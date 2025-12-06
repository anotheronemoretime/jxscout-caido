import type { DefineAPI, SDK } from "caido:plugin";
import { RequestSpec } from "caido:utils";
import { readFile, writeFile } from "fs/promises";
import * as path from "path";
import { Response, Settings } from "./types";

const DEFAULT_SETTINGS: Settings = {
  port: 3333,
  host: "localhost",
  filterInScope: true,
  enabled: true,
};

let globalSettings: Settings | null = null;

// Store for chunked data transfers
interface ChunkSession {
  requestUrl: string;
  requestRaw: string;
  responseRaw: string;
  receivedChunks: number;
  totalChunks: number;
  timestamp: number;
}

const chunkSessions = new Map<string, ChunkSession>();
const CHUNK_SIZE = 500 * 1024; // 500KB per chunk (safe for RPC)
const SESSION_TIMEOUT = 60000; // 1 minute timeout for sessions

function ok<T>(data: T): Response<T> {
  return {
    success: true,
    data,
  };
}

function error(message: string): Response<never> {
  return {
    success: false,
    error: message,
  };
}

const getSettingsFilePath = (sdk: SDK) => {
  return path.join(sdk.meta.path(), "settings.json");
};

const saveSettings = async (sdk: SDK, settings: Settings) => {
  const settingsFilePath = getSettingsFilePath(sdk);

  try {
    await writeFile(settingsFilePath, JSON.stringify(settings, null, 2));
    sdk.console.log(`Settings saved to ${settingsFilePath}`);

    globalSettings = settings;

    return ok(settings);
  } catch (err) {
    sdk.console.error(`Failed to save settings: ${err}`);

    return error(`Failed to save settings: ${err}`);
  }
};

const getSettings = async (sdk: SDK): Promise<Response<Settings>> => {
  const settingsFilePath = getSettingsFilePath(sdk);

  sdk.console.log(`Loading settings from ${settingsFilePath}`);

  try {
    const settings = await readFile(settingsFilePath, "utf-8");
    return ok(JSON.parse(settings) as Settings);
  } catch (err) {
    sdk.console.error(`Failed to read settings: ${err}`);
    return ok(DEFAULT_SETTINGS);
  }
};

const fetchUrl = async (
  sdk: SDK,
  url: string
): Promise<Response<{ requestRaw: string; responseRaw: string }>> => {
  try {
    const urlObj = new URL(url);
    const scheme = urlObj.protocol === "https:" ? "https" : "http";
    const host = urlObj.hostname;
    const port = urlObj.port ? parseInt(urlObj.port) : (scheme === "https" ? 443 : 80);
    const path = urlObj.pathname + urlObj.search;

    // Construct the raw HTTP request from the URL
    const hostHeader = port !== 80 && port !== 443 ? `${host}:${port}` : host;
    const requestRaw = `GET ${path} HTTP/1.1\r\nHost: ${hostHeader}\r\nUser-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:145.0) Gecko/20100101 Firefox/145.0\r\nAccept: */*\r\nAccept-Language: fr,fr-FR;q=0.8,en-US;q=0.5,en;q=0.3\r\nAccept-Encoding: gzip, deflate\r\nConnection: keep-alive\r\n\r\n`;

    // Construct the request spec using the URL
    const requestSpec = new RequestSpec(scheme + "://" + host);
    requestSpec.setPath(path);
    requestSpec.setPort(port);
    requestSpec.setMethod("GET");
    requestSpec.setHeader("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:145.0) Gecko/20100101 Firefox/145.0");
    requestSpec.setHeader("Accept", "*/*");
    requestSpec.setHeader("Accept-Language", "fr,fr-FR;q=0.8,en-US;q=0.5,en;q=0.3");
    requestSpec.setHeader("Accept-Encoding", "gzip, deflate");
    requestSpec.setHeader("Connection", "keep-alive");

    // Send the request
    const sentRequest = await sdk.requests.send(requestSpec, {
      save: false,
    });

    // Get raw response from the sent request
    if (!sentRequest.response) {
      return error("No response received");
    }

    const responseRaw = sentRequest.response.getRaw().toText();

    return ok({ requestRaw, responseRaw });
  } catch (err) {
    sdk.console.error(`jxscout-caido: failed to fetch URL ${url}: ${err}`);
    return error(`Failed to fetch URL: ${err}`);
  }
};

// Clean up expired sessions
const cleanupExpiredSessions = () => {
  const now = Date.now();
  for (const [sessionId, session] of chunkSessions.entries()) {
    if (now - session.timestamp > SESSION_TIMEOUT) {
      chunkSessions.delete(sessionId);
    }
  }
};

