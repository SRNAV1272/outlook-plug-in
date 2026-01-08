/* global Office */

import ReactDOM from "react-dom/client";
import App from "./App";
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
      {/* <App /> */}
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
  emailAddress: "sairajesh.korla1272@outlook.com",//,"sairajesh.korla1272@outlook.com", //"dhruvkapur@cardbyte.ai", //"muskanrai@cardbyte.ai", //"sairajesh.korla1@navajna.com",
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

function hasCardByteSignature(bodyHtml = "") {
  if (!bodyHtml) return false;

  // ✅ PRIMARY (MOST RELIABLE)
  // Azure Blob rendered signature image
  if (bodyHtml.includes("cardbyte-email-signature")) {
    return true;
  }

  // ✅ SECONDARY (legacy renderer / fallback)
  if (bodyHtml.includes("cardbyte.ai")) {
    return true;
  }

  return false;
}

// function applyDefaultSignature() {
//   if (signatureApplied) return;

//   const item = Office.context.mailbox.item;
//   if (!item || !item.body) return;

//   item.body.getAsync(Office.CoercionType.Html, (result) => {
//     if (result.status !== Office.AsyncResultStatus.Succeeded) return;

//     const bodyHtml = result.value || "";

//     // 🛑 HARD STOP — signature already exists
//     if (hasCardByteSignature(bodyHtml)) {
//       console.log("✅ CardByte signature already detected — skipping auto apply");
//       signatureApplied = true;
//       return;
//     }

//     const settings = Office.context.roamingSettings;
//     const storedSignature = settings.get("defaultSignatureHtml");

//     if (!storedSignature) return;

//     // ✅ Lock immediately to avoid double insert
//     signatureApplied = true;

//     const signatureHtml = `
//       <div data-cardbyte-signature="true">
//         ${storedSignature}
//       </div>
//     `;

//     const isReplyOrForward =
//       item.conversationId && bodyHtml.trim().length > 0;

//     const updatedBody = isReplyOrForward
//       ? signatureHtml + "<br/>" + bodyHtml
//       : bodyHtml + signatureHtml;

//     item.body.setAsync(updatedBody, {
//       coercionType: Office.CoercionType.Html,
//     });
//   });
// }

/**
 * --------------------------------------------------
 * Bootstrap
 * --------------------------------------------------
 */
if (typeof Office !== "undefined") {
  Office.onReady((info) => {
    // if (Office.context.mailbox?.item) {
    //   applyDefaultSignature();
    // }

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
