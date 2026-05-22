let CACHED_SIGNATURE_HTML = null;
const SIGNATURE_MARKER = "<!-- CARDBYTE_SIGNATURE -->";
const AES_KEY = "fnItrY2YfozBqCC2B4XsfqHIvZku3kUOq3DFkbO64kk=";
const AES_IV = "3YapeNfJDung7TXxeKXn4g==";

// ─── Session-based cache buster ──────────────────────────────────────────────
const SESSION_KEY = "cardbyte_session_id";
const CACHE_KEY = "cardbyte_cached_signature";
const CACHE_SESSION_KEY = "cardbyte_cached_signature_session";
const CACHE_TIMESTAMP_KEY = "cardbyte_cached_signature_ts";
const CACHE_TTL_MS = 5 * 60 * 1000;

// ─── State-based enforcement ──────────────────────────────────────────────────
let _sigManager = null;

// ─── FIX 1: Safe storage wrapper ─────────────────────────────────────────────
// Classic Outlook's JS-only runtime has no localStorage or sessionStorage.
// All calls are wrapped to fall back to an in-memory store transparently.
const _memStore = {};
const safeStorage = {
    getItem: function (key) {
        try { return localStorage.getItem(key); }
        catch (e) { return Object.prototype.hasOwnProperty.call(_memStore, key) ? _memStore[key] : null; }
    },
    setItem: function (key, val) {
        try { localStorage.setItem(key, val); }
        catch (e) { _memStore[key] = val; }
    },
    removeItem: function (key) {
        try { localStorage.removeItem(key); }
        catch (e) { delete _memStore[key]; }
    }
};

const _sessionMemStore = {};
const safeSessionStorage = {
    getItem: function (key) {
        try { return sessionStorage.getItem(key); }
        catch (e) { return Object.prototype.hasOwnProperty.call(_sessionMemStore, key) ? _sessionMemStore[key] : null; }
    },
    setItem: function (key, val) {
        try { sessionStorage.setItem(key, val); }
        catch (e) { _sessionMemStore[key] = val; }
    }
};

/* ============================================================
   SignatureStateManager
   Owns the canonical HTML for one compose session.
============================================================ */
class SignatureStateManager {

    constructor(canonicalHtml, signatureId, platform) {
        this._signatureId = signatureId || "cardbyte_sig";
        this._sentinel = 'data-cbsig="' + this._signatureId + '"';
        this._platform = platform || detectPlatform();
        this._canonicalHtml = this._injectSentinel(canonicalHtml);
        this._enforcing = false;
        this._watcherTimer = null;
    }

