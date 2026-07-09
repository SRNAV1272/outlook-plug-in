"use strict";

// =============================================================================
//  CardByte Outlook Add-in — event-handler.js  (v2 — universal runtime)
//
//  Runs unmodified on ALL Outlook surfaces:
//    • Classic Outlook on Windows  (JS-only runtime — no DOM/localStorage/Blob)
//    • New Outlook on Windows / OWA / Mac (WebView runtime)
//    • Outlook on iOS / Android    (WebView runtime, 60s hard cap, ephemeral)
//
//  Registered entry points (must match manifest FunctionName values):
//    applySignature              OnNewMessageCompose (1.10) + ribbon button
//    onRecipientsChangedHandler  OnMessageRecipientsChanged (1.11, mobile OK)
//    onFromChangedHandler        OnMessageFromChanged (1.13, mobile OK)
//    onSendHandler               OnMessageSend (1.12, SoftBlock — NOT mobile)
//
//  Design notes:
//    • Recipient POLLING is now a fallback only. The manifest registers
//      OnMessageRecipientsChanged which fires on every recipient edit on
//      Windows, Mac, OWA, iOS and Android. The first time that event fires,
//      polling is permanently disabled for the session.
//    • All signature writes are serialized through an apply-queue so that
//      OnNewMessageCompose / recipients-changed / from-changed can never
//      interleave setSignatureAsync calls.
//    • Storage is a tiered facade: localStorage → OfficeRuntime.storage
//      (classic Windows JS runtime) → in-memory. Same keys everywhere.
//    • Every network call has an AbortController timeout + bounded retry
//      with exponential backoff and jitter.
//    • Signature caches are namespaced PER SENDER EMAIL so multi-account
//      users (OnMessageFromChanged) never leak another account's signature.
// =============================================================================

// ─── Configuration ───────────────────────────────────────────────────────────

const CONFIG = Object.freeze({
    BASE_URL: "https://newqa-enterprise.cardbyte.ai/email-signature",

    // ⚠️ SECURITY — see "Enterprise hardening" notes shipped with this file.
    // A symmetric key + static IV embedded in client JS is obfuscation, not
    // security: anyone can extract it, and AES-CBC with a fixed IV produces
    // deterministic ciphertext. Plan a migration to bearer tokens obtained
    // via OfficeRuntime.auth.getAccessToken() (NAA/SSO) and let TLS protect
    // the payload. Kept here only because the current backend requires it.
    AES_KEY: "fnItrY2YfozBqCC2B4XsfqHIvZku3kUOq3DFkbO64kk=",
    AES_IV: "3YapeNfJDung7TXxeKXn4g==",

    CACHE_TTL_MS: 5 * 60 * 1000,          // default sig / rules / sig-by-id
    HTML_HARD_MAX_BYTES: 100 * 1024,       // matches signature-builder ceiling

    // Inline (base64 → CID) image conversion — see SIGNATURE INJECTION section
    INLINE_IMG_PREFIX: "cardbyte-inline-",
    INLINE_IMG_MAX: 10,

    FETCH_TIMEOUT_MS: 8000,
    FETCH_TIMEOUT_MS_MOBILE: 6000,         // mobile runtime is capped at 60s total
    MAX_RETRIES: 2,
    RETRY_BASE_DELAY_MS: 500,

    RECIPIENT_POLL_MS: 900,               // fallback only (legacy 1.10 clients)
    RECIPIENT_DEBOUNCE_MS: 700,
    PREFETCH_CONCURRENCY: 3,
    PREFETCH_BUDGET_MS_MOBILE: 5000,

    ONSEND_BUDGET_MS: 4000,
    HANDLER_BUDGET_MS_MOBILE: 30000,       // stay well under the 60s mobile cap

    NOTIF_KEY: "cardbyte_sig_status",
    SESSION_KEY: "cardbyte_session_id",

    // Console verbosity ONLY. User-facing notification-bar messages (timed
    // progress at every stage + errors) are ALWAYS shown regardless of DEBUG.
    DEBUG: false,
});

// ─── Logger ──────────────────────────────────────────────────────────────────

const log = {
    debug: (...a) => { if (CONFIG.DEBUG) console.log("[CardByte]", ...a); },
    info: (...a) => console.log("[CardByte]", ...a),
    warn: (...a) => console.warn("[CardByte]", ...a),
    error: (...a) => console.error("[CardByte]", ...a),
    timing(label, t0) { if (CONFIG.DEBUG) console.log(`[CardByte] ⏱ ${label}: ${Date.now() - t0}ms`); },
};

// =============================================================================
//  ENVIRONMENT / PLATFORM DETECTION
// =============================================================================

function detectPlatform() {
    const platform = (typeof Office !== "undefined" && Office?.context?.platform
        ? String(Office.context.platform) : "").toLowerCase();
    const ua = (typeof navigator !== "undefined" && navigator?.userAgent
        ? navigator.userAgent : "").toLowerCase();

    if (platform === "ios" || platform === "iphone" || platform === "ipad") return "mobile-ios";
    if (platform === "android") return "mobile-android";

    if (ua.includes("outlookmobile") || ua.includes("outlook-ios") || ua.includes("outlook-android"))
        return ua.includes("android") ? "mobile-android" : "mobile-ios";

    if ((platform === "officeonline" || platform === "web" || platform === "") &&
        (ua.includes("iphone") || ua.includes("ipad") || ua.includes("android")))
        return ua.includes("android") ? "mobile-android" : "mobile-ios";

    if (platform === "mac" ||
        ((platform === "" || platform === "desktop") &&
            (ua.includes("macintosh") || ua.includes("mac os x")) &&
            !ua.includes("iphone") && !ua.includes("ipad")))
        return "mac";

    if (platform === "officeonline" || platform === "web" || platform === "") return "owa";
    return "desktop";
}

const isMobile = () => { const p = detectPlatform(); return p === "mobile-ios" || p === "mobile-android"; };
const isMac = () => detectPlatform() === "mac";

// Classic Outlook (Windows) executes LaunchEvents in a JS-only runtime:
// no document, no localStorage, no Blob. Feature-detect, never assume.
const HAS_DOM = typeof document !== "undefined";
const HAS_LOCAL_STORAGE = (() => {
    try {
        if (typeof localStorage === "undefined") return false;
        const k = "__cb_probe__";
        localStorage.setItem(k, "1");
        localStorage.removeItem(k);
        return true;
    } catch (_) { return false; }
})();
const HAS_SESSION_STORAGE = (() => {
    try {
        if (typeof sessionStorage === "undefined") return false;
        const k = "__cb_probe__";
        sessionStorage.setItem(k, "1");
        sessionStorage.removeItem(k);
        return true;
    } catch (_) { return false; }
})();
const HAS_OFFICERUNTIME_STORAGE =
    typeof OfficeRuntime !== "undefined" && !!OfficeRuntime?.storage?.getItem;

