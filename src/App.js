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
// MOBILE: wait for the mail item to be fully ready before touching it.
// On iOS / Android the compose item is sometimes not initialised when the
// taskpane fires.
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
// Strips CSS links, <style> blocks and MSO conditionals that mobile Outlook
// ignores — inline styles are far more reliable on mobile.
// ─────────────────────────────────────────────────────────────────────────────
function simplifyHtmlForMobile(html) {
  return html
    .replace(/<link[^>]*rel="stylesheet"[^>]*>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<!--\[if[^>]*>[\s\S]*?<!\[endif\]-->/gi, "")
    .replace(/(<table[^>]*?)width\s*=\s*"?\d+"?/gi, '$1width="100%" style="max-width:100%;"');
}

// ─────────────────────────────────────────────────────────────────────────────
// OUTLOOK WRAPPER — simpler markup for mobile (MSO styles break on iOS/Android)
// ─────────────────────────────────────────────────────────────────────────────
function wrapForOutlook(innerHtml) {
  if (isMobilePlatform()) {
    return `<div style="font-family:Arial,sans-serif;font-size:14px;"><table cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:100%;"><tbody><tr><td style="padding:0;margin:0;">${innerHtml}</td></tr></tbody></table></div>`;
  }
  return `<div style="font-family:Calibri,Arial,sans-serif;font-size:11pt;mso-line-height-rule:exactly;"><table cellpadding="0" cellspacing="0" border="0" style="font-family:inherit;font-size:inherit;color:inherit;"><tbody><tr><td style="padding:0;margin:0;">${innerHtml}</td></tr></tbody></table></div>`;
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

  function getBodyHtml(item) {
    return new Promise((res, rej) => {
      item.body.getAsync(Office.CoercionType.Html, (r) =>
        r.status === "succeeded" ? res(r.value || "") : rej(r.error));
    });
  }
  function bodySetAsync(item, html) {
    return new Promise((res, rej) => {
      item.body.setAsync(html, { coercionType: Office.CoercionType.Html },
        (r) => r.status === "succeeded" ? res() : rej(r.error));
    });
  }
  function bodyPrependAsync(item, html) {
    return new Promise((res, rej) => {
      if (typeof item.body.prependAsync !== "function") { rej(new Error("prependAsync not available")); return; }
      item.body.prependAsync(html, { coercionType: Office.CoercionType.Html },
        (r) => r.status === "succeeded" ? res() : rej(r.error));
    });
  }
  function bodySetSelectedDataAsync(item, html) {
    return new Promise((res, rej) => {
      if (typeof item.body.setSelectedDataAsync !== "function") { rej(new Error("setSelectedDataAsync not available")); return; }
      item.body.setSelectedDataAsync(html, { coercionType: Office.CoercionType.Html },
        (r) => r.status === "succeeded" ? res() : rej(r.error));
    });
  }
  function bodySetSignatureAsync(item, html) {
    return new Promise((res, rej) => {
      if (typeof item.body.setSignatureAsync !== "function") { rej(new Error("setSignatureAsync not available")); return; }
      item.body.setSignatureAsync(html, { coercionType: Office.CoercionType.Html },
        (r) => r.status === "succeeded" ? res() : rej(r.error));
    });
  }

  /* ── Detection helpers ───────────────────────────────────── */

  function hasCardByteSignature(html) {
    return html.includes("CARD_BYTE_SIGNATURE_START") ||
      html.includes("CARDBYTE_SIGNATURE") ||
      html.includes("CB_SIG_START");
  }
  function containsGifImages(html) { return /data:image\/gif;base64,/i.test(html); }
  function detectReplyChain(html) {
    return [/divRplyFwdMsg/i, /appendonsend/i, /OriginalMessage/i, /<blockquote/i,
      /x_divRplyFwdMsg/i, /class="?OutlookMessageHeader"?/i,
      /<hr[^>]*style="[^"]*display\s*:\s*inline-block/i].some(p => p.test(html));
  }

  /* ── Default signature detection / strip ────────────────── */

  function looksLikeDefaultSignature(html) {
    return [/class="?MsoNormal"?/i, /<meta name="Generator" content="Microsoft/i,
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

    for (const p of [/--\s*<br\s*\/?>/i,
      /Sent from (my )?(iPhone|iPad|Galaxy|Samsung|Android|Outlook|Mail)/i,
      /Get Outlook for (iOS|Android)/i, /Sent from Yahoo Mail/i, /Sent via the Samsung/i]) {
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
    // These APIs do not exist on mobile Outlook
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

  /* ── Tiered insertion methods — platform-aware ───────────── */

  /**
   * Signature-only (does NOT touch existing body content).
   *
   * MOBILE:  setSignatureAsync unavailable → prependAsync only.
   * DESKTOP: setSignatureAsync preferred, prependAsync as fallback.
   */
  async function tryInsertSignatureOnly(item, html, label = "") {
    let methods;
    if (mobile) {
      methods = [{ name: "prependAsync", fn: () => bodyPrependAsync(item, html) }];
      if (typeof item.body?.setSignatureAsync === "function")
        methods.push({ name: "setSignatureAsync", fn: () => bodySetSignatureAsync(item, html) });
    } else if (isOWAPlatform() && containsGifImages(html)) {
      methods = [
        { name: "prependAsync", fn: () => bodyPrependAsync(item, html) },
        { name: "setSignatureAsync", fn: () => bodySetSignatureAsync(item, html) },
      ];
    } else {
      methods = [
        { name: "setSignatureAsync", fn: () => bodySetSignatureAsync(item, html) },
        { name: "prependAsync", fn: () => bodyPrependAsync(item, html) },
      ];
    }
    console.log(`[CardByte] ${label} [${platform}]: ${methods.map(m => m.name).join(" → ")}`);
    for (const m of methods) {
      try { await m.fn(); console.log(`[CardByte] ✅ ${m.name} ok`); return { success: true, method: m.name }; }
      catch (err) { console.warn(`[CardByte] ${m.name} failed: ${err?.message || err?.code}`); }
    }
    return { success: false, method: "none" };
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
  async function tryInsertFullBody(item, html, label = "") {
    let methods;
    if (mobile) {
      methods = [
        { name: "setAsync", fn: () => bodySetAsync(item, html) },
        { name: "prependAsync", fn: () => bodyPrependAsync(item, html) },
      ];
    } else if (isOWAPlatform() || containsGifImages(html)) {
      methods = [
        { name: "setAsync", fn: () => bodySetAsync(item, html) },
        { name: "prependAsync", fn: () => bodyPrependAsync(item, html) },
        { name: "setSelectedDataAsync", fn: () => bodySetSelectedDataAsync(item, html) },
        { name: "setSignatureAsync", fn: () => bodySetSignatureAsync(item, html) },
      ];
    } else {
      methods = [
        { name: "setSignatureAsync", fn: () => bodySetSignatureAsync(item, html) },
        { name: "setAsync", fn: () => bodySetAsync(item, html) },
        { name: "prependAsync", fn: () => bodyPrependAsync(item, html) },
        { name: "setSelectedDataAsync", fn: () => bodySetSelectedDataAsync(item, html) },
      ];
    }
    console.log(`[CardByte] ${label} [${platform}]: ${methods.map(m => m.name).join(" → ")}`);
    for (const m of methods) {
      try { await m.fn(); console.log(`[CardByte] ✅ ${m.name} ok`); return { success: true, method: m.name }; }
      catch (err) { console.warn(`[CardByte] ${m.name} failed: ${err?.message || err?.code}`); }
    }
    return { success: false, method: "none" };
  }

  /* ── Main applySignature — all platforms ─────────────────── */

  async function applySignature(signature) {
    if (!signature) return;
    if (typeof Office === "undefined") { console.error("Office.js not available"); return; }
    const item = Office.context?.mailbox?.item;
    if (!item?.body) { console.error("[CardByte] Not in compose mode"); return; }

    console.log(`[CardByte] ══ applySignature — platform: ${platform} ══`);
    console.log(`[CardByte] API: setSignatureAsync=${typeof item.body?.setSignatureAsync}, prependAsync=${typeof item.body?.prependAsync}, setAsync=${typeof item.body?.setAsync}`);

    try {
      // MOBILE: wait for item to fully initialise before any API calls
      if (mobile) {
        const ready = await waitForItemReady(item);
        if (!ready) throw new Error("Mail item never became ready on mobile");
      }

      await ensureNoDefaultSignature(item);

      const existingBody = await getBodyHtml(item);
      if (hasCardByteSignature(existingBody)) {
        console.log("[CardByte] ✅ Already present — skipping"); return;
      }

      // MOBILE: simplify + aggressively compress up-front
      let processed = signature;
      if (mobile) {
        console.log("[CardByte] Mobile: pre-processing HTML");
        processed = simplifyHtmlForMobile(processed);
        processed = await compressImagesInHtml(processed);
      }

      const wrapped = wrapForOutlook(processed);
      const signatureBlock = `<!-- CARD_BYTE_SIGNATURE_START -->${wrapped}<!-- CARD_BYTE_SIGNATURE_END -->`;
      const isReply = detectReplyChain(existingBody);
      const alreadyHasSig = hasCardByteSignature(existingBody);

      console.log(`[CardByte] isReply: ${isReply}, alreadyHasSig: ${alreadyHasSig}, size: ${(signatureBlock.length / 1024).toFixed(1)}KB`);

      const variants = await buildSignatureVariants(signatureBlock);

      // ─── PATH A: REPLY / FORWARD ─────────────────────────────
      if (isReply) {
        console.log("[CardByte] 📧 Reply/Forward path");

        if (alreadyHasSig) {
          for (const v of variants) {
            const updated = existingBody.replace(/<!-- CARD_BYTE_SIGNATURE_START -->[\s\S]*?<!-- CARD_BYTE_SIGNATURE_END -->/, v.html);
            if ((await tryInsertFullBody(item, updated, `Reply-Replace-${v.label}`)).success) return;
          }
        }

        if (mobile) {
          // Mobile: try signature-only first (prependAsync), then full-body
          for (const v of variants) {
            if ((await tryInsertSignatureOnly(item, v.html, `MobileReply-${v.label}`)).success) return;
          }
          const r = await tryInsertFullBody(item, buildReplyHtml(existingBody, stripBase64Images(signatureBlock)), "MobileReply-FullBody");
          if (r.success) return;
          throw new Error("All mobile reply strategies failed");
        }

        // Desktop / OWA
        for (const v of variants) {
          const r = await tryInsertSignatureOnly(item, v.html, `Reply-${v.label}`);
          if (r.success) { if (v.images?.length) await attachImages(item, v.images); return; }
        }
        await tryInsertFullBody(item, buildReplyHtml(existingBody, stripBase64Images(signatureBlock)), "Reply-LastResort");
        return;
      }

      // ─── PATH B: NEW COMPOSE ─────────────────────────────────
      console.log("[CardByte] ✉️ New compose path");

      if (alreadyHasSig) {
        for (const v of variants) {
          const updated = existingBody.replace(/<!-- CARD_BYTE_SIGNATURE_START -->[\s\S]*?<!-- CARD_BYTE_SIGNATURE_END -->/, v.html);
          if ((await tryInsertFullBody(item, updated, `Compose-Replace-${v.label}`)).success) {
            await moveCursorToTop(item);   // ← ADD
            return;
          };
        }
      }

      if (mobile) {
        for (const v of variants) {
          if ((await tryInsertSignatureOnly(item, v.html, `MobileCompose-${v.label}`)).success) {
            await moveCursorToTop(item);   // ← ADD
            return;
          };
        }
        const fullHtml = `${existingBody}<br/>${stripBase64Images(signatureBlock)}`;
        if ((await tryInsertFullBody(item, fullHtml, "MobileCompose-FullBody")).success) {
          await moveCursorToTop(item);   // ← ADD
          return;
        };
        throw new Error("All mobile compose strategies failed");
      }

      // Desktop / OWA
      for (const v of variants) {
        const r = await tryInsertSignatureOnly(item, v.html, `Compose-${v.label}`);
        if (r.success) {
          if (v.images?.length) await attachImages(item, v.images); {
            await moveCursorToTop(item);   // ← ADD
            return;
          };
        }
      }
      await tryInsertFullBody(item, `${existingBody}<br/>${stripBase64Images(signatureBlock)}`, "Compose-LastResort");
      await moveCursorToTop(item);

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