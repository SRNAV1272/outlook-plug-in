/* global Office */
import React, { useCallback, useEffect, useState } from "react";
import { getOfficeToken, login, setToken, getToken } from "./services/authService";
import LoginForm from "./components/LoginForm";
import SignatureView from "./components/SignatureView";

/* ── AES / Encryption helpers ────────────────────────────── */
const AES_KEY = "fnItrY2YfozBqCC2B4XsfqHIvZku3kUOq3DFkbO64kk=";
const AES_IV = "3YapeNfJDung7TXxeKXn4g==";

function base64ToArrayBuffer(base64) {
  let b = base64.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b.length % 4; if (pad) b += "=".repeat(4 - pad);
  const bin = atob(b), bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

async function encryptEmail(email = "") {
  try {
    if (!email?.trim()) return "";
    const keyBuffer = base64ToArrayBuffer(AES_KEY);
    const ivBuffer = base64ToArrayBuffer(AES_IV);
    const key = await crypto.subtle.importKey("raw", keyBuffer, { name: "AES-CBC" }, false, ["encrypt"]);
    const encrypted = await crypto.subtle.encrypt({ name: "AES-CBC", iv: ivBuffer }, key, new TextEncoder().encode(email));
    const bytes = new Uint8Array(encrypted);
    let bin = ""; for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  } catch { return ""; }
}

async function handleAesDecrypt(encryptedText, generatedKey) {
  try {
    if (!encryptedText) return "";
    const keyToUse = generatedKey || AES_KEY;
    let keyBuffer;
    try { keyBuffer = base64ToArrayBuffer(keyToUse); } catch { return encryptedText; }
    if (keyBuffer.byteLength !== 16 && keyBuffer.byteLength !== 32) {
      if (generatedKey && generatedKey !== AES_KEY) return handleAesDecrypt(encryptedText, AES_KEY);
      return encryptedText;
    }
    const ivBuffer = base64ToArrayBuffer(AES_IV);
    if (ivBuffer.byteLength !== 16) return encryptedText;
    const key = await crypto.subtle.importKey("raw", keyBuffer, { name: "AES-CBC" }, false, ["decrypt"]);
    let encryptedBuffer;
    try { encryptedBuffer = base64ToArrayBuffer(encryptedText); } catch { return encryptedText; }
    if (encryptedBuffer.byteLength % 16 !== 0) return encryptedText;
    const decryptedBuffer = await crypto.subtle.decrypt({ name: "AES-CBC", iv: ivBuffer }, key, encryptedBuffer);
    return new TextDecoder().decode(decryptedBuffer);
  } catch (err) {
    if (generatedKey && generatedKey !== AES_KEY && err.message?.includes("key data")) {
      try { return await handleAesDecrypt(encryptedText, AES_KEY); } catch { }
    }
    return encryptedText;
  }
}

// =============================================================================
// localStorage cache — SINGLE SOURCE OF TRUTH for all runtimes
//
// These key names are shared by three files:
//   • App.js (this file)        — writes on every successful signature fetch
//   • event.js                  — reads in applySignature / onSendHandler
//   • event-handler-classic.js  — reads in applySignatureCore / onSendHandler
//
// Do NOT rename these constants without updating the other two files.
// =============================================================================
export const LS_SIG_KEY = "cardbyte_cached_signature";          // signature HTML
export const LS_SESSION_KEY = "cardbyte_cached_signature_session";  // session UUID
export const LS_TS_KEY = "cardbyte_cached_signature_ts";       // write timestamp (ms)

const SESSION_KEY = "cardbyte_session_id";
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 min (used by event.js; kept here for parity)

function getOrCreateSessionId() {
  try {
    let sid = sessionStorage.getItem(SESSION_KEY);
    if (!sid) {
      sid = crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36);
      sessionStorage.setItem(SESSION_KEY, sid);
    }
    return sid;
  } catch { return "unknown"; }
}

/**
 * Writes signature HTML to localStorage.
 * Called after every successful server fetch — keeps all runtimes in sync.
 *
 * Also writes to roamingSettings for Classic Outlook (belt-and-suspenders),
 * because Classic Outlook's JS runtime shares localStorage but roamingSettings
 * provides an additional fallback if localStorage is cleared between sessions.
 */
