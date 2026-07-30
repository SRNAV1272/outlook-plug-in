"use strict";

// =============================================================================
//  CardByte Outlook Add-in — event-handler.js (v6 — Mac send-time rule fix)
//
//  WHAT v6 FIXES (on top of v5)
//
//  Symptom: on Mac desktop, compose/reply applied the CORRECT signature, but
//  pressing Send replaced it with rule 2/3's signature (a "compose"+"internal"
//  rule) whenever To contained both internal and external recipients.
//
//  Root cause: the Mac send handler runs in a FRESH WKWebView. The module-level
//  `_composeTypeByItem` WeakMap is empty there, so getComposeType() re-detected
//  from scratch — and v5's detectComposeType() ended with an unconditional
//  `return "compose"`. Any failure/timeout of getComposeTypeAsync (or a bare
//  subject) silently produced composeType === "compose" on a REPLY. With both
//  hasInternal and hasExternal true, the compose+internal rule then won on
//  priority and overwrote the correct reply signature. Windows/OWA/Safari share
//  a single runtime, never re-detect, and so were never affected.
//
//  v6 changes:
//  1. COMPOSE TYPE IS PERSISTED ON THE ITEM (cardbyte_compose_type custom
//     property). The send runtime reads the compose runtime's decision instead
//     of re-deriving it. This also covers Mac returning "newMail" for a reply.
//  2. NO SILENT "compose" GUESS. detectComposeTypeRaw() returns null when it
//     genuinely cannot tell. At send time (strictComposeType) an unknown type
//     refuses to match context-specific rules and falls through to the
//     persisted-active-signature path — which is the correct answer anyway.
//     getComposeTypeAsync is also wrapped in a 1.5s timeout so a dead callback
//     can't burn the whole send budget.
//  3. SNAPSHOT SHORT-CIRCUIT. Compose time records the recipient set alongside
//     the signature it applied. If recipients are unchanged at send time, we
//     trust the applied signature and skip re-evaluation entirely — killing the
//     bug in the common case and saving the 2.5s Mac fetch.
//  4. SINGLE SHARED CustomProperties HANDLE per item (_propsByItem). v5 loaded
//     a fresh snapshot in each of getManualOverride / setActiveSigOnItem and
//     saved independently, so concurrent saveAsync calls clobbered each other.
//  5. recipientTypeMatches(): "internal" can now mean "ALL recipients are
//     internal" via INTERNAL_REQUIRES_NO_EXTERNAL. This is a PRODUCT DECISION
//     affecting every platform — see the constant. Default is v5 behavior.
//  6. Removed the dead `item.inReplyToId` branch (not an Office.js compose API
//     — it never fired, and it looked like a safety net that wasn't there).
//  7. X_PLATFORM_FORCE is a real constant again instead of commented-out code.
//  8. CB_VERSION is logged on load, so you can confirm which build Mac has
//     actually cached.
//
//  DEPLOYMENT PREREQS FOR MAC (not fixable in this file — verify these):
//  a) https://ns-enterprise.cardbyte.ai/.well-known/microsoft-officeaddins-allowed.json
//     must exist and list this add-in's ID and the full URL of this JS file,
//     and the API must return proper CORS headers. Without it, ALL fetches
//     from the Mac event runtime reject with "TypeError: Load failed".
//  b) Manifest must be the ADD-IN ONLY (XML) manifest for Mac, and LaunchEvents
//     must include OnNewMessageCompose, OnMessageRecipientsChanged,
//     OnMessageFromChanged, OnMessageSend.
//  c) Debug on Mac: defaults write com.microsoft.Outlook
//     OfficeWebAddinDeveloperExtras -bool true  -> inspect via Safari Develop.
//
//  HOW TO CONFIRM THE FIX: send a reply on Mac and look for the
//  "[CardByte] Rule evaluation context:" line emitted during onSendHandler.
//  composeType must be "reply". You should usually see the snapshot
//  short-circuit fire before rule evaluation even runs.
// =============================================================================

const CB_VERSION = "v6.0.0";

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
const SIG_BY_ID_PURGE_MS = 24 * 60 * 60 * 1000;

const ACTIVE_SIG_KEY = "cardbyte_active_sig_id";
const ACTIVE_SIG_TS_KEY = "cardbyte_active_sig_ts";
const ACTIVE_SIG_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// Item-scoped custom property names (cross-runtime, cross-platform).
const ACTIVE_SIG_PROP = "cardbyte_active_sig_id";
const MANUAL_OVERRIDE_PROP = "cardbyte_manual_sig_id";
const COMPOSE_TYPE_PROP = "cardbyte_compose_type";   // v6
const RECIP_SNAPSHOT_PROP = "cardbyte_recip_snapshot"; // v6

// Sentinel meaning "the default (non-rule) signature is what's in the body".
const DEFAULT_SIG_SENTINEL = "default";

// roamingSettings keys (mailbox-scoped, ~32KB total budget — small values only)
const ROAM_ACTIVE_SIG = "cb_active_sig";
const ROAM_RULES = "cb_rules";
const ROAM_RULES_TS = "cb_rules_ts";
const ROAM_MAX_RULES_BYTES = 20 * 1024;

