let CACHED_SIGNATURE_HTML = null;
const SIGNATURE_MARKER = "<!-- CARDBYTE_SIGNATURE -->";
const AES_KEY = "fnItrY2YfozBqCC2B4XsfqHIvZku3kUOq3DFkbO64kk=";
const AES_IV = "3YapeNfJDung7TXxeKXn4g==";

// ─── Session-based cache buster ───────────────────────────────────────────────
const SESSION_KEY = "cardbyte_session_id";
const CACHE_KEY = "cardbyte_cached_signature";
const CACHE_SESSION_KEY = "cardbyte_cached_signature_session";
const CACHE_TIMESTAMP_KEY = "cardbyte_cached_signature_ts";
const CACHE_TTL_MS = 5 * 60 * 1000;

// ─── Notification key constant ────────────────────────────────────────────────
const NOTIF_KEY = "cardbyte_sig_status";

// ─── Timing logger ────────────────────────────────────────────────────────────
function logTiming(label, startMs) {
    const elapsed = Date.now() - startMs;
    console.log(`[CardByte] ⏱ ${label}: ${elapsed}ms`);
}

// ─── Notification helpers ─────────────────────────────────────────────────────
function showNotification(
    item,
    message,
    type = "informationalMessage",
    persistent = false,
    startMs = null
) {

    if (!item || typeof item.notificationMessages?.addAsync !== "function") {
        return;
    }

    let finalMessage = message;

    if (startMs) {
        const elapsed = Date.now() - startMs;
        finalMessage += ` (${elapsed}ms)`;
    }

    // Outlook notification length safety
    if (finalMessage.length > 140) {
        finalMessage = finalMessage.slice(0, 137) + "...";
    }

    const details = {
        type,
        message: finalMessage,
        icon: "",
        persistent,
    };

    item.notificationMessages.replaceAsync(
        NOTIF_KEY,
        details,
        (result) => {

            if (result.status !== "succeeded") {

                item.notificationMessages.addAsync(
                    NOTIF_KEY,
                    details,
                    (r) => {

                        if (r.status !== "succeeded") {
                            console.warn(
                                "[CardByte] addAsync notification failed:",
                                r.error?.message
                            );
                        }

                    }
                );
            }

        }
    );
}

function removeNotification(item) {
    if (!item || typeof item.notificationMessages?.removeAsync !== "function") {
        return;
    }

    item.notificationMessages.removeAsync(NOTIF_KEY, () => { });
}

function notifyWithTiming(item, phase, startMs) {

    const elapsed = Date.now() - startMs;

    console.log(`[CardByte] ${phase}: ${elapsed}ms`);

    showNotification(
        item,
        phase,
        "informationalMessage",
        false,
        startMs
    );
}

function getOrCreateSessionId() {

    let sid = sessionStorage.getItem(SESSION_KEY);

    if (!sid) {

        sid = crypto.randomUUID
            ? crypto.randomUUID()
            : Date.now().toString(36);

        sessionStorage.setItem(SESSION_KEY, sid);
    }

    return sid;
}

