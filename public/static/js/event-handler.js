// =============================================================================
//  CardByte Outlook Add-in — event-handler.js  (v2 — integrated rule engine)
//  Merges the expressive SignatureRuleEngine (condition trees, visibility rules,
//  audit log) from signature-rule-engine.js into the production architecture
//  of the original event-handler.js (localStorage, AES-CBC, prefetch, injection).
//
//  Rule shape your API must now return from /rules-config/get-active:
//  {
//    rulesJson: {
//      rulesList: [
//        {
//          ruleId:        "rule_001",
//          rule:          "Sales — External New Compose",   // display name
//          priority:      10,
//          enabled:       true,
//          context:       "compose" | "reply" | "all",
//          recipientType: "internal" | "external" | "all",  // legacy tier filter
//          ruleValue:     ["*"] | ["domain.com"] | ["user@x.com"],
//          action: {
//            signatureId:    "sig_sales_external",
//            visibilityRules: [
//              { element: "phone_number", showIf: { field: "user.phone", op: "exists" } },
//              { element: "calendly_link", showIf: { field: "user.role",  op: "eq", value: "AE" } }
//            ]
//          },
//          conditions: {          // optional expressive tree — takes precedence over
//            operator: "AND",     // context/recipientType/ruleValue when present
//            groups: [
//              { operator: "OR", conditions: [
//                  { field: "user.department", op: "eq", value: "Sales" },
//                  { field: "user.department", op: "eq", value: "Business Development" }
//              ]},
//              { field: "mail.isExternal",  op: "eq", value: true },
//              { field: "mail.type",        op: "eq", value: "new_compose" }
//            ]
//          }
//        }
//      ],
//      defaults: {
//        global: "sig_global_default",
//        scoped: [
//          { field: "user.department", value: "Sales",       signatureId: "sig_sales_default" },
//          { field: "user.domain",     value: "cardbyte.ai", signatureId: "sig_internal_default" }
//        ]
//      }
//    }
//  }
//
//  Resolution order (per compose window):
//    1. Expressive condition tree match (if rule.conditions present)
//    2. Legacy tier match (context × recipientType × ruleValue pattern)
//    3. Scoped default (department / domain)
//    4. Global default (always guaranteed)
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

// localStorage keys
const SESSION_KEY = "cardbyte_session_id";
const CACHE_KEY = "cardbyte_cached_signature";
const CACHE_SESSION_KEY = "cardbyte_cached_signature_session";
const CACHE_TIMESTAMP_KEY = "cardbyte_cached_signature_ts";
const CACHE_TTL_MS = 5 * 60 * 1000;

const RULES_CACHE_KEY = "cardbyte_cached_rules";
const RULES_CACHE_TIMESTAMP_KEY = "cardbyte_cached_rules_ts";
const RULES_CACHE_TTL_MS = 5 * 60 * 1000;

// Per-signatureId HTML cache — { [signatureId]: { html, ts } }
const SIG_BY_ID_CACHE_KEY = "cardbyte_sig_by_id";
const SIG_BY_ID_TTL_MS = 5 * 60 * 1000;

const NOTIF_KEY_HEAVY = "cardbyte_sig_heavy";
const RECIPIENT_POLL_MS = 2000;

// Context-assembly hard timeout (ms) — mirrors reference engine
const CONTEXT_TIMEOUT_MS = 800;

// In-memory signature cache (fastest path)
let CACHED_SIGNATURE_HTML = null;


// =============================================================================
//  PLATFORM DETECTION  (unchanged from v1)
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
    return Office.context.diagnostics.platform === Office.PlatformType.Mac ? "MAC" : "WINDOWS";
}


// =============================================================================
//  CRYPTO — AES-CBC  (unchanged from v1)
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
//  STORAGE HELPERS  (unchanged from v1)
// =============================================================================

