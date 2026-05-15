let CACHED_SIGNATURE_HTML = null;

// ─── Unified marker (attribute-based — survives Outlook editor round-trips) ───
const SIGNATURE_MARKER = "data-cardbyte-signature";

const AES_KEY = "fnItrY2YfozBqCC2B4XsfqHIvZku3kUOq3DFkbO64kk=";
const AES_IV = "3YapeNfJDung7TXxeKXn4g==";

// ─── Session-based cache buster ───────────────────────────────────────────────
const SESSION_KEY = "cardbyte_session_id";
const CACHE_KEY = "cardbyte_cached_signature";
const CACHE_SESSION_KEY = "cardbyte_cached_signature_session";
const CACHE_TIMESTAMP_KEY = "cardbyte_cached_signature_ts";
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// ─── Watcher config ───────────────────────────────────────────────────────────
const WATCHER_CONFIG = {
    intervalMs: 1500,
    maxRuntimeMs: 30000,
    maxInsertAttempts: 5,
    startupDelayMs: 2000
};

// ─── Watcher state ────────────────────────────────────────────────────────────
let watcherInterval = null;
let watcherStarted = false;
let insertionInProgress = false;
let insertAttempts = 0;
let watcherStartTime = null;
let lastKnownBodyHash = null;

// ─── Session helpers ──────────────────────────────────────────────────────────
function getOrCreateSessionId() {
    let sid = sessionStorage.getItem(SESSION_KEY);
    if (!sid) {
        sid = crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36);
        sessionStorage.setItem(SESSION_KEY, sid);
    }
    return sid;
}

function getCachedSignature({ skipTtl = false } = {}) {
    const currentSid = getOrCreateSessionId();
    const cachedSid = localStorage.getItem(CACHE_SESSION_KEY);

    if (cachedSid !== currentSid) {
        console.log("[CardByte] New session detected — clearing cached signature");
        localStorage.removeItem(CACHE_KEY);
        localStorage.removeItem(CACHE_SESSION_KEY);
        localStorage.removeItem(CACHE_TIMESTAMP_KEY);
        return null;
    }

    if (!skipTtl) {
        const ts = parseInt(localStorage.getItem(CACHE_TIMESTAMP_KEY) || "0", 10);
        if (Date.now() - ts > CACHE_TTL_MS) {
            console.log("[CardByte] Cache TTL expired — clearing cached signature");
            localStorage.removeItem(CACHE_KEY);
            localStorage.removeItem(CACHE_SESSION_KEY);
            localStorage.removeItem(CACHE_TIMESTAMP_KEY);
            return null;
        }
    }

    return localStorage.getItem(CACHE_KEY);
}

function setCachedSignature(html) {
    const currentSid = getOrCreateSessionId();
    try {
        localStorage.setItem(CACHE_KEY, html);
        localStorage.setItem(CACHE_SESSION_KEY, currentSid);
        localStorage.setItem(CACHE_TIMESTAMP_KEY, Date.now().toString());
    } catch (_) { }
}

// ─── Platform detection ───────────────────────────────────────────────────────
const MAX_SAFE_HTML_SIZE = 500_000;
const MAX_SAFE_HTML_SIZE_MOBILE = 200_000;
const MOBILE_MAX_IMAGE_WIDTH = 200;
const MOBILE_IMAGE_QUALITY = 0.5;

function detectPlatform() {
    const platform = (Office?.context?.platform || "").toLowerCase();
    const ua = (navigator?.userAgent || "").toLowerCase();

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
}

function isMobile() { const p = detectPlatform(); return p === "mobile-ios" || p === "mobile-android"; }
function isOWA() { return detectPlatform() === "owa"; }
function isMac() { return detectPlatform() === "mac"; }
function getMaxHtmlSize() { return isMobile() ? MAX_SAFE_HTML_SIZE_MOBILE : MAX_SAFE_HTML_SIZE; }

// ─── Crypto helpers ───────────────────────────────────────────────────────────
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

// ─── Server fetch ─────────────────────────────────────────────────────────────
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

// ─── Image compression ────────────────────────────────────────────────────────
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

