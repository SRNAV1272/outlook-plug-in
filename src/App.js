/* global Office */
import React, { useCallback, useEffect, useState } from "react";
import { getOfficeToken, login, setToken, getToken } from "./services/authService";
import LoginForm from "./components/LoginForm";
import SignatureView from "./components/SignatureView";

// ─────────────────────────────────────────────────────────────────────────────
// SIZE LIMITS
// ─────────────────────────────────────────────────────────────────────────────
const MAX_SAFE_HTML_SIZE = 500_000;   // ~500 KB — desktop / OWA
const MAX_SAFE_HTML_SIZE_MOBILE = 200_000;   // ~200 KB — iOS / Android
const MOBILE_MAX_IMAGE_WIDTH = 200;       // px — shrink images on mobile
const MOBILE_IMAGE_QUALITY = 0.5;       // JPEG quality on mobile

// ─────────────────────────────────────────────────────────────────────────────
// PLATFORM DETECTION
// Returns: 'mobile-ios' | 'mobile-android' | 'mac' | 'owa' | 'desktop'
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

    // Mac detection
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

export function isMacPlatform() {
  return detectPlatform() === "mac";
}

export function isOWAPlatform() {
  return detectPlatform() === "owa";
}

function getMaxHtmlSize() {
  return isMobilePlatform() ? MAX_SAFE_HTML_SIZE_MOBILE : MAX_SAFE_HTML_SIZE;
}

// ─────────────────────────────────────────────────────────────────────────────
// AUTO-APPLY CONTEXT
// ?autoApply=1 → taskpane opened automatically via ItemEdit form load
// ─────────────────────────────────────────────────────────────────────────────
function isAutoApplyContext() {
  try {
    return new URLSearchParams(window.location.search).get("autoApply") === "1";
  } catch { return false; }
}

// ─────────────────────────────────────────────────────────────────────────────
// SIGNATURE STRIP HELPERS
// stripDivById — depth-aware removal of a <div id="..."> and all its children.
//   Handles Outlook's habit of prefixing ids with "x_" in replies/forwards.
// stripSig — full CardByte signature removal
// ─────────────────────────────────────────────────────────────────────────────
// function stripDivById(html, idPattern) {
//   const tempRegex = new RegExp(`<div[^>]*id="([^"]*)"[^>]*>`, "gi");
//   let openMatch;
//   let matchedIndex = -1;
//   let matchedLength = 0;

//   while ((openMatch = tempRegex.exec(html)) !== null) {
//     if (idPattern.test(openMatch[1])) {
//       matchedIndex = openMatch.index;
//       matchedLength = openMatch[0].length;
//       break;
//     }
//   }

//   if (matchedIndex === -1) return html;

//   let pos = matchedIndex + matchedLength;
//   let depth = 1;

//   while (pos < html.length && depth > 0) {
//     const nextOpen = html.indexOf("<div", pos);
//     const nextClose = html.indexOf("</div>", pos);
//     if (nextClose === -1) break;
//     if (nextOpen !== -1 && nextOpen < nextClose) { depth++; pos = nextOpen + 4; }
//     else { depth--; pos = nextClose + 6; }
//   }

//   return html.slice(0, matchedIndex) + html.slice(pos);
// }

