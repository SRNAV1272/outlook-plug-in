"use strict";

// =============================================================================
//  CardByte Outlook Add-in — event-handler-classic.js
//  Base: event-handler-classic (doc 2) — timing, notifications, withTimeout guard
//  Added: Rules selector engine + recipient polling (from event-handler doc 1)
//         + empty-recipients fallback to default signature
// =============================================================================

// ─── Constants ────────────────────────────────────────────────────────────────

const AES_KEY = "fnItrY2YfozBqCC2B4XsfqHIvZku3kUOq3DFkbO64kk=";
const AES_IV = "3YapeNfJDung7TXxeKXn4g==";

const BASE_URL = "https://newqa-enterprise.cardbyte.ai/email-signature";

// localStorage / sessionStorage keys
const SESSION_KEY = "cardbyte_session_id";
const CACHE_KEY = "cardbyte_cached_signature";
const CACHE_SESSION_KEY = "cardbyte_cached_signature_session";
const CACHE_TIMESTAMP_KEY = "cardbyte_cached_signature_ts";
const CACHE_TTL_MS = 5 * 60 * 1000;

const RULES_CACHE_KEY = "cardbyte_cached_rules";
const RULES_CACHE_TIMESTAMP_KEY = "cardbyte_cached_rules_ts";
const RULES_CACHE_TTL_MS = 5 * 60 * 1000;

// Per-signatureId HTML cache  { [signatureId]: { html, ts } }
const SIG_BY_ID_CACHE_KEY = "cardbyte_sig_by_id";
const SIG_BY_ID_TTL_MS = 5 * 60 * 1000;

const MAX_SAFE_HTML_SIZE = 500_000;
const MAX_SAFE_HTML_SIZE_MOBILE = 200_000;
const HEAVY_THRESHOLD = 100 * 1024;   // 100 KB
const MAX_RETRIES = 2;
const RECIPIENT_POLL_MS = 1500;

const NOTIF_KEY = "cardbyte_sig_status";
const NOTIF_KEY_HEAVY = "cardbyte_sig_heavy";

// In-memory fast path
let CACHED_SIGNATURE_HTML = null;

// =============================================================================
//  TIMING LOGGER  (doc 2)
// =============================================================================

function logTiming(label, startMs) {
    const elapsed = Date.now() - startMs;
    console.log(`[CardByte] ⏱ ${label}: ${elapsed}ms`);
}

// =============================================================================
//  PLATFORM DETECTION  (doc 1 — unified)
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
    if (p === "mac") return "MAC";
    if (p === "mobile-ios" || p === "mobile-android") return "MOBILE";
    return "WINDOWS";
}

// =============================================================================
//  NOTIFICATION HELPERS  (doc 2 — icon:"none" OWA-safe variant)
// =============================================================================