const MAX_SAFE_HTML_SIZE = 500_000;
const MAX_SAFE_HTML_SIZE_MOBILE = 200_000;
const MAX_RETRIES = 2;
const RECIPIENT_POLL_MS = 900;

// Send-time budgets. Mac gets a longer budget + one quick network try because
// its event runtime starts with an empty cache.
const SEND_TIMEOUT_MS_MAC = 12_000;
const SEND_TIMEOUT_MS_DEFAULT = 5_000;
const SEND_QUICK_FETCH_MS = 2_500;

// v6: hard ceiling on getComposeTypeAsync so a callback that never fires
// cannot consume the send budget.
const COMPOSE_TYPE_TIMEOUT_MS = 1_500;

// Keep the Mac compose event runtime alive so recipient polling keeps working.
const MAC_KEEPALIVE_MS = 4 * 60 * 1000;

// Set to "WINDOWS" to force the old behavior if the backend rejects "MAC".
// null => report the real platform.
const X_PLATFORM_FORCE = "WINDOWS";

// v6 / Fix 4 — PRODUCT DECISION, affects every platform.
//   false (v5 behavior): recipientType "internal" matches if ANY recipient is
//         internal. With mixed internal+external To, BOTH the internal and the
//         external rule match and priority decides the winner.
//   true : "internal" matches only when EVERY recipient is internal.
// Flip to true only if that is the intended product semantics.
const INTERNAL_REQUIRES_NO_EXTERNAL = false;

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
    if (X_PLATFORM_FORCE) return X_PLATFORM_FORCE;
    const p = detectPlatform();
    if (p === "mac") return "MAC";
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
//  CRYPTO — AES-CBC via Web Crypto API (unchanged)
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
//  STORAGE — MULTI-SOURCE
//  L1: in-memory (this runtime).  L2: localStorage (best effort — EMPTY in the
//  Mac event runtime).  L3: roamingSettings (mailbox-scoped, works in every
//  runtime incl. Mac events; ~32KB budget so only small values live here).
//  Signature HTML never goes to roaming.
// =============================================================================

const _mem = new Map();

const store = {
    get: (key) => {
        if (_mem.has(key)) return _mem.get(key);
        try {
            const v = localStorage.getItem(key);
            if (v != null) { _mem.set(key, v); return v; }
        } catch (_) { }
        return null;
    },
    set: (key, val) => {
        _mem.set(key, val);
        try { localStorage.setItem(key, val); } catch (_) { }
    },
    remove: (...keys) => {
        keys.forEach(k => _mem.delete(k));
        try { keys.forEach(k => localStorage.removeItem(k)); } catch (_) { }
    },
    getJson: (key) => {
        try { const v = store.get(key); return v ? JSON.parse(v) : null; } catch (_) { return null; }
    },
    setJson: (key, val) => {
        try { store.set(key, JSON.stringify(val)); } catch (_) { }
    },
};

function roamGet(key) {
    try { return Office?.context?.roamingSettings?.get(key) ?? null; } catch (_) { return null; }
}
function roamSet(key, val) {
    try {
        const rs = Office?.context?.roamingSettings;
        if (!rs) return;
        rs.set(key, val);
        rs.saveAsync(() => { });
    } catch (_) { }
}
function roamRemove(key) {
    try {
        const rs = Office?.context?.roamingSettings;
        if (!rs) return;
        rs.remove(key);
        rs.saveAsync(() => { });
    } catch (_) { }
}

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
//  ITEM CUSTOM PROPERTIES — v6: ONE shared handle per item.
//
//  v5 loaded a fresh CustomProperties snapshot inside each of
//  getManualOverride / getActiveSigFromItem / setActiveSigOnItem and called
//  saveAsync on each one independently. Two concurrent writers each held a
//  stale snapshot, so the later saveAsync silently discarded the other's key.
//  A single cached handle per item makes writes additive.
//
//  Caveat kept from v5: Mac doesn't cache custom props offline, and saveAsync
//  is fire-and-forget — this is the PRIMARY cross-runtime channel, not the
//  only one. localStorage + roamingSettings remain as fallbacks.
// =============================================================================

const _propsByItem = new WeakMap();

function getProps(item) {
    if (_propsByItem.has(item)) return _propsByItem.get(item);
    const p = new Promise((resolve) => {
        if (typeof item?.loadCustomPropertiesAsync !== "function") return resolve(null);
        try {
            item.loadCustomPropertiesAsync((res) => {
                if (res.status !== Office.AsyncResultStatus.Succeeded)
                    console.warn("[CardByte] loadCustomPropertiesAsync failed:", res.error?.message);
                resolve(res.status === Office.AsyncResultStatus.Succeeded ? res.value : null);
            });
        } catch (e) {
            console.warn("[CardByte] loadCustomPropertiesAsync threw:", e);
            resolve(null);
        }
    });
    _propsByItem.set(item, p);
    return p;
}