function getXPlatform() {
    const p = detectPlatform();
    if (p === "mac") return "MAC";
    if (p === "mobile-ios" || p === "mobile-android") return "MOBILE";
    return "WINDOWS";
}

const fetchTimeoutMs = () => (isMobile() ? CONFIG.FETCH_TIMEOUT_MS_MOBILE : CONFIG.FETCH_TIMEOUT_MS);

// =============================================================================
//  STORAGE FACADE
//  Tier 1: localStorage (web / new Windows / Mac / mobile WebView)
//  Tier 2: OfficeRuntime.storage (classic Windows JS runtime) — async, so it
//          is hydrated into the in-memory map once at startup and mirrored
//          on every write (best effort).
//  Tier 3: in-memory map (always present; sole store on locked-down hosts)
// =============================================================================

const _mem = new Map();
let _storageReadyPromise = null;

const PERSISTED_PREFIXES = ["cardbyte_"]; // every key we persist starts with this

function _mirrorToOfficeRuntime(key, val) {
    if (!HAS_OFFICERUNTIME_STORAGE || HAS_LOCAL_STORAGE) return;
    try {
        if (val === null) OfficeRuntime.storage.removeItem(key).catch(() => { });
        else OfficeRuntime.storage.setItem(key, val).catch(() => { });
    } catch (_) { /* best effort */ }
}

/** Hydrate in-memory map from OfficeRuntime.storage (classic Windows only). */
function ensureStorageReady() {
    if (_storageReadyPromise) return _storageReadyPromise;
    _storageReadyPromise = (async () => {
        if (HAS_LOCAL_STORAGE || !HAS_OFFICERUNTIME_STORAGE) return;
        try {
            const keys = await OfficeRuntime.storage.getKeys();
            const wanted = (keys || []).filter(k => PERSISTED_PREFIXES.some(p => k.startsWith(p)));
            if (wanted.length === 0) return;
            const values = await OfficeRuntime.storage.getItems(wanted);
            for (const k of Object.keys(values || {})) {
                if (values[k] != null) _mem.set(k, values[k]);
            }
            log.debug(`storage hydrated ${wanted.length} key(s) from OfficeRuntime.storage`);
        } catch (e) {
            log.warn("OfficeRuntime.storage hydration failed:", e?.message || e);
        }
    })();
    return _storageReadyPromise;
}

const store = {
    get(key) {
        if (HAS_LOCAL_STORAGE) { try { return localStorage.getItem(key); } catch (_) { } }
        return _mem.has(key) ? _mem.get(key) : null;
    },
    set(key, val) {
        _mem.set(key, val);
        if (HAS_LOCAL_STORAGE) { try { localStorage.setItem(key, val); } catch (_) { } }
        _mirrorToOfficeRuntime(key, val);
    },
    remove(...keys) {
        for (const k of keys) {
            _mem.delete(k);
            if (HAS_LOCAL_STORAGE) { try { localStorage.removeItem(k); } catch (_) { } }
            _mirrorToOfficeRuntime(k, null);
        }
    },
    getJson(key) {
        const v = this.get(key);
        if (!v) return null;
        try { return JSON.parse(v); } catch (_) { return null; }
    },
    setJson(key, val) {
        try { this.set(key, JSON.stringify(val)); } catch (_) { }
    },
};

// ─── Session id (mobile-safe: sessionStorage may be unavailable/ephemeral) ──

let _memSessionId = null;

function getOrCreateSessionId() {
    try {
        if (HAS_SESSION_STORAGE) {
            let sid = sessionStorage.getItem(CONFIG.SESSION_KEY);
            if (!sid) {
                sid = (crypto?.randomUUID ? crypto.randomUUID() : Date.now().toString(36));
                sessionStorage.setItem(CONFIG.SESSION_KEY, sid);
            }
            return sid;
        }
    } catch (_) { /* fall through */ }
    if (!_memSessionId) _memSessionId = (crypto?.randomUUID ? crypto.randomUUID() : Date.now().toString(36));
    return _memSessionId;
}

// =============================================================================
//  NOTIFICATIONS — always visible, with elapsed-time suffix at every stage
//  (loading, API received, decrypted, applying, applied, send verification,
//  failures). CONFIG.DEBUG only controls console verbosity, never visibility.
// =============================================================================

function showNotification(item, message, type = "informationalMessage", persistent = false, startMs = null) {
    try {
        if (!item || typeof item.notificationMessages?.replaceAsync !== "function") return;
        let msg = String(message);
        if (startMs) msg += ` (${Date.now() - startMs}ms)`;
        if (msg.length > 140) msg = msg.slice(0, 137) + "...";
        const details = { type, message: msg, icon: "none", persistent };
        item.notificationMessages.replaceAsync(CONFIG.NOTIF_KEY, details, (result) => {
            try {
                if (result.status !== "succeeded" && typeof item.notificationMessages.addAsync === "function") {
                    item.notificationMessages.addAsync(CONFIG.NOTIF_KEY, details, (r) => {
                        if (r.status !== "succeeded")
                            log.warn("addAsync notification failed:", r.error?.message);
                    });
                }
            } catch (_) { }
        });
    } catch (e) {
        log.warn("showNotification threw, ignoring:", e?.message || e);
    }
}

function showError(item, message, startMs = null, persistent = false) {
    showNotification(item, message, "errorMessage", persistent, startMs);
}

/** Progress notification with elapsed time — always shown to the user. */
function notifyWithTiming(item, phase, startMs) {
    log.debug(`${phase}: ${Date.now() - startMs}ms`);
    showNotification(item, phase, "informationalMessage", false, startMs);
}

function removeNotification(item) {
    try {
        if (!item || typeof item.notificationMessages?.removeAsync !== "function") return;
        item.notificationMessages.removeAsync(CONFIG.NOTIF_KEY, () => { });
    } catch (_) { }
}