    _injectSentinel(html) {
        if (!html) return html;
        return html.replace(
            /(<div\s)(style="mso-element:ps)/,
            "$1" + this._sentinel + " $2"
        );
    }

    _hasDrifted(bodyHtml) {
        if (!bodyHtml) return true;
        return !bodyHtml.includes(this._sentinel);
    }

    async enforce(item) {
        if (this._enforcing) return false;
        this._enforcing = true;
        try {
            var currentBody = await _getBodyHtml(item);
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

    startWatcher(item, intervalMs) {
        if (intervalMs === undefined) intervalMs = 2500;
        if (this._watcherTimer) return;
        var p = this._platform;
        if (p !== "desktop") {
            console.log("[CardByte] Watcher skipped on platform: " + p);
            return;
        }
        console.log("[CardByte] Watcher started (Classic Outlook desktop)");
        var self = this;
        this._watcherTimer = setInterval(function () {
            self.enforce(item).catch(function () {
                // Item may have closed — caller will stopWatcher()
            });
        }, intervalMs);
    }

    stopWatcher() {
        if (this._watcherTimer) {
            clearInterval(this._watcherTimer);
            this._watcherTimer = null;
            console.log("[CardByte] Watcher stopped");
        }
    }
}

// ─── Office.js body read/write helpers ───────────────────────────────────────

function _getBodyHtml(item) {
    return new Promise(function (resolve, reject) {
        item.body.getAsync(Office.CoercionType.Html, function (result) {
            if (result.status === Office.AsyncResultStatus.Succeeded) {
                resolve(result.value || "");
            } else {
                reject(result.error);
            }
        });
    });
}

function _setSignatureHtml(item, html) {
    return new Promise(function (resolve, reject) {
        if (typeof item.body.setSignatureAsync !== "function") {
            reject(new Error("setSignatureAsync not available"));
            return;
        }
        item.body.setSignatureAsync(html, { coercionType: Office.CoercionType.Html }, function (r) {
            if (r.status === "succeeded") resolve();
            else reject(r.error);
        });
    });
}

// ─── FIX 2: sessionStorage replaced with safeSessionStorage ──────────────────

function getOrCreateSessionId() {
    var sid = safeSessionStorage.getItem(SESSION_KEY);
    if (!sid) {
        sid = (typeof crypto !== "undefined" && crypto.randomUUID)
            ? crypto.randomUUID()
            : Date.now().toString(36);
        safeSessionStorage.setItem(SESSION_KEY, sid);
    }
    return sid;
}

// ─── FIX 3: localStorage replaced with safeStorage throughout ────────────────

function getCachedSignature(opts) {
    var skipTtl = opts && opts.skipTtl ? opts.skipTtl : false;
    var skipSessionCheck = opts && opts.skipSessionCheck ? opts.skipSessionCheck : false;

    if (skipSessionCheck) {
        return safeStorage.getItem(CACHE_KEY);
    }
    var currentSid = getOrCreateSessionId();
    var cachedSid = safeStorage.getItem(CACHE_SESSION_KEY);
    if (cachedSid !== currentSid) {
        console.log("[CardByte] New session detected — clearing cached signature");
        safeStorage.removeItem(CACHE_KEY);
        safeStorage.removeItem(CACHE_SESSION_KEY);
        safeStorage.removeItem(CACHE_TIMESTAMP_KEY);
        return null;
    }
    if (!skipTtl) {
        var ts = parseInt(safeStorage.getItem(CACHE_TIMESTAMP_KEY) || "0", 10);
        if (Date.now() - ts > CACHE_TTL_MS) {
            console.log("[CardByte] Cache TTL expired — clearing cached signature");
            safeStorage.removeItem(CACHE_KEY);
            safeStorage.removeItem(CACHE_SESSION_KEY);
            safeStorage.removeItem(CACHE_TIMESTAMP_KEY);
            return null;
        }
    }
    return safeStorage.getItem(CACHE_KEY);
}

function setCachedSignature(html) {
    var currentSid = getOrCreateSessionId();
    try {
        safeStorage.setItem(CACHE_KEY, html);
        safeStorage.setItem(CACHE_SESSION_KEY, currentSid);
        safeStorage.setItem(CACHE_TIMESTAMP_KEY, Date.now().toString());
    } catch (_) { }
}

const MAX_SAFE_HTML_SIZE = 500000;
const MAX_SAFE_HTML_SIZE_MOBILE = 200000;
const MOBILE_MAX_IMAGE_WIDTH = 200;
const MOBILE_IMAGE_QUALITY = 0.5;

function detectPlatform() {
    var platform = (Office && Office.context && Office.context.platform ? Office.context.platform : "").toLowerCase();
    var ua = (typeof navigator !== "undefined" && navigator.userAgent ? navigator.userAgent : "").toLowerCase();
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
        !ua.includes("iphone") && !ua.includes("ipad")
    ) return "mac";
    if (platform === "officeonline" || platform === "web" || platform === "") return "owa";
    return "desktop";
}

function isMobile() { var p = detectPlatform(); return p === "mobile-ios" || p === "mobile-android"; }
function isOWA() { return detectPlatform() === "owa"; }
function isMac() { return detectPlatform() === "mac"; }
function getMaxHtmlSize() { return isMobile() ? MAX_SAFE_HTML_SIZE_MOBILE : MAX_SAFE_HTML_SIZE; }

// ─── FIX 4: Office.onReady() REMOVED ─────────────────────────────────────────
// Classic Outlook's JS-only runtime never fires Office.onReady().
// Platform detection logging is moved into the handlers instead.

function base64ToArrayBuffer(base64) {
    var base64Data = base64.replace(/-/g, "+").replace(/_/g, "/");
    var padding = base64Data.length % 4;
    if (padding) base64Data += "=".repeat(4 - padding);
    var binaryString = atob(base64Data);
    var bytes = new Uint8Array(binaryString.length);
    for (var i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i);
    return bytes.buffer;
}

function arrayBufferToBase64(buffer) {
    var bytes = new Uint8Array(buffer);
    var binaryString = "";
    for (var i = 0; i < bytes.length; i++) binaryString += String.fromCharCode(bytes[i]);
    return btoa(binaryString);
}

async function handleAesDecrypt(encryptedText, generatedKey) {
    try {
        if (!encryptedText) return "";
        var keyToUse = generatedKey || AES_KEY;
        var keyBuffer;
        try { keyBuffer = base64ToArrayBuffer(keyToUse); }
        catch (e) { console.error("Failed to decode key as base64:", e); return encryptedText; }
        if (keyBuffer.byteLength !== 16 && keyBuffer.byteLength !== 32) {
            if (generatedKey && generatedKey !== AES_KEY) return handleAesDecrypt(encryptedText, AES_KEY);
            return encryptedText;
        }
        var ivBuffer = base64ToArrayBuffer(AES_IV);
        if (ivBuffer.byteLength !== 16) return encryptedText;
        var key = await crypto.subtle.importKey("raw", keyBuffer, { name: "AES-CBC" }, false, ["decrypt"]);
        var encryptedBuffer;
        try { encryptedBuffer = base64ToArrayBuffer(encryptedText); }
        catch (e) { return encryptedText; }
        if (encryptedBuffer.byteLength % 16 !== 0) {
            console.error("Invalid encrypted data length: " + encryptedBuffer.byteLength + " bytes");
            return encryptedText;
        }
        var decryptedBuffer = await crypto.subtle.decrypt({ name: "AES-CBC", iv: ivBuffer }, key, encryptedBuffer);
        return new TextDecoder().decode(decryptedBuffer);
    } catch (err) {
        if (generatedKey && generatedKey !== AES_KEY && err.message && err.message.includes("key data")) {
            try { return await handleAesDecrypt(encryptedText, AES_KEY); }
            catch (e) { console.error("Fallback also failed:", e.message); }
        }
        return encryptedText;
    }
}

async function encryptEmail(email) {
    if (email === undefined) email = "";
    try {
        if (!email || email.trim() === "") { console.warn("Warning: Empty email provided"); return ""; }
        var keyBuffer = base64ToArrayBuffer(AES_KEY);
        var ivBuffer = base64ToArrayBuffer(AES_IV);
        if (keyBuffer.byteLength !== 16 && keyBuffer.byteLength !== 32) { console.error("Invalid key length: " + keyBuffer.byteLength + " bytes"); return ""; }
        if (ivBuffer.byteLength !== 16) { console.error("Invalid IV length: " + ivBuffer.byteLength + " bytes"); return ""; }
        var key = await crypto.subtle.importKey("raw", keyBuffer, { name: "AES-CBC" }, false, ["encrypt"]);
        var data = new TextEncoder().encode(email);
        var encrypted = await crypto.subtle.encrypt({ name: "AES-CBC", iv: ivBuffer }, key, data);
        var base64Result = arrayBufferToBase64(encrypted);
        try { atob(base64Result); } catch (e) { console.error("Result is NOT valid base64:", e); }
        return base64Result;
    } catch (err) { console.error("Encryption error:", err); return ""; }
}

async function renderSignatureOnServer(user) {
    var platform = Office.context.diagnostics.platform;
    var xPlatform = platform === Office.PlatformType.Mac ? "MAC" : "WINDOWS";
    try {
        var encryptedMail = await encryptEmail(user);
        var primaryRes = await fetch(
            "https://newqa-enterprise.cardbyte.ai/email-signature/html/outlook/get-active",
            { method: "GET", headers: { username: encryptedMail, "X-Platform": xPlatform } }
        );
        if (primaryRes.ok) {
            var data = await primaryRes.text();
            var decryptedData = await handleAesDecrypt(data);
            console.log("Using NEW renderer");
            return JSON.parse(decryptedData) && JSON.parse(decryptedData).html ? JSON.parse(decryptedData).html : null;
        }
        console.warn("Primary failed. Falling back to legacy...");
    } catch (err) {
        console.warn("Primary crashed. Falling back to legacy...", err);
    }
    try {
        var legacyRes = await fetch(
            "https://newqa-renderer.cardbyte.ai/render-signature",
            { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: user }) }
        );
        if (!legacyRes.ok) throw new Error("Legacy renderer failed");
        var legacyData = await legacyRes.json();
        console.log("Using LEGACY renderer", legacyData);
        return legacyData && legacyData.finalHtml ? legacyData.finalHtml : null;
    } catch (legacyError) {
        console.error("Both primary and legacy failed:", legacyError);
        return null;
    }
}

