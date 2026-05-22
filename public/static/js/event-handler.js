/**
 * CardByte Signature Manager — event-handler.js
 *
 * Platform support matrix (all via LaunchEvent / event-based activation):
 *   ✅ Classic Outlook on Windows  (Mailbox 1.10+, JS-only runtime, no DOM)
 *   ✅ New Outlook on Windows       (Mailbox 1.12+, WebView runtime)
 *   ✅ Outlook on Mac (new UI)      (Mailbox 1.10+, WebView runtime)
 *   ✅ Outlook on the Web / OWA     (Mailbox 1.10+, WebView runtime)
 *   ✅ Safari (OWA in Safari)       (same as OWA path above)
 *   ✅ Outlook iOS / Android        (Mailbox 1.10+ mobile, WebView runtime)
 *
 * Events handled:
 *   OnNewMessageCompose   → applySignature       (req set 1.10)
 *   OnMessageSend         → onSendHandler        (req set 1.12, SoftBlock)
 *   OnMessageFromChanged  → onFromChangedHandler (req set 1.13, account switch)
 */

"use strict";

// ─── Module-level constants ───────────────────────────────────────────────────
let CACHED_SIGNATURE_HTML = null;
const SIGNATURE_MARKER = "<!-- CARDBYTE_SIGNATURE -->";
const AES_KEY = "fnItrY2YfozBqCC2B4XsfqHIvZku3kUOq3DFkbO64kk=";
const AES_IV = "3YapeNfJDung7TXxeKXn4g==";

// ─── Session-based cache buster ───────────────────────────────────────────────
const SESSION_KEY = "cardbyte_session_id";
const CACHE_KEY = "cardbyte_cached_signature";
const CACHE_SESSION_KEY = "cardbyte_cached_signature_session";
const CACHE_TIMESTAMP_KEY = "cardbyte_cached_signature_ts";
const CACHE_TTL_MS = 5 * 60 * 1000;   // 5 minutes

// ─── State-based enforcement ──────────────────────────────────────────────────
let _sigManager = null;

// ─── Safe storage wrapper ─────────────────────────────────────────────────────
// Classic Outlook's JS-only runtime has no localStorage / sessionStorage.
// Falls back to an in-memory store transparently on all platforms.
const _memStore = {};
const safeStorage = {
    getItem(key) {
        try { return localStorage.getItem(key); }
        catch (e) { return Object.prototype.hasOwnProperty.call(_memStore, key) ? _memStore[key] : null; }
    },
    setItem(key, val) {
        try { localStorage.setItem(key, val); }
        catch (e) { _memStore[key] = val; }
    },
    removeItem(key) {
        try { localStorage.removeItem(key); }
        catch (e) { delete _memStore[key]; }
    }
};

const _sessionMemStore = {};
const safeSessionStorage = {
    getItem(key) {
        try { return sessionStorage.getItem(key); }
        catch (e) { return Object.prototype.hasOwnProperty.call(_sessionMemStore, key) ? _sessionMemStore[key] : null; }
    },
    setItem(key, val) {
        try { sessionStorage.setItem(key, val); }
        catch (e) { _sessionMemStore[key] = val; }
    }
};

// ─── Image / HTML size limits ─────────────────────────────────────────────────
const MAX_SAFE_HTML_SIZE = 500000;
const MAX_SAFE_HTML_SIZE_MOBILE = 200000;
const MOBILE_MAX_IMAGE_WIDTH = 200;
const MOBILE_IMAGE_QUALITY = 0.5;

// =============================================================================
// Platform Detection
// =============================================================================

/**
 * Returns a normalised platform string.
 *
 *  "desktop"        – Classic Outlook on Windows (JS-only runtime, no DOM)
 *  "new-outlook"    – New Outlook on Windows (WebView runtime)
 *  "mac"            – Outlook on Mac (new UI, WebView runtime)
 *  "owa"            – Outlook on the Web / OWA / Safari
 *  "mobile-ios"     – Outlook on iOS
 *  "mobile-android" – Outlook on Android
 */
