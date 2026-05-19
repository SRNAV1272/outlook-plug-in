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
// One manager per compose session. Lives from item open → item close / send.
// Replaces the "inject once and hope" pattern with validate → diff → patch.
let _sigManager = null;

/* ============================================================
   SignatureStateManager
   Owns the canonical HTML for one compose session.
   Callers never call bodySetSignatureAsync directly — they
   call _sigManager.enforce(item) and the manager decides
   whether re-injection is actually needed.
============================================================ */
class SignatureStateManager {

    constructor(canonicalHtml, signatureId, platform) {
        // Sentinel: a short unique string embedded in the wrapper div.
        // Survives Outlook's Word-engine re-serializer because the engine
        // only touches <p>/<span> font attributes — it ignores data-*
        // attributes on <div> elements it doesn't own.
        this._signatureId = signatureId || "cardbyte_sig";
        this._sentinel = `data-cbsig="${this._signatureId}"`;
        this._platform = platform || detectPlatform();

        // Inject the sentinel into the outermost wrapper div once,
        // then treat canonicalHtml as immutable for this session.
        this._canonicalHtml = this._injectSentinel(canonicalHtml);

        this._enforcing = false;   // re-entrancy guard
        this._watcherTimer = null;
    }

    // ── Sentinel injection ────────────────────────────────────────────────────
    _injectSentinel(html) {
        // The wrapper div from exportToHTML always starts with:
        //   <div style="mso-element:ps;...
        // Insert our data attribute right before the style attribute.
        if (!html) return html;
        return html.replace(
            /(<div\s)(style="mso-element:ps)/,
            `$1${this._sentinel} $2`
        );
    }

    // ── Drift detection ───────────────────────────────────────────────────────
    // Fast O(n) string scan — no DOM parse needed.
    // Returns true if the body no longer contains our signature at all,
    // OR if it contains only a stale sentinel (different signatureId).
    _hasDrifted(bodyHtml) {
        if (!bodyHtml) return true;
        return !bodyHtml.includes(this._sentinel);
    }

    // ── Core enforce ──────────────────────────────────────────────────────────
    // The single method that replaces all direct bodySetSignatureAsync calls.
    // Returns true if re-injection was performed.
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

    // ── Watcher ───────────────────────────────────────────────────────────────
    // Polls the body on Classic Outlook desktop where onBodyChanged events
    // are unreliable. Mac/OWA don't need this — Office.js events are stable.
    startWatcher(item, intervalMs = 2500) {
        if (this._watcherTimer) return;
        const p = this._platform;
        // Only poll on Classic desktop. Mac/OWA have reliable event hooks.
        if (p !== "desktop") {
            console.log(`[CardByte] Watcher skipped on platform: ${p}`);
            return;
        }
        console.log("[CardByte] Watcher started (Classic Outlook desktop)");
        this._watcherTimer = setInterval(async () => {
            try {
                await this.enforce(item);
            } catch (e) {
                // Item may have closed — caller will stopWatcher()
            }
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

// ─── Office.js body read/write helpers ────────────────────────────────────────
// Centralised so SignatureStateManager and _applySignatureCore
// both use the exact same read/write path.

function _getBodyHtml(item) {
    return new Promise((resolve, reject) => {
        item.body.getAsync(Office.CoercionType.Html, (result) => {
            if (result.status === Office.AsyncResultStatus.Succeeded) {
                resolve(result.value || "");
            } else {
                reject(result.error);
            }
        });
    });
}

// Wraps bodySetSignatureAsync (preferred) with no fallback needed here —
// _applySignatureCore already ensures we have a valid HTML string before
// this is called. setSignatureAsync is the correct API for compose events;
// it places the signature in Outlook's designated signature slot rather than
// appending to the body buffer, which gives us automatic reply-chain safety.
function _setSignatureHtml(item, html) {
    return new Promise((resolve, reject) => {
        if (typeof item.body.setSignatureAsync !== "function") {
            reject(new Error("setSignatureAsync not available"));
            return;
        }
        item.body.setSignatureAsync(html, { coercionType: Office.CoercionType.Html }, (r) => {
            if (r.status === "succeeded") resolve();
            else reject(r.error);
        });
    });
}

// ─── Everything below is unchanged from your original ────────────────────────

function getOrCreateSessionId() {
    let sid = sessionStorage.getItem(SESSION_KEY);
    if (!sid) {
        sid = crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36);
        sessionStorage.setItem(SESSION_KEY, sid);
    }
    return sid;
}

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
        !ua.includes("iphone") && !ua.includes("ipad")
    ) return "mac";
    if (platform === "officeonline" || platform === "web" || platform === "") return "owa";
    return "desktop";
}

function isMobile() { const p = detectPlatform(); return p === "mobile-ios" || p === "mobile-android"; }
function isOWA() { return detectPlatform() === "owa"; }
function isMac() { return detectPlatform() === "mac"; }
function getMaxHtmlSize() { return isMobile() ? MAX_SAFE_HTML_SIZE_MOBILE : MAX_SAFE_HTML_SIZE; }

Office.onReady(() => {
    console.log("✅ Office.onReady is Started !");
    console.log(`[CardByte] Platform detected: ${detectPlatform()}`);
});

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
    } catch (err) { console.error("Encryption error:", err); return ""; }
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

function compressBase64Image(dataUrl, maxWidth, quality) {
    if (maxWidth === undefined) maxWidth = isMobile() ? MOBILE_MAX_IMAGE_WIDTH : 300;
    if (quality === undefined) quality = isMobile() ? MOBILE_IMAGE_QUALITY : 0.7;
    return new Promise((resolve) => {
        if (dataUrl.startsWith("data:image/gif")) { resolve(dataUrl); return; }
        const img = new Image();
        img.onload = () => {
            try {
                const canvas = document.createElement("canvas");
                let width = img.width, height = img.height;
                if (width > maxWidth) { height = Math.round((height * maxWidth) / width); width = maxWidth; }
                canvas.width = width; canvas.height = height;
                const ctx = canvas.getContext("2d");
                const isPng = dataUrl.startsWith("data:image/png");
                if (isPng) {
                    ctx.clearRect(0, 0, width, height);
                    ctx.drawImage(img, 0, 0, width, height);
                    let result = canvas.toDataURL("image/png");
                    if (result.length >= dataUrl.length) { resolve(dataUrl); return; }
                    resolve(result); return;
                }
                ctx.drawImage(img, 0, 0, width, height);
                let result = canvas.toDataURL("image/jpeg", quality);
                if (result.length >= dataUrl.length) result = canvas.toDataURL("image/png");
                if (result.length >= dataUrl.length) { resolve(dataUrl); return; }
                resolve(result);
            } catch (e) { console.warn("[CardByte] Canvas compression failed:", e); resolve(dataUrl); }
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
    const maxSize = getMaxHtmlSize();
    if (result.length > maxSize) {
        for (const m of matches) {
            if (!m.dataUrl.startsWith("data:image/gif") || !result.includes(m.dataUrl)) continue;
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

/* ============================================================
   _applySignatureCore — MODIFIED
   
   The key change: after resolving the HTML (from cache, server,
   stale cache, or fallback), we no longer call bodySetSignatureAsync
   directly. Instead we:
     1. Build a SignatureStateManager with the canonical HTML.
     2. Call manager.enforce(item) — which validates first and only
        injects if drift is detected.
     3. Store the manager in _sigManager for the watcher and
        onSendHandler to reuse.
   
   Everything before this point (fetching, retries, compression,
   fallback) is identical to your original.
============================================================ */
async function _applySignatureCore(item, mailbox, {
    fetchIfMissing = false,
    skipTtl = false,
    skipSessionCheck = false,
    startWatcher = false,       // NEW: compose path passes true; send path passes false
} = {}) {
    const userProfile = mailbox?.userProfile || {};
    const userEmail = userProfile?.emailAddress;

    let fetched = getCachedSignature({ skipTtl, skipSessionCheck });

    if (fetchIfMissing && userEmail && fetched == null) {
        const MAX_RETRIES = 2;
        let attempt = 0;
        let lastError = null;
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
            console.error(`[CardByte] All ${MAX_RETRIES + 1} fetch attempts failed. Last error:`, lastError);
        }
    }

    if (!fetched) {
        const staleCache = getCachedSignature({ skipTtl: true, skipSessionCheck: true });
        if (staleCache) {
            console.warn("[CardByte] Using stale cached signature as last resort.");
            fetched = staleCache;
        } else {
            console.warn("[CardByte] No signature available — using fallback identity signature.");
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

    // Compress images before building canonical state —
    // compression is a one-time cost, canonical HTML stays small.
    const compressedHtml = await compressImagesInHtml(fetched);
    const wrappedHtml = "<div style='margin-top:40px'></div>"
        + compressedHtml
        + "<div style='margin-top:40px'></div>";

    console.log("[CardByte] ════════════════════════════════════",
        fetched ? "Applying signature (state-based)" : "No cached signature, will fetch from server"
    );

    // ── State-based enforcement ───────────────────────────────────────────────
    // If a manager already exists (e.g. onSendHandler reusing compose session
    // state), reuse it — it already has the sentinel injected and watcher running.
    // If not (onSendHandler in a fresh iframe, or compose first load), build one.
    if (!_sigManager || _sigManager._canonicalHtml !== wrappedHtml) {
        // Stop any existing watcher before replacing the manager
        _sigManager?.stopWatcher();
        _sigManager = new SignatureStateManager(
            wrappedHtml,
            userEmail || "cardbyte_sig",   // signatureId — stable per user
            detectPlatform()
        );
    }

    await _sigManager.enforce(item);

    // Watcher is only started from the compose path (applySignature),
    // not from onSendHandler (which fires once just before send).
    if (startWatcher) {
        _sigManager.startWatcher(item);
    }
}

/* ============================================================
   Public handlers — only option flag differences from original
============================================================ */
window.applySignature = async function (event = { completed: () => { } }, options = {}) {
    const mailbox = Office?.context?.mailbox;
    const item = mailbox?.item;
    try {
        if (!item) return;
        await _applySignatureCore(item, mailbox, {
            fetchIfMissing: true,
            startWatcher: true,     // compose path: start the drift watcher
        });
    } catch (err) {
        console.error("[CardByte] Error in applySignature:", err);
    } finally {
        event.completed();
    }
};

window.onSendHandler = async function (event = { completed: () => { } }) {
    const mailbox = Office?.context?.mailbox;
    const item = mailbox?.item;
    try {
        if (!item) return;
        await _applySignatureCore(item, mailbox, {
            fetchIfMissing: false,
            skipTtl: true,
            skipSessionCheck: true, // separate iframe — session ID won't match
            startWatcher: false,    // send path: no watcher, just enforce once
        });
    } catch (err) {
        console.error("[CardByte] Error in onSendHandler:", err);
    } finally {
        // Always stop the watcher on send — compose session is ending.
        _sigManager?.stopWatcher();
        event.completed({ allowEvent: true });
    }
};

// ─── Office action registration (unchanged) ───────────────────────────────────
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