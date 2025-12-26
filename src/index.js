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
  displayName: "Riya",
  emailAddress: "Riya00907@outlook.com",
  timeZone: "India Standard Time",
};

/**
 * --------------------------------------------------
 * Signature guard (CRITICAL)
 * --------------------------------------------------
 */
let signatureApplied = false;

/**
 * --------------------------------------------------
 * Apply Default Signature (AUTO)
 * --------------------------------------------------
 */
function applyDefaultSignature() {
  if (signatureApplied) return;
  signatureApplied = true;

  const item = Office.context.mailbox.item;
  if (!item || !item.body) return;

  item.body.getAsync(Office.CoercionType.Html, (result) => {
    if (result.status !== Office.AsyncResultStatus.Succeeded) return;

    const body = result.value || "";

    // Prevent duplicate signature
    if (body.includes("data-default-signature")) return;

    const profile = Office.context.mailbox.userProfile;

    const signatureHtml = `
      <div data-default-signature="true">
        <br/>
        <strong>${profile?.displayName ?? fallbackUser.displayName}</strong><br/>
        Software Engineer<br/>
        📧 ${profile?.emailAddress ?? fallbackUser.emailAddress}<br/>
        🌍 India
      </div>
    `;

    const isReplyOrForward =
      item.conversationId && body.trim().length > 0;

    const updatedBody = isReplyOrForward
      ? signatureHtml + "<br/>" + body
      : body + signatureHtml;

    item.body.setAsync(updatedBody, {
      coercionType: Office.CoercionType.Html,
    });
  });
}

/**
 * --------------------------------------------------
 * Bootstrap
 * --------------------------------------------------
 */
if (typeof Office !== "undefined") {
  Office.onReady((info) => {
    if (Office.context.mailbox?.item) {
      applyDefaultSignature();
    }

    if (info.host === Office.HostType.Outlook) {
      const user = Office.context.mailbox.userProfile;
      renderApp(user ?? fallbackUser);
    } else {
      renderApp(fallbackUser);
    }
  });
} else {
  renderApp(fallbackUser);
}
