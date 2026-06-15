// ─── Constants ────────────────────────────────────────────────────────────────
const AES_KEY = "fnItrY2YfozBqCC2B4XsfqHIvZku3kUOq3DFkbO64kk=";
const AES_IV = "3YapeNfJDung7TXxeKXn4g==";

const SESSION_KEY = "cardbyte_session_id";
const CACHE_KEY = "cardbyte_cached_signature";
const CACHE_SESSION_KEY = "cardbyte_cached_signature_session";
const CACHE_TIMESTAMP_KEY = "cardbyte_cached_signature_ts";
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

const MAX_SAFE_HTML_SIZE = 500_000;
const MAX_SAFE_HTML_SIZE_MOBILE = 200_000;
const HEAVY_THRESHOLD = 100 * 1024; // 100 KB
const NOTIF_KEY_HEAVY = "cardbyte_sig_heavy";
const MAX_RETRIES = 2;

// ─── Platform detection (memoized) ───────────────────────────────────────────
// detectPlatform() previously re-evaluated on every call; we memoize after
// Office.onReady fires so the result is stable for the lifetime of the page.
let _platformCache = null;

function detectPlatform() {
    if (_platformCache) return _platformCache;

    const platform = (Office?.context?.platform || "").toLowerCase();
    const ua = (navigator?.userAgent || "").toLowerCase();

    if (platform === "ios" || platform === "iphone" || platform === "ipad") {
        _platformCache = "mobile-ios";
    } else if (platform === "android") {
        _platformCache = "mobile-android";
    } else if (ua.includes("outlookmobile") || ua.includes("outlook-ios") || ua.includes("outlook-android")) {
        _platformCache = ua.includes("android") ? "mobile-android" : "mobile-ios";
    } else if (
        (platform === "officeonline" || platform === "web" || platform === "") &&
        (ua.includes("iphone") || ua.includes("ipad") || ua.includes("android"))
    ) {
        _platformCache = ua.includes("android") ? "mobile-android" : "mobile-ios";
    } else if (
        platform === "mac" ||
        ((platform === "" || platform === "desktop") &&
            (ua.includes("macintosh") || ua.includes("mac os x")) &&
            !ua.includes("iphone") && !ua.includes("ipad"))
    ) {
        _platformCache = "mac";
    } else if (platform === "officeonline" || platform === "web" || platform === "") {
        _platformCache = "owa";
    } else {
        _platformCache = "desktop";
    }

    return _platformCache;
}

const isMobile = () => { const p = detectPlatform(); return p === "mobile-ios" || p === "mobile-android"; };
const isOWA = () => detectPlatform() === "owa";
const isMac = () => detectPlatform() === "mac";
const getMaxHtmlSize = () => isMobile() ? MAX_SAFE_HTML_SIZE_MOBILE : MAX_SAFE_HTML_SIZE;

Office.onReady(() => {
    console.log("✅ Office.onReady is Started!");
    // Prime the memoized platform detection once Office context is available.
    _platformCache = null; // reset so detectPlatform() uses the real context
    console.log(`[CardByte] Platform detected: ${detectPlatform()}`);
});

// ─── Crypto helpers ───────────────────────────────────────────────────────────
// Pre-import the AES key pair once rather than re-importing on every fetch.
// Both promises are created eagerly and awaited only when first needed.
let _cryptoKeysPromise = null;

function getCryptoKeys() {
    if (_cryptoKeysPromise) return _cryptoKeysPromise;

    _cryptoKeysPromise = (async () => {
        const keyBuffer = base64ToArrayBuffer(AES_KEY);
        const ivBuffer = base64ToArrayBuffer(AES_IV);
        const [decryptKey, encryptKey] = await Promise.all([
            crypto.subtle.importKey("raw", keyBuffer, { name: "AES-CBC" }, false, ["decrypt"]),
            crypto.subtle.importKey("raw", keyBuffer, { name: "AES-CBC" }, false, ["encrypt"]),
        ]);
        return { decryptKey, encryptKey, ivBuffer };
    })();

    return _cryptoKeysPromise;
}

function base64ToArrayBuffer(base64) {
    let b = base64.replace(/-/g, "+").replace(/_/g, "/");
    const pad = b.length % 4;
    if (pad) b += "=".repeat(4 - pad);
    const bin = atob(b);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
}

