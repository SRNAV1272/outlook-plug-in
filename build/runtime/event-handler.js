/* =========================================================
   CARDBYTE – OUTLOOK AUTO-RUN EVENT HANDLER (v0.0.5)
   =========================================================
   FIXES (v0.0.5 — MOBILE SUPPORT):
   - Added mobile platform detection (iOS/Android Outlook)
   - Mobile-specific insertion strategy (setAsync preferred)
   - Retry with delay for mobile slow-init race condition
   - Skip disableClientSignatureAsync on mobile (unsupported)
   - Skip setSignatureAsync on mobile (unsupported)
   - Added mobile-safe fallback chain
   - Reduced image quality/size defaults on mobile
   - Added waitForItemReady() to handle mobile async init

   FIXES (v0.0.5 — GIF PATCH):
   - compressImagesInHtml: added currentDataUrl guard in first pass
     to prevent double-processing when two <img> tags share the same
     base64 data URL (replace() only replaces first occurrence)
   - compressImagesInHtml: second-pass GIF→PNG conversion now correctly
     skips GIFs already converted on mobile in the first pass
   - compressImagesInHtml: second-pass uses getMaxHtmlSize() (mobile-aware)
     instead of the hardcoded MAX_SAFE_HTML_SIZE from v0.0.4

   FIXES (v0.0.4):
   - Reply/ReplyAll/Forward preserves the conversation chain
   - Cursor stays at top of reply area (not pushed to bottom)
   - setSignatureAsync preferred for replies (doesn't move cursor)
   - Fallback uses prependAsync which also preserves cursor
   ========================================================= */
let SIGNATURE_STATE = "idle"; // idle | loading | applied
let CACHED_SIGNATURE_HTML = null; // stores raw API response for use at send time

const SIGNATURE_SPACER = `<br>`;

const SIGNATURE_MARKER = "<!-- CARDBYTE_SIGNATURE -->";

/* ---------------------------------------------------------
   Config
   --------------------------------------------------------- */
const AES_KEY = "fnItrY2YfozBqCC2B4XsfqHIvZku3kUOq3DFkbO64kk=";
const AES_IV = "3YapeNfJDung7TXxeKXn4g==";

const MAX_SAFE_HTML_SIZE = 500_000;        // ~500 KB — desktop/OWA
const MAX_SAFE_HTML_SIZE_MOBILE = 200_000; // ~200 KB — mobile clients have tighter limits
const MOBILE_MAX_IMAGE_WIDTH = 200;
const MOBILE_IMAGE_QUALITY = 0.5;

/* ---------------------------------------------------------
   Platform Detection
   --------------------------------------------------------- */

function detectPlatform() {
    const platform = (Office?.context?.platform || "").toLowerCase();
    const ua = (navigator?.userAgent || "").toLowerCase();

    if (platform === "ios" || platform === "iphone" || platform === "ipad") return "mobile-ios";
    if (platform === "android") return "mobile-android";

    if (ua.includes("outlookmobile") || ua.includes("outlook-ios") || ua.includes("outlook-android")) {
        return ua.includes("android") ? "mobile-android" : "mobile-ios";
    }

    if (
        (platform === "officeonline" || platform === "web" || platform === "") &&
        (ua.includes("iphone") || ua.includes("ipad") || ua.includes("android"))
    ) {
        return ua.includes("android") ? "mobile-android" : "mobile-ios";
    }

    if (platform === "officeonline" || platform === "web" || platform === "") return "owa";
    return "desktop";
}

function isMobile() {
    const p = detectPlatform();
    return p === "mobile-ios" || p === "mobile-android";
}

function isOWA() {
    return detectPlatform() === "owa";
}

function getMaxHtmlSize() {
    return isMobile() ? MAX_SAFE_HTML_SIZE_MOBILE : MAX_SAFE_HTML_SIZE;
}

/* ---------------------------------------------------------
   Office Ready
   --------------------------------------------------------- */

Office.onReady(() => {
    console.log("✅ Office.onReady is Started !");
    console.log(`[CardByte] Platform detected: ${detectPlatform()}`);
});

/* ---------------------------------------------------------
   AES Encryption / Decryption Helpers
   --------------------------------------------------------- */

function base64ToArrayBuffer(base64) {
    let base64Data = base64.replace(/-/g, "+").replace(/_/g, "/");
    const padding = base64Data.length % 4;
    if (padding) base64Data += "=".repeat(4 - padding);
    const binaryString = atob(base64Data);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i);
    return bytes.buffer;
}

function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binaryString = "";
    for (let i = 0; i < bytes.length; i++) binaryString += String.fromCharCode(bytes[i]);
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
            if (generatedKey && generatedKey !== AES_KEY) return handleAesDecrypt(encryptedText, AES_KEY);
            return encryptedText;
        }
        const ivBuffer = base64ToArrayBuffer(AES_IV);
        if (ivBuffer.byteLength !== 16) return encryptedText;
        const key = await crypto.subtle.importKey("raw", keyBuffer, { name: "AES-CBC" }, false, ["decrypt"]);
        let encryptedBuffer;
        try {
            encryptedBuffer = base64ToArrayBuffer(encryptedText);
        } catch (e) {
            return encryptedText;
        }
        if (encryptedBuffer.byteLength % 16 !== 0) {
            console.error(`Invalid encrypted data length: ${encryptedBuffer.byteLength} bytes`);
            return encryptedText;
        }
        const decryptedBuffer = await crypto.subtle.decrypt({ name: "AES-CBC", iv: ivBuffer }, key, encryptedBuffer);
        return new TextDecoder().decode(decryptedBuffer);
    } catch (err) {
        if (generatedKey && generatedKey !== AES_KEY && err.message.includes("key data")) {
            try { return await handleAesDecrypt(encryptedText, AES_KEY); } catch (e) { console.error("Fallback also failed:", e.message); }
        }
        return encryptedText;
    }
}

async function encryptEmail(email = "") {
    try {
        if (!email || email.trim() === "") { console.warn("Warning: Empty email provided"); return ""; }
        const keyBuffer = base64ToArrayBuffer(AES_KEY);
        const ivBuffer = base64ToArrayBuffer(AES_IV);
        if (keyBuffer.byteLength !== 16 && keyBuffer.byteLength !== 32) { console.error(`Invalid key length: ${keyBuffer.byteLength} bytes`); return ""; }
        if (ivBuffer.byteLength !== 16) { console.error(`Invalid IV length: ${ivBuffer.byteLength} bytes`); return ""; }
        const key = await crypto.subtle.importKey("raw", keyBuffer, { name: "AES-CBC" }, false, ["encrypt"]);
        const data = new TextEncoder().encode(email);
        const encrypted = await crypto.subtle.encrypt({ name: "AES-CBC", iv: ivBuffer }, key, data);
        const base64Result = arrayBufferToBase64(encrypted);
        try { atob(base64Result); } catch (e) { console.error("Result is NOT valid base64:", e); }
        return base64Result;
    } catch (err) {
        console.error("Encryption error:", err);
        return "";
    }
}

/* ---------------------------------------------------------
   Server API
   --------------------------------------------------------- */

