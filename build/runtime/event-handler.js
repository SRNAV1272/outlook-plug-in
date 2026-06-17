// =============================================================================
//  CardByte Outlook Add-in — event-handler.js
//  Optimised & consolidated — June 2026
// =============================================================================

"use strict";

// ─── Constants ────────────────────────────────────────────────────────────────

const AES_KEY = "fnItrY2YfozBqCC2B4XsfqHIvZku3kUOq3DFkbO64kk=";
const AES_IV = "3YapeNfJDung7TXxeKXn4g==";
const BASE_URL = "https://newqa-enterprise.cardbyte.ai/email-signature";

const HEAVY_THRESHOLD = 100 * 1024;   // 100 KB
const MAX_SAFE_HTML_SIZE = 500_000;
const MAX_SAFE_HTML_SIZE_MOBILE = 200_000;
const MAX_RETRIES = 2;

// localStorage / sessionStorage keys
const SESSION_KEY = "cardbyte_session_id";
const CACHE_KEY = "cardbyte_cached_signature";
const CACHE_SESSION_KEY = "cardbyte_cached_signature_session";
const CACHE_TIMESTAMP_KEY = "cardbyte_cached_signature_ts";
const CACHE_TTL_MS = 5 * 60 * 1000;

const RULES_CACHE_KEY = "cardbyte_cached_rules";
const RULES_CACHE_TIMESTAMP_KEY = "cardbyte_cached_rules_ts";
const RULES_CACHE_TTL_MS = 5 * 60 * 1000;

// ── Per-signatureId HTML cache ─────────────────────────────────────────────
// Shape: { [signatureId]: { html: string, ts: number } }
// Shared across all compose/reply/forward windows via SharedRuntime localStorage.
const SIG_BY_ID_CACHE_KEY = "cardbyte_sig_by_id";
const SIG_BY_ID_TTL_MS = 5 * 60 * 1000;   // same TTL as other caches

const NOTIF_KEY_HEAVY = "cardbyte_sig_heavy";
const RECIPIENT_POLL_MS = 2000;   // poll interval for OWA fallback

// ─── In-memory signature cache (fastest path) ────────────────────────────────

let CACHED_SIGNATURE_HTML = null;

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

// Returns "MAC" or "WINDOWS" for X-Platform header
function getXPlatform() {
    return Office.context.diagnostics.platform === Office.PlatformType.Mac ? "MAC" : "WINDOWS";
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

async function aesDecrypt(encryptedText, keyB64 = AES_KEY) {
    if (!encryptedText) return "";
    try {
        const keyBuf = base64ToArrayBuffer(keyB64);
        if (keyBuf.byteLength !== 16 && keyBuf.byteLength !== 32) {
            return keyB64 !== AES_KEY ? aesDecrypt(encryptedText, AES_KEY) : encryptedText;
        }
        const ivBuf = base64ToArrayBuffer(AES_IV);
        const cryptoKey = await crypto.subtle.importKey("raw", keyBuf, { name: "AES-CBC" }, false, ["decrypt"]);
        const encBuf = base64ToArrayBuffer(encryptedText);
        if (encBuf.byteLength % 16 !== 0) { console.error("[CardByte] Invalid encrypted data length"); return encryptedText; }
        const dec = await crypto.subtle.decrypt({ name: "AES-CBC", iv: ivBuf }, cryptoKey, encBuf);
        return new TextDecoder().decode(dec);
    } catch (err) {
        if (keyB64 !== AES_KEY) {
            try { return await aesDecrypt(encryptedText, AES_KEY); } catch (_) { }
        }
        console.error("[CardByte] aesDecrypt error:", err);
        return encryptedText;
    }
}

async function encryptEmail(email = "") {
    if (!email.trim()) return "";
    try {
        const keyBuf = base64ToArrayBuffer(AES_KEY);
        const ivBuf = base64ToArrayBuffer(AES_IV);
        const cryptoKey = await crypto.subtle.importKey("raw", keyBuf, { name: "AES-CBC" }, false, ["encrypt"]);
        const enc = await crypto.subtle.encrypt({ name: "AES-CBC", iv: ivBuf }, cryptoKey, new TextEncoder().encode(email));
        return arrayBufferToBase64(enc);
    } catch (err) {
        console.error("[CardByte] encryptEmail error:", err);
        return "";
    }
}

// =============================================================================
//  STORAGE HELPERS — localStorage wrappers with try/catch
// =============================================================================

const store = {
    get: (key) => { try { return localStorage.getItem(key); } catch (_) { return null; } },
    set: (key, val) => { try { localStorage.setItem(key, val); } catch (_) { } },
    remove: (...keys) => { try { keys.forEach(k => localStorage.removeItem(k)); } catch (_) { } },
    getJson: (key) => { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : null; } catch (_) { return null; } },
    setJson: (key, val) => { try { localStorage.setItem(key, JSON.stringify(val)); } catch (_) { } },
};

