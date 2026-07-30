"use strict";

// =============================================================================
//  CardByte Outlook Add-in — event-handler.js (v7)
//
//  ARCHITECTURE: THE SIGNATURE ID IS THE STATE. THE HTML IS A DISPOSABLE CACHE.
//
//  Every decision point produces an id (a rule's signatureId, or DEFAULT_ID).
//  The id is persisted on the item; HTML is always re-derivable from the id via
//  cache-then-network. Consequences:
//
//   • Send time is uniform: decide id -> resolve html -> ONE body write.
//     No "trust whatever is in the body", so a deleted or race-clobbered
//     signature block is corrected at send.
//   • The Mac send runtime (fresh WKWebView, empty localStorage) is no longer a
//     special case — a cache miss is just a bounded fetch.
//   • Compose does ONE body write per event instead of four (v6 ran
//     applySignatureCore's cached-apply + its post-network re-apply, twice
//     over, concurrently with the rule apply — see WRITE TOKEN below).
//
//  WRITE TOKEN. Windows/OWA share one runtime, so OnNewMessageCompose and
//  OnMessageRecipientsChanged overlap and both write the body across long
//  awaits. Each entry point takes a seq from beginWrite(); a write is dropped
//  if seq is no longer current. Last decision wins deterministically instead of
//  by network luck.
//
//  CHANGES FROM v6 THAT ALTER BEHAVIOUR — VALIDATE THESE:
//   1. Recipient POLLING and the 4-minute MAC_KEEPALIVE are gone. Deferring
//      event.completed() for 4 min can delay or drop OnMessageSend, since the
//      event runtime serialises activations. Recipient tracking now relies on
//      the OnMessageRecipientsChanged LaunchEvent. Confirm it fires on your Mac
//      build; if it does not, re-add polling there specifically.
//   2. An empty recipient list no longer resets the body to the default. OWA
//      fires mid-typing with zero recipients; v6 wrote the default on each one.
//   3. X_PLATFORM_FORCE is removed. The real platform is reported, including a
//      new "OWA" value. Verify the backend accepts MAC / OWA / MOBILE before
//      deploying, or set X_PLATFORM_MAP below to collapse them.
//   4. Default-signature HTML shares the one id-keyed cache (id = "default").
//      The legacy cardbyte_cached_signature key is still read, so a warm cache
//      written by the taskpane build is not thrown away.
//
//  DEPLOYMENT PREREQS FOR MAC (not fixable in this file):
//   a) /.well-known/microsoft-officeaddins-allowed.json must list the add-in id
//      and this file's URL, and the API must send CORS headers. Otherwise every
//      fetch from the Mac event runtime rejects with "TypeError: Load failed".
//   b) XML (add-in only) manifest with LaunchEvents: OnNewMessageCompose,
//      OnMessageRecipientsChanged, OnMessageFromChanged, OnMessageSend.
//   c) Mac debugging: defaults write com.microsoft.Outlook
//      OfficeWebAddinDeveloperExtras -bool true, then Safari > Develop.
// =============================================================================

const CB_VERSION = "v7.0.0";

// ─────────────────────────────────────────────────────────────────────────────
//  CONFIG
// ─────────────────────────────────────────────────────────────────────────────

const AES_KEY = "fnItrY2YfozBqCC2B4XsfqHIvZku3kUOq3DFkbO64kk=";
const AES_IV = "3YapeNfJDung7TXxeKXn4g==";
const BASE_URL = "https://ns-enterprise.cardbyte.ai/email-signature";

// The id standing for "the user's default (non-rule) signature".
// Replace with a real backend id when /html/outlook/get-active returns one;
// that removes the only remaining special case in resolveSigHtml().
const DEFAULT_ID = "default";

// localStorage / sessionStorage keys
const K_SESSION = "cardbyte_session_id";
const K_SIG_CACHE = "cardbyte_sig_cache";              // { [id]: { html, ts } }
const K_SIG_CACHE_LEGACY_DEFAULT = "cardbyte_cached_signature";
const K_RULES = "cardbyte_cached_rules";
const K_RULES_TS = "cardbyte_cached_rules_ts";
const K_ACTIVE_SIG = "cardbyte_active_sig_id";
const K_ACTIVE_SIG_TS = "cardbyte_active_sig_ts";

// Item custom properties — the cross-runtime channel (survives Mac's fresh
// WKWebView per event, unlike localStorage).
const P_ACTIVE_SIG = "cardbyte_active_sig_id";
const P_MANUAL_SIG = "cardbyte_manual_sig_id";
const P_COMPOSE_TYPE = "cardbyte_compose_type";
const P_RECIP_SNAPSHOT = "cardbyte_recip_snapshot";

// roamingSettings — mailbox-scoped, ~32KB total. Small values only; never HTML.
const R_ACTIVE_SIG = "cb_active_sig";
const R_RULES = "cb_rules";
const R_RULES_MAX_BYTES = 20 * 1024;

const SIG_TTL_MS = 5 * 60 * 1000;
const SIG_PURGE_MS = 24 * 60 * 60 * 1000;
const RULES_TTL_MS = 5 * 60 * 1000;
const ACTIVE_SIG_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// One size ceiling, actually enforced. v6 declared 500KB/200KB constants and
// then hardcoded 100KB in the apply path; observed rule signatures are ~42KB.
const MAX_SIG_BYTES = 200 * 1024;

// Send budgets. Mac starts cold, so it gets headroom plus per-leg fetch bounds.
const SEND_BUDGET_MS_MAC = 12_000;
const SEND_BUDGET_MS = 5_000;
const FETCH_BUDGET_MS = 2_500;
const COMPOSE_TYPE_TIMEOUT_MS = 1_500;

// Let OWA's recipient events settle before reading; avoids a burst of
// evaluations while an address is still being typed.
const RECIPIENT_SETTLE_MS = 350;

// Set a value to collapse a platform onto another header value if the backend
// rejects it, e.g. { OWA: "WINDOWS" }. Empty = report the truth.
const X_PLATFORM_MAP = {};

// PRODUCT DECISION, all platforms.
//   false: recipientType "internal" matches if ANY recipient is internal, so a
//          mixed To matches both the internal and external rules and priority
//          decides.
//   true : "internal" matches only when EVERY recipient is internal.
const INTERNAL_REQUIRES_NO_EXTERNAL = false;