function detectPlatform() {
    const ctx = (typeof Office !== "undefined" && Office.context) ? Office.context : null;
    const platform = (ctx && ctx.platform ? ctx.platform : "").toLowerCase();
    const host = (ctx && ctx.diagnostics && ctx.diagnostics.host ? ctx.diagnostics.host : "").toLowerCase();
    const ua = (typeof navigator !== "undefined" && navigator.userAgent ? navigator.userAgent : "").toLowerCase();

    // ── Mobile ──
    if (platform === "ios" || platform === "iphone" || platform === "ipad") return "mobile-ios";
    if (platform === "android") return "mobile-android";
    if (ua.includes("outlookmobile") || ua.includes("outlook-ios") || ua.includes("outlook-android"))
        return ua.includes("android") ? "mobile-android" : "mobile-ios";
    if ((platform === "officeonline" || platform === "web" || platform === "") &&
        (ua.includes("iphone") || ua.includes("ipad") || ua.includes("android")))
        return ua.includes("android") ? "mobile-android" : "mobile-ios";

    // ── Mac ──
    if (platform === "mac") return "mac";
    if ((platform === "" || platform === "desktop") &&
        (ua.includes("macintosh") || ua.includes("mac os x")) &&
        !ua.includes("iphone") && !ua.includes("ipad"))
        return "mac";

    // ── OWA / web / Safari ──
    if (platform === "officeonline" || platform === "web") return "owa";

    // ── New Outlook on Windows ──
    // "new Outlook" reports itself differently: platform may be "" or "desktop"
    // but the host diagnostic contains "newoutlook" or the UA indicates edge/chromium.
    if (host && (host.includes("newoutlook") || host.includes("outlooknew"))) return "new-outlook";
    if (platform === "" && (ua.includes("electron") || ua.includes("edg/"))) return "new-outlook";

    // ── Classic Outlook on Windows (default) ──
    return "desktop";
}

function isMobile() { const p = detectPlatform(); return p === "mobile-ios" || p === "mobile-android"; }
function isOWA() { return detectPlatform() === "owa"; }
function isMac() { return detectPlatform() === "mac"; }
function isNewOutlook() { return detectPlatform() === "new-outlook"; }
function isClassic() { return detectPlatform() === "desktop"; }

/** Returns true for all WebView-based runtimes (i.e. DOM is available). */
function hasDOM() {
    return typeof document !== "undefined" && typeof document.createElement === "function";
}

function getMaxHtmlSize() { return isMobile() ? MAX_SAFE_HTML_SIZE_MOBILE : MAX_SAFE_HTML_SIZE; }

// =============================================================================
// SignatureStateManager
// Owns the canonical HTML for one compose session.
// =============================================================================
class SignatureStateManager {

    constructor(canonicalHtml, signatureId, platform) {
        this._signatureId = signatureId || "cardbyte_sig";
        this._sentinel = `data-cbsig="${this._signatureId}"`;
        this._platform = platform || detectPlatform();
        this._canonicalHtml = this._injectSentinel(canonicalHtml);
        this._enforcing = false;
        this._watcherTimer = null;
        this._visibilityHandler = null;
    }

