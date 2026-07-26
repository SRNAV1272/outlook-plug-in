"use strict";

// =============================================================================
//  CardByte Outlook Add-in — event-handler.js (FIXED v4)
//  Send-time reliability fix:
//  1. Cache reads NEVER destructively delete data. TTL/session expiry returns
//     null (caller refetches) but keeps the stale copy for send-time reads.
//  2. Send-time reads bypass BOTH TTL and session checks everywhere. Fresh
//     JS runtimes (always on Mac OnMessageSend, sometimes on Windows) get a
//     new sessionStorage session id — previously this nuked the rules cache
//     at send time while the default-signature read survived, so the default
//     signature overwrote the rule signature.
//  3. findMatchingRule supports cacheOnly mode — no network at send time.
//  4. purgeStaleSigById horizon raised to 24h so Office.onReady in the
//     send-time runtime doesn't delete rule signature HTML mid-compose.
//  5. Active signature id persisted to localStorage (not just a variable)
//     so a fresh send-time runtime can recover it on any platform.
// =============================================================================

// ─── Constants ────────────────────────────────────────────────────────────────

const AES_KEY = "fnItrY2YfozBqCC2B4XsfqHIvZku3kUOq3DFkbO64kk=";
const AES_IV = "3YapeNfJDung7TXxeKXn4g==";

const BASE_URL = "https://newqa-enterprise.cardbyte.ai/email-signature";

const SESSION_KEY = "cardbyte_session_id";
const CACHE_KEY = "cardbyte_cached_signature";
const CACHE_SESSION_KEY = "cardbyte_cached_signature_session";
const CACHE_TIMESTAMP_KEY = "cardbyte_cached_signature_ts";
const CACHE_TTL_MS = 5 * 60 * 1000;

const RULES_CACHE_KEY = "cardbyte_cached_rules";
const RULES_CACHE_TIMESTAMP_KEY = "cardbyte_cached_rules_ts";
const RULES_CACHE_TTL_MS = 5 * 60 * 1000;

const SIG_BY_ID_CACHE_KEY = "cardbyte_sig_by_id";
const SIG_BY_ID_TTL_MS = 5 * 60 * 1000;
// Hard purge horizon — entries older than this are physically removed.
// Must be much longer than a compose session; TTL above only governs
// freshness (re-fetch), not existence.
const SIG_BY_ID_PURGE_MS = 24 * 60 * 60 * 1000;

// Persisted (cross-runtime) record of the signature currently in the body.
const ACTIVE_SIG_KEY = "cardbyte_active_sig_id";
const ACTIVE_SIG_TS_KEY = "cardbyte_active_sig_ts";
const ACTIVE_SIG_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const MAX_SAFE_HTML_SIZE = 500_000;
const MAX_SAFE_HTML_SIZE_MOBILE = 200_000;
const HEAVY_THRESHOLD = 100 * 1024;
const MAX_RETRIES = 2;
const RECIPIENT_POLL_MS = 900;

const NOTIF_KEY = "cardbyte_sig_status";

let CACHED_SIGNATURE_HTML = null;

// =============================================================================
//  TIMING LOGGER
// =============================================================================

function logTiming(label, startMs) {
    const elapsed = Date.now() - startMs;
    console.log(`[CardByte] ⏱ ${label}: ${elapsed}ms`);
}

// =============================================================================
//  PLATFORM DETECTION
// =============================================================================

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

    if (
        platform === "mac" ||
        ((platform === "" || platform === "desktop") &&
            (ua.includes("macintosh") || ua.includes("mac os x")) &&
            !ua.includes("iphone") && !ua.includes("ipad"))
    ) return "mac";

    if (platform === "officeonline" || platform === "web" || platform === "") return "owa";
    return "desktop";
}

const isMobile = () => { const p = detectPlatform(); return p === "mobile-ios" || p === "mobile-android"; };
const isOWA = () => detectPlatform() === "owa";
const isMac = () => detectPlatform() === "mac";
const getMaxHtmlSize = () => isMobile() ? MAX_SAFE_HTML_SIZE_MOBILE : MAX_SAFE_HTML_SIZE;

function getXPlatform() {
    const p = detectPlatform();
    // if (p === "mac") return "MAC";
    // if (p === "mobile-ios" || p === "mobile-android") return "MOBILE";
    return "WINDOWS";
}

// =============================================================================
//  NOTIFICATION HELPERS
// =============================================================================

function showNotification(item, message, type = "informationalMessage", persistent = false, startMs = null) {
    try {
        if (!item || typeof item.notificationMessages?.addAsync !== "function") return;

        let finalMessage = message;
        if (startMs) finalMessage += ` (${Date.now() - startMs}ms)`;
        if (finalMessage.length > 140) finalMessage = finalMessage.slice(0, 137) + "...";

        const details = { type, message: finalMessage, icon: "none", persistent };

        item.notificationMessages.replaceAsync(NOTIF_KEY, details, (result) => {
            try {
                if (result.status !== "succeeded") {
                    item.notificationMessages.addAsync(NOTIF_KEY, details, (r) => {
                        if (r.status !== "succeeded")
                            console.warn("[CardByte] addAsync notification failed:", r.error?.message);
                    });
                }
            } catch (e) {
                console.warn("[CardByte] notification callback threw:", e);
            }
        });
    } catch (e) {
        console.warn("[CardByte] showNotification threw, ignoring:", e);
    }
}

function removeNotification(item) {
    if (!item || typeof item.notificationMessages?.removeAsync !== "function") return;
    item.notificationMessages.removeAsync(NOTIF_KEY, () => { });
}

