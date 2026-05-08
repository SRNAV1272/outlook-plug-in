/* =========================================================
   CARDBYTE – OUTLOOK AUTO-RUN EVENT HANDLER (v0.0.13)
   =========================================================
   FIXES (v0.0.13 — RECALLED DRAFT BODY WIPE — PART 2):

   ROOT CAUSE:
     v0.0.12 added a hasMeaningfulBody guard in PATH B, but
     only checked it when alreadyHasSignature = false.

     When a recalled draft is opened, it already contains the
     CardByte signature from the original send, so
     alreadyHasSignature = true — bypassing the v0.0.12 guard
     entirely. The code then hit the alreadyHasSignature block
     which unconditionally called tryInsertFullBody with only
     the signature block, wiping the draft body text.

   FIX:
     In the non-Mac alreadyHasSignature branch (PATH B), strip
     the old CardByte sig from the existing body and check if
     meaningful content remains. If yes, route to a
     signature-only path (ComposeReplace-T1/T2/T3) that uses
     setSignatureAsync / prependAsync — which replaces only the
     Outlook signature slot without touching the compose body.
     Falls through to full-body replace only if sig-only fails
     OR if there is no meaningful body content (empty compose).

   ALL OTHER CHANGES: none. v0.0.12 logic fully preserved.

   ─────────────────────────────────────────────────────────
   FIXES (v0.0.12 — RECALLED DRAFT BODY WIPE — PART 1):
   - New _hasMeaningfulBodyContent() helper.
   - PATH B: hasMeaningfulBody && !alreadyHasSignature guard
     routes to DraftPreserve sig-only path instead of
     Compose-T1 full-body replace.

   FIXES (v0.0.11):
   - _stripSigFromSafeZoneOnly() for Mac reply paths.

   FIXES (v0.0.10):
   - Always fetch fresh from API; removed localStorage as
     primary cache to prevent stale sig on reload.

   FIXES (v0.0.9):
   - Mac manual apply: signature-only path.

   FIXES (v0.0.8 — SIGNATURE DUPLICATION BUG):
   - SIGNATURE_STATE set to "applied" after success.
   - Per-item-ID guard resets state for new items.
   - PATH B: cleanBody computed once, reused in all tiers.
   - PATH A: _stripSig before every full-body rebuild.

   FIXES (v0.0.7): Mid-attribute slice bug, tag-anchored patterns.
   FIXES (v0.0.6): Mac support.
   FIXES (v0.0.5): Mobile support, GIF patch.
   FIXES (v0.0.4): Reply/Forward chain preservation.
   ========================================================= */

let SIGNATURE_STATE = "idle"; // idle | loading | applied
let CACHED_SIGNATURE_HTML = null;

const SIGNATURE_SPACER = `<br>`;
const SIGNATURE_MARKER = "<!-- CARDBYTE_SIGNATURE -->";

/* ---------------------------------------------------------
   Config
   --------------------------------------------------------- */
const AES_KEY = "fnItrY2YfozBqCC2B4XsfqHIvZku3kUOq3DFkbO64kk=";
const AES_IV = "3YapeNfJDung7TXxeKXn4g==";

const MAX_SAFE_HTML_SIZE = 500_000;
const MAX_SAFE_HTML_SIZE_MOBILE = 200_000;
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

    if (platform === "mac") return "mac";

    if (
        (platform === "" || platform === "desktop") &&
        (ua.includes("macintosh") || ua.includes("mac os x")) &&
        !ua.includes("iphone") &&
        !ua.includes("ipad")
    ) {
        return "mac";
    }

    if (platform === "officeonline" || platform === "web" || platform === "") return "owa";
    return "desktop";
}

function isMobile() {
    const p = detectPlatform();
    return p === "mobile-ios" || p === "mobile-android";
}

