"use strict";

// =============================================================================
//  CardByte Outlook Add-in — event-handler.js (v6 — cross-runtime signature handoff)
//
//  WHAT v6 FIXES
//  The send-time handler used to RE-DERIVE which signature belongs on the draft
//  (rules -> persisted id -> default). On Mac the OnMessageSend handler runs in
//  a FRESH runtime with empty localStorage, so re-derivation fell through to
//  roamingSettings — a MAILBOX-SCOPED, PERMANENT value left behind by some
//  earlier draft. That stale id is what produced the wrong signature on send.
//
//  v6 stops re-deriving. Compose/reply stashes the signature it ACTUALLY
//  applied onto the draft itself (sessionData, item-scoped, survives the
//  runtime boundary). Send reads that stash and re-applies it. The re-apply
//  still happens on every send, so the tamper guard is fully intact — only the
//  SOURCE of the HTML changed, from "guess again" to "what compose applied".
//
//  KEY CHANGES
//  1. CAPABILITY GATING, not platform gating. The stash is enabled by
//     Mailbox 1.11 support, not by isMac(). Safari (ITP) and Firefox (Total
//     Cookie Protection) can silently degrade localStorage in the add-in
//     iframe and hit the exact same isolation failure; they now get the fix
//     too, without needing to be detected.
//  2. MERGED SEND PATH. One _onSendCore for desktop/web:
//     override -> in-memory sigById -> stashed HTML -> refetch by stashed id
//     -> recovery (rules -> default). Windows/Edge/Chrome exit at step 2 and
//     behave exactly as before.
//  3. ROAMING ACTIVE-SIG ID REMOVED from the desktop/web read chain. It is the
//     value that produced the wrong signature. (roamingSettings is still used
//     for the RULES mirror — that is per-mailbox by nature and correct.)
//  4. CUSTOM PROPERTIES are now a single memoized snapshot per item with
//     serialized saves. v5 loaded independent snapshots and saved whole copies
//     back, so the clearing save at compose start could land after the real
//     write and wipe it.
//  5. MOBILE IS UNTOUCHED. isMobile() short-circuits to _onSendCoreLegacy(),
//     a verbatim copy of v5's send logic including its roaming-aware id read.
//     The stash is a no-op on mobile. No new async calls, no new failure modes,
//     no behavioural change on iOS/Android.
//
//  UNCHANGED FROM v5 (deliberately)
//  - MAC_KEEPALIVE_MS deferral stays Mac-only. Holding a compose event open on
//    Windows blocks subsequent event activations for the item.
//  - getXPlatform() still returns "WINDOWS". Flagged, not changed — altering
//    the header risks backend-side rejection and is unrelated to this bug.
//
//  DEPLOYMENT PREREQS FOR MAC (not fixable in this file — verify these):
//  a) https://newqa-enterprise.cardbyte.ai/.well-known/microsoft-officeaddins-allowed.json
//     must exist, list this add-in's ID and the full URL of this JS file, and
//     the API must return proper CORS headers. Without it, every fetch from the
//     Mac event runtime rejects with "TypeError: Load failed". v6 needs the
//     network far less than v5 (the stash carries the HTML), but the recovery
//     paths still depend on it.
//  b) Manifest must be the ADD-IN ONLY (XML) manifest for Mac, with LaunchEvents
//     for OnNewMessageCompose, OnMessageRecipientsChanged, OnMessageFromChanged,
//     OnMessageSend.
//  c) Debug on Mac: defaults write com.microsoft.Outlook
//     OfficeWebAddinDeveloperExtras -bool true  -> inspect via Safari Develop.
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
const SIG_BY_ID_PURGE_MS = 24 * 60 * 60 * 1000;

const ACTIVE_SIG_KEY = "cardbyte_active_sig_id";
const ACTIVE_SIG_TS_KEY = "cardbyte_active_sig_ts";
const ACTIVE_SIG_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// Item-scoped custom property names (cross-runtime, cross-platform backup).
const ACTIVE_SIG_PROP = "cardbyte_active_sig_id";
const MANUAL_OVERRIDE_PROP = "cardbyte_manual_sig_id";

