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
   DEFAULT SIGNATURE DETECTION / STRIP
--------------------------------------------------------- */

  function getBodyHtml(item) {
    return new Promise((resolve, reject) => {
      item.body.getAsync(Office.CoercionType.Html, r => {
        if (r.status === "succeeded") resolve(r.value || "");
        else reject(r.error);
      });
    });
  }

  function hasCardByteSignature(html) {
    return (
      html.includes("CARD_BYTE_SIGNATURE_START") ||
      html.includes("CARDBYTE_SIGNATURE") ||
      html.includes("CB_SIG_START")
    );
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

  async function ensureNoOutlookSignature(item) {
    const html = await getBodyHtml(item);

    // Never touch if CardByte already exists
    if (hasCardByteSignature(html)) return;

    if (looksLikeOutlookDefaultSignature(html)) {
      console.log("🧹 Removing Outlook default signature");

      const cleaned = stripOutlookSignature(html);

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
           🔍 EARLY CHECK (before Outlook race)
           ========================================= */

        await ensureNoOutlookSignature(item);

        const preHtml = await getBodyHtml(item);
        if (hasCardByteSignature(preHtml)) {
          console.log("✅ CardByte signature already present — skipping");
          return;
        }

        /* =========================================
           🔁 LATE CHECK (Outlook may insert late)
           ========================================= */

        await ensureNoOutlookSignature(item);

        /* =========================================
           ✏️ INSERT SIGNATURE
           ========================================= */

        item.body.setSelectedDataAsync(
          `
        <br/><br/>
        <!-- CARD_BYTE_SIGNATURE_START -->
        ${signature}
        <!-- CARD_BYTE_SIGNATURE_END -->
        `,
          { coercionType: Office.CoercionType.Html },
          result => {
            if (result.status === Office.AsyncResultStatus.Failed) {
              console.error("Apply signature failed:", result.error);
              alert(result.error.message);
            } else {
              console.log("✅ Signature applied safely");
            }
          }
        );
      } catch (e) {
        console.error("Apply signature failed", e);
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
