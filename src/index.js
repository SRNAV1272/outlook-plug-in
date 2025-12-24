/* global Office */

import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";

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

  root.render(<App user={user} />);
};

/**
 * --------------------------------------------------
 * Fallback user
 * --------------------------------------------------
 */
const fallbackUser = {
  accountType: "office365",
  displayName: "K Sai Rajesh",
  emailAddress: "sairajesh.korla1272@outlook.com",
  timeZone: "India Standard Time",
};

/**
 * --------------------------------------------------
 * Bootstrap
 * --------------------------------------------------
 */
if (typeof Office !== "undefined") {
  Office.onReady((info) => {
    if (info.host === Office.HostType.Outlook) {
      const user = Office?.context?.mailbox?.userProfile;
      renderApp(user ?? fallbackUser);
    } else {
      renderApp(fallbackUser);
    }
  });
} else {
  renderApp(fallbackUser);
}