// roamingSettings keys (mailbox-scoped, ~32KB budget — small values only).
// NOTE: ROAM_ACTIVE_SIG is retained ONLY for the legacy mobile path and for
// one-time cleanup. Desktop/web no longer read or write it.
const ROAM_ACTIVE_SIG = "cb_active_sig";
const ROAM_RULES = "cb_rules";
const ROAM_RULES_TS = "cb_rules_ts";
const ROAM_MAX_RULES_BYTES = 20 * 1024;

// v6: sessionData stash — the applied signature, carried on the draft itself.
const SD_SIG_ID = "cb_sig_id";
const SD_SIG_CHUNKS = "cb_sig_chunks";
const SD_SIG_CHUNK = (i) => `cb_sig_${i}`;
const SD_CHUNK_SIZE = 15_000;
const SD_MAX_HTML = 45_000;   // stay inside the ~50k-char sessionData budget
const SD_MAX_CHUNKS = 8;      // hard ceiling; guards against runaway loops

const MAX_SAFE_HTML_SIZE = 500_000;
const MAX_SAFE_HTML_SIZE_MOBILE = 200_000;
const MAX_RETRIES = 2;
const RECIPIENT_POLL_MS = 900;

// Send-time budgets. OnMessageSend allows ~5 min. v6 rarely needs the network
// at send (the stash carries the HTML), so the Mac budget can be generous
// without slowing the common case — those paths only run on a stash miss.
const SEND_TIMEOUT_MS_MAC = 20_000;
const SEND_TIMEOUT_MS_DEFAULT = 5_000;
const SEND_QUICK_FETCH_MS = 2_500;
const SEND_QUICK_FETCH_MS_MAC = 8_000;

// How long to keep the Mac compose event runtime alive so recipient polling
// keeps working (the runtime hard-times-out at ~5 min anyway). MAC ONLY.
const MAC_KEEPALIVE_MS = 4 * 60 * 1000;

// Set to "WINDOWS" to force old behaviour if the backend rejects real values.
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
//  PLATFORM DETECTION (unchanged)
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

// =============================================================================
//  v6: CAPABILITY DETECTION
//  Gate on what the host actually supports rather than on which host it is.
//  Safari/Firefox OWA can degrade storage silently and need the stash without
//  being identifiable via detectPlatform().
// =============================================================================

function _isSetSupported(name, version) {
    try { return !!Office?.context?.requirements?.isSetSupported?.(name, version); }
    catch (_) { return false; }
}

// setSignatureAsync requires Mailbox 1.10.
const CAN_SET_SIGNATURE = _isSetSupported("Mailbox", "1.10");
// sessionData requires Mailbox 1.11.
const CAN_STASH_RAW = _isSetSupported("Mailbox", "1.11");

// Mobile keeps v5 behaviour exactly — the stash is disabled there outright.
const canStash = () => CAN_STASH_RAW && !isMobile();

function logCapabilities() {
    console.log("[CardByte] capabilities:", {
        platform: detectPlatform(),
        setSignatureAsync_1_10: CAN_SET_SIGNATURE,
        sessionData_1_11: CAN_STASH_RAW,
        stashEnabled: canStash(),
    });
}

// Reports the real platform. Left returning "WINDOWS" pending backend
// confirmation — see file header.
function getXPlatform() {
    // if (X_PLATFORM_FORCE) return X_PLATFORM_FORCE;
    // const p = detectPlatform();
    // if (p === "mac") return "MAC";
    // if (p === "mobile-ios" || p === "mobile-android") return "MOBILE";
    return "WINDOWS";
}

// =============================================================================
//  NOTIFICATION HELPERS (unchanged)
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
//  STORAGE — memory L1 + localStorage L2
//  localStorage is EMPTY in the Mac event runtime and may be blocked entirely
//  by Safari ITP / Firefox TCP in the add-in iframe. It is best-effort only;
//  nothing correctness-critical may depend on it.
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
// Used for the RULES mirror (correctly mailbox-scoped) and, on mobile only,
// the legacy active-sig id.
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
//  ITEM CUSTOM PROPERTIES — v6: ONE memoized snapshot per item, saves serialized
//
//  v5 called loadCustomPropertiesAsync at every site. Each call returns an
//  INDEPENDENT snapshot and saveAsync writes the whole snapshot back, so a
//  later-resolving stale snapshot could overwrite a newer one. That is how the
//  compose-start clear could erase the id written by onRecipientsChanged.
// =============================================================================