function notifyWithTiming(item, phase, startMs) {
    const elapsed = Date.now() - startMs;
    console.log(`[CardByte] ${phase}: ${elapsed}ms`);
    showNotification(item, phase, "informationalMessage", false, startMs);
}

// =============================================================================
//  CRYPTO — AES-CBC via Web Crypto API
// =============================================================================

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

async function handleAesDecrypt(encryptedText, generatedKey) {
    const t0 = Date.now();
    try {
        if (!encryptedText) return "";
        const keyToUse = generatedKey || AES_KEY;
        let keyBuffer;
        try { keyBuffer = base64ToArrayBuffer(keyToUse); }
        catch (e) { console.error("Failed to decode key:", e); return encryptedText; }

        if (keyBuffer.byteLength !== 16 && keyBuffer.byteLength !== 32) {
            if (generatedKey && generatedKey !== AES_KEY) return handleAesDecrypt(encryptedText, AES_KEY);
            return encryptedText;
        }

        const ivBuffer = base64ToArrayBuffer(AES_IV);
        if (ivBuffer.byteLength !== 16) return encryptedText;

        const key = await crypto.subtle.importKey("raw", keyBuffer, { name: "AES-CBC" }, false, ["decrypt"]);

        let encryptedBuffer;
        try { encryptedBuffer = base64ToArrayBuffer(encryptedText); }
        catch { return encryptedText; }

        const decryptedBuffer = await crypto.subtle.decrypt({ name: "AES-CBC", iv: ivBuffer }, key, encryptedBuffer);
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
        if (!email || email.trim() === "") return "";
        const keyBuffer = base64ToArrayBuffer(AES_KEY);
        const ivBuffer = base64ToArrayBuffer(AES_IV);
        const key = await crypto.subtle.importKey("raw", keyBuffer, { name: "AES-CBC" }, false, ["encrypt"]);
        const data = new TextEncoder().encode(email);
        const encrypted = await crypto.subtle.encrypt({ name: "AES-CBC", iv: ivBuffer }, key, data);
        const result = arrayBufferToBase64(encrypted);
        logTiming("encryptEmail", t0);
        return result;
    } catch (err) {
        logTiming("encryptEmail (error)", t0);
        return "";
    }
}

// =============================================================================
//  STORAGE HELPERS
// =============================================================================

const store = {
    get: (key) => { try { return localStorage.getItem(key); } catch (_) { return null; } },
    set: (key, val) => { try { localStorage.setItem(key, val); } catch (_) { } },
    remove: (...keys) => { try { keys.forEach(k => localStorage.removeItem(k)); } catch (_) { } },
    getJson: (key) => { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : null; } catch (_) { return null; } },
    setJson: (key, val) => { try { localStorage.setItem(key, JSON.stringify(val)); } catch (_) { } },
};

// =============================================================================
//  SESSION ID
//  NOTE: sessionStorage is per-JS-runtime. Mac (and sometimes Windows)
//  runs OnMessageSend in a FRESH runtime → new session id. Session checks
//  must therefore never run on send-time reads, and must never delete data.
// =============================================================================

function getOrCreateSessionId() {
    try {
        let sid = sessionStorage.getItem(SESSION_KEY);
        if (!sid) {
            sid = crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36);
            sessionStorage.setItem(SESSION_KEY, sid);
        }
        return sid;
    } catch (_) {
        return "mobile-session";
    }
}

// =============================================================================
//  ACTIVE SIGNATURE ID (persisted — survives runtime teardown)
// =============================================================================

function setActiveSignatureId(id) {
    if (id == null) {
        store.remove(ACTIVE_SIG_KEY, ACTIVE_SIG_TS_KEY);
        return;
    }
    store.set(ACTIVE_SIG_KEY, String(id));
    store.set(ACTIVE_SIG_TS_KEY, Date.now().toString());
}

function getActiveSignatureId() {
    const id = store.get(ACTIVE_SIG_KEY);
    if (!id) return null;
    const ts = parseInt(store.get(ACTIVE_SIG_TS_KEY) || "0", 10);
    if (Date.now() - ts > ACTIVE_SIG_MAX_AGE_MS) return null;
    return id;
}

// =============================================================================
//  DEFAULT SIGNATURE CACHE
//  FIX: expiry/mismatch returns null but NEVER deletes — the stale copy is
//  the send-time safety net (skipTtl/skipSessionCheck reads).
// =============================================================================

function getCachedSignature({ skipTtl = false, skipSessionCheck = false } = {}) {
    const t0 = Date.now();

    if (skipSessionCheck) {
        const val = store.get(CACHE_KEY);
        logTiming("getCachedSignature (skipSessionCheck)", t0);
        return val;
    }

    const currentSid = getOrCreateSessionId();
    if (store.get(CACHE_SESSION_KEY) !== currentSid) {
        console.log("[CardByte] New session detected — signature cache treated as stale (kept on disk)");
        logTiming("getCachedSignature (session mismatch)", t0);
        return null;
    }

    if (!skipTtl) {
        const ts = parseInt(store.get(CACHE_TIMESTAMP_KEY) || "0", 10);
        if (Date.now() - ts > CACHE_TTL_MS) {
            console.log("[CardByte] Signature cache TTL expired — treated as stale (kept on disk)");
            logTiming("getCachedSignature (ttl expired)", t0);
            return null;
        }
    }

    const val = store.get(CACHE_KEY);
    logTiming("getCachedSignature (hit)", t0);
    return val;
}

function setCachedSignature(html) {
    const t0 = Date.now();
    const sid = getOrCreateSessionId();
    try {
        store.set(CACHE_KEY, html);
        store.set(CACHE_SESSION_KEY, sid);
        store.set(CACHE_TIMESTAMP_KEY, Date.now().toString());
        logTiming("setCachedSignature", t0);
    } catch (_) {
        logTiming("setCachedSignature (failed)", t0);
    }
}

