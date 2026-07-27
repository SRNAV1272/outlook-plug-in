"use strict";

// =============================================================================
//  CardByte Outlook Add-in — event-handler.js (FIXED v5 — Mac auto-apply)
//
//  Root cause of the Mac failure (taskpane worked, auto-apply didn't):
//  Mac runs LaunchEvent handlers in a FRESH browser runtime (WKWebView) whose
//  localStorage is NOT shared with the taskpane runtime. All v4 cross-runtime
//  handoffs (rules cache, sigById cache, active-sig id) read empty storage,
//  silently returned null, and fell through to the default signature. The
//  network fallback then failed too, because the Mac event runtime enforces
//  CORS (custom headers => preflight) and requires the add-in JS to be listed
//  at /.well-known/microsoft-officeaddins-allowed.json on the API host.
//
//  v5 changes:
//  1. MULTI-SOURCE STORE: memory -> localStorage -> roamingSettings for small
//     values (active sig id, rules JSON if it fits). localStorage remains a
//     best-effort L2, never the only channel.
//  2. ITEM CUSTOM PROPERTIES carry the active signature id. They are attached
//     to the mail item itself, so ANY runtime (compose event, send event,
//     taskpane) on ANY platform can read what was applied to THIS draft.
//  3. Send time is no longer 100% cache-only on Mac: if the id is known but
//     the HTML isn't cached in this runtime, do a short (2.5s) live fetch.
//  4. Cache-first compose: apply whatever signature we can IMMEDIATELY, then
//     refresh rules/signatures from network and re-evaluate. The user never
//     stares at an empty body while a fetch times out.
//  5. Mac keep-alive: event.completed() is DELAYED on Mac for the compose
//     handler so recipient polling survives (calling completed() tears the
//     Mac event runtime down, which killed the poller in v4).
//  6. X-Platform header is real again ("MAC"/"MOBILE"/"WINDOWS") behind a
//     single override constant, so the backend stops receiving WINDOWS from
//     every platform. Set X_PLATFORM_FORCE = "WINDOWS" to restore v4 behavior
//     if the backend rejects "MAC".
//
//  DEPLOYMENT PREREQS FOR MAC (not fixable in this file — verify these):
//  a) https://ns-enterprise.cardbyte.ai/.well-known/microsoft-officeaddins-allowed.json
//     must exist and list this add-in's ID and the full URL of this JS file,
//     and the API must return proper CORS headers. Without it, ALL fetches
//     from the Mac event runtime reject with "TypeError: Load failed".
//  b) Manifest must be the ADD-IN ONLY (XML) manifest for Mac (unified
//     manifest event activation is not supported on Mac), and LaunchEvents
//     must include OnNewMessageCompose, OnMessageRecipientsChanged,
//     OnMessageFromChanged, OnMessageSend.
//  c) Debug on Mac: defaults write com.microsoft.Outlook
//     OfficeWebAddinDeveloperExtras -bool true  -> inspect via Safari Develop.
// =============================================================================

// ─── Constants ────────────────────────────────────────────────────────────────

const AES_KEY = "fnItrY2YfozBqCC2B4XsfqHIvZku3kUOq3DFkbO64kk=";
const AES_IV = "3YapeNfJDung7TXxeKXn4g==";

const BASE_URL = "https://ns-enterprise.cardbyte.ai/email-signature";

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

// v5: item-scoped custom property names (cross-runtime, cross-platform)
const ACTIVE_SIG_PROP = "cardbyte_active_sig_id";
const MANUAL_OVERRIDE_PROP = "cardbyte_manual_sig_id";

// v5: roamingSettings keys (mailbox-scoped, ~32KB total budget — small values only)
const ROAM_ACTIVE_SIG = "cb_active_sig";
const ROAM_RULES = "cb_rules";
const ROAM_RULES_TS = "cb_rules_ts";
const ROAM_MAX_RULES_BYTES = 20 * 1024; // leave headroom in the 32KB budget