// ─── FIX 5: Canvas/DOM guard for Classic Outlook JS runtime ──────────────────
// Classic Outlook has no document/DOM. Skip compression if unavailable.
function compressBase64Image(dataUrl, maxWidth, quality) {
    if (maxWidth === undefined) maxWidth = isMobile() ? MOBILE_MAX_IMAGE_WIDTH : 300;
    if (quality === undefined) quality = isMobile() ? MOBILE_IMAGE_QUALITY : 0.7;
    return new Promise(function (resolve) {
        // Guard: no DOM in Classic Outlook JS runtime
        if (typeof document === "undefined" || typeof document.createElement !== "function") {
            console.log("[CardByte] Skipping image compression — no DOM (Classic Outlook)");
            resolve(dataUrl);
            return;
        }
        if (dataUrl.startsWith("data:image/gif")) { resolve(dataUrl); return; }
        var img = new Image();
        img.onload = function () {
            try {
                var canvas = document.createElement("canvas");
                var width = img.width, height = img.height;
                if (width > maxWidth) { height = Math.round((height * maxWidth) / width); width = maxWidth; }
                canvas.width = width; canvas.height = height;
                var ctx = canvas.getContext("2d");
                var isPng = dataUrl.startsWith("data:image/png");
                if (isPng) {
                    ctx.clearRect(0, 0, width, height);
                    ctx.drawImage(img, 0, 0, width, height);
                    var result = canvas.toDataURL("image/png");
                    if (result.length >= dataUrl.length) { resolve(dataUrl); return; }
                    resolve(result); return;
                }
                ctx.drawImage(img, 0, 0, width, height);
                var result = canvas.toDataURL("image/jpeg", quality);
                if (result.length >= dataUrl.length) result = canvas.toDataURL("image/png");
                if (result.length >= dataUrl.length) { resolve(dataUrl); return; }
                resolve(result);
            } catch (e) { console.warn("[CardByte] Canvas compression failed:", e); resolve(dataUrl); }
        };
        img.onerror = function () { resolve(dataUrl); };
        img.src = dataUrl;
    });
}