// =============================================================================
//  RULES CACHE (same TTL pattern as signature)
//  FIX: expiry/mismatch returns null but NEVER deletes, and send-time reads
//  pass skipSessionCheck (fresh runtimes have a different session id).
// =============================================================================

function getCachedRules({ skipTtl = false, skipSessionCheck = false } = {}) {
    const t0 = Date.now();

    if (skipSessionCheck) {
        const val = store.getJson(RULES_CACHE_KEY);
        logTiming("getCachedRules (skipSessionCheck)", t0);
        return val;
    }

    const currentSid = getOrCreateSessionId();
    // Rules are tied to the same session as signatures
    if (store.get(CACHE_SESSION_KEY) !== currentSid) {
        console.log("[CardByte] New session detected — rules cache treated as stale (kept on disk)");
        logTiming("getCachedRules (session mismatch)", t0);
        return null;
    }

    if (!skipTtl) {
        const ts = parseInt(store.get(RULES_CACHE_TIMESTAMP_KEY) || "0", 10);
        if (Date.now() - ts > RULES_CACHE_TTL_MS) {
            console.log("[CardByte] Rules cache TTL expired — treated as stale (kept on disk)");
            logTiming("getCachedRules (ttl expired)", t0);
            return null;
        }
    }

    const val = store.getJson(RULES_CACHE_KEY);
    logTiming("getCachedRules (hit)", t0);
    return val;
}

function setCachedRules(rulesJson) {
    const t0 = Date.now();
    const sid = getOrCreateSessionId();
    try {
        store.setJson(RULES_CACHE_KEY, rulesJson);
        store.set(RULES_CACHE_TIMESTAMP_KEY, Date.now().toString());
        // Also update the session key so rules and signature share session lifecycle
        store.set(CACHE_SESSION_KEY, sid);
        logTiming("setCachedRules", t0);
    } catch (_) {
        logTiming("setCachedRules (failed)", t0);
    }
}

// =============================================================================
//  PER-SIGNATURE-ID HTML CACHE
// =============================================================================

function _readSigByIdMap() { return store.getJson(SIG_BY_ID_CACHE_KEY) || {}; }
function _writeSigByIdMap(map) { store.setJson(SIG_BY_ID_CACHE_KEY, map); }

function getSigById(signatureId, { skipTtl = false } = {}) {
    const id = String(signatureId);
    const map = _readSigByIdMap();
    const entry = map[id];
    if (!entry) return null;
    if (!skipTtl && Date.now() - entry.ts > SIG_BY_ID_TTL_MS) {
        console.log(`[CardByte] sigById TTL expired for id=${id}`);
        return null;
    }
    return entry.html;
}

function setSigById(signatureId, html) {
    const id = String(signatureId);
    const map = _readSigByIdMap();
    map[id] = { html, ts: Date.now() };
    _writeSigByIdMap(map);
    console.log(`[CardByte] sigById cached: id=${id}`);
}

// FIX: purge horizon is 24h, not the 5-min TTL. Office.onReady fires in the
// FRESH send-time runtime BEFORE _onSendCore — with the old 5-min horizon it
// deleted rule signature HTML for any compose session longer than 5 minutes,
// guaranteeing the default-signature fallback at send.
function purgeStaleSigById() {
    const map = _readSigByIdMap();
    const now = Date.now();
    let purged = 0;
    for (const id of Object.keys(map)) {
        if (now - map[id].ts > SIG_BY_ID_PURGE_MS) { delete map[id]; purged++; }
    }
    if (purged > 0) {
        _writeSigByIdMap(map);
        console.log(`[CardByte] purgeStaleSigById: removed ${purged} stale entries`);
    }
}

// =============================================================================
//  API LAYER
// =============================================================================

async function decryptHtmlResponse(rawText) {
    const decrypted = await handleAesDecrypt(rawText);
    return JSON.parse(decrypted)?.html || null;
}

async function fetchAndCacheRules(encryptedMail, xPlatform) {
    try {
        const res = await fetch(`${BASE_URL}/rules-config/get-active`, {
            method: "GET",
            headers: { "Content-Type": "application/json", username: encryptedMail, "X-Platform": xPlatform },
        });
        if (!res.ok) { console.warn("[CardByte] Rules fetch returned", res.status); return null; }

        const parsed = JSON.parse(await res.text());
        const rulesJson = parsed?.rulesJson;
        if (!rulesJson) { console.warn("[CardByte] Rules response had no rulesJson"); return null; }

        setCachedRules(rulesJson);
        console.log("[CardByte] rulesJson fetched and cached");
        return rulesJson;
    } catch (err) {
        console.error("[CardByte] fetchAndCacheRules failed:", err);
        return null;
    }
}

async function renderSignatureOnServer(userEmail) {
    const t0 = Date.now();
    const item = Office?.context?.mailbox?.item;
    const xPlatform = getXPlatform();

    try {
        notifyWithTiming(item, "Loading signature...", t0);
        const encryptedMail = await encryptEmail(userEmail);

        const primaryRes = await fetch(`${BASE_URL}/html/outlook/get-active`, {
            method: "GET",
            headers: { username: encryptedMail, "X-Platform": xPlatform },
        });

        notifyWithTiming(item, "API response received ✓", t0);

        if (primaryRes.ok) {
            const data = await primaryRes.text();
            const decryptedData = await handleAesDecrypt(data);
            notifyWithTiming(item, "Signature decrypted ✓", t0);
            logTiming("renderSignatureOnServer", t0);

            const html = JSON.parse(decryptedData)?.html;

            if (html === "" || html == null) {
                notifyWithTiming(item, "Signature not assigned. Please Contact Admin.", t0);
                showNotification(item, "Signature not assigned. Please Contact Admin.", "errorMessage", false, t0);
                return { html: null, explicit: true };
            }
            return { html, explicit: true };
        }

        console.warn("[CardByte] Primary fetch failed:", primaryRes.status);
    } catch (err) {
        console.warn("[CardByte] renderSignatureOnServer crashed:", err);
        showNotification(item, `API error: ${err.message}`, "errorMessage", false, t0);
    }

    return { html: null, explicit: false };
}

