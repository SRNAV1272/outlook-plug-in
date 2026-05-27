/**
 * CardByte Signature Manager — event-handler-classic.js
 *
 * ⚠️  THIS FILE IS FOR CLASSIC OUTLOOK ON WINDOWS (JS-only runtime) ONLY.
 *
 * Classic Outlook's LaunchEvent JS runtime does NOT support:
 *   ✗ async / await
 *   ✗ class syntax
 *   ✗ crypto.subtle
 *   ✗ DOM / Canvas API
 *   ✓ localStorage  ← available and shared with the WebView runtime
 *
 * CACHE STRATEGY (SharedRuntime-aware):
 *   The manifest now declares a SharedRuntime pointing to taskpane.html.
 *   On non-Classic platforms (OWA, New Outlook, Mac) the taskpane and the
 *   event handlers run in the same JS context, so localStorage is trivially
 *   shared.
 *
 *   Classic Outlook on Windows runs this file in a separate JS worker that
 *   CANNOT join the WebView SharedRuntime.  However, both contexts share the
 *   same localStorage origin (https://qa-signature.cardbyte.ai), so this file
 *   can read cache entries written by the taskpane without any XHR.
 *
 * Cache key contract (must match event.js / taskpane):
 *   localStorage key  : "cardbyte_cached_signature"      ← signature HTML
 *   localStorage key  : "cardbyte_cached_signature_ts"   ← write timestamp (ms)
 *   localStorage key  : "cardbyte_cached_signature_session" ← session UUID
 *
 * Read policy (this file):
 *   - Read "cardbyte_cached_signature" unconditionally (no TTL, no session check).
 *   - Classic Outlook has no sessionStorage, so we cannot verify session ID.
 *     The signature stored by the taskpane is always fresher than nothing.
 *   - If the key is absent (very first launch, cleared storage, private mode)
 *     fall through to roamingSettings, then inject an error banner.
 *
 * roamingSettings (secondary fallback):
 *   Still populated by the SharedRuntime taskpane's prefetch loop for
 *   belt-and-suspenders coverage on networks that clear localStorage on idle.
 *
 * XHR removed:
 *   The previous direct-to-backend XHR is intentionally removed.
 *   Reasons:
 *     1. The SharedRuntime taskpane already has the signature in localStorage
 *        by the time OnNewMessageCompose fires — a redundant XHR wastes time.
 *     2. The XHR endpoint returned { key: "success" } rather than real HTML,
 *        making it unreliable as a primary path.
 *     3. Removing it eliminates the 6 s timeout from the critical path,
 *        making signature insertion near-instant.
 *   If you need a fresh-fetch path for Classic Outlook, implement it in the
 *   taskpane's prefetch loop (event.js / taskpane.js) and let it land in
 *   localStorage where this file can pick it up synchronously.
 */
"use strict";

// =============================================================================
// Cache keys — MUST match the constants in event.js
// =============================================================================
var LS_SIG_KEY = "cardbyte_cached_signature";
var LS_TS_KEY = "cardbyte_cached_signature_ts";
var RS_SIG_KEY = "cardbyte_sig_html";           // roamingSettings fallback key

// =============================================================================
// localStorage helpers (Classic Outlook supports localStorage)
// =============================================================================

/**
 * Returns the cached signature HTML from localStorage, or null.
 * No TTL / session-ID check: Classic Outlook cannot share sessionStorage
 * with the WebView runtime, so any stored signature is better than none.
 */
function getLsSignature() {
    try {
        var html = localStorage.getItem(LS_SIG_KEY);
        if (html && html.length > 0) {
            var ts = localStorage.getItem(LS_TS_KEY);
            console.log(
                "[CardByte] Classic: localStorage hit — size:",
                html.length,
                "written at:", ts ? new Date(parseInt(ts, 10)).toISOString() : "unknown"
            );
            return html;
        }
        return null;
    } catch (e) {
        console.warn("[CardByte] Classic: localStorage read failed:", e);
        return null;
    }
}

// =============================================================================
// roamingSettings helpers (secondary fallback)
// =============================================================================

function _rsGet() {
    try {
        var rs = Office.context.roamingSettings;
        return rs ? rs.get(RS_SIG_KEY) : null;
    } catch (e) { return null; }
}

function _rsDel() {
    try {
        var rs = Office.context.roamingSettings;
        if (!rs) return;
        rs.remove(RS_SIG_KEY);
        rs.saveAsync(function () { });
    } catch (e) { }
}

/**
 * Returns the cached HTML from roamingSettings { html, ts } entry, or null.
 */
