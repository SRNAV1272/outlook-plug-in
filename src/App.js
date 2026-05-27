/* global Office, OfficeRuntime */
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
// GLOBALTHIS SIGNATURE CACHE
// Scoped to the taskpane JS context only — NOT shared with commands.js.
// roamingSettings remains the bridge to the event-handler context.
// =============================================================================
const MEM_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Returns the cached signature html if it exists and is within TTL.
 * @returns {string|null}
 */
function getMemCache() {
  try {
    const entry = window.MEMORY_SIGNATURE;
    if (!entry?.html || !entry?.ts) return null;
    const age = Date.now() - entry.ts;
    if (age > MEM_CACHE_TTL_MS) {
      console.log("[CardByte] MemCache: expired (age=%dms) — busting", age);
      window.MEMORY_SIGNATURE = null;
      return null;
    }
    console.log("[CardByte] MemCache: hit (age=%dms)", age);
    return entry.html;
  } catch {
    return null;
  }
}

/**
 * Writes a signature html string into the in-memory cache with current timestamp.
 * @param {string} html
 */
function setMemCache(html) {
  try {
    window.MEMORY_SIGNATURE = { html, ts: Date.now() };
    console.log("[CardByte] MemCache: written ✅", new Date().toISOString());
  } catch (e) {
    console.warn("[CardByte] MemCache: write failed —", e);
  }
}

/**
 * Force-invalidates the in-memory cache (e.g. on explicit refresh).
 */
function bustMemCache() {
  window.MEMORY_SIGNATURE = null;
  console.log("[CardByte] MemCache: manually busted");
}

// =============================================================================
// PREFETCH — owned here, but STARTED from index.js inside Office.onReady.
// No Office.onReady call in this file — that caused the race condition.
// =============================================================================
const CACHE_KEY = "cardbyte_sig_html";
const REFRESH_INTERVAL_MS = 4 * 60 * 1000; // 4 min

// Module-level handle — persists across React re-renders.
let _prefetchIntervalId = null;

async function _prefetchSignatureForClassic() {
  try {
    const diagnosticsPlatform = Office?.context?.diagnostics?.platform;

    console.log("[CardByte] Prefetch: platform =", diagnosticsPlatform);

    // Guard: only Classic Outlook on Windows needs the roamingSettings cache.
    if (diagnosticsPlatform !== Office.PlatformType.PC) {
      console.log("[CardByte] Prefetch: skipping — not Classic Windows");
      return;
    }

    const email = Office?.context?.mailbox?.userProfile?.emailAddress;
    if (!email) {
      console.warn("[CardByte] Prefetch: no emailAddress — skipping");
      return;
    }

    const xPlatform = diagnosticsPlatform === Office.PlatformType.Mac ? "MAC" : "WINDOWS";
    const encryptedMail = await encryptEmail(email);
    if (!encryptedMail) {
      console.warn("[CardByte] Prefetch: encryptEmail returned empty — skipping");
      return;
    }

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

    if (!res.ok) {
      console.warn("[CardByte] Prefetch: HTTP", res.status, res.statusText);
      return;
    }

    const encryptedText = await res.text();
    const decryptedText = await handleAesDecrypt(encryptedText);
    const html = JSON.parse(decryptedText)?.html || null;

    if (!html) {
      console.warn("[CardByte] Prefetch: no html field after decrypt — skipping write");
      return;
    }

    // ── Write to all three caches ─────────────────────────────────────────────
    // 1. In-memory: fast path for taskpane re-use
    setMemCache(html);

    // 2. OfficeRuntime.storage: PRIMARY cache for event-handler-classic.js
    try {
      if (typeof OfficeRuntime !== "undefined" && OfficeRuntime.storage) {
        await OfficeRuntime.storage.setItem(CACHE_KEY, JSON.stringify({ html, ts: Date.now() }));
        console.log("[CardByte] Prefetch: OfficeRuntime.storage updated ✅", new Date().toISOString());
      } else {
        console.warn("[CardByte] Prefetch: OfficeRuntime.storage not available — skipping");
      }
    } catch (ortErr) {
      console.warn("[CardByte] Prefetch: OfficeRuntime.storage write failed —", ortErr);
    }

    // 3. roamingSettings: fallback bridge for event-handler-classic.js
    const rs = Office.context.roamingSettings;
    rs.set(CACHE_KEY, { html, ts: Date.now() });
    rs.saveAsync(result => {
      if (result.status === Office.AsyncResultStatus.Succeeded) {
        console.log("[CardByte] Prefetch: roamingSettings updated ✅", new Date().toISOString());
      } else {
        console.warn("[CardByte] Prefetch: roamingSettings save failed —", result.error?.message);
      }
    });

  } catch (err) {
    console.warn("[CardByte] Prefetch: unexpected error:", err);
  }
}

/**
 * Exported — called once from index.js INSIDE Office.onReady,
 * so Office.context is guaranteed to be fully available.
 */