async function fetchSignatureById(signatureId, encryptedMail, xPlatform) {
    try {
        const res = await fetch(`${BASE_URL}/rules-config/get/${signatureId}`, {
            method: "GET",
            headers: { username: encryptedMail, "X-Platform": xPlatform },
        });
        if (!res.ok) { console.error("[CardByte] Signature fetch failed:", res.status); return null; }
        const html = await decryptHtmlResponse(await res.text());
        if (!html) console.warn("[CardByte] Signature HTML empty for signatureId:", signatureId);
        return html;
    } catch (err) {
        console.error("[CardByte] fetchSignatureById crashed:", err);
        return null;
    }
}

async function getOrFetchSignatureById(signatureId, encryptedMail, xPlatform, { skipTtl = false } = {}) {
    const id = String(signatureId);
    const cached = getSigById(id, { skipTtl });
    if (cached) {
        console.log(`[CardByte] ✅ sigById cache hit: id=${id}`);
        return cached;
    }
    console.log(`[CardByte] 🌐 sigById cache miss — fetching id=${id}`);
    const html = await fetchSignatureById(id, encryptedMail, xPlatform);
    if (html) setSigById(id, html);
    return html;
}

async function prefetchAllRuleSignatures(userEmail) {
    const rulesJson = getCachedRules({ skipTtl: false });
    if (!rulesJson) {
        console.log("[CardByte] prefetchAllRuleSignatures: rules not cached yet — skipping");
        return;
    }
    const enabledRules = (rulesJson?.rulesList || []).filter(r => r.enabled && r.signatureId != null);
    if (enabledRules.length === 0) return;

    const xPlatform = getXPlatform();
    const encryptedMail = await encryptEmail(userEmail);

    console.log(`[CardByte] 🔄 Prefetching signatures for ${enabledRules.length} rule(s)...`);

    await Promise.allSettled(
        enabledRules.map(r =>
            getOrFetchSignatureById(r.signatureId, encryptedMail, xPlatform)
                .then(html => {
                    if (html) console.log(`[CardByte] ✅ Prefetched signatureId=${r.signatureId}`);
                    else console.warn(`[CardByte] ⚠️  Prefetch null for signatureId=${r.signatureId}`);
                })
                .catch(err => console.warn(`[CardByte] Prefetch error signatureId=${r.signatureId}:`, err))
        )
    );
    console.log("[CardByte] Prefetch complete");
}

// =============================================================================
//  RECIPIENT HELPERS
// =============================================================================

function getRecipientsAsync(field) {
    return new Promise((resolve) => {
        if (typeof field?.getAsync !== "function") return resolve([]);
        field.getAsync((result) => {
            resolve(result.status === Office.AsyncResultStatus.Succeeded ? (result.value || []) : []);
        });
    });
}

async function getAllRecipientEmails(item) {
    const [to, cc] = await Promise.all([
        getRecipientsAsync(item?.to),
        getRecipientsAsync(item?.cc),
    ]);
    const emails = [...to, ...cc].map(r => (r.emailAddress || "").toLowerCase()).filter(Boolean);
    return [...new Set(emails)];
}

// =============================================================================
//  RULES MATCHING ENGINE
// =============================================================================

function getDomain(email) {
    const at = (email || "").lastIndexOf("@");
    return at === -1 ? "" : email.slice(at + 1).toLowerCase();
}

function recipientTypeMatches(recipientType, hasInternal, hasExternal) {
    if (!recipientType || recipientType.trim() === "") return true;
    const rt = recipientType.toLowerCase();
    if (rt === "all") return true;
    if (rt === "internal") return hasInternal;
    if (rt === "external") return hasExternal;
    return true;
}

function contextMatches(ruleContext, composeType) {
    if (!ruleContext || ruleContext.trim() === "") return true;
    const rc = ruleContext.toLowerCase();
    if (rc === "all") return true;
    if (composeType === null || composeType === undefined) {
        console.warn("[CardByte] contextMatches called with null composeType — using conservative fallback");
        return false;
    }
    return rc === composeType.toLowerCase();
}

function senderMatches(rule, currentSenderEmail) {
    if (!rule.Senders || rule.Senders.length === 0) return true;
    const sender = (currentSenderEmail || "").toLowerCase();
    return rule.Senders.some(s => s.toLowerCase() === sender);
}

// =============================================================================
//  COMPOSE TYPE DETECTION (Mobile-safe)
// =============================================================================

const _composeTypeByItem = new WeakMap();