// =============================================================================
//  CRYPTO — AES-CBC via Web Crypto (legacy backend contract; see CONFIG note)
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
    try {
        if (!encryptedText) return "";
        const keyToUse = generatedKey || CONFIG.AES_KEY;

        let keyBuffer;
        try { keyBuffer = base64ToArrayBuffer(keyToUse); }
        catch (e) { log.error("Failed to decode key:", e); return encryptedText; }

        if (keyBuffer.byteLength !== 16 && keyBuffer.byteLength !== 32) {
            if (generatedKey && generatedKey !== CONFIG.AES_KEY) return handleAesDecrypt(encryptedText, CONFIG.AES_KEY);
            return encryptedText;
        }

        const ivBuffer = base64ToArrayBuffer(CONFIG.AES_IV);
        if (ivBuffer.byteLength !== 16) return encryptedText;

        const key = await crypto.subtle.importKey("raw", keyBuffer, { name: "AES-CBC" }, false, ["decrypt"]);

        let encryptedBuffer;
        try { encryptedBuffer = base64ToArrayBuffer(encryptedText); }
        catch (_) { return encryptedText; }

        const decrypted = await crypto.subtle.decrypt({ name: "AES-CBC", iv: ivBuffer }, key, encryptedBuffer);
        return new TextDecoder().decode(decrypted);
    } catch (_) {
        return encryptedText;
    }
}

const _encryptedEmailCache = new Map(); // email → ciphertext (deterministic anyway)

async function encryptEmail(email = "") {
    try {
        if (!email || email.trim() === "") return "";
        const norm = email.trim().toLowerCase();
        if (_encryptedEmailCache.has(norm)) return _encryptedEmailCache.get(norm);

        const keyBuffer = base64ToArrayBuffer(CONFIG.AES_KEY);
        const ivBuffer = base64ToArrayBuffer(CONFIG.AES_IV);
        const key = await crypto.subtle.importKey("raw", keyBuffer, { name: "AES-CBC" }, false, ["encrypt"]);
        const data = new TextEncoder().encode(norm);
        const encrypted = await crypto.subtle.encrypt({ name: "AES-CBC", iv: ivBuffer }, key, data);
        const result = arrayBufferToBase64(encrypted);
        _encryptedEmailCache.set(norm, result);
        return result;
    } catch (_) {
        return "";
    }
}

// =============================================================================
//  ACTIVE SENDER — supports OnMessageFromChanged / shared & delegate mailboxes
// =============================================================================

let _activeFromEmail = null; // set by onFromChangedHandler; null → userProfile

function getUserEmail() {
    return (_activeFromEmail ||
        Office?.context?.mailbox?.userProfile?.emailAddress ||
        "").toLowerCase();
}

/** Cache-key namespace so account A's signature is never served for account B. */
function emailNs(email) {
    return encodeURIComponent((email || getUserEmail() || "anon").toLowerCase());
}

// =============================================================================
//  CACHES (default signature, rules, per-signature-id HTML)
// =============================================================================

const K = {
    sig: (email) => `cardbyte_cached_signature::${emailNs(email)}`,
    sigSession: (email) => `cardbyte_cached_signature_session::${emailNs(email)}`,
    sigTs: (email) => `cardbyte_cached_signature_ts::${emailNs(email)}`,
    rules: (email) => `cardbyte_cached_rules::${emailNs(email)}`,
    rulesTs: (email) => `cardbyte_cached_rules_ts::${emailNs(email)}`,
    sigById: "cardbyte_sig_by_id",
};

function getCachedSignature({ skipTtl = false, skipSessionCheck = false, email = null } = {}) {
    const e = email || getUserEmail();

    if (skipSessionCheck) return store.get(K.sig(e));

    const currentSid = getOrCreateSessionId();
    if (store.get(K.sigSession(e)) !== currentSid) {
        log.debug("new session — clearing default-signature cache");
        store.remove(K.sig(e), K.sigSession(e), K.sigTs(e));
        return null;
    }

    if (!skipTtl) {
        const ts = parseInt(store.get(K.sigTs(e)) || "0", 10);
        if (Date.now() - ts > CONFIG.CACHE_TTL_MS) {
            log.debug("default-signature cache TTL expired");
            store.remove(K.sig(e), K.sigSession(e), K.sigTs(e));
            return null;
        }
    }
    return store.get(K.sig(e));
}

function setCachedSignature(html, email = null) {
    const e = email || getUserEmail();
    store.set(K.sig(e), html);
    store.set(K.sigSession(e), getOrCreateSessionId());
    store.set(K.sigTs(e), Date.now().toString());
}

function clearCachedSignature(email = null) {
    const e = email || getUserEmail();
    store.remove(K.sig(e), K.sigSession(e), K.sigTs(e));
}

function getCachedRules({ skipTtl = false, email = null } = {}) {
    const e = email || getUserEmail();
    if (!skipTtl) {
        const ts = parseInt(store.get(K.rulesTs(e)) || "0", 10);
        if (Date.now() - ts > CONFIG.CACHE_TTL_MS) {
            store.remove(K.rules(e), K.rulesTs(e));
            return null;
        }
    }
    return store.getJson(K.rules(e));
}

function setCachedRules(rulesJson, email = null) {
    const e = email || getUserEmail();
    store.setJson(K.rules(e), rulesJson);
    store.set(K.rulesTs(e), Date.now().toString());
}

// ── per-signature-id HTML cache ─────────────────────────────────────────────

function _readSigByIdMap() { return store.getJson(K.sigById) || {}; }
function _writeSigByIdMap(map) { store.setJson(K.sigById, map); }

function getSigById(signatureId, { skipTtl = false } = {}) {
    const entry = _readSigByIdMap()[String(signatureId)];
    if (!entry) return null;
    if (!skipTtl && Date.now() - entry.ts > CONFIG.CACHE_TTL_MS) return null;
    return entry.html;
}

function setSigById(signatureId, html) {
    const map = _readSigByIdMap();
    map[String(signatureId)] = { html, ts: Date.now() };
    _writeSigByIdMap(map);
}

function purgeStaleSigById() {
    const map = _readSigByIdMap();
    const now = Date.now();
    let purged = 0;
    for (const id of Object.keys(map)) {
        if (now - map[id].ts > CONFIG.CACHE_TTL_MS) { delete map[id]; purged++; }
    }
    if (purged > 0) _writeSigByIdMap(map);
}

// =============================================================================
//  HTTP LAYER — timeout + bounded retry with backoff & jitter
// =============================================================================

async function fetchWithTimeout(url, options = {}, timeoutMs = null) {
    const ms = timeoutMs ?? fetchTimeoutMs();
    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), ms) : null;
    try {
        return await fetch(url, controller ? { ...options, signal: controller.signal } : options);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

/** GET with retries. Retries on network errors and 5xx; not on 4xx. */
async function httpGet(path, headers) {
    let lastErr = null;
    for (let attempt = 0; attempt <= CONFIG.MAX_RETRIES; attempt++) {
        if (attempt > 0) {
            const delay = CONFIG.RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1) + Math.random() * 250;
            log.debug(`retry ${attempt}/${CONFIG.MAX_RETRIES} for ${path} in ${Math.round(delay)}ms`);
            await new Promise(r => setTimeout(r, delay));
        }
        try {
            const res = await fetchWithTimeout(`${CONFIG.BASE_URL}${path}`, { method: "GET", headers });
            if (res.ok) return res;
            if (res.status >= 400 && res.status < 500) return res; // don't retry client errors
            lastErr = new Error(`HTTP ${res.status}`);
        } catch (err) {
            lastErr = err;
        }
    }
    throw lastErr || new Error("request failed");
}