const store = {
    get: (key) => { try { return localStorage.getItem(key); } catch (_) { return null; } },
    set: (key, val) => { try { localStorage.setItem(key, val); } catch (_) { } },
    remove: (...keys) => { try { keys.forEach(k => localStorage.removeItem(k)); } catch (_) { } },
    getJson: (key) => { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : null; } catch (_) { return null; } },
    setJson: (key, val) => { try { localStorage.setItem(key, JSON.stringify(val)); } catch (_) { } },
};

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
        store.remove(CACHE_KEY, CACHE_SESSION_KEY, CACHE_TIMESTAMP_KEY);
        return null;
    }
    if (!skipTtl) {
        const ts = parseInt(store.get(CACHE_TIMESTAMP_KEY) || "0", 10);
        if (Date.now() - ts > CACHE_TTL_MS) {
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

function _readSigByIdMap() { return store.getJson(SIG_BY_ID_CACHE_KEY) || {}; }
function _writeSigByIdMap(m) { store.setJson(SIG_BY_ID_CACHE_KEY, m); }

function getSigById(signatureId, { skipTtl = false } = {}) {
    const id = String(signatureId);
    const map = _readSigByIdMap();
    const entry = map[id];
    if (!entry) return null;
    if (!skipTtl && Date.now() - entry.ts > SIG_BY_ID_TTL_MS) return null;
    return entry.html;
}

function setSigById(signatureId, html) {
    const id = String(signatureId);
    const map = _readSigByIdMap();
    map[id] = { html, ts: Date.now() };
    _writeSigByIdMap(map);
}

function purgeStaleSigById() {
    const map = _readSigByIdMap();
    const now = Date.now();
    let purged = 0;
    for (const id of Object.keys(map)) {
        if (now - map[id].ts > SIG_BY_ID_TTL_MS) { delete map[id]; purged++; }
    }
    if (purged > 0) _writeSigByIdMap(map);
}


// =============================================================================
//  NOTIFICATION HELPERS  (unchanged from v1)
// =============================================================================

function showNotification(item, message) {
    try {
        if (typeof item?.notificationMessages?.addAsync !== "function") return;
        item.notificationMessages.addAsync(NOTIF_KEY_HEAVY, {
            type: Office.MailboxEnums.ItemNotificationMessageType.InformationalMessage,
            message,
            icon: "Icon.16x16",
            persistent: true,
        }, (r) => { if (r.status !== Office.AsyncResultStatus.Succeeded) console.warn("[CardByte] Notification failed:", r.error?.message); });
    } catch (err) { console.warn("[CardByte] showNotification error:", err); }
}

function removeNotification(item) {
    try {
        if (typeof item?.notificationMessages?.removeAsync !== "function") return;
        item.notificationMessages.removeAsync(NOTIF_KEY_HEAVY, () => { });
    } catch (_) { }
}


// =============================================================================
//  API LAYER  (unchanged from v1)
// =============================================================================

async function decryptHtmlResponse(rawText) {
    const decrypted = await aesDecrypt(rawText);
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
        return rulesJson;
    } catch (err) {
        console.error("[CardByte] fetchAndCacheRules failed:", err);
        return null;
    }
}

async function fetchPrimarySignature(encryptedMail, xPlatform) {
    try {
        const res = await fetch(`${BASE_URL}/html/outlook/get-active`, {
            method: "GET",
            headers: { username: encryptedMail, "X-Platform": xPlatform },
        });
        if (!res.ok) { console.warn("[CardByte] Primary renderer returned", res.status); return null; }
        return await decryptHtmlResponse(await res.text());
    } catch (err) {
        console.warn("[CardByte] Primary renderer crashed:", err);
        return null;
    }
}

async function fetchSignatureById(signatureId, encryptedMail, xPlatform) {
    try {
        const res = await fetch(`${BASE_URL}/rules-config/get/${signatureId}`, {
            method: "GET",
            headers: { username: encryptedMail, "X-Platform": xPlatform },
        });
        if (!res.ok) { console.error("[CardByte] Signature fetch failed:", res.status); return null; }
        return await decryptHtmlResponse(await res.text());
    } catch (err) {
        console.error("[CardByte] fetchSignatureById crashed:", err);
        return null;
    }
}

async function getOrFetchSignatureById(signatureId, encryptedMail, xPlatform, { skipTtl = false } = {}) {
    const id = String(signatureId);
    const cached = getSigById(id, { skipTtl });
    if (cached) { console.log(`[CardByte] ✅ sigById cache hit: id=${id}`); return cached; }

    console.log(`[CardByte] 🌐 sigById cache miss — fetching id=${id}`);
    const html = await fetchSignatureById(id, encryptedMail, xPlatform);
    if (html) setSigById(id, html);
    return html;
}

async function ensureRulesCached(userEmail) {
    let rulesJson = getCachedRules();
    if (rulesJson) return rulesJson;

    console.warn("[CardByte] Rules not in cache — live fetch...");
    if (!userEmail) return null;
    const enc = await encryptEmail(userEmail);
    return await fetchAndCacheRules(enc, getXPlatform());
}

/**
 * Prefetch HTML for every enabled rule's signatureId in parallel.
 * Reads signatureId from rule.action.signatureId (new shape) with fallback
 * to top-level rule.signatureId (legacy shape).
 */
async function prefetchAllRuleSignatures(userEmail) {
    const rulesJson = getCachedRules({ skipTtl: false });
    if (!rulesJson) return;

    const enabledRules = (rulesJson?.rulesList || [])
        .filter(r => r.enabled)
        .map(r => ({ signatureId: r.action?.signatureId ?? r.signatureId }))
        .filter(r => r.signatureId != null);

    if (enabledRules.length === 0) return;

    const xPlatform = getXPlatform();
    const encryptedMail = await encryptEmail(userEmail);

    console.log(`[CardByte] 🔄 Prefetching ${enabledRules.length} rule signature(s)...`);

    await Promise.allSettled(
        enabledRules.map(r =>
            getOrFetchSignatureById(r.signatureId, encryptedMail, xPlatform)
                .catch(err => console.warn(`[CardByte] Prefetch error for signatureId=${r.signatureId}:`, err))
        )
    );

    console.log("[CardByte] Prefetch complete");
}


// =============================================================================
//  RECIPIENT HELPERS  (fixed: uses getAsync correctly, as in v1)
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
//  COMPOSE CONTEXT DETECTION  (unchanged from v1)
// =============================================================================

let _composeContext = null;

async function getOrDetectComposeContext() {
    if (_composeContext !== null) return _composeContext;

    _composeContext = await new Promise((resolve) => {
        const item = Office?.context?.mailbox?.item;
        if (!item) return resolve("compose");

        if (typeof item.getComposeTypeAsync === "function") {
            item.getComposeTypeAsync((result) => {
                if (result.status !== Office.AsyncResultStatus.Succeeded) return resolve("compose");
                const ct = result.value?.composeType || "";
                resolve(
                    ct === "reply" || ct === "forward" ||
                        ct === Office.MailboxEnums.ComposeType?.Reply ||
                        ct === Office.MailboxEnums.ComposeType?.Forward
                        ? "reply" : "compose"
                );
            });
        } else {
            resolve(item.conversationId ? "reply" : "compose");
        }
    });

    console.log(`[CardByte] Compose context: ${_composeContext}`);
    return _composeContext;
}


// =============================================================================
//  CONTEXT ASSEMBLY  ← NEW (ported from signature-rule-engine.js)
//
//  Builds the structured context object that the rule engine needs.
//  Assembles user profile (from rulesJson.userProfile if the API returns it,
//  or from Office mailbox) and mail metadata in one shot, with a hard timeout.
// =============================================================================

/**
 * Assemble the full { user, mail } context object.
 * Falls back to a minimal default context on timeout.
 *
 * @param {string[]} recipientEmails  - already resolved by getAllRecipientEmails()
 * @param {string}   composeContext   - "compose" | "reply"
 * @param {object}   rulesJson        - cached rules payload (may contain userProfile)
 * @returns {object}
 */
async function buildContext(recipientEmails, composeContext, rulesJson) {
    const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error("context_timeout")), CONTEXT_TIMEOUT_MS)
    );

    try {
        const mailbox = Office?.context?.mailbox;
        const userEmail = mailbox?.userProfile?.emailAddress ?? "";
        const orgDomain = userEmail.split("@")[1] ?? "";

        // The API may return a userProfile block alongside rulesJson.
        // If absent we fall back to Office mailbox data.
        const profile = rulesJson?.userProfile ?? {};

        const context = await Promise.race([
            Promise.resolve({
                user: {
                    email: userEmail,
                    name: profile.name ?? mailbox?.userProfile?.displayName ?? "",
                    department: profile.department ?? "",
                    role: profile.role ?? "",
                    location: profile.location ?? "",
                    phone: profile.phone ?? "",
                    domain: profile.domain ?? orgDomain,
                    customAttributes: profile.customAttributes ?? {},
                },
                mail: {
                    type: composeContext === "reply" ? "reply" : "new_compose",
                    recipientDomains: recipientEmails.map(e => e.split("@")[1]).filter(Boolean),
                    isExternal: recipientEmails.some(e => (e.split("@")[1] ?? "") !== orgDomain),
                    isReply: composeContext === "reply",
                    isForward: false,   // getComposeTypeAsync doesn't distinguish reply/forward
                },
            }),
            timeoutPromise,
        ]);

        return context;
    } catch (err) {
        console.warn("[CardByte] buildContext timed out or failed:", err.message);
        const email = Office?.context?.mailbox?.userProfile?.emailAddress ?? "";
        return {
            user: { email, domain: email.split("@")[1] ?? "" },
            mail: { type: "new_compose", recipientDomains: [], isExternal: false },
            _fallback: true,
        };
    }
}