// Send chunked data to jxscout
const sendToJxscoutChunk = async (
  sdk: SDK,
  sessionId: string,
  chunkIndex: number,
  totalChunks: number,
  requestUrl: string | null,
  requestRawChunk: string | null,
  responseRawChunk: string | null
): Promise<Response<{ complete: boolean }>> => {
  cleanupExpiredSessions();

  // Initialize or get session
  let session = chunkSessions.get(sessionId);
  if (!session) {
    if (chunkIndex !== 0) {
      return error("Session not found. Must start with chunk 0.");
    }
    session = {
      requestUrl: requestUrl || "",
      requestRaw: "",
      responseRaw: "",
      receivedChunks: 0,
      totalChunks: totalChunks,
      timestamp: Date.now(),
    };
    chunkSessions.set(sessionId, session);
  }

  // Validate chunk index
  if (chunkIndex !== session.receivedChunks) {
    return error(`Expected chunk ${session.receivedChunks}, got ${chunkIndex}`);
  }

  // Append chunks
  if (chunkIndex === 0 && requestUrl) {
    session.requestUrl = requestUrl;
  }
  if (requestRawChunk) {
    session.requestRaw += requestRawChunk;
  }
  if (responseRawChunk) {
    session.responseRaw += responseRawChunk;
  }

  session.receivedChunks++;
  session.timestamp = Date.now();

  // Check if all chunks received
  if (session.receivedChunks >= session.totalChunks) {
    // All chunks received, send to jxscout
    try {
      const result = await sendToJxscout(
        sdk,
        session.requestUrl,
        session.requestRaw,
        session.responseRaw
      );
      
      // Clean up session
      chunkSessions.delete(sessionId);
      
      if (result.success) {
        return ok({ complete: true });
      } else {
        return error(result.error);
      }
    } catch (err) {
      chunkSessions.delete(sessionId);
      return error(`Failed to send to jxscout: ${err}`);
    }
  }

  return ok({ complete: false });
};

const sendToJxscout = async (
  sdk: SDK,
  requestUrl: string,
  requestRaw: string,
  responseRaw: string
): Promise<Response<void>> => {
  if (!globalSettings) {
    const settingsResponse = await getSettings(sdk);
    if (settingsResponse.success) {
      globalSettings = settingsResponse.data;
    } else {
      sdk.console.error(
        `jxscout-caido: failed to load settings ${settingsResponse.error}`
      );
      globalSettings = DEFAULT_SETTINGS;
    }
  }

  const settings = globalSettings;

  const requestSpec = new RequestSpec("http://" + settings.host);
  requestSpec.setPath("/caido-ingest");
  requestSpec.setPort(settings.port);
  requestSpec.setMethod("POST");
  requestSpec.setHeader("content-type", "application/json");
  requestSpec.setBody(
    JSON.stringify({
      requestUrl,
      request: requestRaw,
      response: responseRaw,
    })
  );

  try {
    await sdk.requests.send(requestSpec, {
      save: false,
    });
    return ok(undefined);
  } catch (err) {
    sdk.console.error(`jxscout-caido: failed to send request ${err}`);
    return error(`Failed to send request to jxscout: ${err}`);
  }
};

export type API = DefineAPI<{
  saveSettings: typeof saveSettings;
  getSettings: typeof getSettings;
  sendToJxscout: typeof sendToJxscout;
  sendToJxscoutChunk: typeof sendToJxscoutChunk;
  fetchUrl: typeof fetchUrl;
}>;

export function init(sdk: SDK<API>) {
  sdk.api.register("saveSettings", saveSettings);
  sdk.api.register("getSettings", getSettings);
  sdk.api.register("sendToJxscout", sendToJxscout);
  sdk.api.register("sendToJxscoutChunk", sendToJxscoutChunk);
  sdk.api.register("fetchUrl", fetchUrl);

  sdk.events.onInterceptResponse(async (sdk, request, response) => {
    if (!globalSettings) {
      const settingsResponse = await getSettings(sdk);
      if (settingsResponse.success) {
        globalSettings = settingsResponse.data;
      } else {
        sdk.console.error(
          `jxscout-caido: failed to load settings ${settingsResponse.error}`
        );
        globalSettings = DEFAULT_SETTINGS;
      }
    }

    const settings = globalSettings;

    // Check if automatic interception is enabled
    if (!settings.enabled) {
      return;
    }

    if (settings.filterInScope && !sdk.requests.inScope(request)) {
      return;
    }

    // Use the shared function to send to jxscout
    await sendToJxscout(
      sdk,
      request.getUrl(),
      request.getRaw().toText(),
      response.getRaw().toText()
    );
  });
}
