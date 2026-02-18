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

  function bodySetAsync(item, html) {
    return new Promise((resolve, reject) => {
      item.body.setAsync(
        html,
        { coercionType: Office.CoercionType.Html },
        (r) => {
          if (r.status === "succeeded") resolve();
          else reject(r.error);
        }
      );
    });
  }

  function hasCardByteSignature(html) {
    return (
      html.includes("CARD_BYTE_SIGNATURE_START") ||
      html.includes("CARDBYTE_SIGNATURE") ||
      html.includes("CB_SIG_START")
    );
  }

  /**
   * Detects default/built-in signatures from Outlook, mobile clients,
   * and other email providers.
   */
  function looksLikeDefaultSignature(html) {
    const patterns = [
      // Outlook desktop / OWA default signatures
      /class="?MsoNormal"?/i,
      /<meta name="Generator" content="Microsoft/i,
      /id="?Signature"?/i,
      /id="?ms-outlook-mobile-signature"?/i,
      /class="?OutlookMessageHeader"?/i,

      // Common "-- " separator (RFC 3676 sig delimiter)
      /--\s*<br\s*\/?>/i,
      /^--\s*$/m,

      // Mobile default signatures
      /Sent from (my )?(iPhone|iPad|Galaxy|Samsung|Android|Outlook|Mail)/i,
      /Get Outlook for (iOS|Android)/i,
      /Sent from Yahoo Mail/i,
      /Sent via the Samsung/i,

      // Gmail default
      /class="?gmail_signature"?/i,

      // Apple Mail
      /class="?AppleMailSignature"?/i,

      // Thunderbird
      /class="?moz-signature"?/i,
    ];

    return patterns.some((p) => p.test(html));
  }

  /**
   * Strips any detected default signature from the body HTML.
   * Tries multiple strategies to find the signature boundary.
   */
  function stripDefaultSignature(html) {
    // Strategy 1: Known container elements (most reliable — remove the element)
    const containerPatterns = [
      // Outlook mobile signature div
      /<div[^>]*id="?ms-outlook-mobile-signature"?[^>]*>[\s\S]*?<\/div>/gi,
      // Gmail signature
      /<div[^>]*class="?gmail_signature"?[^>]*>[\s\S]*?<\/div>/gi,
      // Apple Mail signature
      /<div[^>]*class="?AppleMailSignature"?[^>]*>[\s\S]*?<\/div>/gi,
      // Thunderbird signature
      /<div[^>]*class="?moz-signature"?[^>]*>[\s\S]*?<\/div>/gi,
      // Generic "Signature" id block
      /<div[^>]*id="?Signature"?[^>]*>[\s\S]*?<\/div>/gi,
      // "Get Outlook for iOS/Android" promo line
      /<div[^>]*>.*?Get Outlook for (iOS|Android).*?<\/div>/gi,
    ];

    let cleaned = html;
    for (const p of containerPatterns) {
      cleaned = cleaned.replace(p, "");
    }

    // If container removal changed something, we're done
    if (cleaned.length < html.length) {
      console.log("[CardByte] Removed default signature via container pattern");
      return cleaned.trim();
    }

    // Strategy 2: Truncate from known text markers (cut everything after)
    const truncatePatterns = [
      /--\s*<br\s*\/?>/i,
      /Sent from (my )?(iPhone|iPad|Galaxy|Samsung|Android|Outlook|Mail)/i,
      /Get Outlook for (iOS|Android)/i,
      /Sent from Yahoo Mail/i,
      /Sent via the Samsung/i,
    ];

    for (const p of truncatePatterns) {
      const idx = cleaned.search(p);
      if (idx > -1) {
        console.log("[CardByte] Removed default signature via text marker truncation");
        return cleaned.slice(0, idx).trim();
      }
    }

    // Strategy 3: MsoNormal heuristic — only on fresh compose (minimal body text)
    const bodyTextOnly = cleaned.replace(/<[^>]*>/g, "").trim();
    if (bodyTextOnly.length < 200) {
      const msoIdx = cleaned.search(/<div[^>]*class="?MsoNormal"?/i);
      if (msoIdx > -1) {
        console.log("[CardByte] Removed MsoNormal signature block from fresh compose");
        return cleaned.slice(0, msoIdx).trim();
      }
    }

    return cleaned;
  }

  /**
   * Disables Outlook's built-in client signature if the API supports it.
   */
  async function disableClientSignature(item) {
    try {
      if (typeof item.body?.setSignatureAsync === "function") {
        await new Promise((resolve, reject) => {
          item.body.setSignatureAsync(
            "",
            { coercionType: Office.CoercionType.Html },
            (r) => {
              if (r.status === "succeeded") resolve();
              else reject(r.error);
            }
          );
        });
        console.log("[CardByte] ✅ Cleared Outlook client signature slot via setSignatureAsync");
        return true;
      }
    } catch (e) {
      console.warn("[CardByte] Could not clear client signature slot:", e.message);
    }

    try {
      if (typeof item.disableClientSignatureAsync === "function") {
        await new Promise((resolve, reject) => {
          item.disableClientSignatureAsync((r) => {
            if (r.status === "succeeded") resolve();
            else reject(r.error);
          });
        });
        console.log("[CardByte] ✅ Disabled client signature via disableClientSignatureAsync");
        return true;
      }
    } catch (e) {
      console.warn("[CardByte] disableClientSignatureAsync not available:", e.message);
    }

    return false;
  }

  /**
   * Ensures no default/Outlook/mobile signature is present in the body.
   * Called BEFORE inserting the CardByte signature.
   */
  async function ensureNoDefaultSignature(item) {
    try {
      // Step 1: Try to disable the Outlook client signature mechanism
      await disableClientSignature(item);

      // Step 2: Read the current body and strip any existing default signature
      const html = await getBodyHtml(item);

      // Never touch if CardByte already exists
      if (hasCardByteSignature(html)) {
        console.log("[CardByte] CardByte signature already present — skipping default removal");
        return false;
      }

      if (looksLikeDefaultSignature(html)) {
        console.log("🧹 Removing default signature");
        const cleaned = stripDefaultSignature(html);

        // Only rewrite body if something was actually removed
        if (cleaned.length < html.length) {
          await bodySetAsync(item, cleaned);
          console.log("[CardByte] ✅ Default signature removed from body");
          return true;
        }
      }

      console.log("[CardByte] No default signature detected");
      return false;
    } catch (e) {
      console.warn("[CardByte] ensureNoDefaultSignature error (non-fatal):", e.message);
      return false;
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

        await ensureNoDefaultSignature(item);

        const preHtml = await getBodyHtml(item);
        if (hasCardByteSignature(preHtml)) {
          console.log("✅ CardByte signature already present — skipping");
          return;
        }

        /* =========================================
           🔁 LATE CHECK (Outlook may insert late)
           ========================================= */

        await ensureNoDefaultSignature(item);

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