/**
 * Flatten { user: { department: "Sales" } } → { "user.department": "Sales" }.
 * Array fields are stored under the key AND as "key[]" for array_contains ops.
 */
function flattenContext(obj, prefix = "", out = {}) {
    for (const key of Object.keys(obj)) {
        const val = obj[key];
        const fullKey = prefix ? `${prefix}.${key}` : key;
        if (Array.isArray(val)) {
            out[fullKey] = val;
            out[fullKey + "[]"] = val;   // enable array_contains lookup
        } else if (val !== null && typeof val === "object") {
            flattenContext(val, fullKey, out);
        } else {
            out[fullKey] = val;
        }
    }
    return out;
}


// =============================================================================
//  SIGNATURE RULE ENGINE  ← MERGED
//
//  Combines:
//  • Reference engine: expressive AND/OR condition trees, 10 leaf ops,
//    regex precompilation, field index, visibility resolution
//  • Actual engine: legacy tier matching (context × recipientType × ruleValue)
//    as a fallback when a rule has no `conditions` tree
// =============================================================================

class SignatureRuleEngine {
    /**
     * @param {object[]} rules    - from rulesJson.rulesList (enabled only)
     * @param {object}   defaults - { global: "sig_id", scoped: [...] }
     */
    constructor(rules, defaults) {
        if (!defaults?.global) {
            throw new Error("[CardByte] global default signature is not configured.");
        }

        this.defaults = defaults;

        // Sort by priority ascending; precompile; build index
        this.rules = rules
            .filter(r => r.enabled !== false)
            .sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99))
            .map(r => this._precompile(r));

        this._index = this._buildIndex(this.rules);
    }

    // ── Precompilation ──────────────────────────────────────────────────────

    /** Walk condition trees and compile regex patterns once at construction. */
    _precompile(rule) {
        if (!rule.conditions) return rule;
        const walk = (node) => {
            if (node.field && node.op === "regex" && typeof node.value === "string") {
                node._compiled = new RegExp(node.value, "i");
            }
            (node.conditions ?? node.groups ?? []).forEach(walk);
        };
        walk(rule.conditions);
        return rule;
    }

    // ── Index (for expressive-tree path only) ───────────────────────────────

    /** Build O(1) lookup index on three high-selectivity fields. */
    _buildIndex(rules) {
        const idx = { "user.department": {}, "user.domain": {}, "mail.type": {} };
        const unindexed = [];

        for (const rule of rules) {
            if (!rule.conditions) { unindexed.push(rule); continue; }
            let indexed = false;
            for (const field of Object.keys(idx)) {
                const val = this._findTopLevelEq(rule.conditions, field);
                if (val !== null) {
                    (idx[field][val] ??= []).push(rule);
                    indexed = true;
                }
            }
            if (!indexed) unindexed.push(rule);
        }

        return { byField: idx, unindexed };
    }

    _findTopLevelEq(node, field) {
        if (node.field === field && node.op === "eq") return String(node.value);
        for (const child of (node.conditions ?? node.groups ?? [])) {
            const found = this._findTopLevelEq(child, field);
            if (found !== null) return found;
        }
        return null;
    }

    _getCandidates(context) {
        const seen = new Set();
        const result = [];
        const add = (rule) => { if (!seen.has(rule.ruleId ?? rule.rule)) { seen.add(rule.ruleId ?? rule.rule); result.push(rule); } };

        const dept = context.user?.department;
        const domain = context.user?.domain;
        const mtype = context.mail?.type;

        (this._index.byField["user.department"][dept] ?? []).forEach(add);
        (this._index.byField["user.domain"][domain] ?? []).forEach(add);
        (this._index.byField["mail.type"][mtype] ?? []).forEach(add);
        this._index.unindexed.forEach(add);

        return result.sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99));
    }

    // ── Expressive condition tree evaluator ─────────────────────────────────

    _evaluate(node, flatCtx) {
        if (node.field) return this._evalLeaf(node, flatCtx);
        const children = node.conditions ?? node.groups ?? [];
        if (node.operator === "AND") return children.every(c => this._evaluate(c, flatCtx));
        if (node.operator === "OR") return children.some(c => this._evaluate(c, flatCtx));
        console.warn("[CardByte] Unknown operator:", node.operator);
        return false;
    }

    _evalLeaf({ field, op, value, _compiled }, flatCtx) {
        const actual = flatCtx[field];

        switch (op) {
            case "eq": return actual === value;
            case "neq": return actual !== value;
            case "in": return Array.isArray(value) && value.includes(actual);
            case "not_in": return Array.isArray(value) && !value.includes(actual);
            case "contains": return typeof actual === "string" &&
                actual.toLowerCase().includes(String(value).toLowerCase());
            case "not_contains": return typeof actual === "string" &&
                !actual.toLowerCase().includes(String(value).toLowerCase());
            case "starts_with": return typeof actual === "string" &&
                actual.toLowerCase().startsWith(String(value).toLowerCase());
            case "exists": return actual !== undefined && actual !== null && actual !== "";
            case "not_exists": return actual === undefined || actual === null || actual === "";
            case "regex": return (_compiled ?? new RegExp(value, "i")).test(String(actual ?? ""));
            case "array_contains":
                // Both the flat array ("mail.recipientDomains") and the "[]" alias are stored
                return Array.isArray(flatCtx[field + "[]"])
                    ? flatCtx[field + "[]"].includes(value)
                    : Array.isArray(actual) ? actual.includes(value) : false;
            default:
                console.warn("[CardByte] Unknown op:", op);
                return false;
        }
    }

    // ── Legacy tier matcher (for rules without a conditions tree) ───────────

    /**
     * Mirrors the selectBestRule / ruleMatchesEmails logic from v1 but
     * operates on a single rule against a pre-built context — called only
     * when rule.conditions is absent.
     */
    _matchLegacyRule(rule, context, flatCtx) {
        const composeContext = context.mail?.isReply ? "reply" : "compose";
        const recipientEmails = flatCtx["mail.recipientDomains[]"] ?? [];
        const userEmail = context.user?.email ?? "";
        const userDomain = context.user?.domain ?? "";

        // Context dimension
        const ctx = (rule.context || "all").toLowerCase();
        if (ctx !== "all" && ctx !== composeContext) return false;

        // RecipientType dimension
        const classified = this._classifyRecipients(recipientEmails, userDomain);
        const rt = (rule.recipientType || "all").toLowerCase();
        if (rt !== "all" && rt !== classified) return false;

        // Pattern filter
        const ruleValue = rule.ruleValue || [];
        const externalOnly = rt === "external"
            ? recipientEmails.filter(e => (e.split("@")[1] ?? "") !== userDomain)
            : null;

        return this._legacyRuleMatchesEmails(rule, recipientEmails, externalOnly);
    }

    _classifyRecipients(recipientEmails, userDomain) {
        if (!userDomain || recipientEmails.length === 0) return "all";
        for (const email of recipientEmails) {
            const d = email.split("@")[1]?.toLowerCase() ?? "";
            if (d !== userDomain) return "external";
        }
        return "internal";
    }

    _legacyEmailMatchesPattern(email, pattern) {
        if (!pattern?.trim()) return false;
        const p = pattern.trim().toLowerCase();
        if (p === "*") return true;
        if (!p.includes("@")) return email.endsWith("@" + p);
        return email === p;
    }

    _legacyRuleMatchesEmails(rule, emails, externalEmails = null) {
        const ruleValue = rule.ruleValue || [];

        if (externalEmails !== null) {
            if (externalEmails.length === 0) return false;
            return !externalEmails.some(email =>
                ruleValue.some(pattern => this._legacyEmailMatchesPattern(email, pattern))
            );
        }

        const ruleType = (rule.ruleType || "ANY").toUpperCase();
        if (ruleType === "ALL") {
            return ruleValue.every(p => emails.some(e => this._legacyEmailMatchesPattern(e, p)));
        }
        return emails.some(e => ruleValue.some(p => this._legacyEmailMatchesPattern(e, p)));
    }

    // ── Visibility ──────────────────────────────────────────────────────────

    /**
     * Resolve per-element show/hide rules within a signature template.
     * Returns "all" if no visibility rules are defined.
     *
     * @returns {"all" | { [elementClass]: boolean }}
     */
    _resolveVisibility(visibilityRules, flatCtx) {
        if (!visibilityRules?.length) return "all";
        return visibilityRules.reduce((acc, vr) => {
            acc[vr.element] = this._evaluate(vr.showIf, flatCtx);
            return acc;
        }, {});
    }

    // ── Result builder ──────────────────────────────────────────────────────

    _buildResult(action, flatCtx, resolvedBy, matchedRuleId = null) {
        return {
            signatureId: action.signatureId,
            visibleElements: this._resolveVisibility(action.visibilityRules ?? [], flatCtx),
            resolvedBy,
            matchedRuleId,
        };
    }

    // ── Default resolution ──────────────────────────────────────────────────

    _resolveScopedDefault(flatCtx) {
        for (const entry of (this.defaults.scoped ?? [])) {
            if (flatCtx[entry.field] === entry.value) {
                return this._buildResult(
                    { signatureId: entry.signatureId, visibilityRules: [] },
                    flatCtx,
                    "scoped_default"
                );
            }
        }
        return null;
    }

    _resolveGlobalDefault() {
        return {
            signatureId: this.defaults.global,
            visibleElements: "all",
            resolvedBy: "global_default",
            matchedRuleId: null,
        };
    }

    // ── Main entry point ────────────────────────────────────────────────────

    /**
     * Resolve which signature and visibility to apply for the given context.
     *
     * Resolution order:
     *   1. Expressive condition tree (if rule.conditions present)
     *   2. Legacy tier match (context × recipientType × ruleValue)
     *   3. Scoped default
     *   4. Global default
     *
     * @param {object} context - from buildContext()
     * @returns {{ signatureId, visibleElements, resolvedBy, matchedRuleId }}
     */
    resolve(context) {
        const flatCtx = flattenContext(context);

        // Tier 1 + 2: rule match
        for (const rule of this._getCandidates(context)) {
            let matched = false;

            if (rule.conditions) {
                // Expressive path — AND/OR tree with 10 ops
                matched = this._evaluate(rule.conditions, flatCtx);
            } else {
                // Legacy path — context × recipientType × ruleValue
                matched = this._matchLegacyRule(rule, context, flatCtx);
            }

            if (matched) {
                const action = rule.action ?? { signatureId: rule.signatureId, visibilityRules: [] };
                const result = this._buildResult(action, flatCtx, "rule", rule.ruleId ?? rule.rule);
                console.log(
                    `[CardByte] ✅ Rule matched: "${rule.rule || rule.ruleId}"`,
                    `| resolvedBy=${result.resolvedBy}`,
                    `| signatureId=${result.signatureId}`,
                    `| path=${rule.conditions ? "expressive" : "legacy"}`
                );
                return result;
            }
        }

        // Tier 3: scoped default
        const scoped = this._resolveScopedDefault(flatCtx);
        if (scoped) {
            console.log(`[CardByte] 📎 Scoped default: signatureId=${scoped.signatureId}`);
            return scoped;
        }

        // Tier 4: global default
        console.log(`[CardByte] 🌐 Global default: signatureId=${this.defaults.global}`);
        return this._resolveGlobalDefault();
    }
}