async function detectComposeType(item) {
    if (typeof item?.getComposeTypeAsync === "function") {
        try {
            const result = await new Promise((resolve) => {
                item.getComposeTypeAsync((res) => {
                    if (res.status === Office.AsyncResultStatus.Succeeded) {
                        resolve(res.value?.composeType || "");
                    } else {
                        console.warn("[CardByte] getComposeTypeAsync failed:", res.error?.message);
                        resolve("");
                    }
                });
            });
            const raw = result.toLowerCase();
            console.log("[CardByte] getComposeTypeAsync raw result:", raw);
            if (raw === "reply" || raw === "forward") return "reply";
            if (raw === "newmail") return "compose";
        } catch (e) {
            console.warn("[CardByte] getComposeTypeAsync threw:", e);
        }
    } else {
        console.warn("[CardByte] getComposeTypeAsync not available on this platform");
    }

    try {
        const subject = await new Promise((resolve) => {
            if (typeof item?.subject?.getAsync === "function") {
                item.subject.getAsync((res) => {
                    resolve(res.status === Office.AsyncResultStatus.Succeeded ? (res.value || "") : "");
                });
            } else {
                resolve("");
            }
        });
        const subjLower = subject.toLowerCase().trim();
        if (subjLower.startsWith("re:") || subjLower.startsWith("fw:") || subjLower.startsWith("fwd:")) {
            console.log("[CardByte] Detected reply/forward via subject prefix:", subject);
            return "reply";
        }
    } catch (e) {
        console.warn("[CardByte] Subject check failed:", e);
    }

    try {
        if (item?.inReplyToId) {
            console.log("[CardByte] Detected reply/forward via inReplyToId:", item.inReplyToId);
            return "reply";
        }
    } catch (e) { }

    console.log("[CardByte] Defaulting composeType to 'compose' (new mail)");
    return "compose";
}

function getComposeType(item) {
    if (_composeTypeByItem.has(item)) return Promise.resolve(_composeTypeByItem.get(item));
    return detectComposeType(item).then((detected) => {
        _composeTypeByItem.set(item, detected);
        console.log("[CardByte] composeType cached:", detected);
        return detected;
    });
}

// =============================================================================
//  FIND MATCHING RULE
//  FIX: cacheOnly mode for send time — reads rules with skipTtl +
//  skipSessionCheck and NEVER goes to the network. Previously this function
//  re-ran the TTL/session checks (deleting the cache) and then attempted a
//  live fetch inside the 4s send window — the "clumsy internet" failure.
// =============================================================================

async function findMatchingRule(item, { cacheOnly = false } = {}) {
    let rulesJson = cacheOnly
        ? getCachedRules({ skipTtl: true, skipSessionCheck: true })
        : getCachedRules();

    if (!rulesJson && !cacheOnly) {
        console.warn("[CardByte] Rules not in cache — live fetch...");
        const userEmail = Office?.context?.mailbox?.userProfile?.emailAddress;
        if (userEmail) {
            const enc = await encryptEmail(userEmail);
            rulesJson = await fetchAndCacheRules(enc, getXPlatform());
        }
    }

    if (!rulesJson) { console.warn("[CardByte] findMatchingRule: no rules available"); return null; }

    const senderEmail = Office?.context?.mailbox?.userProfile?.emailAddress;
    const senderDomain = getDomain(senderEmail);

    let emails = await getAllRecipientEmails(item);
    if (emails.length === 0 && isMac()) {
        console.warn("[CardByte] Mac: recipients empty on first read — retrying after short delay");
        await new Promise(r => setTimeout(r, 400));
        emails = await getAllRecipientEmails(item);
    }

    const composeType = await getComposeType(item);

    if (emails.length === 0) {
        console.warn("[CardByte] No recipients — cannot match rules (will fallback to default)");
        return null;
    }

    let hasInternal = false;
    let hasExternal = false;
    const recipientDomains = [];

    emails.forEach(e => {
        const d = getDomain(e);
        if (d && !recipientDomains.includes(d)) recipientDomains.push(d);
        if (senderDomain && d === senderDomain) hasInternal = true;
        else hasExternal = true;
    });

    console.log("[CardByte] Rule evaluation context:", {
        senderEmail,
        senderDomain,
        composeType,
        hasInternal,
        hasExternal,
        recipientDomains,
        totalRules: rulesJson?.rulesList?.length ?? 0,
    });

    const sortedRules = (rulesJson?.rulesList || [])
        .filter(r => r.enabled)
        .sort((a, b) => a.priority - b.priority);

    let matched = null;

    for (const r of sortedRules) {
        const senderOk = senderMatches(r, senderEmail);
        const contextOk = contextMatches(r.context, composeType);
        const recipOk = recipientTypeMatches(r.recipientType, hasInternal, hasExternal);
        const allMatch = senderOk && contextOk && recipOk;

        console.log(
            (allMatch ? ">>> MATCH" : "    skip "),
            `| priority=${r.priority}`,
            `| sender=${senderOk}`,
            `| context=${r.context} (ok=${contextOk})`,
            `| recipientType=${r.recipientType} (ok=${recipOk})`,
            `| sigId=${r.signatureId ?? "NULL"}`,
            `| desc=${r.description ?? r.rule ?? ""}`
        );

        if (allMatch) { matched = r; break; }
    }

    if (matched) {
        console.log(
            `[CardByte] ✅ Matched rule: "${matched.rule ?? matched.description}"`,
            `| priority: ${matched.priority}`,
            `| context: ${matched.context}`,
            `| recipientType: ${matched.recipientType}`,
            `| signatureId: ${matched.signatureId}`
        );
    } else {
        console.warn("[CardByte] ❌ No rules matched", { composeType, hasInternal, hasExternal });
    }

    return matched;
}

// =============================================================================
//  SIGNATURE INJECTION
// =============================================================================

function bodySetSignatureAsync(item, html) {
    return new Promise((resolve, reject) => {
        if (typeof item.body.setSignatureAsync !== "function") {
            reject(new Error("setSignatureAsync not available"));
            return;
        }
        const t0 = Date.now();
        item.body.setSignatureAsync(html, { coercionType: Office.CoercionType.Html }, (r) => {
            logTiming("setSignatureAsync", t0);
            r.status === "succeeded" ? resolve() : reject(r.error);
        });
    });
}