    _injectSentinel(html) {
        if (!html) return html;
        return html.replace(/(<div\s)(style="mso-element:ps)/, `$1${this._sentinel} $2`);
    }

    _hasDrifted(bodyHtml) {
        if (!bodyHtml) return true;
        return !bodyHtml.includes(this._sentinel);
    }

    async enforce(item) {
        if (this._enforcing) return false;
        this._enforcing = true;
        try {
            const currentBody = await _getBodyHtml(item);
            if (!this._hasDrifted(currentBody)) {
                console.log("[CardByte] Signature intact — no re-injection needed");
                return false;
            }
            console.warn("[CardByte] Signature drift detected — re-enforcing");
            await _setSignatureHtml(item, this._canonicalHtml);
            return true;
        } finally {
            this._enforcing = false;
        }
    }

    /**
     * Starts the drift-prevention watcher.
     *
     * Strategy by platform:
     *   • Classic Windows  → setInterval polling (JS-only runtime, no DOM events)
     *   • OWA / Mac / New  → visibilitychange event (battery-friendly, DOM available)
     *   • Mobile           → no watcher (signature is set once; mobile OS restricts bg timers)
     */
    startWatcher(item, intervalMs = 2500) {
        if (this._watcherTimer || this._visibilityHandler) return;

        const p = this._platform;

        if (p === "mobile-ios" || p === "mobile-android") {
            console.log("[CardByte] Watcher skipped on mobile — single-shot only");
            return;
        }

        if (p === "desktop") {
            // Classic Outlook: JS-only runtime; setInterval works fine
            console.log("[CardByte] Watcher started (Classic Outlook — setInterval)");
            this._watcherTimer = setInterval(() => {
                this.enforce(item).catch(() => { /* item may have closed */ });
            }, intervalMs);
            return;
        }

        // OWA, Mac, New Outlook — use page visibilitychange when DOM is available
        if (hasDOM()) {
            console.log(`[CardByte] Watcher started (${p} — visibilitychange)`);
            this._visibilityHandler = () => {
                if (document.visibilityState === "visible") {
                    this.enforce(item).catch(() => { });
                }
            };
            document.addEventListener("visibilitychange", this._visibilityHandler);
            return;
        }

        // Fallback: polling (should rarely reach here)
        console.log(`[CardByte] Watcher started (${p} — setInterval fallback)`);
        this._watcherTimer = setInterval(() => {
            this.enforce(item).catch(() => { });
        }, intervalMs);
    }

    stopWatcher() {
        if (this._watcherTimer) {
            clearInterval(this._watcherTimer);
            this._watcherTimer = null;
            console.log("[CardByte] Interval watcher stopped");
        }
        if (this._visibilityHandler && hasDOM()) {
            document.removeEventListener("visibilitychange", this._visibilityHandler);
            this._visibilityHandler = null;
            console.log("[CardByte] VisibilityChange watcher stopped");
        }
    }
}

// =============================================================================
// Office.js body read / write helpers
// =============================================================================

function _getBodyHtml(item) {
    return new Promise((resolve, reject) => {
        item.body.getAsync(Office.CoercionType.Html, result => {
            if (result.status === Office.AsyncResultStatus.Succeeded) resolve(result.value || "");
            else reject(result.error);
        });
    });
}

/**
 * Writes the signature HTML.
 *
 * Priority:
 *   1. setSignatureAsync   – Mailbox 1.10+; sets the dedicated signature zone (preferred)
 *   2. prependAsync        – older clients; prepends to body as graceful degradation
 */
function _setSignatureHtml(item, html) {
    return new Promise((resolve, reject) => {
        // ── Primary path: setSignatureAsync (Mailbox 1.10+) ──
        if (typeof item.body.setSignatureAsync === "function") {
            item.body.setSignatureAsync(
                html,
                { coercionType: Office.CoercionType.Html },
                result => {
                    if (result.status === "succeeded" ||
                        result.status === Office.AsyncResultStatus.Succeeded) {
                        console.log("[CardByte] setSignatureAsync succeeded");
                        resolve();
                    } else {
                        console.warn("[CardByte] setSignatureAsync failed:", result.error);
                        // Fall through to prepend fallback
                        _prependSignatureFallback(item, html).then(resolve).catch(reject);
                    }
                }
            );
            return;
        }

        // ── Fallback path: prependAsync (older Classic Outlook / Mailbox < 1.10) ──
        console.warn("[CardByte] setSignatureAsync not available — using prependAsync fallback");
        _prependSignatureFallback(item, html).then(resolve).catch(reject);
    });
}

/**
 * Graceful degradation: prepend signature to the body.
 * Used when setSignatureAsync is unavailable (very old clients).
 */
function _prependSignatureFallback(item, html) {
    return new Promise((resolve, reject) => {
        if (typeof item.body.prependAsync !== "function") {
            reject(new Error("Neither setSignatureAsync nor prependAsync is available"));
            return;
        }
        item.body.prependAsync(html, { coercionType: Office.CoercionType.Html }, result => {
            if (result.status === Office.AsyncResultStatus.Succeeded) {
                console.log("[CardByte] prependAsync fallback succeeded");
                resolve();
            } else {
                reject(result.error);
            }
        });
    });
}

// =============================================================================
// Session / Cache helpers
// =============================================================================

function getOrCreateSessionId() {
    let sid = safeSessionStorage.getItem(SESSION_KEY);
    if (!sid) {
        sid = (typeof crypto !== "undefined" && crypto.randomUUID)
            ? crypto.randomUUID()
            : Date.now().toString(36);
        safeSessionStorage.setItem(SESSION_KEY, sid);
    }
    return sid;
}

function getCachedSignature(opts = {}) {
    const { skipTtl = false, skipSessionCheck = false } = opts;

    if (skipSessionCheck) return safeStorage.getItem(CACHE_KEY);

    const currentSid = getOrCreateSessionId();
    const cachedSid = safeStorage.getItem(CACHE_SESSION_KEY);

    if (cachedSid !== currentSid) {
        console.log("[CardByte] New session detected — clearing cached signature");
        safeStorage.removeItem(CACHE_KEY);
        safeStorage.removeItem(CACHE_SESSION_KEY);
        safeStorage.removeItem(CACHE_TIMESTAMP_KEY);
        return null;
    }

    if (!skipTtl) {
        const ts = parseInt(safeStorage.getItem(CACHE_TIMESTAMP_KEY) || "0", 10);
        if (Date.now() - ts > CACHE_TTL_MS) {
            console.log("[CardByte] Cache TTL expired — clearing");
            safeStorage.removeItem(CACHE_KEY);
            safeStorage.removeItem(CACHE_SESSION_KEY);
            safeStorage.removeItem(CACHE_TIMESTAMP_KEY);
            return null;
        }
    }

    return safeStorage.getItem(CACHE_KEY);
}

function setCachedSignature(html) {
    const currentSid = getOrCreateSessionId();
    try {
        safeStorage.setItem(CACHE_KEY, html);
        safeStorage.setItem(CACHE_SESSION_KEY, currentSid);
        safeStorage.setItem(CACHE_TIMESTAMP_KEY, Date.now().toString());
    } catch (_) { /* storage full or unavailable */ }
}

// =============================================================================
// Crypto helpers
// =============================================================================

function base64ToArrayBuffer(base64) {
    const b64 = base64.replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64.length % 4;
    const padded = pad ? b64 + "=".repeat(4 - pad) : b64;
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
}

function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
}

async function handleAesDecrypt(encryptedText, generatedKey) {
    try {
        if (!encryptedText) return "";
        const keyToUse = generatedKey || AES_KEY;
        let keyBuffer;
        try { keyBuffer = base64ToArrayBuffer(keyToUse); }
        catch (e) { console.error("[CardByte] Failed to decode AES key:", e); return encryptedText; }

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
            console.error("[CardByte] Invalid encrypted data length:", encryptedBuffer.byteLength);
            return encryptedText;
        }

        const decrypted = await crypto.subtle.decrypt({ name: "AES-CBC", iv: ivBuffer }, key, encryptedBuffer);
        return new TextDecoder().decode(decrypted);
    } catch (err) {
        if (generatedKey && generatedKey !== AES_KEY && err.message && err.message.includes("key data")) {
            try { return await handleAesDecrypt(encryptedText, AES_KEY); }
            catch (e) { console.error("[CardByte] Fallback decrypt also failed:", e.message); }
        }
        return encryptedText;
    }
}