function forceCursorToTop(item) {
    // return new Promise((resolve) => {
    //     try {
    //         if (typeof item.body?.prependAsync !== "function") { resolve(); return; }
    //         // prependAsync("") moves Outlook's internal write cursor to position 0
    //         // without inserting any visible content.
    //         item.body.prependAsync("", { coercionType: Office.CoercionType.Html }, (r) => {
    //             if (r.status !== "succeeded") { resolve(); return; }
    //             if (typeof item.body?.setSelectedDataAsync !== "function") { resolve(); return; }
    //             // Commit the visible caret at position 0
    //             item.body.setSelectedDataAsync(
    //                 "",
    //                 { coercionType: Office.CoercionType.Html },
    //                 () => resolve()
    //             );
    //         });
    //     } catch { resolve(); }
    // });
    return new Promise((resolve) => {
        // After setAsync, OWA renders the body fresh.
        // We exploit setSelectedDataAsync by first getting the body,
        // then prepending a zero-width non-breaking space as an anchor,
        // selecting it, then immediately deleting it — this forces OWA
        // to commit the caret at position 0.
        console.log("sdlkasdhsakjdhasjdhakjsdhkjsahd- set cursor at the top entered - 1")
        item.body.prependAsync(
            "\uFEFF", // zero-width no-break space — invisible, won't appear in sent email
            { coercionType: Office.CoercionType.Text },
            (r1) => {
                console.log("sdlkasdhsakjdhasjdhakjsdhkjsahd- set cursor at the top entered - 2")
                if (r1.status !== "succeeded") { resolve(); return; }
                // Now select + delete it — this claims the caret at position 0
                item.body.setSelectedDataAsync(
                    "",
                    { coercionType: Office.CoercionType.Text },
                    (r2) => resolve()
                );
            }
        );
    });
}

async function renderSignatureOnServer(user) {
    const platform = Office.context.diagnostics.platform;
    const xPlatform = platform === Office.PlatformType.Mac ? "MAC" : "WINDOWS";

    try {
        const encryptedMail = await encryptEmail(user);
        const primaryRes = await fetch(
            "https://newqa-enterprise.cardbyte.ai/email-signature/html/outlook/get-active",
            { method: "GET", headers: { username: encryptedMail, "X-Platform": xPlatform } }
        );
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

try {
    const legacyRes = await fetch(
        "https://qa-renderer.cardbyte.ai/render-signature",
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: user }) }
    );
    if (!legacyRes.ok) throw new Error("Legacy renderer failed");
    const legacyData = await legacyRes.json();
    console.log("Using LEGACY renderer", legacyData);
    return legacyData?.finalHtml || null;
} catch (legacyError) {
    console.error("Both primary and legacy failed:", legacyError);
    return null;
}
}

/* ---------------------------------------------------------
   Mobile Helpers
   --------------------------------------------------------- */

async function waitForItemReady(item, maxRetries = 5, delayMs = 500) {
    for (let i = 0; i < maxRetries; i++) {
        try {
            await new Promise((resolve, reject) => {
                item.body.getAsync(Office.CoercionType.Html, (r) => {
                    if (r.status === "succeeded") resolve(r.value);
                    else reject(r.error);
                });
            });
            console.log(`[CardByte] Item ready after ${i + 1} attempt(s)`);
            return true;
        } catch (e) {
            console.warn(`[CardByte] Item not ready (attempt ${i + 1}/${maxRetries}): ${e.message || e}`);
            if (i < maxRetries - 1) await new Promise((r) => setTimeout(r, delayMs));
        }
    }
    console.error("[CardByte] Item never became ready");
    return false;
}

function simplifyHtmlForMobile(html) {
    let simplified = html;
    simplified = simplified.replace(/<link[^>]*rel="stylesheet"[^>]*>/gi, "");
    simplified = simplified.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
    simplified = simplified.replace(/<!--\[if[^>]*>[\s\S]*?<!\[endif\]-->/gi, "");
    simplified = simplified.replace(
        /(<table[^>]*?)width\s*=\s*"?\d+"?/gi,
        '$1width="100%" style="max-width:100%;"'
    );
    return simplified;
}

/* ---------------------------------------------------------
   Image Processing Helpers
   --------------------------------------------------------- */

/**
 * Compresses a single base64 data URL image via Canvas.
 * GIFs are passed through unchanged on desktop to preserve animation.
 * On mobile, GIFs are also passed here but converted via convertGifToStaticPng
 * in compressImagesInHtml before this is called.
 * PNGs use PNG output to preserve transparency.
 * JPEGs try JPEG first, then PNG fallback.
 * On mobile, uses smaller maxWidth and lower quality.
 */
function compressBase64Image(dataUrl, maxWidth, quality) {
    if (maxWidth === undefined) maxWidth = isMobile() ? MOBILE_MAX_IMAGE_WIDTH : 300;
    if (quality === undefined) quality = isMobile() ? MOBILE_IMAGE_QUALITY : 0.7;

    return new Promise((resolve) => {
        // Desktop: skip GIFs to preserve animation.
        // Mobile: GIFs are handled separately via convertGifToStaticPng in compressImagesInHtml.
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
                    if (result.length >= dataUrl.length) { resolve(dataUrl); return; }
                    console.log(`[CardByte] Compressed PNG: ${(dataUrl.length / 1024).toFixed(0)}KB -> ${(result.length / 1024).toFixed(0)}KB`);
                    resolve(result);
                    return;
                }

                ctx.drawImage(img, 0, 0, width, height);
                let result = canvas.toDataURL("image/jpeg", quality);
                if (result.length >= dataUrl.length) result = canvas.toDataURL("image/png");
                if (result.length >= dataUrl.length) { resolve(dataUrl); return; }
                console.log(`[CardByte] Compressed: ${(dataUrl.length / 1024).toFixed(0)}KB -> ${(result.length / 1024).toFixed(0)}KB`);
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
 * Used on mobile (always) and on desktop as a last resort when size exceeds limits.
 */
function convertGifToStaticPng(dataUrl, maxWidth) {
    if (maxWidth === undefined) maxWidth = isMobile() ? MOBILE_MAX_IMAGE_WIDTH : 300;

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
                console.log(`[CardByte] GIF->PNG: ${(dataUrl.length / 1024).toFixed(0)}KB -> ${(result.length / 1024).toFixed(0)}KB`);
                resolve(result);
            } catch (e) {
                console.warn("[CardByte] GIF->PNG conversion failed:", e);
                resolve(dataUrl);
            }
        };
        img.onerror = () => resolve(dataUrl);
        img.src = dataUrl;
    });
}

/**
 * Compresses all base64 images in the HTML via Canvas.
 *
 * MOBILE (first pass):
 *   - GIFs → immediately converted to static PNG (mobile renders GIFs poorly)
 *   - Other images → compressed with mobile quality/size settings
 *   Second pass is effectively a no-op for GIFs since they were already converted.
 *
 * DESKTOP / OWA (first pass):
 *   - GIFs → skipped to preserve animation
 *   - Other images → compressed normally
 *   Second pass: if still over limit, convert remaining GIFs to static PNG.
 *
 * Guard: currentDataUrl check prevents double-processing when two <img> tags
 * share the exact same base64 string (String.replace() only replaces the first
 * occurrence, so the second copy stays unchanged and must be processed separately).
 */