function getRoamingSignature() {
    try {
        var entry = _rsGet();
        if (entry && entry.html) {
            console.log("[CardByte] Classic: roamingSettings hit");
            return entry.html;
        }
        return null;
    } catch (e) {
        console.warn("[CardByte] Classic: roamingSettings read failed:", e);
        return null;
    }
}

/**
 * Clears roamingSettings cache entry.
 * Called on OnMessageFromChanged (account switch → stale identity).
 */
function clearRoamingCache() {
    delete _memStore[RS_SIG_KEY];
    _rsDel();
}

// Lightweight in-process mem cache to avoid repeated roamingSettings calls.
var _memStore = {};

function getCachedSignature() {
    // 1. localStorage (written by SharedRuntime taskpane — freshest)
    var lsHtml = getLsSignature();
    if (lsHtml) return lsHtml;

    // 2. In-process mem cache
    var memEntry = _memStore[RS_SIG_KEY];
    if (memEntry && memEntry.html) return memEntry.html;

    // 3. roamingSettings (written by taskpane prefetch loop)
    var rsHtml = getRoamingSignature();
    if (rsHtml) {
        _memStore[RS_SIG_KEY] = { html: rsHtml };
        return rsHtml;
    }

    return null;
}

// =============================================================================
// Error HTML — injected when all cache layers are empty
// =============================================================================
var ERROR_HTML = [
    "<div style='",
    "margin:16px 0;",
    "padding:12px 16px;",
    "border:1px solid #f5c6cb;",
    "border-radius:4px;",
    "background-color:#fff3cd;",
    "font-family:Arial,Helvetica,sans-serif;",
    "font-size:13px;",
    "color:#856404;",
    "'>",
    "<strong>[CardByte]</strong> ",
    "Signature could not be loaded. ",
    "Please open the CardByte taskpane once to sync your signature, ",
    "then reopen this compose window.",
    "</div>"
].join("");

// =============================================================================
// Write path — setSignatureAsync with prependAsync fallback
// =============================================================================
function _prependFallback(item, html, onDone) {
    if (typeof item.body.prependAsync !== "function") {
        console.error("[CardByte] Classic: prependAsync not available — no write path left");
        onDone(false);
        return;
    }
    console.log("[CardByte] Classic: falling back to prependAsync");
    item.body.prependAsync(
        html,
        { coercionType: Office.CoercionType.Html },
        function (result) {
            var ok = result.status === Office.AsyncResultStatus.Succeeded
                || result.status === "succeeded";
            if (!ok) console.error("[CardByte] Classic: prependAsync failed:", result.error && result.error.message);
            onDone(ok);
        }
    );
}

function setSignature(item, html, onDone) {
    if (typeof item.body.setSignatureAsync !== "function") {
        console.warn("[CardByte] Classic: setSignatureAsync not available — trying prependAsync");
        _prependFallback(item, html, onDone);
        return;
    }
    item.body.setSignatureAsync(
        html,
        { coercionType: Office.CoercionType.Html },
        function (result) {
            var ok = result.status === Office.AsyncResultStatus.Succeeded
                || result.status === "succeeded";
            if (ok) {
                console.log("[CardByte] Classic: setSignatureAsync succeeded");
                onDone(true);
            } else {
                console.warn("[CardByte] Classic: setSignatureAsync failed:", result.error && result.error.message, "— trying prependAsync");
                _prependFallback(item, html, onDone);
            }
        }
    );
}

// =============================================================================
// Wrap helper — adds spacing + hidden timestamp marker
// =============================================================================
function _buildWrapped(html) {
    var now = new Date();
    var ts = now.getUTCFullYear() + "-"
        + ("0" + (now.getUTCMonth() + 1)).slice(-2) + "-"
        + ("0" + now.getUTCDate()).slice(-2) + " "
        + ("0" + now.getUTCHours()).slice(-2) + ":"
        + ("0" + now.getUTCMinutes()).slice(-2) + " UTC";
    return "<div style='margin-top:40px'></div>"
        + html
        + "<div style='margin-top:40px'></div>"
        + "<span style='display:none;font-size:0;color:transparent;line-height:0;'"
        + " data-cb-ts='" + ts + "'>" + ts + "</span>";
}

