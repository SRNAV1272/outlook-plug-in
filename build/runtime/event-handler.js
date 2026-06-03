"use strict";

// ─── Configuration ────────────────────────────────────────────────────────────

const CONFIG = {
    XHR_URL: "https://newqa-enterprise.cardbyte.ai/email-signature/html/outlook/get-active",
    XHR_TIMEOUT_MS: 6000,

    AES_KEY_B64: "fnItrY2YfozBqCC2B4XsfqHIvZku3kUOq3DFkbO64kk=",
    AES_IV_B64: "3YapeNfJDung7TXxeKXn4g==",

    CACHE_KEY: "cardbyte_sig_html",

    WRAP_TOP_PX: 40,
    WRAP_BOTTOM_PX: 40,

    SEND_HANDLER_TIMEOUT_MS: 2000,
    COMPOSE_HANDLER_TIMEOUT_MS: 10000,

    DIAG_ENABLED: false,

    CACHE_MAX_AGE_MS: 1000 * 60 * 60 * 6,   // 6 hours

    FETCH_MAX_RETRIES: 2,
    FETCH_RETRY_DELAY_MS: 1000,

    // ── Signature boundary tokens ──────────────────────────────────────────
    // Plain text nodes inside white-coloured <td> cells — survive Classic
    // Outlook's HTML round-trip AND OWA's sanitizer without being stripped.
    // Must match the tokens used in event-handler-classic.js so both files
    // share one stripping strategy.
    CB_SIG_START: "__CBSIG_START_7F2C9D4E__",
    CB_SIG_END:   "__CBSIG_END_7F2C9D4E__"
};

// ─── Diagnostic log ───────────────────────────────────────────────────────────

const _diag = (() => {
    const buf = [];

    function push(level, msg) {
        buf.push("[" + new Date().toISOString() + "] [" + level + "] " + msg);
        try { console.log("[CardByte]", level, msg); } catch (_) { }
    }

    function buildHtmlBlock() {
        const escaped = buf.join("\n")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");
        return "<div style='"
            + "margin:0 0 16px 0;padding:12px 16px;"
            + "border:2px solid #d9534f;border-radius:4px;"
            + "background-color:#fff3cd;"
            + "font-family:Consolas,Courier New,monospace;"
            + "font-size:11px;color:#333;white-space:pre-wrap;'>"
            + "<strong style='color:#d9534f;font-size:13px;'>"
            + "[CardByte DIAGNOSTIC LOG — DELETE BEFORE SENDING]"
            + "</strong><br/><br/>"
            + escaped
            + "</div>";
    }

    return {
        info:  (m) => push("INFO",  m),
        warn:  (m) => push("WARN",  m),
        error: (m) => push("ERROR", m),
        html:  buildHtmlBlock
    };
})();

// ─── Platform detection ───────────────────────────────────────────────────────

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

    if (platform === "mac") return "mac";

    if (
        (platform === "" || platform === "desktop") &&
        (ua.includes("macintosh") || ua.includes("mac os x")) &&
        !ua.includes("iphone") &&
        !ua.includes("ipad")
    ) return "mac";

    if (platform === "officeonline" || platform === "web" || platform === "") return "owa";
    return "desktop";
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function byteKB(str) {
    return new Blob([str]).size / 1024;
}

function base64ToArrayBuffer(base64) {
    let b64 = base64.replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64.length % 4;
    if (pad) b64 += "=".repeat(4 - pad);
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
}

function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
}

// ─── Encryption (Web Crypto AES-CBC) ─────────────────────────────────────────

async function encryptEmail(email) {
    if (!email || !email.trim()) { _diag.warn("encryptEmail: empty email"); return ""; }
    try {
        const keyBuffer = base64ToArrayBuffer(CONFIG.AES_KEY_B64);
        const ivBuffer  = base64ToArrayBuffer(CONFIG.AES_IV_B64);
        const key = await crypto.subtle.importKey(
            "raw", keyBuffer, { name: "AES-CBC" }, false, ["encrypt"]
        );
        const encrypted = await crypto.subtle.encrypt(
            { name: "AES-CBC", iv: ivBuffer },
            key,
            new TextEncoder().encode(email)
        );
        return arrayBufferToBase64(encrypted);
    } catch (e) {
        _diag.error("encryptEmail threw: " + e.message);
        return "";
    }
}

