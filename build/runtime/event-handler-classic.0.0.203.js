/**
* CardByte Signature Manager — event-handler-classic.js
*
* ⚠️  THIS FILE IS FOR CLASSIC OUTLOOK ON WINDOWS (JS-only runtime) ONLY.
*
* Classic Outlook's LaunchEvent JS runtime does NOT support:
*   ✗ async / await
*   ✗ class syntax
*   ✗ crypto.subtle
*   ✗ localStorage / sessionStorage
*   ✗ DOM / Canvas API
*
* Signature strategy (single tier — NO fallback, NO XHR in this file):
*   1. roamingSettings cache — populated AND actively refreshed by SharedRuntime
*      (taskpane.js interval loop, every REFRESH_INTERVAL_MS).
*      Cache hit  → write immediately.
*      Cache miss → inject a visible error message into the compose body
*                   so the user knows the signature failed to load.
*
* Cache freshness contract:
*   - SharedRuntime calls startPrefetchLoop() on Office.onReady (initial load).
*   - SharedRuntime then calls _prefetchSignatureForClassic() every 4 min
*     for the lifetime of the Outlook session.
*   - This file never expires or deletes a valid cache entry on its own.
*     It only clears on OnMessageFromChanged (account switch → stale identity).
*/
"use strict";
// =============================================================================
// Signature cache — roamingSettings + in-session mem
// =============================================================================
var CACHE_KEY = "cardbyte_sig_html";
var _memStore = {};   // { html, ts }
function _rsGet() {
    try {
        var rs = Office.context.roamingSettings;
        return rs ? rs.get(CACHE_KEY) : null;
    } catch (e) { return null; }
}
function _rsDel() {
    try {
        var rs = Office.context.roamingSettings;
        if (!rs) return;
        rs.remove(CACHE_KEY);
        rs.saveAsync(function () { });
    } catch (e) { }
}
/**
* Returns the cached signature HTML string, or null if no entry exists.
*/
function getCached() {
    var memEntry = _memStore[CACHE_KEY];
    if (memEntry) return memEntry.html;
    var rsEntry = _rsGet();
    if (!rsEntry || !rsEntry.html) return null;
    _memStore[CACHE_KEY] = rsEntry;
    return rsEntry.html;
}
/**
* Clears both mem and roamingSettings.
* Called only on OnMessageFromChanged (account switch).
*/
function clearCache() {
    delete _memStore[CACHE_KEY];
    _rsDel();
}
// =============================================================================
// Error HTML — injected when cache is absent
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
    "Signature could not be loaded — the SharedRuntime cache is empty. ",
    "Please wait a few seconds and reopen this compose window, ",
    "or open the CardByte taskpane to trigger a refresh.",
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
// Cache hit  → write signature immediately (SharedRuntime owns freshness).
// Cache miss → inject visible error into compose body so user is informed.
//              No silent fallback. No embedded default HTML.
// =============================================================================
function applySignatureCore(item, event) {
    var cached = getCached();
    if (cached) {
        console.log("[CardByte] Classic: cache hit — writing signature");
        setSignature(item, _buildWrapped(cached), function (ok) {
            if (!ok) console.warn("[CardByte] Classic: signature write failed");
            event.completed();
        });
        return;
    }
    // Cache miss — SharedRuntime has not yet written its first entry.
    // Diagnose roamingSettings state for debugging.
    var rsRaw = null;
    try { rsRaw = Office.context.roamingSettings.get(CACHE_KEY); } catch (e) { }
    console.error(
        "[CardByte] Classic: cache MISS — roamingSettings entry:",
        rsRaw,
        "| _memStore entry:", _memStore[CACHE_KEY]
    );
    // Inject error message so user is not silently left without a signature.
    console.warn("[CardByte] Classic: injecting error message into compose body");
    setSignature(item, ERROR_HTML, function (ok) {
        if (!ok) console.error("[CardByte] Classic: error injection also failed");
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

    // Auto-open the taskpane in Classic Outlook on new compose.
    // showAsTaskpane() is fire-and-forget — signature write proceeds
    // regardless of whether the pane opens successfully.
    if (Office.addin && typeof Office.addin.showAsTaskpane === "function") {
        Office.addin.showAsTaskpane().then(function () {
            console.log("[CardByte] Classic: taskpane opened");
        })["catch"](function (err) {
            // Non-fatal — the signature still gets written even if the pane fails to open.
            console.warn("[CardByte] Classic: showAsTaskpane failed:", err);
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
    var html = getCached();
    if (html) {
        // Re-apply latest cached signature at send time to catch any updates.
        setSignature(item, _buildWrapped(html), function () {
            guarded.completed({ allowEvent: true });
        });
    } else {
        // Cache still absent at send time — allow send but log clearly.
        console.error("[CardByte] Classic: onSendHandler — cache absent at send time, sending without signature");
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
    // Clear stale identity cache — SharedRuntime must re-prefetch for the new From address.
    clearCache();
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