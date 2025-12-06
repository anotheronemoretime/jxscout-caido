import { Classic } from "@caido/primevue";
import PrimeVue from "primevue/config";
import { createApp } from "vue";

import App from "./views/App.vue";

import "./styles/index.css";

import { SDKPlugin } from "./plugins/sdk";
import type { FrontendSDK } from "./types";



// This is the entry point for the frontend plugin
export const init = (sdk: FrontendSDK) => {
  const app = createApp(App);

  // Load the PrimeVue component library
  app.use(PrimeVue, {
    unstyled: true,
    pt: Classic,
  });

  // Provide the FrontendSDK
  app.use(SDKPlugin, sdk);

  // Create the root element for the app
  const root = document.createElement("div");
  Object.assign(root.style, {
    height: "100%",
    width: "100%",
  });

  // Set the ID of the root element
  // Replace this with the value of the prefixWrap plugin in caido.config.ts 
  // This is necessary to prevent styling conflicts between plugins
  root.id = `plugin--frontend-vue`;

  // Mount the app to the root element
  app.mount(root);

  // Add the page to the navigation
  // Make sure to use a unique name for the page
  sdk.navigation.addPage("/jxscout", {
    body: root,
  });

  // Helper function to chunk a string into smaller pieces
  const chunkString = (str: string, chunkSize: number): string[] => {
    const chunks: string[] = [];
    for (let i = 0; i < str.length; i += chunkSize) {
      chunks.push(str.substring(i, i + chunkSize));
    }
    return chunks;
  };

  // Register command to send response to JXScout
  sdk.commands.register("jxscout:send-response", {
    name: "Send to JXScout",
    run: async (context) => {
      try {
        // Log context to debug
        console.log("Context:", context);
        
        // Extract response from context
        // When right-clicking on a response, context.response should be available
        const response = context.response;

        if (!response) {
          sdk.window.showToast("No response found", { variant: "error" });
          return;
        }

        console.log("Response object:", response);
        console.log("Response methods:", Object.getOwnPropertyNames(response));

        // Try to get the request - check if getRequest exists or if we need to use requestId
        const request = context.request;

        console.log("Request object:", request);
        console.log("Request methods:", Object.getOwnPropertyNames(request));

        let requestUrl: string;
        requestUrl = `http://${request.host}${request.path}`;

        // Get raw request and response
        const requestRaw = `GET ${request.path} HTTP/1.1\r\nHost: ${request.host}\r\nUser-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:145.0) Gecko/20100101 Firefox/145.0\r\nAccept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8\r\nAccept-Language: fr,fr-FR;q=0.8,en-US;q=0.5,en;q=0.3\r\nAccept-Encoding: gzip, deflate\r\nConnection: keep-alive\r\nUpgrade-Insecure-Requests: 1\r\nDNT: 1\r\nSec-GPC: 1\r\nPriority: u=0, i\r\n\r\n`;
        const responseRaw = response.raw;

        console.log("Sending to jxscout:", { requestUrl, requestRawLength: requestRaw.length, responseRawLength: responseRaw.length });

        // Send data in chunks if it's too large for RPC
        const CHUNK_SIZE = 500 * 1024; // 500KB per chunk
        const totalSize = requestRaw.length + responseRaw.length;
        
        if (totalSize > CHUNK_SIZE) {
          // Use chunked transfer
          const sessionId = `${Date.now()}-${Math.random().toString(36).substring(7)}`;
          const requestRawChunks = chunkString(requestRaw, CHUNK_SIZE);
          const responseRawChunks = chunkString(responseRaw, CHUNK_SIZE);
          const totalChunks = Math.max(requestRawChunks.length, responseRawChunks.length);
          
          console.log(`Sending ${totalChunks} chunks for ${totalSize} bytes`);
          
          try {
            for (let i = 0; i < totalChunks; i++) {
              const result = await sdk.backend.sendToJxscoutChunk(
                sessionId,
                i,
                totalChunks,
                i === 0 ? requestUrl : null,
                i < requestRawChunks.length ? requestRawChunks[i] : null,
                i < responseRawChunks.length ? responseRawChunks[i] : null
              );
              
              if (!result.success) {
                sdk.window.showToast(`Failed to send chunk ${i + 1}/${totalChunks}: ${result.error}`, { variant: "error" });
                return;
              }
              
              if (result.data.complete) {
                sdk.window.showToast("Response sent to JXScout successfully!", { variant: "success" });
                return;
              }
            }
          } catch (error) {
            console.error("Failed to send chunks:", error);
            sdk.window.showToast(`Failed to send response: ${error}`, { variant: "error" });
            return;
          }
        } else {
          // Small enough, send directly
          const result = await sdk.backend.sendToJxscout(requestUrl, requestRaw, responseRaw);

          if (result.success) {
            sdk.window.showToast("Response sent to JXScout successfully!", { variant: "success" });
          } else {
            sdk.window.showToast(`Failed to send response: ${result.error}`, { variant: "error" });
          }
        }
      } catch (error) {
        console.error("Failed to send response to JXScout:", error);
        console.error("Error details:", error);
        sdk.window.showToast(`Failed to send response: ${error}`, { variant: "error" });
      }
    },
    group: "Custom Commands",
  });

  // Helper function to resolve URLs (absolute vs relative)
  const resolveUrl = (baseUrl: string, src: string): string => {
    // If src is already an absolute URL (starts with http:// or https://), return it as is
    if (src.startsWith("http://") || src.startsWith("https://")) {
      return src;
    }

    try {
      const base = new URL(baseUrl);
      
      // If src starts with //, it's a protocol-relative URL
      if (src.startsWith("//")) {
        return `${base.protocol}${src}`;
      }
      
      // If src starts with /, it's an absolute path from the domain root
      if (src.startsWith("/")) {
        return `${base.protocol}//${base.host}${src}`;
      }
      
      // For relative paths, normalize the base URL first
      // If baseUrl doesn't end with /, we need to treat the last segment as a file
      // and resolve relative to its directory
      let normalizedBaseUrl = baseUrl;
      if (!base.pathname.endsWith("/")) {
        // Remove the last segment (filename) to get the directory
        const lastSlashIndex = base.pathname.lastIndexOf("/");
        if (lastSlashIndex >= 0) {
          normalizedBaseUrl = `${base.protocol}//${base.host}${base.pathname.substring(0, lastSlashIndex + 1)}`;
          if (base.search) {
            normalizedBaseUrl += base.search;
          }
          if (base.hash) {
            normalizedBaseUrl += base.hash;
          }
        }
      }
      
      // Use URL constructor to resolve relative URL
      // This handles ./ ../ and normal relative paths correctly
      return new URL(src, normalizedBaseUrl).href;
    } catch (error) {
      console.error("Error resolving URL:", error);
      // Fallback: if resolution fails, try to construct manually
      const base = new URL(baseUrl);
      
      if (src.startsWith("/")) {
        // Absolute path
        return `${base.protocol}//${base.host}${src}`;
      } else {
        // Relative path
        let basePath = base.pathname;
        if (!basePath.endsWith("/")) {
          basePath = basePath.substring(0, basePath.lastIndexOf("/") + 1);
        }
        // Remove leading ./ if present
        let relativePath = src;
        if (relativePath.startsWith("./")) {
          relativePath = relativePath.substring(2);
        }
        return `${base.protocol}//${base.host}${basePath}${relativePath}`;
      }
    }
  };

  // Helper function to extract script src attributes from HTML
  const extractScriptSrcs = (html: string): string[] => {
    const scriptSrcs: string[] = [];
    // Use regex to find all <script> tags with src attribute
    const scriptRegex = /<script[^>]*src\s*=\s*["']([^"']+)["'][^>]*>/gi;
    let match;
    
    while ((match = scriptRegex.exec(html)) !== null) {
      const src = match[1];
      if (src && src.trim()) {
        scriptSrcs.push(src.trim());
      }
    }
    
    return scriptSrcs;
  };

  // Helper function to extract link href attributes from HTML
  const extractLinkHrefs = (html: string): string[] => {
    const linkHrefs: string[] = [];
    // Use regex to find all <link> tags with href attribute
    const linkRegex = /<link[^>]*href\s*=\s*["']([^"']+)["'][^>]*>/gi;
    let match;
    
    while ((match = linkRegex.exec(html)) !== null) {
      const href = match[1];
      if (href && href.trim()) {
        linkHrefs.push(href.trim());
      }
    }
    
    return linkHrefs;
  };

  // Helper function to construct base URL from request
  const getBaseUrl = (request: any): string => {
    const scheme = request.isTls ? "https" : "http";
    const host = request.host || "";
    const port = request.port || (request.isTls ? 443 : 80);
    const path = request.path || "/";
    const query = request.query || "";
    
    let baseUrl = `${scheme}://${host}`;
    if (port !== 80 && port !== 443) {
      baseUrl += `:${port}`;
    }
    baseUrl += path;
    if (query) {
      baseUrl += `?${query}`;
    }
    return baseUrl;
  };

  // Helper function to send data to jxscout (with chunking if needed)
  const sendToJxscoutWithChunking = async (
    requestUrl: string,
    requestRaw: string,
    responseRaw: string
  ): Promise<{ success: boolean; error?: string }> => {
    const CHUNK_SIZE = 500 * 1024; // 500KB per chunk
    const totalSize = requestRaw.length + responseRaw.length;
    
    if (totalSize > CHUNK_SIZE) {
      // Use chunked transfer
      const sessionId = `${Date.now()}-${Math.random().toString(36).substring(7)}`;
      const requestRawChunks = chunkString(requestRaw, CHUNK_SIZE);
      const responseRawChunks = chunkString(responseRaw, CHUNK_SIZE);
      const totalChunks = Math.max(requestRawChunks.length, responseRawChunks.length);
      
      try {
        for (let i = 0; i < totalChunks; i++) {
          const result = await sdk.backend.sendToJxscoutChunk(
            sessionId,
            i,
            totalChunks,
            i === 0 ? requestUrl : null,
            i < requestRawChunks.length ? requestRawChunks[i] : null,
            i < responseRawChunks.length ? responseRawChunks[i] : null
          );
          
          if (!result.success) {
            return { success: false, error: result.error };
          }
          
          if (result.data.complete) {
            return { success: true };
          }
        }
        return { success: false, error: "Not all chunks were processed" };
      } catch (error) {
        return { success: false, error: String(error) };
      }
    } else {
      // Small enough, send directly
      const result = await sdk.backend.sendToJxscout(requestUrl, requestRaw, responseRaw);
      return { success: result.success, error: result.success ? undefined : result.error };
    }
  };

  // Helper function to fetch URLs and send to jxscout
  const fetchAndSendUrls = async (urls: string[], resourceType: string): Promise<{ successCount: number; errorCount: number }> => {
    let successCount = 0;
    let errorCount = 0;

    for (const url of urls) {
      try {
        // Use backend to fetch the resource
        const fetchResult = await sdk.backend.fetchUrl(url);

        if (fetchResult.success) {
          const { requestRaw, responseRaw } = fetchResult.data;

          // Send to jxscout with chunking support
          const result = await sendToJxscoutWithChunking(url, requestRaw, responseRaw);

          if (result.success) {
            successCount++;
          } else {
            errorCount++;
            console.error(`Failed to send ${resourceType} ${url} to jxscout:`, result.error);
          }
        } else {
          errorCount++;
          console.error(`Failed to fetch ${resourceType} ${url}:`, fetchResult.error);
        }
      } catch (error) {
        errorCount++;
        console.error(`Error processing ${resourceType} ${url}:`, error);
      }
    }

    return { successCount, errorCount };
  };

  // Register command to send all scripts to JXScout
  sdk.commands.register("jxscout:send-all-scripts", {
    name: "Send all <script> to JXScout",
    run: async (context) => {
      try {
        const response = context.response;
        const request = context.request;

        if (!response) {
          sdk.window.showToast("No response found", { variant: "error" });
          return;
        }

        if (!request) {
          sdk.window.showToast("No request found", { variant: "error" });
          return;
        }

        // Get the response body (HTML content)
        const responseBody = response.raw || "";
        
        if (!responseBody) {
          sdk.window.showToast("Response body is empty", { variant: "error" });
          return;
        }

        // Extract all script src attributes
        const scriptSrcs = extractScriptSrcs(responseBody);
        
        if (scriptSrcs.length === 0) {
          sdk.window.showToast("No <script> tags with src attribute found", { variant: "info" });
          return;
        }

        // Construct base URL from request
        const baseUrl = getBaseUrl(request);

        // Resolve all script URLs
        const scriptUrls = scriptSrcs.map(src => resolveUrl(baseUrl, src));
        
        console.log(`Found ${scriptUrls.length} scripts to fetch:`, scriptUrls);

        // Show progress
        sdk.window.showToast(`Fetching ${scriptUrls.length} scripts...`, { variant: "info" });

        // Fetch and send all scripts
        const { successCount, errorCount } = await fetchAndSendUrls(scriptUrls, "script");

        // Show final result
        if (errorCount === 0) {
          sdk.window.showToast(`Successfully sent ${successCount} scripts to JXScout!`, { variant: "success" });
        } else {
          sdk.window.showToast(`Sent ${successCount} scripts, ${errorCount} failed`, { variant: "warning" });
        }
      } catch (error) {
        console.error("Failed to send scripts to JXScout:", error);
        sdk.window.showToast(`Failed to send scripts: ${error}`, { variant: "error" });
      }
    },
    group: "Custom Commands",
  });

  // Add the command to the context menu for Response
  // This will appear when right-clicking on a response in HTTP Proxy
  sdk.menu.registerItem({
    type: "Response",
    commandId: "jxscout:send-response",
    leadingIcon: "fas fa-paper-plane",
  });

  // Register command to send all links to JXScout
  sdk.commands.register("jxscout:send-all-links", {
    name: "Send all <link> to JXScout",
    run: async (context) => {
      try {
        const response = context.response;
        const request = context.request;

        if (!response) {
          sdk.window.showToast("No response found", { variant: "error" });
          return;
        }

        if (!request) {
          sdk.window.showToast("No request found", { variant: "error" });
          return;
        }

        // Get the response body (HTML content)
        const responseBody = response.raw || "";
        
        if (!responseBody) {
          sdk.window.showToast("Response body is empty", { variant: "error" });
          return;
        }

        // Extract all link href attributes
        const linkHrefs = extractLinkHrefs(responseBody);
        
        if (linkHrefs.length === 0) {
          sdk.window.showToast("No <link> tags with href attribute found", { variant: "info" });
          return;
        }

        // Construct base URL from request
        const baseUrl = getBaseUrl(request);

        // Resolve all link URLs
        const linkUrls = linkHrefs.map(href => resolveUrl(baseUrl, href));
        
        console.log(`Found ${linkUrls.length} links to fetch:`, linkUrls);

        // Show progress
        sdk.window.showToast(`Fetching ${linkUrls.length} links...`, { variant: "info" });

        // Fetch and send all links
        const { successCount, errorCount } = await fetchAndSendUrls(linkUrls, "link");

        // Show final result
        if (errorCount === 0) {
          sdk.window.showToast(`Successfully sent ${successCount} links to JXScout!`, { variant: "success" });
        } else {
          sdk.window.showToast(`Sent ${successCount} links, ${errorCount} failed`, { variant: "warning" });
        }
      } catch (error) {
        console.error("Failed to send links to JXScout:", error);
        sdk.window.showToast(`Failed to send links: ${error}`, { variant: "error" });
      }
    },
    group: "Custom Commands",
  });

  sdk.menu.registerItem({
    type: "Response",
    commandId: "jxscout:send-all-scripts",
    leadingIcon: "fas fa-code",
  });

  sdk.menu.registerItem({
    type: "Response",
    commandId: "jxscout:send-all-links",
    leadingIcon: "fas fa-link",
  });

  // Add a sidebar item
  sdk.sidebar.registerItem("JXScout", "/jxscout");

};