async function getItemProp(item, key) {
    try {
        const v = (await getProps(item))?.get(key);
        return v == null ? null : String(v);
    } catch (_) { return null; }
}

async function setItemProps(item, kv) {
    const props = await getProps(item);
    if (!props) return;
    try {
        for (const [k, v] of Object.entries(kv)) {
            if (v == null) props.remove(k);
            else props.set(k, String(v));
        }
        props.saveAsync((res) => {
            if (res.status !== Office.AsyncResultStatus.Succeeded)
                console.warn("[CardByte] customProps saveAsync failed:", res.error?.message);
        });
    } catch (e) {
        console.warn("[CardByte] setItemProps threw:", e);
    }
}

async function getManualOverride(item) {
    return getItemProp(item, MANUAL_OVERRIDE_PROP);
}

// =============================================================================
//  ACTIVE SIGNATURE ID + RECIPIENT SNAPSHOT
//  Written to item props (per-draft, cross-runtime) + roaming + localStorage.
//  The snapshot is what lets the send handler know nothing changed since the
//  compose runtime made its decision.
// =============================================================================

async function markActiveSignature(item, id, { snapshot } = {}) {
    if (id == null) {
        store.remove(ACTIVE_SIG_KEY, ACTIVE_SIG_TS_KEY);
        roamRemove(ROAM_ACTIVE_SIG);
    } else {
        store.set(ACTIVE_SIG_KEY, String(id));
        store.set(ACTIVE_SIG_TS_KEY, Date.now().toString());
        roamSet(ROAM_ACTIVE_SIG, String(id));
    }

    if (!item) return;

    let snap = snapshot;
    if (id != null && snap === undefined) {
        try { snap = serializeRecipients(await getAllRecipientEmails(item)); }
        catch (_) { snap = null; }
    }

    await setItemProps(item, {
        [ACTIVE_SIG_PROP]: id == null ? null : String(id),
        [RECIP_SNAPSHOT_PROP]: id == null ? null : snap,
    });
}

async function getActiveSignatureId(item = null) {
    // 1. Item custom property — authoritative for THIS draft, cross-runtime.
    if (item) {
        const fromItem = await getItemProp(item, ACTIVE_SIG_PROP);
        if (fromItem) return fromItem;
    }
    // 2. localStorage/memory (works on Windows, same-runtime elsewhere).
    const id = store.get(ACTIVE_SIG_KEY);
    if (id) {
        const ts = parseInt(store.get(ACTIVE_SIG_TS_KEY) || "0", 10);
        if (!ts || Date.now() - ts <= ACTIVE_SIG_MAX_AGE_MS) return id;
    }
    // 3. roamingSettings — survives runtime isolation on Mac.
    const roamed = roamGet(ROAM_ACTIVE_SIG);
    return roamed ? String(roamed) : null;
}

// =============================================================================
//  DEFAULT SIGNATURE CACHE
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
//  RULES CACHE — mirrored to roamingSettings when small enough.
// =============================================================================

function getCachedRules({ skipTtl = false, skipSessionCheck = false } = {}) {
    const t0 = Date.now();

    const readLocal = () => store.getJson(RULES_CACHE_KEY);
    const readRoam = () => {
        try {
            const raw = roamGet(ROAM_RULES);
            return raw ? JSON.parse(raw) : null;
        } catch (_) { return null; }
    };

    if (skipSessionCheck) {
        const val = readLocal() || readRoam();
        logTiming("getCachedRules (skipSessionCheck)", t0);
        return val;
    }

    const currentSid = getOrCreateSessionId();
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

    const val = readLocal() || readRoam();
    logTiming("getCachedRules (hit)", t0);
    return val;
}

function setCachedRules(rulesJson) {
    const t0 = Date.now();
    const sid = getOrCreateSessionId();
    try {
        store.setJson(RULES_CACHE_KEY, rulesJson);
        store.set(RULES_CACHE_TIMESTAMP_KEY, Date.now().toString());
        store.set(CACHE_SESSION_KEY, sid);

        const serialized = JSON.stringify(rulesJson);
        if (serialized.length <= ROAM_MAX_RULES_BYTES) {
            roamSet(ROAM_RULES, serialized);
            roamSet(ROAM_RULES_TS, Date.now().toString());
        } else {
            console.warn(`[CardByte] rulesJson too large for roamingSettings (${serialized.length}B > ${ROAM_MAX_RULES_BYTES}B) — Mac event runtime will fetch live`);
        }
        logTiming("setCachedRules", t0);
    } catch (_) {
        logTiming("setCachedRules (failed)", t0);
    }
}

