/* =========================================================
   CARDBYTE – OUTLOOK AUTO-RUN EVENT HANDLER (v0.0.4)
   =========================================================
   FIXES:
   - Reply/ReplyAll/Forward preserves the conversation chain
   - Cursor stays at top of reply area (not pushed to bottom)
   - setSignatureAsync preferred for replies (doesn't move cursor)
   - Fallback uses prependAsync which also preserves cursor
   ========================================================= */
let SIGNATURE_STATE = "idle"; // idle | loading | applied

const SIGNATURE_SPACER = `
        <br>
        <div style="min-height:50px;">&nbsp;</div>
        <br>
    `;

const SIGNATURE_MARKER = "<!-- CARDBYTE_SIGNATURE -->";

/* ---------------------------------------------------------
   Config
   --------------------------------------------------------- */
const AES_KEY = "fnItrY2YfozBqCC2B4XsfqHIvZku3kUOq3DFkbO64kk=";
const AES_IV = "3YapeNfJDung7TXxeKXn4g==";

const MAX_SAFE_HTML_SIZE = 500_000; // ~500 KB

/* ---------------------------------------------------------
   Office Ready
   --------------------------------------------------------- */

Office.onReady(() => {
    console.log("✅ Office.onReady is Started !");
});

/* ---------------------------------------------------------
   AES Encryption / Decryption Helpers
   --------------------------------------------------------- */

function base64ToArrayBuffer(base64) {
    let base64Data = base64.replace(/-/g, "+").replace(/_/g, "/");
    const padding = base64Data.length % 4;
    if (padding) {
        base64Data += "=".repeat(4 - padding);
    }
    const binaryString = atob(base64Data);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes.buffer;
}

function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binaryString = "";
    for (let i = 0; i < bytes.length; i++) {
        binaryString += String.fromCharCode(bytes[i]);
    }
    return btoa(binaryString);
}

async function handleAesDecrypt(encryptedText, generatedKey) {
    try {
        if (!encryptedText) return "";

        const keyToUse = generatedKey || AES_KEY;

        let keyBuffer;
        try {
            keyBuffer = base64ToArrayBuffer(keyToUse);
        } catch (e) {
            console.error("Failed to decode key as base64:", e);
            return encryptedText;
        }

        if (keyBuffer.byteLength !== 16 && keyBuffer.byteLength !== 32) {
            if (generatedKey && generatedKey !== AES_KEY) {
                return handleAesDecrypt(encryptedText, AES_KEY);
            }
            return encryptedText;
        }

        const ivBuffer = base64ToArrayBuffer(AES_IV);
        if (ivBuffer.byteLength !== 16) {
            return encryptedText;
        }

        const key = await crypto.subtle.importKey(
            "raw",
            keyBuffer,
            { name: "AES-CBC" },
            false,
            ["decrypt"]
        );

        let encryptedBuffer;
        try {
            encryptedBuffer = base64ToArrayBuffer(encryptedText);
        } catch (e) {
            return encryptedText;
        }

        if (encryptedBuffer.byteLength % 16 !== 0) {
            console.error(`❌ Invalid encrypted data length: ${encryptedBuffer.byteLength} bytes`);
            return encryptedText;
        }

        const decryptedBuffer = await crypto.subtle.decrypt(
            { name: "AES-CBC", iv: ivBuffer },
            key,
            encryptedBuffer
        );

        return new TextDecoder().decode(decryptedBuffer);
    } catch (err) {
        if (generatedKey && generatedKey !== AES_KEY && err.message.includes("key data")) {
            try {
                return await handleAesDecrypt(encryptedText, AES_KEY);
            } catch (fallbackError) {
                console.error("Fallback also failed:", fallbackError.message);
            }
        }
        return encryptedText;
    }
}

