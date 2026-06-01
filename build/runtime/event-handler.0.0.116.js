let CACHED_SIGNATURE_HTML = null;
const SIGNATURE_MARKER = "<!-- CARDBYTE_SIGNATURE -->";
const AES_KEY = "fnItrY2YfozBqCC2B4XsfqHIvZku3kUOq3DFkbO64kk=";
const AES_IV = "3YapeNfJDung7TXxeKXn4g==";

// ─── Session-based cache buster ───────────────────────────────────────────────
const SESSION_KEY = "cardbyte_session_id";
const CACHE_KEY = "cardbyte_cached_signature";
const CACHE_SESSION_KEY = "cardbyte_cached_signature_session";
const CACHE_TIMESTAMP_KEY = "cardbyte_cached_signature_ts";
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// ─── Size constants ───────────────────────────────────────────────────────────
// setSignatureAsync hard limit: 30,000 characters (~29.3 KB)
// We reserve headroom for the wrapper table + HTML overhead
const SIGNATURE_CHAR_LIMIT = 100 * 1024;
const HTML_OVERHEAD_ESTIMATE_KB = 5; // wrapper table, inline styles, etc.
const OVERHEAD_CHARS = HTML_OVERHEAD_ESTIMATE_KB * 1024;
const PROFILE_PHOTO_CHAR_BUDGET = SIGNATURE_CHAR_LIMIT - OVERHEAD_CHARS; // ~24 KB chars

// ─── Size diagnostics ────────────────────────────────────────────────────────

function extractProfilePhotoSrc(html) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, "text/html");
    const img = doc.querySelector('img[alt="Profile Photo"]');
    return img ? img.getAttribute("src") : null;
}

/**
 * Analyses the signature HTML and returns a size breakdown.
 * All sizes in KB (chars / 1024, since base64 is single-byte ASCII).
 *
 *  totalKb          — full HTML string size
 *  photoKb          — profile photo src size (base64 data URL)
 *  htmlWithoutPhoto — HTML size after removing the photo src
 *  budgetKb         — Outlook's limit in KB (≈ 29.3)
 *  photoAllowedKb   — how many KB the photo is allowed to occupy
 *  photoOverBy      — how many KB the photo exceeds its budget (0 = fine)
 *  willFail         — true if the total exceeds the Outlook limit
 */
function analyseSignatureSize(html) {
    if (!html) return null;

    const totalChars = html.length;
    const totalKb = totalChars / 1024;

    const photoSrc = extractProfilePhotoSrc(html);
    const photoChars = photoSrc ? photoSrc.length : 0;
    const photoKb = photoChars / 1024;

    const htmlWithoutPhotoChars = totalChars - photoChars;
    const htmlWithoutPhotoKb = htmlWithoutPhotoChars / 1024;

    const budgetKb = SIGNATURE_CHAR_LIMIT / 1024;                        // ≈ 29.3 KB
    const photoAllowedKb = (SIGNATURE_CHAR_LIMIT - htmlWithoutPhotoChars) / 1024;
    const photoOverByKb = Math.max(0, photoKb - photoAllowedKb);

    return {
        totalKb: +totalKb.toFixed(1),
        photoKb: +photoKb.toFixed(1),
        htmlWithoutPhotoKb: +htmlWithoutPhotoKb.toFixed(1),
        budgetKb: +budgetKb.toFixed(1),
        photoAllowedKb: +Math.max(0, photoAllowedKb).toFixed(1),
        photoOverByKb: +photoOverByKb.toFixed(1),
        willFail: totalChars > SIGNATURE_CHAR_LIMIT,
    };
}

/**
 * Checks if the error thrown by setSignatureAsync is the Outlook size overflow.
 * Works for both OWA (string match) and Classic Outlook (numeric code).
 */
function isSizeOverflowError(err) {
    if (!err) return false;
    const msg = (err.message || err.toString()).toLowerCase();
    return (
        msg.includes("argumentoutofrange") ||
        msg.includes("out of the range") ||
        msg.includes("dataexceedsmaximumsize") ||
        msg.includes("data parameter") ||
        err.code === 9001   // Office.ErrorCodes.DataExceedsMaximumSize
    );
}