function showNotification(item, message, type = "informationalMessage", persistent = false, startMs = null) {
    try {
        if (!item || typeof item.notificationMessages?.addAsync !== "function") return;

        let finalMessage = message;
        if (startMs) finalMessage += ` (${Date.now() - startMs}ms)`;
        if (finalMessage.length > 140) finalMessage = finalMessage.slice(0, 137) + "...";

        const details = {
            type,
            message: finalMessage,
            icon: "none",        // required by OWA notification validator
            persistent,
        };

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
//  CRYPTO — AES-CBC via Web Crypto API  (doc 2)
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
//  STORAGE HELPERS  (doc 1 — consolidated store object)
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
//  DEFAULT SIGNATURE CACHE  (doc 2 logic, store helper)
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
        console.log("[CardByte] New session detected — clearing cache");
        store.remove(CACHE_KEY, CACHE_SESSION_KEY, CACHE_TIMESTAMP_KEY);
        logTiming("getCachedSignature (session mismatch)", t0);
        return null;
    }

    if (!skipTtl) {
        const ts = parseInt(store.get(CACHE_TIMESTAMP_KEY) || "0", 10);
        if (Date.now() - ts > CACHE_TTL_MS) {
            console.log("[CardByte] Cache TTL expired — clearing");
            store.remove(CACHE_KEY, CACHE_SESSION_KEY, CACHE_TIMESTAMP_KEY);
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
//  RULES CACHE  (doc 1)
// =============================================================================

function getCachedRules({ skipTtl = false } = {}) {
    if (!skipTtl) {
        const ts = parseInt(store.get(RULES_CACHE_TIMESTAMP_KEY) || "0", 10);
        if (Date.now() - ts > RULES_CACHE_TTL_MS) {
            console.log("[CardByte] Rules cache TTL expired");
            store.remove(RULES_CACHE_KEY, RULES_CACHE_TIMESTAMP_KEY);
            return null;
        }
    }
    return store.getJson(RULES_CACHE_KEY);
}

function setCachedRules(rulesJson) {
    store.setJson(RULES_CACHE_KEY, rulesJson);
    store.set(RULES_CACHE_TIMESTAMP_KEY, Date.now().toString());
}

// =============================================================================
//  PER-SIGNATURE-ID HTML CACHE  (doc 1)
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

function purgeStaleSigById() {
    const map = _readSigByIdMap();
    const now = Date.now();
    let purged = 0;
    for (const id of Object.keys(map)) {
        if (now - map[id].ts > SIG_BY_ID_TTL_MS) { delete map[id]; purged++; }
    }
    if (purged > 0) {
        _writeSigByIdMap(map);
        console.log(`[CardByte] purgeStaleSigById: removed ${purged} stale entries`);
    }
}

// =============================================================================
//  API LAYER  (doc 2 renderSignatureOnServer + doc 1 rules/sigById fetchers)
// =============================================================================

/** Decrypts raw API response text and extracts the html field. */
async function decryptHtmlResponse(rawText) {
    const decrypted = await handleAesDecrypt(rawText);
    return JSON.parse(decrypted)?.html || null;
}

/** Fetches and caches the active rules config. */
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

/**
 * Primary signature fetch — doc 2's renderSignatureOnServer adapted to return
 * { html, explicit } so callers can distinguish "empty assigned" vs "network error".
 */
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

/**
 * Fetches the HTML for a specific signatureId — no cache logic.
 * Use getOrFetchSignatureById for cache-first access.
 */
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

/**
 * Cache-first wrapper: hit → returns cached HTML; miss → fetches, stores, returns.
 * All compose/reply/forward windows sharing SharedRuntime localStorage see the same map.
 */
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

/**
 * Prefetches and caches the HTML for every enabled rule's signatureId in parallel.
 * Called at compose-open so recipient-change lookups are instant cache hits.
 */
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
//  RECIPIENT HELPERS  (doc 1)
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
//  RULES MATCHING ENGINE  (doc 1)
// =============================================================================

const _composeTypeByItem = new WeakMap();

function getComposeType(item) {
    if (_composeTypeByItem.has(item)) return Promise.resolve(_composeTypeByItem.get(item));
    return new Promise((resolve) => {
        if (typeof item?.getComposeTypeAsync !== "function") {
            console.warn("[CardByte] getComposeTypeAsync not available — filter disabled");
            resolve(null);
            return;
        }
        item.getComposeTypeAsync((result) => {
            if (result.status !== Office.AsyncResultStatus.Succeeded) {
                console.warn("[CardByte] getComposeTypeAsync failed:", result.error?.message);
                resolve(null);
                return;
            }
            const raw = (result.value?.composeType || "").toLowerCase();
            const normalized = raw === "newmail" ? "compose" : (raw === "reply" || raw === "forward") ? "reply" : null;
            _composeTypeByItem.set(item, normalized);
            console.log("[CardByte] composeType resolved:", raw, "→", normalized);
            resolve(normalized);
        });
    });
}

function getDomain(email) {
    const at = (email || "").lastIndexOf("@");
    return at === -1 ? "" : email.slice(at + 1).toLowerCase();
}

function classifyRecipients(senderEmail, recipientEmails) {
    const senderDomain = getDomain(senderEmail);
    if (!senderDomain || recipientEmails.length === 0) return null;
    return recipientEmails.every(e => getDomain(e) === senderDomain) ? "internal" : "external";
}

async function findMatchingRule(item) {
    let rulesJson = getCachedRules();

    if (!rulesJson) {
        console.warn("[CardByte] Rules not in cache — live fetch...");
        const userEmail = Office?.context?.mailbox?.userProfile?.emailAddress;
        if (userEmail) {
            const enc = await encryptEmail(userEmail);
            rulesJson = await fetchAndCacheRules(enc, getXPlatform());
        }
        if (!rulesJson) { console.warn("[CardByte] findMatchingRule: no rules available"); return null; }
    }

    const senderEmail = Office?.context?.mailbox?.userProfile?.emailAddress;
    const [emails, composeType] = await Promise.all([getAllRecipientEmails(item), getComposeType(item)]);

    if (emails.length === 0) {
        console.warn("[CardByte] No recipients — cannot match rules (will fallback to default)");
        return null;
    }

    const recipientType = classifyRecipients(senderEmail, emails);

    const enabledRules = (rulesJson?.rulesList || [])
        .filter(r => r.enabled)
        .filter(r => r?.context === composeType || r?.context === "all")
        .filter(r => r?.recipientType === recipientType || r?.recipientType === "all")
        .sort((a, b) => a.priority - b.priority);

    console.log("[CardByte] Selector engine:", { composeType, recipientType, emails, enabledRules });

    const matched = enabledRules[0] || null;
    if (matched) {
        console.log(`[CardByte] ✅ Matched rule: "${matched.rule}" (priority ${matched.priority}) → signatureId: ${matched.signatureId}`);
    } else {
        console.warn("[CardByte] ❌ No rules matched", { composeType, recipientType });
    }
    return matched;
}

// =============================================================================
//  SIGNATURE INJECTION  (doc 2 body helpers + doc 1 heavy-sig logic)
// =============================================================================

function getBodyText(item) {
    return new Promise((resolve) => {
        const t0 = Date.now();
        item.body.getAsync(Office.CoercionType.Html, (result) => {
            logTiming("getBodyText", t0);
            resolve(result.status === "succeeded" ? (result.value || "") : "");
        });
    });
}

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

function bodySetSelectedDataAsync(item, html) {
    return new Promise((resolve, reject) => {
        if (typeof item.body.setSelectedDataAsync !== "function") {
            reject(new Error("setSelectedDataAsync not available"));
            return;
        }
        item.body.setSelectedDataAsync(html, { coercionType: Office.CoercionType.Html }, (r) => {
            r.status === Office.AsyncResultStatus.Succeeded ? resolve() : reject(r.error);
        });
    });
}

/**
 * Injects HTML into the compose body.
 * Mobile            → setSelectedDataAsync (setSignatureAsync not supported).
 * Desktop/OWA/Mac:
 *   Light (<100 KB) → setSignatureAsync directly.
 *   Heavy (≥100 KB) → cursor trick (setSignatureAsync("") + setSelectedDataAsync).
 */
async function applySignatureWithFallback(item, html, isSendTime = false) {
    const htmlSize = new Blob([html]).size;
    console.log("[CardByte] Signature size:", htmlSize, "bytes");

    if (isMobile()) {
        const maxSize = getMaxHtmlSize();
        if (htmlSize > maxSize) {
            console.warn(`[CardByte] Signature too large for mobile (${htmlSize} > ${maxSize})`);
            showNotification(item, "Signature too large for this device. Please contact Admin.", "errorMessage", false);
            return false;
        }
        try {
            removeNotification(item);
            await bodySetSelectedDataAsync(item, html);
            console.log("[CardByte] Mobile signature inserted via setSelectedDataAsync");
            return true;
        } catch (err) {
            console.error("[CardByte] Mobile signature insertion failed:", err);
            showNotification(item, "Signature could not be inserted. Please contact Admin.", "errorMessage", false);
            return false;
        }
    }

    // Light path
    if (htmlSize < HEAVY_THRESHOLD) {
        removeNotification(item);
        await bodySetSignatureAsync(item, html);
        return true;
    }

    // Heavy path
    console.warn(`[CardByte] Heavy signature (${htmlSize} bytes) — isSendTime=${isSendTime}`);
    if (isSendTime) {
        console.log("[CardByte] Heavy signature at send time — skipping (already in body)");
        removeNotification(item);
        return false;
    }
    try {
        await bodySetSignatureAsync(item, "");
        await bodySetSelectedDataAsync(item, html);
        removeNotification(item);
        console.log("[CardByte] Heavy signature inserted via cursor trick");
        return true;
    } catch (err) {
        console.error("[CardByte] Heavy path insertion failed:", err);
        showNotification(item, "Your signature is large and could not be inserted. Please contact Admin.", "errorMessage", true);
        return false;
    }
}

// =============================================================================
//  CORE SIGNATURE ORCHESTRATOR  (doc 2 _applySignatureCore, adapted)
// =============================================================================

/**
 * Resolves the correct signature HTML (cache → server → stale fallback)
 * and injects it into the compose body.
 *
 * @param {object}  item
 * @param {object}  mailbox
 * @param {object}  opts
 * @param {boolean} opts.fetchIfMissing
 * @param {boolean} opts.skipTtl
 * @param {boolean} opts.skipSessionCheck
 * @param {string|null} opts.overrideHtml   - inject this HTML directly (rule-matched)
 * @param {boolean} isSendTime
 */
async function applySignatureCore(item, mailbox, opts = {}, isSendTime = false) {
    const t0 = Date.now();
    const { fetchIfMissing = false, skipTtl = false, skipSessionCheck = false, overrideHtml = null } = opts;
    const userEmail = mailbox?.userProfile?.emailAddress;

    // ── 1. Determine which HTML to use ────────────────────────────────────
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
                    // Server explicitly said no signature — stop retrying
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

    // ── 2. Stale-cache last resort ────────────────────────────────────────
    if (!html && !explicitlyUnassigned) {
        const stale = getCachedSignature({ skipTtl: true, skipSessionCheck: true });
        if (stale) {
            console.warn("[CardByte] Using stale cache as last resort");
            html = stale;
            notifyWithTiming(item, "Using stale cache ✓", t0);
        }
    }

    // ── 3. Inject or bail ─────────────────────────────────────────────────
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
//  RECIPIENT-CHANGE HANDLER  (doc 1 + empty-recipients fallback fix)
// =============================================================================

/**
 * Called whenever a recipient change is detected (poll tick or native event).
 *
 * Flow:
 *   • recipients present → run rules selector → inject matched signature
 *                          (no rule matched → fall back to default)
 *   • recipients empty   → fall back to default signature
 *
 * @param {object} item
 * @param {object} mailbox   - needed for the default-signature fallback path
 */
async function onRecipientsChanged(item, mailbox) {
    const matched = await findMatchingRule(item);

    if (matched) {
        console.log(`[CardByte] 🎯 Rule matched → "${matched.rule}" | signatureId: ${matched.signatureId}`);

        const userEmail = Office?.context?.mailbox?.userProfile?.emailAddress;
        const xPlatform = getXPlatform();
        const encryptedMail = await encryptEmail(userEmail);

        // Cache-first: instant hit if prefetchAllRuleSignatures already ran
        const ruleHtml = await getOrFetchSignatureById(matched.signatureId, encryptedMail, xPlatform);
        if (!ruleHtml) {
            console.warn("[CardByte] Rule signature fetch returned null — keeping current signature");
            return;
        }
        console.log("[CardByte] Injecting rule-matched signature");
        await applySignatureWithFallback(item, ruleHtml, false);

    } else {
        // No rule matched OR recipient list is empty → restore default signature
        console.warn("[CardByte] No rule matched / empty recipients — falling back to default signature");
        await applySignatureCore(item, mailbox, { fetchIfMissing: true }, false);
    }
}

// =============================================================================
//  RECIPIENT POLLING — OWA fallback  (doc 1 + empty-recipients fallback)
// =============================================================================

let _lastRecipientSnapshot = "";
let _recipientPollTimer = null;

function serializeRecipients(emails) {
    return [...emails].sort().join(",");
}

async function pollRecipients() {
    const mailbox = Office?.context?.mailbox;
    const item = mailbox?.item;
    if (!item) return;

    const emails = await getAllRecipientEmails(item);
    const snapshot = serializeRecipients(emails);

    if (snapshot === _lastRecipientSnapshot) return; // no change
    _lastRecipientSnapshot = snapshot;

    console.log("[CardByte] 🔄 Recipient change detected via poll:", emails);

    // Pass mailbox so onRecipientsChanged can reach applySignatureCore
    // for the empty-recipients / no-rule-match fallback path
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
//  TIMEOUT WRAPPER  (doc 2 — guards the send event against Outlook's deadline)
// =============================================================================

/**
 * Races `promise` against a ms-millisecond rejection.
 * Used in onSendHandler so event.completed() is always called within
 * Outlook's OnMessageSend wall-clock deadline (no error dialog).
 */
function withTimeout(promise, ms) {
    return Promise.race([
        promise,
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms)
        ),
    ]);
}

// =============================================================================
//  SEND-TIME CORE  (doc 2)
// =============================================================================

const SIGNATURE_SENTINEL = "cardbyte-sig";

async function _onSendCore(item, mailbox) {
    const t0 = Date.now();
    const bodyHtml = await getBodyText(item);

    if (bodyHtml.includes(SIGNATURE_SENTINEL)) {
        notifyWithTiming(item, "Signature already present ✓", t0);
        return;
    }

    const cached = getCachedSignature({ skipTtl: true, skipSessionCheck: true });
    if (!cached) {
        showNotification(item, "No cached signature on send", "errorMessage", false, t0);
        return;
    }

    notifyWithTiming(item, "Re-applying signature...", t0);
    await applySignatureCore(item, mailbox, { fetchIfMissing: false, skipTtl: true, skipSessionCheck: true }, true);
    notifyWithTiming(item, "Signature verified ✓", t0);
    logTiming("_onSendCore", t0);
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

/**
 * applySignature — LaunchEvent handler (new compose / reply / forward)
 *
 * 1. Injects the default signature (fetches rules + primary in parallel).
 * 2. Prefetches all rule signatures in the background.
 * 3. Runs an initial recipient check (handles pre-filled To fields).
 * 4. Starts recipient polling (OWA safety net).
 */
const applySignature = async function (event = { completed: () => { } }) {
    const t0 = Date.now();
    const mailbox = Office?.context?.mailbox;
    const item = mailbox?.item;

    try {
        if (!item) return;

        notifyWithTiming(item, "Starting signature flow...", t0);

        // Inject default signature
        await applySignatureCore(item, mailbox, { fetchIfMissing: true }, false);

        const userEmail = mailbox?.userProfile?.emailAddress;

        // Prefetch all rule signatures in background (non-blocking)
        if (userEmail && !isMobile()) {
            prefetchAllRuleSignatures(userEmail).catch(err =>
                console.warn("[CardByte] Background prefetch failed:", err)
            );
        }

        // Initial recipient check — handles compose opening with a pre-filled To.
        // Skip on mobile: polling is disabled and setSelectedDataAsync would
        // duplicate the signature already inserted above.
        if (!isMobile()) {
            const emails = await getAllRecipientEmails(item);
            if (emails.length > 0) {
                _lastRecipientSnapshot = serializeRecipients(emails);
                await onRecipientsChanged(item, mailbox);
            }
        }

        // Start polling as OWA / fallback safety net
        startRecipientPolling();

    } catch (err) {
        console.error("[CardByte] applySignature error:", err);
    } finally {
        logTiming("applySignature total", t0);
        event.completed();
    }
};

/**
 * onSendHandler — OnMessageSend handler
 *
 * Wrapped in withTimeout(4000) so event.completed({ allowEvent: true })
 * is always called within Outlook's deadline — no error dialog can appear.
 */
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

        // Stop polling — compose session is ending
        stopRecipientPolling();

        notifyWithTiming(item, "Verifying before send...", t0);

        await withTimeout(_onSendCore(item, mailbox), 4000);

        notifyWithTiming(item, "Send verification complete ✓", t0);
        setTimeout(() => removeNotification(item), 3000);

    } catch (err) {
        // Timeout or unexpected error — log and release the event immediately
        console.warn("[CardByte] onSend timeout/error:", err.message);
        showNotification(item, "Send timeout/error", "errorMessage", true, t0);
    } finally {
        done(true);   // always releases the send event; never blocks the user
    }
};

// =============================================================================
//  REGISTER OFFICE ACTIONS
// =============================================================================

if (typeof Office !== "undefined" && typeof Office.actions !== "undefined") {
    Office.actions.associate("applySignature", applySignature);
    Office.actions.associate("onSendHandler", onSendHandler);
    console.log("[CardByte] Registered: applySignature, onSendHandler");
} else {
    console.log("[CardByte] Office.actions unavailable — LaunchEvent path inactive (Outlook 2016/2019)");
}