function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
}

async function handleAesDecrypt(encryptedText) {
    if (!encryptedText) return "";
    try {
        const { decryptKey, ivBuffer } = await getCryptoKeys();
        const encryptedBuffer = base64ToArrayBuffer(encryptedText);
        if (encryptedBuffer.byteLength % 16 !== 0) {
            console.error(`[CardByte] Invalid encrypted data length: ${encryptedBuffer.byteLength} bytes`);
            return encryptedText;
        }
        const decryptedBuffer = await crypto.subtle.decrypt(
            { name: "AES-CBC", iv: ivBuffer }, decryptKey, encryptedBuffer
        );
        return new TextDecoder().decode(decryptedBuffer);
    } catch (err) {
        console.error("[CardByte] Decryption error:", err);
        return encryptedText;
    }
}

async function encryptEmail(email = "") {
    if (!email || !email.trim()) { console.warn("[CardByte] Empty email provided"); return ""; }
    try {
        const { encryptKey, ivBuffer } = await getCryptoKeys();
        const data = new TextEncoder().encode(email);
        const encrypted = await crypto.subtle.encrypt({ name: "AES-CBC", iv: ivBuffer }, encryptKey, data);
        return arrayBufferToBase64(encrypted);
    } catch (err) {
        console.error("[CardByte] Encryption error:", err);
        return "";
    }
}

// ─── Session-aware localStorage cache ────────────────────────────────────────

function getOrCreateSessionId() {
    let sid = sessionStorage.getItem(SESSION_KEY);
    if (!sid) {
        sid = crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36);
        sessionStorage.setItem(SESSION_KEY, sid);
    }
    return sid;
}

/**
 * Clears all three cache keys in one place — previously duplicated in two
 * branches of getCachedSignature.
 */
function _clearCache() {
    localStorage.removeItem(CACHE_KEY);
    localStorage.removeItem(CACHE_SESSION_KEY);
    localStorage.removeItem(CACHE_TIMESTAMP_KEY);
}

function getCachedSignature({ skipTtl = false, skipSessionCheck = false } = {}) {
    if (skipSessionCheck) return localStorage.getItem(CACHE_KEY);

    const currentSid = getOrCreateSessionId();
    if (localStorage.getItem(CACHE_SESSION_KEY) !== currentSid) {
        console.log("[CardByte] New session detected — clearing cached signature");
        _clearCache();
        return null;
    }

    if (!skipTtl) {
        const ts = parseInt(localStorage.getItem(CACHE_TIMESTAMP_KEY) || "0", 10);
        if (Date.now() - ts > CACHE_TTL_MS) {
            console.log("[CardByte] Cache TTL expired — clearing cached signature");
            _clearCache();
            return null;
        }
    }

    return localStorage.getItem(CACHE_KEY);
}

function setCachedSignature(html) {
    const sid = getOrCreateSessionId();
    try {
        localStorage.setItem(CACHE_KEY, html);
        localStorage.setItem(CACHE_SESSION_KEY, sid);
        localStorage.setItem(CACHE_TIMESTAMP_KEY, Date.now().toString());
    } catch (_) { /* quota exceeded — silently ignore */ }
}

// ─── Network ──────────────────────────────────────────────────────────────────

async function renderSignatureOnServer(userEmail) {
    const xPlatform = Office.context.diagnostics.platform === Office.PlatformType.Mac ? "MAC" : "WINDOWS";
    const encryptedMail = await encryptEmail(userEmail);

    const res = await fetch(
        "https://ns-enterprise.cardbyte.ai/email-signature/html/outlook/get-active",
        { method: "GET", headers: { username: encryptedMail, "X-Platform": xPlatform } }
    );

    if (!res.ok) throw new Error(`[CardByte] Server responded ${res.status}`);

    const decryptedData = await handleAesDecrypt(await res.text());
    return JSON.parse(decryptedData)?.html ?? null;
}

// ─── Notification helpers ─────────────────────────────────────────────────────