// =============================================================================
//  PER-SIGNATURE-ID HTML CACHE (localStorage + memory only — too big to roam)
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
        // On Mac event runtime "TypeError: Load failed" here = CORS/well-known
        // URI misconfiguration. See file header prereq (a).
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

            const html = JSON.parse(decryptedData)?.html + `<table><tr><td>${xPlatform}</td></tr></table>`;

            if (html === "" || html == null) {
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
    const rulesJson = getCachedRules({ skipTtl: true, skipSessionCheck: true });
    if (!rulesJson) {
        console.log("[CardByte] prefetchAllRuleSignatures: rules not cached yet — skipping");
        return;
    }
    const enabledRules = (rulesJson?.rulesList || []).filter(r => r.enabled && r.signatureId != null);
    if (enabledRules.length === 0) return;

    const xPlatform = getXPlatform();
    const encryptedMail = await encryptEmail(userEmail);

    // De-dupe: several rules commonly point at the same signatureId.
    const uniqueIds = [...new Set(enabledRules.map(r => String(r.signatureId)))];

    console.log(`[CardByte] 🔄 Prefetching ${uniqueIds.length} unique signature(s) for ${enabledRules.length} rule(s)...`);

    await Promise.allSettled(
        uniqueIds.map(id =>
            getOrFetchSignatureById(id, encryptedMail, xPlatform)
                .catch(err => console.warn(`[CardByte] Prefetch error signatureId=${id}:`, err))
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
        try {
            field.getAsync((result) => {
                resolve(result.status === Office.AsyncResultStatus.Succeeded ? (result.value || []) : []);
            });
        } catch (_) { resolve([]); }
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

function serializeRecipients(emails) {
    return [...emails].sort().join(",");
}

// =============================================================================
//  RULES MATCHING ENGINE
// =============================================================================

function getDomain(email) {
    const at = (email || "").lastIndexOf("@");
    return at === -1 ? "" : email.slice(at + 1).toLowerCase();
}

// v6 / Fix 4 — see INTERNAL_REQUIRES_NO_EXTERNAL.
function recipientTypeMatches(recipientType, hasInternal, hasExternal) {
    if (!recipientType || recipientType.trim() === "") return true;
    const rt = recipientType.toLowerCase();
    if (rt === "all") return true;
    if (rt === "internal") return INTERNAL_REQUIRES_NO_EXTERNAL ? (hasInternal && !hasExternal) : hasInternal;
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

    return rule.Senders.some(raw => {
        const s = (raw || "").toLowerCase().trim();
        if (s === "*" || s === "all") return true;
        if (s.startsWith("*@")) return sender.endsWith(s.slice(1));
        return s === sender;
    });
}

// =============================================================================
//  COMPOSE TYPE DETECTION — v6 CORE FIX
//
//  Three behavioral changes vs v5:
//   (a) getComposeTypeAsync is bounded by COMPOSE_TYPE_TIMEOUT_MS. On Mac's
//       send runtime a callback that never fires used to hang until the outer
//       send budget expired, and then the whole flow was abandoned.
//   (b) The dead `item.inReplyToId` branch is gone — that is not an Office.js
//       compose-item property, so it never once returned "reply".
//   (c) NO unconditional `return "compose"`. Unknown is now null. The send-time
//       caller (strict) treats null as "refuse to match context rules", which
//       routes to the persisted-active-signature path instead of guessing.
// =============================================================================

const _composeTypeByItem = new WeakMap();

// Multi-letter reply/forward prefixes across common locales. Bare "R:" / "I:"
// (Italian) are omitted deliberately: a false positive there would misclassify
// a brand-new mail as a reply, which is the exact class of bug we're fixing.
const REPLY_PREFIX_RE = /^\s*(re|aw|sv|vs|antw|res|ref|fw|fwd|wg|tr|vb|rv|enc|odp|доб|回复|转发)\s*(\[\d+\])?\s*:/i;

function getComposeTypeAsyncBounded(item) {
    return new Promise((resolve) => {
        if (typeof item?.getComposeTypeAsync !== "function") return resolve("");
        let done = false;
        const timer = setTimeout(() => {
            if (done) return;
            done = true;
            console.warn(`[CardByte] getComposeTypeAsync timed out after ${COMPOSE_TYPE_TIMEOUT_MS}ms`);
            resolve("");
        }, COMPOSE_TYPE_TIMEOUT_MS);

        try {
            item.getComposeTypeAsync((res) => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                if (res.status !== Office.AsyncResultStatus.Succeeded)
                    console.warn("[CardByte] getComposeTypeAsync failed:", res.error?.message);
                resolve(res.status === Office.AsyncResultStatus.Succeeded ? (res.value?.composeType || "") : "");
            });
        } catch (e) {
            if (done) return;
            done = true;
            clearTimeout(timer);
            console.warn("[CardByte] getComposeTypeAsync threw:", e);
            resolve("");
        }
    });
}

function getSubjectBounded(item) {
    return new Promise((resolve) => {
        if (typeof item?.subject?.getAsync !== "function") return resolve("");
        let done = false;
        const timer = setTimeout(() => {
            if (!done) { done = true; resolve(""); }
        }, COMPOSE_TYPE_TIMEOUT_MS);
        try {
            item.subject.getAsync((res) => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                resolve(res.status === Office.AsyncResultStatus.Succeeded ? (res.value || "") : "");
            });
        } catch (_) {
            if (!done) { done = true; clearTimeout(timer); resolve(""); }
        }
    });
}

/**
 * @returns {Promise<"compose"|"reply"|null>} null === genuinely undetermined.
 */
async function detectComposeTypeRaw(item, { strict = false } = {}) {
    const raw = await getComposeTypeAsyncBounded(item);
    console.log("[CardByte] getComposeTypeAsync raw =", JSON.stringify(raw));

    const v = String(raw).toLowerCase();
    if (v === "reply" || v === "forward" || v === "replyall") return "reply";
    if (v === "newmail") return "compose";

    // Subject heuristic — only ever promotes to "reply". A non-empty subject
    // with no reply prefix is weak evidence of a new mail, and in strict mode
    // (send time) weak evidence is not good enough.
    const subject = await getSubjectBounded(item);
    if (subject && REPLY_PREFIX_RE.test(subject)) {
        console.log("[CardByte] composeType inferred 'reply' from subject prefix");
        return "reply";
    }
    if (!strict && subject.trim() !== "") return "compose";

    return null;
}

/**
 * Resolution order:
 *   1. this runtime's WeakMap
 *   2. the item custom property written by the compose runtime  <-- v6
 *   3. live detection
 * Step 2 is what fixes Mac: the send runtime inherits the compose runtime's
 * answer instead of re-deriving it from an API that misbehaves there.
 */
async function getComposeType(item, { strict = false, persist = false } = {}) {
    if (_composeTypeByItem.has(item)) return _composeTypeByItem.get(item);

    const fromProp = await getItemProp(item, COMPOSE_TYPE_PROP);
    if (fromProp === "compose" || fromProp === "reply") {
        console.log("[CardByte] composeType from item props:", fromProp);
        _composeTypeByItem.set(item, fromProp);
        return fromProp;
    }

    let t = await detectComposeTypeRaw(item, { strict });

    if (!t && !strict) {
        console.warn("[CardByte] composeType undetermined — assuming 'compose' (non-strict caller)");
        t = "compose";
    }

    if (t) {
        _composeTypeByItem.set(item, t);
        if (persist) setItemProps(item, { [COMPOSE_TYPE_PROP]: t }).catch(() => { });
    }
    return t;
}

// =============================================================================
//  FIND MATCHING RULE
//  v6 adds strictComposeType / persistComposeType. At send time strict mode
//  refuses to evaluate context-specific rules on an unknown compose type,
//  rather than defaulting to "compose" and letting a compose rule win.
// =============================================================================

async function findMatchingRule(item, {
    cacheOnly = false,
    allowQuickFetchMs = 0,
    strictComposeType = false,
    persistComposeType = false,
} = {}) {
    let rulesJson = cacheOnly
        ? getCachedRules({ skipTtl: true, skipSessionCheck: true })
        : getCachedRules();

    if (!rulesJson && (!cacheOnly || allowQuickFetchMs > 0)) {
        console.warn("[CardByte] Rules not in cache — live fetch...");
        const userEmail = Office?.context?.mailbox?.userProfile?.emailAddress;
        if (userEmail) {
            const enc = await encryptEmail(userEmail);
            const fetchP = fetchAndCacheRules(enc, getXPlatform());
            rulesJson = allowQuickFetchMs > 0
                ? await withTimeout(fetchP, allowQuickFetchMs).catch(() => null)
                : await fetchP;
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

    const composeType = await getComposeType(item, {
        strict: strictComposeType,
        persist: persistComposeType,
    });

    if (strictComposeType && !composeType) {
        console.warn("[CardByte] send-time: composeType unknown — refusing to match context-specific rules");
        return null; // caller falls through to the persisted-active-sig path
    }

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
        version: CB_VERSION,
        platform: detectPlatform(),
        strictComposeType,
        senderEmail, senderDomain, composeType, hasInternal, hasExternal,
        recipientDomains, totalRules: rulesJson?.rulesList?.length ?? 0,
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
            `| sigId=${r.signatureId ?? "NULL"}`
        );

        if (allMatch) { matched = r; break; }
    }

    if (!matched) console.warn("[CardByte] ❌ No rules matched", { composeType, hasInternal, hasExternal });
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
//  CORE SIGNATURE ORCHESTRATOR — cache-first fast apply.
// =============================================================================

async function applySignatureCore(item, mailbox, opts = {}, isSendTime = false) {
    const t0 = Date.now();
    const { fetchIfMissing = false, overrideHtml = null, markDefault = false } = opts;
    const userEmail = mailbox?.userProfile?.emailAddress;

    let appliedHtml = null;
    let explicitlyUnassigned = false;

    // ─── FAST PATH: apply any cached copy immediately ───
    let fastHtml = overrideHtml
        || getCachedSignature({ skipTtl: true, skipSessionCheck: true })
        || CACHED_SIGNATURE_HTML;

    if (fastHtml) {
        notifyWithTiming(item, "Applying signature (cached)...", t0);
        const ok = await applySignatureWithFallback(item, fastHtml, isSendTime);
        if (ok) appliedHtml = fastHtml;
    }

    // ─── REFRESH: fetch from server; re-apply only if different ───
    if (fetchIfMissing && userEmail && !overrideHtml) {
        let attempt = 0;
        while (attempt <= MAX_RETRIES) {
            try {
                if (attempt > 0) {
                    console.warn(`[CardByte] Retry ${attempt}/${MAX_RETRIES}...`);
                    await new Promise(r => setTimeout(r, 1000 * attempt));
                }
                const { html: fetched, explicit } = await renderSignatureOnServer(userEmail);
                if (fetched) {
                    CACHED_SIGNATURE_HTML = fetched;
                    setCachedSignature(fetched);
                    if (fetched !== appliedHtml) {
                        notifyWithTiming(item, "Updating to latest signature...", t0);
                        const ok = await applySignatureWithFallback(item, fetched, isSendTime);
                        if (ok) appliedHtml = fetched;
                    }
                    break;
                }
                if (explicit) {
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

    if (!appliedHtml && !explicitlyUnassigned) {
        console.error("[CardByte] No signature available — nothing applied");
        removeNotification(item);
        showNotification(item, "Signature not available. Please contact Admin.", "errorMessage", false);
        logTiming("applySignatureCore (no signature)", t0);
        return false;
    }

    if (appliedHtml) {
        // v6: record that the DEFAULT signature is what's in the body, with a
        // recipient snapshot, so the send handler's short-circuit can fire here
        // too instead of re-evaluating rules from a cold Mac runtime.
        if (markDefault && !isSendTime) {
            markActiveSignature(item, DEFAULT_SIG_SENTINEL).catch(() => { });
        }
        notifyWithTiming(item, "Signature applied ✓", t0);
        setTimeout(() => removeNotification(item), 3000);
    }
    logTiming("applySignatureCore total", t0);
    return !!appliedHtml;
}

// =============================================================================
//  RECIPIENT-CHANGE HANDLER
//  v6: persists composeType AND the recipient snapshot alongside the sig id.
// =============================================================================

async function onRecipientsChanged(item, mailbox) {
    if (await getManualOverride(item)) {
        console.log("[CardByte] Manual override active — skipping rule re-eval on recipient change");
        return;
    }

    const matched = await findMatchingRule(item, { persistComposeType: true });

    if (matched) {
        console.log(`[CardByte] 🎯 Rule matched → signatureId: ${matched.signatureId}`);

        const userEmail = mailbox?.userProfile?.emailAddress;
        const xPlatform = getXPlatform();
        const encryptedMail = await encryptEmail(userEmail);

        const ruleHtml = await getOrFetchSignatureById(matched.signatureId, encryptedMail, xPlatform);
        if (!ruleHtml) {
            console.warn("[CardByte] Rule signature fetch returned null — keeping current signature");
            return;
        }
        const applied = await applySignatureWithFallback(item, ruleHtml, false);
        if (applied) {
            _activeSignatureId = String(matched.signatureId);
            // Snapshot is captured HERE, after the apply, so it reflects the
            // recipient set this signature was actually chosen for.
            const snapshot = serializeRecipients(await getAllRecipientEmails(item));
            await markActiveSignature(item, matched.signatureId, { snapshot });
        }

    } else {
        console.warn("[CardByte] No rule matched / empty recipients — falling back to default signature");
        _activeSignatureId = null;
        await applySignatureCore(item, mailbox, { fetchIfMissing: true, markDefault: true }, false);
    }
}

// =============================================================================
//  RECIPIENT POLLING
// =============================================================================

let _lastRecipientSnapshot = "";
let _recipientPollTimer = null;
let _activeSignatureId = null;

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
    if (isMobile()) return;
    console.log("[CardByte] 📡 Starting recipient polling...");
    _recipientPollTimer = setInterval(() => {
        pollRecipients().catch(err => console.warn("[CardByte] pollRecipients failed:", err));
    }, RECIPIENT_POLL_MS);
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
// =============================================================================

async function resolveOverrideHtml(overrideId, mailbox) {
    if (overrideId === DEFAULT_SIG_SENTINEL) {
        return getCachedSignature({ skipTtl: true, skipSessionCheck: true });
    }
    let html = getSigById(overrideId, { skipTtl: true });
    if (!html) {
        const enc = await encryptEmail(mailbox?.userProfile?.emailAddress);
        html = await getOrFetchSignatureById(overrideId, enc, getXPlatform(), { skipTtl: true });
    }
    return html;
}

// Resolve a signature id to HTML at send time — cache first, then (Mac
// especially, where the event runtime cache is empty) a short live fetch.
async function resolveSigHtmlAtSend(sigId, mailbox) {
    if (String(sigId) === DEFAULT_SIG_SENTINEL) {
        return getCachedSignature({ skipTtl: true, skipSessionCheck: true });
    }

    let html = getSigById(String(sigId), { skipTtl: true });
    if (html) return html;

    try {
        const enc = await encryptEmail(mailbox?.userProfile?.emailAddress);
        html = await withTimeout(
            fetchSignatureById(String(sigId), enc, getXPlatform()),
            SEND_QUICK_FETCH_MS
        );
        if (html) setSigById(sigId, html);
    } catch (e) {
        console.warn(`[CardByte] onSend quick fetch failed for id=${sigId}:`, e.message);
    }
    return html || null;
}

async function _onSendCore(item, mailbox) {
    const t0 = Date.now();
    notifyWithTiming(item, "Verifying signature...", t0);

    // ─── 1. Manual taskpane selection always wins ───
    const overrideId = await getManualOverride(item);
    if (overrideId) {
        const html = await resolveOverrideHtml(overrideId, mailbox);
        if (html) {
            await applySignatureWithFallback(item, html, true);
            logTiming("_onSendCore (manual override)", t0);
            return;
        }
        console.warn("[CardByte] Override id set but html unavailable — falling back to rules");
    }

    // ─── 2. v6 SHORT-CIRCUIT ───
    // If the recipient set hasn't changed since the compose runtime picked a
    // signature, that pick is still correct by construction. Don't re-evaluate:
    // re-evaluation in the cold Mac send runtime is exactly what produced the
    // wrong-rule bug, and skipping it also saves the quick-fetch round trips.
    const [persistedId, persistedSnap] = await Promise.all([
        getItemProp(item, ACTIVE_SIG_PROP),
        getItemProp(item, RECIP_SNAPSHOT_PROP),
    ]);
    const currentSnap = serializeRecipients(await getAllRecipientEmails(item));

    if (persistedId && persistedSnap !== null && persistedSnap === currentSnap) {
        console.log(`[CardByte] onSend: recipients unchanged since compose (id=${persistedId}) — trusting applied signature`);
        removeNotification(item);
        logTiming("_onSendCore (unchanged, no re-eval)", t0);
        return;
    }
    console.log("[CardByte] onSend: recipients changed or no snapshot — re-evaluating", {
        persistedId, persistedSnap, currentSnap,
    });

    // ─── 3. Rule evaluation. strictComposeType means an unknown compose type
    //        will NOT be guessed as "compose" (the Mac bug). One bounded live
    //        rules fetch is allowed on Mac since its localStorage is empty. ───
    const matched = await findMatchingRule(item, {
        cacheOnly: true,
        allowQuickFetchMs: isMac() ? SEND_QUICK_FETCH_MS : 0,
        strictComposeType: true,
    });

    if (matched) {
        const ruleHtml = await resolveSigHtmlAtSend(matched.signatureId, mailbox);
        if (ruleHtml) {
            console.log(`[CardByte] onSend: injecting rule sig id=${matched.signatureId}`);
            await applySignatureWithFallback(item, ruleHtml, true);
            await markActiveSignature(item, matched.signatureId, { snapshot: currentSnap });
            logTiming("_onSendCore (rule)", t0);
            return;
        }
        console.warn(`[CardByte] onSend: rule sig id=${matched.signatureId} unavailable — trying last-applied signature`);
    }

    // ─── 4. Cross-runtime fallback: whatever was actually applied to THIS
    //        draft. Item props first (works on Mac), then localStorage, then
    //        roamingSettings. ───
    const persistedActiveId = persistedId || await getActiveSignatureId(item);
    if (persistedActiveId) {
        console.warn("[CardByte] onSend: falling back to persisted active signature id:", persistedActiveId);
        const activeHtml = await resolveSigHtmlAtSend(persistedActiveId, mailbox);
        if (activeHtml) {
            await applySignatureWithFallback(item, activeHtml, true);
            logTiming("_onSendCore (persisted fallback)", t0);
            return;
        }
        // A signature IS already in the body — never overwrite it with default.
        console.warn("[CardByte] onSend: active sig HTML unavailable — leaving body as-is");
        removeNotification(item);
        logTiming("_onSendCore (leave as-is)", t0);
        return;
    }

    // ─── 5. No rule was ever active → default is genuinely correct. ───
    const cached = getCachedSignature({ skipTtl: true, skipSessionCheck: true });
    if (!cached) {
        console.warn("[CardByte] onSend: no cached default — leaving body as-is");
        removeNotification(item);
        logTiming("_onSendCore (no sig)", t0);
        return;
    }

    console.log("[CardByte] onSend: injecting default sig from cache");
    await applySignatureWithFallback(item, cached, true);
    logTiming("_onSendCore (default)", t0);
}

// =============================================================================
//  OFFICE READY
//  NOTE: on Windows classic the event runtime does NOT run Office.onReady —
//  never put logic here that handlers depend on.
// =============================================================================

Office.onReady(() => {
    console.log(`✅ Office.onReady Started — CardByte ${CB_VERSION}`);
    console.log(`[CardByte] Platform: ${detectPlatform()} | X-Platform header: ${getXPlatform()}`);

    if (Office.context.mailbox) {
        console.log("📧 Mailbox Diagnostics:", Office.context.mailbox.diagnostics);
        console.log("📌 Host Name:", Office.context.mailbox.diagnostics.hostName);
        console.log("📌 Host Version:", Office.context.mailbox.diagnostics.hostVersion);
    }

    purgeStaleSigById();
});

// =============================================================================
//  PUBLIC ENTRY POINTS
// =============================================================================

const applySignature = async function (event = { completed: () => { } }) {
    const t0 = Date.now();
    const mailbox = Office?.context?.mailbox;
    const item = mailbox?.item;

    let _completed = false;
    const completeOnce = () => {
        if (_completed) return;
        _completed = true;
        stopRecipientPolling();
        logTiming("applySignature total (completed)", t0);
        try { event.completed(); } catch (_) { }
    };

    try {
        if (!item) { completeOnce(); return; }

        console.log(`[CardByte] applySignature start — ${CB_VERSION} on ${detectPlatform()}`);
        notifyWithTiming(item, "Starting signature flow...", t0);

        _activeSignatureId = null;
        await markActiveSignature(item, null);

        // v6: determine and PERSIST the compose type as early as possible, in
        // the runtime where the Office API actually behaves. Everything
        // downstream (including the send runtime) reads this instead of
        // re-deriving it. Fire-and-forget so it never blocks the body apply.
        const composeTypeP = getComposeType(item, { persist: true })
            .then(t => { console.log("[CardByte] composeType resolved at compose:", t); return t; })
            .catch(err => { console.warn("[CardByte] composeType resolution failed:", err); return null; });

        // ─── FAST: apply default signature from cache immediately (network
        //     refresh happens inside applySignatureCore afterwards). ───
        const coreP = applySignatureCore(item, mailbox, { fetchIfMissing: true, markDefault: true }, false);

        // ─── Rules refresh runs CONCURRENTLY. ───
        const userEmail = mailbox?.userProfile?.emailAddress;
        const rulesP = (async () => {
            if (!userEmail) return;
            const rulesFresh = getCachedRules();
            if (!rulesFresh) {
                const enc = await encryptEmail(userEmail);
                await fetchAndCacheRules(enc, getXPlatform());
            }
        })().catch(err => console.warn("[CardByte] Rules refresh failed:", err));

        await Promise.allSettled([coreP, rulesP, composeTypeP]);

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

        if (!isMobile()) startRecipientPolling();

    } catch (err) {
        console.error("[CardByte] applySignature error:", err);
    } finally {
        // ─── MAC KEEP-ALIVE ───
        // event.completed() tears down the Mac event runtime, killing recipient
        // polling. Delay completion so the poller lives; the runtime hard-stops
        // at ~5 min or when the user sends/navigates away regardless.
        if (isMac()) {
            console.log(`[CardByte] Mac: deferring event.completed() ${MAC_KEEPALIVE_MS}ms to keep polling alive`);
            setTimeout(completeOnce, MAC_KEEPALIVE_MS);
        } else {
            completeOnce();
        }
    }
};

const onSendHandler = async function (event = { completed: () => { } }) {
    const t0 = Date.now();
    const mailbox = Office?.context?.mailbox;
    const item = mailbox?.item;

    let _done = false;
    const done = (allow = true) => {
        if (_done) return;
        _done = true;
        logTiming("onSendHandler total", t0);
        try { event.completed({ allowEvent: allow }); } catch (_) { }
    };

    try {
        if (!item) { done(true); return; }

        stopRecipientPolling();

        console.log(`[CardByte] onSendHandler start — ${CB_VERSION} on ${detectPlatform()}`);
        notifyWithTiming(item, "Verifying before send...", t0);

        // Mac needs headroom for the bounded live fetches (its event runtime
        // has no cache). The v6 short-circuit usually returns long before this.
        const budget = isMac() ? SEND_TIMEOUT_MS_MAC : SEND_TIMEOUT_MS_DEFAULT;
        await withTimeout(_onSendCore(item, mailbox), budget);

        setTimeout(() => removeNotification(item), 3000);

    } catch (err) {
        console.warn("[CardByte] onSend timeout/error:", err.message);
        removeNotification(item);
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
        await markActiveSignature(item, null);

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
            await applySignatureCore(item, mailbox, { fetchIfMissing: true, markDefault: true }, false);
        }

        setTimeout(() => removeNotification(item), 3000);

    } catch (err) {
        console.error("[CardByte] onFromChangedHandler error:", err);
    } finally {
        logTiming("onFromChangedHandler total", t0);
        try { event.completed(); } catch (_) { }
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
            event.completed();
            return;
        }
        _lastRecipientSnapshot = snapshot;

        await onRecipientsChanged(item, mailbox);

    } catch (err) {
        console.error("[CardByte] onRecipientsChangedHandler error:", err);
    } finally {
        logTiming("onRecipientsChangedHandler total", t0);
        try { event.completed(); } catch (_) { }
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
    console.log(`[CardByte] ${CB_VERSION} registered: applySignature, onSendHandler, onFromChangedHandler, onRecipientsChangedHandler`);
} else {
    console.log("[CardByte] Office.actions unavailable — LaunchEvent path inactive (Outlook 2016/2019)");
}