async function decryptResponse(cipherB64) {
    if (!cipherB64) { _diag.warn("decryptResponse: empty input"); return ""; }
    try {
        const keyBuffer = base64ToArrayBuffer(CONFIG.AES_KEY_B64);
        const ivBuffer  = base64ToArrayBuffer(CONFIG.AES_IV_B64);
        const key = await crypto.subtle.importKey(
            "raw", keyBuffer, { name: "AES-CBC" }, false, ["decrypt"]
        );
        const encBuffer = base64ToArrayBuffer(cipherB64);
        if (encBuffer.byteLength % 16 !== 0) {
            _diag.error("decryptResponse: invalid ciphertext length " + encBuffer.byteLength);
            return "";
        }
        const decrypted = await crypto.subtle.decrypt(
            { name: "AES-CBC", iv: ivBuffer },
            key,
            encBuffer
        );
        return new TextDecoder().decode(decrypted);
    } catch (e) {
        _diag.error("decryptResponse threw: " + e.message);
        return "";
    }
}

// ─── Integrity hash (Web Crypto SHA-256) ─────────────────────────────────────

async function sha256Hex(str) {
    const data = new TextEncoder().encode(str);
    const hashBuf = await crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(hashBuf))
        .map(b => b.toString(16).padStart(2, "0"))
        .join("");
}

// ─── Storage abstraction ──────────────────────────────────────────────────────
//
// Prefers OfficeRuntime.storage (shared across compose + send iframes in
// Classic Outlook / New Outlook). Falls back to localStorage for OWA, where
// OfficeRuntime is undefined — OWA runs both compose and onSend in the same
// origin so localStorage IS shared between the two event iframe contexts.
//
// The abstraction exposes three async methods that mirror the OfficeRuntime
// Promise API: storageGet(key), storageSet(key, val), storageRemove(key).

const _storage = (() => {
    function hasOfficeRuntime() {
        try { return typeof OfficeRuntime !== "undefined" && !!OfficeRuntime.storage; }
        catch (_) { return false; }
    }

    return {
        async get(key) {
            if (hasOfficeRuntime()) {
                return OfficeRuntime.storage.getItem(key);
            }
            try { return localStorage.getItem(key); } catch (_) { return null; }
        },
        async set(key, val) {
            if (hasOfficeRuntime()) {
                return OfficeRuntime.storage.setItem(key, val);
            }
            try { localStorage.setItem(key, val); } catch (_) { }
        },
        async remove(key) {
            if (hasOfficeRuntime()) {
                return OfficeRuntime.storage.removeItem(key);
            }
            try { localStorage.removeItem(key); } catch (_) { }
        }
    };
})();

// ─── Cache ────────────────────────────────────────────────────────────────────
//
//   - Memory cache layer (per-iframe, fast path)
//   - Persistent layer via _storage (OfficeRuntime or localStorage)
//   - SHA-256 integrity check on every read
//   - 6-hour TTL

const _memCache = {};

async function cacheGet() {
    // Fast path: in-memory
    const mem = _memCache[CONFIG.CACHE_KEY];
    if (mem?.html && mem?.hash) {
        const memHash = await sha256Hex(mem.html);
        if (memHash === mem.hash) {
            _diag.info("cacheGet: memory hit");
            return mem.html;
        }
        _diag.warn("cacheGet: memory hash mismatch — falling through");
    }

    // Persistent path
    try {
        const raw = await _storage.get(CONFIG.CACHE_KEY);
        if (!raw) { _diag.warn("cacheGet: storage miss"); return null; }

        let entry;
        try { entry = typeof raw === "string" ? JSON.parse(raw) : raw; }
        catch (_) { _diag.error("cacheGet: JSON parse failed"); return null; }

        if (!entry?.html || !entry?.hash) {
            _diag.warn("cacheGet: invalid entry shape"); return null;
        }
        if (Date.now() - entry.ts > CONFIG.CACHE_MAX_AGE_MS) {
            _diag.warn("cacheGet: entry expired"); return null;
        }
        const storedHash = await sha256Hex(entry.html);
        if (storedHash !== entry.hash) {
            _diag.error("cacheGet: integrity check failed"); return null;
        }

        _memCache[CONFIG.CACHE_KEY] = entry;
        _diag.info("cacheGet: storage hit");
        return entry.html;
    } catch (e) {
        _diag.warn("cacheGet threw: " + e.message);
        return null;
    }
}