async function applySignatureWithFallback(item, html, isSendTime = false) {
    const htmlSize = new Blob([html]).size;
    console.log("[CardByte] Signature size:", htmlSize, "bytes");

    const maxSize = 100 * 1024;
    if (htmlSize > maxSize) {
        console.warn(`[CardByte] Signature exceeds max size (${htmlSize} > ${maxSize} bytes) — not applying`);
        showNotification(item, "Signature could not be applied — size exceeds allowed threshold. Please contact Admin.", "errorMessage", false);
        return false;
    }

    try {
        removeNotification(item);
        await bodySetSignatureAsync(item, html);
        return true;
    } catch (err) {
        console.error("[CardByte] setSignatureAsync failed:", err);
        showNotification(item, "Signature could not be applied. Please contact Admin.", "errorMessage", false);
        return false;
    }
}

// =============================================================================
//  CORE SIGNATURE ORCHESTRATOR
// =============================================================================

async function applySignatureCore(item, mailbox, opts = {}, isSendTime = false) {
    const t0 = Date.now();
    const { fetchIfMissing = false, skipTtl = false, skipSessionCheck = false, overrideHtml = null } = opts;
    const userEmail = mailbox?.userProfile?.emailAddress;

    let html = overrideHtml;
    let explicitlyUnassigned = false;

    if (!html) html = getCachedSignature({ skipTtl, skipSessionCheck });

    if (!html && fetchIfMissing && userEmail) {
        notifyWithTiming(item, "Fetching signature...", t0);

        let attempt = 0;
        while (attempt <= MAX_RETRIES) {
            try {
                if (attempt > 0) {
                    console.warn(`[CardByte] Retry ${attempt}/${MAX_RETRIES}...`);
                    await new Promise(r => setTimeout(r, 1000 * attempt));
                }
                const { html: fetched, explicit } = await renderSignatureOnServer(userEmail);
                if (fetched) {
                    html = fetched;
                    CACHED_SIGNATURE_HTML = html;
                    setCachedSignature(html);
                    notifyWithTiming(item, "Signature fetched ✓", t0);
                    break;
                }
                if (explicit) {
                    // Server explicitly says "no signature assigned" — this is
                    // the ONE case where we hard-delete the cached copy.
                    explicitlyUnassigned = true;
                    store.remove(CACHE_KEY, CACHE_SESSION_KEY, CACHE_TIMESTAMP_KEY);
                    break;
                }
            } catch (err) {
                console.warn(`[CardByte] Fetch attempt ${attempt + 1} failed:`, err);
            }
            attempt++;
        }
    }

    if (!html && !explicitlyUnassigned) {
        const stale = getCachedSignature({ skipTtl: true, skipSessionCheck: true });
        if (stale) {
            console.warn("[CardByte] Using stale signature cache as last resort");
            html = stale;
            notifyWithTiming(item, "Using stale cache ✓", t0);
        }
    }

    if (!html) {
        console.error("[CardByte] No signature available — aborting");
        removeNotification(item);
        showNotification(item, "Signature not available. Please contact Admin.", "errorMessage", false);
        logTiming("applySignatureCore (no signature)", t0);
        return;
    }

    notifyWithTiming(item, "Applying signature...", t0);
    await applySignatureWithFallback(item, html, isSendTime);
    notifyWithTiming(item, "Signature applied ✓", t0);
    setTimeout(() => removeNotification(item), 3000);
    logTiming("applySignatureCore total", t0);
}

// =============================================================================
//  RECIPIENT-CHANGE HANDLER
// =============================================================================

async function onRecipientsChanged(item, mailbox) {
    if (await getManualOverride(item)) {
        console.log("[CardByte] Manual override active — skipping rule re-eval on recipient change");
        return;
    }

    const matched = await findMatchingRule(item);

    if (matched) {
        console.log(`[CardByte] 🎯 Rule matched → "${matched.rule ?? matched.description}" | signatureId: ${matched.signatureId}`);

        const userEmail = Office?.context?.mailbox?.userProfile?.emailAddress;
        const xPlatform = getXPlatform();
        const encryptedMail = await encryptEmail(userEmail);

        const ruleHtml = await getOrFetchSignatureById(matched.signatureId, encryptedMail, xPlatform);
        if (!ruleHtml) {
            console.warn("[CardByte] Rule signature fetch returned null — keeping current signature");
            return;
        }
        console.log("[CardByte] Injecting rule-matched signature, signatureId:", matched.signatureId);
        const applied = await applySignatureWithFallback(item, ruleHtml, false);
        if (applied) {
            _activeSignatureId = String(matched.signatureId);
            // Persist so the (possibly fresh) send-time runtime knows what's
            // actually in the body even if recipients can't be read there.
            setActiveSignatureId(matched.signatureId);
        }

    } else {
        console.warn("[CardByte] No rule matched / empty recipients — falling back to default signature");
        _activeSignatureId = null;
        setActiveSignatureId(null);
        await applySignatureCore(item, mailbox, { fetchIfMissing: true }, false);
    }
}

// =============================================================================
//  RECIPIENT POLLING (Desktop only)
// =============================================================================

let _lastRecipientSnapshot = "";
let _recipientPollTimer = null;

let _activeSignatureId = null;

function serializeRecipients(emails) {
    return [...emails].sort().join(",");
}

async function pollRecipients() {
    const mailbox = Office?.context?.mailbox;
    const item = mailbox?.item;
    if (!item) return;

    const emails = await getAllRecipientEmails(item);
    const snapshot = serializeRecipients(emails);

    if (snapshot === _lastRecipientSnapshot) return;
    _lastRecipientSnapshot = snapshot;

    console.log("[CardByte] 🔄 Recipient change detected via poll:", emails);
    await onRecipientsChanged(item, mailbox);
}