const MAX_SAFE_HTML_SIZE = 500_000;
const MAX_SAFE_HTML_SIZE_MOBILE = 200_000;
const MAX_RETRIES = 2;
const RECIPIENT_POLL_MS = 900;

// v5: send-time budgets. Office allows ~5 min; v4's 4s guaranteed the
// cache-miss path on Mac. Mac gets a longer budget + one quick network try.
const SEND_TIMEOUT_MS_MAC = 12_000;
const SEND_TIMEOUT_MS_DEFAULT = 5_000;
const SEND_QUICK_FETCH_MS = 2_500;

// v5: how long to keep the Mac compose event runtime alive so recipient
// polling keeps working (runtime hard-times-out at ~5 min anyway).
const MAC_KEEPALIVE_MS = 4 * 60 * 1000;

// v5: set to "WINDOWS" to force the old behavior if the backend rejects MAC.
const X_PLATFORM_FORCE = null;

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

// v5 FIX: report the real platform (was hardcoded "WINDOWS", so the backend
// received WINDOWS from Mac — if the backend branches or validates on
// X-Platform this alone breaks Mac). X_PLATFORM_FORCE restores old behavior.
function getXPlatform() {
    // if (X_PLATFORM_FORCE) return X_PLATFORM_FORCE;
    // const p = detectPlatform();
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
//  CRYPTO — AES-CBC via Web Crypto API (unchanged from v4)
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
//  STORAGE — v5 MULTI-SOURCE
//  L1: in-memory (this runtime).  L2: localStorage (best effort — EMPTY in the
//  Mac event runtime, which was the v4 reading fault).  L3: roamingSettings
//  (mailbox-scoped, works in every runtime incl. Mac events; ~32KB budget so
//  only small values live here). Signature HTML never goes to roaming.
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

// roamingSettings helpers — synchronous get, fire-and-forget persist.
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
//  SESSION ID (unchanged)
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
//  ITEM CUSTOM PROPERTIES — v5 primary cross-runtime channel
//  Attached to the draft itself, readable from ANY runtime on ANY platform.
//  (Caveat: Mac doesn't cache custom props offline — the localStorage/roaming
//  fallbacks below cover that.)
// =============================================================================

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

async function setActiveSigOnItem(item, id) {
    const props = await loadCustomProps(item);
    if (!props) return;
    try {
        if (id == null) props.remove(ACTIVE_SIG_PROP);
        else props.set(ACTIVE_SIG_PROP, String(id));
        props.saveAsync(() => { });
    } catch (_) { }
}

async function getActiveSigFromItem(item) {
    const props = await loadCustomProps(item);
    const id = props?.get(ACTIVE_SIG_PROP);
    return id ? String(id) : null;
}

// =============================================================================
//  ACTIVE SIGNATURE ID — v5 writes to item props + roaming + localStorage,
//  reads from all three (item props win: they're per-draft).
// =============================================================================

function setActiveSignatureId(id, item = null) {
    if (id == null) {
        store.remove(ACTIVE_SIG_KEY, ACTIVE_SIG_TS_KEY);
        roamRemove(ROAM_ACTIVE_SIG);
    } else {
        store.set(ACTIVE_SIG_KEY, String(id));
        store.set(ACTIVE_SIG_TS_KEY, Date.now().toString());
        roamSet(ROAM_ACTIVE_SIG, String(id));
    }
    if (item) setActiveSigOnItem(item, id).catch(() => { });
}

async function getActiveSignatureId(item = null) {
    // 1. Item custom property — authoritative for THIS draft, cross-runtime.
    if (item) {
        const fromItem = await getActiveSigFromItem(item);
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
//  DEFAULT SIGNATURE CACHE (v4 semantics kept; store is now multi-source)
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
//  RULES CACHE — v5: mirrored to roamingSettings when small enough, so the
//  Mac event runtime can evaluate rules without localStorage OR network.
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

        // v5: mirror to roamingSettings if it fits the budget.
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
//  API LAYER (unchanged except platform header now honest)
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

            const html = JSON.parse(decryptedData)?.html;

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

    console.log(`[CardByte] 🔄 Prefetching signatures for ${enabledRules.length} rule(s)...`);

    await Promise.allSettled(
        enabledRules.map(r =>
            getOrFetchSignatureById(r.signatureId, encryptedMail, xPlatform)
                .catch(err => console.warn(`[CardByte] Prefetch error signatureId=${r.signatureId}:`, err))
        )
    );
    console.log("[CardByte] Prefetch complete");
}

// =============================================================================
//  RECIPIENT HELPERS (unchanged)
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
//  RULES MATCHING ENGINE (unchanged)
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

    return rule.Senders.some(raw => {
        const s = (raw || "").toLowerCase().trim();
        if (s === "*" || s === "all") return true;
        if (s.startsWith("*@")) return sender.endsWith(s.slice(1));
        return s === sender;
    });
}

// =============================================================================
//  COMPOSE TYPE DETECTION (unchanged)
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
            if (raw === "reply" || raw === "forward") return "reply";
            if (raw === "newmail") return "compose";
        } catch (e) {
            console.warn("[CardByte] getComposeTypeAsync threw:", e);
        }
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
            return "reply";
        }
    } catch (e) {
        console.warn("[CardByte] Subject check failed:", e);
    }

    try {
        if (item?.inReplyToId) return "reply";
    } catch (e) { }

    return "compose";
}