// ─── Notification keys ────────────────────────────────────────────────────────
const NOTIFY_KEYS = {
    API_FAILURE: "cb_api_failure",
    SIG_MISSING: "cb_sig_missing",
    ONSEND_ERROR: "cb_onsend_error",
    ONSEND_TIMEOUT: "cb_onsend_timeout",
    RETRYING: "cb_retrying",
};

// ─── NotificationManager ─────────────────────────────────────────────────────
// Renders natively above the email body using Office.js notificationMessages API.
// Works from both the taskpane iframe and the UI-less event-handler iframe.

const Notify = (() => {
    function getItem() {
        return Office?.context?.mailbox?.item ?? null;
    }

    // Office notification messages have a hard 150-char limit
    function truncate(msg) {
        return msg.length > 147 ? msg.slice(0, 147) + "…" : msg;
    }

    // replaceAsync first so we never show duplicate banners for the same key.
    // Falls back to addAsync only if the key doesn't exist yet (error code 9016).
    function _upsert(key, details) {
        const item = getItem();
        if (!item) return;
        item.notificationMessages.replaceAsync(key, details, (result) => {
            if (result.error?.code === 9016) {
                item.notificationMessages.addAsync(key, details, () => { });
            }
        });
    }

    function showError(key, message) {
        _upsert(key, {
            type: Office.MailboxEnums.ItemNotificationMessageType.ErrorMessage,
            message: truncate(message),
        });
    }

    function showInfo(key, message, persistent = true) {
        _upsert(key, {
            type: Office.MailboxEnums.ItemNotificationMessageType.InformationalMessage,
            message: truncate(message),
            icon: "icon-16",   // must match a <bt:Image> id in your manifest
            persistent,
        });
    }

    function remove(key) {
        const item = getItem();
        if (!item) return;
        item.notificationMessages.removeAsync(key, () => { });
    }

    function removeAll() {
        Object.values(NOTIFY_KEYS).forEach(remove);
    }

    return {
        // ── API / auth ──────────────────────────────────────────────────────
        apiFailed(detail = "") {
            showError(
                NOTIFY_KEYS.API_FAILURE,
                `CardByte: Could not load signature${detail ? " — " + detail : ""}. Check your connection.`
            );
        },
        authFailed() {
            showError(
                NOTIFY_KEYS.API_FAILURE,
                "CardByte: Authentication failed. Please sign in again from the taskpane."
            );
        },

        // ── Signature missing ───────────────────────────────────────────────
        signatureMissing() {
            showError(
                NOTIFY_KEYS.SIG_MISSING,
                "CardByte: Signature could not be applied to this message. Open the taskpane to retry."
            );
        },

        // ── OnSend errors ───────────────────────────────────────────────────
        onSendFailed(reason = "") {
            showError(
                NOTIFY_KEYS.ONSEND_ERROR,
                `CardByte: Signature validation failed${reason ? " — " + reason : ""}. Signature may be missing.`
            );
        },
        onSendTimeout() {
            showError(
                NOTIFY_KEYS.ONSEND_TIMEOUT,
                "CardByte: Send handler timed out. Signature may not have been applied. Please retry sending."
            );
        },

        // ── Transient info (retrying) ───────────────────────────────────────
        retrying() {
            showInfo(
                NOTIFY_KEYS.RETRYING,
                "CardByte: Fetching your signature…",
                false   // non-persistent — auto-clears on item navigation
            );
        },

        // ── Stale cache fallback warning ────────────────────────────────────
        usingStaleCache() {
            showInfo(
                NOTIFY_KEYS.API_FAILURE,
                "CardByte: Using a cached signature — server unreachable. Your latest changes may not be reflected.",
                true
            );
        },
        // ── Size overflow ───────────────────────────────────────────────────
        sizeError(sizes) {
            const actual = sizes?.photoKb ?? 0;
            const allowed = sizes?.photoAllowedKb ?? 0;
            const overBy = sizes?.photoOverByKb ?? 0;
            showError(
                NOTIFY_KEYS.API_FAILURE,
                `CardByte: Signature too large — photo is ${actual} KB (limit ${allowed} KB, over by ${overBy} KB). Upload a smaller profile photo.`
            );
        },

        // ── Clear ───────────────────────────────────────────────────────────
        clear() { removeAll(); },
        clearKey(key) { remove(key); },
    };
})();