async function compressImagesInHtml(html) {
    const regex = /src\s*=\s*"(data:image\/[^;]+;base64,[^"]+)"/gi;
    const matches = [];
    let match;

    while ((match = regex.exec(html)) !== null) {
        matches.push({ fullMatch: match[0], dataUrl: match[1] });
    }

    if (matches.length === 0) return html;

    const mobile = isMobile();
    console.log(`[CardByte] Compressing ${matches.length} base64 image(s) (mobile: ${mobile})`);

    let result = html;

    // ── First pass ──────────────────────────────────────────────────────────
    for (const m of matches) {
        // Guard: if this exact dataUrl no longer exists in result, it was
        // already replaced in a prior iteration (e.g. two <img> tags with the
        // same base64 string — replace() only replaces the first occurrence).
        // Re-check each time since result mutates in the loop.
        if (!result.includes(m.dataUrl)) continue;

        const isGif = m.dataUrl.startsWith("data:image/gif");

        if (isGif && mobile) {
            // Mobile: always convert GIF → static PNG (first frame)
            console.log(`[CardByte] Mobile: converting GIF to static PNG (${(m.dataUrl.length / 1024).toFixed(0)}KB)`);
            const staticPng = await convertGifToStaticPng(m.dataUrl);
            if (staticPng !== m.dataUrl) result = result.replace(m.dataUrl, staticPng);
            continue;
        }

        if (isGif) {
            // Desktop/OWA: preserve GIF animation in first pass
            console.log(`[CardByte] Skipping GIF (${(m.dataUrl.length / 1024).toFixed(0)}KB) to preserve animation`);
            continue;
        }

        const compressed = await compressBase64Image(m.dataUrl);
        if (compressed !== m.dataUrl) result = result.replace(m.dataUrl, compressed);
    }

    // ── Second pass ─────────────────────────────────────────────────────────
    // Only runs if still over the platform-appropriate size limit.
    // On mobile this is largely a no-op because GIFs were already handled above.
    // On desktop this converts any remaining GIFs to static PNG as a last resort.
    const maxSize = getMaxHtmlSize();
    if (result.length > maxSize) {
        console.log(`[CardByte] Still too large (${(result.length / 1024).toFixed(1)}KB > ${(maxSize / 1024).toFixed(0)}KB), converting remaining GIFs to static PNG`);
        for (const m of matches) {
            if (!m.dataUrl.startsWith("data:image/gif")) continue;
            if (!result.includes(m.dataUrl)) continue; // already converted in pass 1
            const staticPng = await convertGifToStaticPng(m.dataUrl);
            if (staticPng !== m.dataUrl) result = result.replace(m.dataUrl, staticPng);
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
                if (result.status === Office.AsyncResultStatus.Succeeded) resolve(true);
                else { console.error(`[CardByte] Attach failed ${cid}:`, result.error); reject(result.error); }
            }
        );
    });
}

/* ---------------------------------------------------------
   Body Insertion Methods
   --------------------------------------------------------- */

// function bodySetAsync(item, html) {
//     return new Promise((resolve, reject) => {
//         item.body.setAsync(html, { coercionType: Office.CoercionType.Html }, (r) => {
//             if (r.status === "succeeded") resolve(); else reject(r.error);
//         });
//     });
// }
function bodySetAsync(item, html) {
    return new Promise((resolve, reject) => {
        item.body.setAsync(
            html,
            { coercionType: Office.CoercionType.Html },
            (r) => {
                if (r.status !== "succeeded") {
                    reject(r.error);
                    return;
                }
                // setAsync always drops cursor at end.
                // prependAsync("") with empty string reliably repositions
                // the write cursor to position 0 without inserting any
                // visible content — cleaner than the \uFEFF approach.
                if (typeof item.body?.prependAsync === "function") {
                    item.body.prependAsync(
                        "",
                        { coercionType: Office.CoercionType.Html },
                        () => resolve()
                    );
                } else {
                    resolve();
                }
            }
        );
    });
}

function bodyPrependAsync(item, html) {
    return new Promise((resolve, reject) => {
        if (typeof item.body.prependAsync !== "function") { reject(new Error("prependAsync not available")); return; }
        item.body.prependAsync(html, { coercionType: Office.CoercionType.Html }, (r) => {
            if (r.status === "succeeded") {
                if (typeof item.body.setSelectedDataAsync === "function") {
                    item.body.setSelectedDataAsync("", { coercionType: Office.CoercionType.Text }, () => resolve());
                } else {
                    resolve();
                }
            } else {
                reject(r.error);
            }
        });
    });
}

function bodySetSelectedDataAsync(item, html) {
    return new Promise((resolve, reject) => {
        if (typeof item.body.setSelectedDataAsync !== "function") { reject(new Error("setSelectedDataAsync not available")); return; }
        item.body.setSelectedDataAsync(html, { coercionType: Office.CoercionType.Html }, (r) => {
            if (r.status === "succeeded") resolve(); else reject(r.error);
        });
    });
}

function bodySetSignatureAsync(item, html) {
    return new Promise((resolve, reject) => {
        if (typeof item.body.setSignatureAsync !== "function") { reject(new Error("setSignatureAsync not available")); return; }
        item.body.setSignatureAsync(html, { coercionType: Office.CoercionType.Html }, (r) => {
            if (r.status === "succeeded") resolve(); else reject(r.error);
        });
    });
}

/**
 * Checks if the HTML contains any GIF base64 images.
 */
function containsGifImages(html) {
    return /data:image\/gif;base64,/i.test(html);
}

/**
 * Detects if the current body looks like a reply/forward.
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

/* ---------------------------------------------------------
   Insertion Strategy — Platform-Aware
   --------------------------------------------------------- */

