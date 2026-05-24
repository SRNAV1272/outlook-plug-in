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
 * Signature HTML is embedded directly — no server XHR is performed.
 * Only setSignatureAsync is used to write the signature.
 *
 * Events handled:
 *   OnNewMessageCompose   → applySignature       (req set 1.10)
 *   OnMessageSend         → onSendHandler        (req set 1.12, SoftBlock)
 *   OnMessageFromChanged  → onFromChangedHandler (req set 1.13)
 */

"use strict";

// =============================================================================
// Embedded signature HTML
// Replace the value of SIGNATURE_HTML with your actual signature markup.
// =============================================================================

var SIGNATURE_HTML = '<table cellpadding="0" cellspacing="0" border="0" width="610" xmlns:v="urn:schemas-microsoft-com:vml" style="border-collapse:collapse;border-spacing:0;margin:0;padding:0;width:610px;table-layout:fixed;font-family:Arial,Helvetica,sans-serif;vertical-align:top;mso-table-lspace:0;mso-table-rspace:0;-ms-text-size-adjust:100%;-webkit-text-size-adjust:100%;background-color:#ffffff;"><colgroup><col width="190" style="width:190px;"><col width="420" style="width:420px;"></colgroup><tr><td rowspan="8" width="190" align="center" valign="middle" style="width:190px;padding:0;text-align:center;vertical-align:middle;border:none;margin:0;line-height:normal;mso-line-height-rule:exactly;"><table cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;margin:0;padding:0;table-layout:fixed;"><tr><td align="center" valign="middle" style="padding:0 40px 0 0;"><table cellpadding="0" cellspacing="0" border="0" align="center" style="border-collapse:collapse;margin:0;padding:0;table-layout:fixed;margin-left:auto;margin-right:auto;"><tr><td align="center" valign="middle" style="padding:0;"><img src="https://upload.wikimedia.org/wikipedia/commons/a/a7/Camponotus_flavomarginatus_ant.jpg" width="150" height="120" alt="Company Logo" style="display:block;border:0;width:150px;height:120px;" vspace="0" hspace="0" border="0"></td></tr></table></td></tr></table></td><td width="420" align="left" valign="top" style="width:420px;padding:0;text-align:left;vertical-align:top;border:none;margin:0;line-height:normal;mso-line-height-rule:exactly;"><p style="font-family:Arial,Helvetica,sans-serif;font-size:12pt;color:#000000;line-height:1;margin:0;padding:0;">Sai Rajesh Korla</p></td></tr><tr><td width="420" align="left" valign="top" style="width:420px;padding:0;text-align:left;vertical-align:top;border:none;margin:0;line-height:normal;mso-line-height-rule:exactly;"><p style="font-family:Arial,Helvetica,sans-serif;font-size:12pt;color:#000000;line-height:1;margin:0;padding:0;">Software Engineer ( MERN Stack )</p></td></tr><tr><td width="420" align="left" valign="top" style="width:420px;padding:0;text-align:left;vertical-align:top;border:none;margin:0;line-height:normal;mso-line-height-rule:exactly;"><p style="font-family:Arial,Helvetica,sans-serif;font-size:12pt;color:#000000;font-weight:normal;font-style:normal;text-decoration:none;margin:0;padding:0;">Telephone: 0124434887</p></td></tr><tr><td width="420" align="left" valign="top" style="width:420px;padding:0;text-align:left;vertical-align:top;border:none;margin:0;line-height:normal;mso-line-height-rule:exactly;"><p style="font-family:Arial,Helvetica,sans-serif;font-size:12pt;color:#000000;font-weight:normal;font-style:normal;text-decoration:none;margin:0;padding:0;">Mobile: +917024899020</p></td></tr><tr><td width="420" align="left" valign="top" style="width:420px;padding:0;text-align:left;vertical-align:top;border:none;margin:0;line-height:normal;mso-line-height-rule:exactly;"><p style="font-family:Arial,Helvetica,sans-serif;font-size:12pt;color:#000000;font-weight:normal;font-style:normal;text-decoration:none;margin:0;padding:0;line-height:1.4;">Ayyappa Society, Hyderabad, Telangana, India, 500001</p></td></tr><tr><td width="420" align="left" valign="top" style="width:420px;padding:0;text-align:left;vertical-align:top;border:none;margin:0;line-height:normal;mso-line-height-rule:exactly;"><p style="font-family:Arial,Helvetica,sans-serif;font-size:12pt;color:#000000;line-height:1;margin:0;padding:0;">CIN No. : L74899DL1991PLC044843</p></td></tr><tr><td width="420" align="left" valign="top" style="width:420px;padding:0;text-align:left;vertical-align:top;border:none;margin:0;line-height:normal;mso-line-height-rule:exactly;"><p style="font-family:Arial,Helvetica,sans-serif;font-size:12pt;color:#000000;font-weight:normal;font-style:normal;text-decoration:none;margin:0;padding:0;">Website: www.navajna.com</p></td></tr></table>';

