/**
 * CardByte Signature Manager — event-handler-classic.js
 * Diagnostic build — roamingSettings canaries added to trace execution.
 *
 * HOW TO READ THE CANARIES (run in taskpane console after compose):
 *   Office.context.roamingSettings.get("cb_file_loaded")   → timestamp if file was fetched+executed
 *   Office.context.roamingSettings.get("cb_handler_fired") → timestamp if applySignature was called
 *   Office.context.roamingSettings.get("cb_ls_value")      → what was in localStorage at handler time
 *   Office.context.roamingSettings.get("cb_last_error")    → any caught error message
 *
 * Interpretation:
 *   cb_file_loaded = null   → file not fetched (wrong URL, 404, or LaunchEvent not firing at all)
 *   cb_file_loaded = ts,
 *   cb_handler_fired = null → file loads but Office.actions.associate failed or Outlook
 *                             didn't call the function (build too old / req set mismatch)
 *   cb_handler_fired = ts,
 *   cb_ls_value = null      → handler fires but localStorage is empty (taskpane never ran)
 *   cb_handler_fired = ts,
 *   cb_ls_value = (html)    → everything works; problem is in setSignatureAsync write path
 */
"use strict";

// =============================================================================
// CANARY 1 — Did the file load at all?
// Runs synchronously at the top level, before any function definitions.
// =============================================================================
(function () {
    try {
        var ts = new Date().toISOString();
        var rs = Office && Office.context && Office.context.roamingSettings;
        if (rs) {
            rs.set("cb_file_loaded", ts);
            rs.set("cb_handler_fired", null);
            rs.set("cb_ls_value", null);
            rs.set("cb_last_error", null);
            rs.saveAsync(function () { });
        }
        console.log("[CardByte] Classic: file loaded at", ts);
    } catch (e) {
        // Can't do anything if even this fails — Office not ready yet
    }
}());

// =============================================================================
// Cache keys — must match App.js / event.js
// =============================================================================
var LS_SIG_KEY = "cardbyte_cached_signature";
var LS_TS_KEY = "cardbyte_cached_signature_ts";
var RS_SIG_KEY = "cardbyte_sig_html";

// =============================================================================
// localStorage helpers
// =============================================================================
function getLsSignature() {
    try {
        var html = localStorage.getItem(LS_SIG_KEY);
        if (html && html.length > 0) {
            var ts = localStorage.getItem(LS_TS_KEY);
            console.log("[CardByte] Classic: localStorage hit — size:", html.length,
                "written at:", ts ? new Date(parseInt(ts, 10)).toISOString() : "unknown");
            return html;
        }
        return null;
    } catch (e) {
        console.warn("[CardByte] Classic: localStorage read failed:", e);
        return null;
    }
}

// =============================================================================
// roamingSettings helpers
// =============================================================================
var _memStore = {};

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

function clearRoamingCache() {
    delete _memStore[RS_SIG_KEY];
    _rsDel();
}

function getCachedSignature() {
    var lsHtml = getLsSignature();
    if (lsHtml) return lsHtml;

    var memEntry = _memStore[RS_SIG_KEY];
    if (memEntry && memEntry.html) return memEntry.html;

    var rsHtml = getRoamingSignature();
    if (rsHtml) {
        _memStore[RS_SIG_KEY] = { html: rsHtml };
        return rsHtml;
    }
    return null;
}

// =============================================================================
// Error HTML
// =============================================================================
var ERROR_HTML = [
    "<div style='margin:16px 0;padding:12px 16px;",
    "border:1px solid #f5c6cb;border-radius:4px;",
    "background-color:#fff3cd;",
    "font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#856404;'>",
    "<strong>[CardByte]</strong> ",
    "Signature could not be loaded. ",
    "Please open the CardByte taskpane once to sync your signature, ",
    "then reopen this compose window.",
    "</div>"
].join("");

// =============================================================================
// Write path
// =============================================================================
function _prependFallback(item, html, onDone) {
    if (typeof item.body.prependAsync !== "function") {
        console.error("[CardByte] Classic: prependAsync not available");
        onDone(false);
        return;
    }
    item.body.prependAsync(html, { coercionType: Office.CoercionType.Html }, function (result) {
        var ok = result.status === Office.AsyncResultStatus.Succeeded || result.status === "succeeded";
        if (!ok) console.error("[CardByte] Classic: prependAsync failed:", result.error && result.error.message);
        onDone(ok);
    });
}