async function encryptEmail(email = "") {
    try {
        if (!email || email.trim() === "") {
            console.warn("Warning: Empty email provided");
            return "";
        }

        const keyBuffer = base64ToArrayBuffer(AES_KEY);
        const ivBuffer = base64ToArrayBuffer(AES_IV);

        if (keyBuffer.byteLength !== 16 && keyBuffer.byteLength !== 32) {
            console.error(`Invalid key length: ${keyBuffer.byteLength} bytes`);
            return "";
        }

        if (ivBuffer.byteLength !== 16) {
            console.error(`Invalid IV length: ${ivBuffer.byteLength} bytes`);
            return "";
        }

        const key = await crypto.subtle.importKey(
            "raw",
            keyBuffer,
            { name: "AES-CBC" },
            false,
            ["encrypt"]
        );

        const data = new TextEncoder().encode(email);

        const encrypted = await crypto.subtle.encrypt(
            { name: "AES-CBC", iv: ivBuffer },
            key,
            data
        );

        const base64Result = arrayBufferToBase64(encrypted);

        try {
            atob(base64Result);
        } catch (e) {
            console.error("✗ Result is NOT valid base64:", e);
        }

        return base64Result;
    } catch (err) {
        console.error("Encryption error:", err);
        return "";
    }
}

/* ---------------------------------------------------------
   Server API
   --------------------------------------------------------- */

async function renderSignatureOnServer(user) {
    try {
        const encryptedMail = await encryptEmail(user);

        // 🔹 1️⃣ Try Primary API First
        const primaryRes = await fetch(
            "https://newqa-enterprise.cardbyte.ai/email-signature/html/outlook/get-active",
            {
                method: "GET",
                headers: {
                    username: encryptedMail,
                },
            }
        );

        // ✅ If primary works → return it
        if (primaryRes.ok) {
            const data = await primaryRes.text();
            const decryptedData = await handleAesDecrypt(data);

            console.log("Using NEW renderer");
            return JSON.parse(decryptedData)?.html || null;
        }

        console.warn("Primary failed. Falling back to legacy...");

    } catch (err) {
        console.warn("Primary crashed. Falling back to legacy...", err);
    }

    // 🔹 2️⃣ Fallback to Legacy API
    try {
        const legacyRes = await fetch(
            "https://qa-renderer.cardbyte.ai/render-signature",
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({ email: user }),
            }
        );

        if (!legacyRes.ok) {
            throw new Error("Legacy renderer failed");
        }

        const legacyData = await legacyRes.json();

        console.log("Using LEGACY renderer", legacyData);
        return legacyData?.finalHtml || null;

    } catch (legacyError) {
        console.error("Both primary and legacy failed:", legacyError);
        return null;
    }
}

/* ---------------------------------------------------------
   Image Processing Helpers
   --------------------------------------------------------- */

/**
 * Compresses a single base64 data URL image via Canvas.
 * GIFs are passed through unchanged to preserve animation.
 * PNGs use PNG output to preserve transparency.
 * JPEGs try JPEG first, then PNG fallback.
 */