async function cacheSet(html) {
    try {
        const entry = { html, ts: Date.now(), hash: await sha256Hex(html) };
        _memCache[CONFIG.CACHE_KEY] = entry;
        await _storage.set(CONFIG.CACHE_KEY, JSON.stringify(entry));
        _diag.info("cacheSet: saved");
        return true;
    } catch (e) {
        _diag.warn("cacheSet threw: " + e.message);
        return false;
    }
}

async function cacheClear() {
    delete _memCache[CONFIG.CACHE_KEY];
    try {
        await _storage.remove(CONFIG.CACHE_KEY);
        _diag.info("cacheClear: done");
    } catch (e) {
        _diag.warn("cacheClear threw: " + e.message);
    }
}

// ─── Signature wrapping ───────────────────────────────────────────────────────
//
// Wraps the raw backend HTML in a sentinel table that carries CB_SIG_START and
// CB_SIG_END as plain text inside visually-hidden cells.
//
// Sentinel cell style: width:0 + overflow:hidden + max-height:0 ensures the
// token text is fully suppressed even on Trident/Word, which ignores font-size:1px
// and color:#ffffff alone. The token still survives the HTML round-trip as a
// text node and is detectable with indexOf.

const SENTINEL_TD_STYLE =
    "font-size:0px;color:#ffffff;line-height:0;max-height:0;" +
    "overflow:hidden;mso-hide:all;display:none;width:0;";

function _wrapSignature(html) {
    return (
        "<table role=\"presentation\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\" style=\"border:0;border-collapse:collapse;\">"
        + "<tr>"
        + "<td style=\"" + SENTINEL_TD_STYLE + "\">"
        + CONFIG.CB_SIG_START
        + "</td>"
        + "</tr>"
        + "<tr>"
        + "<td style=\"padding-top:" + CONFIG.WRAP_TOP_PX + "px;"
        + "padding-bottom:" + CONFIG.WRAP_BOTTOM_PX + "px;\">"
        + html
        + "</td>"
        + "</tr>"
        + "<tr>"
        + "<td style=\"" + SENTINEL_TD_STYLE + "\">"
        + CONFIG.CB_SIG_END
        + "</td>"
        + "</tr>"
        + "</table>"
    );
}

// ─── Signature stripping ──────────────────────────────────────────────────────
//
// Removes ALL CardByte and native Outlook signature artifacts from a body HTML.
//
// STRATEGY — token-position walk instead of regex or DOMParser:
//   Classic Outlook's Trident engine rewrites table nesting unpredictably, so
//   we cannot rely on a fixed tag structure around the tokens. Instead:
//
//   1. Find CB_SIG_START with indexOf.
//   2. Walk BACKWARDS with lastIndexOf("<table") to find the outermost table
//      that encloses the token — the wrapper _wrapSignature produced.
//   3. Find CB_SIG_END with indexOf.
//   4. Walk FORWARDS with indexOf("</table>") to close the block.
//   5. Excise [outerTableOpen … closingTag] from the string.
//   6. Repeat until no more tokens remain (handles double-insert edge case).