// =============================================================================
//  SIGNATURE RENDERER  ← NEW (ported from signature-rule-engine.js)
//
//  Applied AFTER HTML is fetched/decrypted — merges user data into placeholders
//  and hides visibility-false elements before injection.
// =============================================================================

/**
 * Merge user data into the signature HTML template.
 *
 * Template placeholders:  {{user.name}}, {{user.phone}}, {{mail.isExternal}}, etc.
 * Visibility:  elements with class `sig-{elementClass}` are hidden when
 *              visibleElements[elementClass] === false.
 *
 * @param {string}        html            - raw signature HTML (already AES-decrypted)
 * @param {object}        flatCtx         - flattened context object
 * @param {"all"|object}  visibleElements - from engine.resolve()
 * @returns {string}                      - ready-to-inject HTML
 */
function renderSignature(html, flatCtx, visibleElements) {
    if (!html) return "";

    // 1. Replace {{user.name}} etc.
    let rendered = html.replace(/\{\{([\w.]+)\}\}/g, (_, path) => {
        const val = flatCtx[path];
        return (val !== undefined && val !== null) ? String(val) : "";
    });

    // 2. Apply visibility rules (DOM manipulation in a sandboxed DOMParser)
    if (visibleElements !== "all" && typeof DOMParser !== "undefined") {
        try {
            const parser = new DOMParser();
            const doc = parser.parseFromString(rendered, "text/html");

            for (const [elementClass, isVisible] of Object.entries(visibleElements)) {
                if (!isVisible) {
                    doc.querySelectorAll(`.sig-${elementClass}`).forEach(el => {
                        el.style.display = "none";
                    });
                }
            }

            rendered = doc.body.innerHTML;
        } catch (err) {
            console.warn("[CardByte] renderSignature visibility pass failed:", err);
            // Return the placeholder-replaced HTML without visibility changes
        }
    }

    return rendered;
}