function isOWA() { return detectPlatform() === "owa"; }
function isMac() { return detectPlatform() === "mac"; }

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
        try { keyBuffer = base64ToArrayBuffer(keyToUse); }
        catch (e) { console.error("Failed to decode key as base64:", e); return encryptedText; }
        if (keyBuffer.byteLength !== 16 && keyBuffer.byteLength !== 32) {
            if (generatedKey && generatedKey !== AES_KEY) return handleAesDecrypt(encryptedText, AES_KEY);
            return encryptedText;
        }
        const ivBuffer = base64ToArrayBuffer(AES_IV);
        if (ivBuffer.byteLength !== 16) return encryptedText;
        const key = await crypto.subtle.importKey("raw", keyBuffer, { name: "AES-CBC" }, false, ["decrypt"]);
        let encryptedBuffer;
        try { encryptedBuffer = base64ToArrayBuffer(encryptedText); }
        catch (e) { return encryptedText; }
        if (encryptedBuffer.byteLength % 16 !== 0) {
            console.error(`Invalid encrypted data length: ${encryptedBuffer.byteLength} bytes`);
            return encryptedText;
        }
        const decryptedBuffer = await crypto.subtle.decrypt({ name: "AES-CBC", iv: ivBuffer }, key, encryptedBuffer);
        return new TextDecoder().decode(decryptedBuffer);
    } catch (err) {
        if (generatedKey && generatedKey !== AES_KEY && err.message.includes("key data")) {
            try { return await handleAesDecrypt(encryptedText, AES_KEY); }
            catch (e) { console.error("Fallback also failed:", e.message); }
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

function bodySelectAllAndReplaceAsync(item, html) {
    return new Promise((resolve, reject) => {
        if (typeof item.body.setSelectedDataAsync !== "function") {
            reject(new Error("setSelectedDataAsync not available")); return;
        }
        item.body.getAsync(Office.CoercionType.Html, (r) => {
            if (r.status !== "succeeded") { reject(r.error); return; }
            item.body.setAsync("", { coercionType: Office.CoercionType.Html }, (clearResult) => {
                if (clearResult.status !== "succeeded") { reject(clearResult.error); return; }
                item.body.setSelectedDataAsync(html, { coercionType: Office.CoercionType.Html }, (r2) => {
                    if (r2.status === "succeeded") resolve();
                    else reject(r2.error);
                });
            });
        });
    });
}

/* ---------------------------------------------------------
   Server API
   --------------------------------------------------------- */

function forceCursorToTop(item) {
    return new Promise((resolve) => {
        item.body.prependAsync("\uFEFF", { coercionType: Office.CoercionType.Text }, (r1) => {
            if (r1.status !== "succeeded") { resolve(); return; }
            item.body.setSelectedDataAsync("", { coercionType: Office.CoercionType.Text }, () => resolve());
        });
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
            "https://newqa-renderer.cardbyte.ai/render-signature",
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

function compressBase64Image(dataUrl, maxWidth, quality) {
    if (maxWidth === undefined) maxWidth = isMobile() ? MOBILE_MAX_IMAGE_WIDTH : 300;
    if (quality === undefined) quality = isMobile() ? MOBILE_IMAGE_QUALITY : 0.7;

    return new Promise((resolve) => {
        if (dataUrl.startsWith("data:image/gif")) { resolve(dataUrl); return; }
        const img = new Image();
        img.onload = () => {
            try {
                const canvas = document.createElement("canvas");
                let width = img.width;
                let height = img.height;
                if (width > maxWidth) { height = Math.round((height * maxWidth) / width); width = maxWidth; }
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
                    resolve(result); return;
                }
                ctx.drawImage(img, 0, 0, width, height);
                let result = canvas.toDataURL("image/jpeg", quality);
                if (result.length >= dataUrl.length) result = canvas.toDataURL("image/png");
                if (result.length >= dataUrl.length) { resolve(dataUrl); return; }
                console.log(`[CardByte] Compressed: ${(dataUrl.length / 1024).toFixed(0)}KB -> ${(result.length / 1024).toFixed(0)}KB`);
                resolve(result);
            } catch (e) { console.warn("[CardByte] Canvas compression failed:", e); resolve(dataUrl); }
        };
        img.onerror = () => resolve(dataUrl);
        img.src = dataUrl;
    });
}

function convertGifToStaticPng(dataUrl, maxWidth) {
    if (maxWidth === undefined) maxWidth = isMobile() ? MOBILE_MAX_IMAGE_WIDTH : 300;
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
            try {
                const canvas = document.createElement("canvas");
                let width = img.width;
                let height = img.height;
                if (width > maxWidth) { height = Math.round((height * maxWidth) / width); width = maxWidth; }
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext("2d");
                ctx.clearRect(0, 0, width, height);
                ctx.drawImage(img, 0, 0, width, height);
                const result = canvas.toDataURL("image/png");
                console.log(`[CardByte] GIF->PNG: ${(dataUrl.length / 1024).toFixed(0)}KB -> ${(result.length / 1024).toFixed(0)}KB`);
                resolve(result);
            } catch (e) { console.warn("[CardByte] GIF->PNG conversion failed:", e); resolve(dataUrl); }
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

    const mobile = isMobile();
    console.log(`[CardByte] Compressing ${matches.length} base64 image(s) (mobile: ${mobile})`);

    let result = html;

    for (const m of matches) {
        if (!result.includes(m.dataUrl)) continue;
        const isGif = m.dataUrl.startsWith("data:image/gif");
        if (isGif && mobile) {
            console.log(`[CardByte] Mobile: converting GIF to static PNG (${(m.dataUrl.length / 1024).toFixed(0)}KB)`);
            const staticPng = await convertGifToStaticPng(m.dataUrl);
            if (staticPng !== m.dataUrl) result = result.replace(m.dataUrl, staticPng);
            continue;
        }
        if (isGif) {
            console.log(`[CardByte] Skipping GIF (${(m.dataUrl.length / 1024).toFixed(0)}KB) to preserve animation`);
            continue;
        }
        const compressed = await compressBase64Image(m.dataUrl);
        if (compressed !== m.dataUrl) result = result.replace(m.dataUrl, compressed);
    }

    const maxSize = getMaxHtmlSize();
    if (result.length > maxSize) {
        console.log(`[CardByte] Still too large (${(result.length / 1024).toFixed(1)}KB > ${(maxSize / 1024).toFixed(0)}KB), converting remaining GIFs to static PNG`);
        for (const m of matches) {
            if (!m.dataUrl.startsWith("data:image/gif")) continue;
            if (!result.includes(m.dataUrl)) continue;
            const staticPng = await convertGifToStaticPng(m.dataUrl);
            if (staticPng !== m.dataUrl) result = result.replace(m.dataUrl, staticPng);
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
            resolve(false); return;
        }
        item.addFileAttachmentFromBase64Async(
            base64Data, fileName, { isInline: true, contentId: cid },
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

function bodySetAsync(item, html) {
    return new Promise((resolve, reject) => {
        item.body.setAsync(html, { coercionType: Office.CoercionType.Html }, (r) => {
            if (r.status !== "succeeded") { reject(r.error); return; }
            if (typeof item.body?.prependAsync === "function") {
                item.body.prependAsync("", { coercionType: Office.CoercionType.Html }, () => resolve());
            } else { resolve(); }
        });
    });
}

function bodySetAsyncMac(item, html) {
    return new Promise((resolve, reject) => {
        item.body.setAsync(html, { coercionType: Office.CoercionType.Html }, (r) => {
            if (r.status !== "succeeded") { reject(r.error); return; }
            resolve(); // No prependAsync — avoids cursor loss on Mac
        });
    });
}

function bodyPrependAsync(item, html) {
    return new Promise((resolve, reject) => {
        if (typeof item.body.prependAsync !== "function") { reject(new Error("prependAsync not available")); return; }
        item.body.prependAsync(html, { coercionType: Office.CoercionType.Html }, (r) => {
            if (r.status === "succeeded") {
                if (typeof item.body.setSelectedDataAsync === "function") {
                    item.body.setSelectedDataAsync("", { coercionType: Office.CoercionType.Text }, () => resolve());
                } else { resolve(); }
            } else { reject(r.error); }
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

function containsGifImages(html) {
    return /data:image\/gif;base64,/i.test(html);
}

/* ---------------------------------------------------------
   Reply Chain Detection (v0.0.7 tag-anchored patterns)
   --------------------------------------------------------- */
function detectReplyChain(html) {
    const replyMarkers = [
        /divRplyFwdMsg/i,
        /appendonsend/i,
        /OriginalMessage/i,
        /<blockquote/i,
        /x_divRplyFwdMsg/i,
        /class="?OutlookMessageHeader"?/i,
        /<hr[^>]*style="[^"]*display\s*:\s*inline-block/i,
        /<(?:div|hr|span|table)[^>]*class="[^"]*ms-outlook-[^"]*"/i,
        /<(?:div|hr|span|table)[^>]*class="[^"]*ms-owa-[^"]*"/i,
        /<[^>]*\sdata-ogsc[\s=>]/i,
        /<hr[^>]*class="[^"]*separator[^"]*"/i,
        /<div[^>]*class="?WordSection[0-9]"?/i,
    ];
    return replyMarkers.some((p) => p.test(html));
}

/* ---------------------------------------------------------
   Insertion Strategy — Platform-Aware
   --------------------------------------------------------- */

async function tryInsertSignatureOnly(item, signatureHtml, label = "") {
    const platform = detectPlatform();
    const mobile = isMobile();
    const mac = isMac();
    const owa = platform === "owa";
    const hasGifs = containsGifImages(signatureHtml);

    let methods;

    if (mobile) {
        methods = [{ name: "prependAsync", fn: () => bodyPrependAsync(item, signatureHtml) }];
        if (typeof item.body?.setSignatureAsync === "function") {
            methods.push({ name: "setSignatureAsync", fn: () => bodySetSignatureAsync(item, signatureHtml) });
        }
    } else if (mac) {
        methods = [
            { name: "setSignatureAsync", fn: () => bodySetSignatureAsync(item, signatureHtml) },
            { name: "prependAsync", fn: () => bodyPrependAsync(item, signatureHtml) },
        ];
    } else if (owa && hasGifs) {
        methods = [
            { name: "prependAsync", fn: () => bodyPrependAsync(item, signatureHtml) },
            { name: "setSignatureAsync", fn: () => bodySetSignatureAsync(item, signatureHtml) },
        ];
    } else if (owa) {
        methods = [
            { name: "setSignatureAsync", fn: () => bodySetSignatureAsync(item, signatureHtml) },
            { name: "prependAsync", fn: () => bodyPrependAsync(item, signatureHtml) },
            { name: "setSelectedDataAsync", fn: () => bodySetSelectedDataAsync(item, signatureHtml) },
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
    const mac = isMac();
    const owa = platform === "owa";
    const hasGifs = containsGifImages(fullHtml);

    let methods;

    if (mobile) {
        methods = [
            { name: "setAsync", fn: () => bodySetAsync(item, fullHtml) },
            { name: "prependAsync", fn: () => bodyPrependAsync(item, fullHtml) },
        ];
    } else if (mac) {
        methods = [
            { name: "setAsync", fn: () => bodySetAsyncMac(item, fullHtml) },
            { name: "prependAsync", fn: () => bodyPrependAsync(item, fullHtml) },
        ];
    } else if (owa && hasGifs) {
        methods = [
            { name: "setSelectedDataAsync", fn: () => bodySetSelectedDataAsync(item, fullHtml) },
            { name: "prependAsync", fn: () => bodyPrependAsync(item, fullHtml) },
            { name: "setSignatureAsync", fn: () => bodySetSignatureAsync(item, fullHtml) },
            { name: "setAsync", fn: () => bodySetAsync(item, fullHtml) },
        ];
    } else if (owa && !hasGifs) {
        methods = [
            { name: "setSelectedDataAsync", fn: () => bodySetSelectedDataAsync(item, fullHtml) },
            { name: "prependAsync", fn: () => bodyPrependAsync(item, fullHtml) },
            { name: "setSignatureAsync", fn: () => bodySetSignatureAsync(item, fullHtml) },
            { name: "setAsync", fn: () => bodySetAsync(item, fullHtml) },
        ];
    } else {
        methods = [
            { name: "setSelectedDataAsync", fn: () => bodySelectAllAndReplaceAsync(item, fullHtml) },
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
    const platform = detectPlatform();
    const isMacPlatform = platform === "mac";

    if (isMobile()) {
        return `
    <div id="cardbyte-signature-block" contenteditable="false" style="font-family: Arial, sans-serif; font-size: 14px;">
      <table contenteditable="false" cellpadding="0" cellspacing="0" border="0" style="width:100%; max-width:100%;">
        <tbody><tr><td style="padding: 0; margin: 0;">${innerHtml}</td></tr></tbody>
      </table>
    </div>`;
    }

    if (isMacPlatform) {
        return `
    <div id="cardbyte-signature-block" contenteditable="false" style="font-family: Calibri, Arial, sans-serif; font-size: 11pt; mso-line-height-rule: exactly;">
      ${innerHtml}
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
    if (isMac()) {
        console.log("[CardByte] Mac: skipping stabilizeSelection (not needed, avoids flash)");
        return Promise.resolve();
    }
    return new Promise((resolve) => {
        try {
            if (typeof item.body?.setSelectedDataAsync !== "function") { resolve(); return; }
            item.body.getAsync(Office.CoercionType.Html, (r) => {
                if (r.status !== "succeeded") { resolve(); return; }
                item.body.setSelectedDataAsync("", { coercionType: Office.CoercionType.Text }, () => resolve());
            });
        } catch (e) { resolve(); }
    });
}

function _stripDivById(html, idPattern) {
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
        if (nextOpen !== -1 && nextOpen < nextClose) { depth++; pos = nextOpen + 4; }
        else { depth--; pos = nextClose + 6; }
    }

    return html.slice(0, matchedIndex) + html.slice(pos);
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

function _stripOutlookWrappers(html) {
    let result = html;
    result = result.replace(/<p[^>]*class="?MsoNormal"?[^>]*>([\s\S]*?)<\/p>/gi, '$1<br>');
    result = result.replace(/<div[^>]*class="?WordSection[0-9]+"?[^>]*>([\s\S]*?)<\/div>/gi, '$1');
    result = result.replace(/<o:p[^>]*>[\s\S]*?<\/o:p>/gi, '');
    result = result.replace(/<\/o:p>/gi, '');
    return result;
}

/* ---------------------------------------------------------
   Reply Chain Index Helper (v0.0.7 tag-anchored patterns)
   --------------------------------------------------------- */
function _findReplyChainIndex(html) {
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
        if (idx > -1 && (earliest === -1 || idx < earliest)) {
            earliest = idx;
            console.log(`[CardByte] Reply marker matched: ${marker} at index ${idx}`);
        }
    }
    return earliest;
}

/* ---------------------------------------------------------
   Safe-Zone Strip Helper (v0.0.11)
   Strips CardByte sig only from above the reply chain.
   --------------------------------------------------------- */
function _stripSigFromSafeZoneOnly(html) {
    const chainIndex = _findReplyChainIndex(html);

    if (chainIndex === -1) {
        const stripped = _stripSig(html);
        return { safeZone: stripped, replyChain: "", fullStripped: stripped };
    }

    const safeZone = _stripSig(html.slice(0, chainIndex));
    const replyChain = html.slice(chainIndex);

    return {
        safeZone,
        replyChain,
        fullStripped: safeZone + replyChain,
    };
}

/* ---------------------------------------------------------
   Draft Content Detection Helper (v0.0.12)
   Returns true if cleaned body HTML has real user text
   beyond whitespace/empty tags (threshold > 5 chars).
   --------------------------------------------------------- */
function _hasMeaningfulBodyContent(cleanedBodyHtml) {
    const textOnly = cleanedBodyHtml
        .replace(/<[^>]*>/g, "")
        .replace(/&nbsp;/gi, " ")
        .trim();
    return textOnly.length > 5;
}

/* ---------------------------------------------------------
   Main Insertion — Multi-Strategy
   v0.0.13 CHANGES:
     - PATH B / alreadyHasSignature / non-Mac:
       Strip existing sig from body and check for remaining
       meaningful content. If found, use sig-only insertion
       (ComposeReplace-T1/T2/T3) to preserve the draft body.
       Falls through to full-body replace only when body is
       empty or all sig-only tiers fail.
       This fixes recalled drafts where alreadyHasSignature=true
       was bypassing the v0.0.12 hasMeaningfulBody guard.
   --------------------------------------------------------- */

async function insertSignatureWithoutCursorError(item, signatureHtml, options = {}) {
    const isManualApply = options?.manualApply === true;
    try {
        if (window.__INSERTING_SIGNATURE__) return;
        window.__INSERTING_SIGNATURE__ = true;

        const mobile = isMobile();
        const mac = isMac();

        let processedHtml = signatureHtml;
        if (mobile) {
            console.log("[CardByte] Mobile: simplifying HTML and compressing images upfront");
            processedHtml = simplifyHtmlForMobile(processedHtml);
            processedHtml = await compressImagesInHtml(processedHtml);
        }

        const wrappedHtml = wrapForOutlook(processedHtml);
        const signatureBlock = `${SIGNATURE_SPACER}<!-- CARD_BYTE_SIGNATURE_START -->${wrappedHtml}<!-- CARD_BYTE_SIGNATURE_END -->`;
        console.log(`[CardByte] Built signature block (html: ${wrappedHtml})`);
        const sizeKB = (signatureBlock.length / 1024).toFixed(1);
        const gifCount = (signatureBlock.match(/data:image\/gif;base64,/gi) || []).length;
        console.log(`[CardByte] -- Insertion start -- Size: ${sizeKB} KB, GIFs: ${gifCount}, mobile: ${mobile}, mac: ${mac}`);
        if (mobile && gifCount > 0) console.warn(`[CardByte] WARNING: ${gifCount} GIF(s) still present after mobile compression!`);

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
            }

            // ── MOBILE REPLY PATH ──────────────────────────
            if (mobile) {
                console.log("[CardByte] Mobile reply: using full-body strategy");

                if (!alreadyHasSignature) {
                    const result = await tryInsertSignatureOnly(item, signatureBlock, "MobileReply-T1");
                    if (result.success) { await stabilizeSelection(item); return; }
                }

                {
                    const cleanBody = _stripSig(existingBody);
                    const insertIndex = _findReplyChainIndex(cleanBody);
                    const fullHtml = insertIndex > -1
                        ? cleanBody.slice(0, insertIndex) + signatureBlock + cleanBody.slice(insertIndex)
                        : cleanBody + signatureBlock;

                    let result = await tryInsertFullBody(item, fullHtml, "MobileReply-T2");
                    if (result.success) { await stabilizeSelection(item); return; }

                    result = await tryInsertFullBody(item, stripBase64Images(fullHtml), "MobileReply-T3");
                    if (result.success) { await stabilizeSelection(item); return; }
                }

                throw new Error("All mobile reply insertion methods failed");
            }

            // ── MAC REPLY PATH ────────────────────────────
            if (mac) {
                console.log("[CardByte] Mac reply: using full-body rebuild (setSignatureAsync bypassed)");

                if (isManualApply) {
                    console.log("[CardByte] Mac manual apply: using signature-only path");
                    const result = await tryInsertSignatureOnly(item, "<div style='margin-top:20px'></div>" + signatureBlock + "<div style='margin-top:20px'></div>", "MacManual-T1");
                    if (result.success) { return; }
                    const compressed = await compressImagesInHtml(signatureBlock);
                    const result2 = await tryInsertSignatureOnly(item, "<div style='margin-top:20px'></div>" + compressed + "<div style='margin-top:20px'></div>", "MacManual-T2");
                    if (result2.success) { return; }
                    const result3 = await tryInsertSignatureOnly(item, "<div style='margin-top:20px'></div>" + stripBase64Images(signatureBlock) + "<div style='margin-top:20px'></div>", "MacManual-T3");
                    if (result3.success) { return; }
                    throw new Error("Mac manual apply: all signature-only tiers failed");
                }

                // Mac Reply T1
                {
                    try {
                        const compressed = await compressImagesInHtml(signatureBlock);
                        const { safeZone, replyChain } = _stripSigFromSafeZoneOnly(existingBody);
                        const fullHtml = safeZone + "<div style='margin-top:20px'></div>" + compressed + "<div style='margin-top:20px'></div>" + replyChain;
                        console.log(`[CardByte] Mac Reply T1: ${(fullHtml.length / 1024).toFixed(1)}KB`);
                        const result = await tryInsertFullBody(item, fullHtml, "MacReply-T1");
                        if (result.success) { return; }
                    } catch (e) { console.warn("[CardByte] Mac Reply T1:", e.message); }
                }

                // Mac Reply T2
                {
                    try {
                        const { safeZone, replyChain } = _stripSigFromSafeZoneOnly(existingBody);
                        const fullHtml = safeZone + "<div style='margin-top:20px'></div>" + signatureBlock + "<div style='margin-top:20px'></div>" + replyChain;
                        console.log(`[CardByte] Mac Reply T2 uncompressed: ${(fullHtml.length / 1024).toFixed(1)}KB`);
                        const result = await tryInsertFullBody(item, fullHtml, "MacReply-T2");
                        if (result.success) { return; }
                    } catch (e) { console.warn("[CardByte] Mac Reply T2:", e.message); }
                }

                // Mac Reply T3
                {
                    const { safeZone, replyChain } = _stripSigFromSafeZoneOnly(existingBody);
                    const strippedBlock = stripBase64Images(signatureBlock);
                    const fullHtml = safeZone + "<div style='margin-top:20px'></div>" + strippedBlock + "<div style='margin-top:20px'></div>" + replyChain;
                    const result = await tryInsertFullBody(item, fullHtml, "MacReply-T3");
                    if (result.success) { return; }
                }

                throw new Error("All Mac reply insertion tiers failed");
            }

            // ── DESKTOP / OWA REPLY PATH ──────────────────
            if (!alreadyHasSignature) {
                const result = await tryInsertSignatureOnly(item, "<div style='margin-top:20px'></div>" + signatureBlock + "<div style='margin-top:20px'></div>", "Reply-T1");
                if (result.success) { await stabilizeSelection(item); return; }
            }

            if (!alreadyHasSignature) {
                try {
                    const compressed = await compressImagesInHtml(signatureBlock);
                    const result = await tryInsertSignatureOnly(item, "<div style='margin-top:20px'></div>" + compressed + "<div style='margin-top:20px'></div>", "Reply-T2");
                    if (result.success) { await stabilizeSelection(item); return; }
                } catch (e) { console.warn("[CardByte] Reply T2:", e.message); }
            }

            // T3: full-body rebuild (v0.0.8 — always strip first)
            {
                try {
                    const compressed = await compressImagesInHtml(signatureBlock);
                    const fullHtml = "<div style='margin-top:20px'></div>" + compressed + "<div style='margin-top:20px'></div>";
                    console.log(`[CardByte] Reply T3 full-body: ${(fullHtml.length / 1024).toFixed(1)}KB`);
                    const result = await tryInsertFullBody(item, fullHtml, "Reply-T3");
                    if (result.success) { await stabilizeSelection(item); return; }
                } catch (e) { console.warn("[CardByte] Reply T3:", e.message); }
            }

            // T4: strip images, signature-only
            {
                const result = await tryInsertSignatureOnly(item, "<div style='margin-top:20px'></div>" + stripBase64Images(signatureBlock) + "<div style='margin-top:20px'></div>", "Reply-T4");
                if (result.success) { await stabilizeSelection(item); return; }
            }

            throw new Error("All reply insertion tiers failed");
        }

        // ═══════════════════════════════════════════════════
        // PATH B: NEW COMPOSE
        // ═══════════════════════════════════════════════════
        console.log("[CardByte] New compose detected");

        // v0.0.8: strip existing sig once; reuse cleanBody across all tiers
        const cleanBody = _stripSig(existingBody);

        // v0.0.12: guard for compose windows that have user content but no sig
        // (e.g. user typed before add-in loaded, or fresh recalled draft with no sig)
        const hasMeaningfulBody = _hasMeaningfulBodyContent(cleanBody);

        if (hasMeaningfulBody && !alreadyHasSignature) {
            console.log(`[CardByte] Draft has existing content — using signature-only insertion to preserve body`);

            {
                const result = await tryInsertSignatureOnly(item, signatureBlock, "DraftPreserve-T1");
                if (result.success) { await stabilizeSelection(item); return; }
            }
            {
                try {
                    const compressed = await compressImagesInHtml(signatureBlock);
                    const result = await tryInsertSignatureOnly(item, compressed, "DraftPreserve-T2");
                    if (result.success) { await stabilizeSelection(item); return; }
                } catch (e) { console.warn("[CardByte] DraftPreserve-T2:", e.message); }
            }
            {
                const stripped = stripBase64Images(signatureBlock);
                const result = await tryInsertSignatureOnly(item, stripped, "DraftPreserve-T3");
                if (result.success) { await stabilizeSelection(item); return; }
            }

            throw new Error("Draft-preserve insertion: all signature-only tiers failed");
        }

        // ── REPLACE EXISTING CARDBYTE SIGNATURE ──────────
        if (alreadyHasSignature) {
            console.log("[CardByte] Replacing existing CardByte signature in compose");

            // ── MAC: always rebuild full body ─────────────
            if (mac) {
                let freshBody = existingBody;
                try { freshBody = await getBodyHtml(item); } catch (e) { /* use existingBody */ }
                if (existingBody.length > 200 && freshBody.length < existingBody.length * 0.5) freshBody = existingBody;

                const { safeZone, replyChain } = _stripSigFromSafeZoneOnly(freshBody);
                const trimmedSafe = safeZone.replace(/(\s|<br\s*\/?>|&nbsp;)+$/gi, "").trimEnd();

                const sigVariants = [
                    signatureBlock,
                    await compressImagesInHtml(signatureBlock).catch(() => signatureBlock),
                    stripBase64Images(signatureBlock),
                ];

                for (let i = 0; i < sigVariants.length; i++) {
                    try {
                        const fullHtml = trimmedSafe
                            ? `${trimmedSafe}<br/>${sigVariants[i]}${replyChain || "<br/>"}`
                            : `<br/>${sigVariants[i]}<br/>`;
                        await bodySetAsyncMac(item, fullHtml);
                        console.log(`[CardByte] ✅ Mac compose replace: setAsync succeeded (variant ${i})`);
                        return;
                    } catch (e) {
                        console.warn(`[CardByte] Mac compose replace: setAsync variant ${i} failed:`, e.message);
                    }
                }
                throw new Error("Mac compose replace: all setAsync variants failed");
            }

            // ── NON-MAC: v0.0.13 — sig-only when body has content ──
            // Strip the existing CardByte sig and check if user has
            // typed anything meaningful (handles recalled drafts where
            // alreadyHasSignature=true bypassed the v0.0.12 guard).
            const bodyWithoutSig = cleanBody; // cleanBody = _stripSig(existingBody) — computed above
            const hasDraftContent = _hasMeaningfulBodyContent(bodyWithoutSig);

            if (hasDraftContent) {
                console.log(`[CardByte] Compose-Replace: body has content (${bodyWithoutSig.replace(/<[^>]*>/g, "").trim().length} chars) — using sig-only replace to preserve draft`);

                // ComposeReplace-T1: platform-aware sig-only (setSignatureAsync preferred on OWA/desktop)
                {
                    const result = await tryInsertSignatureOnly(item, signatureBlock, "ComposeReplace-T1");
                    if (result.success) { await stabilizeSelection(item); return; }
                }

                // ComposeReplace-T2: compressed
                {
                    try {
                        const compressed = await compressImagesInHtml(signatureBlock);
                        const result = await tryInsertSignatureOnly(item, compressed, "ComposeReplace-T2");
                        if (result.success) { await stabilizeSelection(item); return; }
                    } catch (e) { console.warn("[CardByte] ComposeReplace-T2:", e.message); }
                }

                // ComposeReplace-T3: stripped images
                {
                    const stripped = stripBase64Images(signatureBlock);
                    const result = await tryInsertSignatureOnly(item, stripped, "ComposeReplace-T3");
                    if (result.success) { await stabilizeSelection(item); return; }
                }

                // All sig-only tiers failed — fall through to full-body as last resort
                console.warn("[CardByte] ComposeReplace sig-only: all tiers failed — falling back to full-body replace");
            }

            // Empty compose OR sig-only failed: safe to do full-body replace
            console.log("[CardByte] Attempting full-body replace to update existing signature");
            const result = await tryInsertFullBody(item, signatureBlock, "Compose-Replace");
            if (result.success) { return; }
        }

        // ── MOBILE COMPOSE PATH ───────────────────────────
        if (mobile) {
            console.log("[CardByte] Mobile compose: using full-body strategy");
            {
                const result = await tryInsertSignatureOnly(item, signatureBlock, "MobileCompose-T1");
                if (result.success) { await stabilizeSelection(item); return; }
            }
            {
                const fullHtml = "<br/>" + signatureBlock;
                let result = await tryInsertFullBody(item, fullHtml, "MobileCompose-T2");
                if (result.success) { await stabilizeSelection(item); return; }

                result = await tryInsertFullBody(item, stripBase64Images(fullHtml), "MobileCompose-T3");
                if (result.success) { await stabilizeSelection(item); return; }
            }
            throw new Error("All mobile compose insertion methods failed");
        }

        // ── MAC MANUAL COMPOSE PATH ───────────────────────
        if (mac && isManualApply) {
            console.log("[CardByte] Mac manual compose apply: append signature below draft");

            let freshBody = existingBody;
            try {
                freshBody = await getBodyHtml(item);
                console.log(`[CardByte] Mac manual compose: re-read body ${(freshBody.length / 1024).toFixed(1)}KB`);
            } catch (e) {
                console.warn("[CardByte] Mac manual compose: re-read failed, using existingBody:", e.message);
            }

            if (existingBody.length > 200 && freshBody.length < existingBody.length * 0.5) {
                console.warn("[CardByte] ⚠️ Mac stale-read on manual compose — reverting to existingBody");
                freshBody = existingBody;
            }

            const { safeZone, replyChain } = _stripSigFromSafeZoneOnly(freshBody);
            const trimmedSafe = safeZone.replace(/(\s|<br\s*\/?>|&nbsp;)+$/gi, "").trimEnd();

            const sigVariants = [
                signatureBlock,
                await compressImagesInHtml(signatureBlock).catch(() => signatureBlock),
                stripBase64Images(signatureBlock),
            ];

            for (let i = 0; i < sigVariants.length; i++) {
                try {
                    const fullHtml = trimmedSafe
                        ? `${trimmedSafe}<div style='margin-top:20px'></div>${sigVariants[i]}${replyChain ? replyChain : "<div style='margin-top:20px'></div>"}`
                        : `<div style='margin-top:20px'></div>${sigVariants[i]}<div style='margin-top:20px'></div>`;
                    await bodySetAsyncMac(item, fullHtml);
                    console.log(`[CardByte] ✅ Mac manual compose: setAsync succeeded (variant ${i})`);
                    return;
                } catch (e) {
                    console.warn(`[CardByte] Mac manual compose: setAsync variant ${i} failed:`, e.message);
                }
            }

            throw new Error("Mac manual compose: all setAsync variants failed");
        }

        // ── DESKTOP / OWA / MAC AUTO-RUN COMPOSE PATH ────
        // All tiers use signatureBlock only (v0.0.8: cleanBody already stripped above)

        // Compose T1
        {
            const fullHtml =
                "<div style='margin-top:20px'></div>" +
                signatureBlock +
                "<div style='margin-top:20px'></div>";
            console.log("[CardByte] Compose Tier 1: Full-body insert");
            const result = await tryInsertFullBody(item, fullHtml, "Compose-T1");
            if (result.success) { return; }
        }

        // Compose T2
        {
            console.log("[CardByte] Compose Tier 2: Compress images + full-body insert");
            try {
                const compressed = await compressImagesInHtml(signatureBlock);
                const fullHtml =
                    "<div style='margin-top:20px'></div>" +
                    compressed +
                    "<div style='margin-top:20px'></div>";
                const result = await tryInsertFullBody(item, fullHtml, "Compose-T2");
                if (result.success) { return; }
            } catch (e) { console.warn("[CardByte] Compose Tier 2 compression error:", e.message); }
        }

        // Compose T3
        {
            console.log("[CardByte] Compose Tier 3: CID images + full-body insert");
            try {
                const { cleanedHtml, images } = extractBase64Images(signatureBlock);
                const fullHtml =
                    "<div style='margin-top:20px'></div>" +
                    cleanedHtml +
                    "<div style='margin-top:20px'></div>";
                const result = await tryInsertFullBody(item, fullHtml, "Compose-T3");
                if (result.success) {
                    console.log(`[CardByte] Attached 0/${images.length} images (CID attach disabled)`);
                    return;
                }
            } catch (e) { console.warn("[CardByte] Compose Tier 3 error:", e.message); }
        }

        // Compose T4
        {
            console.log("[CardByte] Compose Tier 4: Strip images + full-body insert");
            const stripped = stripBase64Images(signatureBlock);
            const fullHtml =
                "<div style='margin-top:20px'></div>" + stripped + "<div style='margin-top:20px'></div>";
            const result = await tryInsertFullBody(item, fullHtml, "Compose-T4");
            if (result.success) { return; }
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
   AUTO-RUN ENTRY POINT
   --------------------------------------------------------- */

window.applySignature = async function (event = { completed: () => { } }, options = {}) {
    const isManualApply = options?.forceApply === true;

    const mailbox = Office?.context?.mailbox;
    const item = mailbox?.item;

    const currentItemId = item?.itemId || null;
    if (currentItemId && window.__LAST_ITEM_ID__ && window.__LAST_ITEM_ID__ !== currentItemId) {
        console.log(`[CardByte] New item detected (${currentItemId}) — resetting SIGNATURE_STATE`);
        SIGNATURE_STATE = "idle";
        CACHED_SIGNATURE_HTML = null;
    }
    if (currentItemId) window.__LAST_ITEM_ID__ = currentItemId;

    if (SIGNATURE_STATE === "loading") {
        console.log("[CardByte] Already loading — skipping");
        event.completed();
        return;
    }

    if (SIGNATURE_STATE === "applied" && !isManualApply) {
        console.log("[CardByte] Already applied for this item — skipping");
        event.completed();
        return;
    }

    if (SIGNATURE_STATE === "applied" && isManualApply) {
        try {
            const currentBody = await new Promise((resolve, reject) => {
                item.body.getAsync(Office.CoercionType.Html, (r) => {
                    if (r.status === "succeeded") resolve(r.value || "");
                    else reject(r.error);
                });
            });
            if (hasCardByteSignature(currentBody)) {
                console.log("[CardByte] Manual apply: signature already present in body — skipping");
                event.completed();
                return;
            }
            console.log("[CardByte] Manual apply: signature was removed from body — resetting state");
            SIGNATURE_STATE = "idle";
        } catch (e) {
            console.warn("[CardByte] Manual apply: body check failed, proceeding anyway:", e.message);
            SIGNATURE_STATE = "idle";
        }
    }

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
        const mac = isMac();

        console.log("[CardByte] ════════════════════════════════════");
        console.log(`[CardByte] Starting signature flow v0.0.13 (manual: ${isManualApply})`);
        console.log("[CardByte] User:", user?.emailAddress);
        console.log("[CardByte] Platform:", platform);
        console.log("[CardByte] isMobile:", mobile, "| isMac:", mac, "| isOWA:", isOWA());

        if (mobile) {
            const ready = await waitForItemReady(item);
            if (!ready) throw new Error("Mail item not ready on mobile after retries");
        }

        if (!isManualApply) {
            const removedDefault = await ensureNoDefaultSignature(item);
            if (removedDefault) console.log("[CardByte] Default signature was removed before applying CardByte");
        } else {
            console.log("[CardByte] Manual apply: skipping ensureNoDefaultSignature to preserve body");
        }

        // v0.0.10: Always fetch fresh from API. In-memory cache is session-only fallback.
        let apiResponse = null;

        try {
            apiResponse = await renderSignatureOnServer(user?.emailAddress);
            console.log(`[CardByte] API fetch succeeded: ${(apiResponse?.length / 1024).toFixed(1)}KB`);
        } catch (fetchErr) {
            console.warn("[CardByte] API fetch threw:", fetchErr?.message);
        }

        if (!apiResponse && CACHED_SIGNATURE_HTML) {
            console.warn("[CardByte] API failed — using in-memory session cache as fallback");
            apiResponse = CACHED_SIGNATURE_HTML;
        }

        if (!apiResponse) {
            throw new Error("API returned empty or null response and no session cache available");
        }

        CACHED_SIGNATURE_HTML = apiResponse;
        try { localStorage.setItem("cardbyte_cached_signature", apiResponse); } catch (e) { }

        await insertSignatureWithoutCursorError(item, "<div style='margin-top:20px'></div>" + apiResponse + "<div style='margin-top:20px'></div>", { manualApply: isManualApply });

        SIGNATURE_STATE = "applied";
        console.log("[CardByte] Signature applied successfully");
        console.log("[CardByte] ════════════════════════════════════");

    } catch (err) {
        SIGNATURE_STATE = "idle";
        console.error("[CardByte] applySignature failed:", err.message || err);

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
                    await tryInsertFullBody(fallbackItem, fallbackHtml, "Fallback-Mobile");
                } else {
                    const r = await tryInsertSignatureOnly(fallbackItem, fallbackHtml, "Fallback");
                    if (!r.success) await tryInsertFullBody(fallbackItem, fallbackHtml, "Fallback-Full");
                }
            }
        } catch (fallbackErr) { console.error("[CardByte] Fallback error:", fallbackErr); }

    } finally {
        event.completed();
    }
};

/* ---------------------------------------------------------
   ON-SEND HANDLER (unchanged from v0.0.7)
   --------------------------------------------------------- */
window.onSendHandler = async function (event = { completed: () => { } }) {

    let completedCalled = false;
    const safeComplete = (opts) => {
        if (!completedCalled) {
            completedCalled = true;
            try { event.completed(opts || { allowEvent: true }); } catch (e) { }
        }
    };

    // Hard timeout for Outlook 2019 (5s limit for on-send handlers)
    const timeout = setTimeout(() => {
        console.warn("[CardByte][OnSend] Timeout — forcing event.completed");
        safeComplete({ allowEvent: true });
    }, 4500);

    try {
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

        if (!CACHED_SIGNATURE_HTML) {
            try {
                const stored = localStorage.getItem("cardbyte_cached_signature");
                if (stored) {
                    CACHED_SIGNATURE_HTML = stored;
                    console.log(`[CardByte][OnSend] Restored from localStorage: ${(stored.length / 1024).toFixed(1)}KB`);
                }
            } catch (e) { console.warn("[CardByte][OnSend] localStorage read failed:", e.message); }
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
                        try { localStorage.setItem("cardbyte_cached_signature", fetched); } catch (e) { }
                    } else { console.warn("[CardByte][OnSend] API returned null"); }
                } else { console.warn("[CardByte][OnSend] No user email — cannot fetch signature"); }
            } catch (e) { console.warn("[CardByte][OnSend] API fetch failed:", e.message); }
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

        async function _buildFreshSignatureBlock() {
            let processedHtml = CACHED_SIGNATURE_HTML;

            const canvasSupported = (() => {
                try {
                    const c = document.createElement("canvas");
                    return typeof c.toDataURL === "function";
                } catch (e) { return false; }
            })();

            if (canvasSupported) {
                try {
                    processedHtml = await compressImagesInHtml(processedHtml);
                } catch (e) {
                    console.warn("[CardByte][OnSend] Image compression skipped:", e.message);
                }
            } else {
                console.warn("[CardByte][OnSend] Canvas not available (IE11/2019) — skipping image compression");
            }

            if (isMobile()) processedHtml = simplifyHtmlForMobile(processedHtml);
            const wrappedHtml = wrapForOutlook(processedHtml);
            return `<!-- CARD_BYTE_SIGNATURE_START -->${wrappedHtml}<!-- CARD_BYTE_SIGNATURE_END -->`;
        }

        try {
            console.log("[CardByte][OnSend] Reading body...");
            const body = await _getBodyHtml();
            console.log(`[CardByte][OnSend] Body: ${(body.length / 1024).toFixed(1)}KB, hasSig: ${_hasSig(body)}`);

            const stripped = _hasSig(body) ? _stripSig(body) : body;
            console.log(`[CardByte][OnSend] After strip: ${(stripped.length / 1024).toFixed(1)}KB`);

            if (!CACHED_SIGNATURE_HTML) {
                console.warn("[CardByte][OnSend] No signature in cache — attempting live fetch before send");
                try {
                    const userEmail = mailbox?.userProfile?.emailAddress;
                    if (userEmail) {
                        const fetched = await renderSignatureOnServer(userEmail);
                        if (fetched) {
                            CACHED_SIGNATURE_HTML = fetched;
                            try { localStorage.setItem("cardbyte_cached_signature", fetched); } catch (_) { }
                        } else {
                            if (_hasSig(body)) await _setBodyHtml(stripped);
                            event.completed({ allowEvent: true }); return;
                        }
                    } else {
                        if (_hasSig(body)) await _setBodyHtml(stripped);
                        event.completed({ allowEvent: true }); return;
                    }
                } catch (fetchErr) {
                    console.warn("[CardByte][OnSend] Live fetch failed:", fetchErr.message);
                    if (_hasSig(body)) await _setBodyHtml(stripped);
                    event.completed({ allowEvent: true }); return;
                }
            }

            console.log("[CardByte][OnSend] Building fresh signature block...");
            const freshBlock = await _buildFreshSignatureBlock();
            console.log(`[CardByte][OnSend] Fresh block: ${(freshBlock.length / 1024).toFixed(1)}KB`);

            const replyChainIndex = _findReplyChainIndex(stripped);
            const isReply = replyChainIndex > -1;
            console.log(`[CardByte][OnSend] isReply: ${isReply}, replyChainIndex: ${replyChainIndex}`);

            let finalHtml;
            let beforeChain = "";
            let replyChain = "";

            if (isReply) {
                beforeChain = stripped
                    .slice(0, replyChainIndex)
                    .replace(/(\s|<br\s*\/?>|&nbsp;)+$/gi, "")
                    .trimEnd();
                replyChain = stripped.slice(replyChainIndex);
                console.log(`[CardByte][OnSend] beforeChain: ${(beforeChain.length / 1024).toFixed(1)}KB, replyChain: ${(replyChain.length / 1024).toFixed(1)}KB`);
                finalHtml = beforeChain + freshBlock + replyChain;
            } else {
                finalHtml = stripped + freshBlock;
            }

            console.log(`[CardByte][OnSend] Final body: ${(finalHtml.length / 1024).toFixed(1)}KB`);

            // const SETASYNC_LIMIT = 900_000;

            // if (finalHtml.length <= SETASYNC_LIMIT) {
            //     await _setBodyHtml(finalHtml);
            //     console.log("[CardByte][OnSend] ✅ Done (direct write)");
            //     event.completed({ allowEvent: true }); return;
            // }

            // // Tier A: compress full body
            // try {
            //     const compressed = await compressImagesInHtml(finalHtml);
            //     if (compressed.length <= SETASYNC_LIMIT) {
            //         await _setBodyHtml(compressed);
            //         console.log("[CardByte][OnSend] ✅ Done (compressed)");
            //         event.completed({ allowEvent: true }); return;
            //     }
            // } catch (e) { console.warn("[CardByte][OnSend] Compression failed:", e.message); }

            // // Tier B: strip base64 from reply chain only
            // if (isReply) {
            //     try {
            //         const strippedReplyChain = replyChain.replace(
            //             /(<img[^>]+src=")data:[^"]{100,}(")/gi,
            //             '$1data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=$2'
            //         );
            //         const tierBHtml = beforeChain + freshBlock + strippedReplyChain;
            //         if (tierBHtml.length <= SETASYNC_LIMIT) {
            //             await _setBodyHtml(tierBHtml);
            //             console.log("[CardByte][OnSend] ✅ Done (reply-chain images stripped)");
            //             event.completed({ allowEvent: true }); return;
            //         }
            //     } catch (e) { console.warn("[CardByte][OnSend] Tier B failed:", e.message); }
            // }

            // // Tier C: strip all base64 images
            // try {
            //     const fullyStripped = finalHtml.replace(
            //         /(<img[^>]+src=")data:[^"]{100,}(")/gi,
            //         '$1data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=$2'
            //     );
            //     await _setBodyHtml(fullyStripped);
            //     console.log("[CardByte][OnSend] ✅ Done (all images stripped)");
            // } catch (e) { console.warn("[CardByte][OnSend] Tier C failed — sending without body modification:", e.message); }

            // event.completed({ allowEvent: true });

            const SETASYNC_LIMIT = 900_000;

            if (finalHtml.length <= SETASYNC_LIMIT) {
                await _setBodyHtml(finalHtml);
                console.log("[CardByte][OnSend] ✅ Done (direct write)");
                event.completed({ allowEvent: true }); return;
            }

            // Tier A: compress only freshBlock images, keep replyChain intact
            try {
                const compressedBlock = await compressImagesInHtml(freshBlock);
                const tierAHtml = isReply
                    ? beforeChain + compressedBlock + replyChain
                    : stripped + compressedBlock;
                if (tierAHtml.length <= SETASYNC_LIMIT) {
                    await _setBodyHtml(tierAHtml);
                    console.log("[CardByte][OnSend] ✅ Done (compressed freshBlock only)");
                    event.completed({ allowEvent: true }); return;
                }
            } catch (e) { console.warn("[CardByte][OnSend] Tier A compression failed:", e.message); }

            // Tier B: strip base64 from freshBlock only, keep replyChain intact
            if (isReply) {
                try {
                    const strippedBlock = stripBase64Images(freshBlock);
                    const tierBHtml = beforeChain + strippedBlock + replyChain;
                    if (tierBHtml.length <= SETASYNC_LIMIT) {
                        await _setBodyHtml(tierBHtml);
                        console.log("[CardByte][OnSend] ✅ Done (freshBlock images stripped, replyChain preserved)");
                        event.completed({ allowEvent: true }); return;
                    }
                } catch (e) { console.warn("[CardByte][OnSend] Tier B failed:", e.message); }
            }

            // Tier C: last resort — strip images from entire body
            try {
                const fullyStripped = finalHtml.replace(
                    /(<img[^>]+src=")data:[^"]{100,}(")/gi,
                    '$1data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=$2'
                );
                await _setBodyHtml(fullyStripped);
                console.log("[CardByte][OnSend] ✅ Done (all images stripped — last resort)");
            } catch (e) { console.warn("[CardByte][OnSend] Tier C failed — sending without body modification:", e.message); }

            event.completed({ allowEvent: true });

        } catch (err) {
            console.error("[CardByte][OnSend] ❌ Error:", err.message || err);
            console.error("[CardByte][OnSend] Stack:", err.stack || "N/A");
            event.completed({ allowEvent: true });
        }
    } catch (err) {
        console.error("[CardByte][OnSend] ❌ Fatal:", err.message);
        safeComplete({ allowEvent: true });
    } finally {
        clearTimeout(timeout);
        safeComplete({ allowEvent: true }); // no-op if already called
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
    console.log("[Debug] isMac:", isMac());
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
        isMac: isMac(),
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

/* ---------------------------------------------------------
   LaunchEvent registration
   --------------------------------------------------------- */
if (typeof Office !== "undefined" && typeof Office.actions !== "undefined") {
    Office.actions.associate("applySignature", applySignature);
    console.log("[CardByte] Office.actions.associate registered: applySignature");
} else {
    console.log("[CardByte] Office.actions not available — LaunchEvent path not active (expected on 2016/2019)");
}