function stripSignatures(html) {
    if (!html) { _diag.warn("stripSignatures: empty input"); return ""; }

    _diag.info("=== stripSignatures START | inputLen=" + html.length + " ===");

    // ── 1. Native Outlook div-based signatures ────────────────────────────────
    let before = html.length;
    html = html.replace(/<div[^>]*\bid=["']Signature["'][^>]*>[\s\S]*?<\/div>/gi, "");
    if (html.length !== before)
        _diag.info("stripSignatures: removed div#Signature (" + (before - html.length) + " chars)");

    before = html.length;
    html = html.replace(/<div[^>]*\bid=["']appendonsend["'][^>]*>[\s\S]*?<\/div>/gi, "");
    if (html.length !== before)
        _diag.info("stripSignatures: removed div#appendonsend (" + (before - html.length) + " chars)");

    // ── 2. Legacy plain-text markers ─────────────────────────────────────────
    before = html.length;
    html = html.replace(/__CARDBYTE_SIG_START_V1__[\s\S]*?__CARDBYTE_SIG_END_V1__/gi, "");
    if (html.length !== before)
        _diag.info("stripSignatures: removed V1 markers (" + (before - html.length) + " chars)");

    // ── 3. CB_SIG token-walk (current format) ─────────────────────────────────
    let iterations = 0;
    const MAX_ITER = 10;

    while (iterations++ < MAX_ITER) {
        const startIdx = html.indexOf(CONFIG.CB_SIG_START);
        const endIdx   = html.indexOf(CONFIG.CB_SIG_END);

        if (startIdx === -1 || endIdx === -1) {
            if (startIdx !== -1 || endIdx !== -1) {
                _diag.warn("stripSignatures: orphan token detected — trimming");
                html = html
                    .replace(CONFIG.CB_SIG_START, "")
                    .replace(CONFIG.CB_SIG_END,   "");
            }
            break;
        }

        const tableOpen  = html.lastIndexOf("<table", startIdx);
        const tableClose = html.indexOf("</table>", endIdx);

        if (tableOpen !== -1 && tableClose !== -1) {
            const removed = tableClose + "</table>".length - tableOpen;
            _diag.info("stripSignatures: removing CB_SIG block"
                + " | tableOpen=" + tableOpen
                + " | tableClose=" + tableClose
                + " | removed=" + removed + " chars");
            html = html.substring(0, tableOpen)
                 + html.substring(tableClose + "</table>".length);
        } else {
            _diag.warn("stripSignatures: table boundary not found"
                + " | tableOpen=" + tableOpen
                + " | tableClose=" + tableClose
                + " — falling back to token-span cut");
            html = html.substring(0, startIdx)
                 + html.substring(endIdx + CONFIG.CB_SIG_END.length);
        }
    }

    if (iterations >= MAX_ITER)
        _diag.error("stripSignatures: MAX_ITER reached — possible infinite loop, bailing");

    // ── 4. Cosmetic clean-up ──────────────────────────────────────────────────
    html = html.replace(/(?:\s*<br\s*\/?>)+\s*$/gi, "");
    html = html.replace(/<div>\s*<\/div>/gi, "");
    html = html.replace(/<p>\s*<\/p>/gi, "");

    _diag.info("=== stripSignatures END | outputLen=" + html.length + " ===");
    return html;
}

// ─── Body helpers ─────────────────────────────────────────────────────────────

function _getBody(item) {
    return new Promise((resolve, reject) => {
        if (typeof item.body.getAsync !== "function") {
            reject(new Error("getAsync unavailable")); return;
        }
        item.body.getAsync(Office.CoercionType.Html, (r) => {
            if (r.status === Office.AsyncResultStatus.Succeeded)
                resolve(r.value || "");
            else
                reject(r.error);
        });
    });
}

function _setBody(item, html) {
    return new Promise((resolve, reject) => {
        if (typeof item.body.setAsync !== "function") {
            reject(new Error("setAsync unavailable")); return;
        }
        item.body.setAsync(html, { coercionType: Office.CoercionType.Html }, (r) => {
            if (r.status === Office.AsyncResultStatus.Succeeded)
                resolve();
            else
                reject(r.error);
        });
    });
}

function _setSignatureSlot(item, html) {
    return new Promise((resolve, reject) => {
        item.body.setSignatureAsync(
            html,
            { coercionType: Office.CoercionType.Html },
            (r) => {
                if (r.status === Office.AsyncResultStatus.Succeeded) resolve();
                else reject(r.error);
            }
        );
    });
}

// _moveCursorToTop — after setAsync the insertion point ends up at the bottom
// of the compose area on some OWA / New Outlook builds, so the user would
// start typing below the signature. A zero-length prependAsync nudges Outlook
// into placing the cursor at the very top of the compose area.
function _moveCursorToTop(item) {
    return new Promise((resolve) => {
        if (typeof item.body?.prependAsync !== "function") { resolve(); return; }
        item.body.prependAsync("", { coercionType: Office.CoercionType.Html }, () => resolve());
    });
}

// ─── Core write path ──────────────────────────────────────────────────────────
//
// writeSignature(item, rawHtml, forceReplace)
//
// rawHtml is always the UNWRAPPED backend HTML (no CB_SIG tokens).
//
// PATH A — setSignatureAsync available AND sig fits within its size limit.
//   OWA's setAsync silently strips base64 images when the combined body
//   exceeds ~200 KB.  setSignatureAsync uses Outlook's own image-safe
//   rendering pipeline and has no such restriction — but Microsoft imposes
//   a hard 131 072-byte (128 KB) limit on the data argument.
//   Sequence:
//     1. Read body → split → dedup → strip compose area.
//     2. setAsync(cleanCompose + chainArea)  — body without sig; small payload,
//        chain images fully preserved.
//     3. setSignatureAsync(rawHtml)          — sig appended by Outlook, images intact.
//     4. prependAsync("") to snap cursor.
//
// PATH B — setSignatureAsync unavailable (Classic Outlook Trident) OR sig
//   exceeds the 128 KB setSignatureAsync limit (fallback for OWA/New Outlook).
//   Wraps rawHtml with CB_SIG sentinel tokens so future runs can strip it,
//   then writes cleanCompose + wrappedSig + chainArea in ONE setAsync call.
//   Sequence:
//     1. Read body → split → dedup → strip compose area.
//     2. setAsync(cleanCompose + _wrapSignature(rawHtml) + chainArea).
//     3. Verify CB_SIG tokens survived.
//     4. prependAsync("") to snap cursor.

// Microsoft's documented setSignatureAsync data-size limit (bytes).
const SETSIG_MAX_BYTES = 131072; // 128 KB

async function writeSignature(item, rawHtml, forceReplace = false) {
    const rawBytes = new Blob([rawHtml]).size;
    const htmlKB   = rawBytes / 1024;

    const canUseSigSlot =
        typeof item.body.setSignatureAsync === "function" &&
        rawBytes <= SETSIG_MAX_BYTES;

    _diag.info("=== writeSignature START | " + htmlKB.toFixed(1) + " KB"
        + " | setSignatureAsync=" + (typeof item.body.setSignatureAsync === "function")
        + " | rawBytes=" + rawBytes
        + " | canUseSigSlot=" + canUseSigSlot
        + " | forceReplace=" + forceReplace + " ===");

    // ── Shared prep (used by both paths) ──────────────────────────────────────
    let existingBody;
    try {
        existingBody = await _getBody(item);
        _diag.info("step_readBody: length=" + existingBody.length
            + " | CB_SIG_START=" + (existingBody.indexOf(CONFIG.CB_SIG_START) !== -1)
            + " | CB_SIG_END="   + (existingBody.indexOf(CONFIG.CB_SIG_END)   !== -1));
    } catch (e) {
        _diag.error("step_readBody failed: " + (e?.message || JSON.stringify(e)));
        return false;
    }

    const { cleanCompose, chainArea, skip } = _prepBody(existingBody, forceReplace);
    if (skip) {
        _diag.info("=== writeSignature END | success=true (skipped) ===");
        return true;
    }

    // ── PATH A — two-call split ────────────────────────────────────────────────
    if (canUseSigSlot) {
        _diag.info("PATH A: setAsync body-only + setSignatureAsync sig");

        // Step 1 — Write body WITHOUT sig (small payload, preserves chain images)
        const bodyOnly   = cleanCompose + chainArea;
        const bodyOnlyKB = byteKB(bodyOnly).toFixed(1);
        _diag.info("PATH A step_setBody: " + bodyOnlyKB + " KB");
        try {
            await _setBody(item, bodyOnly);
            _diag.info("PATH A step_setBody: OK");
        } catch (e) {
            _diag.error("PATH A step_setBody failed: " + (e?.message || JSON.stringify(e)));
            return false;
        }

        // Step 2 — Append sig via Outlook's image-safe pipeline
        _diag.info("PATH A step_setSig: " + htmlKB.toFixed(1) + " KB");
        try {
            await _setSignatureSlot(item, rawHtml);
            _diag.info("PATH A step_setSig: OK");
        } catch (e) {
            _diag.error("PATH A step_setSig failed: " + (e?.message || JSON.stringify(e)));
            return false;
        }

        // Step 3 — Snap cursor to top
        await _moveCursorToTop(item);
        _diag.info("PATH A step_cursor: snapped | === writeSignature END | success=true (PATH A) ===");
        return true;
    }

    // ── PATH B — single setAsync with CB_SIG tokens ────────────────────────────
    // Covers: Classic Outlook (no setSignatureAsync) AND OWA/New Outlook when
    // sig exceeds the 128 KB setSignatureAsync limit.
    if (typeof item.body.setSignatureAsync === "function") {
        _diag.info("PATH B: sig too large for setSignatureAsync ("
            + htmlKB.toFixed(1) + " KB > " + (SETSIG_MAX_BYTES / 1024).toFixed(0) + " KB limit)"
            + " — falling back to single setAsync with CB_SIG tokens");
    } else {
        _diag.info("PATH B: setSignatureAsync unavailable — single setAsync with CB_SIG tokens");
    }

    // Wrap sig with CB_SIG sentinel tokens (needed for dedup + future strip)
    const wrappedSig = _wrapSignature(rawHtml);

    const combined   = cleanCompose + wrappedSig + chainArea;
    const combinedKB = byteKB(combined).toFixed(1);
    _diag.info("PATH B step_write: " + combinedKB + " KB");

    try {
        await _setBody(item, combined);
        _diag.info("PATH B step_write: setBody OK");
    } catch (e) {
        _diag.error("PATH B step_write failed: " + (e?.message || JSON.stringify(e)));
        return false;
    }

    // Snap cursor to top
    await _moveCursorToTop(item);
    _diag.info("PATH B step_cursor: snapped");

    // Verify tokens survived the write
    try {
        const bodyAfter = await _getBody(item);
        const startOk   = bodyAfter.indexOf(CONFIG.CB_SIG_START) !== -1;
        const endOk     = bodyAfter.indexOf(CONFIG.CB_SIG_END)   !== -1;
        _diag.info("PATH B step_verify: bodyLen=" + bodyAfter.length
            + " | CB_SIG_START=" + startOk
            + " | CB_SIG_END="   + endOk);
        _diag.info("=== writeSignature END | success=" + (startOk && endOk) + " (PATH B) ===");
        return startOk && endOk;
    } catch (e) {
        _diag.warn("PATH B step_verify: read failed — assuming success");
        return true;
    }
}

// ─── Diagnostics flush ────────────────────────────────────────────────────────

async function writeDiagnostics(item) {
    if (!CONFIG.DIAG_ENABLED) return;
    if (typeof item.body.prependAsync !== "function") {
        _diag.warn("writeDiagnostics: prependAsync unavailable — skipped");
        return;
    }
    await new Promise((resolve) =>
        item.body.prependAsync(_diag.html(), { coercionType: Office.CoercionType.Html }, resolve)
    );
}

// ─── Backend fetch ────────────────────────────────────────────────────────────

function _resolveContext() {
    let email    = "";
    let platform = "WINDOWS";
    try {
        email = (Office.context.mailbox.userProfile.emailAddress || "").trim();
        const p = Office.context.diagnostics.platform;
        if (p === Office.PlatformType.Mac || p === "Mac") platform = "MAC";
    } catch (e) {
        throw new Error("resolveContext: " + e.message);
    }
    if (!email) throw new Error("resolveContext: no email address");
    return { email, platform };
}

// fetchSignature wraps the XHR in a Promise so the caller can await it.
// Retry logic (up to FETCH_MAX_RETRIES) is handled in applySignatureCore.
function fetchSignature() {
    return new Promise(async (resolve, reject) => {
        let ctx;
        try { ctx = _resolveContext(); }
        catch (e) { _diag.error(e.message); reject(new Error("context-error")); return; }

        _diag.info("fetchSignature: email=" + ctx.email + " | platform=" + ctx.platform);

        const encrypted = await encryptEmail(ctx.email);
        if (!encrypted) { reject(new Error("encrypt-failed")); return; }

        const xhr = new XMLHttpRequest();
        xhr.open("GET", CONFIG.XHR_URL, true);
        xhr.timeout = CONFIG.XHR_TIMEOUT_MS;
        xhr.setRequestHeader("username", encrypted);
        xhr.setRequestHeader("X-Platform", ctx.platform);

        xhr.onreadystatechange = async function () {
            if (xhr.readyState !== 4) return;
            _diag.info("fetchSignature: XHR status=" + xhr.status
                + " | responseLen=" + (xhr.responseText || "").length);

            if (xhr.status >= 200 && xhr.status < 300) {
                const plaintext = await decryptResponse(xhr.responseText);
                if (!plaintext) { reject(new Error("decrypt-failed")); return; }

                let parsed;
                try { parsed = JSON.parse(plaintext); }
                catch (e) { reject(new Error("parse-error")); return; }

                const html = parsed?.html;
                if (!html) { reject(new Error("missing-html")); return; }

                _diag.info("fetchSignature: success | htmlLen=" + html.length);
                resolve(html);
            } else {
                _diag.warn("fetchSignature: HTTP " + xhr.status);
                reject(new Error("http-" + xhr.status));
            }
        };

        xhr.ontimeout = () => {
            _diag.warn("fetchSignature: timed out after " + CONFIG.XHR_TIMEOUT_MS + "ms");
            reject(new Error("timeout"));
        };
        xhr.onerror = () => {
            _diag.error("fetchSignature: onerror — CORS / network block?");
            reject(new Error("network-error"));
        };

        xhr.send();
        _diag.info("fetchSignature: xhr.send()");
    });
}

// ─── Apply signature flow ─────────────────────────────────────────────────────
//
//   1. Fetch fresh from backend (with retries).
//   2. Cache raw HTML, then write (writeSignature wraps for PATH B internally).
//   3. On backend failure, fall back to cache.
//   4. On both failures, use identity fallback.
//
// Cache stores RAW (unwrapped) HTML so both PATH A (setSignatureAsync) and
// PATH B (single-setAsync with CB_SIG tokens) get the correct input.
//
// forceReplace semantics:
//   applySignature (onNewMessageCompose)  → forceReplace=false  (dedup guard on)
//   onSendHandler                         → forceReplace=true   (always refresh)
//   onFromChangedHandler                  → forceReplace=true   (sender changed)

async function applySignatureCore(item, guardedEvent, forceReplace = false) {
    _diag.info("applySignatureCore | forceReplace=" + forceReplace);

    let rawHtml = null;

    // ── 1. Fetch from backend with retries ────────────────────────────────────
    for (let attempt = 0; attempt <= CONFIG.FETCH_MAX_RETRIES; attempt++) {
        if (attempt > 0) {
            _diag.warn("applySignatureCore: retry " + attempt + "/" + CONFIG.FETCH_MAX_RETRIES);
            await new Promise(r => setTimeout(r, CONFIG.FETCH_RETRY_DELAY_MS * attempt));
        }
        try {
            rawHtml = await fetchSignature();
            _diag.info("applySignatureCore: fresh fetch OK | htmlLen=" + rawHtml.length);
            break;
        } catch (e) {
            _diag.warn("applySignatureCore: fetch attempt " + (attempt + 1) + " failed: " + e.message);
        }
    }

    // ── 2. Fetch succeeded — cache raw HTML and write ─────────────────────────
    if (rawHtml) {
        await cacheSet(rawHtml);
        const ok = await writeSignature(item, rawHtml, forceReplace);
        if (!ok) _diag.warn("applySignatureCore: writeSignature (fresh) failed");
        await writeDiagnostics(item);
        guardedEvent.completed();
        return;
    }

    // ── 3. Backend failed — try cache ─────────────────────────────────────────
    _diag.warn("applySignatureCore: all fetch attempts failed — trying cache");
    const cachedHtml = await cacheGet();

    if (cachedHtml) {
        _diag.info("applySignatureCore: cache hit | len=" + cachedHtml.length);
        const ok = await writeSignature(item, cachedHtml, forceReplace);
        if (!ok) _diag.warn("applySignatureCore: writeSignature (cached) failed");
        await writeDiagnostics(item);
        guardedEvent.completed();
        return;
    }

    // ── 4. Cache miss too — identity fallback ─────────────────────────────────
    _diag.warn("applySignatureCore: backend miss + cache miss — using identity fallback");

    let userProfile = {};
    try { userProfile = Office.context.mailbox.userProfile || {}; } catch (_) { }

    // Fallback is plain HTML — writeSignature wraps it for the correct path
    const fallbackHtml = `
        <table cellpadding="0" cellspacing="0" border="0" width="400">
          <tr>
            <td style="font-family:Arial,sans-serif;font-size:12px;">
              <strong>${userProfile.displayName || ""}</strong><br/>
              ${userProfile.emailAddress || ""}<br/>
              <span style="color:#999;">Sent via CardByte</span>
            </td>
          </tr>
        </table>
    `;

    const ok = await writeSignature(item, fallbackHtml, forceReplace);
    if (!ok) _diag.warn("applySignatureCore: writeSignature (fallback) failed");
    await writeDiagnostics(item);
    guardedEvent.completed();
}

// ─── Guarded event wrapper ────────────────────────────────────────────────────

function makeGuardedEvent(event, timeoutMs, opts = {}) {
    let done = false;
    const timer = setTimeout(() => {
        if (done) return;
        _diag.warn("makeGuardedEvent: timeout (" + timeoutMs + "ms) — forcing complete");
        complete();
    }, timeoutMs);

    function complete(completionOpts) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try {
            completionOpts ? event.completed(completionOpts) : event.completed();
        } catch (e) {
            _diag.error("event.completed threw: " + e.message);
        }
    }

    return { completed: complete };
}

// ─── Office item helper ───────────────────────────────────────────────────────

function _safeGetItem() {
    try {
        return Office?.context?.mailbox?.item ?? null;
    } catch (_) {
        return null;
    }
}

// ─── Event handlers ───────────────────────────────────────────────────────────

/**
 * applySignature — fires on OnNewMessageCompose / OnNewAppointmentOrganizer.
 * forceReplace=false: respects dedup guard so a signature already in the
 * compose area (e.g. from a previous draft open) is not duplicated.
 */
async function applySignature(event) {
    _diag.info("=== applySignature START ===");
    const guarded = makeGuardedEvent(
        event || { completed: () => {} },
        CONFIG.COMPOSE_HANDLER_TIMEOUT_MS
    );
    const item = _safeGetItem();
    if (!item) {
        _diag.error("applySignature: no mailbox item");
        guarded.completed();
        return;
    }
    await applySignatureCore(item, guarded, false);
}

/**
 * onSendHandler — fires immediately before the message is sent.
 * forceReplace=true: unconditionally replaces any stale / native signature
 * that Outlook may have re-injected between compose and send.
 *
 * Uses OfficeRuntime.storage (shared across iframes) to read the cached
 * wrapped signature without needing to hit the network on send.
 */
async function onSendHandler(event) {
    _diag.info("=== onSendHandler START ===");
    const guarded = makeGuardedEvent(
        event || { completed: () => {} },
        CONFIG.SEND_HANDLER_TIMEOUT_MS
    );
    const item = _safeGetItem();
    if (!item) {
        _diag.warn("onSendHandler: no mailbox item — allowing send");
        guarded.completed({ allowEvent: true });
        return;
    }

    const cachedHtml = await cacheGet();

    if (!cachedHtml) {
        _diag.info("onSendHandler: no cached signature — passing through");
        await writeDiagnostics(item);
        guarded.completed({ allowEvent: true });
        return;
    }

    _diag.info("onSendHandler: writing cached signature ("
        + cachedHtml.length + " chars) | forceReplace=true");

    // cachedHtml is already _wrapSignature()'d — write directly.
    const ok = await writeSignature(item, cachedHtml, true /* forceReplace */);
    if (!ok) _diag.warn("onSendHandler: writeSignature failed");

    await writeDiagnostics(item);
    guarded.completed({ allowEvent: true });
}

/**
 * onFromChangedHandler — fires when the sender address changes.
 * Clears the cache so the new sender's signature is fetched fresh,
 * then writes it with forceReplace=true to replace the previous one.
 */
async function onFromChangedHandler(event) {
    _diag.info("=== onFromChangedHandler START ===");
    const guarded = makeGuardedEvent(
        event || { completed: () => {} },
        CONFIG.COMPOSE_HANDLER_TIMEOUT_MS
    );
    const item = _safeGetItem();
    if (!item) { guarded.completed(); return; }

    await cacheClear();
    await applySignatureCore(item, guarded, true /* forceReplace */);
}

// ─── Handler registration ─────────────────────────────────────────────────────

Office.onReady(() => {
    _diag.info("Office.onReady fired | platform=" + detectPlatform());

    if (typeof Office === "undefined" || !Office.actions) {
        _diag.error("registerHandlers: Office.actions unavailable — registration skipped");
        return;
    }
    try {
        Office.actions.associate("applySignature",        applySignature);
        Office.actions.associate("onSendHandler",         onSendHandler);
        Office.actions.associate("onFromChangedHandler",  onFromChangedHandler);
        _diag.info("registerHandlers: all handlers registered");
    } catch (e) {
        _diag.error("registerHandlers: Office.actions.associate threw: " + e.message);
    }
});