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
// Persists for the lifetime of the event-handler iframe / JS context.
// On WebView clients (OWA, New Outlook, Mac) the context may be torn down
// between sessions — localStorage is the durable fallback.
let COMPOSE_TIME_SIGNATURE = null;

// ─── Timing logger ────────────────────────────────────────────────────────────
function logTiming(label, startMs) {
    const elapsed = Date.now() - startMs;
    console.log(`[CardByte] ⏱ ${label}: ${elapsed}ms`);
}

// ─── Session ID ───────────────────────────────────────────────────────────────
function getOrCreateSessionId() {
    let sid = sessionStorage.getItem(SESSION_KEY);
    if (!sid) {
        sid = crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36);
        sessionStorage.setItem(SESSION_KEY, sid);
    }
    return sid;
}

// ─── Cache read ───────────────────────────────────────────────────────────────
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

// ─── Cache write ──────────────────────────────────────────────────────────────
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
        !ua.includes("iphone") && !ua.includes("ipad")
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

// ─── Compose type detection ───────────────────────────────────────────────────
// Returns "new" | "reply" | "replyAll" | "forward" | "unknown"
function detectComposeType(item) {
    try {
        const mode = item?.composeType;
        if (mode) {
            // Office.MailboxEnums.ComposeType values
            if (mode === Office.MailboxEnums.ComposeType.NewMail) return "new";
            if (mode === Office.MailboxEnums.ComposeType.Reply) return "reply";
            if (mode === Office.MailboxEnums.ComposeType.ReplyAll) return "replyAll";
            if (mode === Office.MailboxEnums.ComposeType.Forward) return "forward";
            // String fallback (some platforms return strings)
            if (typeof mode === "string") return mode.toLowerCase();
        }
    } catch (_) { }
    return "unknown";
}

// ─── Office.onReady ───────────────────────────────────────────────────────────
Office.onReady(() => {
    console.log("✅ Office.onReady is Started !");
    console.log(`[CardByte] Platform detected: ${detectPlatform()}`);

    // Fire-and-forget prefetch so the signature is warm before the user
    // opens any compose/reply/forward window.
    _prefetchSignature().catch((err) => {
        console.warn("[CardByte] onReady prefetch failed silently:", err.message);
    });
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
    const t0 = Date.now();
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
        const result = new TextDecoder().decode(decryptedBuffer);
        logTiming("handleAesDecrypt (success)", t0);
        return result;
    } catch (err) {
        logTiming("handleAesDecrypt (error)", t0);
        if (generatedKey && generatedKey !== AES_KEY && err.message.includes("key data")) {
            try { return await handleAesDecrypt(encryptedText, AES_KEY); }
            catch (e) { console.error("Fallback also failed:", e.message); }
        }
        return encryptedText;
    }
}

async function encryptEmail(email = "") {
    const t0 = Date.now();
    try {
        if (!email || email.trim() === "") { console.warn("Warning: Empty email provided"); return ""; }
        const keyBuffer = base64ToArrayBuffer(AES_KEY);
        const ivBuffer = base64ToArrayBuffer(AES_IV);
        if (keyBuffer.byteLength !== 16 && keyBuffer.byteLength !== 32) {
            console.error(`Invalid key length: ${keyBuffer.byteLength} bytes`); return "";
        }
        if (ivBuffer.byteLength !== 16) {
            console.error(`Invalid IV length: ${ivBuffer.byteLength} bytes`); return "";
        }
        const key = await crypto.subtle.importKey("raw", keyBuffer, { name: "AES-CBC" }, false, ["encrypt"]);
        const data = new TextEncoder().encode(email);
        const encrypted = await crypto.subtle.encrypt({ name: "AES-CBC", iv: ivBuffer }, key, data);
        const base64Result = arrayBufferToBase64(encrypted);
        try { atob(base64Result); } catch (e) { console.error("Result is NOT valid base64:", e); }
        logTiming("encryptEmail (success)", t0);
        return base64Result;
    } catch (err) {
        logTiming("encryptEmail (error)", t0);
        console.error("Encryption error:", err);
        return "";
    }
}