function showHeavySignatureNotification(item, message) {
    try {
        item?.notificationMessages?.addAsync?.(
            NOTIF_KEY_HEAVY,
            {
                type: Office.MailboxEnums.ItemNotificationMessageType.InformationalMessage,
                message,
                icon: "Icon.16x16",
                persistent: true,
            },
            (result) => {
                if (result.status !== Office.AsyncResultStatus.Succeeded)
                    console.warn("[CardByte] Could not add notification:", result.error?.message);
            }
        );
    } catch (err) {
        console.warn("[CardByte] showHeavySignatureNotification failed:", err);
    }
}

function removeHeavySignatureNotification(item) {
    try { item?.notificationMessages?.removeAsync?.(NOTIF_KEY_HEAVY, () => { }); }
    catch (_) { /* no-op */ }
}

// ─── Signature injection ──────────────────────────────────────────────────────

function bodySetSignatureAsync(item, html) {
    return new Promise((resolve, reject) => {
        if (typeof item.body.setSignatureAsync !== "function") {
            reject(new Error("setSignatureAsync not available")); return;
        }
        item.body.setSignatureAsync(html, { coercionType: Office.CoercionType.Html }, (r) => {
            r.status === "succeeded" ? resolve() : reject(r.error);
        });
    });
}

function bodySetSelectedDataAsync(item, html) {
    return new Promise((resolve, reject) => {
        if (typeof item.body.setSelectedDataAsync !== "function") {
            reject(new Error("setSelectedDataAsync not available")); return;
        }
        item.body.setSelectedDataAsync(html, { coercionType: Office.CoercionType.Html }, (r) => {
            r.status === Office.AsyncResultStatus.Succeeded ? resolve() : reject(r.error);
        });
    });
}

/**
 * Light path  (<100 KB): use setSignatureAsync directly — Outlook handles
 * placement natively. We first clear any Outlook-default signature with
 * setSignatureAsync("") before injecting our own, so the two never stack.
 *
 * Heavy path (≥100 KB):
 *   • Compose open → show notification bar only (don't block the compose window).
 *   • Send time    → inject via setSelectedDataAsync so the signature travels
 *                    with the message body.
 *
 * IMPORTANT: setSignatureAsync("") is called ONLY when we have a real signature
 * to insert immediately after. It is never called when no signature is available
 * (that branch exits early in _applySignatureCore before reaching here).
 */
async function applySignatureWithFallback(item, html, isSendTime = false) {
    const htmlSize = new Blob([html]).size;
    console.log("[CardByte] Signature size:", htmlSize, "bytes");

    if (htmlSize < HEAVY_THRESHOLD) {
        removeHeavySignatureNotification(item);
        // Clear any Outlook-injected default signature first, then set ours.
        // Both calls are on the light path so setSignatureAsync is available.
        await bodySetSignatureAsync(item, html);
        return true;
    }

    console.warn(`[CardByte] Signature is ${htmlSize} bytes (≥100 KB) — heavy path (isSendTime=${isSendTime}).`);

    if (!isSendTime) {
        await bodySetSignatureAsync(item, "");
        showHeavySignatureNotification(item, "Your signature is large and will be inserted at the time of send.");
        return false;
    }

    try {
        // Step 1: Use setSignatureAsync("") to force cursor to bottom
        await bodySetSignatureAsync(item, "");

        // Step 2: Now insert heavy signature at cursor (which is now at bottom)
        await bodySetSelectedDataAsync(item, html);

        removeHeavySignatureNotification(item);
        console.log("[CardByte] Heavy signature inserted at bottom via cursor trick.");
        return true;
    } catch (err) {
        console.error("[CardByte] Heavy path send-time insertion failed:", err);
        return false;
    }
}

// ─── Core orchestration ───────────────────────────────────────────────────────

/**
 * @param {object}  item
 * @param {object}  mailbox
 * @param {object}  opts
 * @param {boolean} opts.fetchIfMissing   - Fetch from server when cache is cold.
 * @param {boolean} opts.skipTtl          - Ignore TTL when reading from cache.
 * @param {boolean} opts.skipSessionCheck - Ignore session mismatch check.
 * @param {boolean} isSendTime            - true when called from onSendHandler.
 */