async function encryptEmail(email = "") {
    if (!email || email.trim() === "") { console.warn("[CardByte] Empty email for encryption"); return ""; }
    try {
        const keyBuffer = base64ToArrayBuffer(AES_KEY);
        const ivBuffer = base64ToArrayBuffer(AES_IV);
        const key = await crypto.subtle.importKey("raw", keyBuffer, { name: "AES-CBC" }, false, ["encrypt"]);
        const data = new TextEncoder().encode(email);
        const encrypted = await crypto.subtle.encrypt({ name: "AES-CBC", iv: ivBuffer }, key, data);
        return arrayBufferToBase64(encrypted);
    } catch (err) { console.error("[CardByte] Encryption error:", err); return ""; }
}

// =============================================================================
// Server-side signature rendering
// =============================================================================

async function renderSignatureOnServer(user) {
    // Determine X-Platform header: Mac vs Windows
    let xPlatform = "WINDOWS";
    try {
        const diag = Office.context.diagnostics;
        if (diag && diag.platform) {
            xPlatform = (diag.platform === Office.PlatformType.Mac ||
                diag.platform.toString().toLowerCase() === "mac") ? "MAC" : "WINDOWS";
        }
    } catch (_) { /* diagnostics may be unavailable on mobile */ }

    try {
        const encryptedMail = await encryptEmail(user);

        // ── Primary renderer (new API) ──
        const primaryRes = await fetch(
            "https://newqa-enterprise.cardbyte.ai/email-signature/html/outlook/get-active",
            { method: "GET", headers: { username: encryptedMail, "X-Platform": xPlatform } }
        );
        if (primaryRes.ok) {
            const data = await primaryRes.text();
            const decryptedData = await handleAesDecrypt(data);
            const parsed = JSON.parse(decryptedData);
            console.log("[CardByte] Using NEW renderer");
            return (parsed && parsed.html) ? parsed.html : null;
        }
        console.warn("[CardByte] Primary renderer failed. Falling back to legacy...");
    } catch (err) {
        console.warn("[CardByte] Primary renderer crashed. Falling back to legacy...", err);
    }

    // ── Legacy renderer ──
    try {
        const legacyRes = await fetch(
            "https://newqa-renderer.cardbyte.ai/render-signature",
            { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: user }) }
        );
        if (!legacyRes.ok) throw new Error("Legacy renderer returned " + legacyRes.status);
        const legacyData = await legacyRes.json();
        console.log("[CardByte] Using LEGACY renderer");
        return (legacyData && legacyData.finalHtml) ? legacyData.finalHtml : null;
    } catch (legacyError) {
        console.error("[CardByte] Both renderers failed:", legacyError);
        return null;
    }
}