function setSignature(item, html, onDone) {
    if (typeof item.body.setSignatureAsync !== "function") {
        console.warn("[CardByte] Classic: setSignatureAsync not available — trying prependAsync");
        _prependFallback(item, html, onDone);
        return;
    }
    item.body.setSignatureAsync(html, { coercionType: Office.CoercionType.Html }, function (result) {
        var ok = result.status === Office.AsyncResultStatus.Succeeded || result.status === "succeeded";
        if (ok) {
            console.log("[CardByte] Classic: setSignatureAsync succeeded");
            onDone(true);
        } else {
            console.warn("[CardByte] Classic: setSignatureAsync failed:", result.error && result.error.message);
            _prependFallback(item, html, onDone);
        }
    });
}

// =============================================================================
// Wrap helper
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
// Diagnostic writer — saves state to roamingSettings so taskpane can read it
// =============================================================================
function _saveCanary(key, value) {
    try {
        var rs = Office && Office.context && Office.context.roamingSettings;
        if (rs) {
            rs.set(key, value);
            rs.saveAsync(function () { });
        }
    } catch (e) { }
}

// =============================================================================
// Core apply logic
// =============================================================================
function applySignatureCore(item, event) {
    console.log("[CardByte] Classic: applySignatureCore");

    var cached = getCachedSignature();

    // Record what was in localStorage for diagnostic readback
    _saveCanary("cb_ls_value", cached ? ("size:" + cached.length) : "EMPTY");

    if (cached) {
        console.log("[CardByte] Classic: cache hit — writing signature (size:", cached.length, ")");
        setSignature(item, _buildWrapped(cached), function (ok) {
            if (!ok) {
                console.warn("[CardByte] Classic: signature write failed");
                _saveCanary("cb_last_error", "setSignature returned false");
            }
            event.completed();
        });
        return;
    }

    console.error("[CardByte] Classic: all cache layers empty");
    _saveCanary("cb_last_error", "all cache layers empty at " + new Date().toISOString());
    setSignature(item, ERROR_HTML, function (ok) {
        if (!ok) console.error("[CardByte] Classic: error banner injection also failed");
        event.completed();
    });
}

// =============================================================================
// Guarded event.completed
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
function applySignature(event) {
    if (!event) event = { completed: function () { } };
    var guarded = makeGuardedEvent(event, 12000);

    // CANARY 2 — did Outlook actually call this function?
    _saveCanary("cb_handler_fired", new Date().toISOString());
    console.log("[CardByte] Classic: applySignature handler fired");

    var mailbox = (typeof Office !== "undefined" && Office.context && Office.context.mailbox)
        ? Office.context.mailbox : null;
    var item = mailbox ? mailbox.item : null;

    if (!item) {
        console.warn("[CardByte] Classic: applySignature — no item");
        _saveCanary("cb_last_error", "no mailbox item");
        guarded.completed();
        return;
    }

    if (Office.addin && typeof Office.addin.showAsTaskpane === "function") {
        Office.addin.showAsTaskpane().then(function () {
            console.log("[CardByte] Classic: taskpane opened");
        })["catch"](function (err) {
            console.warn("[CardByte] Classic: showAsTaskpane failed (non-fatal):", err);
        });
    }

    applySignatureCore(item, guarded);
}

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
        setSignature(item, _buildWrapped(cached), function () {
            guarded.completed({ allowEvent: true });
        });
    } else {
        console.error("[CardByte] Classic: onSendHandler — cache empty at send time");
        guarded.completed({ allowEvent: true });
    }
}

function onFromChangedHandler(event) {
    if (!event) event = { completed: function () { } };
    var guarded = makeGuardedEvent(event, 12000);
    console.log("[CardByte] Classic: onFromChangedHandler fired");

    var mailbox = (typeof Office !== "undefined" && Office.context && Office.context.mailbox)
        ? Office.context.mailbox : null;
    var item = mailbox ? mailbox.item : null;
    if (!item) { guarded.completed(); return; }

    clearRoamingCache();
    applySignatureCore(item, guarded);
}

// =============================================================================
// Office.actions.associate — synchronous, top-level, no wrappers
// =============================================================================
function _registerHandlers() {
    if (typeof Office === "undefined" || typeof Office.actions === "undefined") {
        console.warn("[CardByte] Classic: Office.actions not available");
        try {
            var rs = Office && Office.context && Office.context.roamingSettings;
            if (rs) {
                rs.set("cb_last_error", "Office.actions not available at register time");
                rs.saveAsync(function () { });
            }
        } catch (e) { }
        return;
    }
    Office.actions.associate("applySignature", applySignature);
    Office.actions.associate("onSendHandler", onSendHandler);
    Office.actions.associate("onFromChangedHandler", onFromChangedHandler);
    console.log("[CardByte] Classic: all handlers registered");
}

_registerHandlers();