const _propsByItem = new WeakMap();
const _propsSaveChain = new WeakMap();

function loadCustomProps(item) {
    if (!item) return Promise.resolve(null);
    if (_propsByItem.has(item)) return _propsByItem.get(item);

    const p = new Promise((resolve) => {
        if (typeof item?.loadCustomPropertiesAsync !== "function") return resolve(null);
        try {
            item.loadCustomPropertiesAsync((res) =>
                resolve(res?.status === Office.AsyncResultStatus.Succeeded ? res.value : null)
            );
        } catch { resolve(null); }
    });

    _propsByItem.set(item, p);
    return p;
}

function saveCustomProps(item, props) {
    const prev = _propsSaveChain.get(item) || Promise.resolve();
    const next = prev
        .catch(() => { })
        .then(() => new Promise((resolve) => {
            try { props.saveAsync(() => resolve()); } catch (_) { resolve(); }
        }));
    _propsSaveChain.set(item, next);
    return next;
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
        await saveCustomProps(item, props);
    } catch (_) { }
}

async function getActiveSigFromItem(item) {
    const props = await loadCustomProps(item);
    const id = props?.get(ACTIVE_SIG_PROP);
    return id ? String(id) : null;
}

// =============================================================================
//  ACTIVE SIGNATURE ID
//
//  v6: the roamingSettings channel is OFF by default. It is mailbox-scoped and
//  permanent, so on any runtime where localStorage is unavailable it becomes
//  the only survivor and always wins — with whatever id an unrelated draft left
//  behind. That is the wrong-signature bug. allowRoaming:true exists solely so
//  the legacy mobile send path keeps its exact v5 behaviour.
// =============================================================================

function setActiveSignatureId(id, item = null, { allowRoaming = false } = {}) {
    if (id == null) {
        store.remove(ACTIVE_SIG_KEY, ACTIVE_SIG_TS_KEY);
        if (allowRoaming) roamRemove(ROAM_ACTIVE_SIG);
    } else {
        store.set(ACTIVE_SIG_KEY, String(id));
        store.set(ACTIVE_SIG_TS_KEY, Date.now().toString());
        if (allowRoaming) roamSet(ROAM_ACTIVE_SIG, String(id));
    }
    if (item) setActiveSigOnItem(item, id).catch(() => { });
}

async function getActiveSignatureId(item = null, { allowRoaming = false } = {}) {
    // 1. Item custom property — authoritative for THIS draft, cross-runtime.
    if (item) {
        const fromItem = await getActiveSigFromItem(item);
        if (fromItem) return fromItem;
    }
    // 2. localStorage / memory (same-runtime only).
    const id = store.get(ACTIVE_SIG_KEY);
    if (id) {
        const ts = parseInt(store.get(ACTIVE_SIG_TS_KEY) || "0", 10);
        if (!ts || Date.now() - ts <= ACTIVE_SIG_MAX_AGE_MS) return id;
    }
    // 3. roamingSettings — legacy mobile path only. See note above.
    if (allowRoaming) {
        const roamed = roamGet(ROAM_ACTIVE_SIG);
        return roamed ? String(roamed) : null;
    }
    return null;
}

// =============================================================================
//  v6: SESSION DATA STASH — the applied signature, carried on the draft
//
//  sessionData is item-scoped and is the API designed for the compose ->
//  OnMessageSend handoff. It survives the Mac runtime boundary and does not
//  depend on localStorage, so it is immune to both Mac runtime isolation and
//  Safari/Firefox storage partitioning.
//
//  Budget is ~50,000 characters TOTAL, so HTML is chunked and oversized
//  signatures fall back to id-only (send refetches by that exact id).
//  DISABLED ON MOBILE — see canStash().
// =============================================================================