// ─── Attachment helpers ───────────────────────────────────────────────────────
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

// ─── Body helpers ─────────────────────────────────────────────────────────────
function bodySetSignatureAsync(item, html) {
    return new Promise((resolve, reject) => {
        if (typeof item.body.setSignatureAsync !== "function") { reject(new Error("setSignatureAsync not available")); return; }
        item.body.setSignatureAsync(html, { coercionType: Office.CoercionType.Html }, (r) => {
            if (r.status === "succeeded") resolve(); else reject(r.error);
        });
    });
}

function moveCursorToTop(item) {
    return new Promise((resolve) => {
        try {
            if (typeof item.body?.prependAsync !== "function") { resolve(); return; }
            item.body.prependAsync("", { coercionType: Office.CoercionType.Text }, () => {
                if (typeof item.body?.setSelectedDataAsync !== "function") { resolve(); return; }
                item.body.setSelectedDataAsync("", { coercionType: Office.CoercionType.Text }, () => resolve());
            });
        } catch { resolve(); }
    });
}

// ─── Core signature apply ─────────────────────────────────────────────────────
async function _applySignatureCore(item, mailbox, { fetchIfMissing = false, skipTtl = false } = {}) {
    const userEmail = mailbox?.userProfile?.emailAddress;

    let fetched = getCachedSignature({ skipTtl });

    if (fetchIfMissing && userEmail && fetched == null) {
        fetched = await renderSignatureOnServer(userEmail);
        if (fetched != null) {
            CACHED_SIGNATURE_HTML = fetched;
            setCachedSignature(fetched);
        }
    }

    if (!fetched) {
        console.warn("[CardByte] No signature available to apply");
        return;
    }

    let compressedSignature = await compressImagesInHtml(fetched);

    // ✅ Wrap with unified marker so watcher can detect presence reliably
    compressedSignature =
        `<div style='margin-top:40px'></div>` +
        `<div ${SIGNATURE_MARKER}="true">` + compressedSignature + `</div>` +
        `<div style='margin-top:40px'></div>`;

    console.log("[CardByte] ════════════════════════════════════",
        fetched ? "Using cached signature" : "No cached signature, will fetch from server",
        compressedSignature, item?.body
    );

    await bodySetSignatureAsync(item, compressedSignature);
    // await moveCursorToTop(item);
}

// ─── Watcher ──────────────────────────────────────────────────────────────────

/**
 * Starts the signature watcher — polls body every intervalMs,
 * calls _applySignatureCore if signature is missing.
 * Stops after maxRuntimeMs or maxInsertAttempts.
 * Safe to call multiple times — runs only once per compose window.
 */
function startSignatureWatcher() {

    if (watcherStarted) return;

    watcherStarted = true;
    watcherStartTime = Date.now();
    insertAttempts = 0;
    lastKnownBodyHash = null;

    console.log("[CardByte] Signature watcher started");

    watcherInterval = setInterval(async () => {
        try {
            const shouldStop = await watcherTick();
            if (shouldStop) stopSignatureWatcher();
        } catch (err) {
            console.error("[CardByte] Watcher tick error:", err);
        }
    }, WATCHER_CONFIG.intervalMs);
}

function stopSignatureWatcher() {
    if (watcherInterval) clearInterval(watcherInterval);
    watcherInterval = null;
    watcherStarted = false;
    console.log("[CardByte] Signature watcher stopped");
}

async function watcherTick() {

    // Stop after timeout
    if (Date.now() - watcherStartTime >= WATCHER_CONFIG.maxRuntimeMs) {
        console.log("[CardByte] Watcher timeout reached");
        return true;
    }

    // Don't overlap with an in-progress insertion
    if (insertionInProgress) return false;

    const html = await getBodyHtmlSafe();
    if (!html) return false;

    // Track body hash to detect editor recreation
    const currentHash = generateSimpleHash(html);
    const bodyChanged = lastKnownBodyHash && currentHash !== lastKnownBodyHash;
    lastKnownBodyHash = currentHash;

    // ✅ Uses the same attribute marker as _applySignatureCore
    const hasSignature = html.includes(SIGNATURE_MARKER);

    if (hasSignature) {
        console.log("[CardByte] Watcher: signature already present");
        return false;
    }

    if (bodyChanged) {
        console.log("[CardByte] Watcher: compose editor likely recreated — reinserting");
    } else {
        console.log("[CardByte] Watcher: signature missing");
    }

    if (insertAttempts >= WATCHER_CONFIG.maxInsertAttempts) {
        console.warn("[CardByte] Watcher: max insertion attempts reached");
        return true;
    }

    // ✅ Delegate to the real core — same path as applySignature event handler
    await insertSignatureSafe();

    return false;
}