// ─── Session helpers ──────────────────────────────────────────────────────────

function getOrCreateSessionId() {
    let sid = sessionStorage.getItem(SESSION_KEY);
    if (!sid) {
        sid = crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36);
        sessionStorage.setItem(SESSION_KEY, sid);
    }
    return sid;
}

// FIX: Added skipSessionCheck option so onSendHandler (which runs in a separate
// iframe/JS context with a fresh sessionStorage) can still read the cached
// signature that was stored by applySignature in the compose iframe.
function getCachedSignature({ skipTtl = false, skipSessionCheck = false } = {}) {
    if (skipSessionCheck) {
        return localStorage.getItem(CACHE_KEY);
    }

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

function isMobile() {
    const p = detectPlatform();
    return p === "mobile-ios" || p === "mobile-android";
}
function isOWA() { return detectPlatform() === "owa"; }
function isMac() { return detectPlatform() === "mac"; }
function getMaxHtmlSize() { return isMobile() ? MAX_SAFE_HTML_SIZE_MOBILE : MAX_SAFE_HTML_SIZE; }

Office.onReady(() => {
    console.log("✅ Office.onReady is Started !");
    console.log(`[CardByte] Platform detected: ${detectPlatform()}`);
});

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
            "https://ns-enterprise.cardbyte.ai/email-signature/html/outlook/get-active",
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
            "https://ns-renderer.cardbyte.ai/render-signature",
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

// ─── Image helpers ────────────────────────────────────────────────────────────

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
    if (!html) return html;
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, "text/html");
    const profileImg = doc.querySelector('img[alt="Profile Photo"]');
    if (!profileImg) return html;
    const src = profileImg.getAttribute("src");
    if (!src || !src.startsWith("data:image/")) return html;
    console.log(`[CardByte] Compressing profile picture (${(src.length / 1024).toFixed(0)}KB)`);
    const compressed = await compressBase64Image(src);
    if (compressed === src) return html;
    console.log(`[CardByte] Profile picture compressed: ${(src.length / 1024).toFixed(0)}KB -> ${(compressed.length / 1024).toFixed(0)}KB`);
    return html.replace(src, compressed);
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

// ─── Size error notification ──────────────────────────────────────────────────

function _notifySizeError(sizes) {
    const allowed = sizes?.photoAllowedKb ?? 0;
    const actual = sizes?.photoKb ?? 0;
    const overBy = sizes?.photoOverByKb ?? 0;

    Notify.sizeError(sizes); // ← uses showError through the Notify closure

    if (typeof window.__cbSetNotification === "function") {
        window.__cbSetNotification({
            type: "error",
            title: "Signature too large for Outlook",
            sub:
                `Profile photo: ${actual} KB  ·  Allowed: ${allowed} KB  ·  Over by: ${overBy} KB. ` +
                `Upload a smaller profile photo to fix this.`,
            dismissible: true,
        });
    }

    console.error(
        `[CardByte] SIZE OVERFLOW — ` +
        `Total HTML: ${sizes?.totalKb} KB | Photo: ${actual} KB | ` +
        `Budget for photo: ${allowed} KB | Over by: ${overBy} KB | ` +
        `Outlook limit: ${sizes?.budgetKb} KB`
    );
}

