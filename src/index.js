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
 *   1. startPrefetchLoop() — Office.context is guaranteed ready here
 *   2. renderApp()         — React mounts after Office is ready
 *
 * Previously, App.js had its own Office.onReady at module scope which
 * raced against this one and ran before Office.context.mailbox was
 * populated, causing emailAddress to be undefined and the prefetch
 * to silently no-op every time.
 * --------------------------------------------------
 */
if (typeof Office !== "undefined") {
  Office.onReady((info) => {
    console.log("[CardByte] Office.onReady fired — host:", info.host, "platform:", info.platform);

    // ✅ Start prefetch here — Office.context is fully ready
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