function getBodyHtmlSafe() {
    return new Promise((resolve) => {
        try {
            const item = Office.context.mailbox.item;
            if (!item || !item.body) { resolve(null); return; }
            item.body.getAsync(Office.CoercionType.Html, (result) => {
                if (result.status !== Office.AsyncResultStatus.Succeeded) {
                    console.warn("[CardByte] Watcher: getAsync failed");
                    resolve(null); return;
                }
                resolve(result.value || "");
            });
        } catch (err) {
            console.error("[CardByte] getBodyHtmlSafe error:", err);
            resolve(null);
        }
    });
}

/**
 * ✅ Patched — routes through _applySignatureCore instead of buildSignatureHtml()
 */
async function insertSignatureSafe() {
    insertionInProgress = true;
    insertAttempts++;

    console.log(`[CardByte] Watcher insertion attempt #${insertAttempts}`);

    try {
        const mailbox = Office?.context?.mailbox;
        const item = mailbox?.item;

        if (!item) {
            console.warn("[CardByte] Watcher: no item available, skipping");
            return;
        }

        await _applySignatureCore(item, mailbox, { fetchIfMissing: true });

        console.log("[CardByte] Watcher: signature inserted successfully");

    } catch (err) {
        console.error("[CardByte] Watcher: insertion failed:", err);
    } finally {
        insertionInProgress = false;
    }
}

function generateSimpleHash(str) {
    let hash = 0;
    if (!str.length) return hash;
    for (let i = 0; i < str.length; i++) {
        const chr = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + chr;
        hash |= 0;
    }
    return hash;
}

// ─── Event handlers ───────────────────────────────────────────────────────────
window.applySignature = async function (event = { completed: () => { } }, options = {}) {
    console.log("[CardByte] applySignature INVOKED — platform:", detectPlatform());

    const mailbox = Office?.context?.mailbox;
    const item = mailbox?.item;

    try {
        if (!item) { console.warn("[CardByte] applySignature: no item"); return; }
        await _applySignatureCore(item, mailbox, { fetchIfMissing: true });
    } catch (err) {
        console.error("[CardByte] Error in applySignature:", err);
    } finally {
        event.completed();
    }
};

window.onSendHandler = async function (event = { completed: () => { } }) {
    console.log("[CardByte] onSendHandler INVOKED — platform:", detectPlatform());

    const mailbox = Office?.context?.mailbox;
    const item = mailbox?.item;

    try {
        if (!item) { console.warn("[CardByte] onSendHandler: no item"); return; }
        await _applySignatureCore(item, mailbox, { fetchIfMissing: false, skipTtl: true });
    } catch (err) {
        console.error("[CardByte] Error in onSendHandler:", err);
    } finally {
        event.completed({ allowEvent: true });
    }
};

// ─── Office bootstrap ─────────────────────────────────────────────────────────
Office.onReady(() => {
    console.log("[CardByte] Office Ready — platform:", detectPlatform());

    // ✅ Register LaunchEvent handlers inside onReady so Office.actions is guaranteed ready
    if (typeof Office.actions !== "undefined") {
        Office.actions.associate("onSendHandler", onSendHandler);
        Office.actions.associate("applySignature", applySignature);
        console.log("[CardByte] LaunchEvent handlers registered ✓");
    } else {
        console.log("[CardByte] Office.actions not available — Outlook 2016/2019, LaunchEvents not supported");
    }

    // ✅ Start watcher after startup delay to let compose item initialise
    setTimeout(() => {
        startSignatureWatcher();
    }, WATCHER_CONFIG.startupDelayMs);
});