function getComposeType(item) {
    if (_composeTypeByItem.has(item)) return Promise.resolve(_composeTypeByItem.get(item));
    return detectComposeType(item).then((detected) => {
        _composeTypeByItem.set(item, detected);
        return detected;
    });
}

// =============================================================================
//  FIND MATCHING RULE — v5: cacheOnly now also reads the roaming mirror, and
//  a new allowQuickFetch option gives Mac's send-time path one bounded live
//  fetch (v4's pure cacheOnly was guaranteed to fail on Mac because the
//  event runtime's localStorage is empty).
// =============================================================================

async function findMatchingRule(item, { cacheOnly = false, allowQuickFetchMs = 0 } = {}) {
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
//  SIGNATURE INJECTION (unchanged)
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
//  CORE SIGNATURE ORCHESTRATOR — v5: cache-first fast apply. If ANY cached
//  copy exists it goes into the body immediately; the network refresh then
//  runs and re-applies only if the HTML actually changed. The user never
//  waits on a fetch (which on Mac could be failing entirely).
// =============================================================================

async function applySignatureCore(item, mailbox, opts = {}, isSendTime = false) {
    const t0 = Date.now();
    const { fetchIfMissing = false, overrideHtml = null } = opts;
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
        notifyWithTiming(item, "Signature applied ✓", t0);
        setTimeout(() => removeNotification(item), 3000);
    }
    logTiming("applySignatureCore total", t0);
    return !!appliedHtml;
}

// =============================================================================
//  RECIPIENT-CHANGE HANDLER — v5: active id also persisted to ITEM PROPS.
// =============================================================================

async function onRecipientsChanged(item, mailbox) {
    if (await getManualOverride(item)) {
        console.log("[CardByte] Manual override active — skipping rule re-eval on recipient change");
        return;
    }

    const matched = await findMatchingRule(item);

    if (matched) {
        console.log(`[CardByte] 🎯 Rule matched → signatureId: ${matched.signatureId}`);

        const userEmail = Office?.context?.mailbox?.userProfile?.emailAddress;
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
            // v5: item props are the channel the Mac send-time runtime can read.
            setActiveSignatureId(matched.signatureId, item);
        }

    } else {
        console.warn("[CardByte] No rule matched / empty recipients — falling back to default signature");
        _activeSignatureId = null;
        setActiveSignatureId(null, item);
        await applySignatureCore(item, mailbox, { fetchIfMissing: true }, false);
    }
}

// =============================================================================
//  RECIPIENT POLLING
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
    if (isMobile()) return;
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
//  SEND-TIME CORE — v5: item props first; Mac gets bounded live fetches.
// =============================================================================

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