// =============================================================================
// Core apply logic
//
// Priority:
//   1. localStorage  (written by SharedRuntime taskpane — fastest, freshest)
//   2. roamingSettings / mem cache  (written by taskpane prefetch loop)
//   3. Error banner  (both cache layers empty — user needs to open taskpane)
//
// No XHR: the taskpane already owns the fetch responsibility.
// =============================================================================
function applySignatureCore(item, event) {
    console.log("[CardByte] Classic: applySignatureCore — reading cache");

    var cached = getCachedSignature();

    if (cached) {
        console.log("[CardByte] Classic: cache hit — writing signature (size:", cached.length, ")");
        setSignature(item, _buildWrapped(cached), function (ok) {
            if (!ok) console.warn("[CardByte] Classic: signature write failed");
            event.completed();
        });
        return;
    }

    // Both cache layers are empty.
    console.error(
        "[CardByte] Classic: all cache layers empty.",
        "localStorage key:", LS_SIG_KEY,
        "— value:", localStorage ? localStorage.getItem(LS_SIG_KEY) : "N/A",
        "| roamingSettings:", _rsGet()
    );
    console.warn("[CardByte] Classic: injecting error banner into compose body");
    setSignature(item, ERROR_HTML, function (ok) {
        if (!ok) console.error("[CardByte] Classic: error banner injection also failed");
        event.completed();
    });
}

// =============================================================================
// Guarded event.completed — fires exactly once, with timeout safety
// =============================================================================
function makeGuardedEvent(event, timeoutMs) {
    var done = false;
    var timer = setTimeout(function () {
        console.warn("[CardByte] Classic: event timeout — completing");
        complete();
    }, timeoutMs || 8000);
    function complete(opts) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (opts) event.completed(opts);
        else event.completed();
    }
    return { completed: complete };
}

// =============================================================================
// Event handlers
// =============================================================================

/** OnNewMessageCompose */
function applySignature(event) {
    if (!event) event = { completed: function () { } };
    var guarded = makeGuardedEvent(event, 12000);
    var mailbox = (typeof Office !== "undefined" && Office.context && Office.context.mailbox)
        ? Office.context.mailbox : null;
    var item = mailbox ? mailbox.item : null;
    if (!item) {
        console.warn("[CardByte] Classic: applySignature — no item");
        guarded.completed();
        return;
    }

    // Auto-open the taskpane — fire-and-forget; signature write proceeds
    // regardless of whether the pane opens successfully.
    if (Office.addin && typeof Office.addin.showAsTaskpane === "function") {
        Office.addin.showAsTaskpane().then(function () {
            console.log("[CardByte] Classic: taskpane opened");
        })["catch"](function (err) {
            console.warn("[CardByte] Classic: showAsTaskpane failed (non-fatal):", err);
        });
    }

    applySignatureCore(item, guarded);
}

/** OnMessageSend (SoftBlock) */
function onSendHandler(event) {
    if (!event) event = { completed: function () { } };
    var guarded = makeGuardedEvent(event, 12000);
    console.log("[CardByte] Classic: onSendHandler fired");
    var mailbox = (typeof Office !== "undefined" && Office.context && Office.context.mailbox)
        ? Office.context.mailbox : null;
    var item = mailbox ? mailbox.item : null;
    if (!item) { guarded.completed({ allowEvent: true }); return; }

    var cached = getCachedSignature();
    if (cached) {
        // Re-apply at send time to ensure the latest cached version is used.
        setSignature(item, _buildWrapped(cached), function () {
            guarded.completed({ allowEvent: true });
        });
    } else {
        // No signature available — allow send but log clearly.
        console.error("[CardByte] Classic: onSendHandler — cache empty at send time, sending without signature");
        guarded.completed({ allowEvent: true });
    }
}

/** OnMessageFromChanged */
function onFromChangedHandler(event) {
    if (!event) event = { completed: function () { } };
    var guarded = makeGuardedEvent(event, 12000);
    console.log("[CardByte] Classic: onFromChangedHandler fired");
    var mailbox = (typeof Office !== "undefined" && Office.context && Office.context.mailbox)
        ? Office.context.mailbox : null;
    var item = mailbox ? mailbox.item : null;
    if (!item) { guarded.completed(); return; }

    // Clear the roamingSettings + mem cache for the old account identity.
    // localStorage is NOT cleared here because the SharedRuntime taskpane
    // will re-fetch and overwrite it for the new From address via its own
    // onFromChangedHandler / re-render path.
    clearRoamingCache();
    applySignatureCore(item, guarded);
}

// =============================================================================
// Office.actions.associate — synchronous top-level (required for Classic Outlook)
// =============================================================================
function _registerHandlers() {
    if (typeof Office === "undefined" || typeof Office.actions === "undefined") {
        console.warn("[CardByte] Classic: Office.actions not available — skipping registration");
        return;
    }
    Office.actions.associate("applySignature", applySignature);
    console.log("[CardByte] Classic: Registered applySignature");
    Office.actions.associate("onSendHandler", onSendHandler);
    console.log("[CardByte] Classic: Registered onSendHandler");
    Office.actions.associate("onFromChangedHandler", onFromChangedHandler);
    console.log("[CardByte] Classic: Registered onFromChangedHandler");
}

_registerHandlers();