// =============================================================================
// Image compression helpers
// =============================================================================

/**
 * Compress a base64 data URL.
 * Skips silently when the DOM (Canvas API) is unavailable — e.g. Classic Outlook.
 */
function compressBase64Image(dataUrl, maxWidth, quality) {
    if (maxWidth === undefined) maxWidth = isMobile() ? MOBILE_MAX_IMAGE_WIDTH : 300;
    if (quality === undefined) quality = isMobile() ? MOBILE_IMAGE_QUALITY : 0.7;

    return new Promise(resolve => {
        if (!hasDOM()) {
            // Classic Outlook JS-only runtime — no Canvas; skip compression
            resolve(dataUrl);
            return;
        }
        if (dataUrl.startsWith("data:image/gif")) { resolve(dataUrl); return; }

        const img = new Image();
        img.onload = function () {
            try {
                const canvas = document.createElement("canvas");
                let w = img.width, h = img.height;
                if (w > maxWidth) { h = Math.round((h * maxWidth) / w); w = maxWidth; }
                canvas.width = w; canvas.height = h;
                const ctx = canvas.getContext("2d");
                const isPng = dataUrl.startsWith("data:image/png");

                if (isPng) {
                    ctx.clearRect(0, 0, w, h);
                    ctx.drawImage(img, 0, 0, w, h);
                    const r = canvas.toDataURL("image/png");
                    resolve(r.length < dataUrl.length ? r : dataUrl);
                    return;
                }
                ctx.drawImage(img, 0, 0, w, h);
                let r = canvas.toDataURL("image/jpeg", quality);
                if (r.length >= dataUrl.length) r = canvas.toDataURL("image/png");
                resolve(r.length < dataUrl.length ? r : dataUrl);
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
 * Convert an animated GIF to a static PNG (for mobile where GIFs cause size issues).
 * Returns the original dataUrl if conversion is not possible.
 */
function convertGifToStaticPng(dataUrl) {
    return new Promise(resolve => {
        if (!hasDOM()) { resolve(dataUrl); return; }
        const img = new Image();
        img.onload = function () {
            try {
                const canvas = document.createElement("canvas");
                canvas.width = img.width; canvas.height = img.height;
                canvas.getContext("2d").drawImage(img, 0, 0);
                const png = canvas.toDataURL("image/png");
                resolve(png !== "data:," ? png : dataUrl);
            } catch (e) { resolve(dataUrl); }
        };
        img.onerror = () => resolve(dataUrl);
        img.src = dataUrl;
    });
}

async function compressImagesInHtml(html) {
    if (!html) return html;

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
            const staticPng = await convertGifToStaticPng(m.dataUrl);
            if (staticPng !== m.dataUrl) result = result.replace(m.dataUrl, staticPng);
            continue;
        }
        if (isGif) continue;
        const compressed = await compressBase64Image(m.dataUrl);
        if (compressed !== m.dataUrl) result = result.replace(m.dataUrl, compressed);
    }

    // Second pass: if still too large, convert remaining GIFs to PNG
    if (result.length > getMaxHtmlSize()) {
        for (const m of matches) {
            if (!m.dataUrl.startsWith("data:image/gif") || !result.includes(m.dataUrl)) continue;
            const staticPng = await convertGifToStaticPng(m.dataUrl);
            if (staticPng !== m.dataUrl) result = result.replace(m.dataUrl, staticPng);
        }
    }

    return result;
}

// =============================================================================
// Core apply-signature logic
// =============================================================================

async function _applySignatureCore(item, mailbox, opts = {}) {
    const {
        fetchIfMissing = false,
        skipTtl = false,
        skipSessionCheck = false,
        startWatcher = false,
        forceRefresh = false       // set true when From account changes
    } = opts;

    const userProfile = (mailbox && mailbox.userProfile) ? mailbox.userProfile : {};
    const userEmail = userProfile.emailAddress;

    // Clear cache if a hard refresh is requested (e.g. From account changed)
    if (forceRefresh) {
        console.log("[CardByte] Force refresh — clearing cache for new From account");
        safeStorage.removeItem(CACHE_KEY);
        safeStorage.removeItem(CACHE_SESSION_KEY);
        safeStorage.removeItem(CACHE_TIMESTAMP_KEY);
        CACHED_SIGNATURE_HTML = null;
    }

    let fetched = getCachedSignature({ skipTtl, skipSessionCheck });

    if (fetchIfMissing && userEmail && fetched == null) {
        const MAX_RETRIES = 2;
        let attempt = 0, lastError = null;

        while (attempt <= MAX_RETRIES) {
            try {
                if (attempt > 0) {
                    console.warn(`[CardByte] Retrying fetch (attempt ${attempt}/${MAX_RETRIES})...`);
                    await new Promise(r => setTimeout(r, 1000 * attempt));
                }
                const result = await renderSignatureOnServer(userEmail);
                if (result != null) {
                    fetched = result;
                    CACHED_SIGNATURE_HTML = fetched;
                    setCachedSignature(fetched);
                    break;
                }
                lastError = new Error("Server returned null");
            } catch (err) {
                lastError = err;
                console.warn(`[CardByte] Fetch attempt ${attempt + 1} failed:`, err);
            }
            attempt++;
        }

        if (fetched == null) {
            console.error(`[CardByte] All ${MAX_RETRIES + 1} fetch attempts failed. Last:`, lastError);
        }
    }

    // ── Stale-cache fallback ──
    if (!fetched) {
        const stale = getCachedSignature({ skipTtl: true, skipSessionCheck: true });
        if (stale) {
            console.warn("[CardByte] Using stale cached signature as last resort.");
            fetched = stale;
        } else {
            console.warn("[CardByte] No signature available — using identity fallback.");
            fetched =
                `<table cellpadding="0" cellspacing="0" border="0" width="400">` +
                `<tr><td style="font-family:Arial,sans-serif;font-size:12px;">` +
                `<strong>${userProfile.displayName || ""}</strong><br/>` +
                `${userProfile.emailAddress || ""}<br/>` +
                `<span style="color:#999;">Sent via CardByte</span>` +
                `</td></tr></table>`;
        }
    }

    const compressedHtml = await compressImagesInHtml(fetched);
    const wrappedHtml =
        "<div style='margin-top:40px'></div>" +
        compressedHtml +
        "<div style='margin-top:40px'></div>";

    console.log("[CardByte] ════ Applying signature — platform:", detectPlatform());

    // Re-use existing manager if HTML hasn't changed; otherwise create a new one
    if (!_sigManager || _sigManager._canonicalHtml !== wrappedHtml) {
        if (_sigManager) _sigManager.stopWatcher();
        _sigManager = new SignatureStateManager(
            wrappedHtml,
            userEmail || "cardbyte_sig",
            detectPlatform()
        );
    }

    await _sigManager.enforce(item);

    if (startWatcher) {
        _sigManager.startWatcher(item);
    }
}

// =============================================================================
// Event handler — OnNewMessageCompose  (Mailbox req set 1.10)
// Fires on all platforms: Classic Windows, New Outlook, Mac, OWA, Safari, Mobile
// =============================================================================
async function applySignature(event) {
    if (!event) event = { completed() { } };

    const platform = detectPlatform();
    console.log("[CardByte] applySignature fired. Platform:", platform);

    const mailbox = (typeof Office !== "undefined" && Office.context && Office.context.mailbox)
        ? Office.context.mailbox
        : null;
    const item = mailbox ? mailbox.item : null;

    try {
        if (!item) { console.warn("[CardByte] No item — skipping"); return; }
        await _applySignatureCore(item, mailbox, {
            fetchIfMissing: true,
            startWatcher: true,
        });
    } catch (err) {
        console.error("[CardByte] Error in applySignature:", err);
    } finally {
        event.completed();
    }
}

// =============================================================================
// Event handler — OnMessageSend  (Mailbox req set 1.12, SoftBlock)
// Fires on: New Outlook, Classic Windows, Mac, OWA
// Ensures the signature hasn't been stripped before the message leaves.
// =============================================================================
async function onSendHandler(event) {
    if (!event) event = { completed() { } };

    const platform = detectPlatform();
    console.log("[CardByte] onSendHandler fired. Platform:", platform);

    const mailbox = (typeof Office !== "undefined" && Office.context && Office.context.mailbox)
        ? Office.context.mailbox
        : null;
    const item = mailbox ? mailbox.item : null;

    try {
        if (!item) return;
        await _applySignatureCore(item, mailbox, {
            fetchIfMissing: false,    // don't block send on a network round-trip
            skipTtl: true,
            skipSessionCheck: true,
            startWatcher: false,
        });
    } catch (err) {
        console.error("[CardByte] Error in onSendHandler:", err);
    } finally {
        if (_sigManager) _sigManager.stopWatcher();
        // allowEvent: true → SoftBlock allows the send even if we errored
        event.completed({ allowEvent: true });
    }
}

// =============================================================================
// Event handler — OnMessageFromChanged  (Mailbox req set 1.13)
// Fires when the user switches the From account while composing.
// Supported: New Outlook (Windows), Classic Windows, Mac, OWA
// Re-fetches and re-injects the signature for the new sender account.
// =============================================================================
async function onFromChangedHandler(event) {
    if (!event) event = { completed() { } };

    const platform = detectPlatform();
    console.log("[CardByte] onFromChangedHandler fired. Platform:", platform);

    const mailbox = (typeof Office !== "undefined" && Office.context && Office.context.mailbox)
        ? Office.context.mailbox
        : null;
    const item = mailbox ? mailbox.item : null;

    try {
        if (!item) { console.warn("[CardByte] No item — skipping"); return; }

        // Re-read the new From address from the item (available on 1.13 clients)
        let newFromEmail = null;
        if (item.from && typeof item.from.getAsync === "function") {
            newFromEmail = await new Promise(resolve => {
                item.from.getAsync(r => {
                    resolve((r.status === Office.AsyncResultStatus.Succeeded && r.value)
                        ? r.value.emailAddress
                        : null);
                });
            });
        }

        // Patch mailbox userProfile so _applySignatureCore fetches the right sig
        const patchedMailbox = { ...mailbox };
        if (newFromEmail && mailbox.userProfile) {
            patchedMailbox.userProfile = { ...mailbox.userProfile, emailAddress: newFromEmail };
        }

        await _applySignatureCore(item, patchedMailbox, {
            fetchIfMissing: true,
            forceRefresh: true,    // clears cache so we fetch for the new address
            startWatcher: true,
        });
    } catch (err) {
        console.error("[CardByte] Error in onFromChangedHandler:", err);
    } finally {
        event.completed();
    }
}

// =============================================================================
// Office.actions.associate
// Must use named function references (not window.*) — Classic Outlook has no window.
// Associate is called unconditionally; on older clients Office.actions may not exist.
// =============================================================================
if (typeof Office !== "undefined" && typeof Office.actions !== "undefined") {
    Office.actions.associate("applySignature", applySignature);
    console.log("[CardByte] Registered: applySignature");

    Office.actions.associate("onSendHandler", onSendHandler);
    console.log("[CardByte] Registered: onSendHandler");

    Office.actions.associate("onFromChangedHandler", onFromChangedHandler);
    console.log("[CardByte] Registered: onFromChangedHandler");
} else {
    console.log("[CardByte] Office.actions not available — LaunchEvent path not active (expected on Outlook 2016/2019)");
}