function startRecipientPolling() {
    if (_recipientPollTimer) return;
    if (isMobile()) {
        console.log("[CardByte] 📵 Recipient polling disabled on mobile");
        return;
    }
    console.log("[CardByte] 📡 Starting recipient polling...");
    _recipientPollTimer = setInterval(pollRecipients, RECIPIENT_POLL_MS);
}

function stopRecipientPolling() {
    if (_recipientPollTimer) {
        clearInterval(_recipientPollTimer);
        _recipientPollTimer = null;
    }
}

// =============================================================================
//  TIMEOUT WRAPPER
// =============================================================================

function withTimeout(promise, ms) {
    return Promise.race([
        promise,
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms)
        ),
    ]);
}

// =============================================================================
//  SEND-TIME CORE
//  Send time is 100% cache-only. All reads bypass TTL AND session checks
//  because OnMessageSend may run in a fresh runtime with a new session id.
// =============================================================================

const SIGNATURE_SENTINEL = "cardbyte-sig";
const MANUAL_OVERRIDE_PROP = "cardbyte_manual_sig_id";

function loadCustomProps(item) {
    return new Promise((resolve) => {
        if (typeof item?.loadCustomPropertiesAsync !== "function") return resolve(null);
        try {
            item.loadCustomPropertiesAsync((res) =>
                resolve(res.status === Office.AsyncResultStatus.Succeeded ? res.value : null)
            );
        } catch { resolve(null); }
    });
}

async function getManualOverride(item) {
    const props = await loadCustomProps(item);
    const id = props?.get(MANUAL_OVERRIDE_PROP);
    return id ? String(id) : null;
}

// Resolves the override id to HTML (cache-first, network fallback for rule sigs)
async function resolveOverrideHtml(overrideId, mailbox) {
    if (overrideId === "default") {
        return getCachedSignature({ skipTtl: true, skipSessionCheck: true });
    }
    let html = getSigById(overrideId, { skipTtl: true });
    if (!html) {
        const enc = await encryptEmail(mailbox?.userProfile?.emailAddress);
        html = await getOrFetchSignatureById(overrideId, enc, getXPlatform(), { skipTtl: true });
    }
    return html;
}

async function _onSendCore(item, mailbox) {
    const t0 = Date.now();
    notifyWithTiming(item, "Re-applying correct signature...", t0);

    // ─── Manual taskpane selection wins at send time ───
    const overrideId = await getManualOverride(item);
    if (overrideId) {
        const html = await resolveOverrideHtml(overrideId, mailbox);
        if (html) {
            await applySignatureWithFallback(item, html, false);
            notifyWithTiming(item, "Manual signature kept ✓", t0);
            logTiming("_onSendCore (manual override)", t0);
            return;
        }
        console.warn("[CardByte] Override id set but html unavailable — falling back to rules");
    }

    // Send-time: cache-only, bypass TTL AND session checks (fresh runtime safe)
    const rulesJson = getCachedRules({ skipTtl: true, skipSessionCheck: true });

    if (rulesJson) {
        const matched = await findMatchingRule(item, { cacheOnly: true });

        if (matched) {
            console.log(`[CardByte] onSend: rule matched id=${matched.signatureId}`);

            const ruleHtml = getSigById(String(matched.signatureId), { skipTtl: true });

            if (ruleHtml) {
                console.log(`[CardByte] onSend: injecting rule sig id=${matched.signatureId} from cache`);
                await applySignatureWithFallback(item, ruleHtml, false);
                notifyWithTiming(item, "Rule signature applied ✓", t0);
                logTiming("_onSendCore (rule)", t0);
                return;
            }
            console.warn(`[CardByte] onSend: rule sig id=${matched.signatureId} not in cache — trying last-applied signature`);
        } else {
            console.log("[CardByte] onSend: no rule matched (or recipients unreadable) — trying last-applied signature");
        }
    } else {
        console.warn("[CardByte] onSend: no rules in cache — trying last-applied signature");
    }

    // ─── Cross-runtime fallback (all platforms, not just Mac) ───
    // If rule evaluation was inconclusive at send time (recipients unreadable,
    // rules missing, or the matched sig HTML absent), trust the persisted
    // record of the signature that was actually applied during compose.
    // The body already contains it; re-applying is a no-op safety measure.
    const persistedActiveId = getActiveSignatureId();
    if (persistedActiveId) {
        console.warn("[CardByte] onSend: falling back to persisted active signature id:", persistedActiveId);
        const activeHtml = getSigById(persistedActiveId, { skipTtl: true });
        if (activeHtml) {
            await applySignatureWithFallback(item, activeHtml, false);
            notifyWithTiming(item, "Rule signature applied ✓ (persisted fallback)", t0);
            logTiming("_onSendCore (persisted fallback)", t0);
            return;
        }
        // HTML not cached but a rule signature IS in the body — do NOT
        // overwrite it with the default. Leave the body untouched.
        console.warn("[CardByte] onSend: active sig HTML not cached — leaving body as-is (rule sig already applied at compose)");
        removeNotification(item);
        logTiming("_onSendCore (leave as-is)", t0);
        return;
    }

    // No rule signature was ever active → default is genuinely correct.
    const cached = getCachedSignature({ skipTtl: true, skipSessionCheck: true });
    if (!cached) {
        showNotification(item, "No cached signature on send", "errorMessage", false, t0);
        logTiming("_onSendCore (no sig)", t0);
        return;
    }

    console.log("[CardByte] onSend: injecting default sig from cache");
    await applySignatureWithFallback(item, cached, false);
    notifyWithTiming(item, "Signature applied ✓", t0);
    logTiming("_onSendCore (default)", t0);
}

// =============================================================================
//  OFFICE READY
// =============================================================================