let _lastStashKey = null;

function sdSet(item, key, val) {
    return new Promise((resolve) => {
        if (typeof item?.sessionData?.setAsync !== "function") return resolve(false);
        try {
            item.sessionData.setAsync(key, val, (r) =>
                resolve(r?.status === Office.AsyncResultStatus.Succeeded)
            );
        } catch (_) { resolve(false); }
    });
}

function sdGet(item, key) {
    return new Promise((resolve) => {
        if (typeof item?.sessionData?.getAsync !== "function") return resolve(null);
        try {
            item.sessionData.getAsync(key, (r) =>
                resolve(r?.status === Office.AsyncResultStatus.Succeeded ? (r.value ?? null) : null)
            );
        } catch (_) { resolve(null); }
    });
}

/**
 * Record the signature that was ACTUALLY written into the body.
 * Call only after setSignatureAsync succeeded. id === "default" is valid.
 */
async function stashAppliedSignature(item, id, html) {
    const sigId = id == null ? "default" : String(id);

    // Custom properties are the small, always-attempted backup channel.
    setActiveSigOnItem(item, sigId).catch(() => { });

    if (!canStash()) return;   // mobile, or host below Mailbox 1.11

    // The 900ms poller can re-apply the same signature repeatedly; skip
    // redundant setAsync round-trips.
    const key = `${sigId}:${html ? html.length : 0}`;
    if (key === _lastStashKey) return;
    _lastStashKey = key;

    try {
        await sdSet(item, SD_SIG_ID, sigId);

        const tooBig = !html
            || html.length > SD_MAX_HTML
            || Math.ceil(html.length / SD_CHUNK_SIZE) > SD_MAX_CHUNKS;

        if (tooBig) {
            await sdSet(item, SD_SIG_CHUNKS, "0");
            console.warn(`[CardByte] stash: HTML ${html ? html.length : 0} chars exceeds sessionData budget — send will refetch id=${sigId}`);
            return;
        }

        const n = Math.ceil(html.length / SD_CHUNK_SIZE);
        for (let i = 0; i < n; i++) {
            const ok = await sdSet(item, SD_SIG_CHUNK(i),
                html.slice(i * SD_CHUNK_SIZE, (i + 1) * SD_CHUNK_SIZE));
            if (!ok) {
                await sdSet(item, SD_SIG_CHUNKS, "0");
                console.warn("[CardByte] stash: chunk write failed — falling back to id-only");
                return;
            }
        }
        await sdSet(item, SD_SIG_CHUNKS, String(n));
        console.log(`[CardByte] stash: applied sig id=${sigId} (${n} chunk(s), ${html.length} chars)`);
    } catch (e) {
        console.warn("[CardByte] stashAppliedSignature failed:", e);
    }
}

/**
 * Read back what compose/reply applied to THIS draft.
 * Returns { id, html } — html may be null when the signature was too large.
 */
async function readStashedSignature(item) {
    let id = null;
    let html = null;

    if (canStash()) {
        id = await sdGet(item, SD_SIG_ID);

        const n = parseInt((await sdGet(item, SD_SIG_CHUNKS)) || "0", 10);
        if (n > 0 && n <= SD_MAX_CHUNKS) {
            const parts = [];
            for (let i = 0; i < n; i++) {
                const c = await sdGet(item, SD_SIG_CHUNK(i));
                if (c == null) { parts.length = 0; break; }
                parts.push(c);
            }
            if (parts.length === n) html = parts.join("");
            else console.warn("[CardByte] stash: incomplete chunk set — ignoring stashed HTML");
        }
    }

    // Custom-property backup covers hosts without sessionData.
    if (!id) id = await getActiveSigFromItem(item);

    return { id: id || null, html };
}

