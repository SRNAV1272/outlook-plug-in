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

// ─── In-memory signature store ────────────────────────────────────────────────
let COMPOSE_TIME_SIGNATURE = null;

// ─── In-flight fetch deduplicator ────────────────────────────────────────────
let _fetchInFlight = null;

// ─── Notification key constant ────────────────────────────────────────────────
const NOTIF_KEY = "cardbyte_sig_status";

// ─── Timing logger ────────────────────────────────────────────────────────────
function logTiming(label, startMs) {
    const elapsed = Date.now() - startMs;
    console.log(`[CardByte] ⏱ ${label}: ${elapsed}ms`);
}

// ─── Notification helpers ─────────────────────────────────────────────────────
/**
 * Show or update the notification bar on the compose item.
 * type: "informationalMessage" | "errorMessage" | "progressIndicator" (OWA only)
 * We use "informationalMessage" for broad compatibility.
 */
function showNotification(item, message, type = "informationalMessage", persistent = false) {
    if (!item || typeof item.notificationMessages?.addAsync !== "function") return;

    const details = {
        type,
        message,
        icon: "none",
        persistent,
    };

    // Replace if already shown (replaceAsync), else add fresh (addAsync)
    item.notificationMessages.replaceAsync(NOTIF_KEY, details, (result) => {
        if (result.status !== "succeeded") {
            // Key didn't exist yet — add it
            item.notificationMessages.addAsync(NOTIF_KEY, details, (r) => {
                if (r.status !== "succeeded") {
                    console.warn("[CardByte] addAsync notification failed:", r.error?.message);
                }
            });
        }
    });
}