async function compressImagesInHtml(html) {
    if (!html) return html;
    var regex = /src\s*=\s*"(data:image\/[^;]+;base64,[^"]+)"/gi;
    var matches = [];
    var match;
    while ((match = regex.exec(html)) !== null) {
        matches.push({ fullMatch: match[0], dataUrl: match[1] });
    }
    if (matches.length === 0) return html;
    var mobile = isMobile();
    console.log("[CardByte] Compressing " + matches.length + " base64 image(s) (mobile: " + mobile + ")");
    var result = html;
    for (var i = 0; i < matches.length; i++) {
        var m = matches[i];
        if (!result.includes(m.dataUrl)) continue;
        var isGif = m.dataUrl.startsWith("data:image/gif");
        if (isGif && mobile) {
            var staticPng = await convertGifToStaticPng(m.dataUrl);
            if (staticPng !== m.dataUrl) result = result.replace(m.dataUrl, staticPng);
            continue;
        }
        if (isGif) continue;
        var compressed = await compressBase64Image(m.dataUrl);
        if (compressed !== m.dataUrl) result = result.replace(m.dataUrl, compressed);
    }
    var maxSize = getMaxHtmlSize();
    if (result.length > maxSize) {
        for (var j = 0; j < matches.length; j++) {
            var m2 = matches[j];
            if (!m2.dataUrl.startsWith("data:image/gif") || !result.includes(m2.dataUrl)) continue;
            var staticPng2 = await convertGifToStaticPng(m2.dataUrl);
            if (staticPng2 !== m2.dataUrl) result = result.replace(m2.dataUrl, staticPng2);
        }
    }
    return result;
}