async function _applySignatureCore(item, mailbox, opts = {}, isSendTime = false) {
    const { fetchIfMissing = false, skipTtl = false, skipSessionCheck = false } = opts;
    const userEmail = mailbox?.userProfile?.emailAddress;

    let html = getCachedSignature({ skipTtl, skipSessionCheck });

    if (fetchIfMissing && userEmail && html == null) {
        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            if (attempt > 0) {
                console.warn(`[CardByte] Retrying signature fetch (attempt ${attempt}/${MAX_RETRIES})…`);
                // Exponential-ish back-off starting at 1 s (not 0 s on attempt 0)
                await new Promise(r => setTimeout(r, 1000 * attempt));
            }
            try {
                const result = await renderSignatureOnServer(userEmail);
                if (result != null) { html = result; break; }
                console.warn("[CardByte] Server returned null on attempt", attempt);
            } catch (err) {
                console.warn(`[CardByte] Fetch attempt ${attempt + 1} failed:`, err);
            }
        }

        if (html != null) {
            setCachedSignature(html);
        } else {
            console.error(`[CardByte] All ${MAX_RETRIES + 1} fetch attempts failed — falling back to stale cache.`);
            // Last resort: any cached value regardless of TTL or session
            html = getCachedSignature({ skipTtl: true, skipSessionCheck: true });
            if (html) console.warn("[CardByte] Using stale cached signature.");
        }
    }

    if (!html) {
        console.error("[CardByte] No signature available. Aborting.");
        removeHeavySignatureNotification(item);
        showHeavySignatureNotification(item, "Signature not available. Please contact Admin.");
        return;
    }

    await applySignatureWithFallback(item, html, isSendTime);
}

// ─── Office action handlers ───────────────────────────────────────────────────

const applySignature = async function (event = { completed: () => { } }) {
    const mailbox = Office?.context?.mailbox;
    const item = mailbox?.item;
    try {
        if (!item) return;
        await _applySignatureCore(item, mailbox, { fetchIfMissing: true }, false);
    } catch (err) {
        console.error("[CardByte] Error in applySignature:", err);
    } finally {
        event.completed();
    }
};

async function logDraftedContent() {
    const item = Office?.context?.mailbox?.item;
    if (!item) { console.error("[CardByte] No item found"); return; }

    item.body.getAsync(Office.CoercionType.Html, (result) => {
        if (result.status !== Office.AsyncResultStatus.Succeeded) {
            console.error("[CardByte] getAsync failed:", result.error?.message);
            return;
        }

        const fullHtml = result.value;
        const parser = new DOMParser();
        const doc = parser.parseFromString(fullHtml, "text/html");

        // Remove everything from the HR (quote divider) onwards
        const hr = doc.querySelector("hr");
        const divRply = doc.querySelector("#divRplyFwdMsg");
        const quoteAnchor = doc.querySelector("a[name='_MailOriginal']");

        const cutPoint = quoteAnchor || hr || divRply;

        if (cutPoint) {
            // Remove the cutpoint and all following siblings
            let node = cutPoint;
            while (node) {
                const next = node.nextSibling;
                node.parentNode.removeChild(node);
                node = next;
            }
            cutPoint.remove?.();
        }

        const draftedHtml = doc.body.innerHTML.trim();
        console.log("[CardByte] Drafted content only:", draftedHtml);
    });
}

const onSendHandler = async function (event = { completed: () => { } }) {
    const mailbox = Office?.context?.mailbox;
    const item = mailbox?.item;
    try {
        if (!item) return;
        // Send iframe has its own fresh sessionStorage, so we skip both the
        // TTL and the session check and just read whatever is in localStorage.

        await bodySetSignatureAsync(item, " ");

        await logDraftedContent(); // 👈 add this
        await _applySignatureCore(
            item, mailbox,
            { fetchIfMissing: false, skipTtl: true, skipSessionCheck: true },
            true
        );
    } catch (err) {
        console.error("[CardByte] Error in onSendHandler:", err);
    } finally {
        // event.completed({ allowEvent: true });
    }
};

// ─── Associate Office actions ─────────────────────────────────────────────────

if (typeof Office !== "undefined" && typeof Office.actions !== "undefined") {
    Office.actions.associate("onSendHandler", onSendHandler);
    Office.actions.associate("applySignature", applySignature);
    console.log("[CardByte] Office.actions registered: applySignature, onSendHandler");
} else {
    console.log("[CardByte] Office.actions not available — LaunchEvent path not active (expected on 2016/2019)");
}