// =============================================================================
//  DEFAULT SIGNATURE CACHE (unchanged semantics)
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
//  RULES CACHE — mirrored to roamingSettings when small enough. This mirror is
//  correct: rules ARE mailbox-scoped, unlike the per-draft active signature id.
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
            console.warn(`[CardByte] rulesJson too large for roamingSettings (${serialized.length}B > ${ROAM_MAX_RULES_BYTES}B) — isolated runtimes will fetch live`);
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
//  API LAYER (unchanged)
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
        // "TypeError: Load failed" in the Mac event runtime = CORS/well-known
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
//  TIMEOUT WRAPPER (hoisted above its first use)
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
//  FIND MATCHING RULE (unchanged)
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
//  CORE SIGNATURE ORCHESTRATOR — cache-first fast apply, then network refresh.
//  v6: stashes whatever actually landed in the body (including the refreshed
//  copy) so send re-applies exactly that.
// =============================================================================

async function applySignatureCore(item, mailbox, opts = {}, isSendTime = false) {
    const t0 = Date.now();
    const { fetchIfMissing = false, overrideHtml = null, sigId = "default" } = opts;
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
        if (ok) {
            appliedHtml = fastHtml;
            await stashAppliedSignature(item, sigId, fastHtml);
        }
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
                        if (ok) {
                            appliedHtml = fetched;
                            await stashAppliedSignature(item, sigId, fetched);
                        }
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
//  RECIPIENT-CHANGE HANDLER — v6: stashes the applied signature on the draft.
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
            // Mobile keeps its v5 roaming write; desktop/web does not.
            setActiveSignatureId(matched.signatureId, item, { allowRoaming: isMobile() });
            await stashAppliedSignature(item, matched.signatureId, ruleHtml);
        }

    } else {
        console.warn("[CardByte] No rule matched / empty recipients — falling back to default signature");
        _activeSignatureId = null;
        setActiveSignatureId(null, item, { allowRoaming: isMobile() });
        await applySignatureCore(item, mailbox, { fetchIfMissing: true, sigId: "default" }, false);
    }
}

// =============================================================================
//  RECIPIENT POLLING (unchanged — still skipped on mobile)
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
//  SEND-TIME HELPERS
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

// Resolve an id to HTML at send time — cache first, then a bounded live fetch.
async function resolveSigHtmlAtSend(sigId, mailbox) {
    const id = String(sigId);

    if (id === "default") {
        const cached = getCachedSignature({ skipTtl: true, skipSessionCheck: true });
        if (cached) return cached;
    }

    let html = getSigById(id, { skipTtl: true });
    if (html) return html;

    const budget = isMac() ? SEND_QUICK_FETCH_MS_MAC : SEND_QUICK_FETCH_MS;
    try {
        const enc = await encryptEmail(mailbox?.userProfile?.emailAddress);
        html = await withTimeout(fetchSignatureById(id, enc, getXPlatform()), budget);
        if (html) setSigById(id, html);
    } catch (e) {
        console.warn(`[CardByte] onSend quick fetch failed for id=${id}:`, e.message);
    }
    return html || null;
}

// =============================================================================
//  SEND-TIME CORE — DESKTOP / WEB (Windows, Mac, OWA in any browser)
//
//  Always re-applies, so the tamper guard is intact. What changed is the SOURCE
//  of the HTML: it now comes from what compose actually applied to THIS draft,
//  never from a mailbox-scoped id left behind by a different draft.
//
//  Order:
//    1. Manual taskpane selection      (explicit user choice wins)
//    2. In-memory sigById by stashed id (Windows classic / healthy OWA — no I/O)
//    3. Stashed HTML                    (Mac, degraded Safari/Firefox — no network)
//    4. Refetch by stashed id           (signature too large to stash)
//    5. Recovery: rules -> default      (compose-time never completed)
// =============================================================================

