/* global Office */

import ReactDOM from "react-dom/client";
import App from "./App";
import { startPrefetchLoop } from "./App";
import "./styles.css";
import React from "react";

/**
 * --------------------------------------------------
 * Create root ONCE (CRITICAL)
 * --------------------------------------------------
 */
const container = document.getElementById("root");
const root = ReactDOM.createRoot(container);

/**
 * --------------------------------------------------
 * Single render guard (Fast Refresh safe)
 * --------------------------------------------------
 */
let rendered = false;

const renderApp = (user) => {
  if (rendered) return;
  rendered = true;

  root.render(
    <React.StrictMode>
      <App user={user} />
    </React.StrictMode>
  );
};

/**
 * --------------------------------------------------
 * Fallback user
 * --------------------------------------------------
 */
const fallbackUser = {
  accountType: "office365",
  displayName: "Korla Sai Rajesh",
  emailAddress: "sairajesh.korla1272@outlook.com",
  timeZone: "India Standard Time",
};

/**
 * --------------------------------------------------
 * Bootstrap
 *
 * Office.onReady is the SINGLE entry point for both:
 *
 *   1. startPrefetchLoop()
 *      For Classic Outlook on Windows, this immediately fetches the
 *      signature from the CardByte server and writes it to:
 *        • localStorage["cardbyte_cached_signature"]  ← primary cache
 *        • Office.context.roamingSettings              ← secondary fallback
 *
 *      event-handler-classic.js reads localStorage first (same origin,
 *      shared between the WebView taskpane runtime and the Classic JS
 *      worker), so it gets an instant cache hit without any XHR.
 *
 *      On OWA / New Outlook / Mac, startPrefetchLoop() skips the fetch
 *      because those platforms run inside the SharedRuntime and
 *      App.loadSignature() (called from init()) handles the fetch and
 *      calls persistSignatureToStorage() directly.
 *
 *   2. renderApp()
 *      React mounts after Office is ready.  App.init() → loadSignature()
 *      → fetchSignatureFromServer() runs as usual and also calls
 *      persistSignatureToStorage(), keeping localStorage current.
 *
 * --------------------------------------------------
 */
if (typeof Office !== "undefined") {
  Office.onReady((info) => {
    console.log("[CardByte] Office.onReady fired — host:", info.host, "platform:", info.platform);

    // ✅ Start prefetch here — Office.context is fully ready.
    //    For Classic Windows: fetches + writes to localStorage immediately.
    //    For other platforms: no-ops (App.loadSignature handles it).
    startPrefetchLoop();

    if (info.host === Office.HostType.Outlook) {
      const user = Office.context.mailbox.userProfile;
      renderApp(user ?? fallbackUser);
    } else {
      renderApp(fallbackUser);
    }
  });
} else {
  // Non-Office environment (browser dev / testing)
  renderApp(fallbackUser);
}