function compressBase64Image(dataUrl, maxWidth = 300, quality = 0.7) {
    return new Promise((resolve) => {
        // GIFs: pass through unchanged — canvas destroys animation
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

                // For PNGs, preserve transparency — output as PNG only
                if (isPng) {
                    ctx.clearRect(0, 0, width, height);
                    ctx.drawImage(img, 0, 0, width, height);
                    let result = canvas.toDataURL("image/png");
                    if (result.length >= dataUrl.length) {
                        resolve(dataUrl);
                        return;
                    }
                    console.log(
                        `[CardByte] Compressed PNG: ${(dataUrl.length / 1024).toFixed(0)}KB → ${(result.length / 1024).toFixed(0)}KB`
                    );
                    resolve(result);
                    return;
                }

                // For JPEG and others — try JPEG first, then PNG fallback
                ctx.drawImage(img, 0, 0, width, height);

                let result = canvas.toDataURL("image/jpeg", quality);
                if (result.length >= dataUrl.length) {
                    result = canvas.toDataURL("image/png");
                }
                if (result.length >= dataUrl.length) {
                    resolve(dataUrl);
                    return;
                }

                console.log(
                    `[CardByte] Compressed: ${(dataUrl.length / 1024).toFixed(0)}KB → ${(result.length / 1024).toFixed(0)}KB`
                );
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

/**
 * Converts a GIF data URL to a static PNG via Canvas (first frame only).
 * Used as a last resort when GIF size exceeds limits.
 */
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
                console.log(
                    `[CardByte] GIF→PNG: ${(dataUrl.length / 1024).toFixed(0)}KB → ${(result.length / 1024).toFixed(0)}KB`
                );
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

/**
 * Compresses all base64 images in the HTML via Canvas.
 * GIFs are preserved in the first pass. If the total size still
 * exceeds MAX_SAFE_HTML_SIZE, GIFs are converted to static PNGs.
 */
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

    // First pass: compress non-GIF images, skip GIFs to preserve animation
    for (const m of matches) {
        const isGif = m.dataUrl.startsWith("data:image/gif");

        if (isGif) {
            console.log(`[CardByte] Skipping GIF (${(m.dataUrl.length / 1024).toFixed(0)}KB) to preserve animation`);
            continue;
        }

        const compressed = await compressBase64Image(m.dataUrl);
        if (compressed !== m.dataUrl) {
            result = result.replace(m.dataUrl, compressed);
        }
    }

    // Second pass: if still too large, convert GIFs to static PNG as last resort
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

/**
 * Extracts base64 images → cid: references.
 */
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

/**
 * Strips all base64 images entirely, replacing with [image] placeholder.
 */
function stripBase64Images(html) {
    return html.replace(
        /<img[^>]*src\s*=\s*"data:image\/[^"]*"[^>]*\/?>/gi,
        '<span style="color:#999;font-size:11px;">[image]</span>'
    );
}

/**
 * Adds a single base64 image as an inline CID attachment.
 */
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
   Body Insertion Methods
   --------------------------------------------------------- */

/**
 * Method A: body.setAsync — replaces entire body (has size limits)
 * ⚠️ WARNING: This replaces the FULL body. Only use with combined HTML
 * that already includes the reply chain.
 */
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

/**
 * Method B: body.prependAsync — prepends to body top
 * ✅ SAFE for replies: adds content at top, keeps reply chain intact,
 *    cursor stays near top.
 */
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

/**
 * Method C: body.setSelectedDataAsync — inserts at cursor position
 */
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

/**
 * Method D: body.setSignatureAsync — specifically designed for signatures
 * ✅ BEST for replies: inserts signature in the signature slot without
 *    touching the body content or cursor position.
 * Available in Mailbox requirement set 1.10+
 */
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

/**
 * Detects if running on OWA (Outlook on the Web).
 */
function isOWA() {
    const platform = (Office?.context?.platform || "").toLowerCase();
    return platform === "officeonline" || platform === "web" || platform === "";
}

/**
 * Checks if the HTML contains any GIF base64 images.
 */
function containsGifImages(html) {
    return /data:image\/gif;base64,/i.test(html);
}

/**
 * Detects if the current body looks like a reply/forward
 * (contains a quoted conversation chain).
 */
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

/**
 * Tries insertion methods — order depends on whether this is a
 * reply (must preserve chain + cursor) or a new compose.
 *
 * FOR REPLIES:
 *   1. setSignatureAsync — best: signature slot, no body/cursor change
 *   2. prependAsync — good: adds at top, chain stays, cursor near top
 *   3. setAsync with full combined HTML — last resort (cursor may jump)
 *
 * FOR NEW COMPOSE:
 *   Same as before — setSignatureAsync first on desktop, setAsync on OWA
 *
 * Returns { success: boolean, method: string }
 */
async function tryInsertSignatureOnly(item, signatureHtml, label = "") {
    const owa = isOWA();
    const hasGifs = containsGifImages(signatureHtml);

    // For signature-only insertion (reply mode), prefer methods that
    // don't replace the body:
    //   1. setSignatureAsync — inserts into signature slot, body untouched
    //   2. prependAsync — adds at top of body, chain stays below
    // Only fall back to setAsync with full body as last resort.

    let methods;

    if (owa && hasGifs) {
        // OWA + GIFs: setSignatureAsync strips GIFs, so try prepend first
        methods = [
            { name: "prependAsync", fn: () => bodyPrependAsync(item, signatureHtml) },
            { name: "setSignatureAsync", fn: () => bodySetSignatureAsync(item, signatureHtml) },
        ];
    } else {
        // Default: setSignatureAsync is best — doesn't touch body at all
        methods = [
            { name: "setSignatureAsync", fn: () => bodySetSignatureAsync(item, signatureHtml) },
            { name: "prependAsync", fn: () => bodyPrependAsync(item, signatureHtml) },
        ];
    }

    console.log(`[CardByte] ${label} Platform: ${owa ? 'OWA' : 'Desktop'}, hasGifs: ${hasGifs}, method order: ${methods.map(m => m.name).join(' → ')}`);

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
 * Full-body replacement insertion (used for new compose or as last resort).
 * Tries all methods including setAsync which replaces the entire body.
 */
async function tryInsertFullBody(item, fullHtml, label = "") {
    // const owa = isOWA();
    // const hasGifs = containsGifImages(fullHtml);

    // let methods;

    const owa = isOWA();
    const mac = isMac();
    const hasGifs = containsGifImages(fullHtml);

    let methods;

    if (mac) {
        // On Mac: setAsync last — it nukes the body if fullHtml is wrong
        methods = [
            { name: "setSelectedDataAsync", fn: () => bodySetSelectedDataAsync(item, fullHtml) },
            { name: "setSignatureAsync", fn: () => bodySetSignatureAsync(item, fullHtml) },
            { name: "prependAsync", fn: () => bodyPrependAsync(item, fullHtml) },
            { name: "setAsync", fn: () => bodySetAsync(item, fullHtml) }, // last resort
        ];
    } else if (owa || hasGifs) {
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

    console.log(`[CardByte] ${label} Platform: ${owa ? 'OWA' : 'Desktop'}, hasGifs: ${hasGifs}, method order: ${methods.map(m => m.name).join(' → ')}`);

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
   Outlook Wrapper
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

function stabilizeSelection(_item) {
    return Promise.resolve();
}

/* ---------------------------------------------------------
   Main Insertion — Multi-Strategy (FIXED for Reply chains)
   --------------------------------------------------------- */

/**
 * TWO PATHS:
 *
 * PATH A — REPLY / REPLY ALL / FORWARD (reply chain detected):
 *   Uses setSignatureAsync or prependAsync to insert ONLY the signature.
 *   These methods don't replace the body, so the reply chain and cursor
 *   position are preserved. Falls back to full-body replacement only
 *   if signature-only methods all fail.
 *
 * PATH B — NEW COMPOSE (no reply chain):
 *   Appends signature to existing body (which may just be empty or a
 *   stripped default signature) and uses full-body replacement.
 *
 * Each path has tiered image compression fallbacks.
 */
async function insertSignatureWithoutCursorError(item, signatureHtml) {
    try {
        if (window.__INSERTING_SIGNATURE__) return;
        window.__INSERTING_SIGNATURE__ = true;

        await stabilizeSelection(item);

        const wrappedHtml = wrapForOutlook(signatureHtml);
        const signatureBlock = `<!-- CARD_BYTE_SIGNATURE_START -->${wrappedHtml}<!-- CARD_BYTE_SIGNATURE_END -->`;

        const sizeKB = (signatureBlock.length / 1024).toFixed(1);
        const gifCount = (signatureBlock.match(/data:image\/gif;base64,/gi) || []).length;
        console.log(`[CardByte] ── Insertion start ── Signature size: ${sizeKB} KB, GIFs: ${gifCount}`);

        // ✅ READ existing body to detect reply chain
        const existingBody = await getBodyHtml(item);
        const isReply = detectReplyChain(existingBody);
        const alreadyHasSignature = hasCardByteSignature(existingBody);

        console.log(`[CardByte] isReply: ${isReply}, alreadyHasSignature: ${alreadyHasSignature}`);

        // ═══════════════════════════════════════════════════
        // PATH A: REPLY / REPLY ALL / FORWARD
        // ═══════════════════════════════════════════════════
        if (isReply) {
            console.log("[CardByte] 📧 Reply/Forward detected — using signature-only insertion to preserve chain & cursor");

            // If we already have a CardByte signature, we need to replace it
            // which requires full-body replacement
            if (alreadyHasSignature) {
                console.log("[CardByte] Replacing existing CardByte signature in reply");
                const updatedBody = existingBody.replace(
                    /<!-- CARD_BYTE_SIGNATURE_START -->[\s\S]*?<!-- CARD_BYTE_SIGNATURE_END -->/,
                    signatureBlock
                );
                // Must use full-body set since we're replacing inline content
                const result = await tryInsertFullBody(item, updatedBody, "Reply-Replace");
                if (result.success) return;
                // If that fails, fall through to signature-only methods below
            }

            // ── Tier 1: Insert signature only (no body replacement) ──
            {
                console.log("[CardByte] Reply Tier 1: Signature-only insert");
                const result = await tryInsertSignatureOnly(item, signatureBlock, "Reply-T1");
                if (result.success) return;
            }

            // ── Tier 2: Compress images in signature, then signature-only insert ──
            {
                console.log("[CardByte] Reply Tier 2: Compress + signature-only insert");
                try {
                    const compressed = await compressImagesInHtml(signatureBlock);
                    console.log(`[CardByte] Compressed signature: ${(compressed.length / 1024).toFixed(1)} KB`);
                    const result = await tryInsertSignatureOnly(item, compressed, "Reply-T2");
                    if (result.success) return;
                } catch (e) {
                    console.warn("[CardByte] Reply Tier 2 compression error:", e.message);
                }
            }

            // ── Tier 3: CID attachments + signature-only insert ──
            {
                console.log("[CardByte] Reply Tier 3: CID + signature-only insert");
                try {
                    const { cleanedHtml, images } = extractBase64Images(signatureBlock);
                    const result = await tryInsertSignatureOnly(item, cleanedHtml, "Reply-T3");
                    if (result.success) {
                        let attached = 0;
                        for (const img of images) {
                            try {
                                await addInlineImageAttachment(item, img);
                                attached++;
                            } catch (e) {
                                console.warn(`[CardByte] Image attach failed: ${img.cid}`);
                            }
                        }
                        console.log(`[CardByte] Attached ${attached}/${images.length} images`);
                        return;
                    }
                } catch (e) {
                    console.warn("[CardByte] Reply Tier 3 error:", e.message);
                }
            }

            // ── Tier 4: Strip images + signature-only insert ──
            {
                console.log("[CardByte] Reply Tier 4: Strip images + signature-only");
                const stripped = stripBase64Images(signatureBlock);
                const result = await tryInsertSignatureOnly(item, stripped, "Reply-T4");
                if (result.success) return;
            }

            // ── Tier 5 (last resort): Full body replacement with reply chain preserved ──
            {
                console.log("[CardByte] Reply Tier 5: Full body replacement (last resort — cursor may move)");

                // Find the reply boundary and insert signature before it
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
                    if (match > -1) {
                        insertIndex = match;
                        break;
                    }
                }

                let fullHtml;
                if (insertIndex > -1) {
                    const before = existingBody.slice(0, insertIndex);
                    const after = existingBody.slice(insertIndex);
                    fullHtml = `${before}${signatureBlock}${after}`;
                } else {
                    fullHtml = `${existingBody}${signatureBlock}`;
                }

                const stripped = stripBase64Images(fullHtml);
                const result = await tryInsertFullBody(item, stripped, "Reply-T5");
                if (result.success) return;
            }

            throw new Error("All reply insertion tiers failed");
        }

        // ═══════════════════════════════════════════════════
        // PATH B: NEW COMPOSE
        // ═══════════════════════════════════════════════════
        console.log("[CardByte] ✉️ New compose detected — using standard insertion");

        // For new compose, try setSignatureAsync first (it places the
        // signature correctly and keeps cursor at top)
        // ── Tier 1: Signature-only methods first (even for new compose) ──
        {
            console.log("[CardByte] Compose Tier 1: Signature-only insert");
            const result = await tryInsertSignatureOnly(item, signatureBlock, "Compose-T1");
            if (result.success) return;
        }

        // ── Tier 2: Full body replacement (append signature to existing body) ──
        const fullHtml = `${existingBody}<br/>${signatureBlock}`;

        {
            console.log("[CardByte] Compose Tier 2: Direct full-body insert");
            const result = await tryInsertFullBody(item, fullHtml, "Compose-T2");
            if (result.success) return;
        }

        // ── Tier 3: Compress images + full body ──
        {
            console.log("[CardByte] Compose Tier 3: Compress images");
            try {
                const compressed = await compressImagesInHtml(fullHtml);
                console.log(`[CardByte] Compressed size: ${(compressed.length / 1024).toFixed(1)} KB`);
                const result = await tryInsertFullBody(item, compressed, "Compose-T3");
                if (result.success) return;
            } catch (e) {
                console.warn("[CardByte] Compose Tier 3 compression error:", e.message);
            }
        }

        // ── Tier 4: CID inline attachments ──
        {
            console.log("[CardByte] Compose Tier 4: CID inline attachments");
            try {
                const { cleanedHtml, images } = extractBase64Images(fullHtml);
                const result = await tryInsertFullBody(item, cleanedHtml, "Compose-T4");
                if (result.success) {
                    let attached = 0;
                    for (const img of images) {
                        try {
                            await addInlineImageAttachment(item, img);
                            attached++;
                        } catch (e) {
                            console.warn(`[CardByte] Image attach failed: ${img.cid}`);
                        }
                    }
                    console.log(`[CardByte] Attached ${attached}/${images.length} images`);
                    return;
                }
            } catch (e) {
                console.warn("[CardByte] Compose Tier 4 error:", e.message);
            }
        }

        // ── Tier 5: Strip all images ──
        {
            console.log("[CardByte] Compose Tier 5: Strip images (last resort)");
            const stripped = stripBase64Images(fullHtml);
            const result = await tryInsertFullBody(item, stripped, "Compose-T5");
            if (result.success) return;
        }

        throw new Error("All compose insertion tiers failed");

    } catch (err) {
        console.error("[CardByte] insertSignature TOTAL FAILURE:", err);
        throw err;
    } finally {
        window.__INSERTING_SIGNATURE__ = false;
    }
}

/* ---------------------------------------------------------
   Body Read + Detection Helpers
   --------------------------------------------------------- */

function getBodyHtml(item) {
    return new Promise((resolve, reject) => {
        item.body.getAsync(Office.CoercionType.Html, (r) => {
            if (r.status === "succeeded") resolve(r.value || "");
            else reject(r.error);
        });
    });
}

function hasCardByteSignature(html) {
    return (
        html.includes("CARD_BYTE_SIGNATURE_START") ||
        html.includes("CARDBYTE_SIGNATURE")
    );
}

/**
 * Detects default/built-in signatures from Outlook, mobile clients,
 * and other email providers.
 */
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

/**
 * Strips any detected default signature from the body HTML.
 * Tries multiple strategies to find the signature boundary.
 */
function stripDefaultSignature(html) {
    // Strategy 1: Known container elements
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

    // Strategy 2: Truncate from known text markers
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

    // Strategy 3: MsoNormal-based heuristic
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
 * ✅ SAFE: Skips removal entirely on reply/forward to avoid damaging chain.
 */
async function ensureNoDefaultSignature(item) {
    try {
        await disableClientSignature(item);

        const html = await getBodyHtml(item);

        if (hasCardByteSignature(html)) {
            console.log("[CardByte] CardByte signature already present — skipping default removal");
            return false;
        }

        // ✅ Don't strip signatures from reply/forward bodies — too risky
        if (detectReplyChain(html)) {
            console.log("[CardByte] Reply/forward detected — skipping default signature removal");
            return false;
        }

        if (looksLikeDefaultSignature(html)) {
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
   AUTO-RUN ENTRY POINT (MUST BE GLOBAL)
   --------------------------------------------------------- */

window.applySignature = async function (event = { completed: () => { } }) {
    if (SIGNATURE_STATE === "loading") {
        console.log("[CardByte] Already loading — skipping");
        event.completed();
        return;
    }

    if (SIGNATURE_STATE === "applied") {
        console.log("[CardByte] Already applied — skipping");
        event.completed();
        return;
    }

    const mailbox = Office?.context?.mailbox;
    const item = mailbox?.item;
    const user = mailbox?.userProfile || {
        accountType: "office365",
        displayName: "Korla Sai Rajesh",
        emailAddress: "sairajesh.korla1272@outlook.com",
        timeZone: "India Standard Time"
    };

    try {
        if (!item) {
            console.warn("[CardByte] No mail item found");
            event.completed();
            return;
        }

        SIGNATURE_STATE = "loading";

        console.log("[CardByte] ════════════════════════════════════");
        console.log("[CardByte] Starting signature flow v0.0.4");
        console.log("[CardByte] User:", user?.emailAddress);
        console.log("[CardByte] Platform:", Office?.context?.platform || "unknown");
        console.log("[CardByte] Host:", Office?.context?.host || "unknown");
        console.log("[CardByte] isOWA:", isOWA());

        console.log("[CardByte] API check: setSignatureAsync =", typeof item.body?.setSignatureAsync);
        console.log("[CardByte] API check: prependAsync =", typeof item.body?.prependAsync);
        console.log("[CardByte] API check: setSelectedDataAsync =", typeof item.body?.setSelectedDataAsync);
        console.log("[CardByte] API check: setAsync =", typeof item.body?.setAsync);
        console.log("[CardByte] API check: addFileAttachmentFromBase64Async =", typeof item.addFileAttachmentFromBase64Async);
        console.log("[CardByte] API check: disableClientSignatureAsync =", typeof item.disableClientSignatureAsync);

        const removedDefault = await ensureNoDefaultSignature(item);
        if (removedDefault) {
            console.log("[CardByte] Default signature was removed before applying CardByte");
        }

        const apiResponse = await renderSignatureOnServer(user?.emailAddress);

        if (!apiResponse) {
            throw new Error("API returned empty or null response");
        }

        const sizeKB = (apiResponse.length / 1024).toFixed(1);
        const base64Count = (apiResponse.match(/data:image\/[^;]+;base64,/gi) || []).length;
        const gifCount = (apiResponse.match(/data:image\/gif;base64,/gi) || []).length;
        console.log(`[CardByte] API response: ${sizeKB} KB, ${base64Count} base64 image(s), ${gifCount} GIF(s)`);

        await insertSignatureWithoutCursorError(item, apiResponse);

        SIGNATURE_STATE = "idle";
        console.log("[CardByte] ✅ Signature applied successfully");
        console.log("[CardByte] ════════════════════════════════════");

    } catch (err) {
        SIGNATURE_STATE = "idle";
        console.error("[CardByte] ❌ applySignature failed:", err.message || err);
        console.error("[CardByte] Stack:", err.stack || "N/A");

        try {
            const userProfile = mailbox?.userProfile || {};

            const fallbackHtml = `
        <table cellpadding="0" cellspacing="0" border="0" width="400">
          <tr>
            <td style="font-family:Arial,sans-serif;font-size:12px;">
              <strong>${userProfile.displayName || ""}</strong><br/>
              ${userProfile.emailAddress || ""}<br/>
              <span style="color:#999;">Sent via CardByte</span>
            </td>
          </tr>
        </table>
      `.trim();

            const item = mailbox?.item;
            if (item) {
                // Even fallback should try signature-only first
                const fbResult = await tryInsertSignatureOnly(item, fallbackHtml, "Fallback");
                if (fbResult.success) {
                    console.log("[CardByte] Fallback applied via", fbResult.method);
                } else {
                    const fbResult2 = await tryInsertFullBody(item, fallbackHtml, "Fallback-Full");
                    if (fbResult2.success) {
                        console.log("[CardByte] Fallback applied via", fbResult2.method);
                    } else {
                        console.error("[CardByte] ❌ Fallback also failed entirely");
                    }
                }
            }
        } catch (fallbackErr) {
            console.error("[CardByte] ❌ Fallback error:", fallbackErr);
        }
    } finally {
        SIGNATURE_STATE = "idle";
        event.completed();
    }
};

/* ---------------------------------------------------------
   Debug Helpers
   --------------------------------------------------------- */

window.testCardByte = () =>
    window.applySignature({ completed: () => console.log("🧪 done") });

/**
 * Run from console: window.debugSignatureSize()
 */
window.debugSignatureSize = async function () {
    const mailbox = Office?.context?.mailbox;
    const item = mailbox?.item;
    const user = mailbox?.userProfile?.emailAddress || "sairajesh.korla1272@outlook.com";

    console.log("[Debug] ════════════════════════════════════");
    console.log("[Debug] Platform:", Office?.context?.platform || "unknown");
    console.log("[Debug] Host:", Office?.context?.host || "unknown");
    console.log("[Debug] isOWA:", isOWA());

    if (item) {
        console.log("[Debug] setSignatureAsync:", typeof item.body?.setSignatureAsync);
        console.log("[Debug] prependAsync:", typeof item.body?.prependAsync);
        console.log("[Debug] setSelectedDataAsync:", typeof item.body?.setSelectedDataAsync);
        console.log("[Debug] setAsync:", typeof item.body?.setAsync);
        console.log("[Debug] addFileAttachmentFromBase64Async:", typeof item.addFileAttachmentFromBase64Async);
        console.log("[Debug] disableClientSignatureAsync:", typeof item.disableClientSignatureAsync);
    }

    console.log("[Debug] Fetching signature...");
    const html = await renderSignatureOnServer(user);

    if (!html) {
        console.error("[Debug] No HTML returned");
        return;
    }

    const totalKB = (html.length / 1024).toFixed(1);
    const base64Matches = html.match(/data:image\/[^;]+;base64,[^"]+/gi) || [];
    const gifMatches = html.match(/data:image\/gif;base64,[^"]+/gi) || [];
    const totalBase64KB = (base64Matches.reduce((s, m) => s + m.length, 0) / 1024).toFixed(1);
    const totalGifKB = (gifMatches.reduce((s, m) => s + m.length, 0) / 1024).toFixed(1);

    console.log(`[Debug] Total HTML: ${totalKB} KB`);
    console.log(`[Debug] Base64 images: ${base64Matches.length} (${totalBase64KB} KB total)`);
    console.log(`[Debug] GIF images: ${gifMatches.length} (${totalGifKB} KB total)`);
    base64Matches.forEach((m, i) => {
        const type = m.match(/data:image\/([^;]+)/)?.[1] || "unknown";
        console.log(`  Image ${i} [${type}]: ${(m.length / 1024).toFixed(1)} KB`);
    });

    const { cleanedHtml } = extractBase64Images(html);
    console.log(`[Debug] HTML without images: ${(cleanedHtml.length / 1024).toFixed(1)} KB`);
    console.log(`[Debug] Limit: ${(MAX_SAFE_HTML_SIZE / 1024).toFixed(0)} KB`);
    console.log(`[Debug] Over limit: ${html.length > MAX_SAFE_HTML_SIZE}`);
    console.log("[Debug] ════════════════════════════════════");

    return {
        totalKB,
        imageCount: base64Matches.length,
        gifCount: gifMatches.length,
        imageTotalKB: totalBase64KB,
        gifTotalKB: totalGifKB,
        htmlWithoutImagesKB: (cleanedHtml.length / 1024).toFixed(1),
        overLimit: html.length > MAX_SAFE_HTML_SIZE
    };
};