async function tryInsertSignatureOnly(item, signatureHtml, label = "") {
    const platform = detectPlatform();
    const mobile = isMobile();
    const owa = platform === "owa";
    const hasGifs = containsGifImages(signatureHtml);

    let methods;

    if (mobile) {
        methods = [
            { name: "prependAsync", fn: () => bodyPrependAsync(item, signatureHtml) },
        ];
        if (typeof item.body?.setSignatureAsync === "function") {
            methods.push({ name: "setSignatureAsync", fn: () => bodySetSignatureAsync(item, signatureHtml) });
        }
    } else if (owa && hasGifs) {
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

    console.log(`[CardByte] ${label} Platform: ${platform}, hasGifs: ${hasGifs}, method order: ${methods.map(m => m.name).join(' -> ')}`);

    for (const m of methods) {
        try {
            console.log(`[CardByte] ${label} Trying ${m.name}...`);
            await m.fn();
            console.log(`[CardByte] ${m.name} succeeded`);
            return { success: true, method: m.name };
        } catch (err) {
            const msg = err?.message || err?.code || JSON.stringify(err);
            console.warn(`[CardByte] ${m.name} failed: ${msg}`);
        }
    }

    return { success: false, method: "none" };
}

async function tryInsertFullBody(item, fullHtml, label = "") {
    const platform = detectPlatform();
    const mobile = isMobile();
    const owa = platform === "owa";
    const hasGifs = containsGifImages(fullHtml);

    let methods;

    // if (mobile) {
    //     methods = [
    //         { name: "setAsync", fn: () => bodySetAsync(item, fullHtml) },
    //         { name: "prependAsync", fn: () => bodyPrependAsync(item, fullHtml) },
    //     ];
    // } else if (owa || hasGifs) {
    //     methods = [
    //         { name: "setAsync", fn: () => bodySetAsync(item, fullHtml) },
    //         { name: "prependAsync", fn: () => bodyPrependAsync(item, fullHtml) },
    //         { name: "setSelectedDataAsync", fn: () => bodySetSelectedDataAsync(item, fullHtml) },
    //         { name: "setSignatureAsync", fn: () => bodySetSignatureAsync(item, fullHtml) },
    //     ];
    // } else {
    //     methods = [
    //         { name: "setSignatureAsync", fn: () => bodySetSignatureAsync(item, fullHtml) },
    //         { name: "setAsync", fn: () => bodySetAsync(item, fullHtml) },
    //         { name: "prependAsync", fn: () => bodyPrependAsync(item, fullHtml) },
    //         { name: "setSelectedDataAsync", fn: () => bodySetSelectedDataAsync(item, fullHtml) },
    //     ];
    // }
    if (mobile) {
        methods = [
            { name: "setAsync", fn: () => bodySetAsync(item, fullHtml) },
            { name: "prependAsync", fn: () => bodyPrependAsync(item, fullHtml) },
        ];
    } else if (owa && hasGifs) {
        // OWA + GIFs: setSignatureAsync breaks GIF rendering, so setAsync first
        methods = [
            { name: "setSelectedDataAsync", fn: () => bodySetSelectedDataAsync(item, fullHtml) },
            { name: "prependAsync", fn: () => bodyPrependAsync(item, fullHtml) },
            { name: "setSignatureAsync", fn: () => bodySetSignatureAsync(item, fullHtml) },
            { name: "setAsync", fn: () => bodySetAsync(item, fullHtml) },
        ];
    } else if (owa && !hasGifs) {
        // OWA, no GIFs: setSignatureAsync FIRST — keeps cursor at top
        methods = [
            { name: "setSelectedDataAsync", fn: () => bodySetSelectedDataAsync(item, fullHtml) },
            { name: "prependAsync", fn: () => bodyPrependAsync(item, fullHtml) },
            { name: "setSignatureAsync", fn: () => bodySetSignatureAsync(item, fullHtml) },
            { name: "setAsync", fn: () => bodySetAsync(item, fullHtml) },
        ];
    } else {
        // Desktop
        methods = [
            { name: "setSelectedDataAsync", fn: () => bodySetSelectedDataAsync(item, fullHtml) },
            { name: "prependAsync", fn: () => bodyPrependAsync(item, fullHtml) },
            { name: "setSignatureAsync", fn: () => bodySetSignatureAsync(item, fullHtml) },
            { name: "setAsync", fn: () => bodySetAsync(item, fullHtml) },
        ];
    }

    console.log(`[CardByte] ${label} Platform: ${platform}, hasGifs: ${hasGifs}, method order: ${methods.map(m => m.name).join(' -> ')}`);

    for (const m of methods) {
        try {
            console.log(`[CardByte] ${label} Trying ${m.name}...`);
            await m.fn();
            console.log(`[CardByte] ${m.name} succeeded`);
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
    if (isMobile()) {
        return `
    <div id="cardbyte-signature-block" contenteditable="false" style="font-family: Arial, sans-serif; font-size: 14px;">
      <table contenteditable="false" cellpadding="0" cellspacing="0" border="0" style="width:100%; max-width:100%;">
        <tbody><tr><td style="padding: 0; margin: 0;">${innerHtml}</td></tr></tbody>
      </table>
    </div>`;
    }
    return `
    <div id="cardbyte-signature-block" contenteditable="false" style="font-family: Calibri, Arial, sans-serif; font-size: 11pt; mso-line-height-rule: exactly;">
      <table contenteditable="false" cellpadding="0" cellspacing="0" border="0" style="font-family: inherit; font-size: inherit; color: inherit;">
        <tbody><tr><td style="padding: 0; margin: 0;">${innerHtml}</td></tr></tbody>
      </table>
    </div>`;
}

function stabilizeSelection(item) {
    return new Promise((resolve) => {
        try {
            if (typeof item.body?.setSelectedDataAsync !== "function") { resolve(); return; }
            item.body.getAsync(Office.CoercionType.Html, (r) => {
                if (r.status !== "succeeded") { resolve(); return; }
                item.body.setSelectedDataAsync("", { coercionType: Office.CoercionType.Text }, () => resolve());
            });
        } catch (e) {
            resolve();
        }
    });
}

/* ---------------------------------------------------------
   Main Insertion — Multi-Strategy
   --------------------------------------------------------- */

async function insertSignatureWithoutCursorError(item, signatureHtml) {
    try {
        if (window.__INSERTING_SIGNATURE__) return;
        window.__INSERTING_SIGNATURE__ = true;

        const mobile = isMobile();

        // On mobile, simplify HTML first and aggressively compress/convert images
        // (including GIF→PNG conversion) before wrapping or building the block.
        let processedHtml = signatureHtml;
        if (mobile) {
            console.log("[CardByte] Mobile: simplifying HTML and compressing images upfront");
            processedHtml = simplifyHtmlForMobile(processedHtml);
            processedHtml = await compressImagesInHtml(processedHtml);
            // After compressImagesInHtml on mobile, all GIFs are now static PNGs.
        }

        const wrappedHtml = wrapForOutlook(processedHtml);
        const signatureBlock = `${SIGNATURE_SPACER}<!-- CARD_BYTE_SIGNATURE_START -->${wrappedHtml}<!-- CARD_BYTE_SIGNATURE_END -->`;
        console.log(`[CardByte] Built signature block (html: ${wrappedHtml})`);
        const sizeKB = (signatureBlock.length / 1024).toFixed(1);
        const gifCount = (signatureBlock.match(/data:image\/gif;base64,/gi) || []).length;
        console.log(`[CardByte] -- Insertion start -- Size: ${sizeKB} KB, GIFs: ${gifCount}, mobile: ${mobile}`);
        if (mobile && gifCount > 0) {
            // This should never happen after mobile compression, but log a warning if it does.
            console.warn(`[CardByte] WARNING: ${gifCount} GIF(s) still present after mobile compression!`);
        }

        const existingBody = await getBodyHtml(item);
        const isReply = detectReplyChain(existingBody);
        const alreadyHasSignature = hasCardByteSignature(existingBody);

        console.log(`[CardByte] isReply: ${isReply}, alreadyHasSignature: ${alreadyHasSignature}`);

        // ═══════════════════════════════════════════════════
        // PATH A: REPLY / REPLY ALL / FORWARD
        // ═══════════════════════════════════════════════════
        if (isReply) {
            console.log("[CardByte] Reply/Forward detected");

            if (alreadyHasSignature) {
                console.log("[CardByte] Replacing existing CardByte signature in reply");
                const updatedBody = existingBody.replace(
                    /<!-- CARD_BYTE_SIGNATURE_START -->[\s\S]*?<!-- CARD_BYTE_SIGNATURE_END -->/,
                    signatureBlock
                );
                const result = await tryInsertFullBody(item, updatedBody, "Reply-Replace");
                if (result.success) {
                    return;
                };
            }

            // MOBILE REPLY PATH
            if (mobile) {
                console.log("[CardByte] Mobile reply: using full-body strategy");

                {
                    const result = await tryInsertSignatureOnly(item, signatureBlock, "MobileReply-T1");
                    if (result.success) {
                        return;
                    }
                }

                {
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
                        const m = existingBody.search(marker);
                        if (m > -1) { insertIndex = m; break; }
                    }
                    const fullHtml = insertIndex > -1
                        ? existingBody.slice(0, insertIndex) + signatureBlock + existingBody.slice(insertIndex)
                        : existingBody + signatureBlock;

                    let result = await tryInsertFullBody(item, fullHtml, "MobileReply-T2");
                    if (result.success) {
                        return;
                    }

                    result = await tryInsertFullBody(item, stripBase64Images(fullHtml), "MobileReply-T3");
                    if (result.success) {
                        return;
                    }
                }

                throw new Error("All mobile reply insertion methods failed");
            }

            // DESKTOP / OWA REPLY PATH
            {
                console.log("[CardByte] Reply Tier 1: Signature-only insert");
                const result = await tryInsertSignatureOnly(item, signatureBlock, "Reply-T1");
                if (result.success) {
                    return;
                }
            }
            {
                console.log("[CardByte] Reply Tier 2: Compress + signature-only insert");
                try {
                    const compressed = await compressImagesInHtml(signatureBlock);
                    console.log(`[CardByte] Compressed signature: ${(compressed.length / 1024).toFixed(1)} KB`);
                    const result = await tryInsertSignatureOnly(item, compressed, "Reply-T2");
                    if (result.success) {
                        return;
                    }
                } catch (e) { console.warn("[CardByte] Reply Tier 2 compression error:", e.message); }
            }

            {
                console.log("[CardByte] Reply Tier 4: Strip images + signature-only");
                const result = await tryInsertSignatureOnly(item, stripBase64Images(signatureBlock), "Reply-T4");
                if (result.success) {
                    return;
                }
            }
            {
                console.log("[CardByte] Reply Tier 5: Full body replacement (last resort)");
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
                    const m = existingBody.search(marker);
                    if (m > -1) { insertIndex = m; break; }
                }
                const fullHtml = insertIndex > -1
                    ? existingBody.slice(0, insertIndex) + signatureBlock + existingBody.slice(insertIndex)
                    : existingBody + signatureBlock;
                const result = await tryInsertFullBody(item, stripBase64Images(fullHtml), "Reply-T5");
                if (result.success) {
                    return;
                }
            }

            throw new Error("All reply insertion tiers failed");
        }

        // ═══════════════════════════════════════════════════
        // PATH B: NEW COMPOSE
        // ═══════════════════════════════════════════════════
        console.log("[CardByte] New compose detected");

        if (alreadyHasSignature) {
            console.log("[CardByte] Replacing existing CardByte signature in compose");
            const updatedBody = existingBody.replace(
                /<!-- CARD_BYTE_SIGNATURE_START -->[\s\S]*?<!-- CARD_BYTE_SIGNATURE_END -->/,
                signatureBlock
            );
            const result = await tryInsertFullBody(item, updatedBody, "Compose-Replace");
            if (result.success) {
                return;
            }
        }

        // MOBILE COMPOSE PATH
        if (mobile) {
            console.log("[CardByte] Mobile compose: using full-body strategy");
            {
                const result = await tryInsertSignatureOnly(item, signatureBlock, "MobileCompose-T1");
                if (result.success) { await stabilizeSelection(item); return; }
            }
            {
                const fullHtml = existingBody + "<br/>" + signatureBlock;
                let result = await tryInsertFullBody(item, fullHtml, "MobileCompose-T2");
                if (result.success) { await stabilizeSelection(item); return; }

                result = await tryInsertFullBody(item, stripBase64Images(fullHtml), "MobileCompose-T3");
                if (result.success) { await stabilizeSelection(item); return; }
            }
            throw new Error("All mobile compose insertion methods failed");
        }



        // DESKTOP / OWA COMPOSE PATH
        // Mirror the reply/forward approach: always build a full-body HTML and write it back.
        // This gives us 100% control over spacing — no Outlook-injected gaps from setSignatureAsync.

        {
            console.log("[CardByte] Compose Tier 1: Full-body insert (consistent spacing like reply path)");
            const fullHtml = existingBody
                ? existingBody.replace(/(\s|<br\s*\/?>|&nbsp;)+$/gi, "").trimEnd() + signatureBlock
                : signatureBlock;
            const result = await tryInsertFullBody(item, fullHtml, "Compose-T1");
            if (result.success) {
                return;
            }
        }
        {
            console.log("[CardByte] Compose Tier 2: Compress images + full-body insert");
            try {
                const compressed = await compressImagesInHtml(signatureBlock);
                const fullHtml = existingBody
                    ? existingBody.replace(/(\s|<br\s*\/?>|&nbsp;)+$/gi, "").trimEnd() + compressed
                    : compressed;
                const result = await tryInsertFullBody(item, fullHtml, "Compose-T2");
                if (result.success) {
                    return;
                }
            } catch (e) { console.warn("[CardByte] Compose Tier 2 compression error:", e.message); }
        }
        {
            console.log("[CardByte] Compose Tier 3: CID images + full-body insert");
            try {
                const { cleanedHtml, images } = extractBase64Images(signatureBlock);
                const fullHtml = existingBody
                    ? existingBody.replace(/(\s|<br\s*\/?>|&nbsp;)+$/gi, "").trimEnd() + cleanedHtml
                    : cleanedHtml;
                const result = await tryInsertFullBody(item, fullHtml, "Compose-T3");
                if (result.success) {
                    let attached = 0;
                    for (const img of images) {
                        try { await addInlineImageAttachment(item, img); attached++; }
                        catch (e) { console.warn(`[CardByte] Image attach failed: ${img.cid}`); }
                    }
                    console.log(`[CardByte] Attached ${attached}/${images.length} images`);
                }
            } catch (e) { console.warn("[CardByte] Compose Tier 3 error:", e.message); }
        }
        {
            console.log("[CardByte] Compose Tier 4: Strip images + full-body insert");
            const stripped = stripBase64Images(signatureBlock);
            const fullHtml = existingBody
                ? existingBody.replace(/(\s|<br\s*\/?>|&nbsp;)+$/gi, "").trimEnd() + stripped
                : stripped;
            const result = await tryInsertFullBody(item, fullHtml, "Compose-T4");
            if (result.success) {
                return;
            }
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
    return /id="x?_?cardbyte-signature-block"/i.test(html)
        || html.includes("CARD_BYTE_SIGNATURE_START")
        || html.includes("CARDBYTE_SIGNATURE");
}

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
    for (const p of containerPatterns) cleaned = cleaned.replace(p, "");
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
    if (isMobile()) {
        console.log("[CardByte] Mobile: skipping disableClientSignature (not supported)");
        return false;
    }
    try {
        if (typeof item.body?.setSignatureAsync === "function") {
            await new Promise((resolve, reject) => {
                item.body.setSignatureAsync("", { coercionType: Office.CoercionType.Html }, (r) => {
                    if (r.status === "succeeded") resolve(); else reject(r.error);
                });
            });
            console.log("[CardByte] Cleared Outlook client signature slot via setSignatureAsync");
            return true;
        }
    } catch (e) { console.warn("[CardByte] Could not clear client signature slot:", e.message); }

    try {
        if (typeof item.disableClientSignatureAsync === "function") {
            await new Promise((resolve, reject) => {
                item.disableClientSignatureAsync((r) => {
                    if (r.status === "succeeded") resolve(); else reject(r.error);
                });
            });
            console.log("[CardByte] Disabled client signature via disableClientSignatureAsync");
            return true;
        }
    } catch (e) { console.warn("[CardByte] disableClientSignatureAsync not available:", e.message); }

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
            const cleaned = stripDefaultSignature(html);
            if (cleaned.length < html.length) {
                await bodySetAsync(item, cleaned);
                console.log("[CardByte] Default signature removed from body");
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

        const platform = detectPlatform();
        const mobile = isMobile();

        console.log("[CardByte] ════════════════════════════════════");
        console.log("[CardByte] Starting signature flow v0.0.5");
        console.log("[CardByte] User:", user?.emailAddress);
        console.log("[CardByte] Platform:", platform);
        console.log("[CardByte] Host:", Office?.context?.host || "unknown");
        console.log("[CardByte] isMobile:", mobile);
        console.log("[CardByte] isOWA:", isOWA());
        console.log("[CardByte] UserAgent:", navigator?.userAgent?.substring(0, 120) || "unknown");
        console.log("[CardByte] API check: setSignatureAsync =", typeof item.body?.setSignatureAsync);
        console.log("[CardByte] API check: prependAsync =", typeof item.body?.prependAsync);
        console.log("[CardByte] API check: setSelectedDataAsync =", typeof item.body?.setSelectedDataAsync);
        console.log("[CardByte] API check: setAsync =", typeof item.body?.setAsync);
        console.log("[CardByte] API check: addFileAttachmentFromBase64Async =", typeof item.addFileAttachmentFromBase64Async);
        console.log("[CardByte] API check: disableClientSignatureAsync =", typeof item.disableClientSignatureAsync);

        if (mobile) {
            console.log("[CardByte] Mobile: waiting for item readiness...");
            const ready = await waitForItemReady(item);
            if (!ready) throw new Error("Mail item not ready on mobile after retries");
        }

        const removedDefault = await ensureNoDefaultSignature(item);
        if (removedDefault) console.log("[CardByte] Default signature was removed before applying CardByte");

        const apiResponse = await renderSignatureOnServer(user?.emailAddress);
        if (!apiResponse) throw new Error("API returned empty or null response");

        CACHED_SIGNATURE_HTML = apiResponse; // ← cache for onSendHandler
        try {
            localStorage.setItem("cardbyte_cached_signature", apiResponse);
            console.log("[CardByte] Signature cached to localStorage");
        } catch (e) {
            console.warn("[CardByte] localStorage write failed:", e.message);
        }
        const sizeKB = (apiResponse.length / 1024).toFixed(1);
        const base64Count = (apiResponse.match(/data:image\/[^;]+;base64,/gi) || []).length;
        const gifCount = (apiResponse.match(/data:image\/gif;base64,/gi) || []).length;
        console.log(`[CardByte] API response: ${sizeKB} KB, ${base64Count} base64 image(s), ${gifCount} GIF(s)`);

        await insertSignatureWithoutCursorError(item, apiResponse);

        SIGNATURE_STATE = "idle";
        console.log("[CardByte] Signature applied successfully");
        console.log("[CardByte] ════════════════════════════════════");

    } catch (err) {
        SIGNATURE_STATE = "idle";
        console.error("[CardByte] applySignature failed:", err.message || err);
        console.error("[CardByte] Stack:", err.stack || "N/A");

        try {
            const userProfile = mailbox?.userProfile || {};
            const fallbackHtml = `
        <table cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:400px;">
          <tr>
            <td style="font-family:Arial,sans-serif;font-size:${isMobile() ? '14' : '12'}px;">
              <strong>${userProfile.displayName || ""}</strong><br/>
              ${userProfile.emailAddress || ""}<br/>
              <span style="color:#999;">Sent via CardByte</span>
            </td>
          </tr>
        </table>`.trim();

            const fallbackItem = mailbox?.item;
            if (fallbackItem) {
                if (isMobile()) {
                    const fbResult = await tryInsertFullBody(fallbackItem, fallbackHtml, "Fallback-Mobile");
                    console.log(fbResult.success
                        ? `[CardByte] Mobile fallback applied via ${fbResult.method}`
                        : "[CardByte] Mobile fallback also failed entirely");
                } else {
                    const fbResult = await tryInsertSignatureOnly(fallbackItem, fallbackHtml, "Fallback");
                    if (fbResult.success) {
                        console.log("[CardByte] Fallback applied via", fbResult.method);
                    } else {
                        const fbResult2 = await tryInsertFullBody(fallbackItem, fallbackHtml, "Fallback-Full");
                        console.log(fbResult2.success
                            ? `[CardByte] Fallback applied via ${fbResult2.method}`
                            : "[CardByte] Fallback also failed entirely");
                    }
                }
            }
        } catch (fallbackErr) {
            console.error("[CardByte] Fallback error:", fallbackErr);
        }
    } finally {
        SIGNATURE_STATE = "idle";
        event.completed();
    }
};

/* ---------------------------------------------------------
   ON-SEND HANDLER
   Re-inserts (or replaces) the CardByte signature at send time.
   Called by the OnMessageSend LaunchEvent.
   --------------------------------------------------------- */
/* ---------------------------------------------------------
   ON-SEND HANDLER
   Removes any existing CardByte signature and re-appends it
   at the very bottom — below all content and reply chains.
   --------------------------------------------------------- */
window.onSendHandler = async function (event = { completed: () => { } }) {

    const mailbox = Office?.context?.mailbox;
    const item = mailbox?.item;

    console.log("[CardByte][OnSend] ════════════════════════════");
    console.log("[CardByte][OnSend] Handler fired");
    console.log("[CardByte][OnSend] item:", item ? "found" : "NULL");

    if (!item) {
        console.error("[CardByte][OnSend] No item — allowing send");
        event.completed({ allowEvent: true });
        return;
    }

    // ── Resolve signature: localStorage → API fallback ───────────────────
    if (!CACHED_SIGNATURE_HTML) {
        try {
            const stored = localStorage.getItem("cardbyte_cached_signature");
            if (stored) {
                CACHED_SIGNATURE_HTML = stored;
                console.log(`[CardByte][OnSend] Restored from localStorage: ${(stored.length / 1024).toFixed(1)}KB`);
            }
        } catch (e) {
            console.warn("[CardByte][OnSend] localStorage read failed:", e.message);
        }
    }

    if (!CACHED_SIGNATURE_HTML) {
        try {
            console.log("[CardByte][OnSend] Cache empty — fetching from API...");
            const userEmail = mailbox?.userProfile?.emailAddress;
            if (userEmail) {
                const fetched = await renderSignatureOnServer(userEmail);
                if (fetched) {
                    CACHED_SIGNATURE_HTML = fetched;
                    console.log(`[CardByte][OnSend] API fetch succeeded: ${(fetched.length / 1024).toFixed(1)}KB`);
                    try {
                        localStorage.setItem("cardbyte_cached_signature", fetched);
                    } catch (e) {
                        console.warn("[CardByte][OnSend] localStorage write failed:", e.message);
                    }
                } else {
                    console.warn("[CardByte][OnSend] API returned null");
                }
            } else {
                console.warn("[CardByte][OnSend] No user email — cannot fetch signature");
            }
        } catch (e) {
            console.warn("[CardByte][OnSend] API fetch failed:", e.message);
        }
    }

    console.log("[CardByte][OnSend] cachedSignature:", CACHED_SIGNATURE_HTML
        ? `${(CACHED_SIGNATURE_HTML.length / 1024).toFixed(1)}KB`
        : "NULL");

    function _getBodyHtml() {
        return new Promise((resolve, reject) => {
            item.body.getAsync(Office.CoercionType.Html, (r) => {
                if (r.status === "succeeded") resolve(r.value || "");
                else reject(new Error(r.error?.message || "getAsync failed"));
            });
        });
    }

    function _setBodyHtml(html) {
        return new Promise((resolve, reject) => {
            item.body.setAsync(html, { coercionType: Office.CoercionType.Html }, (r) => {
                if (r.status === "succeeded") resolve();
                else reject(new Error(r.error?.message || "setAsync failed"));
            });
        });
    }

    function _hasSig(html) {
        return /id="x?_?cardbyte-signature-block"/i.test(html)
            || html.includes("CARD_BYTE_SIGNATURE_START")
            || html.includes("CARDBYTE_SIGNATURE");
    }

    function _stripDivById(html, idPattern) {
        const openTagRegex = new RegExp(`<div[^>]*id="[^"]*${idPattern.source}[^"]*"[^>]*>`, "i");
        const openMatch = openTagRegex.exec(html);
        if (!openMatch) return html;

        const startIndex = openMatch.index;
        let pos = startIndex + openMatch[0].length;
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

        return html.slice(0, startIndex) + html.slice(pos);
    }

    function _stripSig(html) {
        let result = html;
        result = _stripDivById(result, /x?_?cardbyte-signature-block/i);
        result = result.replace(
            /<!-- CARD_BYTE_SIGNATURE_START -->[\s\S]*?<!-- CARD_BYTE_SIGNATURE_END -->/gi,
            ""
        );
        // Only trim trailing — never leading
        result = result.replace(/(\s|<br\s*\/?>|&nbsp;)+$/gi, "").trimEnd();
        return result;
    }

    function _findReplyChainIndex(html) {
        const replyMarkers = [
            /<div[^>]*id="?x?_?divRplyFwdMsg"?/i,
            /<div[^>]*id="?appendonsend"?/i,
            /<hr[^>]*style="[^"]*display\s*:\s*inline-block/i,
            /<blockquote/i,
            /class="?OutlookMessageHeader"?/i,
            /x_divRplyFwdMsg/i,
            /divRplyFwdMsg/i,
        ];
        let earliest = -1;
        for (const marker of replyMarkers) {
            const idx = html.search(marker);
            if (idx > -1 && (earliest === -1 || idx < earliest)) {
                earliest = idx;
                console.log(`[CardByte][OnSend] Reply marker matched: ${marker} at index ${idx}`);
            }
        }
        return earliest;
    }

    // async function _buildFreshSignatureBlock() {
    //     let processedHtml = CACHED_SIGNATURE_HTML;
    //     if (isMobile()) {
    //         processedHtml = simplifyHtmlForMobile(processedHtml);
    //         processedHtml = await compressImagesInHtml(processedHtml);
    //     }
    //     const wrappedHtml = wrapForOutlook(processedHtml);
    //     return `<!-- CARD_BYTE_SIGNATURE_START -->${wrappedHtml}<!-- CARD_BYTE_SIGNATURE_END -->`;
    // }
    async function _buildFreshSignatureBlock() {
        let processedHtml = CACHED_SIGNATURE_HTML;

        // ✅ Always compress — not just on mobile
        processedHtml = await compressImagesInHtml(processedHtml);

        if (isMobile()) {
            processedHtml = simplifyHtmlForMobile(processedHtml);
        }

        const wrappedHtml = wrapForOutlook(processedHtml);
        return `<!-- CARD_BYTE_SIGNATURE_START -->${wrappedHtml}<!-- CARD_BYTE_SIGNATURE_END -->`;
    }

    try {
        console.log("[CardByte][OnSend] Reading body...");
        const body = await _getBodyHtml();
        console.log(`[CardByte][OnSend] Body: ${(body.length / 1024).toFixed(1)}KB, hasSig: ${_hasSig(body)}`);

        // ── Step 1: Strip existing signature ────────────────────────────
        const stripped = _hasSig(body) ? _stripSig(body) : body;
        console.log(`[CardByte][OnSend] After strip: ${(stripped.length / 1024).toFixed(1)}KB, sigStillPresent: ${_hasSig(stripped)}`);

        // ── Step 2: No signature available — send stripped or as-is ─────
        // if (!CACHED_SIGNATURE_HTML) {
        //     console.warn("[CardByte][OnSend] No signature available — sending without");
        //     if (_hasSig(body)) await _setBodyHtml(stripped);
        //     event.completed({ allowEvent: true });
        //     return;
        // }
        // ── Step 2: No signature available — attempt live fetch, then send ───
        if (!CACHED_SIGNATURE_HTML) {
            console.warn("[CardByte][OnSend] No signature in cache — attempting live fetch before send");
            try {
                const userEmail = mailbox?.userProfile?.emailAddress;
                if (userEmail) {
                    const fetched = await renderSignatureOnServer(userEmail);
                    if (fetched) {
                        CACHED_SIGNATURE_HTML = fetched;
                        console.log(`[CardByte][OnSend] Live fetch succeeded: ${(fetched.length / 1024).toFixed(1)}KB`);
                        try { localStorage.setItem("cardbyte_cached_signature", fetched); } catch (_) { }
                    } else {
                        console.warn("[CardByte][OnSend] Live fetch returned null — sending without signature");
                        if (_hasSig(body)) await _setBodyHtml(stripped);
                        event.completed({ allowEvent: true });
                        return;
                    }
                } else {
                    console.warn("[CardByte][OnSend] No user email — sending without signature");
                    if (_hasSig(body)) await _setBodyHtml(stripped);
                    event.completed({ allowEvent: true });
                    return;
                }
            } catch (fetchErr) {
                console.warn("[CardByte][OnSend] Live fetch failed — sending without signature:", fetchErr.message);
                if (_hasSig(body)) await _setBodyHtml(stripped);
                event.completed({ allowEvent: true });
                return;
            }
        }

        // ── Step 3: Build fresh block ────────────────────────────────────
        console.log("[CardByte][OnSend] Building fresh signature block...");
        const freshBlock = await _buildFreshSignatureBlock();
        console.log(`[CardByte][OnSend] Fresh block: ${(freshBlock.length / 1024).toFixed(1)}KB`);

        // ── Step 4: Find reply chain boundary ───────────────────────────
        const replyChainIndex = _findReplyChainIndex(stripped);
        const isReply = replyChainIndex > -1;
        console.log(`[CardByte][OnSend] isReply: ${isReply}, replyChainIndex: ${replyChainIndex}`);

        let finalHtml;

        if (isReply) {
            console.log("[CardByte][OnSend] Reply path — inserting before reply chain");
            const beforeChain = stripped
                .slice(0, replyChainIndex)
                .replace(/(\s|<br\s*\/?>|&nbsp;)+$/gi, "")
                .trimEnd();
            const replyChain = stripped.slice(replyChainIndex);
            console.log(`[CardByte][OnSend] beforeChain: ${(beforeChain.length / 1024).toFixed(1)}KB`);
            console.log(`[CardByte][OnSend] replyChain: ${(replyChain.length / 1024).toFixed(1)}KB`);
            finalHtml = beforeChain + freshBlock + replyChain;
        } else {
            console.log("[CardByte][OnSend] Compose path — appending at bottom");
            finalHtml = stripped + freshBlock;
        }

        console.log(`[CardByte][OnSend] Final body: ${(finalHtml.length / 1024).toFixed(1)}KB`);

        // // ── Step 5: Write back ───────────────────────────────────────────
        // await _setBodyHtml(finalHtml);
        // console.log("[CardByte][OnSend] ✅ Done — allowing send");
        // ── Step 5: Write back — tiered by size ─────────────────────────────
        const SETASYNC_LIMIT = 900_000; // 900 KB — safe headroom under OWA's ~1 MB cap

        console.log(`[CardByte][OnSend] Size check — final: ${(finalHtml.length / 1024).toFixed(1)}KB, limit: ${(SETASYNC_LIMIT / 1024).toFixed(0)}KB`);

        if (finalHtml.length <= SETASYNC_LIMIT) {
            // Fast path — body is within safe limits
            await _setBodyHtml(finalHtml);
            console.log("[CardByte][OnSend] ✅ Done (direct write) — allowing send");
            event.completed({ allowEvent: true });
            return;
        }

        // Body too large — try progressively more aggressive compression

        // Tier A: compress images in the full final body
        console.warn(`[CardByte][OnSend] Body too large — compressing images`);
        try {
            const compressed = await compressImagesInHtml(finalHtml);
            console.log(`[CardByte][OnSend] After compression: ${(compressed.length / 1024).toFixed(1)}KB`);
            if (compressed.length <= SETASYNC_LIMIT) {
                await _setBodyHtml(compressed);
                console.log("[CardByte][OnSend] ✅ Done (compressed) — allowing send");
                event.completed({ allowEvent: true });
                return;
            }
        } catch (e) {
            console.warn("[CardByte][OnSend] Compression failed:", e.message);
        }

        // Tier B: strip base64 images from reply chain only (preserve sig images)
        if (isReply) {
            console.warn(`[CardByte][OnSend] Still too large — stripping base64 from reply chain`);
            try {
                const strippedReplyChain = replyChain.replace(
                    /(<img[^>]+src=")data:[^"]{100,}(")/gi,
                    '$1data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=$2'
                );
                const tierBHtml = beforeChain + freshBlock + strippedReplyChain;
                console.log(`[CardByte][OnSend] Tier B size: ${(tierBHtml.length / 1024).toFixed(1)}KB`);
                if (tierBHtml.length <= SETASYNC_LIMIT) {
                    await _setBodyHtml(tierBHtml);
                    console.log("[CardByte][OnSend] ✅ Done (reply-chain images stripped) — allowing send");
                    event.completed({ allowEvent: true });
                    return;
                }
            } catch (e) {
                console.warn("[CardByte][OnSend] Tier B failed:", e.message);
            }
        }

        // Tier C: strip ALL base64 images from everything (last resort before giving up)
        console.warn(`[CardByte][OnSend] Still too large — stripping all base64 images`);
        try {
            const fullyStripped = finalHtml.replace(
                /(<img[^>]+src=")data:[^"]{100,}(")/gi,
                '$1data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=$2'
            );
            console.log(`[CardByte][OnSend] Tier C size: ${(fullyStripped.length / 1024).toFixed(1)}KB`);
            await _setBodyHtml(fullyStripped);
            console.log("[CardByte][OnSend] ✅ Done (all images stripped) — allowing send");
        } catch (e) {
            console.warn("[CardByte][OnSend] Tier C also failed — allowing send without body modification:", e.message);
        }

        event.completed({ allowEvent: true });

    } catch (err) {
        console.error("[CardByte][OnSend] ❌ Error:", err.message || err);
        console.error("[CardByte][OnSend] Stack:", err.stack || "N/A");
        event.completed({ allowEvent: true });
    }
};

if (typeof Office !== "undefined" && typeof Office.actions !== "undefined") {
    Office.actions.associate("onSendHandler", onSendHandler);
    console.log("[CardByte] Office.actions.associate registered: onSendHandler");
}

/* ---------------------------------------------------------
   Debug Helpers
   --------------------------------------------------------- */

window.testCardByte = () =>
    window.applySignature({ completed: () => console.log("done") });

window.debugSignatureSize = async function () {
    const mailbox = Office?.context?.mailbox;
    const user = mailbox?.userProfile?.emailAddress || "sairajesh.korla1272@outlook.com";
    const item = mailbox?.item;
    const platform = detectPlatform();

    console.log("[Debug] ════════════════════════════════════");
    console.log("[Debug] Platform:", platform);
    console.log("[Debug] isMobile:", isMobile());
    console.log("[Debug] isOWA:", isOWA());
    console.log("[Debug] UserAgent:", navigator?.userAgent?.substring(0, 120) || "unknown");

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
    if (!html) { console.error("[Debug] No HTML returned"); return; }

    const maxSize = getMaxHtmlSize();
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
    console.log(`[Debug] Limit: ${(maxSize / 1024).toFixed(0)} KB (${isMobile() ? 'mobile' : 'desktop/OWA'})`);
    console.log(`[Debug] Over limit: ${html.length > maxSize}`);
    console.log("[Debug] ════════════════════════════════════");

    return {
        platform,
        isMobile: isMobile(),
        totalKB,
        imageCount: base64Matches.length,
        gifCount: gifMatches.length,
        imageTotalKB: totalBase64KB,
        gifTotalKB: totalGifKB,
        htmlWithoutImagesKB: (cleanedHtml.length / 1024).toFixed(1),
        maxSizeKB: (maxSize / 1024).toFixed(0),
        overLimit: html.length > maxSize
    };
};

/* =========================================================
   LaunchEvent / event-based activation (M365 / OWA)
   Registers "applySignature" with the Office runtime so the
   manifest's <LaunchEvent FunctionName="applySignature" />
   can find and call it.
   ========================================================= */
if (typeof Office !== "undefined" && typeof Office.actions !== "undefined") {
    Office.actions.associate("applySignature", applySignature);
    console.log("[CardByte] Office.actions.associate registered: applySignature");
} else {
    console.log("[CardByte] Office.actions not available — LaunchEvent path not active (expected on 2016/2019)");
}