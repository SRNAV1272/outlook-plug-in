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

// ─── In-memory signature store (set at compose time, read at send time) ───────
let COMPOSE_TIME_SIGNATURE = null;

// ─── Timing logger ────────────────────────────────────────────────────────────
function logTiming(label, startMs) {
    const elapsed = Date.now() - startMs;
    console.log(`[CardByte] ⏱ ${label}: ${elapsed}ms`);
}

function getOrCreateSessionId() {
    let sid = sessionStorage.getItem(SESSION_KEY);
    if (!sid) {
        sid = crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36);
        sessionStorage.setItem(SESSION_KEY, sid);
    }
    return sid;
}

function getCachedSignature({ skipTtl = false, skipSessionCheck = false } = {}) {
    const t0 = Date.now();

    if (skipSessionCheck) {
        const val = localStorage.getItem(CACHE_KEY);
        logTiming("getCachedSignature (skipSessionCheck)", t0);
        return val;
    }

    const currentSid = getOrCreateSessionId();
    const cachedSid = localStorage.getItem(CACHE_SESSION_KEY);

    if (cachedSid !== currentSid) {
        console.log("[CardByte] New session detected — clearing cached signature");
        localStorage.removeItem(CACHE_KEY);
        localStorage.removeItem(CACHE_SESSION_KEY);
        localStorage.removeItem(CACHE_TIMESTAMP_KEY);
        logTiming("getCachedSignature (session mismatch — cleared)", t0);
        return null;
    }

    if (!skipTtl) {
        const ts = parseInt(localStorage.getItem(CACHE_TIMESTAMP_KEY) || "0", 10);
        if (Date.now() - ts > CACHE_TTL_MS) {
            console.log("[CardByte] Cache TTL expired — clearing cached signature");
            localStorage.removeItem(CACHE_KEY);
            localStorage.removeItem(CACHE_SESSION_KEY);
            localStorage.removeItem(CACHE_TIMESTAMP_KEY);
            logTiming("getCachedSignature (TTL expired — cleared)", t0);
            return null;
        }
    }

    const val = localStorage.getItem(CACHE_KEY);
    logTiming("getCachedSignature (hit)", t0);
    return val;
}

function setCachedSignature(html) {
    const t0 = Date.now();
    const currentSid = getOrCreateSessionId();
    try {
        localStorage.setItem(CACHE_KEY, html);
        localStorage.setItem(CACHE_SESSION_KEY, currentSid);
        localStorage.setItem(CACHE_TIMESTAMP_KEY, Date.now().toString());
        logTiming("setCachedSignature", t0);
    } catch (_) {
        logTiming("setCachedSignature (failed — likely quota)", t0);
    }
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
    } catch (err) {
        console.error("Encryption error:", err);
        return "";
    }
}

async function renderSignatureOnServer(user) {
    const t0 = Date.now();
    const platform = Office.context.diagnostics.platform;
    const xPlatform = platform === Office.PlatformType.Mac ? "MAC" : "WINDOWS";

    try {
        const encryptedMail = await encryptEmail(user);
        console.log(`[CardByte] 🌐 API call started — primary renderer`);
        const primaryRes = await fetch(
            "https://ns-enterprise.cardbyte.ai/email-signature/html/outlook/get-active",
            { method: "GET", headers: { username: encryptedMail, "X-Platform": xPlatform } }
        );
        if (primaryRes.ok) {
            const data = await primaryRes.text();
            const decryptedData = await handleAesDecrypt(data);
            logTiming("API call — primary renderer (success)", t0);
            console.log("[CardByte] Using NEW renderer");
            return JSON.parse(decryptedData)?.html || null;
        }
        logTiming("API call — primary renderer (non-ok response)", t0);
        console.warn("Primary failed. Falling back to legacy...");
    } catch (err) {
        logTiming("API call — primary renderer (crashed)", t0);
        console.warn("Primary crashed. Falling back to legacy...", err);
    }

    try {
        const t1 = Date.now();
        console.log(`[CardByte] 🌐 API call started — legacy renderer`);
        const legacyRes = await fetch(
            "https://enterprise.cardbyte.ai/render-signature",
            { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: user }) }
        );
        if (!legacyRes.ok) throw new Error("Legacy renderer failed");
        const legacyData = await legacyRes.json();
        logTiming("API call — legacy renderer (success)", t1);
        console.log("[CardByte] Using LEGACY renderer", legacyData);
        return legacyData?.finalHtml || null;
    } catch (legacyError) {
        console.error("Both primary and legacy failed:", legacyError);
        return null;
    }
}

// ─── Timeout wrapper ──────────────────────────────────────────────────────────
function withTimeout(promise, ms) {
    return Promise.race([
        promise,
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms)
        )
    ]);
}

function getBodyText(item) {
    return new Promise((resolve) => {
        item.body.getAsync(Office.CoercionType.Html, (result) => {
            if (result.status === "succeeded") resolve(result.value || "");
            else resolve("");
        });
    });
}

const SIGNATURE_SENTINEL = "cardbyte-sig";

function bodySetSignatureAsync(item, html) {
    return new Promise((resolve, reject) => {
        if (typeof item.body.setSignatureAsync !== "function") {
            reject(new Error("setSignatureAsync not available"));
            return;
        }
        const t0 = Date.now();
        item.body.setSignatureAsync(html, { coercionType: Office.CoercionType.Html }, (r) => {
            logTiming("setSignatureAsync", t0);
            if (r.status === "succeeded") resolve();
            else reject(r.error);
        });
    });
}