export function startPrefetchLoop() {
  if (_prefetchIntervalId) {
    clearInterval(_prefetchIntervalId);
    _prefetchIntervalId = null;
  }

  // Warm caches from roamingSettings immediately (before first network call).
  try {
    const cached = Office.context.roamingSettings.get(CACHE_KEY);
    if (cached?.html) {
      // 1. MemCache
      setMemCache(cached.html);
      console.log("[CardByte] startPrefetchLoop: warmed MemCache from roamingSettings");

      // 2. OfficeRuntime.storage — seed it so event-handler-classic.js has a hit
      //    even before the first network prefetch completes.
      if (typeof OfficeRuntime !== "undefined" && OfficeRuntime.storage) {
        OfficeRuntime.storage
          .setItem(CACHE_KEY, JSON.stringify({ html: cached.html, ts: Date.now() }))
          .then(() => console.log("[CardByte] startPrefetchLoop: warmed OfficeRuntime.storage from roamingSettings ✅"))
          .catch(e => console.warn("[CardByte] startPrefetchLoop: OfficeRuntime.storage warm failed —", e));
      }
    }
  } catch (e) {
    console.warn("[CardByte] startPrefetchLoop: roamingSettings warm failed —", e);
  }

  // Immediate fetch — cache warm before first compose
  _prefetchSignatureForClassic();

  // Periodic refresh — keeps all caches current for long sessions
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

function isMobile() { const p = detectPlatform(); return p === "mobile-ios" || p === "mobile-android"; }
function isOWA() { return detectPlatform() === "owa"; }
function isMac() { return detectPlatform() === "mac"; }

export function isMobilePlatform() {
  const p = detectPlatform();
  return p === "mobile-ios" || p === "mobile-android";
}

export function isOWAPlatform() {
  return detectPlatform() === "owa";
}

function getMaxHtmlSize() {
  return isMobilePlatform() ? MAX_SAFE_HTML_SIZE_MOBILE : MAX_SAFE_HTML_SIZE;
}

// =============================================================================
// AUTO-APPLY CONTEXT
// =============================================================================
function isAutoApplyContext() {
  try {
    return new URLSearchParams(window.location.search).get("autoApply") === "1";
  } catch { return false; }
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

  // Auth init only — prefetch loop is owned by startPrefetchLoop() in index.js.
  useEffect(() => {
    init();
  }, [init]);

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

  function moveCursorToTop(item) {
    return new Promise((resolve) => {
      try {
        if (typeof item.body?.prependAsync !== "function") { resolve(); return; }
        item.body.prependAsync("", { coercionType: Office.CoercionType.Text }, () => {
          if (typeof item.body?.setSelectedDataAsync !== "function") { resolve(); return; }
          item.body.setSelectedDataAsync("", { coercionType: Office.CoercionType.Text }, () => resolve());
        });
      } catch { resolve(); }
    });
  }

  /* ── Main applySignature — all platforms ──────────────────────────── */

  async function applySignature(signature) {
    if (typeof Office === "undefined") { console.error("Office.js not available"); return; }
    const mailbox = Office?.context?.mailbox;
    const item = mailbox?.item;

    try {
      if (!item) { console.warn("[CardByte] No mail item found"); return; }

      const platform = detectPlatform();
      const mobile = isMobile();
      const mac = isMac();

      // ── Resolve signature HTML ──────────────────────────────────────────
      // Priority: caller-provided → MemCache (if fresh) → no-op
      // The prefetch loop keeps MemCache warm; we never re-fetch here.
      let resolvedHtml = signature || getMemCache();

      if (!resolvedHtml) {
        console.warn("[CardByte] applySignature: no signature available (cache empty, none provided)");
        return;
      }

      if (!signature && resolvedHtml) {
        console.log("[CardByte] applySignature: using MemCache hit");
      }

      let compressedSignature = await compressImagesInHtml(resolvedHtml);
      compressedSignature = "<div style='margin-top:40px'></div>" + compressedSignature;

      console.log("[CardByte] ════════════════════════════════════",
        "Applying signature",
        compressedSignature, item?.body
      );

      await bodySetSignatureAsync(item, compressedSignature);

      console.log("[CardByte] User:", user?.emailAddress);
      console.log("[CardByte] Platform:", platform);
      console.log("[CardByte] isMobile:", mobile, "| isMac:", mac, "| isOWA:", isOWA());

    } catch (err) {
      console.error("[CardByte] Error in applySignature:", err);
    }
  }

  /* ── Auth / load ──────────────────────────────────────────────────── */

  async function loadSignature() {
    try { setLoading(true); setMode("ready"); }
    catch (e) { setError("Unable to load signature"); setMode("ready"); }
    finally { setLoading(false); }
  }

  /**
   * Called when SignatureView requests an explicit refresh.
   * Busts MemCache so the next applySignature call won't use stale data,
   * then delegates to the prefetch loop to re-fetch and re-populate.
   */
  async function handleRefresh() {
    bustMemCache();
    await _prefetchSignatureForClassic();
    await loadSignature();
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
      refresh={handleRefresh}
      loading={loading}
      error={error}
      autoApply={autoApply}
      isMobile={mobile}
      platform={platform}
      cachedSignature={getMemCache()}
    />
  );

  return <div>Initializing add-in…</div>;
}

function decodeJwt(token) {
  const base64 = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(atob(base64));
}