// =============================================================================
// PERSIST CALLBACK — registered by App after it mounts
// =============================================================================
let _onSignaturePersisted = null;

/**
 * Register a callback to be invoked every time persistSignatureToStorage
 * successfully writes new HTML. App.js calls this once after mounting.
 * The callback receives the HTML string.
 */
export function onSignaturePersisted(cb) {
  _onSignaturePersisted = typeof cb === "function" ? cb : null;
}

export function persistSignatureToStorage(html) {
  if (!html) return;
  try {
    const sid = getOrCreateSessionId();
    localStorage.setItem(LS_SIG_KEY, html);
    localStorage.setItem(LS_SESSION_KEY, sid);
    localStorage.setItem(LS_TS_KEY, Date.now().toString());
    console.log("[CardByte] persistSignatureToStorage: localStorage written — size:", html.length);

    // ── Notify App so it can insert the signature immediately ──
    if (typeof _onSignaturePersisted === "function") {
      _onSignaturePersisted(html);
    }
  } catch (e) {
    console.warn("[CardByte] persistSignatureToStorage: localStorage write failed:", e);
  }

  // roamingSettings fallback — unchanged
  try {
    const rs = Office?.context?.roamingSettings;
    if (rs) {
      rs.set("cardbyte_sig_html", { html, ts: Date.now() });
      rs.saveAsync(result => {
        if (result.status === Office.AsyncResultStatus.Succeeded) {
          console.log("[CardByte] persistSignatureToStorage: roamingSettings updated ✅");
        } else {
          console.warn("[CardByte] persistSignatureToStorage: roamingSettings save failed:", result.error?.message);
        }
      });
    }
  } catch (e) {
    console.warn("[CardByte] persistSignatureToStorage: roamingSettings write failed:", e);
  }

  try {
    var mailbox = (typeof Office !== "undefined" && Office.context && Office.context.mailbox)
      ? Office.context.mailbox : null;
    var item = mailbox ? mailbox.item : null;

    item.body.setSignatureAsync(html, { coercionType: Office.CoercionType.Html }, function (result) {
      var ok = result.status === Office.AsyncResultStatus.Succeeded || result.status === "succeeded";
      if (ok) {
        console.log("[CardByte] Classic: setSignatureAsync succeeded");
        // onDone(true);
      } else {
        console.warn("[CardByte] Classic: setSignatureAsync failed:", result.error && result.error.message);
        // _prependFallback(item, html, onDone);
      }
    });

  } catch (e) {
    console.error(e)
  }

}

// =============================================================================
// PREFETCH — owned here, started from index.js inside Office.onReady.
//
// Previously only wrote to roamingSettings (Classic-only guard).
// Now writes to localStorage unconditionally so that:
//   • SharedRuntime event.js handlers get an instant cache hit
//   • event-handler-classic.js gets the same data from localStorage
//   • roamingSettings remains as a secondary fallback for Classic
// =============================================================================
const REFRESH_INTERVAL_MS = 4 * 60 * 1000; // 4 min

let _prefetchIntervalId = null;

async function _prefetchSignatureForClassic() {
  try {
    const diagnosticsPlatform = Office?.context?.diagnostics?.platform;
    console.log("[CardByte] Prefetch: platform =", diagnosticsPlatform);

    // Still guard on PC so we don't make unnecessary server calls on
    // Mac / OWA / Mobile where the React component fetches its own copy.
    // if (diagnosticsPlatform !== Office.PlatformType.PC) {
    //   console.log("[CardByte] Prefetch: skipping — not Classic Windows");
    //   return;
    // }

    const email = Office?.context?.mailbox?.userProfile?.emailAddress;
    if (!email) { console.warn("[CardByte] Prefetch: no emailAddress — skipping"); return; }

    const xPlatform = diagnosticsPlatform === Office.PlatformType.Mac ? "MAC" : "WINDOWS";
    const encryptedMail = await encryptEmail(email);
    if (!encryptedMail) { console.warn("[CardByte] Prefetch: encryptEmail returned empty — skipping"); return; }

    console.log("[CardByte] Prefetch: fetching signature…");

    const res = await fetch(
      "https://newqa-enterprise.cardbyte.ai/email-signature/html/outlook/get-active",
      {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          "username": encryptedMail,
          "X-Platform": xPlatform
        }
      }
    );

    if (!res.ok) { console.warn("[CardByte] Prefetch: HTTP", res.status, res.statusText); return; }

    const encryptedText = await res.text();
    const decryptedText = await handleAesDecrypt(encryptedText);
    const html = JSON.parse(decryptedText)?.html || null;

    if (!html) { console.warn("[CardByte] Prefetch: no html field after decrypt — skipping write"); return; }

    // Write to localStorage (primary) + roamingSettings (fallback) in one call.
    persistSignatureToStorage(html);

    console.log("[CardByte] Prefetch: complete ✅", new Date().toISOString());

  } catch (err) {
    console.warn("[CardByte] Prefetch: unexpected error:", err);
  }
}

