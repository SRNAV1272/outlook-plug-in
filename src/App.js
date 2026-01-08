/* global Office */
import React, { useCallback, useEffect, useState } from "react";
import {
  getOfficeToken,
  login,
  setToken,
  getToken
} from "./services/authService";
import LoginForm from "./components/LoginForm";
import SignatureView from "./components/SignatureView";

export default function App({ user }) {
  const [mode, setMode] = useState("init"); // init | login | ready
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  /* ---------------------------------------------------------
     INIT
  --------------------------------------------------------- */
  const init = useCallback(async () => {
    setLoading(true);
    setError("");

    const cached = getToken();
    if (cached) {
      setMode("ready");
      setLoading(false);
      return;
    }

    try {
      const token = await getOfficeToken();
      const payload = decodeJwt(token);
      setToken(token, payload.exp, "aad");
      setMode("ready");
    } catch (e) {
      console.warn("SSO failed → login fallback", e);
      setMode("login");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    init();
  }, [init]);

  /* ---------------------------------------------------------
     BODY HELPERS
  --------------------------------------------------------- */

  function getBodyHtml(item) {
    return new Promise((resolve, reject) => {
      item.body.getAsync(Office.CoercionType.Html, r =>
        r.status === "succeeded" ? resolve(r.value || "") : reject(r.error)
      );
    });
  }

  function stripCardByteSignature(html) {
    return html.replace(
      /<!-- CARD_BYTE_SIGNATURE_START -->[\s\S]*?<!-- CARD_BYTE_SIGNATURE_END -->/gi,
      ""
    ).trim();
  }

  /* ---------------------------------------------------------
     CID ATTACHMENTS
  --------------------------------------------------------- */
  async function attachCidImages(item, attachments = []) {
    for (const img of attachments) {
      await new Promise((resolve, reject) => {
        item.addFileAttachmentFromBase64Async(
          img.base64,
          img.filename,
          { isInline: true, contentId: img.cid },
          r => (r.status === "succeeded" ? resolve() : reject(r.error))
        );
      });
    }
  }

  /* ---------------------------------------------------------
     APPLY SIGNATURE (CID SAFE – HARD REPLACE)
  --------------------------------------------------------- */
  function applySignature(payload) {
    if (!payload?.html) return;
    if (typeof Office === "undefined") return;

    Office.onReady(async () => {
      const item = Office.context?.mailbox?.item;
      if (!item?.body) return;

      try {
        if (window.__INSERTING_SIGNATURE__) return;
        window.__INSERTING_SIGNATURE__ = true;

        // 1️⃣ Attach CID images
        await attachCidImages(item, payload.attachments);

        // 2️⃣ Clean existing CardByte signature
        const current = await getBodyHtml(item);
        const cleaned = stripCardByteSignature(current);

        // 3️⃣ Replace body (single write = stable)
        const finalHtml = `
                ${cleaned}
                <br/><br/>
                <!-- CARD_BYTE_SIGNATURE_START -->
                ${payload.html}
                <!-- CARD_BYTE_SIGNATURE_END -->
            `.trim();

        await item.body.setAsync(finalHtml, {
          coercionType: Office.CoercionType.Html
        });

        console.log("✅ CardByte signature applied (CID)");

      } catch (e) {
        console.error("❌ Apply signature failed", e);
      } finally {
        window.__INSERTING_SIGNATURE__ = false;
      }
    });
  }

  /* ---------------------------------------------------------
     LOGIN
  --------------------------------------------------------- */
  async function handleLogin(form) {
    try {
      setLoading(true);
      await login(form.username, form.password);
      setMode("ready");
    } catch {
      setError("Invalid username or password");
      setMode("ready");
    } finally {
      setLoading(false);
    }
  }

  /* ---------------------------------------------------------
     RENDER
  --------------------------------------------------------- */
  if (mode === "login") {
    return (
      <LoginForm
        onLogin={handleLogin}
        loading={loading}
        error={error}
      />
    );
  }

  if (mode === "ready") {
    return (
      <SignatureView
        Office={Office}
        user={user}
        apply={applySignature}   // 🔥 CID payload
      />
    );
  }

  return <div>Initializing add-in…</div>;
}

/* ---------------------------------------------------------
   JWT DECODE
--------------------------------------------------------- */
function decodeJwt(token) {
  const base64 = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(atob(base64));
}