async function decryptHtmlResponse(rawText) {
    const decrypted = await handleAesDecrypt(rawText);
    try { return JSON.parse(decrypted)?.html || null; } catch (_) { return null; }
}

// =============================================================================
//  API CALLS
// =============================================================================

async function fetchAndCacheRules(userEmail) {
    try {
        const encryptedMail = await encryptEmail(userEmail);
        const res = await httpGet("/rules-config/get-active", {
            "Content-Type": "application/json",
            username: encryptedMail,
            "X-Platform": getXPlatform(),
        });
        if (!res.ok) { log.warn("rules fetch returned", res.status); return null; }

        const parsed = JSON.parse(await res.text());
        const rulesJson = parsed?.rulesJson;
        if (!rulesJson) { log.warn("rules response had no rulesJson"); return null; }

        setCachedRules(rulesJson, userEmail);
        log.debug("rulesJson fetched and cached");
        return rulesJson;
    } catch (err) {
        log.error("fetchAndCacheRules failed:", err?.message || err);
        return null;
    }
}

/**
 * Fetch the user's default (active) signature.
 * @returns {{html: string|null, explicit: boolean}}
 *   explicit=true → the server answered authoritatively (including "no
 *   signature assigned"); explicit=false → transport failure.
 */
async function renderSignatureOnServer(userEmail) {
    const t0 = Date.now();
    const item = Office?.context?.mailbox?.item;
    try {
        notifyWithTiming(item, "Loading signature...", t0);
        const encryptedMail = await encryptEmail(userEmail);
        const res = await httpGet("/html/outlook/get-active", {
            username: encryptedMail,
            "X-Platform": getXPlatform(),
        });

        notifyWithTiming(item, "API response received ✓", t0);

        if (res.ok) {
            const decrypted = await handleAesDecrypt(await res.text());
            notifyWithTiming(item, "Signature decrypted ✓", t0);
            let html = null;
            try { html = JSON.parse(decrypted)?.html; } catch (_) { html = null; }

            if (html === "" || html == null) {
                showError(item, "Signature not assigned. Please contact Admin.", t0);
                return { html: null, explicit: true };
            }
            return { html, explicit: true };
        }
        log.warn("primary signature fetch failed:", res.status);
    } catch (err) {
        log.warn("renderSignatureOnServer failed:", err?.message || err);
        showError(item, `API error: ${err?.message || err}`, t0);
    }
    return { html: null, explicit: false };
}

async function fetchSignatureById(signatureId, userEmail) {
    try {
        const encryptedMail = await encryptEmail(userEmail);
        const res = await httpGet(`/rules-config/get/${encodeURIComponent(signatureId)}`, {
            username: encryptedMail,
            "X-Platform": getXPlatform(),
        });
        if (!res.ok) { log.error("signature fetch failed:", res.status); return null; }
        const html = await decryptHtmlResponse(await res.text());
        if (!html) log.warn("signature HTML empty for signatureId:", signatureId);
        return html;
    } catch (err) {
        log.error("fetchSignatureById failed:", err?.message || err);
        return null;
    }
}

async function getOrFetchSignatureById(signatureId, userEmail, { skipTtl = false } = {}) {
    const id = String(signatureId);
    const cached = getSigById(id, { skipTtl });
    if (cached) { log.debug(`sigById cache hit id=${id}`); return cached; }
    log.debug(`sigById cache miss — fetching id=${id}`);
    const html = await fetchSignatureById(id, userEmail);
    if (html) setSigById(id, html);
    return html;
}

/** Warm the sig-by-id cache for every enabled rule (bounded concurrency). */
async function prefetchAllRuleSignatures(userEmail) {
    const rulesJson = getCachedRules({ email: userEmail });
    if (!rulesJson) { log.debug("prefetch skipped — rules not cached"); return; }

    const enabled = (rulesJson?.rulesList || []).filter(r => r.enabled && r.signatureId != null);
    if (enabled.length === 0) return;

    log.debug(`prefetching ${enabled.length} rule signature(s)`);
    const queue = [...enabled];
    const workers = Array.from({ length: Math.min(CONFIG.PREFETCH_CONCURRENCY, queue.length) }, async () => {
        while (queue.length) {
            const r = queue.shift();
            try { await getOrFetchSignatureById(r.signatureId, userEmail); }
            catch (err) { log.warn(`prefetch error signatureId=${r.signatureId}:`, err?.message || err); }
        }
    });
    await Promise.allSettled(workers);
    log.debug("prefetch complete");
}

// =============================================================================
//  RECIPIENT HELPERS
// =============================================================================

function getRecipientsAsync(field) {
    return new Promise((resolve) => {
        if (typeof field?.getAsync !== "function") return resolve([]);
        try {
            field.getAsync((result) => {
                resolve(result.status === Office.AsyncResultStatus.Succeeded ? (result.value || []) : []);
            });
        } catch (_) { resolve([]); }
    });
}

async function getAllRecipientEmails(item) {
    // Cc/Bcc intentionally excluded to mirror the C# backend contract.
    const [to] = await Promise.all([getRecipientsAsync(item?.to)]);
    const emails = to.map(r => (r.emailAddress || "").toLowerCase()).filter(Boolean);
    return [...new Set(emails)];
}

// =============================================================================
//  RULES MATCHING ENGINE — mirrors C# RecipientTypeMatches / ContextMatches
//  (dual-flag: hasInternal and hasExternal are independent booleans)
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
    return true; // mirrors C# fallthrough
}

function contextMatches(ruleContext, composeType) {
    if (!ruleContext || ruleContext.trim() === "") return true;
    const rc = ruleContext.toLowerCase();
    if (rc === "all") return true;
    if (composeType === null) return true; // API unavailable — don't drop rules
    return rc === composeType.toLowerCase();
}

let _composeTypeCache = null; // one compose item per runtime activation

function getComposeType(item) {
    if (_composeTypeCache !== null) return Promise.resolve(_composeTypeCache);
    return new Promise((resolve) => {
        if (typeof item?.getComposeTypeAsync !== "function") {
            log.debug("getComposeTypeAsync unavailable — context filter disabled");
            resolve(null);
            return;
        }
        try {
            item.getComposeTypeAsync((result) => {
                if (result.status !== Office.AsyncResultStatus.Succeeded) {
                    log.debug("getComposeTypeAsync failed:", result.error?.message);
                    resolve(null);
                    return;
                }
                const raw = (result.value?.composeType || "").toLowerCase();
                const normalized = raw === "newmail" ? "compose"
                    : (raw === "reply" || raw === "forward") ? "reply"
                        : null;
                _composeTypeCache = normalized;
                log.debug("composeType:", raw, "→", normalized);
                resolve(normalized);
            });
        } catch (_) { resolve(null); }
    });
}