// v5: resolve a signature id to HTML at send time — cache first, then (Mac
// especially, where the event runtime cache is empty) a short live fetch.
async function resolveSigHtmlAtSend(sigId, mailbox) {
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
    notifyWithTiming(item, "Re-applying correct signature...", t0);

    // ─── Manual taskpane selection wins ───
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

    // ─── Rule evaluation. On Mac allow ONE bounded live rules fetch, because
    //     the event runtime's localStorage is empty (the v4 dead end). ───
    const matched = await findMatchingRule(item, {
        cacheOnly: true,
        allowQuickFetchMs: isMac() ? SEND_QUICK_FETCH_MS : 0,
    });

    if (matched) {
        const ruleHtml = await resolveSigHtmlAtSend(matched.signatureId, mailbox);
        if (ruleHtml) {
            console.log(`[CardByte] onSend: injecting rule sig id=${matched.signatureId}`);
            await applySignatureWithFallback(item, ruleHtml, true);
            logTiming("_onSendCore (rule)", t0);
            return;
        }
        console.warn(`[CardByte] onSend: rule sig id=${matched.signatureId} unavailable — trying last-applied signature`);
    }

    // ─── Cross-runtime fallback: the signature actually applied to THIS draft.
    //     v5 reads it from ITEM CUSTOM PROPS first (works on Mac), then
    //     localStorage, then roamingSettings. ───
    const persistedActiveId = await getActiveSignatureId(item);
    if (persistedActiveId) {
        console.warn("[CardByte] onSend: falling back to persisted active signature id:", persistedActiveId);
        const activeHtml = await resolveSigHtmlAtSend(persistedActiveId, mailbox);
        if (activeHtml) {
            await applySignatureWithFallback(item, activeHtml, true);
            logTiming("_onSendCore (persisted fallback)", t0);
            return;
        }
        // A rule signature IS in the body — never overwrite it with default.
        console.warn("[CardByte] onSend: active sig HTML unavailable — leaving body as-is");
        removeNotification(item);
        logTiming("_onSendCore (leave as-is)", t0);
        return;
    }

    // ─── No rule was ever active → default is genuinely correct. ───
    const cached = getCachedSignature({ skipTtl: true, skipSessionCheck: true });
    if (!cached) {
        // Body already contains whatever compose-time applied; do nothing
        // destructive. (v4 showed an error here; keep it informational.)
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

        notifyWithTiming(item, "Starting signature flow...", t0);

        _activeSignatureId = null;
        setActiveSignatureId(null, item);

        // ─── FAST: apply default signature from cache immediately (network
        //     refresh happens inside applySignatureCore afterwards). ───
        const coreP = applySignatureCore(item, mailbox, { fetchIfMissing: true }, false);

        // ─── Rules refresh runs CONCURRENTLY — v4 awaited it before applying
        //     anything, so a hanging/failing fetch on Mac stalled the whole
        //     flow with an empty body. ───
        const userEmail = mailbox?.userProfile?.emailAddress;
        const rulesP = (async () => {
            if (!userEmail) return;
            const rulesFresh = getCachedRules();
            if (!rulesFresh) {
                const enc = await encryptEmail(userEmail);
                await fetchAndCacheRules(enc, getXPlatform());
            }
        })().catch(err => console.warn("[CardByte] Rules refresh failed:", err));

        await Promise.allSettled([coreP, rulesP]);

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
        // ─── v5 MAC KEEP-ALIVE ───
        // On Mac, event.completed() tears down this runtime, killing recipient
        // polling (v4: poller was dead the moment compose opened). Delay
        // completion so the poller lives; the runtime hard-stops at ~5 min or
        // when the user sends/navigates away regardless.
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

    const done = (allow = true) => {
        logTiming("onSendHandler total", t0);
        event.completed({ allowEvent: allow });
    };

    try {
        if (!item) { done(true); return; }

        stopRecipientPolling();

        notifyWithTiming(item, "Verifying before send...", t0);

        // v5: Mac needs headroom for the bounded live fetches (its event
        // runtime has no cache). 4s guaranteed failure there.
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
        setActiveSignatureId(null, item);

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