function removeNotification(item) {
    if (!item || typeof item.notificationMessages?.removeAsync !== "function") return;
    item.notificationMessages.removeAsync(NOTIF_KEY, () => { /* ignore */ });
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
function detectComposeType(item) {
    try {
        const mode = item?.composeType;
        if (mode) {
            if (mode === Office.MailboxEnums.ComposeType.NewMail) return "new";
            if (mode === Office.MailboxEnums.ComposeType.Reply) return "reply";
            if (mode === Office.MailboxEnums.ComposeType.ReplyAll) return "replyAll";
            if (mode === Office.MailboxEnums.ComposeType.Forward) return "forward";
            if (typeof mode === "string") return mode.toLowerCase();
        }
        if (item?.inReplyTo) return "reply-or-forward";
    } catch (_) { }
    return "new";
}

// ─── Office.onReady ───────────────────────────────────────────────────────────
Office.onReady(() => {
    console.log("✅ Office.onReady is Started !");
    console.log(`[CardByte] Platform detected: ${detectPlatform()}`);

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
            "https://newqa-enterprise.cardbyte.ai/email-signature/html/outlook/get-active",
            { method: "GET", headers: { username: encryptedMail, "X-Platform": xPlatform } }
        );
        logTiming("API call — fetch() resolved (headers)", tFetch);

        if (primaryRes.ok) {
            const tBody = Date.now();
            const data = await primaryRes.arrayBuffer();
            logTiming("API call — response.arrayBuffer() buffering", tBody);

            const text = new TextDecoder().decode(data);
            const decryptedData = await handleAesDecrypt(text);
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
}

// ─── Fetch deduplicator ───────────────────────────────────────────────────────
async function _fetchSignatureOnce(userEmail) {
    if (_fetchInFlight) {
        console.log("[CardByte] 🔒 Fetch already in-flight — waiting on existing promise (no duplicate request)");
        const t0 = Date.now();
        const result = await _fetchInFlight;
        logTiming("_fetchSignatureOnce (waited on in-flight)", t0);
        return result;
    }

    console.log("[CardByte] 🔒 No in-flight fetch — starting new request");
    _fetchInFlight = renderSignatureOnServer(userEmail).finally(() => {
        _fetchInFlight = null;
        console.log("[CardByte] 🔒 In-flight fetch settled — lock released");
    });

    return _fetchInFlight;
}

// ─── Taskpane prefetch ────────────────────────────────────────────────────────
async function _prefetchSignature() {
    const t0 = Date.now();
    console.log("[CardByte] 🔥 Prefetch: started");

    const mailbox = Office?.context?.mailbox;
    const userEmail = mailbox?.userProfile?.emailAddress;

    if (!userEmail) {
        console.warn("[CardByte] 🔥 Prefetch: no email available — skipping");
        return;
    }

    if (COMPOSE_TIME_SIGNATURE) {
        console.log("[CardByte] 🔥 Prefetch: COMPOSE_TIME_SIGNATURE already warm — skipping");
        logTiming("Prefetch (skipped — in-memory warm)", t0);
        return;
    }

    const cached = getCachedSignature();
    if (cached) {
        COMPOSE_TIME_SIGNATURE = cached;
        console.log("[CardByte] 🔥 Prefetch: cache hit — COMPOSE_TIME_SIGNATURE warmed");
        logTiming("Prefetch (warmed from cache)", t0);
        return;
    }

    console.log("[CardByte] 🔥 Prefetch: cache miss — fetching from server");
    try {
        const html = await _fetchSignatureOnce(userEmail);
        if (html) {
            COMPOSE_TIME_SIGNATURE = html;
            setCachedSignature(html);
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

if (typeof window !== "undefined") {
    window.cardbytePrewarm = _prefetchSignature;
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
    return `<div data-cb="${SIGNATURE_SENTINEL}" style="margin-top:40px;margin-bottom:40px;">${html}</div>`;
}

// ─── Compose-time core ────────────────────────────────────────────────────────
async function _applySignatureCore(item, mailbox) {
    const t0 = Date.now();
    const userProfile = mailbox?.userProfile || {};
    const userEmail = userProfile?.emailAddress;
    const composeType = detectComposeType(item);

    console.log(`[CardByte] _applySignatureCore — composeType: ${composeType}`);

    // ── Phase 1: In-memory (fastest — silent, no notification needed) ─────────
    let signature = COMPOSE_TIME_SIGNATURE;
    if (signature) {
        console.log("[CardByte] ✅ Compose: using in-memory COMPOSE_TIME_SIGNATURE");
    }

    // ── Phase 2: Session cache (fast — silent) ────────────────────────────────
    if (!signature) {
        signature = getCachedSignature();
        if (signature) {
            console.log("[CardByte] ✅ Compose: session cache hit");
            COMPOSE_TIME_SIGNATURE = signature;
        }
    }

    // ── Phase 3: Server fetch — full notification lifecycle ───────────────────
    if (!signature && userEmail) {

        // 3a. API call starting
        showNotification(item, "CardByte: Loading signature…");
        console.log("[CardByte] 🔔 Notification → Loading signature…");

        const MAX_RETRIES = 2;
        let attempt = 0;
        let lastError = null;

        while (attempt <= MAX_RETRIES) {
            try {
                if (attempt > 0) {
                    console.warn(`[CardByte] Retrying fetch (attempt ${attempt}/${MAX_RETRIES})...`);
                    await new Promise(r => setTimeout(r, 1000 * attempt));
                }
                const result = await _fetchSignatureOnce(userEmail);
                if (result != null) {
                    signature = result;
                    break;
                }
                lastError = new Error("Server returned null");
            } catch (err) {
                lastError = err;
                showNotification(item, `[CardByte] Fetch attempt ${attempt + 1} failed:`);
                console.warn(`[CardByte] Fetch attempt ${attempt + 1} failed:`, err);
            }
            attempt++;
        }

        if (signature) {
            // 3b. API response received successfully
            showNotification(item, "CardByte: Signature fetched successfully.");
            console.log("[CardByte] 🔔 Notification → Signature fetched successfully.");
            COMPOSE_TIME_SIGNATURE = signature;
            setCachedSignature(signature);
        } else {
            showNotification(item, `[CardByte] All ${MAX_RETRIES + 1} fetch attempts failed. Please contact admin.`);
            console.error(`[CardByte] All ${MAX_RETRIES + 1} fetch attempts failed:`, lastError);
        }
    }

    // ── Phase 4: Stale cache last-ditch (bypasses session + TTL) ─────────────
    if (!signature) {
        const staleCache = getCachedSignature({ skipTtl: true, skipSessionCheck: true });
        if (staleCache) {
            console.warn("[CardByte] Using stale cached signature as last resort.");
            signature = staleCache;
            COMPOSE_TIME_SIGNATURE = signature;
        }
    }

    // ── Phase 5: No signature found anywhere — abort and notify ──────────────
    if (!signature) {
        console.error("[CardByte] ❌ No signature found in memory, cache, or server.");
        showNotification(
            item,
            "CardByte: Signature not found. Please contact your admin.",
            "errorMessage",
            true  // persistent — user must dismiss manually
        );
        console.log("[CardByte] 🔔 Notification → Signature not found. Please contact your admin.");
        logTiming(`_applySignatureCore (${composeType}) — aborted, no signature`, t0);
        return; // ← do NOT apply anything
    }

    // ── Phase 6: Applying signature ───────────────────────────────────────────
    showNotification(item, "CardByte: Applying signature…");
    console.log("[CardByte] 🔔 Notification → Applying signature…");

    const finalSignature = _wrapSignature(signature);
    console.log(`[CardByte] Writing signature for composeType: ${composeType}`);
    await bodySetSignatureAsync(item, finalSignature);

    // ── Phase 7: Applied ──────────────────────────────────────────────────────
    showNotification(item, "CardByte: Signature applied ✓");
    console.log("[CardByte] 🔔 Notification → Signature applied ✓");

    // Auto-dismiss success message after 4 seconds
    setTimeout(() => removeNotification(item), 4000);

    logTiming(`_applySignatureCore (${composeType}) total`, t0);
}

// ─── Send-time core — NO API calls ───────────────────────────────────────────
//
// CONTRACT: always resolves (never throws). Returns true if a write was
// attempted (caller can log), false if no signature was found.
// The write itself is awaited to completion — it is NEVER raced against a
// timeout here. The timeout guard lives in onSendHandler and only fires
// event.completed() once; if the write finishes first, the guard is cancelled.


async function _onSendCore(item) {
    const t0 = Date.now();
    console.log("[CardByte] ── onSend: checking body for existing signature...");

    // ── Step 1: resolve signature source (all synchronous / localStorage — fast)
    // localStorage reads are synchronous and effectively instant, so we resolve
    // the source before doing the async body read, saving one round-trip.
    const signature =
        COMPOSE_TIME_SIGNATURE ||
        getCachedSignature({ skipTtl: true, skipSessionCheck: true }) ||
        null;

    console.log("[CardByte] ⚠️ onSend: signature missing — attempting recovery.");

    if (!signature) {
        console.warn("[CardByte] ⚠️ onSend: no signature in memory or cache — sending as-is.");
        logTiming("_onSendCore (no signature)", t0);
        return;
    }

    // ── Step 2: write — awaited to full completion, not raced
    console.log("[CardByte] ✅ onSend: writing signature from "
        + (COMPOSE_TIME_SIGNATURE ? "memory" : "localStorage cache") + ".");
    await bodySetSignatureAsync(item, _wrapSignature(signature));
    console.log("[CardByte] ✅ onSend: signature re-applied successfully.");
    logTiming("_onSendCore (re-applied)", t0);
}

// ─── Public event handlers ────────────────────────────────────────────────────
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
        showNotification(item, "CardByte: Failed to apply signature.", "errorMessage");
        setTimeout(() => removeNotification(item), 5000);
    } finally {
        logTiming(`applySignature handler (${composeType})`, t0);
        event.completed();
    }
};

const onSendHandler = async function (event = { completed: () => { } }) {
    const t0 = Date.now();
    const mailbox = Office?.context?.mailbox;
    const item = mailbox?.item;

    console.log("[CardByte] === onSendHandler fired ===");

    // ── Guard: prevents Outlook's "add-in is taking too long" error dialog.
    //
    // DESIGN: the guard and _onSendCore race via a single `done` flag.
    // Whichever finishes first calls event.completed() exactly once.
    //
    // If _onSendCore finishes first  → guard timer is cancelled, write is done.
    // If guard fires first (8 s)     → event.completed() is called to satisfy
    //   Outlook, but _onSendCore continues running in the background.
    //   setSignatureAsync/getAsync are Office.js async operations that survive
    //   the event.completed() call for a short window, so the write usually
    //   still lands. This is best-effort at that point — acceptable because
    //   the signature was already present at compose time in the normal flow.
    //
    // The guard timeout is 8 s (Outlook's hard limit is ~10 s).
    // Normal flow (sentinel present) takes ~200–500 ms — guard never fires.
    // Recovery flow (write needed) takes ~500–2000 ms — guard never fires.
    // Only a pathological hang (Office.js runtime stall) reaches 8 s.

    let done = false;
    let guardTimer = null;

    const complete = () => {
        if (done) return;
        done = true;
        if (guardTimer) { clearTimeout(guardTimer); guardTimer = null; }
        logTiming("onSendHandler total", t0);
        event.completed({ allowEvent: true });
    };

    // Start the guard — only fires if _onSendCore hangs
    guardTimer = setTimeout(() => {
        if (done) return;
        console.warn("[CardByte] onSendHandler: guard timeout (8 s) — forcing event.completed()."
            + " Write may still be in-flight.");
        complete();
    }, 8000);

    try {
        // if (!item) {
        //     console.warn("[CardByte] onSendHandler: no item.");
        //     complete();
        //     return;
        // }
        await _onSendCore(item);
    } catch (err) {
        // _onSendCore is designed not to throw, but guard against anything unexpected
        console.warn("[CardByte] onSendHandler: unexpected error —", err.message);
    } finally {
        // Normal path: write finished before 8 s — cancel guard and complete cleanly
        complete();
    }
};

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

        COMPOSE_TIME_SIGNATURE = null;
        _fetchInFlight = null;
        localStorage.removeItem(CACHE_KEY);
        localStorage.removeItem(CACHE_SESSION_KEY);
        localStorage.removeItem(CACHE_TIMESTAMP_KEY);
        console.log("[CardByte] onFromChangedHandler: in-memory + localStorage + in-flight lock cleared");

        // Notify that signature is being reloaded for the new account
        showNotification(item, "CardByte: Switching signature for new account…");
        console.log("[CardByte] 🔔 Notification: reloading signature for account switch");

        await _applySignatureCore(item, mailbox);
        // _applySignatureCore will update the notification to "applied ✓" internally
    } catch (err) {
        console.error("[CardByte] Error in onFromChangedHandler:", err);
        showNotification(item, "CardByte: Failed to reload signature.", "errorMessage");
        setTimeout(() => removeNotification(item), 5000);
    } finally {
        logTiming("onFromChangedHandler total", t0);
        event.completed();
    }
};

// ─── Handler registration ─────────────────────────────────────────────────────
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