/* global Office */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { getOfficeToken, login, setToken, getToken } from "./services/authService";
import LoginForm from "./components/LoginForm";
import SignatureView from "./components/SignatureView";

// ─────────────────────────────────────────────────────────────────────────────
// SIZE LIMITS
// ─────────────────────────────────────────────────────────────────────────────
const MAX_SAFE_HTML_SIZE        = 500_000;   // ~500 KB — desktop / OWA
const MAX_SAFE_HTML_SIZE_MOBILE = 200_000;   // ~200 KB — iOS / Android
const MOBILE_MAX_IMAGE_WIDTH    = 200;       // px — shrink images on mobile
const MOBILE_IMAGE_QUALITY      = 0.5;       // JPEG quality on mobile

// Matches commands.js guard: body text must exceed this to trust freshBody
const MAC_SAFE_THRESHOLD = 30; // visible chars

// ─────────────────────────────────────────────────────────────────────────────
// PLATFORM DETECTION
// Returns: 'mobile-ios' | 'mobile-android' | 'mac' | 'owa' | 'desktop'
// ─────────────────────────────────────────────────────────────────────────────
export function detectPlatform() {
  try {
    const platform = (Office?.context?.platform || "").toLowerCase();
    const ua       = (navigator?.userAgent || "").toLowerCase();

    if (platform === "ios" || platform === "iphone" || platform === "ipad") return "mobile-ios";
    if (platform === "android") return "mobile-android";

    if (ua.includes("outlookmobile") || ua.includes("outlook-ios") || ua.includes("outlook-android"))
      return ua.includes("android") ? "mobile-android" : "mobile-ios";

    if (
      (platform === "officeonline" || platform === "web" || platform === "") &&
      (ua.includes("iphone") || ua.includes("ipad") || ua.includes("android"))
    ) return ua.includes("android") ? "mobile-android" : "mobile-ios";

    if (platform === "mac") return "mac";
    if (
      (platform === "" || platform === "desktop") &&
      (ua.includes("macintosh") || ua.includes("mac os x")) &&
      !ua.includes("iphone") &&
      !ua.includes("ipad")
    ) return "mac";

    if (platform === "officeonline" || platform === "web" || platform === "") return "owa";
    return "desktop";
  } catch { return "desktop"; }
}

export function isMobilePlatform() {
  const p = detectPlatform();
  return p === "mobile-ios" || p === "mobile-android";
}
export function isMacPlatform()  { return detectPlatform() === "mac"; }
export function isOWAPlatform()  { return detectPlatform() === "owa"; }

// Alias used throughout to match commands.js naming
function isMac()    { return isMacPlatform(); }
function isOWA()    { return isOWAPlatform(); }
function isMobile() { return isMobilePlatform(); }

function getMaxHtmlSize() {
  return isMobile() ? MAX_SAFE_HTML_SIZE_MOBILE : MAX_SAFE_HTML_SIZE;
}

// ─────────────────────────────────────────────────────────────────────────────
// AUTO-APPLY CONTEXT
// ─────────────────────────────────────────────────────────────────────────────
function isAutoApplyContext() {
  try {
    return new URLSearchParams(window.location.search).get("autoApply") === "1";
  } catch { return false; }
}

// ─────────────────────────────────────────────────────────────────────────────
// SIGNATURE STRIP HELPERS  (unchanged from original App.js)
// ─────────────────────────────────────────────────────────────────────────────
function stripDivById(html, idPattern) {
  if (isMac()) {
    const startMarker = "<!-- CARD_BYTE_SIGNATURE_START -->";
    const endMarker   = "<!-- CARD_BYTE_SIGNATURE_END -->";
    const startIdx    = html.indexOf(startMarker);
    const endIdx      = html.indexOf(endMarker);
    if (startIdx !== -1 && endIdx !== -1)
      return html.slice(0, startIdx) + html.slice(endIdx + endMarker.length);
  }

  const tempRegex = new RegExp(`<div[^>]*id="([^"]*)"[^>]*>`, "gi");
  let openMatch, matchedIndex = -1, matchedLength = 0;

  while ((openMatch = tempRegex.exec(html)) !== null) {
    if (idPattern.test(openMatch[1])) {
      matchedIndex  = openMatch.index;
      matchedLength = openMatch[0].length;
      break;
    }
  }
  if (matchedIndex === -1) return html;

  let pos = matchedIndex + matchedLength, depth = 1;
  while (pos < html.length && depth > 0) {
    const nextOpen  = html.indexOf("<div",  pos);
    const nextClose = html.indexOf("</div>", pos);
    if (nextClose === -1) break;
    if (nextOpen !== -1 && nextOpen < nextClose) { depth++; pos = nextOpen + 4; }
    else                                          { depth--; pos = nextClose + 6; }
  }
  return html.slice(0, matchedIndex) + html.slice(pos);
}

function stripSig(html) {
  let result = html;
  if (isMac()) {
    result = result.replace(/<div\s+class="[^"]*signature[^"]*"[^>]*>[\s\S]*?<\/div>/gi, "");
    result = result.replace(/<div\s+id="[^"]*Signature[^"]*"[^>]*>[\s\S]*?<\/div>/gi, "");
  }
  result = stripDivById(result, /x?_?cardbyte-signature-block/i);
  result = result.replace(/<!-- CARD_BYTE_SIGNATURE_START -->[\s\S]*?<!-- CARD_BYTE_SIGNATURE_END -->/gi, "");
  result = result.replace(/<!-- CARDBYTE_SIGNATURE -->/gi, "");
  if (isMac()) result = result.replace(/<div[^>]*>\s*<\/div>/gi, "");
  result = result.replace(/(\s|<br\s*\/?>|&nbsp;)+$/gi, "").trimEnd();
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// REPLY CHAIN INDEX HELPER  (expanded to match commands.js Tier-5 markers)
// ─────────────────────────────────────────────────────────────────────────────
function findReplyChainIndex(html) {
  const replyMarkers = [
    /<div[^>]*id="?x?_?divRplyFwdMsg"?/i,
    /<div[^>]*id="?appendonsend"?/i,
    /<hr[^>]*style="[^"]*display\s*:\s*inline-block/i,
    /<blockquote/i,
    /class="?OutlookMessageHeader"?/i,
    /<(?:div|hr|span|table)[^>]*class="[^"]*ms-outlook-[^"]*"/i,
    /<(?:div|hr|span|table)[^>]*class="[^"]*ms-owa-[^"]*"/i,
    /<[^>]*\sdata-ogsc[\s=>]/i,
    /<hr[^>]*class="[^"]*separator[^"]*"/i,
    /<div[^>]*class="?WordSection[0-9]"?/i,
    /x_divRplyFwdMsg/i,
    /divRplyFwdMsg/i,
    /<div[^>]*class="[^"]*gmail_extra[^"]*"/i,
    /<div[^>]*class="[^"]*yahoo_quoted[^"]*"/i,
    /<!--\s*--original message--\s*-->/i,
    /On .{10,80} wrote:/i,
  ];
  let earliest = -1;
  for (const marker of replyMarkers) {
    const idx = html.search(marker);
    if (idx > -1 && (earliest === -1 || idx < earliest)) earliest = idx;
  }
  return earliest;
}

