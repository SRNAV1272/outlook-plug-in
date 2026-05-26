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
 * Signature strategy (two tiers — NO XHR in this file):
 *   1. roamingSettings cache — populated AND actively refreshed by SharedRuntime
 *      (taskpane.js interval loop, every REFRESH_INTERVAL_MS).
 *      Cache hit  → write immediately. No TTL check here — SharedRuntime owns
 *      freshness; if the entry exists it is considered valid.
 *   2. Embedded SIGNATURE_HTML fallback — used only when SharedRuntime has not
 *      yet written its first entry (true cold launch, < ~2 s after Outlook start).
 *      The next compose will get the live signature automatically.
 *
 *   All network calls live exclusively in taskpane.js (SharedRuntime context),
 *   where fetch() works without WinINet / CORS concerns.
 *
 * Cache freshness contract:
 *   - SharedRuntime calls prefetchSignature() on Office.onReady (initial load).
 *   - SharedRuntime then calls prefetchSignature() every REFRESH_INTERVAL_MS
 *     (e.g. 4 min) for the lifetime of the Outlook session.
 *   - This file never expires or deletes a valid cache entry on its own.
 *     It only clears on OnMessageFromChanged (account switch → stale identity).
 *
 * Events handled:
 *   OnNewMessageCompose   → applySignature       (req set 1.10)
 *   OnMessageSend         → onSendHandler        (req set 1.12, SoftBlock)
 *   OnMessageFromChanged  → onFromChangedHandler (req set 1.13)
 */

"use strict";

// =============================================================================
// Signature cache — roamingSettings + in-session mem
//
// NO TTL enforcement here. Freshness is guaranteed by the SharedRuntime
// refresh interval in taskpane.js. This handler trusts whatever is in the
// cache as the most recently fetched value.
//
// _memStore       : fast same-session path (dies on runtime restart).
// roamingSettings : survives restarts. Written by SharedRuntime.
//                   Shape: { html: string, ts: number }
// =============================================================================
var CACHE_KEY = "cardbyte_sig_html";
var _memStore = {};               // { html, ts }

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
 * Does NOT check TTL — SharedRuntime is responsible for keeping the entry fresh.
 */