// ─── Session ID ───────────────────────────────────────────────────────────────

function getOrCreateSessionId() {
    let sid = sessionStorage.getItem(SESSION_KEY);
    if (!sid) {
        sid = crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36);
        sessionStorage.setItem(SESSION_KEY, sid);
    }
    return sid;
}

// ─── Default signature cache ──────────────────────────────────────────────────

function getCachedSignature({ skipTtl = false, skipSessionCheck = false } = {}) {
    if (skipSessionCheck) return store.get(CACHE_KEY);

    const currentSid = getOrCreateSessionId();
    if (store.get(CACHE_SESSION_KEY) !== currentSid) {
        console.log("[CardByte] New session — clearing signature cache");
        store.remove(CACHE_KEY, CACHE_SESSION_KEY, CACHE_TIMESTAMP_KEY);
        return null;
    }
    if (!skipTtl) {
        const ts = parseInt(store.get(CACHE_TIMESTAMP_KEY) || "0", 10);
        if (Date.now() - ts > CACHE_TTL_MS) {
            console.log("[CardByte] Signature cache TTL expired");
            store.remove(CACHE_KEY, CACHE_SESSION_KEY, CACHE_TIMESTAMP_KEY);
            return null;
        }
    }
    return store.get(CACHE_KEY);
}

function setCachedSignature(html) {
    const sid = getOrCreateSessionId();
    store.set(CACHE_KEY, html);
    store.set(CACHE_SESSION_KEY, sid);
    store.set(CACHE_TIMESTAMP_KEY, Date.now().toString());
}

// ─── Rules cache ─────────────────────────────────────────────────────────────

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

// ─── Per-signatureId HTML cache ───────────────────────────────────────────────
//
// Stored as a single JSON map under SIG_BY_ID_CACHE_KEY so all compose /
// reply / forward windows sharing the same SharedRuntime localStorage key
// see each other's fetched signatures immediately.
//
//  Map shape: { [signatureId]: { html: string, ts: number } }

function _readSigByIdMap() {
    return store.getJson(SIG_BY_ID_CACHE_KEY) || {};
}

function _writeSigByIdMap(map) {
    store.setJson(SIG_BY_ID_CACHE_KEY, map);
}