Office.onReady(() => {
    console.log("✅ Office.onReady Started");
    console.log(`[CardByte] Platform: ${detectPlatform()}`);
    purgeStaleSigById();
});

// =============================================================================
//  PUBLIC ENTRY POINTS
// =============================================================================

const applySignature = async function (event = { completed: () => { } }) {
    const t0 = Date.now();
    const mailbox = Office?.context?.mailbox;
    const item = mailbox?.item;

    try {
        if (!item) return;

        notifyWithTiming(item, "Starting signature flow...", t0);

        _activeSignatureId = null;
        setActiveSignatureId(null);

        // ─── Refresh rules cache (same pattern as signature) ─────────────────
        const userEmail = mailbox?.userProfile?.emailAddress;
        if (userEmail) {
            const enc = await encryptEmail(userEmail);
            const rulesFresh = getCachedRules(); // checks TTL + session
            if (!rulesFresh) {
                console.log("[CardByte] Rules cache missing/expired — fetching fresh rules...");
                await fetchAndCacheRules(enc, getXPlatform());
            } else {
                console.log("[CardByte] Rules cache still valid — skipping fetch");
            }
        }
        // ─────────────────────────────────────────────────────────────────────

        await applySignatureCore(item, mailbox, { fetchIfMissing: true }, false);

        if (userEmail && !isMobile()) {
            prefetchAllRuleSignatures(userEmail).catch(err =>
                console.warn("[CardByte] Background prefetch failed:", err)
            );
        }

        const emails = await getAllRecipientEmails(item);
        if (emails.length > 0) {
            _lastRecipientSnapshot = serializeRecipients(emails);
            await onRecipientsChanged(item, mailbox);
        }

        if (!isMobile()) {
            startRecipientPolling();
        }

    } catch (err) {
        console.error("[CardByte] applySignature error:", err);
    } finally {
        logTiming("applySignature total", t0);
        event.completed();
    }
};

const onSendHandler = async function (event = { completed: () => { } }) {
    const t0 = Date.now();
    const mailbox = Office?.context?.mailbox;
    const item = mailbox?.item;

    const done = (allow = true) => {
        logTiming("onSendHandler total", t0);
        event.completed({ allowEvent: allow });
    };

    try {
        if (!item) { done(true); return; }

        stopRecipientPolling();

        notifyWithTiming(item, "Verifying before send...", t0);

        await withTimeout(_onSendCore(item, mailbox), 4000);

        notifyWithTiming(item, "Send verification complete ✓", t0);
        setTimeout(() => removeNotification(item), 3000);

    } catch (err) {
        console.warn("[CardByte] onSend timeout/error:", err.message);
        showNotification(item, "Send timeout/error", "errorMessage", true, t0);
    } finally {
        done(true);
    }
};

const onFromChangedHandler = async function (event = { completed: () => { } }) {
    const t0 = Date.now();
    const mailbox = Office?.context?.mailbox;
    const item = mailbox?.item;

    try {
        if (!item) { event.completed(); return; }

        console.log("[CardByte] onFromChangedHandler: account changed, re-evaluating rules...");
        notifyWithTiming(item, "Account changed — updating signature...", t0);

        _activeSignatureId = null;
        setActiveSignatureId(null);

        // Also refresh rules when account changes — sender context changed
        const userEmail = mailbox?.userProfile?.emailAddress;
        if (userEmail) {
            const enc = await encryptEmail(userEmail);
            await fetchAndCacheRules(enc, getXPlatform());
        }

        const emails = await getAllRecipientEmails(item);
        if (emails.length > 0) {
            _lastRecipientSnapshot = serializeRecipients(emails);
            await onRecipientsChanged(item, mailbox);
        } else {
            await applySignatureCore(item, mailbox, { fetchIfMissing: true }, false);
        }

        notifyWithTiming(item, "Signature updated ✓", t0);
        setTimeout(() => removeNotification(item), 3000);

    } catch (err) {
        console.error("[CardByte] onFromChangedHandler error:", err);
    } finally {
        logTiming("onFromChangedHandler total", t0);
        event.completed();
    }
};

const onRecipientsChangedHandler = async function (event = { completed: () => { } }) {
    const t0 = Date.now();
    const mailbox = Office?.context?.mailbox;
    const item = mailbox?.item;

    try {
        if (!item) { event.completed(); return; }

        console.log("[CardByte] onRecipientsChangedHandler: recipients changed, re-evaluating rules...");

        const emails = await getAllRecipientEmails(item);
        const snapshot = serializeRecipients(emails);

        if (snapshot === _lastRecipientSnapshot) {
            console.log("[CardByte] Recipients unchanged — skipping");
            event.completed();
            return;
        }
        _lastRecipientSnapshot = snapshot;

        await onRecipientsChanged(item, mailbox);

    } catch (err) {
        console.error("[CardByte] onRecipientsChangedHandler error:", err);
    } finally {
        logTiming("onRecipientsChangedHandler total", t0);
        event.completed();
    }
};

// =============================================================================
//  REGISTER OFFICE ACTIONS
// =============================================================================

if (typeof Office !== "undefined" && typeof Office.actions !== "undefined") {
    Office.actions.associate("applySignature", applySignature);
    Office.actions.associate("onSendHandler", onSendHandler);
    Office.actions.associate("onFromChangedHandler", onFromChangedHandler);
    Office.actions.associate("onRecipientsChangedHandler", onRecipientsChangedHandler);
    console.log("[CardByte] Registered: applySignature, onSendHandler, onFromChangedHandler, onRecipientsChangedHandler");
} else {
    console.log("[CardByte] Office.actions unavailable — LaunchEvent path inactive (Outlook 2016/2019)");
}