function getCached() {
    // 1. In-session mem — fastest, no RS read needed
    var memEntry = _memStore[CACHE_KEY];
    if (memEntry) {
        return memEntry.html;
    }
    // 2. roamingSettings — populated by SharedRuntime, survives runtime restarts
    var rsEntry = _rsGet();
    if (!rsEntry || !rsEntry.html) {
        return null;
    }
    _memStore[CACHE_KEY] = rsEntry;   // promote to mem for this session
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
// Embedded fallback signature HTML
// Used only on true cold launch (SharedRuntime first prefetch not yet complete).
// SharedRuntime will overwrite roamingSettings within a few seconds of startup;
// the next OnNewMessageCompose will get the live signature.
// =============================================================================
var SIGNATURE_HTML = '<table cellpadding="0" cellspacing="0" border="0" width="610" xmlns:v="urn:schemas-microsoft-com:vml" style="border-collapse:collapse;border-spacing:0;margin:0;padding:0;width:610px;table-layout:fixed;font-family:Arial,Helvetica,sans-serif;vertical-align:top;mso-table-lspace:0;mso-table-rspace:0;-ms-text-size-adjust:100%;-webkit-text-size-adjust:100%;background-color:#ffffff;"><colgroup><col width="190" style="width:190px;"><col width="420" style="width:420px;"></colgroup><tr><td rowspan="8" width="190" align="center" valign="middle" style="width:190px;padding:0;text-align:center;vertical-align:middle;border:none;margin:0;line-height:normal;mso-line-height-rule:exactly;"><table cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;margin:0;padding:0;table-layout:fixed;"><tr><td align="center" valign="middle" style="padding:0 40px 0 0;"><table cellpadding="0" cellspacing="0" border="0" align="center" style="border-collapse:collapse;margin:0;padding:0;table-layout:fixed;margin-left:auto;margin-right:auto;"><tr><td align="center" valign="middle" style="padding:0;"><img src="https://upload.wikimedia.org/wikipedia/commons/a/a7/Camponotus_flavomarginatus_ant.jpg" width="150" height="120" alt="Company Logo" style="display:block;border:0;width:150px;height:120px;" vspace="0" hspace="0" border="0"></td></tr></table></td></tr></table></td><td width="420" align="left" valign="top" style="width:420px;padding:0;text-align:left;vertical-align:top;border:none;margin:0;line-height:normal;mso-line-height-rule:exactly;"><p style="font-family:Arial,Helvetica,sans-serif;font-size:12pt;color:#000000;line-height:1;margin:0;padding:0;">Sai Rajesh Korla</p></td></tr><tr><td width="420" align="left" valign="top" style="width:420px;padding:0;text-align:left;vertical-align:top;border:none;margin:0;line-height:normal;mso-line-height-rule:exactly;"><p style="font-family:Arial,Helvetica,sans-serif;font-size:12pt;color:#000000;line-height:1;margin:0;padding:0;">Software Engineer ( MERN Stack )</p></td></tr><tr><td width="420" align="left" valign="top" style="width:420px;padding:0;text-align:left;vertical-align:top;border:none;margin:0;line-height:normal;mso-line-height-rule:exactly;"><p style="font-family:Arial,Helvetica,sans-serif;font-size:12pt;color:#000000;font-weight:normal;font-style:normal;text-decoration:none;margin:0;padding:0;">Telephone: 0124434887</p></td></tr><tr><td width="420" align="left" valign="top" style="width:420px;padding:0;text-align:left;vertical-align:top;border:none;margin:0;line-height:normal;mso-line-height-rule:exactly;"><p style="font-family:Arial,Helvetica,sans-serif;font-size:12pt;color:#000000;font-weight:normal;font-style:normal;text-decoration:none;margin:0;padding:0;">Mobile: +917024899020</p></td></tr><tr><td width="420" align="left" valign="top" style="width:420px;padding:0;text-align:left;vertical-align:top;border:none;margin:0;line-height:normal;mso-line-height-rule:exactly;"><p style="font-family:Arial,Helvetica,sans-serif;font-size:12pt;color:#000000;font-weight:normal;font-style:normal;text-decoration:none;margin:0;padding:0;line-height:1.4;">Ayyappa Society, Hyderabad, Telangana, India, 500001</p></td></tr><tr><td width="420" align="left" valign="top" style="width:420px;padding:0;text-align:left;vertical-align:top;border:none;margin:0;line-height:normal;mso-line-height-rule:exactly;"><p style="font-family:Arial,Helvetica,sans-serif;font-size:12pt;color:#000000;line-height:1;margin:0;padding:0;">CIN No. : L74899DL1991PLC044843</p></td></tr><tr><td width="420" align="left" valign="top" style="width:420px;padding:0;text-align:left;vertical-align:top;border:none;margin:0;line-height:normal;mso-line-height-rule:exactly;"><p style="font-family:Arial,Helvetica,sans-serif;font-size:12pt;color:#000000;font-weight:normal;font-style:normal;text-decoration:none;margin:0;padding:0;">Website: www.navajna.com</p></td></tr></table>';

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
// Tier 1: roamingSettings cache present (written + refreshed by SharedRuntime)
//         → write immediately. No network call at all.
//
// Tier 2: cache absent (SharedRuntime not yet written its first entry,
//         i.e. true cold launch within the first ~2 s of Outlook start)
//         → write embedded SIGNATURE_HTML and complete.
//           SharedRuntime will populate the cache moments later;
//           the next compose will get the live signature.
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

    console.warn("[CardByte] Classic: cache absent — writing embedded fallback (cold launch)");
    setSignature(item, _buildWrapped(SIGNATURE_HTML), function (ok) {
        if (!ok) console.warn("[CardByte] Classic: fallback write failed");
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

    // roamingSettings cache is always fresh (SharedRuntime refreshes it on interval).
    // Re-apply the latest signature at send time to catch any updates made since compose.
    var html = getCached();
    if (html) {
        setSignature(item, _buildWrapped(html), function () {
            guarded.completed({ allowEvent: true });
        });
    } else {
        // Genuinely cold (Outlook just started and prefetch hasn't finished yet).
        // Allow the send — the embedded fallback was already written at compose time.
        console.warn("[CardByte] Classic: onSendHandler — cache absent, sending as-is");
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
    // Clear stale identity cache. SharedRuntime must re-prefetch for the new From address.
    // This handler writes the embedded fallback for this compose; next compose gets live sig.
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