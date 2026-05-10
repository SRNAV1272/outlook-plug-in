/* global Office */
import React, { useCallback, useEffect, useState } from "react";
import { getOfficeToken, login, setToken, getToken } from "./services/authService";
import LoginForm from "./components/LoginForm";
import SignatureView from "./components/SignatureView";

// ─────────────────────────────────────────────────────────────────────────────
// SIZE LIMITS
// Mobile Outlook has a much tighter HTML body limit than desktop / OWA.
// ─────────────────────────────────────────────────────────────────────────────
const MAX_SAFE_HTML_SIZE = 500_000;  // ~500 KB  — desktop / OWA
const MAX_SAFE_HTML_SIZE_MOBILE = 200_000;  // ~200 KB  — iOS / Android
const MOBILE_MAX_IMAGE_WIDTH = 200;      // px  — shrink images on mobile
const MOBILE_IMAGE_QUALITY = 0.5;      // JPEG quality on mobile

// ─────────────────────────────────────────────────────────────────────────────
// PLATFORM DETECTION
// Returns: 'mobile-ios' | 'mobile-android' | 'owa' | 'desktop'
// ─────────────────────────────────────────────────────────────────────────────
export function detectPlatform() {
  try {
    const platform = (Office?.context?.platform || "").toLowerCase();
    const ua = (navigator?.userAgent || "").toLowerCase();

    if (platform === "ios" || platform === "iphone" || platform === "ipad") return "mobile-ios";
    if (platform === "android") return "mobile-android";

    // Outlook Mobile UA fallback
    if (ua.includes("outlookmobile") || ua.includes("outlook-ios") || ua.includes("outlook-android"))
      return ua.includes("android") ? "mobile-android" : "mobile-ios";

    // Some mobile builds report platform as "officeonline"/"" but have mobile UA
    if (
      (platform === "officeonline" || platform === "web" || platform === "") &&
      (ua.includes("iphone") || ua.includes("ipad") || ua.includes("android"))
    ) return ua.includes("android") ? "mobile-android" : "mobile-ios";

    if (platform === "officeonline" || platform === "web" || platform === "") return "owa";
    return "desktop";
  } catch { return "desktop"; }
}

function isMobile() {
  const p = detectPlatform();
  return p === "mobile-ios" || p === "mobile-android";
}

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

// ─────────────────────────────────────────────────────────────────────────────
// AUTO-APPLY CONTEXT
// ?autoApply=1  →  taskpane was opened automatically via ItemEdit form load
// (Outlook 2016 / 2019 / mobile — these don't support LaunchEvent)
// ─────────────────────────────────────────────────────────────────────────────
function isAutoApplyContext() {
  try {
    return new URLSearchParams(window.location.search).get("autoApply") === "1";
  } catch { return false; }
}

// ─────────────────────────────────────────────────────────────────────────────
// APP
// ─────────────────────────────────────────────────────────────────────────────
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

  /* ── Outlook body helpers ────────────────────────────────── */

  function bodySetSignatureAsync(item, html) {
    return new Promise((res, rej) => {
      if (typeof item.body.setSignatureAsync !== "function") { rej(new Error("setSignatureAsync not available")); return; }
      item.body.setSignatureAsync(html, { coercionType: Office.CoercionType.Html },
        (r) => r.status === "succeeded" ? res() : rej(r.error));
    });
  }

  /* ── Image processing — mobile-aware ────────────────────── */

  function compressBase64Image(dataUrl, maxWidth, quality) {
    if (maxWidth === undefined) maxWidth = mobile ? MOBILE_MAX_IMAGE_WIDTH : 300;
    if (quality === undefined) quality = mobile ? MOBILE_IMAGE_QUALITY : 0.7;

    return new Promise((resolve) => {
      // Desktop: preserve GIF animation in first pass
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
        // Mobile: convert GIFs to static PNG immediately
        const png = await convertGifToStaticPng(item.dataUrl);
        if (png !== item.dataUrl) result = result.replace(item.dataUrl, png);
        continue;
      }
      if (isGif) continue; // desktop: skip in first pass to preserve animation
      const compressed = await compressBase64Image(item.dataUrl);
      if (compressed !== item.dataUrl) result = result.replace(item.dataUrl, compressed);
    }

    // Second pass: if still over limit, convert remaining desktop GIFs too
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

  /**
   * Full-body replacement (last resort / mobile default).
   *
   * MOBILE:  setAsync most reliable; setSignatureAsync is NOT available.
   * DESKTOP: setSignatureAsync → setAsync → prependAsync → setSelectedDataAsync.
   */
  function moveCursorToTop(item) {
    return new Promise((resolve) => {
      try {
        if (typeof item.body?.prependAsync !== "function") { resolve(); return; }
        // prependAsync with empty text moves the insertion point to before all content
        item.body.prependAsync("", { coercionType: Office.CoercionType.Text }, () => {
          if (typeof item.body?.setSelectedDataAsync !== "function") { resolve(); return; }
          item.body.setSelectedDataAsync("", { coercionType: Office.CoercionType.Text }, () => resolve());
        });
      } catch { resolve(); }
    });
  }

  /* ── Main applySignature — all platforms ─────────────────── */

  async function applySignature(signature) {
    if (!signature) return;
    if (typeof Office === "undefined") { console.error("Office.js not available"); return; }
    const mailbox = Office?.context?.mailbox;
    const item = mailbox?.item;

    try {
      if (!item) {
        console.warn("[CardByte] No mail item found");
        return;
      }

      const platform = detectPlatform();
      const mobile = isMobile();
      const mac = isMac();
      let compressedSignature = await compressImagesInHtml(signature);
      compressedSignature = "<div style='margin-top:40px'></div>" + compressedSignature;
      console.log("[CardByte] ════════════════════════════════════",
        signature ? "Using provided signature" : "No signature provided",
        compressedSignature, item?.body
      );

      await bodySetSignatureAsync(item, compressedSignature)

      console.log("[CardByte] User:", user?.emailAddress);
      console.log("[CardByte] Platform:", platform);
      console.log("[CardByte] isMobile:", mobile, "| isMac:", mac, "| isOWA:", isOWA());


    } catch (err) {
      console.error("[CardByte] Error in applySignature:", err);
    } finally {
      // event.completed();
    }
  }

  /* ── Auth / load ─────────────────────────────────────────── */

  async function loadSignature() {
    try { setLoading(true); setMode("ready"); }
    catch (e) { setError("Unable to load signature"); setMode("ready"); }
    finally { setLoading(false); }
  }

  async function handleLogin(form) {
    try { setLoading(true); await login(form.username, form.password); await loadSignature(); }
    catch { setError("Invalid username or password"); setMode("ready"); }
    finally { setLoading(false); }
  }

  /* ── Render ──────────────────────────────────────────────── */

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