// =============================================================================
//  ANALYTICS / AUDIT LOG  ← NEW (ported from signature-rule-engine.js)
//
//  Fire-and-forget POST — never blocks signature injection.
// =============================================================================

function logResolution(context, result) {
    const payload = {
        userId: context.user?.email,
        mailType: context.mail?.type,
        isExternal: context.mail?.isExternal,
        signatureId: result.signatureId,
        resolvedBy: result.resolvedBy,
        matchedRuleId: result.matchedRuleId,
        timestamp: Date.now(),
    };

    fetch(`${BASE_URL}/signature-audit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        keepalive: true,
    }).catch(() => { });
}


// =============================================================================
//  SIGNATURE INJECTION  (updated: accepts visibleElements from engine)
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
        removeNotification(item);
        return false;
    }

    try {
        await bodySetSignatureAsync(item, "");
        await bodySetSelectedDataAsync(item, html);
        removeNotification(item);
        return true;
    } catch (err) {
        console.error("[CardByte] Heavy path insertion failed:", err);
        showNotification(item, "Your signature is large and could not be inserted. Please contact Admin.");
        return false;
    }
}


// =============================================================================
//  CORE SIGNATURE ORCHESTRATOR  (fallback path — primary renderer)
// =============================================================================

async function applySignatureCore(item, mailbox, opts = {}, isSendTime = false) {
    const { fetchIfMissing = false, skipTtl = false, skipSessionCheck = false, overrideHtml = null } = opts;
    const userEmail = mailbox?.userProfile?.emailAddress;

    let html = overrideHtml ?? getCachedSignature({ skipTtl, skipSessionCheck });

    if (!html && fetchIfMissing && userEmail) {
        let attempt = 0;
        while (attempt <= MAX_RETRIES) {
            try {
                if (attempt > 0) await new Promise(r => setTimeout(r, 1000 * attempt));
                const result = await fetchPrimarySignature(await encryptEmail(userEmail), getXPlatform());
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

    if (!html) {
        const stale = getCachedSignature({ skipTtl: true, skipSessionCheck: true });
        if (stale) { console.warn("[CardByte] Using stale cache as last resort"); html = stale; }
    }

    if (!html) {
        console.error("[CardByte] No signature available — aborting");
        showNotification(item, "Signature not available. Please contact Admin.");
        return;
    }

    await applySignatureWithFallback(item, html, isSendTime);
}


// =============================================================================
//  RECIPIENT-CHANGE HANDLER  (updated: uses engine + renderSignature)
// =============================================================================

/**
 * Called whenever the recipient list changes (native event or poll).
 * Resolves the best rule via SignatureRuleEngine, fetches the HTML (cache-first),
 * applies renderSignature() for visibility + placeholders, then injects.
 */
async function onRecipientsChanged(item) {
    const mailbox = Office?.context?.mailbox;
    const userEmail = mailbox?.userProfile?.emailAddress;

    const [rulesJson, recipientEmails, composeContext] = await Promise.all([
        ensureRulesCached(userEmail),
        getAllRecipientEmails(item),
        getOrDetectComposeContext(),
    ]);

    if (!rulesJson || recipientEmails.length === 0) return;

    const context = await buildContext(recipientEmails, composeContext, rulesJson);

    const defaults = rulesJson.defaults ?? { global: rulesJson.defaultSignatureId ?? "" };
    if (!defaults.global) {
        console.warn("[CardByte] No global default configured — cannot run engine");
        return;
    }

    const engine = new SignatureRuleEngine(
        (rulesJson.rulesList || []).filter(r => r.enabled !== false),
        defaults
    );

    const result = engine.resolve(context);
    const flatCtx = flattenContext(context);
    const xPlatform = getXPlatform();
    const encryptedMail = await encryptEmail(userEmail);

    const rawHtml = await getOrFetchSignatureById(result.signatureId, encryptedMail, xPlatform);
    if (!rawHtml) {
        console.warn("[CardByte] Rule signature fetch returned null — keeping current signature");
        return;
    }

    const renderedHtml = renderSignature(rawHtml, flatCtx, result.visibleElements);

    console.log("[CardByte] Injecting rule-matched signature");
    await applySignatureWithFallback(item, renderedHtml, false);

    logResolution(context, result);
}


// =============================================================================
//  RECIPIENT POLLING — OWA fallback
// =============================================================================

let _lastRecipientSnapshot = "";
let _recipientPollTimer = null;

function serializeRecipients(emails) { return [...emails].sort().join(","); }

async function pollRecipients() {
    const item = Office?.context?.mailbox?.item;
    if (!item) return;

    const emails = await getAllRecipientEmails(item);
    const snapshot = serializeRecipients(emails);

    if (snapshot === _lastRecipientSnapshot) return;
    _lastRecipientSnapshot = snapshot;

    console.log("[CardByte] 🔄 Recipient change detected via poll:", emails);
    if (emails.length === 0) return;

    await onRecipientsChanged(item);
}

function startRecipientPolling() {
    if (_recipientPollTimer) return;
    _recipientPollTimer = setInterval(pollRecipients, RECIPIENT_POLL_MS);
}

function stopRecipientPolling() {
    if (_recipientPollTimer) { clearInterval(_recipientPollTimer); _recipientPollTimer = null; }
}


// =============================================================================
//  NATIVE RecipientsChanged EVENT
// =============================================================================

let _recipientsHandlerRegistered = false;

function registerRecipientsChangedHandler() {
    const item = Office?.context?.mailbox?.item;

    if (!item) {
        setTimeout(registerRecipientsChangedHandler, 300);
        return;
    }

    if (_recipientsHandlerRegistered || isMobile()) return;

    if (typeof item.addHandlerAsync !== "function") {
        console.warn("[CardByte] addHandlerAsync not available");
        return;
    }

    item.addHandlerAsync(
        Office.EventType.RecipientsChanged,
        async () => {
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
    console.log("[CardByte] Office.onReady fired | platform:", detectPlatform());
    purgeStaleSigById();
    setTimeout(registerRecipientsChangedHandler, 500);
});


// =============================================================================
//  PUBLIC ENTRY POINTS
// =============================================================================

/**
 * applySignature — LaunchEvent handler (new compose / reply / forward)
 *
 * Resolution order at open time:
 *   1. Expressive rule engine with actual recipients (if To is pre-filled)
 *   2. Expressive rule engine with wildcard context-default rule
 *   3. Primary renderer fallback (last resort)
 *
 * After injecting, kicks off:
 *   - Background prefetch of all rule signatures
 *   - Recipient polling (OWA safety net)
 *   - Native RecipientsChanged handler
 */
const applySignature = async function (event = { completed: () => { } }) {
    _composeContext = null;
    _lastRecipientSnapshot = "";
    _recipientsHandlerRegistered = false;

    const mailbox = Office?.context?.mailbox;
    const item = mailbox?.item;

    try {
        if (!item) return;

        const userEmail = mailbox?.userProfile?.emailAddress;

        const [composeContext, rulesJson, emails] = await Promise.all([
            getOrDetectComposeContext(),
            ensureRulesCached(userEmail),
            getAllRecipientEmails(item),
        ]);

        const xPlatform = getXPlatform();
        const encryptedMail = await encryptEmail(userEmail);

        const defaults = rulesJson?.defaults ?? { global: rulesJson?.defaultSignatureId ?? "" };
        let engine = null;

        // Build engine only when we have rules + a configured global default
        if (rulesJson && defaults.global) {
            try {
                engine = new SignatureRuleEngine(
                    (rulesJson.rulesList || []).filter(r => r.enabled !== false),
                    defaults
                );
            } catch (err) {
                console.error("[CardByte] Engine construction failed:", err);
            }
        }

        let appliedViaRule = false;

        if (engine) {
            // ── Step 1: full rule match if To is pre-filled ─────────────────
            const recipientsForMatch = emails.length > 0 ? emails : [];
            if (recipientsForMatch.length > 0) {
                _lastRecipientSnapshot = serializeRecipients(recipientsForMatch);
            }

            const context = await buildContext(recipientsForMatch, composeContext, rulesJson);
            const result = engine.resolve(context);
            const flatCtx = flattenContext(context);

            const rawHtml = await getOrFetchSignatureById(result.signatureId, encryptedMail, xPlatform);
            if (rawHtml) {
                const renderedHtml = renderSignature(rawHtml, flatCtx, result.visibleElements);
                await applySignatureWithFallback(item, renderedHtml, false);
                appliedViaRule = true;
                console.log(`[CardByte] ✅ Opening sig: resolvedBy=${result.resolvedBy} | id=${result.signatureId}`);
                logResolution(context, result);
            }
        }

        // ── Step 3: primary renderer fallback ──────────────────────────────
        if (!appliedViaRule) {
            console.warn("[CardByte] No rule match at open — falling back to primary renderer");
            await applySignatureCore(item, mailbox, { fetchIfMissing: true }, false);
        }

        // ── Background work ─────────────────────────────────────────────────
        if (userEmail) {
            prefetchAllRuleSignatures(userEmail).catch(err =>
                console.warn("[CardByte] Background prefetch failed:", err)
            );
        }

        startRecipientPolling();
        registerRecipientsChangedHandler();

    } catch (err) {
        console.error("[CardByte] applySignature error:", err);
    } finally {
        event.completed();
    }
};

/**
 * onSendHandler — AppendOnSend / OnMessageSend
 */
const onSendHandler = async function (event = { completed: () => { } }) {
    const mailbox = Office?.context?.mailbox;
    const item = mailbox?.item;

    try {
        if (!item) return;
        stopRecipientPolling();
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
    console.log("[CardByte] Office.actions registered");
} else {
    console.log("[CardByte] Office.actions not available — Outlook 2016/2019");
}