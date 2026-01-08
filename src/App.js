/* global Office */
import React, { useCallback, useEffect, useState } from "react";
import { getOfficeToken, login, setToken, getToken } from "./services/authService";
import LoginForm from "./components/LoginForm";
import SignatureView from "./components/SignatureView";
// import SignatureView from "./";

export default function App({ user }) {
  const [mode, setMode] = useState("init"); // init | login | ready
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const init = useCallback(async () => {
    setLoading(true);
    setError("");

    // 1️⃣ Check cached token
    const cached = getToken();
    if (cached) {
      await loadSignature();
      return;
    }

    // 2️⃣ Try Office SSO (ONLY if available)
    try {
      const token = await getOfficeToken();
      const payload = decodeJwt(token);
      setToken(token, payload.exp, "aad");
      await loadSignature();
    } catch (e) {
      console.warn("SSO unavailable or failed → login fallback", e);
      setMode("ready");
      setLoading(false);
    }
  }, [])

  useEffect(() => {
    // console.log("sdkjahdskjashdkjasd", )
    init();
  }, [init]);

  /* ---------------------------------------------------------
     BODY READ + SIGNATURE CLEAN HELPERS
  --------------------------------------------------------- */

  function getBodyHtml(item) {
    return new Promise((resolve, reject) => {
      item.body.getAsync(Office.CoercionType.Html, r => {
        if (r.status === "succeeded") resolve(r.value || "");
        else reject(r.error);
      });
    });
  }

  function looksLikeOutlookDefaultSignature(html) {
    return (
      /class="?MsoNormal"?/i.test(html) ||
      /<meta name="Generator" content="Microsoft Outlook"/i.test(html) ||
      /--<br\s*\/?>/i.test(html) ||
      /Sent from (my )?iPhone/i.test(html)
    );
  }

  function stripOutlookSignature(html) {
    const patterns = [
      /<div class="?MsoNormal"?.*?>/i,
      /--<br\s*\/?>/i,
      /Sent from (my )?iPhone/i
    ];

    for (const p of patterns) {
      const idx = html.search(p);
      if (idx > -1) {
        return html.slice(0, idx).trim();
      }
    }

    return html;
  }

  function stripCardByteSignature(html) {
    return html.replace(
      /<!-- CARD_BYTE_SIGNATURE_START -->[\s\S]*?<!-- CARD_BYTE_SIGNATURE_END -->/gi,
      ""
    ).trim();
  }

  async function cleanExistingSignatures(item) {
    const html = await getBodyHtml(item);
    let cleaned = html;

    // 🔥 Remove existing CardByte signature (REPLACE)
    cleaned = stripCardByteSignature(cleaned);

    // 🧹 Remove Outlook default signature
    if (looksLikeOutlookDefaultSignature(cleaned)) {
      cleaned = stripOutlookSignature(cleaned);
    }

    if (cleaned !== html) {
      await item.body.setAsync(cleaned, {
        coercionType: Office.CoercionType.Html
      });
    }
  }

  async function loadSignature() {
    try {
      setLoading(true);
      // const data = await fetchSignature(); // MUST return { html }
      // setSignature(data.html);
      setMode("ready");
    } catch (e) {
      console.error("Signature load failed", e);
      setError("Unable to load signature");
      setMode("ready");
    } finally {
      setLoading(false);
    }
  }

  async function handleLogin(form) {
    try {
      setLoading(true);
      await login(form.username, form.password);
      await loadSignature();
    } catch {
      setError("Invalid username or password");
      setMode("ready");
    } finally {
      setLoading(false);
    }
  }

  function applySignature(signature) {
    if (!signature) return;

    if (typeof Office === "undefined") {
      console.error("Office.js not available");
      return;
    }

    Office.onReady(async () => {
      const item = Office.context?.mailbox?.item;

      if (!item || !item.body) {
        console.error("Not in compose mode");
        return;
      }

      try {
        /* =========================================
           🔒 PREVENT PARALLEL INSERTS
           ========================================= */
        if (window.__INSERTING_SIGNATURE__) return;
        window.__INSERTING_SIGNATURE__ = true;

        /* =========================================
           🧹 CLEAN FIRST (REPLACE MODE)
           - Old CardByte signature
           - Outlook default signature
           ========================================= */
        await cleanExistingSignatures(item);

        /* =========================================
           ✏️ INSERT FRESH SIGNATURE
           ========================================= */
        await new Promise((resolve, reject) => {
          item.body.setSelectedDataAsync(
            `
          <br/><br/>
          <!-- CARD_BYTE_SIGNATURE_START -->
          ${signature}
          <!-- CARD_BYTE_SIGNATURE_END -->
          `,
            { coercionType: Office.CoercionType.Html },
            result =>
              result.status === Office.AsyncResultStatus.Succeeded
                ? resolve()
                : reject(result.error)
          );
        });

        console.log("✅ Signature replaced successfully");
      } catch (e) {
        console.error("❌ Apply signature failed", e);
      } finally {
        window.__INSERTING_SIGNATURE__ = false;
      }
    });
  }


  if (mode === "login") {
    return <LoginForm onLogin={handleLogin} loading={loading} error={error} />;
  }

  if (mode === "ready") {
    return (
      <SignatureView
        Office={Office}
        user={user}
        apply={applySignature}
        refresh={loadSignature}
        loading={loading}
        error={error}
      />
    );
  }

  return <div>Initializing add-in…</div>;
}

function decodeJwt(token) {
  const base64 = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(atob(base64));
}