const NOTIF_KEY = "cardbyte_sig_status";

// How chatty the in-mail notification bar is.
//   "errors"  — failures only (quietest; recommended for production)
//   "status"  — start / applied / failures
//   "verbose" — status plus per-phase timings (QA builds)
const NOTIFY_LEVEL = "verbose";
const NOTIFY_CLEAR_MS = 3000;

// ─────────────────────────────────────────────────────────────────────────────
//  LOGGING
// ─────────────────────────────────────────────────────────────────────────────

const log = (...a) => console.log("[CardByte]", ...a);
const warn = (...a) => console.warn("[CardByte]", ...a);
const err = (...a) => console.error("[CardByte]", ...a);
const since = (t0) => `${Date.now() - t0}ms`;
const timed = (label, t0) => log(`⏱ ${label}: ${since(t0)}`);

// ─────────────────────────────────────────────────────────────────────────────
//  PLATFORM
//  v6 read Office.context.platform, which does not exist — it resolved to ""
//  and every classification fell through to a user-agent guess (and, with
//  X_PLATFORM_FORCE set, to the literal "WINDOWS"). The real property is
//  Office.context.diagnostics.platform (Mailbox 1.5+); UA stays as fallback.
// ─────────────────────────────────────────────────────────────────────────────

let _platform = null;

function detectPlatform() {
    if (_platform) return _platform;

    const PT = typeof Office !== "undefined" ? Office.PlatformType : null;
    const d = (() => {
        try { return Office?.context?.diagnostics?.platform || null; } catch (_) { return null; }
    })();
    const ua = (() => {
        try { return (navigator?.userAgent || "").toLowerCase(); } catch (_) { return ""; }
    })();

    const uaMobile = () => {
        if (ua.includes("android")) return "mobile-android";
        if (ua.includes("iphone") || ua.includes("ipad")) return "mobile-ios";
        return null;
    };

    if (d && PT) {
        if (d === PT.iOS) return (_platform = "mobile-ios");
        if (d === PT.Android) return (_platform = "mobile-android");
        if (d === PT.Mac) return (_platform = "mac");
        if (d === PT.PC) return (_platform = "windows");
        if (d === PT.OfficeOnline) return (_platform = uaMobile() || "owa");
        if (d === PT.Universal) return (_platform = uaMobile() || "owa");
    }

    // diagnostics unavailable (requirement set < 1.5, or a stripped runtime).
    if (ua.includes("outlook-android")) return (_platform = "mobile-android");
    if (ua.includes("outlook-ios") || ua.includes("outlookmobile")) return (_platform = uaMobile() || "mobile-ios");
    const m = uaMobile();
    if (m) return (_platform = m);
    if (ua.includes("macintosh") || ua.includes("mac os x")) return (_platform = "mac");

    return (_platform = "owa");
}

const isMac = () => detectPlatform() === "mac";
const isMobile = () => detectPlatform().startsWith("mobile-");

function getXPlatform() {
    const p = detectPlatform();
    const base =
        p === "mac" ? "MAC" :
            // Outlook for iOS reports MAC: the backend has no iOS bucket, and
            // iOS shares the Apple/WebKit rendering path, so MAC is the closest
            // accepted value. Must precede the isMobile() branch, which would
            // otherwise claim it. Android still reports MOBILE.
            p === "mobile-ios" ? "MAC" :
                p === "owa" ? "WINDOWS" :
                    isMobile() ? "MOBILE" :
                        "WINDOWS";
    return X_PLATFORM_MAP[base] || base;
}

// ─────────────────────────────────────────────────────────────────────────────
//  ASYNC UTILITIES
// ─────────────────────────────────────────────────────────────────────────────

// Note: this bounds how long we WAIT, it cannot cancel the underlying work.
function withTimeout(promise, ms, label = "operation") {
    let timer;
    return Promise.race([
        Promise.resolve(promise).finally(() => clearTimeout(timer)),
        new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
        }),
    ]);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Wrap a callback-style Office API in a promise with a hard ceiling, resolving