/** Highest-priority matching rule for the current compose item, or null. */
async function findMatchingRule(item) {
    const userEmail = getUserEmail();
    let rulesJson = getCachedRules({ email: userEmail });

    if (!rulesJson && userEmail) {
        log.debug("rules not cached — live fetch");
        rulesJson = await fetchAndCacheRules(userEmail);
    }
    if (!rulesJson) { log.debug("findMatchingRule: no rules available"); return null; }

    const senderDomain = getDomain(userEmail);

    // Mac: recipient hydration can lag on reply/forward — retry once.
    let emails = await getAllRecipientEmails(item);
    if (emails.length === 0 && isMac()) {
        await new Promise(r => setTimeout(r, 400));
        emails = await getAllRecipientEmails(item);
    }

    const composeType = await getComposeType(item);

    if (emails.length === 0) {
        log.debug("no recipients — cannot match rules");
        return null;
    }

    let hasInternal = false;
    let hasExternal = false;
    for (const e of emails) {
        const d = getDomain(e);
        if (senderDomain && d === senderDomain) hasInternal = true;
        else hasExternal = true;
    }

    log.debug("rule context:", { userEmail, senderDomain, composeType, hasInternal, hasExternal });

    const sorted = (rulesJson?.rulesList || [])
        .filter(r => r.enabled)
        .sort((a, b) => a.priority - b.priority);

    for (const r of sorted) {
        const ok = contextMatches(r.context, composeType) &&
            recipientTypeMatches(r.recipientType, hasInternal, hasExternal);
        log.debug(ok ? ">>> MATCH" : "    skip",
            `priority=${r.priority} context=${r.context} recipientType=${r.recipientType} sigId=${r.signatureId ?? "NULL"}`);
        if (ok) return r;
    }

    log.debug("no rules matched", { composeType, hasInternal, hasExternal });
    return null;
}

// =============================================================================
//  INLINE IMAGE HANDLING — base64 data URIs → CID inline attachments
//
//  WHY: `<img src="data:image/...;base64,...">` does not survive sending.
//  Classic Outlook's Word rendering engine cannot display data URIs, and on
//  send Exchange/Outlook strips them or converts them into regular
//  attachments — recipients see a paperclip instead of the image.
//
//  FIX (Microsoft-prescribed pattern): before injecting the signature, every
//  embedded base64 image is uploaded once as an INLINE attachment via
//  item.addFileAttachmentFromBase64Async(..., { isInline: true }) and the
//  <img src> is rewritten to `cid:<attachmentName>`. CID inline images render
//  in-body at the receiver in Outlook, Gmail, Apple Mail, etc.
//  addFileAttachmentFromBase64Async (Mailbox 1.8) is also on the mobile
//  event-activation API allow-list, so this path works on iOS/Android too.
//
//  Details:
//    • Attachment names are content-hashed → the same image is attached
//      exactly once per compose item, including on send-time re-injection.
//    • The tracker is seeded from item.getAttachmentsAsync on first use, so
//      a fresh runtime activation (mobile is ephemeral; each LaunchEvent may
//      be a new runtime) never duplicates an already-attached image.
//    • On signature switches, our attachments that are no longer referenced
//      are removed — stale unreferenced inline attachments are exactly what
//      shows up as a "mystery attachment" at the receiver.
//    • If an attach fails or the API is unavailable, that image keeps its
//      original data URI (previous behavior) — degrade, never break.
//    • Limitation: only <img src="data:..."> is converted; CSS
//      background-image data URIs are left untouched. Long-term fix remains
//      hosted HTTPS image URLs served by the signature backend.
// =============================================================================

let _inlineAttachedNames = {};   // name → true (attached on the current item)
let _inlineTrackerSeeded = false;

function _hashString(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
}

function _extFromMime(mime) {
    const m = (mime || "").toLowerCase();
    if (m.includes("png")) return "png";
    if (m.includes("gif")) return "gif";
    if (m.includes("webp")) return "webp";
    if (m.includes("bmp")) return "bmp";
    return "jpg";
}

function resetInlineImageTracker() {
    _inlineAttachedNames = {};
    _inlineTrackerSeeded = false;
}

function _getAttachmentsSafe(item) {
    return new Promise((resolve) => {
        if (typeof item?.getAttachmentsAsync !== "function") return resolve(null);
        try {
            item.getAttachmentsAsync((r) => {
                resolve(r.status === Office.AsyncResultStatus.Succeeded ? (r.value || []) : null);
            });
        } catch (_) { resolve(null); }
    });
}

/** Seed the attached-name tracker from the item's real attachment list once
 *  per activation, so we never re-attach an image that already exists —
 *  critical on mobile, where every LaunchEvent may be a fresh runtime. */
async function _seedInlineTracker(item) {
    if (_inlineTrackerSeeded) return;
    _inlineTrackerSeeded = true;
    const atts = await _getAttachmentsSafe(item);
    if (!atts) return;
    for (const att of atts) {
        const nm = att.name || "";
        if (nm.startsWith(CONFIG.INLINE_IMG_PREFIX)) _inlineAttachedNames[nm] = true;
    }
}

function _attachInlineBase64(item, b64, name) {
    return new Promise((resolve) => {
        try {
            item.addFileAttachmentFromBase64Async(b64, name, { isInline: true }, (r) => {
                resolve(r.status === Office.AsyncResultStatus.Succeeded
                    ? true
                    : (log.warn(`inline attach failed for ${name}:`, r.error?.message), false));
            });
        } catch (e) {
            log.warn("inline attach threw:", e?.message || e);
            resolve(false);
        }
    });
}

/**
 * Converts embedded base64 images in `html` to CID inline attachments.
 * Returns { html: processedHtml, usedNames: {name: true} }. Images that fail
 * to attach keep their original data URI.
 */