function stripDivById(html, idPattern) {
  // On Mac, try multiple strategies
  if (isMacPlatform()) {
    // Strategy 1: Direct removal by exact ID match (Mac sometimes doesn't add x_ prefix)
    let directMatch = html.match(new RegExp(`<div[^>]*id="cardbyte-signature-block"[^>]*>.*?</div>`, 'is'));
    if (directMatch) {
      return html.replace(directMatch[0], '');
    }

    // Strategy 2: Look for the signature block by content markers
    const startMarker = '<!-- CARD_BYTE_SIGNATURE_START -->';
    const endMarker = '<!-- CARD_BYTE_SIGNATURE_END -->';
    const startIdx = html.indexOf(startMarker);
    const endIdx = html.indexOf(endMarker);

    if (startIdx !== -1 && endIdx !== -1) {
      const endPos = endIdx + endMarker.length;
      return html.slice(0, startIdx) + html.slice(endPos);
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

  let pos = matchedIndex + matchedLength;
  let depth = 1;

  while (pos < html.length && depth > 0) {
    const nextOpen = html.indexOf("<div", pos);
    const nextClose = html.indexOf("</div>", pos);
    if (nextClose === -1) break;
    if (nextOpen !== -1 && nextOpen < nextClose) {
      depth++;
      pos = nextOpen + 4;
    } else {
      depth--;
      pos = nextClose + 6;
    }
  }

  return html.slice(0, matchedIndex) + html.slice(pos);
}

// function stripSig(html) {
//   let result = html;
//   // 1. depth-aware div strip (handles x_ prefix Outlook adds in replies)
//   result = stripDivById(result, /x?_?cardbyte-signature-block/i);
//   // 2. comment-marker block
//   result = result.replace(
//     /<!-- CARD_BYTE_SIGNATURE_START -->[\s\S]*?<!-- CARD_BYTE_SIGNATURE_END -->/gi,
//     ""
//   );
//   // 3. legacy marker
//   result = result.replace(/<!-- CARDBYTE_SIGNATURE -->/gi, "");
//   // 4. trim trailing only — never leading
//   result = result.replace(/(\s|<br\s*\/?>|&nbsp;)+$/gi, "").trimEnd();
//   return result;
// }
function stripSig(html) {
  let result = html;

  // For Mac, also strip any signature-like content before the reply chain
  if (isMacPlatform()) {
    // Mac often wraps signatures in additional divs
    result = result.replace(/<div\s+class="[^"]*signature[^"]*"[^>]*>[\s\S]*?<\/div>/gi, "");
    result = result.replace(/<div\s+id="[^"]*Signature[^"]*"[^>]*>[\s\S]*?<\/div>/gi, "");
  }

  // 1. depth-aware div strip (handles x_ prefix Outlook adds in replies)
  result = stripDivById(result, /x?_?cardbyte-signature-block/i);

  // 2. comment-marker block
  result = result.replace(
    /<!-- CARD_BYTE_SIGNATURE_START -->[\s\S]*?<!-- CARD_BYTE_SIGNATURE_END -->/gi,
    ""
  );

  // 3. legacy marker
  result = result.replace(/<!-- CARDBYTE_SIGNATURE -->/gi, "");

  // 4. Mac-specific: remove any empty divs that might remain
  if (isMacPlatform()) {
    result = result.replace(/<div[^>]*>\s*<\/div>/gi, "");
    result = result.replace(/(\s|<br\s*\/?>|&nbsp;)+$/gi, "").trimEnd();
  }

  // 5. trim trailing only — never leading
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
  ];
  let earliest = -1;
  for (const marker of replyMarkers) {
    const idx = html.search(marker);
    if (idx > -1 && (earliest === -1 || idx < earliest)) earliest = idx;
  }
  return earliest;
}

// ─────────────────────────────────────────────────────────────────────────────
// MOBILE: wait for mail item to be fully ready before touching it
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
  const [mode, setMode] = useState("init");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const autoApply = isAutoApplyContext();
  const mobile = isMobilePlatform();
  const mac = isMacPlatform();
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

  // ── Outlook body helpers ─────────────────────────────────────────────────

  function getBodyHtml(item) {
    return new Promise((res, rej) => {
      item.body.getAsync(Office.CoercionType.Html, (r) =>
        r.status === "succeeded" ? res(r.value || "") : rej(r.error));
    });
  }

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

  function bodyPrependAsync(item, html) {
    return new Promise((res, rej) => {
      if (typeof item.body.prependAsync !== "function") { rej(new Error("prependAsync not available")); return; }
      item.body.prependAsync(html, { coercionType: Office.CoercionType.Html }, (r) => {
        if (r.status === "succeeded") res(); else rej(r.error);
      });
    });
  }

  function bodySetSelectedDataAsync(item, html) {
    return new Promise((res, rej) => {
      if (typeof item.body.setSelectedDataAsync !== "function") { rej(new Error("setSelectedDataAsync not available")); return; }
      item.body.setSelectedDataAsync(html, { coercionType: Office.CoercionType.Html }, (r) => {
        if (r.status === "succeeded") res(); else rej(r.error);
      });
    });
  }

  function bodySetSignatureAsync(item, html) {
    return new Promise((res, rej) => {
      if (typeof item.body.setSignatureAsync !== "function") { rej(new Error("setSignatureAsync not available")); return; }
      item.body.setSignatureAsync(html, { coercionType: Office.CoercionType.Html }, (r) => {
        if (r.status === "succeeded") res(); else rej(r.error);
      });
    });
  }

  function bodySelectAllAndReplaceAsync(item, html) {
    return new Promise((res, rej) => {
      if (typeof item.body.setSelectedDataAsync !== "function") { rej(new Error("setSelectedDataAsync not available")); return; }
      item.body.setAsync("", { coercionType: Office.CoercionType.Html }, (clearResult) => {
        if (clearResult.status !== "succeeded") { rej(clearResult.error); return; }
        item.body.setSelectedDataAsync(html, { coercionType: Office.CoercionType.Html }, (r2) => {
          if (r2.status === "succeeded") res(); else rej(r2.error);
        });
      });
    });
  }

  // ── Stabilize selection — moves cursor to top and deselects all ──────────
  // This fixes the "signature gets selected / cursor lands below" bug when
  // using prependAsync or setSelectedDataAsync from the taskpane.
  // Skipped on Mac (causes a visual flash and is not needed there).

  function stabilizeSelection(item) {
    if (mac) {
      console.log("[CardByte] Mac: skipping stabilizeSelection");
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      try {
        if (typeof item.body?.setSelectedDataAsync !== "function") { resolve(); return; }
        item.body.setSelectedDataAsync("", { coercionType: Office.CoercionType.Text }, () => resolve());
      } catch (e) { resolve(); }
    });
  }

  // ── Detection helpers ────────────────────────────────────────────────────

  // function hasCardByteSignature(html) {
  //   return html.includes("CARD_BYTE_SIGNATURE_START") ||
  //     html.includes("CARDBYTE_SIGNATURE") ||
  //     html.includes("CB_SIG_START") ||
  //     /id="x?_?cardbyte-signature-block"/i.test(html);
  // }
  function hasCardByteSignature(html) {
    // Standard detection
    if (html.includes("CARD_BYTE_SIGNATURE_START") ||
      html.includes("CARDBYTE_SIGNATURE") ||
      html.includes("CB_SIG_START") ||
      /id="x?_?cardbyte-signature-block"/i.test(html)) {
      return true;
    }

    // Mac-specific detection - check for wrapped signature blocks
    if (isMacPlatform()) {
      // Mac might have the signature without the typical markers
      const macPatterns = [
        /<div[^>]*style="[^"]*font-family:Calibri[^"]*"[^>]*>[\s\S]*?CardByte/i,
        /<div[^>]*contenteditable="false"[^>]*>[\s\S]*?<!-- CARD_BYTE/i,
      ];
      return macPatterns.some(pattern => pattern.test(html));
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

  // ── Default signature detection / strip ─────────────────────────────────

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
    if (mobile) { console.log("[CardByte] Mobile: skipping disableClientSignature (unsupported)"); return false; }
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

  // ── Image processing — platform-aware ────────────────────────────────────

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

  // ── Tiered insertion methods — platform-aware ─────────────────────────────

  /**
   * tryInsertSignatureOnly
   * Inserts signature WITHOUT touching existing body content.
   *
   * MOBILE:   prependAsync → (setSignatureAsync if available)
   * MAC:      prependAsync only  (setSignatureAsync causes issues on Mac)
   * OWA+GIF:  prependAsync → setSignatureAsync
   * OWA:      setSelectedDataAsync → setSignatureAsync → prependAsync
   * DESKTOP:  setSignatureAsync → prependAsync
   */
  async function tryInsertSignatureOnly(item, html, label = "") {
    let methods;

    if (mobile) {
      methods = [{ name: "prependAsync", fn: () => bodyPrependAsync(item, html) }];
      if (typeof item.body?.setSignatureAsync === "function")
        methods.push({ name: "setSignatureAsync", fn: () => bodySetSignatureAsync(item, html) });

    } else if (mac) {
      methods = [{ name: "prependAsync", fn: () => bodyPrependAsync(item, html) }];

    } else if (isOWAPlatform() && containsGifImages(html)) {
      methods = [
        { name: "prependAsync", fn: () => bodyPrependAsync(item, html) },
        { name: "setSignatureAsync", fn: () => bodySetSignatureAsync(item, html) },
      ];

    } else if (isOWAPlatform()) {
      methods = [
        { name: "setSelectedDataAsync", fn: () => bodySetSelectedDataAsync(item, html) },
        { name: "setSignatureAsync", fn: () => bodySetSignatureAsync(item, html) },
        { name: "prependAsync", fn: () => bodyPrependAsync(item, html) },
      ];

    } else {
      methods = [
        { name: "setSignatureAsync", fn: () => bodySetSignatureAsync(item, html) },
        { name: "prependAsync", fn: () => bodyPrependAsync(item, html) },
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

  /**
   * tryInsertFullBody
   * Replaces or sets the full body (last resort / mobile default).
   *
   * MOBILE:   setAsync → prependAsync
   * MAC:      setAsync → prependAsync
   * OWA+GIF:  setSelectedDataAsync → prependAsync → setSignatureAsync → setAsync
   * OWA:      setSelectedDataAsync → prependAsync → setSignatureAsync → setAsync
   * DESKTOP:  bodySelectAllAndReplaceAsync → prependAsync → setSignatureAsync → setAsync
   */
  async function tryInsertFullBody(item, html, label = "") {
    let methods;

    if (mobile) {
      methods = [
        { name: "setAsync", fn: () => bodySetAsync(item, html) },
        { name: "prependAsync", fn: () => bodyPrependAsync(item, html) },
      ];

    } else if (mac) {
      methods = [
        { name: "setAsync", fn: () => bodySetAsync(item, html) },
        { name: "prependAsync", fn: () => bodyPrependAsync(item, html) },
      ];

    } else if (isOWAPlatform()) {
      methods = [
        { name: "setSelectedDataAsync", fn: () => bodySetSelectedDataAsync(item, html) },
        { name: "prependAsync", fn: () => bodyPrependAsync(item, html) },
        { name: "setSignatureAsync", fn: () => bodySetSignatureAsync(item, html) },
        { name: "setAsync", fn: () => bodySetAsync(item, html) },
      ];

    } else {
      methods = [
        { name: "setSelectedDataAsync", fn: () => bodySelectAllAndReplaceAsync(item, html) },
        { name: "prependAsync", fn: () => bodyPrependAsync(item, html) },
        { name: "setSignatureAsync", fn: () => bodySetSignatureAsync(item, html) },
        { name: "setAsync", fn: () => bodySetAsync(item, html) },
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

  // ── Main applySignature — all platforms ───────────────────────────────────

  async function applySignature(signature) {
    if (!signature) return;
    if (typeof Office === "undefined") { console.error("Office.js not available"); return; }
    const item = Office.context?.mailbox?.item;
    if (!item?.body) { console.error("[CardByte] Not in compose mode"); return; }

    console.log(`[CardByte] ══ applySignature — platform: ${platform} ══`);
    console.log(`[CardByte] API: setSignatureAsync=${typeof item.body?.setSignatureAsync}, prependAsync=${typeof item.body?.prependAsync}, setAsync=${typeof item.body?.setAsync}`);

    try {
      if (mobile) {
        const ready = await waitForItemReady(item);
        if (!ready) throw new Error("Mail item never became ready on mobile");
      }

      await ensureNoDefaultSignature(item);

      const existingBody = await getBodyHtml(item);

      // Always strip any prior CardByte signature first to prevent duplication
      const cleanBody = stripSig(existingBody);

      if (hasCardByteSignature(existingBody)) {
        console.log("[CardByte] Existing signature detected — will replace");
      }

      let processed = signature;
      if (mobile) {
        console.log("[CardByte] Mobile: pre-processing HTML");
        processed = simplifyHtmlForMobile(processed);
        processed = await compressImagesInHtml(processed);
      }

      const wrapped = wrapForOutlook(processed);
      const signatureBlock = `<!-- CARD_BYTE_SIGNATURE_START -->${wrapped}<!-- CARD_BYTE_SIGNATURE_END -->`;
      const isReply = detectReplyChain(existingBody);

      console.log(`[CardByte] isReply: ${isReply}, platform: ${platform}, size: ${(signatureBlock.length / 1024).toFixed(1)}KB`);

      const variants = await buildSignatureVariants(signatureBlock);

      // ── PATH A: REPLY / FORWARD ──────────────────────────────────────────
      if (isReply) {
        console.log("[CardByte] 📧 Reply/Forward path");

        // ── MOBILE REPLY ──
        if (mobile) {
          // T1: signature-only (no full-body risk)
          for (const v of variants) {
            const r = await tryInsertSignatureOnly(item, v.html, `MobileReply-T1-${v.label}`);
            if (r.success) { await stabilizeSelection(item); return; }
          }
          // T2: full-body rebuild — always strip first
          const insertIndex = findReplyChainIndex(cleanBody);
          const fullHtml = insertIndex > -1
            ? cleanBody.slice(0, insertIndex) + signatureBlock + cleanBody.slice(insertIndex)
            : cleanBody + signatureBlock;
          let r = await tryInsertFullBody(item, fullHtml, "MobileReply-T2");
          if (r.success) { await stabilizeSelection(item); return; }
          r = await tryInsertFullBody(item, stripBase64Images(fullHtml), "MobileReply-T3");
          if (r.success) { await stabilizeSelection(item); return; }
          throw new Error("All mobile reply strategies failed");
        }

        // ── MAC REPLY ──
        // if (mac) {
        //   console.log("[CardByte] Mac reply: full-body rebuild (setSignatureAsync bypassed)");
        //   // Mac T1: compressed signature-only
        //   try {
        //     const compressed = await compressImagesInHtml(signatureBlock);
        //     const r = await tryInsertFullBody(item, compressed, "MacReply-T1");
        //     if (r.success) { await stabilizeSelection(item); return; }
        //   } catch (e) { console.warn("[CardByte] MacReply-T1:", e.message); }
        //   // Mac T2: uncompressed
        //   {
        //     const r = await tryInsertFullBody(item, signatureBlock, "MacReply-T2");
        //     if (r.success) { await stabilizeSelection(item); return; }
        //   }
        //   // Mac T3: strip images — last resort
        //   {
        //     const r = await tryInsertFullBody(item, stripBase64Images(signatureBlock), "MacReply-T3");
        //     if (r.success) { await stabilizeSelection(item); return; }
        //   }
        //   throw new Error("All Mac reply insertion tiers failed");
        // }
        // ── MAC REPLY ──
        // if (mac) {
        //   console.log("[CardByte] Mac reply: trying signature insertion without breaking reply chain");

        //   // T1: Use signature-only insertion first (preserves reply chain)
        //   for (const v of variants) {
        //     const r = await tryInsertSignatureOnly(item, v.html, `MacReply-T1-${v.label}`);
        //     if (r.success) {
        //       await stabilizeSelection(item);
        //       return;
        //     }
        //   }

        //   // T2: If signature-only fails, try compressed version
        //   try {
        //     const compressed = await compressImagesInHtml(signatureBlock);
        //     const r = await tryInsertSignatureOnly(item, compressed, "MacReply-T2");
        //     if (r.success) {
        //       await stabilizeSelection(item);
        //       return;
        //     }
        //   } catch (e) { console.warn("[CardByte] MacReply-T2:", e.message); }

        //   // T3: Last resort - strip images and try signature-only
        //   try {
        //     const r = await tryInsertSignatureOnly(item, stripBase64Images(signatureBlock), "MacReply-T3");
        //     if (r.success) {
        //       await stabilizeSelection(item);
        //       return;
        //     }
        //   } catch (e) { console.warn("[CardByte] MacReply-T3:", e.message); }

        //   // T4: If all signature-only methods fail, fall back to full-body
        //   console.log("[CardByte] Mac reply: falling back to full-body rebuild");
        //   try {
        //     const compressed = await compressImagesInHtml(signatureBlock);
        //     const r = await tryInsertFullBody(item, compressed, "MacReply-T4");
        //     if (r.success) { await stabilizeSelection(item); return; }
        //   } catch (e) { console.warn("[CardByte] MacReply-T4:", e.message); }

        //   throw new Error("All Mac reply insertion tiers failed");
        // }
        // ── MAC REPLY ──
        if (mac) {
          console.log("[CardByte] Mac reply: ensuring clean removal before insertion");

          // First, ensure any existing signature is completely removed
          let cleanExisting = stripSig(existingBody);

          // On Mac, we need to be more aggressive - remove multiple times if needed
          let previousLength = cleanExisting.length;
          let maxIterations = 3;
          for (let i = 0; i < maxIterations; i++) {
            cleanExisting = stripSig(cleanExisting);
            if (cleanExisting.length === previousLength) break;
            previousLength = cleanExisting.length;
          }

          // Find where to insert the signature (above reply chain)
          const insertIndex = findReplyChainIndex(cleanExisting);
          let finalHtml;

          if (insertIndex > -1) {
            finalHtml = cleanExisting.slice(0, insertIndex) + signatureBlock + cleanExisting.slice(insertIndex);
          } else {
            finalHtml = cleanExisting + signatureBlock;
          }

          // Try multiple insertion methods
          try {
            // Method 1: Direct setAsync (most reliable on Mac)
            await bodySetAsync(item, finalHtml);
            console.log("[CardByte] ✅ Mac reply: setAsync succeeded");
            await stabilizeSelection(item);
            return;
          } catch (e) {
            console.warn("[CardByte] Mac reply setAsync failed:", e.message);
          }

          // Method 2: setSelectedDataAsync with selection cleared
          try {
            await bodySetSelectedDataAsync(item, finalHtml);
            console.log("[CardByte] ✅ Mac reply: setSelectedDataAsync succeeded");
            await stabilizeSelection(item);
            return;
          } catch (e) {
            console.warn("[CardByte] Mac reply setSelectedDataAsync failed:", e.message);
          }

          throw new Error("All Mac reply insertion methods failed");
        }

        // ── DESKTOP / OWA REPLY ──
        // T1: signature-only (preferred)
        for (const v of variants) {
          const r = await tryInsertSignatureOnly(item, v.html, `Reply-T1-${v.label}`);
          if (r.success) {
            if (v.images?.length) await attachImages(item, v.images);
            await stabilizeSelection(item);
            return;
          }
        }
        // T2: full-body rebuild
        try {
          const compressed = await compressImagesInHtml(signatureBlock);
          const insertIndex = findReplyChainIndex(cleanBody);
          const fullHtml = insertIndex > -1
            ? cleanBody.slice(0, insertIndex) + compressed + cleanBody.slice(insertIndex)
            : cleanBody + compressed;
          const r = await tryInsertFullBody(item, fullHtml, "Reply-T2");
          if (r.success) { await stabilizeSelection(item); return; }
        } catch (e) { console.warn("[CardByte] Reply-T2:", e.message); }
        // T3: strip images
        {
          const r = await tryInsertSignatureOnly(item, stripBase64Images(signatureBlock), "Reply-T3");
          if (r.success) { await stabilizeSelection(item); return; }
        }
        return;
      }

      // ── PATH B: NEW COMPOSE ──────────────────────────────────────────────
      console.log("[CardByte] ✉️ New compose path");

      // ── MOBILE COMPOSE ──
      if (mobile) {
        for (const v of variants) {
          const r = await tryInsertSignatureOnly(item, v.html, `MobileCompose-T1-${v.label}`);
          if (r.success) { await stabilizeSelection(item); return; }
        }
        const fullHtml = (cleanBody ? cleanBody.replace(/(\s|<br\s*\/?>|&nbsp;)+$/gi, "").trimEnd() : "") + "<br/>" + signatureBlock;
        let r = await tryInsertFullBody(item, fullHtml, "MobileCompose-T2");
        if (r.success) { await stabilizeSelection(item); return; }
        r = await tryInsertFullBody(item, stripBase64Images(fullHtml), "MobileCompose-T3");
        if (r.success) { await stabilizeSelection(item); return; }
        throw new Error("All mobile compose strategies failed");
      }

      // // ── MAC COMPOSE ──
      // if (mac) {
      //   // Mac T1: try signature-only with prependAsync
      //   for (const v of variants) {
      //     const r = await tryInsertSignatureOnly(item, v.html, `MacCompose-T1-${v.label}`);
      //     if (r.success) { await stabilizeSelection(item); return; }
      //   }
      //   // Mac T2: full-body
      //   {
      //     const body = cleanBody
      //       ? cleanBody.replace(/(\s|<br\s*\/?>|&nbsp;)+$/gi, "").trimEnd() + signatureBlock
      //       : signatureBlock;
      //     const r = await tryInsertFullBody(item, body, "MacCompose-T2");
      //     if (r.success) { await stabilizeSelection(item); return; }
      //   }
      //   // Mac T3: strip images
      //   {
      //     const r = await tryInsertFullBody(item, stripBase64Images(signatureBlock), "MacCompose-T3");
      //     if (r.success) { await stabilizeSelection(item); return; }
      //   }
      //   return;
      // }
      // ── MAC COMPOSE ──
      if (mac) {
        console.log("[CardByte] Mac compose: replacing signature");

        // Aggressively strip any existing signature first
        let cleanBody = stripSig(existingBody);
        for (let i = 0; i < 3; i++) {
          const newClean = stripSig(cleanBody);
          if (newClean === cleanBody) break;
          cleanBody = newClean;
        }

        // Build final HTML
        const body = cleanBody
          ? cleanBody.replace(/(\s|<br\s*\/?>|&nbsp;)+$/gi, "").trimEnd() + signatureBlock
          : signatureBlock;

        // Use setAsync for most reliable replacement on Mac
        const r = await tryInsertFullBody(item, body, "MacCompose");
        if (r.success) {
          await stabilizeSelection(item);
          return;
        }

        throw new Error("Mac compose insertion failed");
      }

      // ── DESKTOP / OWA COMPOSE ──
      // T1: full-body (cleanBody + signatureBlock)
      {
        const fullHtml = cleanBody
          ? cleanBody.replace(/(\s|<br\s*\/?>|&nbsp;)+$/gi, "").trimEnd() + signatureBlock
          : signatureBlock;
        const r = await tryInsertFullBody(item, fullHtml, "Compose-T1");
        if (r.success) { await stabilizeSelection(item); return; }
      }
      // T2: compressed
      try {
        const compressed = await compressImagesInHtml(signatureBlock);
        const r = await tryInsertFullBody(item, compressed, "Compose-T2");
        if (r.success) { await stabilizeSelection(item); return; }
      } catch (e) { console.warn("[CardByte] Compose-T2:", e.message); }
      // T3: CID images
      try {
        const { cleanedHtml, images } = extractBase64Images(signatureBlock);
        const r = await tryInsertFullBody(item, cleanedHtml, "Compose-T3");
        if (r.success) {
          if (images.length) await attachImages(item, images);
          await stabilizeSelection(item);
          return;
        }
      } catch (e) { console.warn("[CardByte] Compose-T3:", e.message); }
      // T4: strip images — last resort
      {
        const stripped = stripBase64Images(signatureBlock);
        const fullHtml = cleanBody
          ? cleanBody.replace(/(\s|<br\s*\/?>|&nbsp;)+$/gi, "").trimEnd() + stripped
          : stripped;
        const r = await tryInsertFullBody(item, fullHtml, "Compose-T4");
        if (r.success) { await stabilizeSelection(item); return; }
      }

    } catch (e) {
      console.error("[CardByte] applySignature failed:", e);
      throw e;
    }
  }

  function buildReplyHtml(existingBody, sigBlock) {
    const markers = [
      /<div[^>]*id="?divRplyFwdMsg"?/i, /<div[^>]*id="?appendonsend"?/i,
      /<div[^>]*id="?x_divRplyFwdMsg"?/i,
      /<hr[^>]*style="[^"]*display\s*:\s*inline-block/i,
      /<blockquote/i, /<!-- OriginalMessage -->/i,
    ];
    let idx = -1;
    for (const p of markers) { const i = existingBody.search(p); if (i > -1) { idx = i; break; } }
    return idx > -1
      ? `${existingBody.slice(0, idx)}${sigBlock}${existingBody.slice(idx)}`
      : `${existingBody}${sigBlock}`;
  }

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

  // ── Auth / load ──────────────────────────────────────────────────────────

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

  // ── Render ───────────────────────────────────────────────────────────────

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