// to `fallback` on failure or timeout so no caller can hang.
function officeAsync(fn, { ms = COMPOSE_TYPE_TIMEOUT_MS, fallback = null, label = "office call" } = {}) {
    return new Promise((resolve) => {
        let done = false;
        const finish = (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
        const timer = setTimeout(() => { warn(`${label} timed out after ${ms}ms`); finish(fallback); }, ms);
        try {
            fn((res) => {
                if (res?.status !== Office.AsyncResultStatus.Succeeded) {
                    warn(`${label} failed:`, res?.error?.message);
                    return finish(fallback);
                }
                finish(res);
            });
        } catch (e) {
            warn(`${label} threw:`, e);
            finish(fallback);
        }
    });
}

// ─────────────────────────────────────────────────────────────────────────────
//  WRITE TOKEN
//  Guards every body/state write against a newer decision made during an await.
// ─────────────────────────────────────────────────────────────────────────────

let _writeSeq = 0;
const beginWrite = () => ++_writeSeq;
const isCurrent = (seq) => seq === _writeSeq;

// ─────────────────────────────────────────────────────────────────────────────
//  NOTIFICATIONS
// ─────────────────────────────────────────────────────────────────────────────

// `icon` is documented as required for type "informationalMessage" and is meant
// to be an image resource id from the manifest's <Resources><bt:Images>. OWA
// tolerates an unknown id and renders the message without an icon; Windows
// desktop is stricter. "none" is what shipped and works — to be robust across
// hosts, declare an image resource and put its id here.
const NOTIF_ICON = "none";

// Guards the auto-clear timer: it only clears the message it was scheduled for,
// so a later error can never be wiped by an earlier success's timeout.
let _notifSeq = 0;

function showNotification(item, message, type = "informationalMessage", startMs = null) {
    try {
        const nm = item?.notificationMessages;
        if (typeof nm?.replaceAsync !== "function") {
            warn("notificationMessages unavailable on this item — skipping:", message);
            return;
        }

        let msg = startMs ? `${message} (${since(startMs)})` : message;
        if (msg.length > 150) msg = `${msg.slice(0, 147)}...`; // host hard limit

        const details = { type, message: msg };
        if (type === "informationalMessage") {
            details.icon = NOTIF_ICON;
            details.persistent = false;
        }

        _notifSeq++;
        nm.replaceAsync(NOTIF_KEY, details, (r) => {
            if (r?.status === Office.AsyncResultStatus.Succeeded) return;
            // replaceAsync fails when the key is not present yet — add instead.
            try {
                nm.addAsync(NOTIF_KEY, details, (r2) => {
                    if (r2?.status !== Office.AsyncResultStatus.Succeeded) {
                        warn("notification failed:", r2?.error?.code, r2?.error?.message, details);
                    }
                });
            } catch (e) {
                warn("notification addAsync threw:", e);
            }
        });
    } catch (e) {
        warn("showNotification threw, ignoring:", e);
    }
}

function removeNotification(item) {
    try { item?.notificationMessages?.removeAsync?.(NOTIF_KEY, () => { }); } catch (_) { }
}

// Clear after a delay, but only if nothing newer has been shown since.
function clearNotificationSoon(item, ms = NOTIFY_CLEAR_MS) {
    const mine = _notifSeq;
    setTimeout(() => {
        if (mine === _notifSeq) removeNotification(item);
    }, ms);
}

// Progress/status messages, suppressed unless NOTIFY_LEVEL allows them.
// Timings are attached only at "verbose" — they are QA instrumentation, not
// something an end user should read.
function notifyStatus(item, message, startMs = null) {
    if (NOTIFY_LEVEL === "errors") return;
    showNotification(item, message, "informationalMessage", NOTIFY_LEVEL === "verbose" ? startMs : null);
}

const notifyError = (item, msg) => showNotification(item, msg, "errorMessage");

// ─────────────────────────────────────────────────────────────────────────────
//  CRYPTO — AES-CBC via Web Crypto
// ─────────────────────────────────────────────────────────────────────────────

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

async function importAesKey(usage) {
    const keyBuffer = base64ToArrayBuffer(AES_KEY);
    if (keyBuffer.byteLength !== 16 && keyBuffer.byteLength !== 32) {
        throw new Error(`AES key must be 16 or 32 bytes, got ${keyBuffer.byteLength}`);
    }
    return crypto.subtle.importKey("raw", keyBuffer, { name: "AES-CBC" }, false, [usage]);
}

async function aesDecrypt(encryptedText) {
    if (!encryptedText) return "";
    try {
        const key = await importAesKey("decrypt");
        const iv = base64ToArrayBuffer(AES_IV);
        if (iv.byteLength !== 16) throw new Error("AES IV must be 16 bytes");
        const plain = await crypto.subtle.decrypt(
            { name: "AES-CBC", iv },
            key,
            base64ToArrayBuffer(encryptedText)
        );
        return new TextDecoder().decode(plain);
    } catch (e) {
        warn("aesDecrypt failed, returning input unchanged:", e.message);
        return encryptedText;
    }
}

async function encryptEmail(email = "") {
    if (!email.trim()) return "";
    try {
        const key = await importAesKey("encrypt");
        const iv = base64ToArrayBuffer(AES_IV);
        const enc = await crypto.subtle.encrypt(
            { name: "AES-CBC", iv },
            key,
            new TextEncoder().encode(email)
        );
        return arrayBufferToBase64(enc);
    } catch (e) {
        err("encryptEmail failed:", e);
        return "";
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//  STORAGE
//  L1 memory (this runtime) / L2 localStorage (empty in Mac event runtime) /
//  L3 roamingSettings (mailbox-scoped, reaches every runtime, tiny budget).
// ─────────────────────────────────────────────────────────────────────────────

const _mem = new Map();

const store = {
    get(key) {
        if (_mem.has(key)) return _mem.get(key);
        try {
            const v = localStorage.getItem(key);
            if (v != null) { _mem.set(key, v); return v; }
        } catch (_) { }
        return null;
    },
    set(key, val) {
        _mem.set(key, val);
        try { localStorage.setItem(key, val); } catch (_) { }
    },
    remove(...keys) {
        keys.forEach((k) => _mem.delete(k));
        try { keys.forEach((k) => localStorage.removeItem(k)); } catch (_) { }
    },
    getJson(key) {
        try { const v = store.get(key); return v ? JSON.parse(v) : null; } catch (_) { return null; }
    },
    setJson(key, val) {
        try { store.set(key, JSON.stringify(val)); } catch (_) { }
    },
};

const roam = {
    get(key) {
        try { return Office?.context?.roamingSettings?.get(key) ?? null; } catch (_) { return null; }
    },
    set(key, val) {
        try {
            const rs = Office?.context?.roamingSettings;
            if (!rs) return;
            rs.set(key, val);
            rs.saveAsync(() => { });
        } catch (_) { }
    },
    remove(key) {
        try {
            const rs = Office?.context?.roamingSettings;
            if (!rs) return;
            rs.remove(key);
            rs.saveAsync(() => { });
        } catch (_) { }
    },
};

function getSessionId() {
    try {
        let sid = sessionStorage.getItem(K_SESSION);
        if (!sid) {
            sid = crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36);
            sessionStorage.setItem(K_SESSION, sid);
        }
        return sid;
    } catch (_) {
        return "no-session";
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//  SIGNATURE HTML CACHE — one id-keyed map, DEFAULT_ID included.
//  HTML is disposable: a miss costs a fetch, never correctness.
// ─────────────────────────────────────────────────────────────────────────────

const sigCache = {
    read() { return store.getJson(K_SIG_CACHE) || {}; },
    write(map) { store.setJson(K_SIG_CACHE, map); },

    get(id, { skipTtl = false } = {}) {
        const key = String(id);
        const entry = sigCache.read()[key];
        if (entry?.html) {
            if (skipTtl || Date.now() - entry.ts <= SIG_TTL_MS) return entry.html;
            log(`sig cache stale for id=${key}`);
        }
        // Migration: a warm default written by the taskpane build.
        if (key === DEFAULT_ID) {
            const legacy = store.get(K_SIG_CACHE_LEGACY_DEFAULT);
            if (legacy) { log("sig cache: using legacy default key"); return legacy; }
        }
        return null;
    },

    set(id, html) {
        if (!html) return;
        const map = sigCache.read();
        map[String(id)] = { html, ts: Date.now() };
        sigCache.write(map);
    },

    purge() {
        const map = sigCache.read();
        const now = Date.now();
        let n = 0;
        for (const id of Object.keys(map)) {
            if (now - (map[id]?.ts || 0) > SIG_PURGE_MS) { delete map[id]; n++; }
        }
        if (n) { sigCache.write(map); log(`purged ${n} stale signature cache entr${n === 1 ? "y" : "ies"}`); }
    },
};

// ─────────────────────────────────────────────────────────────────────────────
//  RULES CACHE — mirrored to roaming when small enough, so the Mac send
//  runtime can evaluate without a network round trip.
// ─────────────────────────────────────────────────────────────────────────────

function getCachedRules({ skipTtl = false } = {}) {
    if (!skipTtl) {
        const ts = parseInt(store.get(K_RULES_TS) || "0", 10);
        if (!ts || Date.now() - ts > RULES_TTL_MS) {
            const roamed = readRoamedRules();
            if (roamed) return roamed;
            log("rules cache stale");
            return null;
        }
    }
    return store.getJson(K_RULES) || readRoamedRules();
}

function readRoamedRules() {
    try {
        const raw = roam.get(R_RULES);
        return raw ? JSON.parse(raw) : null;
    } catch (_) { return null; }
}

function setCachedRules(rulesJson) {
    store.setJson(K_RULES, rulesJson);
    store.set(K_RULES_TS, Date.now().toString());
    try {
        const s = JSON.stringify(rulesJson);
        if (s.length <= R_RULES_MAX_BYTES) roam.set(R_RULES, s);
        else warn(`rulesJson too large to roam (${s.length}B) — Mac event runtime will fetch live`);
    } catch (_) { }
}

// ─────────────────────────────────────────────────────────────────────────────
//  ITEM CUSTOM PROPERTIES
//  ONE shared handle per item, and saveAsync is AWAITED. v6 fired and forgot,
//  so a Send moments after compose could read a property that never landed —
//  and concurrent writers silently clobbered each other's keys.
// ─────────────────────────────────────────────────────────────────────────────

const _propsByItem = new WeakMap();

function getProps(item) {
    if (_propsByItem.has(item)) return _propsByItem.get(item);
    const p = officeAsync((cb) => item.loadCustomPropertiesAsync(cb), {
        ms: FETCH_BUDGET_MS,
        label: "loadCustomPropertiesAsync",
    }).then((res) => res?.value ?? null);
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
    if (!props) return false;
    try {
        for (const [k, v] of Object.entries(kv)) {
            if (v == null) props.remove(k);
            else props.set(k, String(v));
        }
        const res = await officeAsync((cb) => props.saveAsync(cb), {
            ms: FETCH_BUDGET_MS,
            label: "customProps saveAsync",
        });
        return !!res;
    } catch (e) {
        warn("setItemProps threw:", e);
        return false;
    }
}

const getManualOverride = (item) => getItemProp(item, P_MANUAL_SIG);

// ─────────────────────────────────────────────────────────────────────────────
//  ACTIVE SIGNATURE ID (+ recipient snapshot)
//  This is the authoritative state. Item props are the primary channel;
//  localStorage and roaming are fallbacks.
// ─────────────────────────────────────────────────────────────────────────────

async function markActiveSignature(item, id, snapshot = null) {
    if (id == null) {
        store.remove(K_ACTIVE_SIG, K_ACTIVE_SIG_TS);
        roam.remove(R_ACTIVE_SIG);
    } else {
        store.set(K_ACTIVE_SIG, String(id));
        store.set(K_ACTIVE_SIG_TS, Date.now().toString());
        roam.set(R_ACTIVE_SIG, String(id));
    }
    if (!item) return;
    await setItemProps(item, {
        [P_ACTIVE_SIG]: id == null ? null : String(id),
        [P_RECIP_SNAPSHOT]: id == null ? null : snapshot,
    });
}

async function getActiveSignatureId(item = null) {
    if (item) {
        const fromItem = await getItemProp(item, P_ACTIVE_SIG);
        if (fromItem) return fromItem;
    }
    const id = store.get(K_ACTIVE_SIG);
    if (id) {
        const ts = parseInt(store.get(K_ACTIVE_SIG_TS) || "0", 10);
        if (!ts || Date.now() - ts <= ACTIVE_SIG_MAX_AGE_MS) return id;
    }
    const roamed = roam.get(R_ACTIVE_SIG);
    return roamed ? String(roamed) : null;
}

// ─────────────────────────────────────────────────────────────────────────────
//  API
// ─────────────────────────────────────────────────────────────────────────────

function apiHeaders(encryptedMail, extra = {}) {
    return { username: encryptedMail, "X-Platform": getXPlatform(), ...extra };
}

async function fetchRules(encryptedMail) {
    try {
        const res = await fetch(`${BASE_URL}/rules-config/get-active`, {
            method: "GET",
            headers: apiHeaders(encryptedMail, { "Content-Type": "application/json" }),
        });
        if (!res.ok) { warn("rules fetch returned", res.status); return null; }
        const rulesJson = JSON.parse(await res.text())?.rulesJson;
        if (!rulesJson) { warn("rules response had no rulesJson"); return null; }
        setCachedRules(rulesJson);
        log("rulesJson fetched and cached");
        return rulesJson;
    } catch (e) {
        // "TypeError: Load failed" in the Mac event runtime means the
        // well-known allowlist / CORS setup is wrong. See header prereq (a).
        err("fetchRules failed:", e);
        return null;
    }
}

// Default signature. Returns { html, explicit } — explicit means the server
// gave a definitive answer, so an empty result is "unassigned", not "unknown".
async function fetchDefaultSignature(encryptedMail) {
    try {
        const res = await fetch(`${BASE_URL}/html/outlook/get-active`, {
            method: "GET",
            headers: apiHeaders(encryptedMail),
        });
        if (!res.ok) {
            let msg = "";
            try { const b = JSON.parse(await res.text()); msg = String(b?.message || b?.error || ""); } catch (_) { }
            warn("default signature fetch failed:", res.status, msg);
            const notFound = res.status === 404 || /not\s*found/i.test(msg);
            return { html: null, explicit: notFound };
        }
        const html = JSON.parse(await aesDecrypt(await res.text()))?.html + `<table><tr><td>${getXPlatform()}</td></tr></table>` || null;
        return { html, explicit: true };
    } catch (e) {
        warn("fetchDefaultSignature crashed:", e);
        return { html: null, explicit: false };
    }
}

// Same { html, explicit } shape as fetchDefaultSignature so resolveSigHtml can
// treat both uniformly.
async function fetchSignatureById(id, encryptedMail) {
    try {
        const res = await fetch(`${BASE_URL}/rules-config/get/${id}`, {
            method: "GET",
            headers: apiHeaders(encryptedMail),
        });
        if (!res.ok) {
            err(`signature fetch failed id=${id}:`, res.status);
            return { html: null, explicit: res.status === 404 };
        }
        const html = JSON.parse(await aesDecrypt(await res.text()))?.html || null;
        if (!html) warn("signature HTML empty for id:", id);
        return { html, explicit: true };
    } catch (e) {
        err(`fetchSignatureById crashed id=${id}:`, e);
        return { html: null, explicit: false };
    }
}

/**
 * THE CORE OF THE ID-AS-STATE DESIGN: id -> HTML, cache then network.
 *
 * `unassigned` distinguishes "the server answered definitively and there is no
 * signature for this user" (an admin problem) from "we could not reach or parse
 * the server" (a transient problem). The two need different messages — without
 * the distinction a misconfiguration is indistinguishable from flaky network.
 *
 * @returns {Promise<{ html: string|null, source: "cache"|"network"|"none", unassigned: boolean }>}
 */
async function resolveSigHtml(id, userEmail, { allowNetwork = true, budgetMs = FETCH_BUDGET_MS } = {}) {
    const key = String(id);

    const cached = sigCache.get(key, { skipTtl: true });
    if (cached) return { html: cached, source: "cache", unassigned: false };

    if (!allowNetwork || !userEmail) return { html: null, source: "none", unassigned: false };

    try {
        const enc = await encryptEmail(userEmail);
        const { html, explicit } = key === DEFAULT_ID
            ? await withTimeout(fetchDefaultSignature(enc), budgetMs, "default fetch")
            : await withTimeout(fetchSignatureById(key, enc), budgetMs, `sig fetch ${key}`);
        if (html) {
            sigCache.set(key, html);
            return { html, source: "network", unassigned: false };
        }
        // Definitive empty answer = nothing is assigned server-side.
        return { html: null, source: "none", unassigned: !!explicit };
    } catch (e) {
        warn(`resolveSigHtml failed id=${key}:`, e.message);
        return { html: null, source: "none", unassigned: false };
    }
}

// Revalidate in the background and refresh the cache. Returns fresh HTML only
// when it actually differs from what we already applied.
async function revalidateSigHtml(id, userEmail, appliedHtml) {
    const key = String(id);
    try {
        const enc = await encryptEmail(userEmail);
        const { html } = key === DEFAULT_ID
            ? await fetchDefaultSignature(enc)
            : await fetchSignatureById(key, enc);
        if (!html) return null;
        sigCache.set(key, html);
        return html === appliedHtml ? null : html;
    } catch (e) {
        warn(`revalidate failed id=${key}:`, e.message);
        return null;
    }
}

async function prefetchRuleSignatures(userEmail) {
    const rulesJson = getCachedRules({ skipTtl: true });
    const ids = [...new Set(
        (rulesJson?.rulesList || [])
            .filter((r) => r.enabled && r.signatureId != null)
            .map((r) => String(r.signatureId))
    )].filter((id) => !sigCache.get(id, { skipTtl: true }));

    if (!ids.length) return;
    log(`prefetching ${ids.length} signature(s)`);
    await Promise.allSettled(ids.map((id) => resolveSigHtml(id, userEmail)));
}

// ─────────────────────────────────────────────────────────────────────────────
//  RECIPIENTS
// ─────────────────────────────────────────────────────────────────────────────

async function getRecipients(field) {
    const res = await officeAsync((cb) => field.getAsync(cb), {
        ms: FETCH_BUDGET_MS,
        label: "recipients getAsync",
    });
    return res?.value || [];
}

async function getAllRecipientEmails(item) {
    if (!item?.to?.getAsync) return [];
    const [to, cc] = await Promise.all([
        getRecipients(item.to),
        item.cc?.getAsync ? getRecipients(item.cc) : Promise.resolve([]),
    ]);
    return [...new Set(
        [...to, ...cc].map((r) => (r.emailAddress || "").toLowerCase().trim()).filter(Boolean)
    )];
}

const serializeRecipients = (emails) => [...emails].sort().join(",");

// ─────────────────────────────────────────────────────────────────────────────
//  COMPOSE TYPE
//  Resolution order: this runtime's cache -> the item property written at
//  compose -> live detection. Step 2 is what lets Mac's fresh send runtime
//  inherit the compose runtime's answer instead of re-deriving it from an API
//  that misreports there. Unknown is null, never a silent "compose".
// ─────────────────────────────────────────────────────────────────────────────

const _composeTypeByItem = new WeakMap();

// Multi-letter reply/forward prefixes. Bare "R:"/"I:" are deliberately absent:
// a false positive would misclassify a new mail as a reply.
const REPLY_PREFIX_RE = /^\s*(re|aw|sv|vs|antw|res|ref|fw|fwd|wg|tr|vb|rv|enc|odp|доб|回复|转发)\s*(\[\d+\])?\s*:/i;

async function detectComposeType(item, strict) {
    const res = await officeAsync((cb) => item.getComposeTypeAsync(cb), {
        label: "getComposeTypeAsync",
    });
    const raw = String(res?.value?.composeType || "").toLowerCase();
    log("getComposeTypeAsync raw =", JSON.stringify(raw));

    if (raw === "reply" || raw === "replyall" || raw === "forward") return "reply";
    if (raw === "newmail") return "compose";

    const subjRes = await officeAsync((cb) => item.subject.getAsync(cb), { label: "subject getAsync" });
    const subject = String(subjRes?.value || "");

    // The heuristic may only ever promote to "reply".
    if (REPLY_PREFIX_RE.test(subject)) {
        log("composeType inferred 'reply' from subject prefix");
        return "reply";
    }
    // A subject with no reply prefix is weak evidence of a new mail — not good
    // enough at send time, where guessing wrong overwrites a correct signature.
    if (!strict && subject.trim() !== "") return "compose";

    return null;
}

async function getComposeType(item, { strict = false, persist = false } = {}) {
    if (_composeTypeByItem.has(item)) return _composeTypeByItem.get(item);

    const fromProp = await getItemProp(item, P_COMPOSE_TYPE);
    if (fromProp === "compose" || fromProp === "reply") {
        log("composeType from item props:", fromProp);
        _composeTypeByItem.set(item, fromProp);
        return fromProp;
    }

    let t = await detectComposeType(item, strict);
    if (!t && !strict) {
        warn("composeType undetermined — assuming 'compose' (non-strict caller)");
        t = "compose";
    }
    if (t) {
        _composeTypeByItem.set(item, t);
        if (persist) await setItemProps(item, { [P_COMPOSE_TYPE]: t });
    }
    return t;
}

// ─────────────────────────────────────────────────────────────────────────────
//  RULE MATCHING
// ─────────────────────────────────────────────────────────────────────────────

function getDomain(email) {
    const at = (email || "").lastIndexOf("@");
    return at === -1 ? "" : email.slice(at + 1).toLowerCase();
}

function recipientTypeMatches(recipientType, hasInternal, hasExternal) {
    const rt = (recipientType || "").toLowerCase().trim();
    if (!rt || rt === "all") return true;
    if (rt === "internal") return INTERNAL_REQUIRES_NO_EXTERNAL ? hasInternal && !hasExternal : hasInternal;
    if (rt === "external") return hasExternal;
    return true;
}

function contextMatches(ruleContext, composeType) {
    const rc = (ruleContext || "").toLowerCase().trim();
    if (!rc || rc === "all") return true;
    if (!composeType) return false; // conservative: never match on an unknown
    return rc === composeType.toLowerCase();
}

function senderMatches(rule, senderEmail) {
    if (!rule.Senders?.length) return true;
    const sender = (senderEmail || "").toLowerCase().trim();
    return rule.Senders.some((raw) => {
        const s = (raw || "").toLowerCase().trim();
        if (s === "*" || s === "all") return true;
        if (s.startsWith("*@")) return sender.endsWith(s.slice(1));
        return s === sender;
    });
}

/**
 * @returns {Promise<{ rule: object|null, blocked: boolean }>}
 *   blocked = we could not evaluate safely (unknown compose type in strict
 *   mode, or no rules available), so the caller must NOT treat a null rule as
 *   "the default applies".
 */
async function findMatchingRule(item, senderEmail, {
    allowNetwork = false,
    budgetMs = FETCH_BUDGET_MS,
    strictComposeType = false,
    persistComposeType = false,
} = {}) {
    let rulesJson = getCachedRules({ skipTtl: strictComposeType });

    if (!rulesJson && allowNetwork && senderEmail) {
        warn("rules not cached — live fetch");
        const enc = await encryptEmail(senderEmail);
        rulesJson = await withTimeout(fetchRules(enc), budgetMs, "rules fetch").catch(() => null);
    }
    if (!rulesJson) { warn("no rules available"); return { rule: null, blocked: true }; }

    const composeType = await getComposeType(item, {
        strict: strictComposeType,
        persist: persistComposeType,
    });
    if (strictComposeType && !composeType) {
        warn("composeType unknown at send — refusing to match context-specific rules");
        return { rule: null, blocked: true };
    }

    let emails = await getAllRecipientEmails(item);
    if (!emails.length && isMac()) {
        // Mac occasionally reports an empty list on first read.
        await sleep(400);
        emails = await getAllRecipientEmails(item);
    }
    if (!emails.length) {
        log("no recipients — cannot evaluate rules");
        return { rule: null, blocked: true };
    }

    const senderDomain = getDomain(senderEmail);
    let hasInternal = false;
    let hasExternal = false;
    const domains = [];
    for (const e of emails) {
        const d = getDomain(e);
        if (d && !domains.includes(d)) domains.push(d);
        if (senderDomain && d === senderDomain) hasInternal = true;
        else hasExternal = true;
    }

    const rules = (rulesJson.rulesList || [])
        .filter((r) => r.enabled)
        .sort((a, b) => a.priority - b.priority);

    log("rule evaluation:", {
        version: CB_VERSION,
        platform: detectPlatform(),
        strict: strictComposeType,
        composeType,
        senderDomain,
        hasInternal,
        hasExternal,
        domains,
        rules: rules.length,
    });

    for (const r of rules) {
        const s = senderMatches(r, senderEmail);
        const c = contextMatches(r.context, composeType);
        const p = recipientTypeMatches(r.recipientType, hasInternal, hasExternal);
        log(
            s && c && p ? ">>> MATCH" : "    skip ",
            `| priority=${r.priority} | sender=${s} | context=${r.context}(${c})`,
            `| recipientType=${r.recipientType}(${p}) | sigId=${r.signatureId ?? "NULL"}`
        );
        if (s && c && p) return { rule: r, blocked: false };
    }

    log("no rule matched — default applies");
    return { rule: null, blocked: false };
}

// ─────────────────────────────────────────────────────────────────────────────
//  BODY WRITES
//  setSignatureAsync REPLACES the signature block, so reapplying the same id is
//  idempotent. appendOnSendAsync is a send-time-only fallback for hosts without
//  setSignatureAsync (Mailbox < 1.10) — it appends, hence the failure guard.
// ─────────────────────────────────────────────────────────────────────────────

async function writeSignature(item, html, { isSendTime = false } = {}) {
    const bytes = new Blob([html]).size;
    if (bytes > MAX_SIG_BYTES) {
        warn(`signature ${bytes}B exceeds ${MAX_SIG_BYTES}B — not applying`);
        notifyError(item, "Signature exceeds the allowed size. Please contact Admin.");
        return false;
    }

    if (typeof item.body?.setSignatureAsync === "function") {
        const res = await officeAsync(
            (cb) => item.body.setSignatureAsync(html, { coercionType: Office.CoercionType.Html }, cb),
            { ms: FETCH_BUDGET_MS, label: "setSignatureAsync" }
        );
        if (res) { log(`signature written (${bytes}B)`); return true; }
    } else {
        warn("setSignatureAsync unavailable on this host");
    }

    if (isSendTime && typeof item.body?.appendOnSendAsync === "function") {
        const res = await officeAsync(
            (cb) => item.body.appendOnSendAsync(html, { coercionType: Office.CoercionType.Html }, cb),
            { ms: FETCH_BUDGET_MS, label: "appendOnSendAsync" }
        );
        if (res) { log("signature appended via appendOnSendAsync"); return true; }
    }

    notifyError(item, "Signature could not be applied. Please contact Admin.");
    return false;
}

/**
 * Apply the signature for `id`, guarded by the write token.
 * Fast path applies a cached copy immediately; revalidation rewrites only if
 * the server copy differs AND no newer decision has been made meanwhile.
 */
async function applyById(item, id, userEmail, seq, { revalidate = false, isSendTime = false } = {}) {
    const key = String(id);
    const t0 = Date.now();

    // Only announce a wait if there is one: a cache hit writes in ~300ms.
    if (!isSendTime && !sigCache.get(key, { skipTtl: true })) {
        notifyStatus(item, "Loading your signature...", t0);
    }

    const { html, source, unassigned } = await resolveSigHtml(key, userEmail, {
        budgetMs: isSendTime ? FETCH_BUDGET_MS : 10_000,
    });

    if (!html) {
        // Never blank the body or substitute a guess: whatever is there already
        // is better than nothing.
        warn(`could not resolve id=${key} (unassigned=${unassigned}) — leaving body as-is`);
        if (!isSendTime) {
            notifyError(item, unassigned
                ? "No signature is assigned to your account. Please contact Admin."
                : "Couldn't load your signature. Check your connection, or contact Admin.");
        }
        return false;
    }
    if (!isCurrent(seq)) { log(`stale write dropped (seq=${seq}, current=${_writeSeq})`); return false; }

    const ok = await writeSignature(item, html, { isSendTime });
    if (!ok) return false;
    log(`applied id=${key} from ${source}`);

    if (!isSendTime) {
        notifyStatus(item, "Signature applied", t0);
        clearNotificationSoon(item);
    } else {
        removeNotification(item);
    }

    if (revalidate && source === "cache" && userEmail && !isSendTime) {
        // Background only — never blocks the user, never races the token.
        revalidateSigHtml(key, userEmail, html).then(async (fresh) => {
            if (!fresh || !isCurrent(seq)) return;
            log(`id=${key} changed on server — rewriting`);
            await writeSignature(item, fresh);
        }).catch(() => { });
    }
    return true;
}

// ─────────────────────────────────────────────────────────────────────────────
//  THE SINGLE DECISION PATH
//  Everything at compose time funnels through here: pick an id, apply it once,
//  persist it. Replaces v6's applySignatureCore + onRecipientsChanged pair,
//  which each wrote the body independently.
// ─────────────────────────────────────────────────────────────────────────────

async function evaluateAndApply(item, mailbox, seq, { allowNetwork = true } = {}) {
    const t0 = Date.now();
    const userEmail = mailbox?.userProfile?.emailAddress;

    const override = await getManualOverride(item);
    if (override) {
        log("manual override active — leaving signature untouched:", override);
        return;
    }

    const { rule, blocked } = await findMatchingRule(item, userEmail, {
        allowNetwork,
        persistComposeType: true,
    });

    if (blocked) {
        // Could not evaluate (no recipients yet, no rules). Do NOT reset the
        // body to the default — that was v6's mid-typing signature flicker.
        const active = await getItemProp(item, P_ACTIVE_SIG);
        if (active) { log("evaluation blocked — keeping active id:", active); return; }
        log("evaluation blocked and nothing applied yet — applying default");
    }

    const targetId = rule ? String(rule.signatureId) : DEFAULT_ID;
    if (!isCurrent(seq)) { log("stale evaluation dropped"); return; }

    const applied = await applyById(item, targetId, userEmail, seq, { revalidate: true });
    if (applied && isCurrent(seq)) {
        const snapshot = serializeRecipients(await getAllRecipientEmails(item));
        await markActiveSignature(item, targetId, snapshot);
    }
    timed(`evaluateAndApply (${targetId})`, t0);
}

// ─────────────────────────────────────────────────────────────────────────────
//  SEND
//  Phase 1 decides an id with no body writes. Phase 2 resolves and writes once.
// ─────────────────────────────────────────────────────────────────────────────

async function decideSendId(item, userEmail) {
    const currentSnap = serializeRecipients(await getAllRecipientEmails(item));

    const override = await getManualOverride(item);
    if (override) return { id: override, snapshot: currentSnap, reason: "manual override", persist: false };

    const [activeId, snapshot] = await Promise.all([
        getItemProp(item, P_ACTIVE_SIG),
        getItemProp(item, P_RECIP_SNAPSHOT),
    ]);

    // Recipients unchanged since the compose-time decision: skip re-evaluation
    // (the expensive, Mac-hostile part) but still reapply the id.
    if (activeId && snapshot !== null && snapshot === currentSnap) {
        return { id: activeId, snapshot: currentSnap, reason: "recipients unchanged since compose", persist: false };
    }

    const { rule, blocked } = await findMatchingRule(item, userEmail, {
        allowNetwork: true,
        budgetMs: FETCH_BUDGET_MS,
        strictComposeType: true,
    });

    if (rule) {
        return { id: String(rule.signatureId), snapshot: currentSnap, reason: `rule priority=${rule.priority}`, persist: true };
    }

    const fallback = activeId || await getActiveSignatureId(item);
    if (blocked && fallback) {
        return { id: fallback, snapshot: currentSnap, reason: "evaluation blocked — persisted id", persist: false };
    }
    if (!blocked) {
        return { id: DEFAULT_ID, snapshot: currentSnap, reason: "no rule matched", persist: true };
    }
    return { id: fallback || DEFAULT_ID, snapshot: currentSnap, reason: "last resort", persist: false };
}

async function onSendCore(item, mailbox) {
    const t0 = Date.now();
    const userEmail = mailbox?.userProfile?.emailAddress;
    const seq = beginWrite();

    const { id, snapshot, reason, persist } = await decideSendId(item, userEmail);
    log(`onSend: target id=${id} (${reason})`);

    const applied = await applyById(item, id, userEmail, seq, { isSendTime: true });
    if (applied && persist) await markActiveSignature(item, id, snapshot);

    removeNotification(item);
    timed(`onSendCore (${applied ? "applied" : "left as-is"})`, t0);
}

// ─────────────────────────────────────────────────────────────────────────────
//  ENTRY POINTS
// ─────────────────────────────────────────────────────────────────────────────

// Every handler completes exactly once, even if the body throws.
function makeCompleter(label, t0, event, args) {
    let done = false;
    return () => {
        if (done) return;
        done = true;
        timed(label, t0);
        try { event.completed(args); } catch (_) { }
    };
}

const applySignature = async function (event = { completed: () => { } }) {
    const t0 = Date.now();
    const mailbox = Office?.context?.mailbox;
    const item = mailbox?.item;
    const complete = makeCompleter("applySignature total", t0, event);

    try {
        if (!item) return complete();
        log(`applySignature start — ${CB_VERSION} on ${detectPlatform()} (X-Platform: ${getXPlatform()})`);
        notifyStatus(item, "Preparing your signature...", t0);

        const seq = beginWrite();
        const userEmail = mailbox?.userProfile?.emailAddress;

        await markActiveSignature(item, null);

        // Persist the compose type here, in the runtime where the API behaves.
        // The send runtime reads it instead of re-deriving it.
        const composeTypeP = getComposeType(item, { persist: true })
            .then((t) => log("composeType at compose:", t))
            .catch((e) => warn("composeType resolution failed:", e));

        // Warm the rules cache before evaluating.
        const rulesP = (async () => {
            if (!userEmail || getCachedRules()) return;
            await fetchRules(await encryptEmail(userEmail));
        })().catch((e) => warn("rules refresh failed:", e));

        await Promise.allSettled([composeTypeP, rulesP]);

        _lastSnapshot = serializeRecipients(await getAllRecipientEmails(item));
        await evaluateAndApply(item, mailbox, seq);

        if (userEmail && !isMobile()) {
            prefetchRuleSignatures(userEmail).catch((e) => warn("prefetch failed:", e));
        }
    } catch (e) {
        err("applySignature error:", e);
    } finally {
        complete();
    }
};

let _lastSnapshot = "";

const onRecipientsChangedHandler = async function (event = { completed: () => { } }) {
    const t0 = Date.now();
    const mailbox = Office?.context?.mailbox;
    const item = mailbox?.item;
    const complete = makeCompleter("onRecipientsChanged total", t0, event);

    try {
        if (!item) return complete();

        // Let the host settle: OWA fires per keystroke-ish, and a half-typed
        // address produces a recipient set we do not want to evaluate.
        await sleep(RECIPIENT_SETTLE_MS);

        const snapshot = serializeRecipients(await getAllRecipientEmails(item));
        if (snapshot === _lastSnapshot) { log("recipients unchanged — skipping"); return complete(); }
        _lastSnapshot = snapshot;

        log("recipients changed — re-evaluating");
        await evaluateAndApply(item, mailbox, beginWrite());
    } catch (e) {
        err("onRecipientsChangedHandler error:", e);
    } finally {
        complete();
    }
};

const onFromChangedHandler = async function (event = { completed: () => { } }) {
    const t0 = Date.now();
    const mailbox = Office?.context?.mailbox;
    const item = mailbox?.item;
    const complete = makeCompleter("onFromChanged total", t0, event);

    try {
        if (!item) return complete();
        log("from changed — re-evaluating for the new account");

        const seq = beginWrite();
        const userEmail = mailbox?.userProfile?.emailAddress;

        // The account changed, so every cached signature and rule belongs to
        // the previous identity.
        store.remove(K_SIG_CACHE, K_SIG_CACHE_LEGACY_DEFAULT, K_RULES, K_RULES_TS);
        await markActiveSignature(item, null);

        if (userEmail) await fetchRules(await encryptEmail(userEmail));

        _lastSnapshot = serializeRecipients(await getAllRecipientEmails(item));
        await evaluateAndApply(item, mailbox, seq);
    } catch (e) {
        err("onFromChangedHandler error:", e);
    } finally {
        complete();
    }
};

const onSendHandler = async function (event = { completed: () => { } }) {
    const t0 = Date.now();
    const mailbox = Office?.context?.mailbox;
    const item = mailbox?.item;
    // Always allow the send: a signature problem must never block the user.
    const complete = makeCompleter("onSendHandler total", t0, event, { allowEvent: true });

    try {
        if (!item) return complete();
        log(`onSendHandler start — ${CB_VERSION} on ${detectPlatform()}`);
        showNotification(item, "Verifying signature...");

        const budget = isMac() ? SEND_BUDGET_MS_MAC : SEND_BUDGET_MS;
        await withTimeout(onSendCore(item, mailbox), budget, "onSendCore");
    } catch (e) {
        warn("onSend timeout/error:", e.message);
        removeNotification(item);
    } finally {
        complete();
    }
};

// ─────────────────────────────────────────────────────────────────────────────
//  BOOTSTRAP
//  NOTE: on Windows classic the event runtime does not run Office.onReady —
//  never put logic here that a handler depends on.
// ─────────────────────────────────────────────────────────────────────────────

Office.onReady(() => {
    log(`ready — ${CB_VERSION} | platform=${detectPlatform()} | X-Platform=${getXPlatform()} | session=${getSessionId()}`);
    try {
        const d = Office.context.mailbox?.diagnostics;
        if (d) log(`host=${d.hostName} version=${d.hostVersion}`);
    } catch (_) { }
    sigCache.purge();
});

if (typeof Office !== "undefined" && Office.actions?.associate) {
    Office.actions.associate("applySignature", applySignature);
    Office.actions.associate("onSendHandler", onSendHandler);
    Office.actions.associate("onFromChangedHandler", onFromChangedHandler);
    Office.actions.associate("onRecipientsChangedHandler", onRecipientsChangedHandler);
    log(`${CB_VERSION} handlers registered`);
} else {
    log("Office.actions unavailable — LaunchEvent path inactive (Outlook 2016/2019)");
}