/**
 * Exported — called once from index.js INSIDE Office.onReady.
 */
export function startPrefetchLoop() {
  if (_prefetchIntervalId) { clearInterval(_prefetchIntervalId); _prefetchIntervalId = null; }

  _prefetchSignatureForClassic(); // immediate — warm cache before first compose

  _prefetchIntervalId = setInterval(() => {
    console.log("[CardByte] Prefetch: interval refresh");
    _prefetchSignatureForClassic();
  }, REFRESH_INTERVAL_MS);
}

// =============================================================================
// SIZE LIMITS
// =============================================================================
const MAX_SAFE_HTML_SIZE = 500_000;
const MAX_SAFE_HTML_SIZE_MOBILE = 200_000;
const MOBILE_MAX_IMAGE_WIDTH = 200;
const MOBILE_IMAGE_QUALITY = 0.5;

// =============================================================================
// PLATFORM DETECTION
// =============================================================================
export function detectPlatform() {
  try {
    const platform = (Office?.context?.platform || "").toLowerCase();
    const ua = (navigator?.userAgent || "").toLowerCase();

    if (platform === "ios" || platform === "iphone" || platform === "ipad") return "mobile-ios";
    if (platform === "android") return "mobile-android";

    if (ua.includes("outlookmobile") || ua.includes("outlook-ios") || ua.includes("outlook-android"))
      return ua.includes("android") ? "mobile-android" : "mobile-ios";

    if (
      (platform === "officeonline" || platform === "web" || platform === "") &&
      (ua.includes("iphone") || ua.includes("ipad") || ua.includes("android"))
    ) return ua.includes("android") ? "mobile-android" : "mobile-ios";

    if (platform === "officeonline" || platform === "web" || platform === "") return "owa";
    return "desktop";
  } catch { return "desktop"; }
}

export function isMobilePlatform() { const p = detectPlatform(); return p === "mobile-ios" || p === "mobile-android"; }
export function isOWAPlatform() { return detectPlatform() === "owa"; }

function isMobile() { return isMobilePlatform(); }
function isOWA() { return isOWAPlatform(); }
function isMac() { return detectPlatform() === "mac"; }

function getMaxHtmlSize() { return isMobilePlatform() ? MAX_SAFE_HTML_SIZE_MOBILE : MAX_SAFE_HTML_SIZE; }

// =============================================================================
// AUTO-APPLY CONTEXT
// =============================================================================
function isAutoApplyContext() {
  try { return new URLSearchParams(window.location.search).get("autoApply") === "1"; }
  catch { return false; }
}