async function processInlineImages(item, html) {
    if (!html || !html.includes("data:image/")) return { html, usedNames: {} };

    if (typeof item?.addFileAttachmentFromBase64Async !== "function") {
        log.warn("inline images: addFileAttachmentFromBase64Async unavailable (< Mailbox 1.8) — leaving data URIs");
        return { html, usedNames: {} };
    }

    // src="data:image/<mime>;base64,<data>"  (single- or double-quoted)
    const re = /src\s*=\s*(['"])data:image\/([a-z0-9.+-]+);base64,([^'"]+)\1/gi;
    const jobs = [];
    const byName = {};
    let m;
    while ((m = re.exec(html)) !== null && jobs.length < CONFIG.INLINE_IMG_MAX) {
        const b64 = m[3].replace(/\s+/g, "");
        if (!b64) continue;
        const name = CONFIG.INLINE_IMG_PREFIX + _hashString(b64) + "." + _extFromMime(m[2]);
        if (byName[name]) continue; // same image repeated — one attach covers all
        byName[name] = true;
        jobs.push({ full: m[0], quote: m[1], b64, name, ok: false });
    }
    if (jobs.length === 0) return { html, usedNames: {} };

    log.debug(`processInlineImages: ${jobs.length} embedded image(s) found`);
    await _seedInlineTracker(item);

    for (const j of jobs) { // sequential: Office attachment APIs dislike parallel writes
        if (_inlineAttachedNames[j.name]) { j.ok = true; continue; }
        j.ok = await _attachInlineBase64(item, j.b64, j.name);
        if (j.ok) {
            _inlineAttachedNames[j.name] = true;
            log.debug("inline image attached:", j.name);
        }
    }

    let out = html;
    const usedNames = {};
    for (const j of jobs) {
        if (!j.ok) continue; // attach failed → keep original data URI
        usedNames[j.name] = true;
        // Same data URI may appear multiple times — replace every occurrence.
        out = out.split(j.full).join(`src=${j.quote}cid:${j.name}${j.quote}`);
    }
    return { html: out, usedNames };
}

/** Removes attachments this add-in created that the current signature no
 *  longer references (fire-and-forget). Only touches our prefixed names. */
async function cleanupStaleInlineAttachments(item, keepNames) {
    if (typeof item?.removeAttachmentAsync !== "function") return;
    const atts = await _getAttachmentsSafe(item);
    if (!atts) return;
    for (const att of atts) {
        const nm = att.name || "";
        if (!nm.startsWith(CONFIG.INLINE_IMG_PREFIX) || keepNames[nm]) continue;
        try {
            item.removeAttachmentAsync(att.id, (r) => {
                if (r.status === Office.AsyncResultStatus.Succeeded) {
                    delete _inlineAttachedNames[nm];
                    log.debug("removed stale inline attachment:", nm);
                } else {
                    log.warn("stale attachment remove failed:", nm);
                }
            });
        } catch (e) { log.warn("cleanup threw:", e?.message || e); }
    }
}

// =============================================================================
//  SIGNATURE INJECTION — serialized through an apply-queue
// =============================================================================

function byteLength(str) {
    try { return new TextEncoder().encode(str).length; } // Blob is absent in JS-only runtime
    catch (_) { return String(str).length; }
}

function bodySetSignatureAsync(item, html) {
    return new Promise((resolve, reject) => {
        if (typeof item?.body?.setSignatureAsync !== "function") {
            reject(new Error("setSignatureAsync not available on this client"));
            return;
        }
        item.body.setSignatureAsync(html, { coercionType: Office.CoercionType.Html }, (r) => {
            r.status === "succeeded" ? resolve() : reject(r.error || new Error("setSignatureAsync failed"));
        });
    });
}

// Serialize every signature write: OnNewMessageCompose, recipients-changed
// and from-changed handlers can overlap in WebView runtimes; interleaved
// setSignatureAsync calls produce duplicated/half-applied signatures.
let _applyChain = Promise.resolve();
function enqueueApply(taskFn) {
    const run = _applyChain.then(taskFn, taskFn);
    _applyChain = run.catch(() => { });
    return run;
}

async function applySignatureWithFallback(item, html, opts = {}) {
    // opts.skipImageCleanup — set by the send path: attachments must not be
    // added/removed while the item is mid-send. At send time the images are
    // already attached (content-hashed names → tracker/attachment-list hits),
    // so processing only rewrites data URIs to existing cid: references.
    const { skipImageCleanup = false } = opts;

    return enqueueApply(async () => {
        // Step 1: base64 data URIs → CID inline attachments (see section above).
        const { html: processedHtml, usedNames } = await processInlineImages(item, html);

        const size = byteLength(processedHtml);
        if (size > CONFIG.HTML_HARD_MAX_BYTES) {
            log.warn(`signature exceeds max size (${size} > ${CONFIG.HTML_HARD_MAX_BYTES})`);
            showError(item, "Signature could not be applied — size exceeds allowed threshold. Please contact Admin.");
            return false;
        }
        try {
            // Do NOT removeNotification here — the "Applying signature..."
            // message must remain on the bar until it is replaced by the
            // "applied ✓" notification from the caller.
            await bodySetSignatureAsync(item, processedHtml);
            // Step 2: drop our attachments the new signature no longer
            // references — stale unreferenced inline attachments surface as
            // "mystery attachments" at the receiver. Fire-and-forget.
            if (!skipImageCleanup) {
                cleanupStaleInlineAttachments(item, usedNames)
                    .catch(err => log.warn("inline cleanup failed:", err?.message || err));
            }
            return true;
        } catch (err) {
            log.error("setSignatureAsync failed:", err?.message || err);
            showError(item, "Signature could not be applied. Please contact Admin.");
            return false;
        }
    });
}

// =============================================================================
//  CORE ORCHESTRATOR
// =============================================================================

// Tracks the signatureId last injected by the rules engine.
// null = default signature active; string = rule signature active.
let _activeSignatureId = null;

async function applySignatureCore(item, mailbox, opts = {}) {
    const t0 = Date.now();
    const { fetchIfMissing = false, skipTtl = false, skipSessionCheck = false, overrideHtml = null } = opts;
    const userEmail = getUserEmail();

    let html = overrideHtml;
    let explicitlyUnassigned = false;

    if (!html) html = getCachedSignature({ skipTtl, skipSessionCheck, email: userEmail });

    if (!html && fetchIfMissing && userEmail) {
        notifyWithTiming(item, "Fetching signature...", t0);
        const { html: fetched, explicit } = await renderSignatureOnServer(userEmail);
        if (fetched) {
            html = fetched;
            setCachedSignature(html, userEmail);
            notifyWithTiming(item, "Signature fetched ✓", t0);
        } else if (explicit) {
            explicitlyUnassigned = true;
            clearCachedSignature(userEmail);
        }
    }

    // Transport failure → stale cache beats no signature at all.
    if (!html && !explicitlyUnassigned) {
        const stale = getCachedSignature({ skipTtl: true, skipSessionCheck: true, email: userEmail });
        if (stale) {
            log.warn("using stale cached signature (network unavailable)");
            html = stale;
            notifyWithTiming(item, "Using stale cache ✓", t0);
        }
    }

    if (!html) {
        log.error("no signature available — aborting");
        removeNotification(item);
        showError(item, "Signature not available. Please contact Admin.", t0);
        return false;
    }

    notifyWithTiming(item, "Applying signature...", t0);
    const ok = await applySignatureWithFallback(item, html);
    if (ok) {
        notifyWithTiming(item, "Signature applied ✓", t0);
        setTimeout(() => removeNotification(item), 3000);
    }
    return ok;
}

// =============================================================================
//  RECIPIENT-CHANGE CORE (used by LaunchEvent handler AND the polling fallback)
// =============================================================================

let _recipientRunToken = 0; // stale-run guard: only the latest change applies

async function onRecipientsChangedCore(item, mailbox) {
    const t0 = Date.now();
    const token = ++_recipientRunToken;
    const matched = await findMatchingRule(item);
    if (token !== _recipientRunToken) { log.debug("recipient run superseded — dropping"); return; }

    if (matched) {
        log.debug(`rule matched → signatureId=${matched.signatureId}`);
        const ruleHtml = await getOrFetchSignatureById(matched.signatureId, getUserEmail());
        if (token !== _recipientRunToken) return;
        if (!ruleHtml) {
            log.warn("rule signature fetch returned null — keeping current signature");
            return;
        }
        notifyWithTiming(item, "Applying rule signature...", t0);
        const ok = await applySignatureWithFallback(item, ruleHtml);
        if (ok) {
            notifyWithTiming(item, "Rule signature applied ✓", t0);
            setTimeout(() => removeNotification(item), 3000);
        }
        _activeSignatureId = String(matched.signatureId);
    } else {
        log.debug("no rule matched — falling back to default signature");
        _activeSignatureId = null;
        await applySignatureCore(item, mailbox, { fetchIfMissing: true });
    }
}

// ─── Debounce for recipient changes (users type/paste in bursts) ────────────

let _recipientDebounceTimer = null;

function debouncedRecipientsChanged(item, mailbox) {
    if (_recipientDebounceTimer) clearTimeout(_recipientDebounceTimer);
    _recipientDebounceTimer = setTimeout(() => {
        _recipientDebounceTimer = null;
        onRecipientsChangedCore(item, mailbox)
            .catch(err => log.warn("recipient change handling failed:", err?.message || err));
    }, CONFIG.RECIPIENT_DEBOUNCE_MS);
}

// =============================================================================
//  POLLING — legacy fallback ONLY (Mailbox 1.10/1.11 clients where the
//  OnMessageRecipientsChanged LaunchEvent doesn't fire). Disabled on mobile
//  (the runtime is torn down after event.completed, so timers never run) and
//  permanently disabled the moment the real event fires once.
// =============================================================================

let _lastRecipientSnapshot = "";
let _recipientPollTimer = null;
let _recipientEventSeen = false;

const serializeRecipients = (emails) => [...emails].sort().join(",");

async function pollRecipients() {
    if (_recipientEventSeen) { stopRecipientPolling(); return; }
    const mailbox = Office?.context?.mailbox;
    const item = mailbox?.item;
    if (!item) return;

    const emails = await getAllRecipientEmails(item);
    const snapshot = serializeRecipients(emails);
    if (snapshot === _lastRecipientSnapshot) return;
    _lastRecipientSnapshot = snapshot;

    log.debug("recipient change detected via poll:", emails);
    debouncedRecipientsChanged(item, mailbox);
}

function startRecipientPolling() {
    if (_recipientPollTimer || _recipientEventSeen) return;
    if (isMobile()) { log.debug("polling not applicable on mobile"); return; }
    _recipientPollTimer = setInterval(() => {
        pollRecipients().catch(() => { });
    }, CONFIG.RECIPIENT_POLL_MS);
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

function withTimeout(promise, ms, label = "operation") {
    return Promise.race([
        promise,
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
    ]);
}

// =============================================================================
//  SEND-TIME CORE — cache-only, never blocks the send (SoftBlock + allowEvent)
// =============================================================================

async function _onSendCore(item, mailbox) {
    const t0 = Date.now();
    notifyWithTiming(item, "Re-applying correct signature...", t0);

    const userEmail = getUserEmail();
    const rulesJson = getCachedRules({ skipTtl: true, email: userEmail });

    if (rulesJson) {
        const matched = await findMatchingRule(item);

        // Mac fallback: if the live match is inconclusive but a rule signature
        // was applied during compose, trust it rather than reverting to default.
        if (!matched && isMac() && _activeSignatureId) {
            const ruleHtml = getSigById(_activeSignatureId, { skipTtl: true });
            if (ruleHtml) {
                await applySignatureWithFallback(item, ruleHtml, { skipImageCleanup: true });
                notifyWithTiming(item, "Rule signature applied ✓ (Mac fallback)", t0);
                return;
            }
        }

        if (matched) {
            const ruleHtml = getSigById(String(matched.signatureId), { skipTtl: true }); // cache-only at send time
            if (ruleHtml) {
                await applySignatureWithFallback(item, ruleHtml, { skipImageCleanup: true });
                notifyWithTiming(item, "Rule signature applied ✓", t0);
                return;
            }
            log.warn(`onSend: rule sig id=${matched.signatureId} not in cache — falling back to default`);
        }
    }

    const cached = getCachedSignature({ skipTtl: true, skipSessionCheck: true, email: userEmail });
    if (!cached) {
        log.warn("onSend: no cached signature — leaving body as-is");
        showError(item, "No cached signature on send", t0);
        return;
    }
    await applySignatureWithFallback(item, cached, { skipImageCleanup: true });
    notifyWithTiming(item, "Signature applied ✓", t0);
}

// =============================================================================
//  OFFICE READY
// =============================================================================

if (typeof Office !== "undefined" && typeof Office.onReady === "function") {
    Office.onReady(() => {
        log.info(`ready — platform=${detectPlatform()} dom=${HAS_DOM} ls=${HAS_LOCAL_STORAGE} ors=${HAS_OFFICERUNTIME_STORAGE}`);
        ensureStorageReady().then(() => purgeStaleSigById()).catch(() => { });
    });
}

// =============================================================================
//  PUBLIC ENTRY POINTS
// =============================================================================

const _noopEvent = { completed: () => { } };

/** OnNewMessageCompose + "Apply Signature" ribbon button. */
const applySignature = async function (event = _noopEvent) {
    const t0 = Date.now();
    const mailbox = Office?.context?.mailbox;
    const item = mailbox?.item;

    try {
        if (!item) return;
        await ensureStorageReady();

        notifyWithTiming(item, "Starting signature flow...", t0);

        _activeSignatureId = null;
        _composeTypeCache = null;
        resetInlineImageTracker(); // new compose item — re-seed from its attachments

        const budget = isMobile() ? CONFIG.HANDLER_BUDGET_MS_MOBILE : 25000;

        await withTimeout((async () => {
            // 1) Default signature first — user sees a signature ASAP.
            await applySignatureCore(item, mailbox, { fetchIfMissing: true });

            const userEmail = getUserEmail();

            // 2) Warm rules + rule-signature caches (all platforms, incl. mobile —
            //    on mobile this is awaited with a small budget so the cache is
            //    populated before the runtime is torn down).
            if (userEmail) {
                if (!getCachedRules({ email: userEmail })) await fetchAndCacheRules(userEmail);
                const prefetch = prefetchAllRuleSignatures(userEmail);
                if (isMobile()) {
                    await withTimeout(prefetch, CONFIG.PREFETCH_BUDGET_MS_MOBILE, "prefetch").catch(() => { });
                } else {
                    prefetch.catch(err => log.warn("background prefetch failed:", err?.message || err));
                }
            }

            // 3) Reply/forward already has recipients — run the rules pass now.
            //    (Previously desktop-only; mobile supports the same APIs.)
            const emails = await getAllRecipientEmails(item);
            if (emails.length > 0) {
                _lastRecipientSnapshot = serializeRecipients(emails);
                await onRecipientsChangedCore(item, mailbox);
            }
        })(), budget, "applySignature");

        // 4) Legacy fallback for clients where OnMessageRecipientsChanged
        //    never fires. Self-disables the moment the real event is seen.
        startRecipientPolling();

    } catch (err) {
        log.error("applySignature error:", err?.message || err);
    } finally {
        log.timing("applySignature total", t0);
        try { event.completed(); } catch (_) { }
    }
};

/** OnMessageRecipientsChanged (Mailbox 1.11 — Windows, Mac, OWA, iOS, Android). */
const onRecipientsChangedHandler = async function (event = _noopEvent) {
    const t0 = Date.now();
    const mailbox = Office?.context?.mailbox;
    const item = mailbox?.item;

    try {
        if (!item) return;
        await ensureStorageReady();

        _recipientEventSeen = true; // the real event works → retire polling
        stopRecipientPolling();

        if (isMobile()) {
            // Ephemeral runtime: run to completion before event.completed().
            await withTimeout(onRecipientsChangedCore(item, mailbox),
                CONFIG.HANDLER_BUDGET_MS_MOBILE, "onRecipientsChanged");
        } else {
            // Persistent runtime: debounce bursts of recipient edits.
            const emails = await getAllRecipientEmails(item);
            const snapshot = serializeRecipients(emails);
            if (snapshot !== _lastRecipientSnapshot) {
                _lastRecipientSnapshot = snapshot;
                debouncedRecipientsChanged(item, mailbox);
            }
        }
    } catch (err) {
        log.warn("onRecipientsChangedHandler error:", err?.message || err);
    } finally {
        log.timing("onRecipientsChangedHandler total", t0);
        try { event.completed(); } catch (_) { }
    }
};

/** OnMessageFromChanged (Mailbox 1.13 — Windows, Mac, OWA, iOS, Android).
 *  Re-resolves signature + rules for the newly selected sending account. */
const onFromChangedHandler = async function (event = _noopEvent) {
    const t0 = Date.now();
    const mailbox = Office?.context?.mailbox;
    const item = mailbox?.item;

    try {
        if (!item) return;
        await ensureStorageReady();

        const newFrom = await new Promise((resolve) => {
            if (typeof item?.from?.getAsync !== "function") return resolve(null);
            try {
                item.from.getAsync((r) => {
                    resolve(r.status === Office.AsyncResultStatus.Succeeded
                        ? (r.value?.emailAddress || null) : null);
                });
            } catch (_) { resolve(null); }
        });

        const previous = getUserEmail();
        _activeFromEmail = (newFrom || "").toLowerCase() || null;
        const current = getUserEmail();
        log.info(`from changed: ${previous || "?"} → ${current || "?"}`);

        if (current && current !== previous) {
            _activeSignatureId = null;
            // Caches are keyed per email, so the new account gets a fresh
            // fetch while the previous account's caches stay intact.
            await withTimeout((async () => {
                await applySignatureCore(item, mailbox, { fetchIfMissing: true });
                if (!getCachedRules({ email: current })) await fetchAndCacheRules(current);
                const emails = await getAllRecipientEmails(item);
                if (emails.length > 0) await onRecipientsChangedCore(item, mailbox);
            })(), isMobile() ? CONFIG.HANDLER_BUDGET_MS_MOBILE : 20000, "onFromChanged");
        }
    } catch (err) {
        log.warn("onFromChangedHandler error:", err?.message || err);
    } finally {
        log.timing("onFromChangedHandler total", t0);
        try { event.completed(); } catch (_) { }
    }
};

/** OnMessageSend (Mailbox 1.12, SoftBlock). Not supported on mobile —
 *  the manifest never registers it there, and this handler always allows
 *  the send regardless of outcome. */
const onSendHandler = async function (event = _noopEvent) {
    const t0 = Date.now();
    const mailbox = Office?.context?.mailbox;
    const item = mailbox?.item;

    const done = () => {
        log.timing("onSendHandler total", t0);
        try { event.completed({ allowEvent: true }); } catch (_) { }
    };

    try {
        if (!item) { done(); return; }
        await ensureStorageReady();
        stopRecipientPolling();

        notifyWithTiming(item, "Verifying before send...", t0);

        await withTimeout(_onSendCore(item, mailbox), CONFIG.ONSEND_BUDGET_MS, "onSend");

        notifyWithTiming(item, "Send verification complete ✓", t0);
        setTimeout(() => removeNotification(item), 3000);
    } catch (err) {
        log.warn("onSend timeout/error:", err?.message || err);
        showError(item, "Send timeout/error", t0, /* persistent */ true);
        // Never block the send over a signature problem — fail open.
    } finally {
        done();
    }
};

// =============================================================================
//  REGISTER OFFICE ACTIONS
// =============================================================================

if (typeof Office !== "undefined" && typeof Office.actions !== "undefined") {
    Office.actions.associate("applySignature", applySignature);
    Office.actions.associate("onSendHandler", onSendHandler);
    Office.actions.associate("onRecipientsChangedHandler", onRecipientsChangedHandler);
    Office.actions.associate("onFromChangedHandler", onFromChangedHandler);
    log.info("registered: applySignature, onSendHandler, onRecipientsChangedHandler, onFromChangedHandler");
} else {
    log.info("Office.actions unavailable — LaunchEvent path inactive (Outlook 2016/2019)");
}