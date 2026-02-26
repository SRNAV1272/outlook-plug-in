/* global Office */
import React, { useCallback, useEffect, useState } from "react";
import { getOfficeToken, login, setToken, getToken } from "./services/authService";
import LoginForm from "./components/LoginForm";
import SignatureView from "./components/SignatureView";

const MAX_SAFE_HTML_SIZE = 500_000;

export default function App({ user }) {
  const [mode, setMode] = useState("init"); // init | login | ready
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const init = useCallback(async () => {
    setLoading(true);
    setError("");

    const cached = getToken();
    if (cached) {
      await loadSignature();
      return;
    }

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
  }, []);

  useEffect(() => {
    init();
  }, [init]);

  /* ---------------------------------------------------------
     OUTLOOK BODY HELPERS
  --------------------------------------------------------- */

  function getBodyHtml(item) {
    return new Promise((resolve, reject) => {
      item.body.getAsync(Office.CoercionType.Html, (r) => {
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

  function bodyPrependAsync(item, html) {
    return new Promise((resolve, reject) => {
      if (typeof item.body.prependAsync !== "function") {
        reject(new Error("prependAsync not available"));
        return;
      }
      item.body.prependAsync(
        html,
        { coercionType: Office.CoercionType.Html },
        (r) => {
          if (r.status === "succeeded") resolve();
          else reject(r.error);
        }
      );
    });
  }

  function bodySetSelectedDataAsync(item, html) {
    return new Promise((resolve, reject) => {
      if (typeof item.body.setSelectedDataAsync !== "function") {
        reject(new Error("setSelectedDataAsync not available"));
        return;
      }
      item.body.setSelectedDataAsync(
        html,
        { coercionType: Office.CoercionType.Html },
        (r) => {
          if (r.status === "succeeded") resolve();
          else reject(r.error);
        }
      );
    });
  }

  function bodySetSignatureAsync(item, html) {
    return new Promise((resolve, reject) => {
      if (typeof item.body.setSignatureAsync !== "function") {
        reject(new Error("setSignatureAsync not available"));
        return;
      }
      item.body.setSignatureAsync(
        html,
        { coercionType: Office.CoercionType.Html },
        (r) => {
          if (r.status === "succeeded") resolve();
          else reject(r.error);
        }
      );
    });
  }

  /* ---------------------------------------------------------
     DETECTION HELPERS
  --------------------------------------------------------- */

  function hasCardByteSignature(html) {
    return (
      html.includes("CARD_BYTE_SIGNATURE_START") ||
      html.includes("CARDBYTE_SIGNATURE") ||
      html.includes("CB_SIG_START")
    );
  }

  function isOWA() {
    const platform = (Office?.context?.platform || "").toLowerCase();
    return platform === "officeonline" || platform === "web" || platform === "";
  }

  function containsGifImages(html) {
    return /data:image\/gif;base64,/i.test(html);
  }

  function detectReplyChain(html) {
    const replyMarkers = [
      /divRplyFwdMsg/i,
      /appendonsend/i,
      /OriginalMessage/i,
      /<blockquote/i,
      /x_divRplyFwdMsg/i,
      /class="?OutlookMessageHeader"?/i,
      /<hr[^>]*style="[^"]*display\s*:\s*inline-block/i,
    ];
    return replyMarkers.some((p) => p.test(html));
  }

  /* ---------------------------------------------------------
     DEFAULT SIGNATURE DETECTION / STRIP
  --------------------------------------------------------- */

  function looksLikeDefaultSignature(html) {
    const patterns = [
      /class="?MsoNormal"?/i,
      /<meta name="Generator" content="Microsoft/i,
      /id="?Signature"?/i,
      /id="?ms-outlook-mobile-signature"?/i,
      /class="?OutlookMessageHeader"?/i,
      /--\s*<br\s*\/?>/i,
      /^--\s*$/m,
      /Sent from (my )?(iPhone|iPad|Galaxy|Samsung|Android|Outlook|Mail)/i,
      /Get Outlook for (iOS|Android)/i,
      /Sent from Yahoo Mail/i,
      /Sent via the Samsung/i,
      /class="?gmail_signature"?/i,
      /class="?AppleMailSignature"?/i,
      /class="?moz-signature"?/i,
    ];
    return patterns.some((p) => p.test(html));
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
    for (const p of containerPatterns) {
      cleaned = cleaned.replace(p, "");
    }

    if (cleaned.length < html.length) {
      console.log("[CardByte] Removed default signature via container pattern");
      return cleaned.trim();
    }

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

  async function ensureNoDefaultSignature(item) {
    try {
      await disableClientSignature(item);

      const html = await getBodyHtml(item);

      if (hasCardByteSignature(html)) {
        console.log("[CardByte] CardByte signature already present — skipping default removal");
        return false;
      }

      if (detectReplyChain(html)) {
        console.log("[CardByte] Reply/forward detected — skipping default signature removal");
        return false;
      }

      if (looksLikeDefaultSignature(html)) {
        console.log("🧹 Removing default signature");
        const cleaned = stripDefaultSignature(html);

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

  /* ---------------------------------------------------------
     IMAGE PROCESSING HELPERS
  --------------------------------------------------------- */

  function compressBase64Image(dataUrl, maxWidth = 300, quality = 0.7) {
    return new Promise((resolve) => {
      if (dataUrl.startsWith("data:image/gif")) {
        resolve(dataUrl);
        return;
      }

      const img = new Image();
      img.onload = () => {
        try {
          const canvas = document.createElement("canvas");
          let width = img.width;
          let height = img.height;

          if (width > maxWidth) {
            height = Math.round((height * maxWidth) / width);
            width = maxWidth;
          }

          canvas.width = width;
          canvas.height = height;

          const ctx = canvas.getContext("2d");
          const isPng = dataUrl.startsWith("data:image/png");

          if (isPng) {
            ctx.clearRect(0, 0, width, height);
            ctx.drawImage(img, 0, 0, width, height);
            let result = canvas.toDataURL("image/png");
            if (result.length >= dataUrl.length) {
              resolve(dataUrl);
              return;
            }
            console.log(`[CardByte] Compressed PNG: ${(dataUrl.length / 1024).toFixed(0)}KB → ${(result.length / 1024).toFixed(0)}KB`);
            resolve(result);
            return;
          }

          ctx.drawImage(img, 0, 0, width, height);
          let result = canvas.toDataURL("image/jpeg", quality);
          if (result.length >= dataUrl.length) {
            result = canvas.toDataURL("image/png");
          }
          if (result.length >= dataUrl.length) {
            resolve(dataUrl);
            return;
          }

          console.log(`[CardByte] Compressed: ${(dataUrl.length / 1024).toFixed(0)}KB → ${(result.length / 1024).toFixed(0)}KB`);
          resolve(result);
        } catch (e) {
          console.warn("[CardByte] Canvas compression failed:", e);
          resolve(dataUrl);
        }
      };
      img.onerror = () => resolve(dataUrl);
      img.src = dataUrl;
    });
  }

  function convertGifToStaticPng(dataUrl, maxWidth = 300) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        try {
          const canvas = document.createElement("canvas");
          let width = img.width;
          let height = img.height;

          if (width > maxWidth) {
            height = Math.round((height * maxWidth) / width);
            width = maxWidth;
          }

          canvas.width = width;
          canvas.height = height;

          const ctx = canvas.getContext("2d");
          ctx.clearRect(0, 0, width, height);
          ctx.drawImage(img, 0, 0, width, height);

          const result = canvas.toDataURL("image/png");
          console.log(`[CardByte] GIF→PNG: ${(dataUrl.length / 1024).toFixed(0)}KB → ${(result.length / 1024).toFixed(0)}KB`);
          resolve(result);
        } catch (e) {
          console.warn("[CardByte] GIF→PNG conversion failed:", e);
          resolve(dataUrl);
        }
      };
      img.onerror = () => resolve(dataUrl);
      img.src = dataUrl;
    });
  }

  async function compressImagesInHtml(html) {
    const regex = /src\s*=\s*"(data:image\/[^;]+;base64,[^"]+)"/gi;
    const matches = [];
    let match;

    while ((match = regex.exec(html)) !== null) {
      matches.push({ fullMatch: match[0], dataUrl: match[1] });
    }

    if (matches.length === 0) return html;

    console.log(`[CardByte] Compressing ${matches.length} base64 image(s)`);

    let result = html;

    for (const m of matches) {
      if (m.dataUrl.startsWith("data:image/gif")) {
        console.log(`[CardByte] Skipping GIF (${(m.dataUrl.length / 1024).toFixed(0)}KB) to preserve animation`);
        continue;
      }
      const compressed = await compressBase64Image(m.dataUrl);
      if (compressed !== m.dataUrl) {
        result = result.replace(m.dataUrl, compressed);
      }
    }

    if (result.length > MAX_SAFE_HTML_SIZE) {
      console.log(`[CardByte] Still too large (${(result.length / 1024).toFixed(1)}KB), converting GIFs to static PNG`);
      for (const m of matches) {
        if (m.dataUrl.startsWith("data:image/gif") && result.includes(m.dataUrl)) {
          const staticPng = await convertGifToStaticPng(m.dataUrl);
          if (staticPng !== m.dataUrl) {
            result = result.replace(m.dataUrl, staticPng);
          }
        }
      }
    }

    return result;
  }

  function extractBase64Images(html) {
    const images = [];
    let index = 0;

    const cleanedHtml = html.replace(
      /src\s*=\s*"data:(image\/([^;]+));base64,([^"]+)"/gi,
      (_match, mimeType, extension, base64Data) => {
        const cid = `cardbyte_img_${index}`;
        const safeExt = extension.replace(/[^a-z0-9]/gi, "") || "png";
        const fileName = `${cid}.${safeExt}`;
        images.push({ cid, fileName, mimeType, base64Data });
        index++;
        return `src="cid:${cid}"`;
      }
    );

    return { cleanedHtml, images };
  }

  function stripBase64Images(html) {
    return html.replace(
      /<img[^>]*src\s*=\s*"data:image\/[^"]*"[^>]*\/?>/gi,
      '<span style="color:#999;font-size:11px;">[image]</span>'
    );
  }

  function addInlineImageAttachment(item, { cid, fileName, base64Data }) {
    return new Promise((resolve, reject) => {
      if (typeof item.addFileAttachmentFromBase64Async !== "function") {
        console.warn("[CardByte] addFileAttachmentFromBase64Async not available");
        resolve(false);
        return;
      }

      item.addFileAttachmentFromBase64Async(
        base64Data,
        fileName,
        { isInline: true, contentId: cid },
        (result) => {
          if (result.status === Office.AsyncResultStatus.Succeeded) {
            resolve(true);
          } else {
            console.error(`[CardByte] Attach failed ${cid}:`, result.error);
            reject(result.error);
          }
        }
      );
    });
  }

  /* ---------------------------------------------------------
     TIERED INSERTION METHODS (mirrors auto-run handler)
  --------------------------------------------------------- */

  function wrapForOutlook(innerHtml) {
    return `
      <div style="font-family: Calibri, Arial, sans-serif; font-size: 11pt; mso-line-height-rule: exactly;">
        <table cellpadding="0" cellspacing="0" border="0" style="font-family: inherit; font-size: inherit; color: inherit;">
          <tbody>
            <tr>
              <td style="padding: 0; margin: 0;">
                ${innerHtml}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    `;
  }

  /**
   * Signature-only insertion — does NOT replace the body.
   * Keeps cursor at top, preserves reply chain.
   */
  async function tryInsertSignatureOnly(item, signatureHtml, label = "") {
    const owa = isOWA();
    const hasGifs = containsGifImages(signatureHtml);

    let methods;

    if (owa && hasGifs) {
      methods = [
        { name: "prependAsync", fn: () => bodyPrependAsync(item, signatureHtml) },
        { name: "setSignatureAsync", fn: () => bodySetSignatureAsync(item, signatureHtml) },
      ];
    } else {
      methods = [
        { name: "setSignatureAsync", fn: () => bodySetSignatureAsync(item, signatureHtml) },
        { name: "prependAsync", fn: () => bodyPrependAsync(item, signatureHtml) },
      ];
    }

    console.log(`[CardByte] ${label} Platform: ${owa ? "OWA" : "Desktop"}, hasGifs: ${hasGifs}, method order: ${methods.map((m) => m.name).join(" → ")}`);

    for (const m of methods) {
      try {
        console.log(`[CardByte] ${label} Trying ${m.name}...`);
        await m.fn();
        console.log(`[CardByte] ✅ ${m.name} succeeded`);
        return { success: true, method: m.name };
      } catch (err) {
        const msg = err?.message || err?.code || JSON.stringify(err);
        console.warn(`[CardByte] ${m.name} failed: ${msg}`);
      }
    }

    return { success: false, method: "none" };
  }

  /**
   * Full-body replacement — last resort. Cursor may move.
   */
  async function tryInsertFullBody(item, fullHtml, label = "") {
    const owa = isOWA();
    const hasGifs = containsGifImages(fullHtml);

    let methods;

    if (owa || hasGifs) {
      methods = [
        { name: "setAsync", fn: () => bodySetAsync(item, fullHtml) },
        { name: "prependAsync", fn: () => bodyPrependAsync(item, fullHtml) },
        { name: "setSelectedDataAsync", fn: () => bodySetSelectedDataAsync(item, fullHtml) },
        { name: "setSignatureAsync", fn: () => bodySetSignatureAsync(item, fullHtml) },
      ];
    } else {
      methods = [
        { name: "setSignatureAsync", fn: () => bodySetSignatureAsync(item, fullHtml) },
        { name: "setAsync", fn: () => bodySetAsync(item, fullHtml) },
        { name: "prependAsync", fn: () => bodyPrependAsync(item, fullHtml) },
        { name: "setSelectedDataAsync", fn: () => bodySetSelectedDataAsync(item, fullHtml) },
      ];
    }

    console.log(`[CardByte] ${label} Platform: ${owa ? "OWA" : "Desktop"}, hasGifs: ${hasGifs}, method order: ${methods.map((m) => m.name).join(" → ")}`);

    for (const m of methods) {
      try {
        console.log(`[CardByte] ${label} Trying ${m.name}...`);
        await m.fn();
        console.log(`[CardByte] ✅ ${m.name} succeeded`);
        return { success: true, method: m.name };
      } catch (err) {
        const msg = err?.message || err?.code || JSON.stringify(err);
        console.warn(`[CardByte] ${m.name} failed: ${msg}`);
      }
    }

    return { success: false, method: "none" };
  }

  /* ---------------------------------------------------------
     MAIN APPLY SIGNATURE (5-tier strategy for BOTH paths)
  --------------------------------------------------------- */

  async function applySignature(signature) {
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
        await ensureNoDefaultSignature(item);

        const existingBody = await getBodyHtml(item);

        if (hasCardByteSignature(existingBody)) {
          console.log("✅ CardByte signature already present — skipping");
          return;
        }

        await ensureNoDefaultSignature(item);

        const wrappedHtml = wrapForOutlook(signature);
        const signatureBlock = `<!-- CARD_BYTE_SIGNATURE_START -->${wrappedHtml}<!-- CARD_BYTE_SIGNATURE_END -->`;

        const isReply = detectReplyChain(existingBody);
        const alreadyHasSignature = hasCardByteSignature(existingBody);
        const sizeKB = (signatureBlock.length / 1024).toFixed(1);

        console.log(`[CardByte] isReply: ${isReply}, alreadyHasSignature: ${alreadyHasSignature}, size: ${sizeKB}KB`);

        // ═══════════════════════════════════════════════════
        // PRE-PROCESS: Build size variants upfront
        // ═══════════════════════════════════════════════════
        const variants = await buildSignatureVariants(signatureBlock, item);

        if (isReply) {
          console.log("[CardByte] 📧 Reply/Forward detected");

          if (alreadyHasSignature) {
            console.log("[CardByte] Replacing existing CardByte signature in reply");
            for (const v of variants) {
              const updatedBody = existingBody.replace(
                /<!-- CARD_BYTE_SIGNATURE_START -->[\s\S]*?<!-- CARD_BYTE_SIGNATURE_END -->/,
                v.html
              );
              const result = await tryInsertFullBody(item, updatedBody, `Reply-Replace-${v.label}`);
              if (result.success) return;
            }
          }

          // Try each variant with signature-only methods
          for (const v of variants) {
            console.log(`[CardByte] Reply ${v.label}: signature-only (${(v.html.length / 1024).toFixed(1)}KB)`);
            const result = await tryInsertSignatureOnly(item, v.html, `Reply-${v.label}`);
            if (result.success) {
              // Attach CID images if this variant used them
              if (v.images && v.images.length > 0) {
                let attached = 0;
                for (const img of v.images) {
                  try {
                    await addInlineImageAttachment(item, img);
                    attached++;
                  } catch (e) {
                    console.warn(`[CardByte] Image attach failed: ${img.cid}`);
                  }
                }
                console.log(`[CardByte] Attached ${attached}/${v.images.length} images`);
              }
              return;
            }
          }

          // Last resort: full body replacement
          console.log("[CardByte] Reply last resort: Full body replacement");
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

          const strippedSig = stripBase64Images(signatureBlock);
          let fullHtml;
          if (insertIndex > -1) {
            fullHtml = `${existingBody.slice(0, insertIndex)}${strippedSig}${existingBody.slice(insertIndex)}`;
          } else {
            fullHtml = `${existingBody}${strippedSig}`;
          }

          const result = await tryInsertFullBody(item, fullHtml, "Reply-LastResort");
          if (result.success) return;

          throw new Error("All reply insertion tiers failed");
        }

        // ═══════════════════════════════════════════════════
        // PATH B: NEW COMPOSE
        // ═══════════════════════════════════════════════════
        console.log("[CardByte] ✉️ New compose detected");

        if (alreadyHasSignature) {
          for (const v of variants) {
            const updatedBody = existingBody.replace(
              /<!-- CARD_BYTE_SIGNATURE_START -->[\s\S]*?<!-- CARD_BYTE_SIGNATURE_END -->/,
              v.html
            );
            const result = await tryInsertFullBody(item, updatedBody, `Compose-Replace-${v.label}`);
            if (result.success) return;
          }
        }

        // Try each variant with signature-only methods
        for (const v of variants) {
          console.log(`[CardByte] Compose ${v.label}: signature-only (${(v.html.length / 1024).toFixed(1)}KB)`);
          const result = await tryInsertSignatureOnly(item, v.html, `Compose-${v.label}`);
          if (result.success) {
            if (v.images && v.images.length > 0) {
              let attached = 0;
              for (const img of v.images) {
                try {
                  await addInlineImageAttachment(item, img);
                  attached++;
                } catch (e) {
                  console.warn(`[CardByte] Image attach failed: ${img.cid}`);
                }
              }
              console.log(`[CardByte] Attached ${attached}/${v.images.length} images`);
            }
            return;
          }
        }

        // Last resort: full body replacement with stripped images
        console.log("[CardByte] Compose last resort: Full body replacement");
        const stripped = stripBase64Images(signatureBlock);
        const fullHtml = `${existingBody}<br/>${stripped}`;
        const result = await tryInsertFullBody(item, fullHtml, "Compose-LastResort");
        if (result.success) return;

        throw new Error("All compose insertion tiers failed");
      } catch (e) {
        console.error("[CardByte] Apply signature failed:", e);
      }
    });
  }

  /**
   * Builds an array of signature HTML variants from smallest to largest,
   * so we always try the most compressed version first.
   */
  async function buildSignatureVariants(signatureBlock, item) {
    const variants = [];
    const originalSize = signatureBlock.length;

    console.log(`[CardByte] Building variants from ${(originalSize / 1024).toFixed(1)}KB signature`);

    // Variant 1: Original (only if under limit)
    if (originalSize <= MAX_SAFE_HTML_SIZE) {
      variants.push({ label: "Original", html: signatureBlock, images: null });
    }

    // Variant 2: Compressed images
    try {
      const compressed = await compressImagesInHtml(signatureBlock);
      if (compressed.length < originalSize && compressed.length <= MAX_SAFE_HTML_SIZE) {
        variants.push({ label: "Compressed", html: compressed, images: null });
      }
    } catch (e) {
      console.warn("[CardByte] Compression failed:", e.message);
    }

    // Variant 3: CID inline attachments (images extracted)
    try {
      const { cleanedHtml, images } = extractBase64Images(signatureBlock);
      if (cleanedHtml.length < originalSize) {
        variants.push({ label: "CID", html: cleanedHtml, images });
      }
    } catch (e) {
      console.warn("[CardByte] CID extraction failed:", e.message);
    }

    // Variant 4: All images stripped (always smallest, always works)
    const stripped = stripBase64Images(signatureBlock);
    variants.push({ label: "Stripped", html: stripped, images: null });

    // Sort by size ascending — try smallest first
    variants.sort((a, b) => a.html.length - b.html.length);

    console.log(`[CardByte] Variants: ${variants.map(v => `${v.label}(${(v.html.length / 1024).toFixed(1)}KB)`).join(", ")}`);

    return variants;
  }

  /* ---------------------------------------------------------
     AUTH / LOAD
  --------------------------------------------------------- */

  async function loadSignature() {
    try {
      setLoading(true);
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

  /* ---------------------------------------------------------
     RENDER
  --------------------------------------------------------- */

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