// ─────────────────────────────────────────────────────────────────────────────
// DETECTION HELPERS
// ─────────────────────────────────────────────────────────────────────────────
function hasCardByteSignature(html) {
  if (
    html.includes("CARD_BYTE_SIGNATURE_START") ||
    html.includes("CARDBYTE_SIGNATURE")        ||
    html.includes("CB_SIG_START")              ||
    /id="x?_?cardbyte-signature-block"/i.test(html)
  ) return true;
  if (isMac()) {
    return [
      /<div[^>]*style="[^"]*font-family:Calibri[^"]*"[^>]*>[\s\S]*?CardByte/i,
      /<div[^>]*contenteditable="false"[^>]*>[\s\S]*?<!-- CARD_BYTE/i,
    ].some(p => p.test(html));
  }
  return false;
}

function detectReplyChain(html) {
  return [
    /divRplyFwdMsg/i, /appendonsend/i, /OriginalMessage/i, /<blockquote/i,
    /x_divRplyFwdMsg/i, /class="?OutlookMessageHeader"?/i,
    /<hr[^>]*style="[^"]*display\s*:\s*inline-block/i,
    /<(?:div|hr|span|table)[^>]*class="[^"]*ms-outlook-[^"]*"/i,
    /<(?:div|hr|span|table)[^>]*class="[^"]*ms-owa-[^"]*"/i,
    /<[^>]*\sdata-ogsc[\s=>]/i,
    /<hr[^>]*class="[^"]*separator[^"]*"/i,
    /<div[^>]*class="?WordSection[0-9]"?/i,
  ].some(p => p.test(html));
}

function containsGifImages(html) { return /data:image\/gif;base64,/i.test(html); }

// ─────────────────────────────────────────────────────────────────────────────
// SAFE-ZONE STRIP
// ─────────────────────────────────────────────────────────────────────────────
function stripSigFromSafeZoneOnly(html) {
  const chainIndex = findReplyChainIndex(html);
  if (chainIndex === -1) {
    const stripped = stripSig(html);
    if (hasCardByteSignature(html) && !hasCardByteSignature(stripped))
      console.log("[CardByte] Successfully stripped signature from safe zone");
    else if (hasCardByteSignature(html) && hasCardByteSignature(stripped))
      console.warn("[CardByte] WARNING: Signature still present after strip!");
    return { safeZone: stripped, replyChain: "", fullStripped: stripped };
  }
  const safeZone   = stripSig(html.slice(0, chainIndex));
  const replyChain = html.slice(chainIndex);
  if (hasCardByteSignature(html.slice(0, chainIndex)) && !hasCardByteSignature(safeZone))
    console.log("[CardByte] Successfully stripped signature from safe zone (with reply chain)");
  return { safeZone, replyChain, fullStripped: safeZone + replyChain };
}