// =============================================================================
// Signature wrapper
// =============================================================================
function buildSignatureHtml() {
    return "<div style='margin-top:40px'></div>"
        + SIGNATURE_HTML
        + "<div style='margin-top:40px'></div>"
        + '<span style="color:#666;">T2(+username): ' + "Version 3" + '</span><br/>';
}

// =============================================================================
// In-memory signature cache (localStorage unavailable in JS-only runtime)
// =============================================================================
var _cachedSignatureHtml = null;

function getCached() {
    return _cachedSignatureHtml;
}

function setCache(html) {
    _cachedSignatureHtml = html;
}

function clearCache() {
    _cachedSignatureHtml = null;
}

// =============================================================================
// setSignatureAsync — sole write path
// =============================================================================
function setSignature(item, html, onDone) {
    if (typeof item.body.setSignatureAsync !== "function") {
        console.error("[CardByte] Classic: setSignatureAsync not available on this item");
        onDone(false);
        return;
    }

    item.body.setSignatureAsync(
        html,
        { coercionType: Office.CoercionType.Html },
        function (result) {
            if (result.status === Office.AsyncResultStatus.Succeeded ||
                result.status === "succeeded") {
                console.log("[CardByte] Classic: setSignatureAsync succeeded");
                onDone(true);
            } else {
                console.error("[CardByte] Classic: setSignatureAsync failed:", result.error && result.error.message);
                onDone(false);
            }
        }
    );
}

// =============================================================================
// Core apply logic
// =============================================================================
function applySignatureCore(item, event) {
    var html = buildSignatureHtml();
    setCache(html);

    setSignature(item, html, function (ok) {
        if (!ok) {
            console.warn("[CardByte] Classic: signature write failed");
        }
        event.completed();
    });
}

// =============================================================================
// Guarded event.completed — ensures it fires exactly once
// =============================================================================
function makeGuardedEvent(event, timeoutMs) {
    var done = false;

    function complete(opts) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (opts) event.completed(opts);
        else event.completed();
    }

    var timer = setTimeout(function () {
        console.warn("[CardByte] Classic: event timeout — completing");
        complete();
    }, timeoutMs || 8000);

    return { completed: complete };
}

// =============================================================================
// Event handlers
// =============================================================================

/**
 * OnNewMessageCompose
 * Writes the signature into a new compose window.
 */
function applySignature(event) {
    if (!event) event = { completed: function () { } };

    var guarded = makeGuardedEvent(event, 8000);

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

/**
 * OnMessageSend (SoftBlock)
 * Re-applies cached signature before the message leaves the outbox.
 * Always allows the send even if the write fails.
 */
function onSendHandler(event) {
    if (!event) event = { completed: function () { } };

    var guarded = makeGuardedEvent(event, 8000);

    console.log("[CardByte] Classic: onSendHandler fired");

    var mailbox = (typeof Office !== "undefined" && Office.context && Office.context.mailbox)
        ? Office.context.mailbox : null;
    var item = mailbox ? mailbox.item : null;

    if (!item) {
        guarded.completed({ allowEvent: true });
        return;
    }

    var html = getCached() || buildSignatureHtml();

    setSignature(item, html, function () {
        guarded.completed({ allowEvent: true });
    });
}

/**
 * OnMessageFromChanged
 * Clears cache and re-applies signature when the sender address changes.
 * The embedded signature is static, so no re-fetch is needed — just re-write.
 */
function onFromChangedHandler(event) {
    if (!event) event = { completed: function () { } };

    var guarded = makeGuardedEvent(event, 8000);

    console.log("[CardByte] Classic: onFromChangedHandler fired");

    var mailbox = (typeof Office !== "undefined" && Office.context && Office.context.mailbox)
        ? Office.context.mailbox : null;
    var item = mailbox ? mailbox.item : null;

    if (!item) {
        guarded.completed();
        return;
    }

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