async function _onSendCore(item, mailbox) {
    const t0 = Date.now();
    notifyWithTiming(item, "Re-applying signature...", t0);

    // ─── 1. Manual taskpane selection ───
    const overrideId = await getManualOverride(item);
    if (overrideId) {
        const html = await resolveOverrideHtml(overrideId, mailbox);
        if (html) {
            await applySignatureWithFallback(item, html, true);
            logTiming("_onSendCore (manual override)", t0);
            return;
        }
        console.warn("[CardByte] Override id set but html unavailable — continuing");
    }

    const { id: stashedId, html: stashedHtml } = await readStashedSignature(item);

    // ─── 2. Same-runtime cache: Windows classic, healthy OWA. Zero I/O. ───
    if (stashedId && stashedId !== "default") {
        const mem = getSigById(stashedId, { skipTtl: true });
        if (mem) {
            console.log(`[CardByte] onSend: re-applying sig id=${stashedId} from memory`);
            await applySignatureWithFallback(item, mem, true);
            logTiming("_onSendCore (memory)", t0);
            return;
        }
    }

    // ─── 3. Stashed HTML: exactly what compose applied. Zero network. ───
    if (stashedHtml) {
        console.log(`[CardByte] onSend: re-applying stashed sig id=${stashedId}`);
        await applySignatureWithFallback(item, stashedHtml, true);
        logTiming("_onSendCore (stash)", t0);
        return;
    }

    // ─── 4. Id known, HTML not stashed (oversized) → refetch THAT id. ───
    if (stashedId) {
        const resolved = await resolveSigHtmlAtSend(stashedId, mailbox);
        if (resolved) {
            console.log(`[CardByte] onSend: refetched sig id=${stashedId}`);
            await applySignatureWithFallback(item, resolved, true);
            logTiming("_onSendCore (refetched by id)", t0);
            return;
        }
        // The correct id is known but unreachable. Leaving the body untouched is
        // the only safe move — substituting a different signature here is
        // precisely the bug this version removes.
        console.error(`[CardByte] onSend: sig id=${stashedId} unresolvable — leaving body as-is`);
        removeNotification(item);
        logTiming("_onSendCore (unresolvable)", t0);
        return;
    }

    // ─── 5. RECOVERY: nothing was ever recorded for this draft. ───
    console.warn("[CardByte] onSend: no signature recorded for this draft — recovery path");

    const matched = await findMatchingRule(item, {
        cacheOnly: true,
        allowQuickFetchMs: isMac() ? SEND_QUICK_FETCH_MS_MAC : 0,
    });

    if (matched) {
        const ruleHtml = await resolveSigHtmlAtSend(matched.signatureId, mailbox);
        if (ruleHtml) {
            console.log(`[CardByte] onSend recovery: injecting rule sig id=${matched.signatureId}`);
            await applySignatureWithFallback(item, ruleHtml, true);
            await stashAppliedSignature(item, matched.signatureId, ruleHtml);
            logTiming("_onSendCore (recovery: rule)", t0);
            return;
        }
    }

    const cached = getCachedSignature({ skipTtl: true, skipSessionCheck: true });
    if (cached) {
        console.log("[CardByte] onSend recovery: injecting default sig from cache");
        await applySignatureWithFallback(item, cached, true);
        await stashAppliedSignature(item, "default", cached);
        logTiming("_onSendCore (recovery: default)", t0);
        return;
    }

    console.warn("[CardByte] onSend: nothing available — leaving body as-is");
    removeNotification(item);
    logTiming("_onSendCore (recovery: none)", t0);
}

// =============================================================================
//  SEND-TIME CORE — MOBILE (iOS / Android)
//
//  VERBATIM v5 LOGIC. Mobile runs a single webview, so the runtime isolation
//  this release fixes does not occur there, and its roaming-aware id read still
//  behaves as it always has. Nothing in v6 changes mobile behaviour: the stash
//  is disabled, roaming reads/writes are preserved, budgets are unchanged.
//  Do not "unify" this without re-testing on device.
// =============================================================================