// ─────────────────────────────────────────────────────────────────────────────
// MOBILE: wait for mail item to be fully ready
// ─────────────────────────────────────────────────────────────────────────────
async function waitForItemReady(item, maxRetries = 6, delayMs = 500) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      await new Promise((resolve, reject) => {
        item.body.getAsync(Office.CoercionType.Html,
          (r) => r.status === "succeeded" ? resolve() : reject(r.error));
      });
      console.log(`[CardByte] Item ready after ${i + 1} attempt(s)`);
      return true;
    } catch (e) {
      console.warn(`[CardByte] Item not ready (${i + 1}/${maxRetries}): ${e?.message || e}`);
      if (i < maxRetries - 1) await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  console.error("[CardByte] Item never became ready");
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// MOBILE HTML SIMPLIFICATION
// ─────────────────────────────────────────────────────────────────────────────
function simplifyHtmlForMobile(html) {
  return html
    .replace(/<link[^>]*rel="stylesheet"[^>]*>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<!--\[if[^>]*>[\s\S]*?<!\[endif\]-->/gi, "")
    .replace(/(<table[^>]*?)width\s*=\s*"?\d+"?/gi, '$1width="100%" style="max-width:100%;"');
}

// ─────────────────────────────────────────────────────────────────────────────
// OUTLOOK WRAPPER — platform-aware markup
// ─────────────────────────────────────────────────────────────────────────────
function wrapForOutlook(innerHtml) {
  if (isMobile()) {
    return `<div id="cardbyte-signature-block" contenteditable="false" style="font-family:Arial,sans-serif;font-size:14px;"><table contenteditable="false" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:100%;"><tbody><tr><td style="padding:0;margin:0;">${innerHtml}<tr></tr></tbody></table></div>`;
  }
  if (isMac()) {
    // Mac: no MSO table, no mso-line-height-rule — matches commands.js wrapForOutlook Mac omission
    return `<div id="cardbyte-signature-block" contenteditable="false" style="font-family:Calibri,Arial,sans-serif;font-size:11pt;">${innerHtml}</div>`;
  }
  // Windows Desktop / OWA
  return `<div id="cardbyte-signature-block" contenteditable="false" style="font-family:Calibri,Arial,sans-serif;font-size:11pt;mso-line-height-rule:exactly;"><table contenteditable="false" cellpadding="0" cellspacing="0" border="0" style="font-family:inherit;font-size:inherit;color:inherit;"><tbody><tr><td style="padding:0;margin:0;">${innerHtml}</td></tr></tbody></table></div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// APP
// ─────────────────────────────────────────────────────────────────────────────
export default function App({ user }) {
  const [mode,    setMode]    = useState("init");
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState("");

  // Mirror commands.js SIGNATURE_STATE guard ("idle" | "loading" | "applied")
  const signatureStateRef = useRef("idle");
  // Mirror commands.js __INSERTING_SIGNATURE__ guard
  const insertingRef = useRef(false);

  const autoApply  = isAutoApplyContext();
  const mobile     = isMobile();
  const mac        = isMac();
  const platform   = detectPlatform();

  const init = useCallback(async () => {
    setLoading(true);
    setError("");
    const cached = getToken();
    if (cached) { await loadSignature(); return; }
    try {
      const token   = await getOfficeToken();
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

  // ─────────────────────────────────────────────────────────────────────────
  // OUTLOOK BODY PRIMITIVES
  // ─────────────────────────────────────────────────────────────────────────

  function getBodyHtml(item) {
    return new Promise((res, rej) => {
      item.body.getAsync(Office.CoercionType.Html,
        (r) => r.status === "succeeded" ? res(r.value || "") : rej(r.error));
    });
  }

  /** Standard setAsync — calls prependAsync("") after to reset cursor (non-Mac) */
  function bodySetAsync(item, html) {
    return new Promise((res, rej) => {
      item.body.setAsync(html, { coercionType: Office.CoercionType.Html }, (r) => {
        if (r.status !== "succeeded") { rej(r.error); return; }
        if (typeof item.body?.prependAsync === "function") {
          item.body.prependAsync("", { coercionType: Office.CoercionType.Html }, () => res());
        } else { res(); }
      });
    });
  }

  /** Mac-safe setAsync — no trailing prependAsync (avoids cursor flash) */
  function bodySetAsyncMac(item, html) {
    return new Promise((res, rej) => {
      item.body.setAsync(html, { coercionType: Office.CoercionType.Html },
        (r) => r.status === "succeeded" ? res() : rej(r.error));
    });
  }

  function bodyPrependAsync(item, html) {
    return new Promise((res, rej) => {
      if (typeof item.body.prependAsync !== "function") {
        rej(new Error("prependAsync not available")); return;
      }
      item.body.prependAsync(html, { coercionType: Office.CoercionType.Html },
        (r) => r.status === "succeeded" ? res() : rej(r.error));
    });
  }

  function bodySetSelectedDataAsync(item, html) {
    return new Promise((res, rej) => {
      if (typeof item.body.setSelectedDataAsync !== "function") {
        rej(new Error("setSelectedDataAsync not available")); return;
      }
      item.body.setSelectedDataAsync(html, { coercionType: Office.CoercionType.Html },
        (r) => r.status === "succeeded" ? res() : rej(r.error));
    });
  }

  function bodySetSignatureAsync(item, html) {
    return new Promise((res, rej) => {
      if (typeof item.body.setSignatureAsync !== "function") {
        rej(new Error("setSignatureAsync not available")); return;
      }
      item.body.setSignatureAsync(html, { coercionType: Office.CoercionType.Html },
        (r) => r.status === "succeeded" ? res() : rej(r.error));
    });
  }

  /** Clear + setSelectedDataAsync — full-body replacement without setAsync on desktop */
  function bodySelectAllAndReplaceAsync(item, html) {
    return new Promise((res, rej) => {
      if (typeof item.body.setSelectedDataAsync !== "function") {
        rej(new Error("setSelectedDataAsync not available")); return;
      }
      item.body.setAsync("", { coercionType: Office.CoercionType.Html }, (clearResult) => {
        if (clearResult.status !== "succeeded") { rej(clearResult.error); return; }
        item.body.setSelectedDataAsync(html, { coercionType: Office.CoercionType.Html },
          (r2) => r2.status === "succeeded" ? res() : rej(r2.error));
      });
    });
  }

  /** Stabilize selection — skipped on Mac (causes visual flash) */
  function stabilizeSelection(item) {
    if (mac) return Promise.resolve();
    return new Promise((resolve) => {
      try {
        if (typeof item.body?.setSelectedDataAsync !== "function") { resolve(); return; }
        item.body.setSelectedDataAsync("", { coercionType: Office.CoercionType.Text }, () => resolve());
      } catch { resolve(); }
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // DEFAULT SIGNATURE STRIP
  // ─────────────────────────────────────────────────────────────────────────

  function looksLikeDefaultSignature(html) {
    return [
      /class="?MsoNormal"?/i, /<meta name="Generator" content="Microsoft/i,
      /id="?Signature"?/i, /id="?ms-outlook-mobile-signature"?/i,
      /class="?OutlookMessageHeader"?/i, /--\s*<br\s*\/?>/i, /^--\s*$/m,
      /Sent from (my )?(iPhone|iPad|Galaxy|Samsung|Android|Outlook|Mail)/i,
      /Get Outlook for (iOS|Android)/i, /Sent from Yahoo Mail/i,
      /Sent via the Samsung/i, /class="?gmail_signature"?/i,
      /class="?AppleMailSignature"?/i, /class="?moz-signature"?/i,
    ].some(p => p.test(html));
  }

  function stripDefaultSignature(html) {
    const containerPatterns = [
      /<div[^>]*id="?ms-outlook-mobile-signature"?[^>]*>[\s\S]*?<\/div>/gi,
      /<div[^>]*class="?gmail_signature"?[^>]*>[\s\S]*?<\/div>/gi,
      /<div[^>]*class="?AppleMailSignature"?[^>]*>[\s\S]*?<\/div>/gi,
      /<div[^>]*class="?moz-signature"?[^>]*>[\s\S]*?<\/div>/gi,
      /<div[^>]*id="?Signature"?[^>]*>[\s\S]*?<\/div>/gi,
      /<div[^>]*>.*?Get Outlook for (iOS|Android).*?<\/div>/gi,
    ];
    let cleaned = html;
    for (const p of containerPatterns) cleaned = cleaned.replace(p, "");
    if (cleaned.length < html.length) return cleaned.trim();
    for (const p of [
      /--\s*<br\s*\/?>/i,
      /Sent from (my )?(iPhone|iPad|Galaxy|Samsung|Android|Outlook|Mail)/i,
      /Get Outlook for (iOS|Android)/i, /Sent from Yahoo Mail/i, /Sent via the Samsung/i,
    ]) {
      const idx = cleaned.search(p);
      if (idx > -1) return cleaned.slice(0, idx).trim();
    }
    if (cleaned.replace(/<[^>]*>/g, "").trim().length < 200) {
      const msoIdx = cleaned.search(/<div[^>]*class="?MsoNormal"?/i);
      if (msoIdx > -1) return cleaned.slice(0, msoIdx).trim();
    }
    return cleaned;
  }

  async function disableClientSignature(item) {
    if (mobile) return false;
    try {
      if (typeof item.body?.setSignatureAsync === "function") {
        await new Promise((res, rej) => {
          item.body.setSignatureAsync("", { coercionType: Office.CoercionType.Html },
            (r) => r.status === "succeeded" ? res() : rej(r.error));
        });
        console.log("[CardByte] ✅ Cleared client signature slot");
        return true;
      }
    } catch (e) { console.warn("[CardByte] setSignatureAsync clear failed:", e.message); }
    try {
      if (typeof item.disableClientSignatureAsync === "function") {
        await new Promise((res, rej) => {
          item.disableClientSignatureAsync((r) => r.status === "succeeded" ? res() : rej(r.error));
        });
        console.log("[CardByte] ✅ Disabled client signature");
        return true;
      }
    } catch (e) { console.warn("[CardByte] disableClientSignatureAsync failed:", e.message); }
    return false;
  }

  async function ensureNoDefaultSignature(item) {
    try {
      await disableClientSignature(item);
      const html = await getBodyHtml(item);
      // Skip removal if CardByte sig already present, or reply chain detected
      if (hasCardByteSignature(html) || detectReplyChain(html)) return false;
      if (looksLikeDefaultSignature(html)) {
        const cleaned = stripDefaultSignature(html);
        if (cleaned.length < html.length) {
          await bodySetAsync(item, cleaned);
          console.log("[CardByte] ✅ Default signature removed from body");
          return true;
        }
      }
      return false;
    } catch (e) {
      console.warn("[CardByte] ensureNoDefaultSignature (non-fatal):", e.message);
      return false;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // IMAGE PROCESSING
  // ─────────────────────────────────────────────────────────────────────────

  function compressBase64Image(dataUrl, maxWidth, quality) {
    if (maxWidth === undefined) maxWidth = mobile ? MOBILE_MAX_IMAGE_WIDTH : 300;
    if (quality  === undefined) quality  = mobile ? MOBILE_IMAGE_QUALITY   : 0.7;
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
    for (const it of matches) {
      const isGif = it.dataUrl.startsWith("data:image/gif");
      if (isGif && mobile) {
        const png = await convertGifToStaticPng(it.dataUrl);
        if (png !== it.dataUrl) result = result.replace(it.dataUrl, png);
        continue;
      }
      // Non-mobile GIFs: skip first pass to preserve animation (mirrors commands.js)
      if (isGif) continue;
      const compressed = await compressBase64Image(it.dataUrl);
      if (compressed !== it.dataUrl) result = result.replace(it.dataUrl, compressed);
    }
    // Second pass — if still too large, convert remaining GIFs to static PNG
    if (result.length > getMaxHtmlSize()) {
      console.log(`[CardByte] Still too large (${(result.length / 1024).toFixed(1)}KB), converting GIFs to static PNG`);
      for (const it of matches) {
        if (it.dataUrl.startsWith("data:image/gif") && result.includes(it.dataUrl)) {
          const png = await convertGifToStaticPng(it.dataUrl);
          if (png !== it.dataUrl) result = result.replace(it.dataUrl, png);
        }
      }
    }
    return result;
  }

  function extractBase64Images(html) {
    const images = []; let index = 0;
    const cleanedHtml = html.replace(
      /src\s*=\s*"data:(image\/([^;]+));base64,([^"]+)"/gi,
      (_m, mimeType, extension, base64Data) => {
        const cid = `cardbyte_img_${index}`;
        images.push({ cid, fileName: `${cid}.${extension.replace(/[^a-z0-9]/gi, "") || "png"}`, mimeType, base64Data });
        index++;
        return `src="cid:${cid}"`;
      }
    );
    return { cleanedHtml, images };
  }

  function stripBase64Images(html) {
    return html.replace(/<img[^>]*src\s*=\s*"data:image\/[^"]*"[^>]*\/?>/gi,
      '<span style="color:#999;font-size:11px;">[image]</span>');
  }

  function addInlineImageAttachment(item, { cid, fileName, base64Data }) {
    return new Promise((res, rej) => {
      if (typeof item.addFileAttachmentFromBase64Async !== "function") { res(false); return; }
      item.addFileAttachmentFromBase64Async(base64Data, fileName, { isInline: true, contentId: cid },
        (r) => r.status === Office.AsyncResultStatus.Succeeded ? res(true) : rej(r.error));
    });
  }

  async function attachImages(item, images) {
    let attached = 0;
    for (const img of images) {
      try { await addInlineImageAttachment(item, img); attached++; }
      catch { console.warn(`[CardByte] Attach failed: ${img.cid}`); }
    }
    console.log(`[CardByte] Attached ${attached}/${images.length} images`);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // TIERED INSERTION: SIGNATURE-ONLY
  // Mirrors commands.js tryInsertSignatureOnly exactly, with mobile branch
  // ─────────────────────────────────────────────────────────────────────────

  async function tryInsertSignatureOnly(item, html, label = "") {
    let methods;

    if (mobile) {
      // Mobile: prependAsync first, setSignatureAsync as fallback
      methods = [{ name: "prependAsync", fn: () => bodyPrependAsync(item, html) }];
      if (typeof item.body?.setSignatureAsync === "function")
        methods.push({ name: "setSignatureAsync", fn: () => bodySetSignatureAsync(item, html) });

    } else if (isOWA() && containsGifImages(html)) {
      // OWA + GIFs: prependAsync first (setSignatureAsync strips GIFs on OWA)
      methods = [
        { name: "prependAsync",     fn: () => bodyPrependAsync(item, html)     },
        { name: "setSignatureAsync", fn: () => bodySetSignatureAsync(item, html) },
      ];

    } else if (isOWA()) {
      // OWA, no GIFs: setSelectedDataAsync → setSignatureAsync → prependAsync
      methods = [
        { name: "setSelectedDataAsync", fn: () => bodySetSelectedDataAsync(item, html) },
        { name: "setSignatureAsync",     fn: () => bodySetSignatureAsync(item, html)    },
        { name: "prependAsync",          fn: () => bodyPrependAsync(item, html)          },
      ];

    } else {
      // Desktop (Windows + Mac): setSignatureAsync → prependAsync
      // (Mac calls this from macReplyInsert; Windows calls it from reply/compose tiers)
      methods = [
        { name: "setSignatureAsync", fn: () => bodySetSignatureAsync(item, html) },
        { name: "prependAsync",      fn: () => bodyPrependAsync(item, html)      },
      ];
    }

    console.log(`[CardByte] ${label} [${platform}]: ${methods.map(m => m.name).join(" → ")}`);
    for (const m of methods) {
      try {
        await m.fn();
        console.log(`[CardByte] ✅ ${m.name} ok`);
        return { success: true, method: m.name };
      } catch (err) {
        console.warn(`[CardByte] ${m.name} failed: ${err?.message || err?.code}`);
      }
    }
    return { success: false, method: "none" };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // TIERED INSERTION: FULL BODY
  // Mirrors commands.js tryInsertFullBody exactly, with all platform branches
  // ─────────────────────────────────────────────────────────────────────────

  async function tryInsertFullBody(item, html, label = "") {
    let methods;

    if (mobile) {
      methods = [
        { name: "setAsync",    fn: () => bodySetAsync(item, html)    },
        { name: "prependAsync", fn: () => bodyPrependAsync(item, html) },
      ];

    } else if (mac) {
      // Mac: setSelectedDataAsync first, setAsync LAST (nukes body if html is wrong)
      // Matches commands.js mac branch in tryInsertFullBody
      methods = [
        { name: "setSelectedDataAsync", fn: () => bodySetSelectedDataAsync(item, html) },
        { name: "setSignatureAsync",     fn: () => bodySetSignatureAsync(item, html)    },
        { name: "prependAsync",          fn: () => bodyPrependAsync(item, html)          },
        { name: "setAsync",              fn: () => bodySetAsyncMac(item, html)           }, // last resort
      ];

    } else if (isOWA() || containsGifImages(html)) {
      // OWA or any platform with GIFs
      methods = [
        { name: "setAsync",              fn: () => bodySetAsync(item, html)               },
        { name: "prependAsync",          fn: () => bodyPrependAsync(item, html)           },
        { name: "setSelectedDataAsync",  fn: () => bodySetSelectedDataAsync(item, html)   },
        { name: "setSignatureAsync",     fn: () => bodySetSignatureAsync(item, html)      },
      ];

    } else {
      // Windows Desktop: selectAll+replace preferred, then fallbacks
      methods = [
        { name: "setSelectedDataAsync", fn: () => bodySelectAllAndReplaceAsync(item, html) },
        { name: "prependAsync",         fn: () => bodyPrependAsync(item, html)              },
        { name: "setSignatureAsync",    fn: () => bodySetSignatureAsync(item, html)         },
        { name: "setAsync",             fn: () => bodySetAsync(item, html)                  },
      ];
    }

    console.log(`[CardByte] ${label} [${platform}]: ${methods.map(m => m.name).join(" → ")}`);
    for (const m of methods) {
      try {
        await m.fn();
        console.log(`[CardByte] ✅ ${m.name} ok`);
        return { success: true, method: m.name };
      } catch (err) {
        console.warn(`[CardByte] ${m.name} failed: ${err?.message || err?.code}`);
      }
    }
    return { success: false, method: "none" };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // MAC REPLY — NON-DESTRUCTIVE INSERTION WITH STRIPPING
  // Exact port of macReplyInsert from commands.js
  // ─────────────────────────────────────────────────────────────────────────
  async function macReplyInsert(item, variants) {
    console.log("[CardByte] ── macReplyInsert: non-destructive with signature stripping ──");

    let existingBodyForCheck = await getBodyHtml(item).catch(() => "");

    // Strip existing CardByte sig from safe zone before attempting insertion
    const { safeZone, replyChain } = stripSigFromSafeZoneOnly(existingBodyForCheck);
    const alreadyHasSig = hasCardByteSignature(existingBodyForCheck);
    const wasStripped   = alreadyHasSig && !hasCardByteSignature(safeZone);

    console.log(`[CardByte] macReplyInsert: alreadyHasSig=${alreadyHasSig}, wasStripped=${wasStripped}`);

    if (wasStripped) {
      console.log("[CardByte] macReplyInsert: stripped existing signature from safe zone");
      try {
        const cleanedBody = safeZone + replyChain;
        if (cleanedBody !== existingBodyForCheck) {
          await bodySetAsyncMac(item, cleanedBody);
          console.log("[CardByte] ✅ macReplyInsert: cleaned existing signature from body");
          existingBodyForCheck = await getBodyHtml(item).catch(() => cleanedBody);
        }
      } catch (e) {
        console.warn("[CardByte] macReplyInsert: failed to clean existing signature:", e.message);
      }
    }

    for (const v of variants) {
      // ── setSignatureAsync: signature slot only — body untouched ──────
      try {
        await bodySetSignatureAsync(item, v.html);
        console.log(`[CardByte] ✅ macReplyInsert: setSignatureAsync ok (${v.label})`);
        return { success: true, method: "setSignatureAsync" };
      } catch (e) {
        console.warn(`[CardByte] macReplyInsert: setSignatureAsync failed (${v.label}): ${e.message}`);
      }

      // ── prependAsync: safe ONLY when no sig exists in current body ──
      const currentHasSig = hasCardByteSignature(existingBodyForCheck);
      if (!currentHasSig) {
        try {
          await bodyPrependAsync(item, v.html);
          console.log(`[CardByte] ✅ macReplyInsert: prependAsync ok (${v.label})`);
          return { success: true, method: "prependAsync" };
        } catch (e) {
          console.warn(`[CardByte] macReplyInsert: prependAsync failed (${v.label}): ${e.message}`);
        }
      } else {
        console.warn(`[CardByte] macReplyInsert: skipping prependAsync (${v.label}) — sig still present`);
      }
    }

    console.error("[CardByte] macReplyInsert: all methods exhausted.");
    return { success: false, method: "none" };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // BUILD SIGNATURE VARIANTS
  // ─────────────────────────────────────────────────────────────────────────
  async function buildSignatureVariants(signatureBlock) {
    const maxSize = getMaxHtmlSize();
    const variants = [];
    if (signatureBlock.length <= maxSize)
      variants.push({ label: "Original", html: signatureBlock, images: null });
    try {
      const c = await compressImagesInHtml(signatureBlock);
      if (c.length <= maxSize) variants.push({ label: "Compressed", html: c, images: null });
    } catch { /* non-fatal */ }
    try {
      const { cleanedHtml, images } = extractBase64Images(signatureBlock);
      if (images.length) variants.push({ label: "CID", html: cleanedHtml, images });
    } catch { /* non-fatal */ }
    variants.push({ label: "Stripped", html: stripBase64Images(signatureBlock), images: null });
    console.log(`[CardByte] Variants: ${variants.map(v => `${v.label}(${(v.html.length / 1024).toFixed(1)}KB)`).join(", ")}`);
    return variants;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // MAIN applySignature — EXACT MIRROR OF commands.js insertSignatureWithoutCursorError
  // Covers: Windows Desktop, Mac, OWA, Mobile iOS/Android
  // All reply / compose paths, all tiers, all image fallbacks
  // ─────────────────────────────────────────────────────────────────────────
  async function applySignature(signature) {
    if (!signature) return;
    if (typeof Office === "undefined") { console.error("Office.js not available"); return; }
    const item = Office.context?.mailbox?.item;
    if (!item?.body) { console.error("[CardByte] Not in compose mode"); return; }

    // ── SIGNATURE_STATE guard (mirrors commands.js) ──────────────────────
    if (signatureStateRef.current === "loading") {
      console.log("[CardByte] Already loading — skipping");
      return;
    }
    if (signatureStateRef.current === "applied") {
      console.log("[CardByte] Already applied — skipping");
      return;
    }

    // ── __INSERTING_SIGNATURE__ guard (mirrors commands.js) ──────────────
    if (insertingRef.current) return;
    insertingRef.current = true;

    signatureStateRef.current = "loading";

    console.log("[CardByte] ════════════════════════════════════");
    console.log(`[CardByte] applySignature — platform: ${platform}`);
    console.log(`[CardByte] setSignatureAsync=${typeof item.body?.setSignatureAsync}`);
    console.log(`[CardByte] prependAsync=${typeof item.body?.prependAsync}`);
    console.log(`[CardByte] setSelectedDataAsync=${typeof item.body?.setSelectedDataAsync}`);
    console.log(`[CardByte] setAsync=${typeof item.body?.setAsync}`);
    console.log(`[CardByte] addFileAttachmentFromBase64Async=${typeof item.addFileAttachmentFromBase64Async}`);
    console.log(`[CardByte] disableClientSignatureAsync=${typeof item.disableClientSignatureAsync}`);

    try {
      if (mobile) {
        const ready = await waitForItemReady(item);
        if (!ready) throw new Error("Mail item never became ready on mobile");
      }

      // Skip ensureNoDefaultSignature on Mac — reading+writing body before reply
      // detection would truncate / overwrite the draft on Mac reply.
      if (!mac) {
        await ensureNoDefaultSignature(item);
      }

      // ── Read body ONCE — detection only on Mac; full use on other platforms ──
      const existingBody = await getBodyHtml(item);
      console.log(`[CardByte] existingBody: ${(existingBody.length / 1024).toFixed(1)}KB`);

      if (hasCardByteSignature(existingBody))
        console.log("[CardByte] Existing CardByte signature detected");

      // Mobile pre-processing
      let processed = signature;
      if (mobile) {
        processed = simplifyHtmlForMobile(processed);
        processed = await compressImagesInHtml(processed);
      }

      const wrapped        = wrapForOutlook(processed);
      const signatureBlock = `<!-- CARD_BYTE_SIGNATURE_START -->${wrapped}<!-- CARD_BYTE_SIGNATURE_END -->`;
      const isReply        = detectReplyChain(existingBody);

      const sizeKB   = (signatureBlock.length / 1024).toFixed(1);
      const gifCount = (signatureBlock.match(/data:image\/gif;base64,/gi) || []).length;
      console.log(`[CardByte] ── Insertion start ── size: ${sizeKB} KB, GIFs: ${gifCount}`);
      console.log(`[CardByte] isReply=${isReply}, mac=${mac}, mobile=${mobile}`);

      const variants = await buildSignatureVariants(signatureBlock);

      // ════════════════════════════════════════════════════════════════════
      // PATH A: REPLY / REPLY ALL / FORWARD
      // ════════════════════════════════════════════════════════════════════
      if (isReply) {
        console.log("[CardByte] 📧 Reply/Forward path");

        // ── MAC REPLY ───────────────────────────────────────────────────
        // Non-destructive only — never call setAsync on Mac reply
        if (mac) {
          const result = await macReplyInsert(item, variants);
          if (result.success) {
            signatureStateRef.current = "applied";
            return;
          }
          // Intentionally NOT falling through to setAsync on Mac reply:
          // surfacing the error is safer than corrupting the reply chain.
          throw new Error(
            "[CardByte] Mac reply: all non-destructive methods failed. " +
            "setAsync intentionally skipped to protect reply chain."
          );
        }

        // ── MOBILE REPLY ─────────────────────────────────────────────────
        if (mobile) {
          // T1: signature-only (non-destructive)
          for (const v of variants) {
            const r = await tryInsertSignatureOnly(item, v.html, `MobileReply-T1-${v.label}`);
            if (r.success) { await stabilizeSelection(item); signatureStateRef.current = "applied"; return; }
          }
          // T2/T3: full-body rebuild with safe-zone strip
          const { safeZone, replyChain } = stripSigFromSafeZoneOnly(existingBody);
          const fullHtml = safeZone + signatureBlock + replyChain;
          let r = await tryInsertFullBody(item, fullHtml, "MobileReply-T2");
          if (r.success) { await stabilizeSelection(item); signatureStateRef.current = "applied"; return; }
          r = await tryInsertFullBody(item, stripBase64Images(fullHtml), "MobileReply-T3");
          if (r.success) { await stabilizeSelection(item); signatureStateRef.current = "applied"; return; }
          throw new Error("All mobile reply strategies failed");
        }

        // ── WINDOWS DESKTOP / OWA REPLY ─────────────────────────────────
        // T1: signature-only (preferred — never touches reply chain)
        for (const v of variants) {
          const r = await tryInsertSignatureOnly(item, v.html, `Reply-T1-${v.label}`);
          if (r.success) {
            if (v.images?.length) await attachImages(item, v.images);
            await stabilizeSelection(item);
            signatureStateRef.current = "applied";
            return;
          }
        }

        // T2: compress + safe-zone rebuild
        try {
          const compressed = await compressImagesInHtml(signatureBlock);
          const { safeZone, replyChain } = stripSigFromSafeZoneOnly(existingBody);
          const fullHtml = safeZone + compressed + replyChain;
          console.log(`[CardByte] Reply-T2: safeZone=${(safeZone.length / 1024).toFixed(1)}KB replyChain=${(replyChain.length / 1024).toFixed(1)}KB`);
          const r = await tryInsertFullBody(item, fullHtml, "Reply-T2");
          if (r.success) { await stabilizeSelection(item); signatureStateRef.current = "applied"; return; }
        } catch (e) { console.warn("[CardByte] Reply-T2:", e.message); }

        // T3: stripped images, signature-only
        {
          const r = await tryInsertSignatureOnly(item, stripBase64Images(signatureBlock), "Reply-T3");
          if (r.success) { await stabilizeSelection(item); signatureStateRef.current = "applied"; return; }
        }

        // T4: stripped images, full-body rebuild (last resort — cursor may move)
        try {
          const { safeZone, replyChain } = stripSigFromSafeZoneOnly(existingBody);
          const r = await tryInsertFullBody(
            item, safeZone + stripBase64Images(signatureBlock) + replyChain, "Reply-T4"
          );
          if (r.success) { await stabilizeSelection(item); signatureStateRef.current = "applied"; return; }
        } catch (e) { console.warn("[CardByte] Reply-T4:", e.message); }

        // T5 (commands.js Tier 5 equivalent): find exact reply boundary via markers
        // Used as absolute last resort when all other methods fail
        {
          console.log("[CardByte] Reply-T5: boundary-splice full body (last resort)");
          const replyMarkers = [
            /<div[^>]*id="?divRplyFwdMsg"?/i,
            /<div[^>]*id="?appendonsend"?/i,
            /<div[^>]*id="?x_divRplyFwdMsg"?/i,
            /<hr[^>]*style="[^"]*display\s*:\s*inline-block/i,
            /<blockquote/i,
            /<!-- OriginalMessage -->/i,
          ];
          let insertIndex = -1;
          for (const marker of replyMarkers) {
            const match = existingBody.search(marker);
            if (match > -1) { insertIndex = match; break; }
          }
          let fullHtml;
          if (insertIndex > -1) {
            fullHtml = existingBody.slice(0, insertIndex) + signatureBlock + existingBody.slice(insertIndex);
          } else {
            fullHtml = existingBody + signatureBlock;
          }
          const r = await tryInsertFullBody(item, stripBase64Images(fullHtml), "Reply-T5");
          if (r.success) { await stabilizeSelection(item); signatureStateRef.current = "applied"; return; }
        }

        console.error("[CardByte] All reply insertion tiers failed");
        return;
      }

      // ════════════════════════════════════════════════════════════════════
      // PATH B: NEW COMPOSE
      // ════════════════════════════════════════════════════════════════════
      console.log("[CardByte] ✉️ New compose path");

      // ── MOBILE COMPOSE ────────────────────────────────────────────────
      if (mobile) {
        for (const v of variants) {
          const r = await tryInsertSignatureOnly(item, v.html, `MobileCompose-T1-${v.label}`);
          if (r.success) { await stabilizeSelection(item); signatureStateRef.current = "applied"; return; }
        }
        const fullHtml = "<br/>" + signatureBlock + "<br/>";
        let r = await tryInsertFullBody(item, fullHtml, "MobileCompose-T2");
        if (r.success) { await stabilizeSelection(item); signatureStateRef.current = "applied"; return; }
        r = await tryInsertFullBody(item, stripBase64Images(fullHtml), "MobileCompose-T3");
        if (r.success) { await stabilizeSelection(item); signatureStateRef.current = "applied"; return; }
        throw new Error("All mobile compose strategies failed");
      }

      // ── MAC COMPOSE ───────────────────────────────────────────────────
      // Compose on Mac is safe for setAsync: getAsync is reliable here
      // (no reply chain → no truncation risk)
      if (mac) {
        console.log("[CardByte] Mac compose");

        // Compose Tier 1: try setSignatureAsync / prependAsync first (non-destructive)
        // Mirrors commands.js Compose Tier 1
        {
          const result = await tryInsertSignatureOnly(item, signatureBlock, "MacCompose-T1");
          if (result.success) { signatureStateRef.current = "applied"; return; }
        }

        // Re-read fresh body — safe in compose window (no truncation risk on Mac)
        let freshBody = existingBody;
        try {
          freshBody = await getBodyHtml(item);
          console.log(`[CardByte] Re-read body: ${(freshBody.length / 1024).toFixed(1)} KB`);
        } catch (e) {
          console.warn("[CardByte] Re-read body failed, using existingBody:", e.message);
        }

        // Mac stale-read guard (mirrors commands.js)
        if (existingBody.length > 200 && freshBody.length < existingBody.length * 0.5) {
          console.warn("[CardByte] ⚠️ Mac stale-read — reverting to existingBody");
          freshBody = existingBody;
        }

        // Mac safe-threshold guard (mirrors commands.js)
        const draftTextLength = freshBody.replace(/<[^>]*>/g, "").trim().length;
        if (draftTextLength < MAC_SAFE_THRESHOLD) {
          console.warn("[CardByte] ⚠️ Mac body near-empty — skipping setAsync to protect draft");
          try {
            await bodyPrependAsync(item, signatureBlock);
            console.log("[CardByte] ✅ Mac safe prependAsync succeeded");
            signatureStateRef.current = "applied";
            return;
          } catch (e) {
            console.warn("[CardByte] Mac safe prependAsync failed:", e.message);
            console.error("[CardByte] ❌ Refusing setAsync — would wipe draft. Aborting.");
            return;
          }
        }

        // Strip existing CardByte sig before building fullHtml (duplication fix)
        const { safeZone, replyChain } = stripSigFromSafeZoneOnly(freshBody);
        const trimmedSafe  = safeZone.replace(/(\s|<br\s*\/?>|&nbsp;)+$/gi, "").trimEnd();
        const hadSignature = hasCardByteSignature(freshBody);
        console.log(`[CardByte] Mac compose: ${hadSignature ? "replacing existing signature" : "fresh insert"}`);

        for (const v of variants) {
          try {
            let fullHtml = trimmedSafe
              ? `${trimmedSafe}<br/>${v.html}`
              : `${v.html}<br/>`;
            if (replyChain && replyChain.trim()) fullHtml += replyChain;
            console.log(`[CardByte] Mac compose: building HTML with ${fullHtml.length} chars`);
            await bodySetAsyncMac(item, fullHtml);
            console.log(`[CardByte] ✅ Mac compose setAsync ok (${v.label})`);
            signatureStateRef.current = "applied";
            return;
          } catch (e) {
            console.warn(`[CardByte] Mac compose setAsync failed (${v.label}):`, e.message);
          }
        }

        // Last fallback for Mac compose: prependAsync (only if no sig existed)
        if (!hadSignature) {
          for (const v of variants) {
            try {
              await bodyPrependAsync(item, v.html);
              console.log(`[CardByte] ✅ Mac compose prependAsync fallback ok (${v.label})`);
              signatureStateRef.current = "applied";
              return;
            } catch (e) {
              console.warn(`[CardByte] Mac compose prependAsync fallback failed (${v.label}):`, e.message);
            }
          }
        }
        throw new Error("Mac compose: all insertion methods failed");
      }

      // ── WINDOWS DESKTOP / OWA COMPOSE ────────────────────────────────
      // Compose Tier 1: signature-only (setSignatureAsync → prependAsync)
      {
        const result = await tryInsertSignatureOnly(item, signatureBlock, "Compose-T1");
        if (result.success) { await stabilizeSelection(item); signatureStateRef.current = "applied"; return; }
      }

      // Re-read fresh body before any setAsync (mirrors commands.js Mac re-read guard)
      let freshBody = existingBody;
      try {
        freshBody = await getBodyHtml(item);
        console.log(`[CardByte] Re-read body: ${(freshBody.length / 1024).toFixed(1)} KB`);
      } catch (e) {
        console.warn("[CardByte] Re-read body failed, using existingBody:", e.message);
      }

      // Strip existing sig before appending (prevents duplication on re-apply)
      const { safeZone: compSafe, replyChain: compChain } = stripSigFromSafeZoneOnly(freshBody);
      const trimmedCompSafe = compSafe.replace(/(\s|<br\s*\/?>|&nbsp;)+$/gi, "").trimEnd();
      const fullHtml = trimmedCompSafe
        ? `${trimmedCompSafe}<br/>${signatureBlock}${compChain ? compChain : ""}`
        : `${signatureBlock}<br/>`;

      // Compose Tier 2: full-body insert
      {
        const r = await tryInsertFullBody(item, fullHtml, "Compose-T2");
        if (r.success) { await stabilizeSelection(item); signatureStateRef.current = "applied"; return; }
      }

      // Compose Tier 3: compress images
      try {
        const compressed = await compressImagesInHtml(fullHtml);
        console.log(`[CardByte] Compressed size: ${(compressed.length / 1024).toFixed(1)} KB`);
        const r = await tryInsertFullBody(item, compressed, "Compose-T3");
        if (r.success) { await stabilizeSelection(item); signatureStateRef.current = "applied"; return; }
      } catch (e) { console.warn("[CardByte] Compose-T3:", e.message); }

      // Compose Tier 4: CID inline attachments
      try {
        const { cleanedHtml, images } = extractBase64Images(fullHtml);
        const r = await tryInsertFullBody(item, cleanedHtml, "Compose-T4");
        if (r.success) {
          if (images.length) await attachImages(item, images);
          await stabilizeSelection(item);
          signatureStateRef.current = "applied";
          return;
        }
      } catch (e) { console.warn("[CardByte] Compose-T4:", e.message); }

      // Compose Tier 5: strip all images (last resort)
      {
        const r = await tryInsertFullBody(item, stripBase64Images(fullHtml), "Compose-T5");
        if (r.success) { await stabilizeSelection(item); signatureStateRef.current = "applied"; return; }
      }

      throw new Error("All compose insertion tiers failed");

    } catch (e) {
      signatureStateRef.current = "idle";
      console.error("[CardByte] applySignature failed:", e);
      throw e;
    } finally {
      insertingRef.current = false;
      // Reset state to "idle" if it wasn't set to "applied" above
      if (signatureStateRef.current === "loading") signatureStateRef.current = "idle";
      console.log("[CardByte] ════════════════════════════════════");
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // AUTH / LOAD
  // ─────────────────────────────────────────────────────────────────────────

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

  // ─────────────────────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────────────────────

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
      isMac={mac}
      platform={platform}
    />
  );

  return <div>Initializing add-in…</div>;
}

function decodeJwt(token) {
  const base64 = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(atob(base64));
}