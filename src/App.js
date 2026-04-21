/* global Office */
import React, { useCallback, useEffect, useState } from "react";
import { getOfficeToken, login, setToken, getToken } from "./services/authService";
import LoginForm from "./components/LoginForm";
import SignatureView from "./components/SignatureView";

// ─────────────────────────────────────────────────────────────────────────────
// SIZE LIMITS
// ─────────────────────────────────────────────────────────────────────────────
const MAX_SAFE_HTML_SIZE        = 500_000;  // ~500 KB — desktop / OWA
const MAX_SAFE_HTML_SIZE_MOBILE = 200_000;  // ~200 KB — iOS / Android
const MOBILE_MAX_IMAGE_WIDTH    = 200;      // px — shrink images on mobile
const MOBILE_IMAGE_QUALITY      = 0.5;     // JPEG quality on mobile

// ─────────────────────────────────────────────────────────────────────────────
// PLATFORM DETECTION
// Returns: 'mobile-ios' | 'mobile-android' | 'mac' | 'owa' | 'desktop'
// ─────────────────────────────────────────────────────────────────────────────
export function detectPlatform() {
  try {
    const platform = (Office?.context?.platform || "").toLowerCase();
    const ua       = (navigator?.userAgent   || "").toLowerCase();

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
export function isMacPlatform() { return detectPlatform() === "mac"; }
export function isOWAPlatform() { return detectPlatform() === "owa"; }

function getMaxHtmlSize() {
  return isMobilePlatform() ? MAX_SAFE_HTML_SIZE_MOBILE : MAX_SAFE_HTML_SIZE;
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
// SIGNATURE STRIP HELPERS
// ─────────────────────────────────────────────────────────────────────────────
function stripDivById(html, idPattern) {
  if (isMacPlatform()) {
    const startMarker = "<!-- CARD_BYTE_SIGNATURE_START -->";
    const endMarker   = "<!-- CARD_BYTE_SIGNATURE_END -->";
    const startIdx    = html.indexOf(startMarker);
    const endIdx      = html.indexOf(endMarker);
    if (startIdx !== -1 && endIdx !== -1) {
      return html.slice(0, startIdx) + html.slice(endIdx + endMarker.length);
    }
  }

  const tempRegex = new RegExp(`<div[^>]*id="([^"]*)"[^>]*>`, "gi");
  let openMatch;
  let matchedIndex = -1;
  let matchedLength = 0;

  while ((openMatch = tempRegex.exec(html)) !== null) {
    if (idPattern.test(openMatch[1])) {
      matchedIndex = openMatch.index;
      matchedLength = openMatch[0].length;
      break;
    }
  }

  if (matchedIndex === -1) return html;

  let pos   = matchedIndex + matchedLength;
  let depth = 1;

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

  if (isMacPlatform()) {
    result = result.replace(/<div\s+class="[^"]*signature[^"]*"[^>]*>[\s\S]*?<\/div>/gi, "");
    result = result.replace(/<div\s+id="[^"]*Signature[^"]*"[^>]*>[\s\S]*?<\/div>/gi, "");
  }

  result = stripDivById(result, /x?_?cardbyte-signature-block/i);
  result = result.replace(/<!-- CARD_BYTE_SIGNATURE_START -->[\s\S]*?<!-- CARD_BYTE_SIGNATURE_END -->/gi, "");
  result = result.replace(/<!-- CARDBYTE_SIGNATURE -->/gi, "");

  if (isMacPlatform()) {
    result = result.replace(/<div[^>]*>\s*<\/div>/gi, "");
  }

  result = result.replace(/(\s|<br\s*\/?>|&nbsp;)+$/gi, "").trimEnd();
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// REPLY CHAIN INDEX HELPER
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
// SAFE-ZONE STRIP
// ─────────────────────────────────────────────────────────────────────────────
function stripSigFromSafeZoneOnly(html) {
  const chainIndex = findReplyChainIndex(html);
  if (chainIndex === -1) {
    const stripped = stripSig(html);
    return { safeZone: stripped, replyChain: "", fullStripped: stripped };
  }
  const safeZone   = stripSig(html.slice(0, chainIndex));
  const replyChain = html.slice(chainIndex); // NEVER modified
  return { safeZone, replyChain, fullStripped: safeZone + replyChain };
}

// ─────────────────────────────────────────────────────────────────────────────
// MOBILE: wait for mail item to be fully ready
// ─────────────────────────────────────────────────────────────────────────────
async function waitForItemReady(item, maxRetries = 6, delayMs = 500) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      await new Promise((resolve, reject) => {
        item.body.getAsync(Office.CoercionType.Html, (r) => {
          if (r.status === "succeeded") resolve(); else reject(r.error);
        });
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
  if (isMobilePlatform()) {
    return `<div id="cardbyte-signature-block" contenteditable="false" style="font-family:Arial,sans-serif;font-size:14px;"><table contenteditable="false" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:100%;"><tbody><tr><td style="padding:0;margin:0;">${innerHtml}</td></tr></tbody></table></div>`;
  }
  if (isMacPlatform()) {
    return `<div id="cardbyte-signature-block" contenteditable="false" style="font-family:Calibri,Arial,sans-serif;font-size:11pt;mso-line-height-rule:exactly;">${innerHtml}</div>`;
  }
  return `<div id="cardbyte-signature-block" contenteditable="false" style="font-family:Calibri,Arial,sans-serif;font-size:11pt;mso-line-height-rule:exactly;"><table contenteditable="false" cellpadding="0" cellspacing="0" border="0" style="font-family:inherit;font-size:inherit;color:inherit;"><tbody><tr><td style="padding:0;margin:0;">${innerHtml}</td></tr></tbody></table></div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// APP
// ─────────────────────────────────────────────────────────────────────────────
export default function App({ user }) {
  const [mode,    setMode]    = useState("init");
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState("");

  const autoApply = isAutoApplyContext();
  const mobile    = isMobilePlatform();
  const mac       = isMacPlatform();
  const platform  = detectPlatform();

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
      item.body.getAsync(Office.CoercionType.Html, (r) =>
        r.status === "succeeded" ? res(r.value || "") : rej(r.error));
    });
  }

  // Standard setAsync — calls prependAsync("") after to reset cursor (non-Mac)
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

  // Mac-safe setAsync — no trailing prependAsync (avoids cursor flash)
  function bodySetAsyncMac(item, html) {
    return new Promise((res, rej) => {
      item.body.setAsync(html, { coercionType: Office.CoercionType.Html }, (r) =>
        r.status === "succeeded" ? res() : rej(r.error));
    });
  }

  function bodyPrependAsync(item, html) {
    return new Promise((res, rej) => {
      if (typeof item.body.prependAsync !== "function") {
        rej(new Error("prependAsync not available")); return;
      }
      item.body.prependAsync(html, { coercionType: Office.CoercionType.Html }, (r) =>
        r.status === "succeeded" ? res() : rej(r.error));
    });
  }

  function bodySetSelectedDataAsync(item, html) {
    return new Promise((res, rej) => {
      if (typeof item.body.setSelectedDataAsync !== "function") {
        rej(new Error("setSelectedDataAsync not available")); return;
      }
      item.body.setSelectedDataAsync(html, { coercionType: Office.CoercionType.Html }, (r) =>
        r.status === "succeeded" ? res() : rej(r.error));
    });
  }

  function bodySetSignatureAsync(item, html) {
    return new Promise((res, rej) => {
      if (typeof item.body.setSignatureAsync !== "function") {
        rej(new Error("setSignatureAsync not available")); return;
      }
      item.body.setSignatureAsync(html, { coercionType: Office.CoercionType.Html }, (r) =>
        r.status === "succeeded" ? res() : rej(r.error));
    });
  }

  function bodySelectAllAndReplaceAsync(item, html) {
    return new Promise((res, rej) => {
      if (typeof item.body.setSelectedDataAsync !== "function") {
        rej(new Error("setSelectedDataAsync not available")); return;
      }
      item.body.setAsync("", { coercionType: Office.CoercionType.Html }, (clearResult) => {
        if (clearResult.status !== "succeeded") { rej(clearResult.error); return; }
        item.body.setSelectedDataAsync(html, { coercionType: Office.CoercionType.Html }, (r2) =>
          r2.status === "succeeded" ? res() : rej(r2.error));
      });
    });
  }

  // Stabilize selection — skipped on Mac (causes visual flash, not needed)
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
  // DETECTION HELPERS
  // ─────────────────────────────────────────────────────────────────────────

  function hasCardByteSignature(html) {
    if (
      html.includes("CARD_BYTE_SIGNATURE_START") ||
      html.includes("CARDBYTE_SIGNATURE") ||
      html.includes("CB_SIG_START") ||
      /id="x?_?cardbyte-signature-block"/i.test(html)
    ) return true;
    if (isMacPlatform()) {
      return [
        /<div[^>]*style="[^"]*font-family:Calibri[^"]*"[^>]*>[\s\S]*?CardByte/i,
        /<div[^>]*contenteditable="false"[^>]*>[\s\S]*?<!-- CARD_BYTE/i,
      ].some(p => p.test(html));
    }
    return false;
  }

  function containsGifImages(html) { return /data:image\/gif;base64,/i.test(html); }

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
      if (hasCardByteSignature(html) || detectReplyChain(html)) return false;
      if (looksLikeDefaultSignature(html)) {
        const cleaned = stripDefaultSignature(html);
        if (cleaned.length < html.length) { await bodySetAsync(item, cleaned); return true; }
      }
      return false;
    } catch (e) { console.warn("[CardByte] ensureNoDefaultSignature (non-fatal):", e.message); return false; }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // IMAGE PROCESSING
  // ─────────────────────────────────────────────────────────────────────────

  function compressBase64Image(dataUrl, maxWidth, quality) {
    if (maxWidth === undefined) maxWidth = mobile ? MOBILE_MAX_IMAGE_WIDTH : 300;
    if (quality === undefined) quality   = mobile ? MOBILE_IMAGE_QUALITY   : 0.7;
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
      if (isGif) continue;
      const compressed = await compressBase64Image(it.dataUrl);
      if (compressed !== it.dataUrl) result = result.replace(it.dataUrl, compressed);
    }
    if (result.length > getMaxHtmlSize()) {
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

  // ─────────────────────────────────────────────────────────────────────────
  // TIERED INSERTION HELPERS — used by non-Mac paths only
  // ─────────────────────────────────────────────────────────────────────────

  async function tryInsertSignatureOnly(item, html, label = "") {
    let methods;
    if (mobile) {
      methods = [{ name: "prependAsync", fn: () => bodyPrependAsync(item, html) }];
      if (typeof item.body?.setSignatureAsync === "function")
        methods.push({ name: "setSignatureAsync", fn: () => bodySetSignatureAsync(item, html) });
    } else if (isOWAPlatform() && containsGifImages(html)) {
      methods = [
        { name: "prependAsync",      fn: () => bodyPrependAsync(item, html) },
        { name: "setSignatureAsync", fn: () => bodySetSignatureAsync(item, html) },
      ];
    } else if (isOWAPlatform()) {
      methods = [
        { name: "setSelectedDataAsync", fn: () => bodySetSelectedDataAsync(item, html) },
        { name: "setSignatureAsync",    fn: () => bodySetSignatureAsync(item, html) },
        { name: "prependAsync",         fn: () => bodyPrependAsync(item, html) },
      ];
    } else {
      // desktop
      methods = [
        { name: "setSignatureAsync", fn: () => bodySetSignatureAsync(item, html) },
        { name: "prependAsync",      fn: () => bodyPrependAsync(item, html) },
      ];
    }
    console.log(`[CardByte] ${label} [${platform}]: ${methods.map(m => m.name).join(" → ")}`);
    for (const m of methods) {
      try { await m.fn(); console.log(`[CardByte] ✅ ${m.name} ok`); return { success: true, method: m.name }; }
      catch (err) { console.warn(`[CardByte] ${m.name} failed: ${err?.message || err?.code}`); }
    }
    return { success: false, method: "none" };
  }

  async function tryInsertFullBody(item, html, label = "") {
    let methods;
    if (mobile) {
      methods = [
        { name: "setAsync",     fn: () => bodySetAsync(item, html) },
        { name: "prependAsync", fn: () => bodyPrependAsync(item, html) },
      ];
    } else if (isOWAPlatform()) {
      methods = [
        { name: "setSelectedDataAsync", fn: () => bodySetSelectedDataAsync(item, html) },
        { name: "prependAsync",         fn: () => bodyPrependAsync(item, html) },
        { name: "setSignatureAsync",    fn: () => bodySetSignatureAsync(item, html) },
        { name: "setAsync",             fn: () => bodySetAsync(item, html) },
      ];
    } else {
      // desktop
      methods = [
        { name: "setSelectedDataAsync", fn: () => bodySelectAllAndReplaceAsync(item, html) },
        { name: "prependAsync",         fn: () => bodyPrependAsync(item, html) },
        { name: "setSignatureAsync",    fn: () => bodySetSignatureAsync(item, html) },
        { name: "setAsync",             fn: () => bodySetAsync(item, html) },
      ];
    }
    console.log(`[CardByte] ${label} [${platform}]: ${methods.map(m => m.name).join(" → ")}`);
    for (const m of methods) {
      try { await m.fn(); console.log(`[CardByte] ✅ ${m.name} ok`); return { success: true, method: m.name }; }
      catch (err) { console.warn(`[CardByte] ${m.name} failed: ${err?.message || err?.code}`); }
    }
    return { success: false, method: "none" };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // MAC REPLY — FULLY NON-DESTRUCTIVE INSERTION
  //
  // ROOT CAUSE OF THE BUG:
  //   On Mac, item.body.getAsync() inside a reply/forward window silently
  //   returns a TRUNCATED copy — Outlook's internal rendering buffer clips
  //   the reply chain at an arbitrary byte boundary with no error or warning.
  //
  //   Any code path that does getAsync → mutate → setAsync will write the
  //   truncated body back, permanently destroying the quoted reply chain.
  //   This is why the user sees only the most recent email in the thread.
  //
  // THE ONLY SAFE APPROACH:
  //   Use APIs that INSERT content at a specific slot WITHOUT reading or
  //   writing the full body HTML:
  //
  //     • prependAsync(html)      — inserts at cursor / top of compose area
  //     • setSignatureAsync(html) — inserts into the dedicated signature slot
  //
  //   Both of these are "append-only" from Outlook's perspective. The reply
  //   chain is never read, never modified, never written back.
  //
  // WHAT WE NEVER DO HERE:
  //   setAsync is NEVER called in this function, regardless of failures.
  //   If all non-destructive methods fail, we return failure and let the
  //   caller decide — we do not silently fall through to a destructive path.
  // ─────────────────────────────────────────────────────────────────────────
  async function macReplyInsert(item, variants) {
    console.log("[CardByte] ── macReplyInsert: non-destructive only (setAsync NEVER called) ──");

    for (const v of variants) {
      // prependAsync: inserts at top of compose area, fully non-destructive
      try {
        await bodyPrependAsync(item, v.html);
        console.log(`[CardByte] ✅ macReplyInsert: prependAsync ok (${v.label})`);
        return { success: true, method: "prependAsync" };
      } catch (e) {
        console.warn(`[CardByte] macReplyInsert: prependAsync failed (${v.label}): ${e.message}`);
      }

      // setSignatureAsync: inserts into signature slot, also non-destructive
      try {
        await bodySetSignatureAsync(item, v.html);
        console.log(`[CardByte] ✅ macReplyInsert: setSignatureAsync ok (${v.label})`);
        return { success: true, method: "setSignatureAsync" };
      } catch (e) {
        console.warn(`[CardByte] macReplyInsert: setSignatureAsync failed (${v.label}): ${e.message}`);
      }
    }

    // Do NOT fall through to setAsync here — that would destroy the reply chain.
    console.error("[CardByte] macReplyInsert: all non-destructive methods exhausted. Returning failure.");
    return { success: false, method: "none" };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // MAIN applySignature — ALL PLATFORMS
  // ─────────────────────────────────────────────────────────────────────────

  async function applySignature(signature) {
    if (!signature) return;
    if (typeof Office === "undefined") { console.error("Office.js not available"); return; }
    const item = Office.context?.mailbox?.item;
    if (!item?.body) { console.error("[CardByte] Not in compose mode"); return; }

    console.log(`[CardByte] ══ applySignature — platform: ${platform} ══`);
    console.log(`[CardByte] setSignatureAsync=${typeof item.body?.setSignatureAsync}, prependAsync=${typeof item.body?.prependAsync}, setAsync=${typeof item.body?.setAsync}`);

    try {
      if (mobile) {
        const ready = await waitForItemReady(item);
        if (!ready) throw new Error("Mail item never became ready on mobile");
      }

      // Skip ensureNoDefaultSignature on Mac reply — it calls getAsync+setAsync
      // and would truncate + overwrite the body before we even apply the signature.
      // We detect the reply scenario after reading existingBody below.
      if (!mac) {
        await ensureNoDefaultSignature(item);
      }

      // ── Read body ONCE — used only for detection on Mac reply ─────────
      // On Mac reply this read may be truncated. We accept that and use it
      // ONLY to detect isReply / hasCardByteSignature. We NEVER pass this
      // truncated value into setAsync on Mac reply.
      const existingBody = await getBodyHtml(item);
      console.log(`[CardByte] existingBody: ${(existingBody.length / 1024).toFixed(1)}KB`);

      if (hasCardByteSignature(existingBody)) {
        console.log("[CardByte] Existing CardByte signature detected");
      }

      // Mobile pre-processing
      let processed = signature;
      if (mobile) {
        processed = simplifyHtmlForMobile(processed);
        processed = await compressImagesInHtml(processed);
      }

      const wrapped        = wrapForOutlook(processed);
      const signatureBlock = `<!-- CARD_BYTE_SIGNATURE_START -->${wrapped}<!-- CARD_BYTE_SIGNATURE_END -->`;
      const isReply        = detectReplyChain(existingBody);

      console.log(`[CardByte] isReply=${isReply}, mac=${mac}, size=${(signatureBlock.length / 1024).toFixed(1)}KB`);

      const variants = await buildSignatureVariants(signatureBlock);

      // ══════════════════════════════════════════════════════════════════
      // PATH A: REPLY / FORWARD
      // ══════════════════════════════════════════════════════════════════
      if (isReply) {
        console.log("[CardByte] 📧 Reply/Forward path");

        // ── MAC REPLY: non-destructive only, dedicated function ──────────
        // setAsync is NEVER called here — see macReplyInsert() docs above.
        if (mac) {
          const result = await macReplyInsert(item, variants);
          if (result.success) return;
          // We deliberately do NOT fall through to any setAsync path.
          // Surfacing the error is safer than silently corrupting the email.
          throw new Error(
            "[CardByte] Mac reply: all non-destructive insertion methods failed. " +
            "setAsync was intentionally skipped to protect the reply chain."
          );
        }

        // ── MOBILE REPLY ─────────────────────────────────────────────────
        if (mobile) {
          // T1: signature-only (non-destructive)
          for (const v of variants) {
            const r = await tryInsertSignatureOnly(item, v.html, `MobileReply-T1-${v.label}`);
            if (r.success) { await stabilizeSelection(item); return; }
          }
          // T2/T3: full-body rebuild with safe-zone strip
          {
            const { safeZone, replyChain } = stripSigFromSafeZoneOnly(existingBody);
            const fullHtml = safeZone + signatureBlock + replyChain;
            let r = await tryInsertFullBody(item, fullHtml, "MobileReply-T2");
            if (r.success) { await stabilizeSelection(item); return; }
            r = await tryInsertFullBody(item, stripBase64Images(fullHtml), "MobileReply-T3");
            if (r.success) { await stabilizeSelection(item); return; }
          }
          throw new Error("All mobile reply strategies failed");
        }

        // ── DESKTOP / OWA REPLY ──────────────────────────────────────────
        // T1: signature-only (preferred — never touches reply chain)
        for (const v of variants) {
          const r = await tryInsertSignatureOnly(item, v.html, `Reply-T1-${v.label}`);
          if (r.success) {
            if (v.images?.length) await attachImages(item, v.images);
            await stabilizeSelection(item);
            return;
          }
        }
        // T2: full-body rebuild with safe-zone strip
        try {
          const compressed = await compressImagesInHtml(signatureBlock);
          const { safeZone, replyChain } = stripSigFromSafeZoneOnly(existingBody);
          const fullHtml = safeZone + compressed + replyChain;
          console.log(`[CardByte] Reply-T2: safeZone=${(safeZone.length / 1024).toFixed(1)}KB replyChain=${(replyChain.length / 1024).toFixed(1)}KB`);
          const r = await tryInsertFullBody(item, fullHtml, "Reply-T2");
          if (r.success) { await stabilizeSelection(item); return; }
        } catch (e) { console.warn("[CardByte] Reply-T2:", e.message); }
        // T3: stripped images, signature-only
        {
          const r = await tryInsertSignatureOnly(item, stripBase64Images(signatureBlock), "Reply-T3");
          if (r.success) { await stabilizeSelection(item); return; }
        }
        // T4: stripped images, full-body rebuild
        try {
          const { safeZone, replyChain } = stripSigFromSafeZoneOnly(existingBody);
          const r = await tryInsertFullBody(item, safeZone + stripBase64Images(signatureBlock) + replyChain, "Reply-T4");
          if (r.success) { await stabilizeSelection(item); return; }
        } catch (e) { console.warn("[CardByte] Reply-T4:", e.message); }
        return;
      }

      // ══════════════════════════════════════════════════════════════════
      // PATH B: NEW COMPOSE
      // ══════════════════════════════════════════════════════════════════
      console.log("[CardByte] ✉️ New compose path");

      // ── MOBILE COMPOSE ────────────────────────────────────────────────
      if (mobile) {
        for (const v of variants) {
          const r = await tryInsertSignatureOnly(item, v.html, `MobileCompose-T1-${v.label}`);
          if (r.success) { await stabilizeSelection(item); return; }
        }
        const fullHtml = "<br/>" + signatureBlock + "<br/>";
        let r = await tryInsertFullBody(item, fullHtml, "MobileCompose-T2");
        if (r.success) { await stabilizeSelection(item); return; }
        r = await tryInsertFullBody(item, stripBase64Images(fullHtml), "MobileCompose-T3");
        if (r.success) { await stabilizeSelection(item); return; }
        throw new Error("All mobile compose strategies failed");
      }

      // ── MAC COMPOSE ───────────────────────────────────────────────────
      // Compose on Mac is safe for setAsync: getAsync is reliable when there
      // is no reply chain (compose window = clean, untruncated body).
      if (mac) {
        console.log("[CardByte] Mac compose");

        // REPLACE PATH: existing CardByte sig found — strip and re-insert
        if (hasCardByteSignature(existingBody)) {
          console.log("[CardByte] Mac compose: replacing existing signature");

          // Re-read fresh — safe in compose window (no truncation risk)
          let freshBody = existingBody;
          try { freshBody = await getBodyHtml(item); } catch { /* use existingBody */ }
          if (existingBody.length > 200 && freshBody.length < existingBody.length * 0.5) {
            console.warn("[CardByte] ⚠️ Mac stale-read on replace — reverting to existingBody");
            freshBody = existingBody;
          }

          const { safeZone, replyChain } = stripSigFromSafeZoneOnly(freshBody);
          const trimmedSafe = safeZone.replace(/(\s|<br\s*\/?>|&nbsp;)+$/gi, "").trimEnd();

          for (const v of variants) {
            try {
              const fullHtml = trimmedSafe
                ? `${trimmedSafe}<br/>${v.html}${replyChain || "<br/>"}`
                : `<br/>${v.html}<br/>`;
              await bodySetAsyncMac(item, fullHtml);
              console.log(`[CardByte] ✅ Mac compose replace setAsync ok (${v.label})`);
              return;
            } catch (e) { console.warn(`[CardByte] Mac compose replace setAsync failed (${v.label}):`, e.message); }
          }
          console.warn("[CardByte] Mac compose replace: all variants failed, falling through to fresh insert");
        }

        // FRESH INSERT PATH: re-read and append signature after draft content
        let freshBodyForInsert = existingBody;
        try { freshBodyForInsert = await getBodyHtml(item); } catch { /* use existingBody */ }
        if (existingBody.length > 200 && freshBodyForInsert.length < existingBody.length * 0.5) {
          console.warn("[CardByte] ⚠️ Mac stale-read on fresh insert — reverting to existingBody");
          freshBodyForInsert = existingBody;
        }

        const trimmedFreshBody = freshBodyForInsert
          .replace(/(\s|<br\s*\/?>|&nbsp;)+$/gi, "")
          .trimEnd();

        for (const v of variants) {
          try {
            const fullHtml = trimmedFreshBody
              ? `${trimmedFreshBody}<br/>${v.html}<br/>`
              : `<br/>${v.html}<br/>`;
            await bodySetAsyncMac(item, fullHtml);
            console.log(`[CardByte] ✅ Mac compose fresh insert setAsync ok (${v.label})`);
            return;
          } catch (e) { console.warn(`[CardByte] Mac compose fresh insert failed (${v.label}):`, e.message); }
        }

        // Fallback: prependAsync (non-destructive, always safe)
        for (const v of variants) {
          try {
            await bodyPrependAsync(item, v.html);
            console.log(`[CardByte] ✅ Mac compose prependAsync fallback ok (${v.label})`);
            return;
          } catch (e) { console.warn(`[CardByte] Mac compose prependAsync fallback failed (${v.label}):`, e.message); }
        }

        throw new Error("Mac compose: all insertion methods failed");
      }

      // ── DESKTOP / OWA COMPOSE ─────────────────────────────────────────
      {
        const r = await tryInsertFullBody(item, "<br/>" + signatureBlock + "<br/>", "Compose-T1");
        if (r.success) { await stabilizeSelection(item); return; }
      }
      try {
        const compressed = await compressImagesInHtml(signatureBlock);
        const r = await tryInsertFullBody(item, compressed, "Compose-T2");
        if (r.success) { await stabilizeSelection(item); return; }
      } catch (e) { console.warn("[CardByte] Compose-T2:", e.message); }
      try {
        const { cleanedHtml, images } = extractBase64Images(signatureBlock);
        const r = await tryInsertFullBody(item, cleanedHtml, "Compose-T3");
        if (r.success) {
          if (images.length) await attachImages(item, images);
          await stabilizeSelection(item);
          return;
        }
      } catch (e) { console.warn("[CardByte] Compose-T3:", e.message); }
      {
        const r = await tryInsertFullBody(item, "<br/>" + stripBase64Images(signatureBlock) + "<br/>", "Compose-T4");
        if (r.success) { await stabilizeSelection(item); return; }
      }

    } catch (e) {
      console.error("[CardByte] applySignature failed:", e);
      throw e;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // HELPERS
  // ─────────────────────────────────────────────────────────────────────────

  async function attachImages(item, images) {
    let attached = 0;
    for (const img of images) {
      try { await addInlineImageAttachment(item, img); attached++; }
      catch { console.warn(`[CardByte] Attach failed: ${img.cid}`); }
    }
    console.log(`[CardByte] Attached ${attached}/${images.length} images`);
  }

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