// ─── Backend fetch ────────────────────────────────────────────────────────────
async function renderSignatureOnServer(user) {
    const t0 = Date.now();
    const platform = Office.context.diagnostics.platform;
    const xPlatform = platform === Office.PlatformType.Mac ? "MAC" : "WINDOWS";

    try {
        const encryptedMail = await encryptEmail(user);
        console.log(`[CardByte] 🌐 API call started — primary renderer`);

        const tFetch = Date.now();
        const primaryRes = await fetch(
            "https://ns-enterprise.cardbyte.ai/email-signature/html/outlook/get-active",
            { method: "GET", headers: { username: encryptedMail, "X-Platform": xPlatform } }
        );
        logTiming("API call — fetch() resolved (headers)", tFetch);

        if (primaryRes.ok) {
            const tBody = Date.now();
            const data = await primaryRes.arrayBuffer();        // faster than text() — skips string copy
            logTiming("API call — response.arrayBuffer() buffering", tBody);

            const text = new TextDecoder().decode(data);
            const decryptedData = await handleAesDecrypt(text); // timing inside
            logTiming("API call — primary renderer (total)", t0);
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

// ─── Taskpane prefetch ────────────────────────────────────────────────────────
// Called from Office.onReady (event-handler context) AND from taskpane.js
// via window.cardbytePrewarm(). Warms COMPOSE_TIME_SIGNATURE + localStorage
// so OnNewMessageCompose / reply / forward all hit cache immediately.
async function _prefetchSignature() {
    const t0 = Date.now();
    console.log("[CardByte] 🔥 Prefetch: started");

    const mailbox = Office?.context?.mailbox;
    const userEmail = mailbox?.userProfile?.emailAddress;

    if (!userEmail) {
        console.warn("[CardByte] 🔥 Prefetch: no email available — skipping");
        return;
    }

    // 1. In-memory already warm
    if (COMPOSE_TIME_SIGNATURE) {
        console.log("[CardByte] 🔥 Prefetch: COMPOSE_TIME_SIGNATURE already warm — skipping");
        logTiming("Prefetch (skipped — in-memory warm)", t0);
        return;
    }

    // 2. Valid cache exists — warm in-memory from it
    const cached = getCachedSignature();           // logTiming inside
    if (cached) {
        COMPOSE_TIME_SIGNATURE = cached;
        console.log("[CardByte] 🔥 Prefetch: cache hit — COMPOSE_TIME_SIGNATURE warmed");
        logTiming("Prefetch (warmed from cache)", t0);
        return;
    }

    // 3. Cache miss — fetch from server
    console.log("[CardByte] 🔥 Prefetch: cache miss — fetching from server");
    try {
        const html = await renderSignatureOnServer(userEmail); // timing inside
        if (html) {
            COMPOSE_TIME_SIGNATURE = html;
            setCachedSignature(html);                          // timing inside
            logTiming("Prefetch (fetch + cache set)", t0);
            console.log("[CardByte] 🔥 Prefetch: ✅ complete — signature ready");
        } else {
            console.warn("[CardByte] 🔥 Prefetch: server returned null — compose will fetch on demand");
            logTiming("Prefetch (server returned null)", t0);
        }
    } catch (err) {
        console.error("[CardByte] 🔥 Prefetch: fetch threw —", err.message);
        logTiming("Prefetch (fetch threw)", t0);
    }
}

// Expose on window so taskpane.js can call window.cardbytePrewarm()
if (typeof window !== "undefined") {
    window.cardbytePrewarm = _prefetchSignature;
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

// ─── Body helpers ─────────────────────────────────────────────────────────────
function getBodyText(item) {
    return new Promise((resolve) => {
        const t0 = Date.now();
        item.body.getAsync(Office.CoercionType.Html, (result) => {
            logTiming("getBodyText", t0);
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

// ─── Signature wrapper ────────────────────────────────────────────────────────
function _wrapSignature(html) {
    // The data-cb attribute carries SIGNATURE_SENTINEL so body checks
    // (bodyHtml.includes(SIGNATURE_SENTINEL)) work on all compose types.
    return `<div data-cb="${SIGNATURE_SENTINEL}" style="margin-top:40px;margin-bottom:40px;">${html}</div>`;
}

// ─── Compose-time core ────────────────────────────────────────────────────────
// Handles new compose, reply, replyAll, forward — all via the same path.
// Resolution order: in-memory → cache → server fetch (with retries) → stale cache → identity fallback
async function _applySignatureCore(item, mailbox) {
    const t0 = Date.now();
    const userProfile = mailbox?.userProfile || {};
    const userEmail = userProfile?.emailAddress;
    const composeType = detectComposeType(item);

    console.log(`[CardByte] _applySignatureCore — composeType: ${composeType}`);

    // 1. In-memory (fastest — same JS context, set by prefetch or prior compose)
    let signature = COMPOSE_TIME_SIGNATURE;
    if (signature) {
        console.log("[CardByte] ✅ Compose: using in-memory COMPOSE_TIME_SIGNATURE");
    }

    // 2. Session cache (localStorage)
    if (!signature) {
        signature = getCachedSignature();           // logTiming inside
        if (signature) {
            console.log("[CardByte] ✅ Compose: cache hit");
            COMPOSE_TIME_SIGNATURE = signature;    // warm in-memory for send-time
        }
    }

    // 3. Server fetch with retries (only when cache cold)
    if (!signature && userEmail) {
        const MAX_RETRIES = 2;
        let attempt = 0;
        let lastError = null;

        while (attempt <= MAX_RETRIES) {
            try {
                if (attempt > 0) {
                    console.warn(`[CardByte] Retrying fetch (attempt ${attempt}/${MAX_RETRIES})...`);
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
            COMPOSE_TIME_SIGNATURE = signature;
            setCachedSignature(signature);          // timing inside
        } else {
            console.error(`[CardByte] All ${MAX_RETRIES + 1} fetch attempts failed:`, lastError);
        }
    }

    // 4. Stale cache last-ditch (bypasses session + TTL)
    if (!signature) {
        const staleCache = getCachedSignature({ skipTtl: true, skipSessionCheck: true }); // timing inside
        if (staleCache) {
            console.warn("[CardByte] Using stale cached signature as last resort.");
            signature = staleCache;
            COMPOSE_TIME_SIGNATURE = signature;
        }
    }

    // 5. Minimal identity fallback (not stored — send-time won't re-apply it)
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
    }

    const finalSignature = _wrapSignature(signature);
    console.log(`[CardByte] Applying signature for composeType: ${composeType}`);
    await bodySetSignatureAsync(item, finalSignature); // timing inside
    logTiming(`_applySignatureCore (${composeType}) total`, t0);
}

// ─── Send-time core ───────────────────────────────────────────────────────────
// NO API calls. In-memory → cache → allow send as-is.
async function _onSendCore(item, mailbox) {
    const t0 = Date.now();
    console.log("[CardByte] ── onSend: checking body for existing signature...");

    const bodyHtml = await getBodyText(item);      // timing inside getBodyText

    if (bodyHtml.includes(SIGNATURE_SENTINEL)) {
        console.log("[CardByte] ✅ onSend: signature already present — fast pass-through.");
        logTiming("_onSendCore (fast pass-through)", t0);
        return;
    }

    console.log("[CardByte] ⚠️ onSend: signature missing — attempting recovery (no API calls).");

    // 1. In-memory variable set at compose / prefetch time
    let signature = COMPOSE_TIME_SIGNATURE;
    if (signature) {
        console.log("[CardByte] ✅ onSend: recovered from COMPOSE_TIME_SIGNATURE (in-memory).");
    }

    // 2. localStorage (skip session + TTL — may be different iframe context)
    if (!signature) {
        signature = getCachedSignature({ skipTtl: true, skipSessionCheck: true }); // timing inside
        if (signature) {
            console.log("[CardByte] ✅ onSend: recovered from localStorage cache.");
        }
    }

    // 3. Nothing — let mail go as-is
    if (!signature) {
        console.warn("[CardByte] ⚠️ onSend: no signature found — sending without signature.");
        logTiming("_onSendCore (no signature — sending as-is)", t0);
        return;
    }

    await bodySetSignatureAsync(item, _wrapSignature(signature)); // timing inside
    console.log("[CardByte] ✅ onSend: signature re-applied successfully.");
    logTiming("_onSendCore (re-applied)", t0);
}

// ─── Public event handlers ────────────────────────────────────────────────────

// Handles OnNewMessageCompose — fires for new mail, reply, replyAll, forward
const applySignature = async function (event = { completed: () => { } }) {
    const t0 = Date.now();
    const mailbox = Office?.context?.mailbox;
    const item = mailbox?.item;
    const composeType = item ? detectComposeType(item) : "unknown";

    console.log(`[CardByte] === applySignature fired (composeType: ${composeType}) ===`);

    try {
        if (!item) {
            console.warn("[CardByte] applySignature: no item — completing");
            return;
        }
        await _applySignatureCore(item, mailbox);
    } catch (err) {
        console.error("[CardByte] Error in applySignature:", err);
    } finally {
        logTiming(`applySignature handler (${composeType})`, t0);
        event.completed();
    }
};

// Handles OnMessageSend — no API calls, fast path only
const onSendHandler = async function (event = { completed: () => { } }) {
    const t0 = Date.now();
    const mailbox = Office?.context?.mailbox;
    const item = mailbox?.item;

    console.log("[CardByte] === onSendHandler fired ===");

    const done = (allow = true) => {
        logTiming("onSendHandler total", t0);
        event.completed({ allowEvent: allow });
    };

    try {
        if (!item) { done(true); return; }
        await withTimeout(_onSendCore(item, mailbox), 4000);
    } catch (err) {
        console.warn("[CardByte] onSendHandler error/timeout — allowing send:", err.message);
    } finally {
        done(true);
    }
};

// Handles OnMessageFromChanged — account switched, wipe cache and re-fetch
const onFromChangedHandler = async function (event = { completed: () => { } }) {
    const t0 = Date.now();
    const mailbox = Office?.context?.mailbox;
    const item = mailbox?.item;

    console.log("[CardByte] === onFromChangedHandler fired — clearing cache for account switch ===");

    try {
        if (!item) {
            console.warn("[CardByte] onFromChangedHandler: no item — completing");
            return;
        }

        // Wipe both stores so the new account's signature is fetched fresh
        COMPOSE_TIME_SIGNATURE = null;
        localStorage.removeItem(CACHE_KEY);
        localStorage.removeItem(CACHE_SESSION_KEY);
        localStorage.removeItem(CACHE_TIMESTAMP_KEY);
        console.log("[CardByte] onFromChangedHandler: in-memory + localStorage cleared");

        await _applySignatureCore(item, mailbox);
    } catch (err) {
        console.error("[CardByte] Error in onFromChangedHandler:", err);
    } finally {
        logTiming("onFromChangedHandler total", t0);
        event.completed();
    }
};

// ─── Handler registration ─────────────────────────────────────────────────────
// Must be synchronous at top level — any async wrapper causes silent failures.
if (typeof Office !== "undefined" && typeof Office.actions !== "undefined") {
    Office.actions.associate("applySignature", applySignature);
    console.log("[CardByte] Office.actions.associate registered: applySignature");

    Office.actions.associate("onSendHandler", onSendHandler);
    console.log("[CardByte] Office.actions.associate registered: onSendHandler");

    Office.actions.associate("onFromChangedHandler", onFromChangedHandler);
    console.log("[CardByte] Office.actions.associate registered: onFromChangedHandler");
} else {
    console.log("[CardByte] Office.actions not available — LaunchEvent path not active (expected on 2016/2019)");
}