function getSigById(signatureId, { skipTtl = false } = {}) {
    const id = String(signatureId);
    const map = _readSigByIdMap();
    const entry = map[id];
    if (!entry) return null;
    if (!skipTtl && Date.now() - entry.ts > SIG_BY_ID_TTL_MS) {
        console.log(`[CardByte] sigById cache TTL expired for id=${id}`);
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
//  NOTIFICATION HELPERS
// =============================================================================

function showNotification(item, message) {
    try {
        if (typeof item?.notificationMessages?.addAsync !== "function") return;
        item.notificationMessages.addAsync(
            NOTIF_KEY_HEAVY,
            {
                type: Office.MailboxEnums.ItemNotificationMessageType.InformationalMessage,
                message,
                icon: "Icon.16x16",
                persistent: true,
            },
            (r) => { if (r.status !== Office.AsyncResultStatus.Succeeded) console.warn("[CardByte] Notification failed:", r.error?.message); }
        );
    } catch (err) { console.warn("[CardByte] showNotification error:", err); }
}

function removeNotification(item) {
    try {
        if (typeof item?.notificationMessages?.removeAsync !== "function") return;
        item.notificationMessages.removeAsync(NOTIF_KEY_HEAVY, () => { });
    } catch (_) { }
}

// =============================================================================
//  API LAYER
// =============================================================================

/** Decrypts a raw API response text and extracts the `html` field. */
async function decryptHtmlResponse(rawText) {
    const decrypted = await aesDecrypt(rawText);
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

/** Fetches the default (primary) signature HTML. */
async function fetchPrimarySignature(encryptedMail, xPlatform) {
    try {
        const res = await fetch(`${BASE_URL}/html/outlook/get-active`, {
            method: "GET",
            headers: { username: encryptedMail, "X-Platform": xPlatform },
        });
        if (!res.ok) { console.warn("[CardByte] Primary renderer returned", res.status); return null; }
        const html = await decryptHtmlResponse(await res.text());
        if (html) console.log("[CardByte] Primary renderer succeeded");
        else console.warn("[CardByte] Primary renderer returned empty html");
        return html;
    } catch (err) {
        console.warn("[CardByte] Primary renderer crashed:", err);
        return null;
    }
}

/**
 * Fetches the signature HTML for a specific signatureId directly from the
 * network — no cache logic here; use getOrFetchSignatureById for that.
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
 * Cache-first wrapper around fetchSignatureById.
 *
 * Hit  → returns cached HTML immediately (no network call).
 * Miss → fetches from API, stores result in the shared sigById map, returns HTML.
 *
 * All compose / reply / forward windows in the same SharedRuntime share the
 * same localStorage entry, so the first window to fetch a given signatureId
 * makes all subsequent windows instant cache hits.
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
 * Main signature resolver:
 *  1. Runs primary renderer + rules fetch in parallel.
 *  2. Returns primary HTML if available, otherwise falls back to the
 *     highest-priority enabled rule (using the shared sigById cache).
 *  Side-effect: always populates the rules cache.
 */
async function resolveSignatureFromServer(userEmail) {
    const xPlatform = getXPlatform();
    const encryptedMail = await encryptEmail(userEmail);

    const [primaryHtml, rulesJson] = await Promise.all([
        fetchPrimarySignature(encryptedMail, xPlatform),
        fetchAndCacheRules(encryptedMail, xPlatform),
    ]);

    if (primaryHtml) {
        console.log("[CardByte] Using primary renderer result");
        return primaryHtml;
    }

    console.warn("[CardByte] Primary returned null — falling back to top-priority rule");

    const enabledRules = (rulesJson?.rulesList || [])
        .filter(r => r.enabled)
        .sort((a, b) => a.priority - b.priority);

    if (enabledRules.length === 0) {
        console.warn("[CardByte] No enabled rules found");
        return null;
    }

    const topRule = enabledRules[0];
    console.log(`[CardByte] Fallback rule: "${topRule.rule}" (priority ${topRule.priority}), signatureId: ${topRule.signatureId}`);
    return getOrFetchSignatureById(topRule.signatureId, encryptedMail, xPlatform);
}

/**
 * Prefetches and caches the HTML for every enabled rule's signatureId in
 * parallel. Called at compose-open time so recipient-change lookups are instant.
 */
async function prefetchAllRuleSignatures(userEmail) {
    const rulesJson = getCachedRules({ skipTtl: false });
    if (!rulesJson) {
        console.log("[CardByte] prefetchAllRuleSignatures: rules not cached yet — skipping");
        return;
    }

    const enabledRules = (rulesJson?.rulesList || [])
        .filter(r => r.enabled && r.signatureId != null);

    if (enabledRules.length === 0) return;

    const xPlatform = getXPlatform();
    const encryptedMail = await encryptEmail(userEmail);

    console.log(`[CardByte] 🔄 Prefetching signatures for ${enabledRules.length} rule(s)...`);

    await Promise.allSettled(
        enabledRules.map(r =>
            getOrFetchSignatureById(r.signatureId, encryptedMail, xPlatform)
                .then(html => {
                    if (html) console.log(`[CardByte] ✅ Prefetched signatureId=${r.signatureId}`);
                    else console.warn(`[CardByte] ⚠️  Prefetch returned null for signatureId=${r.signatureId}`);
                })
                .catch(err => console.warn(`[CardByte] Prefetch error for signatureId=${r.signatureId}:`, err))
        )
    );

    console.log("[CardByte] Prefetch complete");
}

// =============================================================================
//  RECIPIENT HELPERS
// =============================================================================

/** Reads a recipient field asynchronously; resolves to an empty array on failure. */
function getRecipientsAsync(field) {
    return new Promise((resolve) => {
        if (typeof field?.getAsync !== "function") return resolve([]);
        field.getAsync((result) => {
            resolve(result.status === Office.AsyncResultStatus.Succeeded ? (result.value || []) : []);
        });
    });
}

/** Reads To + CC and returns a deduplicated array of lowercase email strings. */
async function getAllRecipientEmails(item) {
    const [to, cc] = await Promise.all([
        getRecipientsAsync(item?.to),
        getRecipientsAsync(item?.cc),
    ]);
    const emails = [...to, ...cc].map(r => (r.emailAddress || "").toLowerCase()).filter(Boolean);
    return [...new Set(emails)];
}

// =============================================================================
//  COMPOSE CONTEXT DETECTION
// =============================================================================

/**
 * Resolves the compose context for the current item: "compose" | "reply".
 *
 * Uses getComposeTypeAsync when available (New Outlook / OWA).
 * Falls back to conversationId presence for Classic Outlook.
 *
 * Result is cached per LaunchEvent invocation in _composeContext so the async
 * Office call only happens once per compose window. Reset to null at the top
 * of applySignature() so each new window gets a fresh detection.
 */
let _composeContext = null;   // "compose" | "reply" | null (uninitialised)

async function getOrDetectComposeContext() {
    if (_composeContext !== null) return _composeContext;

    _composeContext = await new Promise((resolve) => {
        const item = Office?.context?.mailbox?.item;
        if (!item) return resolve("compose");

        if (typeof item.getComposeTypeAsync === "function") {
            item.getComposeTypeAsync((result) => {
                if (result.status !== Office.AsyncResultStatus.Succeeded) return resolve("compose");
                const ct = result.value?.composeType || "";
                // ComposeType enum values: "newMail" | "reply" | "forward"
                resolve(ct === "reply" || ct === "forward" ||
                    ct === Office.MailboxEnums.ComposeType?.Reply ||
                    ct === Office.MailboxEnums.ComposeType?.Forward
                    ? "reply" : "compose");
            });
        } else {
            // Classic Outlook: conversationId is set on replies/forwards, null on new mail
            resolve(item.conversationId ? "reply" : "compose");
        }
    });

    console.log(`[CardByte] Compose context detected: ${_composeContext}`);
    return _composeContext;
}

// =============================================================================
//  RULES MATCHING ENGINE
// =============================================================================

/**
 * Returns true if `email` satisfies `pattern`.
 * Patterns: "*" (wildcard) | "domain.com" (domain match) | "user@domain.com" (exact)
 */
function emailMatchesPattern(email, pattern) {
    if (!pattern?.trim()) return false;
    const p = pattern.trim().toLowerCase();
    if (p === "*") return true;
    if (!p.includes("@")) return email.endsWith("@" + p);
    return email === p;
}

/**
 * Returns true if the rule's ruleValue patterns are satisfied by the recipient list.
 *
 * For NON-external rules (internal / all):
 *   ruleType "ALL"  → every pattern must match at least one recipient.
 *   ruleType "DOMAIN" | "ANY" (default) → at least one recipient matches at least one pattern.
 *
 * For EXTERNAL rules (when externalEmails is provided):
 *   ruleValue is an EXCLUSION list — the rule fires only when ALL external
 *   recipients are NOT matched by any pattern in ruleValue.
 *   e.g. ruleValue: ["gmail.com"] means:
 *     "apply this signature to every external domain EXCEPT gmail.com"
 *   → fires only if no external recipient's domain appears in ruleValue.
 *
 * @param {object}      rule
 * @param {string[]}    emails         - full recipient list (To + CC), lowercase
 * @param {string[]|null} externalEmails - non-null only for external-classified rules;
 *                                        internal recipients already stripped out
 */
function ruleMatchesEmails(rule, emails, externalEmails = null) {
    const ruleValue = rule.ruleValue || [];

    // ── External exclusion logic ──────────────────────────────────────────────
    if (externalEmails !== null) {
        if (externalEmails.length === 0) return false; // no external recipients — nothing to match

        // Rule fires only when NO external recipient is covered by any exclusion pattern
        const anyExcluded = externalEmails.some(email =>
            ruleValue.some(pattern => emailMatchesPattern(email, pattern))
        );
        return !anyExcluded;
    }

    // ── Standard inclusion logic (internal / all rules) ───────────────────────
    const ruleType = (rule.ruleType || "ANY").toUpperCase();

    if (ruleType === "ALL") {
        return ruleValue.every(p => emails.some(e => emailMatchesPattern(e, p)));
    }
    return emails.some(e => ruleValue.some(p => emailMatchesPattern(e, p)));
}

/**
 * Classifies the recipient list as "internal", "external", or "all".
 *
 * internal → every recipient shares the user's domain
 * external → at least one recipient is on a different domain  (mixed = external)
 * all      → fallback when userEmail or recipients are unavailable
 *
 * Short-circuits on the first external hit for performance.
 *
 * @param {string[]} recipientEmails  - lowercase email strings
 * @param {string}   userEmail        - logged-in user's email address
 * @returns {"internal"|"external"|"all"}
 */
function classifyRecipientType(recipientEmails, userEmail) {
    if (!userEmail || recipientEmails.length === 0) return "all";

    const userDomain = userEmail.split("@")[1]?.toLowerCase() || "";
    if (!userDomain) return "all";

    for (const email of recipientEmails) {
        const domain = email.split("@")[1]?.toLowerCase() || "";
        if (domain !== userDomain) return "external";   // short-circuit
    }
    return "internal";
}

/**
 * Selects the single best rule for the current compose window.
 *
 * Evaluation hierarchy (highest tier wins; priority number breaks ties within a tier):
 *
 *   Tier 1 — context exact  + recipientType exact  (e.g. "reply"  + "internal" / "external")
 *   Tier 2 — context exact  + recipientType all    (e.g. "reply"  + "all")
 *   Tier 3 — context all    + recipientType exact  (e.g. "all"    + "internal" / "external")
 *   Tier 4 — context all    + recipientType all    (e.g. "all"    + "all")
 *
 * "all" on either dimension is a fallback — used only when no rule with a
 * more-specific value on that dimension passes its match check.
 *
 * Within the same tier the rule with the lowest priority number wins.
 *
 * External recipientType matching:
 *   Internal recipients (same domain as user) are stripped before pattern
 *   matching. ruleValue acts as an EXCLUSION list — the rule fires only when
 *   ALL remaining external recipients are NOT covered by any pattern in ruleValue.
 *   If no matching external rule exists the engine falls through to the next tier.
 *
 * @param {object[]} enabledRules      - pre-filtered to enabled only (any order)
 * @param {string[]} recipientEmails   - lowercase deduplicated emails (To + CC)
 * @param {"compose"|"reply"} composeContext
 * @param {string}   userEmail
 * @returns {object|null}
 */
function selectBestRule(enabledRules, recipientEmails, composeContext, userEmail) {
    const classified = classifyRecipientType(recipientEmails, userEmail);
    console.log(`[CardByte] Recipient type: ${classified} | Context: ${composeContext}`);

    // Pre-compute external-only list once — reused for every external rule check
    const userDomain = (userEmail.split("@")[1] || "").toLowerCase();
    const externalEmails = userDomain
        ? recipientEmails.filter(e => (e.split("@")[1] || "").toLowerCase() !== userDomain)
        : [...recipientEmails];

    // Tier buckets: index 0 = highest (exact+exact) … index 3 = lowest (all+all)
    const buckets = [null, null, null, null];

    for (const rule of enabledRules) {

        // ── Context dimension ─────────────────────────────────────────────────
        const ctx = (rule.context || "all").toLowerCase();
        const ctxExact = ctx === composeContext;
        const ctxAll = ctx === "all";

        if (!ctxExact && !ctxAll) continue; // e.g. rule is "compose" but we're in "reply"

        // ── RecipientType dimension ───────────────────────────────────────────
        const rt = (rule.recipientType || "all").toLowerCase();
        const rtExact = rt === classified;
        const rtAll = rt === "all";

        if (!rtExact && !rtAll) continue;   // e.g. rule is "internal" but recipients are external

        // ── Pattern filter ────────────────────────────────────────────────────
        // External rules: pass externalEmails → exclusion logic
        // All other rules: pass null → standard inclusion logic
        const emailsCtx = rt === "external" ? externalEmails : null;
        if (!ruleMatchesEmails(rule, recipientEmails, emailsCtx)) continue;

        // ── Assign tier ───────────────────────────────────────────────────────
        //   ctxExact + rtExact → 0
        //   ctxExact + rtAll   → 1
        //   ctxAll   + rtExact → 2
        //   ctxAll   + rtAll   → 3
        const tier = (ctxExact ? 0 : 2) + (rtExact ? 0 : 1);

        // ── Keep lowest priority number within this tier ──────────────────────
        if (buckets[tier] === null || rule.priority < buckets[tier].priority) {
            buckets[tier] = rule;
        }
    }

    // ── Return the best rule from the highest non-empty tier ─────────────────
    const bestRule = buckets.find(b => b !== null) ?? null;

    if (bestRule) {
        console.log(
            `[CardByte] ✅ Best rule: "${bestRule.rule}"`,
            `| tier=${buckets.findIndex(b => b === bestRule) + 1}`,
            `| priority=${bestRule.priority}`,
            `| context=${bestRule.context}`,
            `| recipientType=${bestRule.recipientType}`,
            `| signatureId=${bestRule.signatureId}`
        );
    } else {
        console.warn(
            "[CardByte] ❌ No rule matched",
            "| context:", composeContext,
            "| recipientType:", classified,
            "| externalEmails:", externalEmails,
            "| allRecipients:", recipientEmails
        );
    }

    return bestRule;
}

/**
 * Public entry point for rule evaluation.
 *
 * Runs getAllRecipientEmails and getOrDetectComposeContext in parallel (both
 * are async Office calls) so neither waits on the other. Live-fetches rules
 * from the API only when the cache is cold.
 *
 * @param {object} item  - Office mailbox item
 * @returns {Promise<object|null>}  best matching rule, or null
 */
async function findMatchingRule(item) {

    // ── Rules: cache-first, single live fetch on miss ────────────────────────
    let rulesJson = getCachedRules();
    if (!rulesJson) {
        console.warn("[CardByte] Rules not in cache — live fetch...");
        const userEmail = Office?.context?.mailbox?.userProfile?.emailAddress;
        if (userEmail) {
            const enc = await encryptEmail(userEmail);
            rulesJson = await fetchAndCacheRules(enc, getXPlatform());
        }
        if (!rulesJson) {
            console.warn("[CardByte] findMatchingRule: no rules available");
            return null;
        }
    }

    // ── Recipients + context in parallel ─────────────────────────────────────
    const [recipientEmails, composeContext] = await Promise.all([
        getAllRecipientEmails(item),
        getOrDetectComposeContext(),
    ]);

    if (recipientEmails.length === 0) {
        console.warn("[CardByte] No recipients yet — cannot match rules");
        return null;
    }

    const userEmail = Office?.context?.mailbox?.userProfile?.emailAddress || "";
    const enabledRules = (rulesJson?.rulesList || []).filter(r => r.enabled);

    return selectBestRule(enabledRules, recipientEmails, composeContext, userEmail);
}

// =============================================================================
//  SIGNATURE INJECTION
// =============================================================================

function bodySetSignatureAsync(item, html) {
    return new Promise((resolve, reject) => {
        if (typeof item.body.setSignatureAsync !== "function") { reject(new Error("setSignatureAsync not available")); return; }
        item.body.setSignatureAsync(html, { coercionType: Office.CoercionType.Html }, (r) => {
            r.status === "succeeded" ? resolve() : reject(r.error);
        });
    });
}

function bodySetSelectedDataAsync(item, html) {
    return new Promise((resolve, reject) => {
        if (typeof item.body.setSelectedDataAsync !== "function") { reject(new Error("setSelectedDataAsync not available")); return; }
        item.body.setSelectedDataAsync(html, { coercionType: Office.CoercionType.Html }, (r) => {
            r.status === Office.AsyncResultStatus.Succeeded ? resolve() : reject(r.error);
        });
    });
}

/**
 * Injects HTML into the compose body.
 * Light (<100 KB): uses setSignatureAsync directly.
 * Heavy (≥100 KB): cursor trick at compose time; skipped at send time (already there).
 */
async function applySignatureWithFallback(item, html, isSendTime = false) {
    const htmlSize = new Blob([html]).size;
    console.log("[CardByte] Signature size:", htmlSize, "bytes");

    if (htmlSize < HEAVY_THRESHOLD) {
        removeNotification(item);
        await bodySetSignatureAsync(item, html);
        return true;
    }

    console.warn(`[CardByte] Heavy signature (${htmlSize} bytes) — isSendTime=${isSendTime}`);

    if (isSendTime) {
        console.log("[CardByte] Heavy signature at send time — skipping (already in body)");
        removeNotification(item);
        return false;
    }

    try {
        await bodySetSignatureAsync(item, "");          // move cursor to bottom
        await bodySetSelectedDataAsync(item, html);     // inject at cursor
        removeNotification(item);
        console.log("[CardByte] Heavy signature inserted via cursor trick");
        return true;
    } catch (err) {
        console.error("[CardByte] Heavy path insertion failed:", err);
        showNotification(item, "Your signature is large and could not be inserted. Please contact Admin.");
        return false;
    }
}

// =============================================================================
//  CORE SIGNATURE ORCHESTRATOR
// =============================================================================

/**
 * Resolves the correct signature HTML and injects it into the compose body.
 *
 * @param {object}  item                        - Office mailbox item
 * @param {object}  mailbox                     - Office mailbox
 * @param {object}  opts
 * @param {boolean} opts.fetchIfMissing         - fetch from server if cache is cold
 * @param {boolean} opts.skipTtl               - bypass TTL check on the cache
 * @param {boolean} opts.skipSessionCheck      - bypass session-ID check
 * @param {string|null} opts.overrideHtml      - use this HTML directly (rule-matched)
 * @param {boolean} isSendTime                 - true when called from onSendHandler
 */
async function applySignatureCore(item, mailbox, opts = {}, isSendTime = false) {
    const { fetchIfMissing = false, skipTtl = false, skipSessionCheck = false, overrideHtml = null } = opts;
    const userEmail = mailbox?.userProfile?.emailAddress;

    // ── 1. Determine which HTML to use ─────────────────────────────────────
    let html = overrideHtml;

    if (!html) {
        html = getCachedSignature({ skipTtl, skipSessionCheck });
    }

    if (!html && fetchIfMissing && userEmail) {
        let attempt = 0;
        while (attempt <= MAX_RETRIES) {
            try {
                if (attempt > 0) {
                    console.warn(`[CardByte] Retry ${attempt}/${MAX_RETRIES}...`);
                    await new Promise(r => setTimeout(r, 1000 * attempt));
                }
                const result = await resolveSignatureFromServer(userEmail);
                if (result != null) {
                    html = result;
                    CACHED_SIGNATURE_HTML = html;
                    setCachedSignature(html);
                    break;
                }
            } catch (err) {
                console.warn(`[CardByte] Fetch attempt ${attempt + 1} failed:`, err);
            }
            attempt++;
        }
    }

    // ── 2. Last resort: stale cache ─────────────────────────────────────────
    if (!html) {
        const stale = getCachedSignature({ skipTtl: true, skipSessionCheck: true });
        if (stale) {
            console.warn("[CardByte] Using stale cache as last resort");
            html = stale;
        }
    }

    // ── 3. Inject or bail ──────────────────────────────────────────────────
    if (!html) {
        console.error("[CardByte] No signature available — aborting");
        removeNotification(item);
        showNotification(item, "Signature not available. Please contact Admin.");
        return;
    }

    await applySignatureWithFallback(item, html, isSendTime);
}

// =============================================================================
//  RECIPIENT-CHANGE HANDLER — applies the rule-matched signature
// =============================================================================

/**
 * Called whenever the recipient list changes (via event or poll).
 * Finds the matching rule, resolves that signature via the shared sigById
 * cache (zero network if already prefetched), and injects it.
 */
async function onRecipientsChanged(item) {
    const matched = await findMatchingRule(item);
    if (!matched) return;

    console.log(`[CardByte] 🎯 Rule matched → "${matched.rule}" | signatureId: ${matched.signatureId}`);

    const userEmail = Office?.context?.mailbox?.userProfile?.emailAddress;
    const xPlatform = getXPlatform();
    const encryptedMail = await encryptEmail(userEmail);

    // Cache-first: will be a hit if prefetchAllRuleSignatures ran at compose open
    const ruleHtml = await getOrFetchSignatureById(matched.signatureId, encryptedMail, xPlatform);
    if (!ruleHtml) {
        console.warn("[CardByte] Rule signature fetch returned null — keeping current signature");
        return;
    }

    console.log("[CardByte] Injecting rule-matched signature");
    await applySignatureWithFallback(item, ruleHtml, false);
}

// =============================================================================
//  RECIPIENT POLLING — OWA fallback (RecipientsChanged is unreliable in OWA)
// =============================================================================

let _lastRecipientSnapshot = "";
let _recipientPollTimer = null;

function serializeRecipients(emails) {
    return [...emails].sort().join(",");
}

async function pollRecipients() {
    const item = Office?.context?.mailbox?.item;
    if (!item) return;

    const emails = await getAllRecipientEmails(item);
    const snapshot = serializeRecipients(emails);

    if (snapshot === _lastRecipientSnapshot) return;   // no change
    _lastRecipientSnapshot = snapshot;

    console.log("[CardByte] 🔄 Recipient change detected via poll:", emails);
    if (emails.length === 0) return;

    await onRecipientsChanged(item);
}

function startRecipientPolling() {
    if (_recipientPollTimer) return;
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
//  NATIVE RecipientsChanged EVENT — desktop / new Outlook
// =============================================================================

let _recipientsHandlerRegistered = false;

function registerRecipientsChangedHandler() {
    const item = Office?.context?.mailbox?.item;

    if (!item) {
        console.log("[CardByte] Item not ready — retrying RecipientsChanged registration...");
        setTimeout(registerRecipientsChangedHandler, 300);
        return;
    }

    if (_recipientsHandlerRegistered) return;

    if (isMobile()) {
        console.log("[CardByte] RecipientsChanged not supported on mobile — skipping");
        return;
    }

    if (typeof item.addHandlerAsync !== "function") {
        console.warn("[CardByte] addHandlerAsync not available");
        return;
    }

    item.addHandlerAsync(
        Office.EventType.RecipientsChanged,
        async (eventArgs) => {
            console.log("[CardByte] 🔔 RecipientsChanged (native):", eventArgs);
            const currentItem = Office?.context?.mailbox?.item;
            if (!currentItem) return;
            await onRecipientsChanged(currentItem);
        },
        { asyncContext: null },
        (result) => {
            if (result.status === Office.AsyncResultStatus.Succeeded) {
                _recipientsHandlerRegistered = true;
                console.log("[CardByte] ✅ RecipientsChanged handler registered");
            } else {
                console.warn("[CardByte] ❌ RecipientsChanged registration failed:", result.error?.message);
                setTimeout(registerRecipientsChangedHandler, 500);
            }
        }
    );
}

// =============================================================================
//  OFFICE READY
// =============================================================================

Office.onReady(() => {
    console.log("✅ Office.onReady fired");
    console.log(`[CardByte] Platform: ${detectPlatform()}`);

    // Opportunistically purge stale per-id entries left from previous sessions
    purgeStaleSigById();

    // Delay slightly to let OWA fully hydrate the mailbox item
    setTimeout(registerRecipientsChangedHandler, 500);
});

// =============================================================================
//  PUBLIC ENTRY POINTS
// =============================================================================

/**
 * applySignature — LaunchEvent handler (new compose / reply / forward)
 * Injects the default signature and kicks off recipient polling + native event.
 */
const applySignature = async function (event = { completed: () => { } }) {
    // Reset per-window state so each new compose/reply/forward gets a fresh
    // context detection and recipient snapshot.
    _composeContext = null;
    _lastRecipientSnapshot = "";
    _recipientsHandlerRegistered = false;

    const mailbox = Office?.context?.mailbox;
    const item = mailbox?.item;

    try {
        if (!item) return;

        const userEmail = mailbox?.userProfile?.emailAddress;

        // Inject default signature (fetches rules + primary in parallel)
        await applySignatureCore(item, mailbox, { fetchIfMissing: true }, false);

        // Prefetch all rule signatures in the background so recipient-change
        // lookups across this and any other open compose windows are instant.
        // Fire-and-forget — failures are logged but don't block the compose open.
        if (userEmail) {
            prefetchAllRuleSignatures(userEmail).catch(err =>
                console.warn("[CardByte] Background prefetch failed:", err)
            );
        }

        // Initial recipient check (handles compose opening with a pre-filled To)
        const emails = await getAllRecipientEmails(item);
        if (emails.length > 0) {
            _lastRecipientSnapshot = serializeRecipients(emails);
            await onRecipientsChanged(item);
        }

        // Start polling as OWA / fallback safety net
        startRecipientPolling();

        // Register native RecipientsChanged handler for desktop / New Outlook
        registerRecipientsChangedHandler();

    } catch (err) {
        console.error("[CardByte] applySignature error:", err);
    } finally {
        event.completed();
    }
};

/**
 * onSendHandler — AppendOnSend / OnMessageSend handler
 * Re-applies the cached signature at send time (handles heavy-sig edge cases).
 */
const onSendHandler = async function (event = { completed: () => { } }) {
    const mailbox = Office?.context?.mailbox;
    const item = mailbox?.item;

    try {
        if (!item) return;

        // Stop polling — compose session is ending
        stopRecipientPolling();

        // await applySignatureCore(
        //     item, mailbox,
        //     { fetchIfMissing: false, skipTtl: true, skipSessionCheck: true },
        //     true  // isSendTime
        // );
    } catch (err) {
        console.error("[CardByte] onSendHandler error:", err);
    } finally {
        event.completed({ allowEvent: true });
    }
};

// =============================================================================
//  REGISTER OFFICE ACTIONS
// =============================================================================

if (typeof Office !== "undefined" && typeof Office.actions !== "undefined") {
    Office.actions.associate("applySignature", applySignature);
    Office.actions.associate("onSendHandler", onSendHandler);
    console.log("[CardByte] Office.actions registered: applySignature, onSendHandler");
} else {
    console.log("[CardByte] Office.actions not available — LaunchEvent path inactive (Outlook 2016/2019)");
}