function extractBase64Images(html) {
    var images = [];
    var index = 0;
    var cleanedHtml = html.replace(
        /src\s*=\s*"data:(image\/([^;]+));base64,([^"]+)"/gi,
        function (_match, mimeType, extension, base64Data) {
            var cid = "cardbyte_img_" + index;
            var safeExt = extension.replace(/[^a-z0-9]/gi, "") || "png";
            var fileName = cid + "." + safeExt;
            images.push({ cid: cid, fileName: fileName, mimeType: mimeType, base64Data: base64Data });
            index++;
            return 'src="cid:' + cid + '"';
        }
    );
    return { cleanedHtml: cleanedHtml, images: images };
}

function addInlineImageAttachment(item, opts) {
    var cid = opts.cid, fileName = opts.fileName, base64Data = opts.base64Data;
    return new Promise(function (resolve, reject) {
        if (typeof item.addFileAttachmentFromBase64Async !== "function") {
            console.warn("[CardByte] addFileAttachmentFromBase64Async not available");
            resolve(false); return;
        }
        item.addFileAttachmentFromBase64Async(
            base64Data, fileName, { isInline: true, contentId: cid },
            function (result) {
                if (result.status === Office.AsyncResultStatus.Succeeded) resolve(true);
                else { console.error("[CardByte] Attach failed " + cid + ":", result.error); reject(result.error); }
            }
        );
    });
}

function moveCursorToTop(item) {
    return new Promise(function (resolve) {
        try {
            if (typeof item.body.prependAsync !== "function") { resolve(); return; }
            item.body.prependAsync("", { coercionType: Office.CoercionType.Text }, function () {
                if (typeof item.body.setSelectedDataAsync !== "function") { resolve(); return; }
                item.body.setSelectedDataAsync("", { coercionType: Office.CoercionType.Text }, function () { resolve(); });
            });
        } catch (e) { resolve(); }
    });
}