// ─── Cache read ───────────────────────────────────────────────────────────────
function getCachedSignature({
    skipTtl = false,
    skipSessionCheck = false
} = {}) {

    const t0 = Date.now();

    if (skipSessionCheck) {

        const val = localStorage.getItem(CACHE_KEY);

        logTiming("getCachedSignature (skipSessionCheck)", t0);

        return val;
    }

    const currentSid = getOrCreateSessionId();
    const cachedSid = localStorage.getItem(CACHE_SESSION_KEY);

    if (cachedSid !== currentSid) {

        console.log("[CardByte] New session detected — clearing cache");

        localStorage.removeItem(CACHE_KEY);
        localStorage.removeItem(CACHE_SESSION_KEY);
        localStorage.removeItem(CACHE_TIMESTAMP_KEY);

        logTiming("getCachedSignature (session mismatch)", t0);

        return null;
    }

    if (!skipTtl) {

        const ts = parseInt(
            localStorage.getItem(CACHE_TIMESTAMP_KEY) || "0",
            10
        );

        if (Date.now() - ts > CACHE_TTL_MS) {

            console.log("[CardByte] Cache TTL expired — clearing");

            localStorage.removeItem(CACHE_KEY);
            localStorage.removeItem(CACHE_SESSION_KEY);
            localStorage.removeItem(CACHE_TIMESTAMP_KEY);

            logTiming("getCachedSignature (ttl expired)", t0);

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

        logTiming("setCachedSignature (failed)", t0);

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

    if (platform === "ios" || platform === "iphone" || platform === "ipad") {
        return "mobile-ios";
    }

    if (platform === "android") {
        return "mobile-android";
    }

    if (
        ua.includes("outlookmobile") ||
        ua.includes("outlook-ios") ||
        ua.includes("outlook-android")
    ) {
        return ua.includes("android")
            ? "mobile-android"
            : "mobile-ios";
    }

    if (
        (platform === "officeonline" || platform === "web" || platform === "") &&
        (ua.includes("iphone") || ua.includes("ipad") || ua.includes("android"))
    ) {
        return ua.includes("android")
            ? "mobile-android"
            : "mobile-ios";
    }

    if (platform === "mac") {
        return "mac";
    }

    if (
        (platform === "" || platform === "desktop") &&
        (ua.includes("macintosh") || ua.includes("mac os x")) &&
        !ua.includes("iphone") &&
        !ua.includes("ipad")
    ) {
        return "mac";
    }

    if (
        platform === "officeonline" ||
        platform === "web" ||
        platform === ""
    ) {
        return "owa";
    }

    return "desktop";
}

function isMobile() {
    const p = detectPlatform();
    return p === "mobile-ios" || p === "mobile-android";
}

function isOWA() {
    return detectPlatform() === "owa";
}

function isMac() {
    return detectPlatform() === "mac";
}

function getMaxHtmlSize() {
    return isMobile()
        ? MAX_SAFE_HTML_SIZE_MOBILE
        : MAX_SAFE_HTML_SIZE;
}

// ─── Office Ready ─────────────────────────────────────────────────────────────
Office.onReady(() => {

    console.log("✅ Office.onReady Started");
    console.log(`[CardByte] Platform: ${detectPlatform()}`);

});

// ─── Crypto helpers ───────────────────────────────────────────────────────────
function base64ToArrayBuffer(base64) {

    let base64Data = base64.replace(/-/g, "+").replace(/_/g, "/");

    const padding = base64Data.length % 4;

    if (padding) {
        base64Data += "=".repeat(4 - padding);
    }

    const binaryString = atob(base64Data);

    const bytes = new Uint8Array(binaryString.length);

    for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }

    return bytes.buffer;
}

function arrayBufferToBase64(buffer) {

    const bytes = new Uint8Array(buffer);

    let binaryString = "";

    for (let i = 0; i < bytes.length; i++) {
        binaryString += String.fromCharCode(bytes[i]);
    }

    return btoa(binaryString);
}

async function handleAesDecrypt(encryptedText, generatedKey) {

    const t0 = Date.now();

    try {

        if (!encryptedText) {
            return "";
        }

        const keyToUse = generatedKey || AES_KEY;

        let keyBuffer;

        try {
            keyBuffer = base64ToArrayBuffer(keyToUse);
        } catch (e) {
            console.error("Failed to decode key:", e);
            return encryptedText;
        }

        if (
            keyBuffer.byteLength !== 16 &&
            keyBuffer.byteLength !== 32
        ) {

            if (generatedKey && generatedKey !== AES_KEY) {
                return handleAesDecrypt(encryptedText, AES_KEY);
            }

            return encryptedText;
        }

        const ivBuffer = base64ToArrayBuffer(AES_IV);

        if (ivBuffer.byteLength !== 16) {
            return encryptedText;
        }

        const key = await crypto.subtle.importKey(
            "raw",
            keyBuffer,
            { name: "AES-CBC" },
            false,
            ["decrypt"]
        );

        let encryptedBuffer;

        try {
            encryptedBuffer = base64ToArrayBuffer(encryptedText);
        } catch {
            return encryptedText;
        }

        const decryptedBuffer = await crypto.subtle.decrypt(
            { name: "AES-CBC", iv: ivBuffer },
            key,
            encryptedBuffer
        );

        const result = new TextDecoder().decode(decryptedBuffer);

        logTiming("handleAesDecrypt", t0);

        return result;

    } catch (err) {

        logTiming("handleAesDecrypt (error)", t0);

        return encryptedText;
    }
}

async function encryptEmail(email = "") {

    const t0 = Date.now();

    try {

        if (!email || email.trim() === "") {
            return "";
        }

        const keyBuffer = base64ToArrayBuffer(AES_KEY);
        const ivBuffer = base64ToArrayBuffer(AES_IV);

        const key = await crypto.subtle.importKey(
            "raw",
            keyBuffer,
            { name: "AES-CBC" },
            false,
            ["encrypt"]
        );

        const data = new TextEncoder().encode(email);

        const encrypted = await crypto.subtle.encrypt(
            { name: "AES-CBC", iv: ivBuffer },
            key,
            data
        );

        const result = arrayBufferToBase64(encrypted);

        logTiming("encryptEmail", t0);

        return result;

    } catch (err) {

        logTiming("encryptEmail (error)", t0);

        return "";
    }
}

// ─── Backend fetch ────────────────────────────────────────────────────────────
async function renderSignatureOnServer(user) {

    const t0 = Date.now();

    const item = Office?.context?.mailbox?.item;

    const platform = Office.context.diagnostics.platform;

    const xPlatform =
        platform === Office.PlatformType.Mac
            ? "MAC"
            : "WINDOWS";

    try {

        notifyWithTiming(item, "Loading signature...", t0);

        const encryptedMail = await encryptEmail(user);

        const apiStart = Date.now();

        const primaryRes = await fetch(
            "https://ns-enterprise.cardbyte.ai/email-signature/html/outlook/get-active",
            {
                method: "GET",
                headers: {
                    username: encryptedMail,
                    "X-Platform": xPlatform
                }
            }
        );

        notifyWithTiming(item, "API response received ✓", apiStart);

        if (primaryRes.ok) {

            const data = await primaryRes.text();

            const decryptedData = await handleAesDecrypt(data);

            notifyWithTiming(item, "Signature decrypted ✓", apiStart);

            logTiming("renderSignatureOnServer", t0);
            console.warn("API responce Decryting : ", JSON.parse(decryptedData));
            if (JSON.parse(decryptedData)?.html === "")
                notifyWithTiming(item, "Signature not assigned. Please Contact Admin.", apiStart);
            return JSON.parse(decryptedData)?.html || "";
        }

        console.warn("Primary failed. Falling back to legacy...");

    } catch (err) {

        console.warn("Primary crashed:", err);

        showNotification(
            item,
            `API error: ${err.message}`,
            "errorMessage",
            false,
            t0
        );
    }

    return null;
}

// ─── Timeout wrapper ──────────────────────────────────────────────────────────
function withTimeout(promise, ms) {

    return Promise.race([
        promise,
        new Promise((_, reject) =>
            setTimeout(
                () => reject(new Error(`Timed out after ${ms}ms`)),
                ms
            )
        )
    ]);
}

// ─── Body helpers ─────────────────────────────────────────────────────────────
function getBodyText(item) {

    return new Promise((resolve) => {

        const t0 = Date.now();

        item.body.getAsync(
            Office.CoercionType.Html,
            (result) => {

                logTiming("getBodyText", t0);

                if (result.status === "succeeded") {
                    resolve(result.value || "");
                } else {
                    resolve("");
                }

            }
        );
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

        item.body.setSignatureAsync(
            html,
            { coercionType: Office.CoercionType.Html },
            (r) => {

                logTiming("setSignatureAsync", t0);

                if (r.status === "succeeded") {
                    resolve();
                } else {
                    reject(r.error);
                }

            }
        );
    });
}

// ─── Core apply ───────────────────────────────────────────────────────────────
async function _applySignatureCore(
    item,
    mailbox,
    {
        fetchIfMissing = false,
        skipTtl = false,
        skipSessionCheck = false
    } = {}
) {

    const t0 = Date.now();
    console.error("[CardByte] applySignature called :", t0);
    const userProfile = mailbox?.userProfile || {};
    const userEmail = userProfile?.emailAddress;

    let fetched = getCachedSignature({
        skipTtl,
        skipSessionCheck
    });

    if (fetchIfMissing && userEmail && fetched == null) {

        notifyWithTiming(item, "Fetching signature...", t0);

        const result = await renderSignatureOnServer(userEmail);

        if (result != null) {

            fetched = result;

            CACHED_SIGNATURE_HTML = fetched;

            setCachedSignature(fetched);

            notifyWithTiming(item, "Signature fetched ✓", t0);
        }
    }

    if (!fetched) {

        const staleCache = getCachedSignature({
            skipTtl: true,
            skipSessionCheck: true
        });

        if (staleCache) {

            fetched = staleCache;

            notifyWithTiming(item, "Using stale cache ✓", t0);

        }
    }

    notifyWithTiming(item, "Applying signature...", t0);

    const finalSignature =
        `<div style='margin-top:40px'></div>` +
        fetched +
        `<div style='margin-top:40px'></div>`;

    await bodySetSignatureAsync(item, finalSignature);

    notifyWithTiming(item, "Signature applied ✓", t0);

    setTimeout(() => removeNotification(item), 3000);

    logTiming("_applySignatureCore total", t0);
}

// ─── Apply signature handler ──────────────────────────────────────────────────
const applySignature = async function (
    event = { completed: () => { } }
) {

    const t0 = Date.now();

    const mailbox = Office?.context?.mailbox;
    const item = mailbox?.item;

    try {

        if (!item) {
            return;
        }

        notifyWithTiming(item, "Starting signature flow...", t0);

        await _applySignatureCore(
            item,
            mailbox,
            {
                fetchIfMissing: true
            }
        );

    } catch (err) {

        console.error("[CardByte] applySignature error:", err);
        // notifyWithTiming(item, "Error ", t0);
        showNotification(
            item,
            `Apply failed: ${err.message}`,
            "errorMessage",
            true,
            t0
        );

    } finally {

        logTiming("applySignature total", t0);

        event.completed();
    }
};

// ─── Send-time core ───────────────────────────────────────────────────────────
async function _onSendCore(item, mailbox) {

    const t0 = Date.now();

    const bodyHtml = await getBodyText(item);

    if (bodyHtml.includes(SIGNATURE_SENTINEL)) {

        notifyWithTiming(item, "Signature already present ✓", t0);

        return;
    }

    const cached = getCachedSignature({
        skipTtl: true,
        skipSessionCheck: true
    });

    if (!cached) {

        showNotification(
            item,
            "No cached signature on send",
            "errorMessage",
            false,
            t0
        );

        return;
    }

    notifyWithTiming(item, "Re-applying signature...", t0);

    await _applySignatureCore(
        item,
        mailbox,
        {
            fetchIfMissing: false,
            skipTtl: true,
            skipSessionCheck: true
        }
    );

    notifyWithTiming(item, "Signature verified ✓", t0);

    logTiming("_onSendCore", t0);
}

// ─── onSend handler ───────────────────────────────────────────────────────────
const onSendHandler = async function (
    event = { completed: () => { } }
) {

    const t0 = Date.now();

    const mailbox = Office?.context?.mailbox;
    const item = mailbox?.item;

    const done = (allow = true) => {

        logTiming("onSendHandler total", t0);

        event.completed({
            allowEvent: allow
        });
    };

    try {

        if (!item) {
            done(true);
            return;
        }

        notifyWithTiming(item, "Verifying before send...", t0);

        await withTimeout(
            _onSendCore(item, mailbox),
            4000
        );

        notifyWithTiming(item, "Send verification complete ✓", t0);

        setTimeout(() => removeNotification(item), 3000);

    } catch (err) {

        console.warn(
            "[CardByte] onSend timeout/error:",
            err.message
        );

        showNotification(
            item,
            `Send timeout/error`,
            "errorMessage",
            true,
            t0
        );

    } finally {

        done(true);
    }
};

// ─── Handler registration ─────────────────────────────────────────────────────
if (
    typeof Office !== "undefined" &&
    typeof Office.actions !== "undefined"
) {

    Office.actions.associate(
        "applySignature",
        applySignature
    );

    console.log(
        "[CardByte] Registered: applySignature"
    );

    Office.actions.associate(
        "onSendHandler",
        onSendHandler
    );

    console.log(
        "[CardByte] Registered: onSendHandler"
    );

} else {

    console.log(
        "[CardByte] Office.actions unavailable"
    );
}