// ─── Compose-time: fetch → store in memory + cache → apply ───────────────────
async function _applySignatureCore(item, mailbox) {
    const userProfile = mailbox?.userProfile || {};
    const userEmail = userProfile?.emailAddress;

    // 1. Try in-memory first (fastest — same JS context)
    let signature = COMPOSE_TIME_SIGNATURE;
    if (signature) {
        console.log("[CardByte] ✅ Compose: using in-memory COMPOSE_TIME_SIGNATURE");
    }

    // 2. Try session cache
    if (!signature) {
        const t0 = Date.now();
        signature = getCachedSignature();          // logTiming inside getCachedSignature
        if (signature) {
            console.log("[CardByte] ✅ Compose: cache hit");
            COMPOSE_TIME_SIGNATURE = signature;   // warm the in-memory store
        }
    }

    // 3. Fetch from server (with retries)
    if (!signature && userEmail) {
        const MAX_RETRIES = 2;
        let attempt = 0;
        let lastError = null;

        while (attempt <= MAX_RETRIES) {
            try {
                if (attempt > 0) {
                    console.warn(`[CardByte] Retrying signature fetch (attempt ${attempt}/${MAX_RETRIES})...`);
                    await new Promise(r => setTimeout(r, 1000 * attempt));
                }
                const result = await renderSignatureOnServer(userEmail); // timing inside
                if (result != null) {
                    signature = result;
                    break;
                }
                lastError = new Error("Server returned null");
            } catch (err) {
                lastError = err;
                console.warn(`[CardByte] Fetch attempt ${attempt + 1} failed:`, err);
            }
            attempt++;
        }

        if (signature) {
            COMPOSE_TIME_SIGNATURE = signature;   // store for send-time use
            setCachedSignature(signature);        // logTiming inside setCachedSignature
        } else {
            console.error(`[CardByte] All ${MAX_RETRIES + 1} fetch attempts failed. Last error:`, lastError);
        }
    }

    // 4. Last-ditch stale cache (bypasses session + TTL)
    if (!signature) {
        const t0 = Date.now();
        const staleCache = getCachedSignature({ skipTtl: true, skipSessionCheck: true });
        logTiming("getCachedSignature (stale fallback)", t0);
        if (staleCache) {
            console.warn("[CardByte] Using stale cached signature as last resort.");
            signature = staleCache;
            COMPOSE_TIME_SIGNATURE = signature;
        }
    }

    // 5. Minimal identity fallback
    if (!signature) {
        console.warn("[CardByte] No signature available — using fallback identity signature.");
        signature = `
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
        // Do NOT store the fallback in COMPOSE_TIME_SIGNATURE — so send-time
        // knows there was no real signature and skips re-applying it.
    }

    const finalSignature = `<div style='margin-top:40px'></div>${signature}<div style='margin-top:40px'></div>`;
    console.log("[CardByte] Applying signature at compose time...");
    await bodySetSignatureAsync(item, finalSignature); // timing inside
}

// ─── Send-time: NO API calls — in-memory → cache → allow send ────────────────
async function _onSendCore(item, mailbox) {
    console.log("[CardByte] ── onSend: checking if signature is already in body...");
    const t0 = Date.now();
    const bodyHtml = await getBodyText(item);
    logTiming("getBodyText", t0);

    if (bodyHtml.includes(SIGNATURE_SENTINEL)) {
        console.log("[CardByte] ✅ onSend: signature already present — nothing to do.");
        return;
    }

    console.log("[CardByte] ⚠️ onSend: signature missing — attempting recovery (no API calls).");

    // 1. In-memory variable set at compose time
    let signature = COMPOSE_TIME_SIGNATURE;
    if (signature) {
        console.log("[CardByte] ✅ onSend: recovered from COMPOSE_TIME_SIGNATURE (in-memory).");
    }

    // 2. localStorage cache (skip session + TTL — different context)
    if (!signature) {
        const t1 = Date.now();
        signature = getCachedSignature({ skipTtl: true, skipSessionCheck: true });
        // logTiming already inside getCachedSignature
        if (signature) {
            console.log("[CardByte] ✅ onSend: recovered from localStorage cache.");
        }
    }

    // 3. Nothing available — let the mail go as-is
    if (!signature) {
        console.warn("[CardByte] ⚠️ onSend: no signature found in memory or cache — sending without signature.");
        return;
    }

    const finalSignature = `<div style='margin-top:40px'></div>${signature}<div style='margin-top:40px'></div>`;
    await bodySetSignatureAsync(item, finalSignature); // timing inside
    console.log("[CardByte] ✅ onSend: signature re-applied successfully.");
}

// ─── Public event handlers ────────────────────────────────────────────────────
const applySignature = async function (event = { completed: () => { } }) {
    const mailbox = Office?.context?.mailbox;
    const item = mailbox?.item;

    try {
        if (!item) return;
        await _applySignatureCore(item, mailbox);
    } catch (err) {
        console.error("[CardByte] Error in applySignature:", err);
    } finally {
        event.completed();
    }
};

const onSendHandler = async function (event = { completed: () => { } }) {
    const mailbox = Office?.context?.mailbox;
    const item = mailbox?.item;

    const done = (allow = true) => event.completed({ allowEvent: allow });

    try {
        if (!item) { done(true); return; }
        await withTimeout(_onSendCore(item, mailbox), 4000);
    } catch (err) {
        console.warn("[CardByte] onSendHandler error/timeout — allowing send:", err.message);
    } finally {
        done(true);
    }
};

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