async function _onSendCoreLegacy(item, mailbox) {
    const t0 = Date.now();
    notifyWithTiming(item, "Re-applying correct signature...", t0);

    // ─── Manual taskpane selection wins ───
    const overrideId = await getManualOverride(item);
    if (overrideId) {
        const html = await resolveOverrideHtml(overrideId, mailbox);
        if (html) {
            await applySignatureWithFallback(item, html, true);
            logTiming("_onSendCoreLegacy (manual override)", t0);
            return;
        }
        console.warn("[CardByte] Override id set but html unavailable — falling back to rules");
    }

    const matched = await findMatchingRule(item, { cacheOnly: true, allowQuickFetchMs: 0 });

    if (matched) {
        const ruleHtml = await resolveSigHtmlAtSend(matched.signatureId, mailbox);
        if (ruleHtml) {
            console.log(`[CardByte] onSend: injecting rule sig id=${matched.signatureId}`);
            await applySignatureWithFallback(item, ruleHtml, true);
            logTiming("_onSendCoreLegacy (rule)", t0);
            return;
        }
        console.warn(`[CardByte] onSend: rule sig id=${matched.signatureId} unavailable — trying last-applied signature`);
    }

    const persistedActiveId = await getActiveSignatureId(item, { allowRoaming: true });
    if (persistedActiveId) {
        console.warn("[CardByte] onSend: falling back to persisted active signature id:", persistedActiveId);
        const activeHtml = await resolveSigHtmlAtSend(persistedActiveId, mailbox);
        if (activeHtml) {
            await applySignatureWithFallback(item, activeHtml, true);
            logTiming("_onSendCoreLegacy (persisted fallback)", t0);
            return;
        }
        console.warn("[CardByte] onSend: active sig HTML unavailable — leaving body as-is");
        removeNotification(item);
        logTiming("_onSendCoreLegacy (leave as-is)", t0);
        return;
    }

    const cached = getCachedSignature({ skipTtl: true, skipSessionCheck: true });
    if (!cached) {
        console.warn("[CardByte] onSend: no cached default — leaving body as-is");
        removeNotification(item);
        logTiming("_onSendCoreLegacy (no sig)", t0);
        return;
    }

    console.log("[CardByte] onSend: injecting default sig from cache");
    await applySignatureWithFallback(item, cached, true);
    logTiming("_onSendCoreLegacy (default)", t0);
}

// =============================================================================
//  OFFICE READY
//  NOTE: on Windows classic the event runtime does NOT run Office.onReady —
//  never put logic here that handlers depend on.
// =============================================================================

Office.onReady(() => {
    console.log("✅ Office.onReady Started");
    console.log(`[CardByte] Platform: ${detectPlatform()}`);
    logCapabilities();
    purgeStaleSigById();

    // One-time cleanup of the stale mailbox-scoped active-sig id that caused
    // the wrong signature on isolated runtimes. Mobile still uses it.
    if (!isMobile() && roamGet(ROAM_ACTIVE_SIG)) {
        console.log("[CardByte] Clearing legacy roaming active-sig id");
        roamRemove(ROAM_ACTIVE_SIG);
    }
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
        _lastStashKey = null;   // fresh draft — allow the first stash to write

        // v6: the v5 `setActiveSignatureId(null, item)` call was REMOVED here.
        // It wrote a cleared custom-properties snapshot that could resolve after
        // the real write from onRecipientsChanged and erase it. There is nothing
        // to clear on a new draft anyway — item-scoped state starts empty.

        // ─── FAST: apply default from cache immediately; network refresh runs
        //     inside applySignatureCore afterwards. ───
        const coreP = applySignatureCore(item, mailbox, { fetchIfMissing: true, sigId: "default" }, false);

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
        // ─── MAC KEEP-ALIVE (Mac only, unchanged) ───
        // event.completed() tears down the Mac event runtime and kills the
        // poller. Deferring keeps it alive; the runtime hard-stops at ~5 min or
        // when the user sends/navigates away regardless. Do NOT enable this on
        // Windows: a pending compose event blocks later event activations.
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

        // Mobile keeps the v5 path and the v5 budget. Desktop/web use the
        // stash-based path; Mac gets headroom for the rare refetch branches.
        if (isMobile()) {
            await withTimeout(_onSendCoreLegacy(item, mailbox), SEND_TIMEOUT_MS_DEFAULT);
        } else {
            const budget = isMac() ? SEND_TIMEOUT_MS_MAC : SEND_TIMEOUT_MS_DEFAULT;
            await withTimeout(_onSendCore(item, mailbox), budget);
        }

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
        _lastStashKey = null;   // account changed — force the next stash to write
        setActiveSignatureId(null, item, { allowRoaming: isMobile() });

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
            await applySignatureCore(item, mailbox, { fetchIfMissing: true, sigId: "default" }, false);
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