async function _applySignatureCore(item, mailbox, opts) {
    var fetchIfMissing = opts && opts.fetchIfMissing ? opts.fetchIfMissing : false;
    var skipTtl = opts && opts.skipTtl ? opts.skipTtl : false;
    var skipSessionCheck = opts && opts.skipSessionCheck ? opts.skipSessionCheck : false;
    var startWatcher = opts && opts.startWatcher ? opts.startWatcher : false;

    var userProfile = (mailbox && mailbox.userProfile) ? mailbox.userProfile : {};
    var userEmail = userProfile.emailAddress;

    var fetched = getCachedSignature({ skipTtl: skipTtl, skipSessionCheck: skipSessionCheck });

    if (fetchIfMissing && userEmail && fetched == null) {
        var MAX_RETRIES = 2;
        var attempt = 0;
        var lastError = null;
        while (attempt <= MAX_RETRIES) {
            try {
                if (attempt > 0) {
                    console.warn("[CardByte] Retrying signature fetch (attempt " + attempt + "/" + MAX_RETRIES + ")...");
                    await new Promise(function (r) { setTimeout(r, 1000 * attempt); });
                }
                var result = await renderSignatureOnServer(userEmail);
                if (result != null) {
                    fetched = result;
                    CACHED_SIGNATURE_HTML = fetched;
                    setCachedSignature(fetched);
                    break;
                }
                lastError = new Error("Server returned null");
            } catch (err) {
                lastError = err;
                console.warn("[CardByte] Fetch attempt " + (attempt + 1) + " failed:", err);
            }
            attempt++;
        }
        if (fetched == null) {
            console.error("[CardByte] All " + (MAX_RETRIES + 1) + " fetch attempts failed. Last error:", lastError);
        }
    }

    if (!fetched) {
        var staleCache = getCachedSignature({ skipTtl: true, skipSessionCheck: true });
        if (staleCache) {
            console.warn("[CardByte] Using stale cached signature as last resort.");
            fetched = staleCache;
        } else {
            console.warn("[CardByte] No signature available — using fallback identity signature.");
            fetched = '<table cellpadding="0" cellspacing="0" border="0" width="400">'
                + '<tr><td style="font-family:Arial,sans-serif;font-size:12px;">'
                + '<strong>' + (userProfile.displayName || "") + '</strong><br/>'
                + (userProfile.emailAddress || "") + '<br/>'
                + '<span style="color:#999;">Sent via CardByte</span>'
                + '</td></tr></table>';
        }
    }

    var compressedHtml = await compressImagesInHtml(fetched);
    var wrappedHtml = "<div style='margin-top:40px'></div>"
        + compressedHtml
        + "<div style='margin-top:40px'></div>";

    console.log("[CardByte] ════════════════════════════════════",
        fetched ? "Applying signature (state-based)" : "No cached signature, will fetch from server"
    );

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

/* ============================================================
   FIX 6: Named function declarations instead of window.*
   Classic Outlook has no window object. Functions must be
   declared as named functions so Office.actions.associate
   can reference them by name.
============================================================ */
async function applySignature(event) {
    if (!event) event = { completed: function () { } };
    // Log platform here since Office.onReady() is removed
    console.log("[CardByte] applySignature fired. Platform: " + detectPlatform());
    var mailbox = Office && Office.context && Office.context.mailbox ? Office.context.mailbox : null;
    var item = mailbox ? mailbox.item : null;
    try {
        if (!item) return;
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

async function onSendHandler(event) {
    if (!event) event = { completed: function () { } };
    var mailbox = Office && Office.context && Office.context.mailbox ? Office.context.mailbox : null;
    var item = mailbox ? mailbox.item : null;
    try {
        if (!item) return;
        await _applySignatureCore(item, mailbox, {
            fetchIfMissing: false,
            skipTtl: true,
            skipSessionCheck: true,
            startWatcher: false,
        });
    } catch (err) {
        console.error("[CardByte] Error in onSendHandler:", err);
    } finally {
        if (_sigManager) _sigManager.stopWatcher();
        event.completed({ allowEvent: true });
    }
}

// ─── Office action registration ───────────────────────────────────────────────
// Both functions are named declarations above, so they are defined here
// regardless of whether window exists (Classic Outlook has no window).
if (typeof Office !== "undefined" && typeof Office.actions !== "undefined") {
    Office.actions.associate("applySignature", applySignature);
    console.log("[CardByte] Office.actions.associate registered: applySignature");
    Office.actions.associate("onSendHandler", onSendHandler);
    console.log("[CardByte] Office.actions.associate registered: onSendHandler");
} else {
    console.log("[CardByte] Office.actions not available — LaunchEvent path not active (expected on 2016/2019)");
}
