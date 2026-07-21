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

  /* ── Main applySignature — all platforms ─────────────────── */

  const MANUAL_OVERRIDE_PROP = "cardbyte_manual_sig_id";

  function loadCustomProps(item) {
    return new Promise((resolve) => {
      if (typeof item?.loadCustomPropertiesAsync !== "function") return resolve(null);
      try {
        item.loadCustomPropertiesAsync((res) =>
          resolve(res.status === Office.AsyncResultStatus.Succeeded ? res.value : null));
      } catch { resolve(null); }
    });
  }

  async function markManualOverride(item, sigId) {
    if (!sigId) return;
    const props = await loadCustomProps(item);
    if (!props) return;
    props.set(MANUAL_OVERRIDE_PROP, String(sigId));
    await new Promise((resolve) =>
      props.saveAsync((res) => resolve(res.status === Office.AsyncResultStatus.Succeeded)));
  }

  async function applySignature(signature, sigId) {
    if (!signature) return;
    if (typeof Office === "undefined") { console.error("Office.js not available"); return; }
    const item = Office?.context?.mailbox?.item;
    if (!item) { console.warn("[CardByte] No mail item found"); return; }

    try {
      await bodySetSignatureAsync(item, signature);   // apply as-is, no compression
      await markManualOverride(item, sigId);          // pin this choice for send-time
      console.log("[CardByte] Manual signature applied & pinned:", sigId);
    } catch (err) {
      console.error("[CardByte] Error in applySignature:", err);
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