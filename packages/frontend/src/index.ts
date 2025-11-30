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

        const result = await sdk.backend.sendToJxscout(requestUrl, requestRaw, responseRaw);

        if (result.success) {
          sdk.window.showToast("Response sent to JXScout successfully!", { variant: "success" });
        } else {
          sdk.window.showToast(`Failed to send response: ${result.error}`, { variant: "error" });
        }
      } catch (error) {
        console.error("Failed to send response to JXScout:", error);
        console.error("Error details:", error);
        sdk.window.showToast(`Failed to send response: ${error}`, { variant: "error" });
      }
    },
    group: "Custom Commands",
  });

  // Add the command to the context menu for Response
  // This will appear when right-clicking on a response in HTTP Proxy
  sdk.menu.registerItem({
    type: "Response",
    commandId: "jxscout:send-response",
    leadingIcon: "fas fa-hand",
  });

  // Add a sidebar item
  sdk.sidebar.registerItem("JXScout", "/jxscout");

};