// =============================================================================
// APP
// =============================================================================
export default function App({ user }) {
  const [mode, setMode] = useState("init");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const autoApply = isAutoApplyContext();
  const mobile = isMobilePlatform();
  const platform = detectPlatform();

  const init = useCallback(async () => {
    setLoading(true);
    setError("");
    const cached = getToken();
    if (cached) { await loadSignature(); return; }
    try {
      const token = await getOfficeToken();
      const payload = decodeJwt(token);
      setToken(token, payload.exp, "aad");
      await loadSignature();
    } catch (e) {
      console.warn("SSO unavailable → login fallback", e);
      setMode("ready");
      setLoading(false);
    }
  }, []);

  useEffect(() => { init(); }, [init]);

  /* ── Outlook body helpers ──────────────────────────────────────────── */

  function bodySetSignatureAsync(item, html) {
    return new Promise((res, rej) => {
      if (typeof item.body.setSignatureAsync !== "function") {
        rej(new Error("setSignatureAsync not available"));
        return;
      }
      item.body.setSignatureAsync(
        html,
        { coercionType: Office.CoercionType.Html },
        (r) => r.status === "succeeded" ? res() : rej(r.error)
      );
    });
  }

  /* ── Image processing — mobile-aware ──────────────────────────────── */

  function compressBase64Image(dataUrl, maxWidth, quality) {
    if (maxWidth === undefined) maxWidth = mobile ? MOBILE_MAX_IMAGE_WIDTH : 300;
    if (quality === undefined) quality = mobile ? MOBILE_IMAGE_QUALITY : 0.7;

    return new Promise((resolve) => {
      if (dataUrl.startsWith("data:image/gif") && !mobile) { resolve(dataUrl); return; }
      const img = new Image();
      img.onload = () => {
        try {
          const canvas = document.createElement("canvas");
          let w = img.width, h = img.height;
          if (w > maxWidth) { h = Math.round(h * maxWidth / w); w = maxWidth; }
          canvas.width = w; canvas.height = h;
          const ctx = canvas.getContext("2d");
          if (dataUrl.startsWith("data:image/png")) {
            ctx.clearRect(0, 0, w, h); ctx.drawImage(img, 0, 0, w, h);
            const r = canvas.toDataURL("image/png");
            resolve(r.length < dataUrl.length ? r : dataUrl); return;
          }
          ctx.drawImage(img, 0, 0, w, h);
          let r = canvas.toDataURL("image/jpeg", quality);
          if (r.length >= dataUrl.length) r = canvas.toDataURL("image/png");
          resolve(r.length < dataUrl.length ? r : dataUrl);
        } catch { resolve(dataUrl); }
      };
      img.onerror = () => resolve(dataUrl);
      img.src = dataUrl;
    });
  }

  function convertGifToStaticPng(dataUrl, maxWidth) {
    if (maxWidth === undefined) maxWidth = mobile ? MOBILE_MAX_IMAGE_WIDTH : 300;
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        try {
          const canvas = document.createElement("canvas");
          let w = img.width, h = img.height;
          if (w > maxWidth) { h = Math.round(h * maxWidth / w); w = maxWidth; }
          canvas.width = w; canvas.height = h;
          const ctx = canvas.getContext("2d");
          ctx.clearRect(0, 0, w, h); ctx.drawImage(img, 0, 0, w, h);
          resolve(canvas.toDataURL("image/png"));
        } catch { resolve(dataUrl); }
      };
      img.onerror = () => resolve(dataUrl);
      img.src = dataUrl;
    });
  }

  async function compressImagesInHtml(html) {
    const regex = /src\s*=\s*"(data:image\/[^;]+;base64,[^"]+)"/gi;
    const matches = []; let m;
    while ((m = regex.exec(html)) !== null) matches.push({ dataUrl: m[1] });
    if (!matches.length) return html;

    console.log(`[CardByte] Compressing ${matches.length} image(s) — mobile: ${mobile}`);
    let result = html;

    for (const item of matches) {
      const isGif = item.dataUrl.startsWith("data:image/gif");
      if (isGif && mobile) {
        const png = await convertGifToStaticPng(item.dataUrl);
        if (png !== item.dataUrl) result = result.replace(item.dataUrl, png);
        continue;
      }
      if (isGif) continue;
      const compressed = await compressBase64Image(item.dataUrl);
      if (compressed !== item.dataUrl) result = result.replace(item.dataUrl, compressed);
    }

    if (result.length > getMaxHtmlSize()) {
      for (const item of matches) {
        if (item.dataUrl.startsWith("data:image/gif") && result.includes(item.dataUrl)) {
          const png = await convertGifToStaticPng(item.dataUrl);
          if (png !== item.dataUrl) result = result.replace(item.dataUrl, png);
        }
      }
    }
    return result;
  }

  /* ── Main applySignature — all platforms ──────────────────────────── */

  const applySignature = useCallback(async (signature) => {
    if (!signature) return;
    if (typeof Office === "undefined") { console.error("Office.js not available"); return; }
    const mailbox = Office?.context?.mailbox;
    const item = mailbox?.item;

    try {
      if (!item) { console.warn("[CardByte] No mail item found"); return; }
      let compressedSignature = await compressImagesInHtml(signature);
      compressedSignature = "<div style='margin-top:40px'></div>" + compressedSignature;
      console.log("[CardByte] applySignature: writing to compose body — platform:", detectPlatform());
      await bodySetSignatureAsync(item, compressedSignature);
      console.log("[CardByte] applySignature: done. platform:", detectPlatform());
    } catch (err) {
      console.error("[CardByte] Error in applySignature:", err);
    }
  }, [mobile]);  // mobile is stable after first render

  // Register once so the prefetch loop (and any future persist call)
  // triggers a live insertion on whatever item is currently open.
  useEffect(() => {
    onSignaturePersisted((html) => {
      console.log("[CardByte] onSignaturePersisted fired — auto-inserting");
      applySignature(html);   // your existing function, all platforms
    });

    // Unregister on unmount so stale closures don't fire
    return () => onSignaturePersisted(null);
  }, [applySignature]);   // applySignature is stable because it's defined with useCallback

  /* ── Fetch signature from server ──────────────────────────────────── */

  /**
   * Fetches the user's signature from the CardByte server, writes it to
   * localStorage (and roamingSettings) via persistSignatureToStorage(), then
   * returns the raw HTML.
   *
   * This is the single place where a network fetch happens in the React app.
   * After this call, event.js and event-handler-classic.js can read the
   * signature from localStorage without a network round-trip.
   */
  async function fetchSignatureFromServer(emailAddress) {
    if (!emailAddress) return null;
    try {
      const diagnosticsPlatform = Office?.context?.diagnostics?.platform;
      const xPlatform = diagnosticsPlatform === Office.PlatformType.Mac ? "MAC" : "WINDOWS";
      const encryptedMail = await encryptEmail(emailAddress);
      if (!encryptedMail) return null;

      const res = await fetch(
        "https://newqa-enterprise.cardbyte.ai/email-signature/html/outlook/get-active",
        {
          method: "GET",
          headers: {
            "Content-Type": "application/json",
            "username": encryptedMail,
            "X-Platform": xPlatform
          }
        }
      );

      if (!res.ok) { console.warn("[CardByte] fetchSignatureFromServer: HTTP", res.status); return null; }

      const encryptedText = await res.text();
      const decryptedText = await handleAesDecrypt(encryptedText);
      const html = JSON.parse(decryptedText)?.html || null;

      if (html) {
        // ── KEY STEP: persist to localStorage immediately so that
        //    event.js (SharedRuntime) and event-handler-classic.js
        //    both get an instant cache hit next time they fire.
        persistSignatureToStorage(html);
        console.log("[CardByte] fetchSignatureFromServer: signature fetched and persisted ✅");
      }

      return html;
    } catch (err) {
      console.warn("[CardByte] fetchSignatureFromServer: error:", err);
      return null;
    }
  }

  /* ── Auth / load ──────────────────────────────────────────────────── */

  async function loadSignature() {
    try {
      setLoading(true);

      // Attempt to fetch a fresh copy and populate the shared cache.
      const emailAddress = user?.emailAddress || Office?.context?.mailbox?.userProfile?.emailAddress;
      if (emailAddress) {
        await fetchSignatureFromServer(emailAddress);
      }

      setMode("ready");
    } catch (e) {
      console.warn("[CardByte] loadSignature error:", e);
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

  /* ── Render ───────────────────────────────────────────────────────── */

  if (mode === "login") return <LoginForm onLogin={handleLogin} loading={loading} error={error} />;

  if (mode === "ready") return (
    <SignatureView
      Office={Office}
      user={user}
      apply={applySignature}
      refresh={loadSignature}
      loading={loading}
      error={error}
      autoApply={autoApply}
      isMobile={mobile}
      platform={platform}
    />
  );

  return <div>Initializing add-in…</div>;
}

function decodeJwt(token) {
  const base64 = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(atob(base64));
}