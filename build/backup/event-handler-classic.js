/**
 * CardByte Signature Manager — event-handler-classic.js
 * Diagnostic build — roamingSettings canaries added to trace execution.
 *
 * CACHE STRATEGY (in priority order):
 *   1. OfficeRuntime.storage  ← PRIMARY  (shared across JS runtime ↔ taskpane WebView)
 *   2. roamingSettings        ← FALLBACK (written by prefetch loop in App.js)
 *   3. Error banner           ← taskpane has never run / all caches cold
 *
 * HOW TO READ THE CANARIES (run in taskpane console after compose):
 *   Office.context.roamingSettings.get("cb_file_loaded")   → timestamp if file was fetched+executed
 *   Office.context.roamingSettings.get("cb_handler_fired") → timestamp if applySignature was called
 *   Office.context.roamingSettings.get("cb_cache_source")  → "OfficeRuntime" | "roamingSettings" | "EMPTY"
 *   Office.context.roamingSettings.get("cb_ls_value")      → size of html retrieved (or EMPTY)
 *   Office.context.roamingSettings.get("cb_last_error")    → any caught error message
 */
"use strict";

// =============================================================================
// CANARY 1 — Did the file load at all?
// =============================================================================
(function () {
    try {
        var ts = new Date().toISOString();
        var rs = Office && Office.context && Office.context.roamingSettings;
        if (rs) {
            rs.set("cb_file_loaded", ts);
            rs.set("cb_handler_fired", null);
            rs.set("cb_ls_value", null);
            rs.set("cb_cache_source", null);
            rs.set("cb_last_error", null);
            rs.saveAsync(function () { });
        }
        console.log("[CardByte] Classic: file loaded at", ts);
    } catch (e) { }
}());

// =============================================================================
// Cache keys — must match App.js / _prefetchSignatureForClassic
// =============================================================================
var ORT_SIG_KEY = "cardbyte_sig_html";   // OfficeRuntime.storage key  (SAME as App.js CACHE_KEY)
var RS_SIG_KEY = "cardbyte_sig_html";   // roamingSettings key        (SAME as App.js CACHE_KEY)

// =============================================================================
// OfficeRuntime.storage helpers  ← PRIMARY CACHE
// Classic JS engine and taskpane WebView BOTH have access to this store.
// =============================================================================

/**
 * Reads the signature html from OfficeRuntime.storage.
 * Returns a Promise that resolves to { html: string } or null.
 */
function _ortGet() {
    return new Promise(function (resolve) {
        try {
            if (typeof OfficeRuntime === "undefined" || !OfficeRuntime.storage) {
                console.warn("[CardByte] Classic: OfficeRuntime.storage not available");
                resolve(null);
                return;
            }
            OfficeRuntime.storage.getItem(ORT_SIG_KEY).then(function (value) {
                if (!value) { resolve(null); return; }
                try {
                    var parsed = JSON.parse(value);
                    if (parsed && parsed.html) {
                        console.log("[CardByte] Classic: OfficeRuntime.storage hit — size:", parsed.html.length);
                        resolve(parsed);
                    } else {
                        resolve(null);
                    }
                } catch (e) {
                    // Stored as raw html string (legacy)
                    if (typeof value === "string" && value.length > 0) {
                        console.log("[CardByte] Classic: OfficeRuntime.storage raw string hit — size:", value.length);
                        resolve({ html: value });
                    } else {
                        resolve(null);
                    }
                }
            })["catch"](function (e) {
                console.warn("[CardByte] Classic: OfficeRuntime.storage read error:", e);
                resolve(null);
            });
        } catch (e) {
            console.warn("[CardByte] Classic: OfficeRuntime.storage exception:", e);
            resolve(null);
        }
    });
}

// =============================================================================
// roamingSettings helpers  ← FALLBACK CACHE
// Written by _prefetchSignatureForClassic() in App.js as { html, ts }.
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

function getRoamingSignature() {
    try {
        var entry = _rsGet();
        if (entry && entry.html) {
            console.log("[CardByte] Classic: roamingSettings hit — size:", entry.html.length);
            return entry.html;
        }
        return null;
    } catch (e) {
        console.warn("[CardByte] Classic: roamingSettings read failed:", e);
        return null;
    }
}

function clearRoamingCache() {
    _rsDel();
}

// =============================================================================
// getCachedSignatureAsync — unified async waterfall
//
// Priority:
//   1. OfficeRuntime.storage  (JS engine ↔ WebView shared store)
//   2. roamingSettings        (written by App.js prefetch loop)
//
// Calls callback(html: string | null, source: string).
// =============================================================================
function getCachedSignatureAsync(callback) {
    _ortGet().then(function (entry) {
        if (entry && entry.html) {
            callback(entry.html, "OfficeRuntime");
            return;
        }
        // OfficeRuntime miss — try roamingSettings
        var rsHtml = getRoamingSignature();
        if (rsHtml) {
            callback(rsHtml, "roamingSettings");
            return;
        }
        callback(null, "EMPTY");
    })["catch"](function (e) {
        console.warn("[CardByte] Classic: getCachedSignatureAsync unexpected error:", e);
        // Last resort — roamingSettings
        var rsHtml = getRoamingSignature();
        callback(rsHtml || null, rsHtml ? "roamingSettings" : "EMPTY");
    });
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
// Diagnostic writer
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
// Core apply logic — now async via getCachedSignatureAsync
// =============================================================================
function applySignatureCore(item, event) {
    console.log("[CardByte] Classic: applySignatureCore");

    getCachedSignatureAsync(function (cached, source) {
        // Record cache source and size for diagnostics
        _saveCanary("cb_cache_source", source);
        _saveCanary("cb_ls_value", cached ? ("size:" + cached.length) : "EMPTY");

        if (cached) {
            console.log("[CardByte] Classic: cache hit via", source, "— size:", cached.length);
            setSignature(item, _buildWrapped(cached), function (ok) {
                if (!ok) _saveCanary("cb_last_error", "setSignature returned false");
                event.completed();
            });
            return;
        }

        console.error("[CardByte] Classic: all cache layers empty — source:", source);
        _saveCanary("cb_last_error", "all cache layers empty at " + new Date().toISOString());
        setSignature(item, ERROR_HTML, function () { event.completed(); });
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

    getCachedSignatureAsync(function (cached, source) {
        if (cached) {
            console.log("[CardByte] Classic: onSendHandler — cache hit via", source);
            setSignature(item, _buildWrapped(cached), function () {
                guarded.completed({ allowEvent: true });
            });
        } else {
            console.error("[CardByte] Classic: onSendHandler — cache empty at send time");
            guarded.completed({ allowEvent: true });
        }
    });
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
// Office.actions.associate
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