// Replace your existing bodySetSignatureAsync with this:
async function bodySetSignatureAsync(item, html) {
    // Pre-flight size check — diagnose BEFORE attempting the call
    const sizes = analyseSignatureSize(html);
    if (sizes) {
        console.log(
            `[CardByte] Size check — total: ${sizes.totalKb} KB | ` +
            `photo: ${sizes.photoKb} KB | html (no photo): ${sizes.htmlWithoutPhotoKb} KB | ` +
            `limit: ${sizes.budgetKb} KB | photo budget: ${sizes.photoAllowedKb} KB`
        );

        if (sizes.willFail) {
            console.warn(
                `[CardByte] ⚠ Signature will exceed Outlook limit. ` +
                `Photo is ${sizes.photoOverByKb} KB over its ${sizes.photoAllowedKb} KB budget.`
            );
            // Notify before the call so the user sees it immediately
            _notifySizeError(sizes);
        }
    }

    return new Promise((resolve, reject) => {
        if (typeof item.body.setSignatureAsync !== "function") {
            reject(new Error("setSignatureAsync not available"));
            return;
        }
        item.body.setSignatureAsync(
            html,
            { coercionType: Office.CoercionType.Html },
            (r) => {
                if (r.status === "succeeded") {
                    resolve();
                } else {
                    if (isSizeOverflowError(r.error)) {
                        const sizes2 = analyseSignatureSize(html);
                        _notifySizeError(sizes2);
                        // Throw a clean message so the outer catch doesn't
                        // overwrite the size-error banner with the raw OWA error
                        const s = sizes2;
                        reject(new Error(
                            `SIZE OVERFLOW — Total HTML: ${s?.totalKb} KB | Photo: ${s?.photoKb} KB | ` +
                            `Budget for photo: ${s?.photoAllowedKb} KB | Over by: ${s?.photoOverByKb} KB | ` +
                            `Outlook limit: ${s?.budgetKb} KB`
                        ));
                    } else {
                        reject(r.error);
                    }
                }
            }
        );
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

// ─── Core signature logic ─────────────────────────────────────────────────────
// FIX: Added skipSessionCheck param so onSendHandler (separate iframe, fresh
// sessionStorage) can still read the signature cached by the compose iframe.

async function _applySignatureCore(item, mailbox, { fetchIfMissing = false, skipTtl = false, skipSessionCheck = false } = {}) {
    const userProfile = mailbox?.userProfile || {};
    const userEmail = userProfile?.emailAddress;

    let fetched = getCachedSignature({ skipTtl, skipSessionCheck });

    // ── Fetch with retries ────────────────────────────────────────────────────
    if (fetchIfMissing && userEmail && fetched == null) {
        Notify.retrying(); // 🔔 Show "Fetching your signature…" info bar

        const MAX_RETRIES = 2;
        let attempt = 0;
        let lastError = null;
        let authErrorDetected = false;

        while (attempt <= MAX_RETRIES) {
            try {
                if (attempt > 0) {
                    console.warn(`[CardByte] Retrying signature fetch (attempt ${attempt}/${MAX_RETRIES})...`);
                    await new Promise(r => setTimeout(r, 1000 * attempt));
                }
                const result = await renderSignatureOnServer(userEmail);
                if (result != null) {
                    fetched = result;
                    CACHED_SIGNATURE_HTML = fetched;
                    // setCachedSignature(fetched);
                    break;
                }
                lastError = new Error("Server returned null");
            } catch (err) {
                lastError = err;
                // Detect auth failures from error shape (4xx from fetch won't throw
                // but a JSON parse on an auth-error body might; guard broadly)
                if (err?.message?.toLowerCase().includes("auth") ||
                    err?.message?.toLowerCase().includes("401") ||
                    err?.message?.toLowerCase().includes("403")) {
                    authErrorDetected = true;
                    break; // no point retrying auth failures
                }
                console.warn(`[CardByte] Fetch attempt ${attempt + 1} failed:`, err);
            }
            attempt++;
        }

        if (fetched != null) {
            // Compress immediately after fetch and store compressed version
            fetched = await compressImagesInHtml(fetched);
            CACHED_SIGNATURE_HTML = fetched;
            // setCachedSignature(fetched);
            Notify.clear(); // ✅ Fetch succeeded — clear the retrying bar
        } else {
            // All retries exhausted — show the right error
            if (authErrorDetected) {
                Notify.authFailed(); // 🔔 Red: "Authentication failed…"
            } else {
                Notify.apiFailed(lastError?.message || ""); // 🔔 Red: "Could not load signature…"
            }
            console.error(`[CardByte] All ${MAX_RETRIES + 1} fetch attempts failed. Last error:`, lastError);
        }
    }

    // ── Fallback chain ────────────────────────────────────────────────────────
    if (!fetched) {
        // Last-ditch: try stale cache, bypassing both session and TTL checks
        const staleCache = getCachedSignature({ skipTtl: true, skipSessionCheck: true });
        if (staleCache) {
            console.warn("[CardByte] Using stale cached signature as last resort after all retries failed.");
            Notify.usingStaleCache(); // 🔔 Blue: "Using cached signature — server unreachable…"
            fetched = staleCache;
        } else {
            console.warn("[CardByte] No signature available — using fallback identity signature.");
            Notify.signatureMissing(); // 🔔 Red: "Signature could not be applied…"
            fetched = `
                <table cellpadding="0" cellspacing="0" border="0" width="400">
                  <tr>
                    <td style="font-family:Arial,sans-serif;font-size:12px;">
                      <strong>${userProfile.displayName || ""}</strong><br/>
                      ${userProfile.emailAddress || ""}<br/>
                      <span style="color:#999;">Sent via CardByte</span>
                    </td>
                  </tr>
                </table>
            `;
        }
    }

    let finalSignature = `
        <table role="presentation" cellpadding="0" cellspacing="0" border="0">
        <tr>
            <td style="padding-top:40px; padding-bottom:40px;">
            ${fetched}
            </td>
        </tr>
        </table>
        `;

    console.log("[CardByte] ════════════════════════════════════",
        fetched ? "Applying signature" : "No cached signature, will fetch from server",
        finalSignature, item?.body
    );

    await bodySetSignatureAsync(item, finalSignature);
}

// ─── applySignature (compose iframe) ─────────────────────────────────────────

window.applySignature = async function (event = { completed: () => { } }, options = {}) {
    const mailbox = Office?.context?.mailbox;
    const item = mailbox?.item;

    try {
        if (!item) return;
        await _applySignatureCore(item, mailbox, { fetchIfMissing: true });
    } catch (err) {
        console.error("[CardByte] Error in applySignature:", err);
        // Don't overwrite the size-error banner with the generic API failure message
        if (!err.message?.startsWith("SIZE OVERFLOW")) {
            Notify.apiFailed(err.message);
        }
    } finally {
        event.completed();
    }
};

// ─── onSendHandler (UI-less event iframe) ────────────────────────────────────

window.onSendHandler = async function (event = { completed: () => { } }) {
    const mailbox = Office?.context?.mailbox;
    const item = mailbox?.item;

    // Timeout guard — onSendHandler must call event.completed within ~10s
    // or Outlook will kill the handler and potentially block the send.
    const timeoutId = setTimeout(() => {
        console.error("[CardByte] onSendHandler timed out");
        Notify.onSendTimeout(); // 🔔 Red: "Send handler timed out…"
        event.completed({ allowEvent: true });
    }, 8000);

    try {
        if (!item) {
            clearTimeout(timeoutId);
            event.completed({ allowEvent: true });
            return;
        }

        // FIX: skipSessionCheck:true because onSendHandler runs in a separate
        // iframe with its own fresh sessionStorage, so the session ID never
        // matches the one stored by applySignature — causing a false cache miss.
        await _applySignatureCore(item, mailbox, {
            fetchIfMissing: false,
            skipTtl: true,
            skipSessionCheck: true,
        });

        clearTimeout(timeoutId);
        // Only clear error banners on success — keep stale-cache warning visible
        Notify.clearKey(NOTIFY_KEYS.ONSEND_ERROR);
        Notify.clearKey(NOTIFY_KEYS.ONSEND_TIMEOUT);

    } catch (err) {
        clearTimeout(timeoutId);
        console.error("[CardByte] Error in onSendHandler:", err);
        Notify.onSendFailed(err.message); // 🔔 Red: "Signature validation failed…"
    } finally {
        // Guard: if timeout already fired, completed() was already called.
        // Calling it again is a no-op in most Outlook builds but avoids double-fire.
        try { event.completed({ allowEvent: true }); } catch (_) { }
    }
};

// ─── Office.actions registration ─────────────────────────────────────────────

if (typeof Office !== "undefined" && typeof Office.actions !== "undefined") {
    Office.actions.associate("onSendHandler", onSendHandler);
    console.log("[CardByte] Office.actions.associate registered: onSendHandler");
}

if (typeof Office !== "undefined" && typeof Office.actions !== "undefined") {
    Office.actions.associate("applySignature", applySignature);
    console.log("[CardByte] Office.actions.associate registered: applySignature");
} else {
    console.log("[CardByte] Office.actions not available — LaunchEvent path not active (expected on 2016/2019)");
}