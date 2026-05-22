/**
 * CardByte Signature Manager — event-handler-classic.js
 *
 * ⚠️  THIS FILE IS FOR CLASSIC OUTLOOK ON WINDOWS (JS-only runtime) ONLY.
 *
 * Classic Outlook's LaunchEvent JS runtime runs on a legacy engine that does NOT support:
 *   ✗ async / await
 *   ✗ class syntax
 *   ✗ crypto.subtle  (Web Crypto API unavailable)
 *   ✗ localStorage / sessionStorage (falls back to _memStore below)
 *   ✗ DOM / Canvas API
 *
 * This file uses only ES5-compatible constructs + XMLHttpRequest for network calls.
 * It is referenced by the manifest's JSRuntime.Url override so it loads only in
 * Classic Outlook. All other platforms (OWA, New Outlook, Mac, Mobile) continue
 * to use the full modern event-handler.js via WebViewRuntime.Url.
 *
 * Events handled:
 *   OnNewMessageCompose   → applySignature       (req set 1.10)
 *   OnMessageSend         → onSendHandler        (req set 1.12, SoftBlock)
 *   OnMessageFromChanged  → onFromChangedHandler (req set 1.13)
 */

"use strict";

// =============================================================================
// In-memory store (localStorage unavailable in JS-only runtime)
// =============================================================================
var _memStore = {};

function memGet(key) {
    return Object.prototype.hasOwnProperty.call(_memStore, key) ? _memStore[key] : null;
}
function memSet(key, val) { _memStore[key] = val; }
function memDel(key) { delete _memStore[key]; }

// =============================================================================
// Simple cache (session-scoped via _memStore — no localStorage in JS runtime)
// =============================================================================
var CACHE_KEY = "cardbyte_sig_html";
var CACHED_HTML = null;   // module-level fallback

function getCached() { return CACHED_HTML || memGet(CACHE_KEY); }
function setCache(html) { CACHED_HTML = html; memSet(CACHE_KEY, html); }
function clearCache() { CACHED_HTML = null; memDel(CACHE_KEY); }

// =============================================================================
// XHR helper — replaces fetch() which requires async/await in this runtime
// Calls onSuccess(responseText) or onError(statusCode).
// =============================================================================
function xhrGet(url, headers, onSuccess, onError) {
    var xhr = new XMLHttpRequest();
    xhr.open("GET", url, true);
    if (headers) {
        var keys = Object.keys(headers);
        for (var i = 0; i < keys.length; i++) {
            xhr.setRequestHeader(keys[i], headers[keys[i]]);
        }
    }
    xhr.onreadystatechange = function () {
        if (xhr.readyState !== 4) return;
        if (xhr.status >= 200 && xhr.status < 300) {
            onSuccess(xhr.responseText);
        } else {
            onError(xhr.status);
        }
    };
    xhr.onerror = function () { onError(0); };
    xhr.send();
}

function xhrPost(url, headers, body, onSuccess, onError) {
    var xhr = new XMLHttpRequest();
    xhr.open("POST", url, true);
    if (headers) {
        var keys = Object.keys(headers);
        for (var i = 0; i < keys.length; i++) {
            xhr.setRequestHeader(keys[i], headers[keys[i]]);
        }
    }
    xhr.onreadystatechange = function () {
        if (xhr.readyState !== 4) return;
        if (xhr.status >= 200 && xhr.status < 300) {
            onSuccess(xhr.responseText);
        } else {
            onError(xhr.status);
        }
    };
    xhr.onerror = function () { onError(0); };
    xhr.send(body);
}

// =============================================================================
// Server fetch — Classic version
//
// NOTE: crypto.subtle is NOT available in Classic Outlook's JS-only runtime.
// We send the email address in plaintext. The server must accept this.
// If server-side decryption is required, implement a separate Classic endpoint
// that accepts plaintext (or a simpler encoding like btoa).
// =============================================================================
function fetchSignatureForUser(email, platform, onDone) {
    // onDone(html | null)

    // ── Primary renderer ──
    xhrGet(
        "https://newqa-enterprise.cardbyte.ai/email-signature/html/outlook/get-active",
        { "username": email, "X-Platform": platform },
        function (responseText) {
            try {
                // Primary renderer returns AES-encrypted JSON.
                // crypto.subtle is unavailable here so we attempt JSON.parse directly
                // (works if server detects Classic and returns plaintext JSON).
                var parsed = JSON.parse(responseText);
                if (parsed && parsed.html) {
                    console.log("[CardByte] Classic: primary renderer OK");
                    onDone(parsed.html);
                    return;
                }
            } catch (e) { /* fall through */ }
            // If parsing fails (encrypted payload), fall to legacy renderer
            console.warn("[CardByte] Classic: primary renderer returned unparseable data, trying legacy");
            fetchLegacy(email, onDone);
        },
        function (status) {
            console.warn("[CardByte] Classic: primary renderer failed (" + status + "), trying legacy");
            fetchLegacy(email, onDone);
        }
    );
}

function fetchLegacy(email, onDone) {
    xhrPost(
        "https://newqa-renderer.cardbyte.ai/render-signature",
        { "Content-Type": "application/json" },
        JSON.stringify({ email: email }),
        function (responseText) {
            try {
                var data = JSON.parse(responseText);
                if (data && data.finalHtml) {
                    console.log("[CardByte] Classic: legacy renderer OK");
                    onDone(data.finalHtml);
                    return;
                }
            } catch (e) { /* fall through */ }
            console.error("[CardByte] Classic: legacy renderer returned unparseable data");
            onDone(null);
        },
        function (status) {
            console.error("[CardByte] Classic: legacy renderer failed (" + status + ")");
            onDone(null);
        }
    );
}

// =============================================================================
// Office.js body write helper — callback-based, no async/await
// =============================================================================
function setSignature(item, html, onDone) {
    // Primary: setSignatureAsync (Mailbox 1.10+)
    if (typeof item.body.setSignatureAsync === "function") {
        item.body.setSignatureAsync(
            html,
            { coercionType: Office.CoercionType.Html },
            function (result) {
                if (result.status === Office.AsyncResultStatus.Succeeded ||
                    result.status === "succeeded") {
                    console.log("[CardByte] Classic: setSignatureAsync succeeded");
                    onDone(true);
                } else {
                    console.warn("[CardByte] Classic: setSignatureAsync failed, trying prependAsync");
                    prependSignature(item, html, onDone);
                }
            }
        );
        return;
    }
    // Fallback: prependAsync
    prependSignature(item, html, onDone);
}

function prependSignature(item, html, onDone) {
    if (typeof item.body.prependAsync !== "function") {
        console.error("[CardByte] Classic: neither setSignatureAsync nor prependAsync available");
        onDone(false);
        return;
    }
    item.body.prependAsync(
        html,
        { coercionType: Office.CoercionType.Html },
        function (result) {
            if (result.status === Office.AsyncResultStatus.Succeeded) {
                console.log("[CardByte] Classic: prependAsync succeeded");
                onDone(true);
            } else {
                console.error("[CardByte] Classic: prependAsync failed:", result.error);
                onDone(false);
            }
        }
    );
}

// =============================================================================
// Identity fallback signature (used when both renderers fail)
// =============================================================================
function buildFallbackHtml(userProfile) {
    var name = (userProfile && userProfile.displayName) ? userProfile.displayName : "";
    var email = (userProfile && userProfile.emailAddress) ? userProfile.emailAddress : "";
    return '<table cellpadding="0" cellspacing="0" border="0" width="400">' +
        '<tr><td style="font-family:Arial,sans-serif;font-size:12px;">' +
        '<strong>' + name + '</strong><br/>' +
        email + '<br/>' +
        '<span style="color:#999;">Sent via CardByte</span>' +
        '</td></tr></table>';
}

// =============================================================================
// Core: apply signature — fully callback-based, no async/await
// =============================================================================
function applySignatureCore(item, userProfile, html, event) {
    // Wrap in spacers
    var wrapped = "<div style='margin-top:40px'></div>" + html + "<div style='margin-top:40px'></div>";
    setSignature(item, wrapped, function (ok) {
        if (!ok) console.warn("[CardByte] Classic: signature set failed");
        event.completed();
    });
}

function runWithSignature(item, userProfile, event, forceRefresh) {
    if (forceRefresh) clearCache();

    var cached = getCached();
    if (cached) {
        console.log("[CardByte] Classic: using cached signature");
        applySignatureCore(item, userProfile, cached, event);
        return;
    }

    var email = userProfile ? userProfile.emailAddress : null;
    if (!email) {
        console.warn("[CardByte] Classic: no email — using fallback");
        applySignatureCore(item, userProfile, buildFallbackHtml(userProfile), event);
        return;
    }

    // Determine platform header
    var xPlatform = "WINDOWS";
    try {
        var diag = Office.context.diagnostics;
        if (diag && diag.platform &&
            (diag.platform === Office.PlatformType.Mac ||
                diag.platform.toString().toLowerCase() === "mac")) {
            xPlatform = "MAC";
        }
    } catch (e) { /* ignore */ }

    fetchSignatureForUser(email, xPlatform, function (html) {
        if (html) {
            setCache(html);
            applySignatureCore(item, userProfile, html, event);
        } else {
            // Stale cache already cleared — use identity fallback
            console.warn("[CardByte] Classic: fetch failed — using identity fallback");
            applySignatureCore(item, userProfile, buildFallbackHtml(userProfile), event);
        }
    });
}

// =============================================================================
// Event handlers — OnNewMessageCompose
// =============================================================================
function applySignature(event) {
    if (!event) event = { completed: function () { } };
    console.log("[CardByte] Classic: applySignature fired");

    var mailbox = (typeof Office !== "undefined" && Office.context && Office.context.mailbox)
        ? Office.context.mailbox : null;
    var item = mailbox ? mailbox.item : null;

    if (!item) {
        console.warn("[CardByte] Classic: no item");
        event.completed();
        return;
    }

    var userProfile = (mailbox && mailbox.userProfile) ? mailbox.userProfile : {};
    runWithSignature(item, userProfile, event, false);
}

// =============================================================================
// Event handlers — OnMessageSend (SoftBlock)
// =============================================================================
function onSendHandler(event) {
    if (!event) event = { completed: function () { } };
    console.log("[CardByte] Classic: onSendHandler fired");

    var mailbox = (typeof Office !== "undefined" && Office.context && Office.context.mailbox)
        ? Office.context.mailbox : null;
    var item = mailbox ? mailbox.item : null;

    if (!item) {
        event.completed({ allowEvent: true });
        return;
    }

    var cached = getCached();
    if (!cached) {
        // No cached signature — allow send without blocking
        console.warn("[CardByte] Classic: onSend — no cached signature, allowing send");
        event.completed({ allowEvent: true });
        return;
    }

    var wrapped = "<div style='margin-top:40px'></div>" + cached + "<div style='margin-top:40px'></div>";
    setSignature(item, wrapped, function () {
        event.completed({ allowEvent: true });
    });
}

// =============================================================================
// Event handlers — OnMessageFromChanged
// =============================================================================
function onFromChangedHandler(event) {
    if (!event) event = { completed: function () { } };
    console.log("[CardByte] Classic: onFromChangedHandler fired");

    var mailbox = (typeof Office !== "undefined" && Office.context && Office.context.mailbox)
        ? Office.context.mailbox : null;
    var item = mailbox ? mailbox.item : null;

    if (!item) {
        event.completed();
        return;
    }

    // Try to read new From address (Mailbox 1.13+)
    if (item.from && typeof item.from.getAsync === "function") {
        item.from.getAsync(function (result) {
            var newEmail = null;
            if (result.status === Office.AsyncResultStatus.Succeeded && result.value) {
                newEmail = result.value.emailAddress;
            }

            var patchedProfile = {};
            if (mailbox && mailbox.userProfile) {
                patchedProfile.displayName = mailbox.userProfile.displayName;
                patchedProfile.emailAddress = newEmail || mailbox.userProfile.emailAddress;
            }

            clearCache();   // force re-fetch for new account
            runWithSignature(item, patchedProfile, event, false);
        });
    } else {
        // Can't determine new From — re-apply with existing profile
        var userProfile = (mailbox && mailbox.userProfile) ? mailbox.userProfile : {};
        clearCache();
        runWithSignature(item, userProfile, event, false);
    }
}

// =============================================================================
// Office.actions.associate
//
// In Classic Outlook's JS-only runtime:
//   - Office.onReady() NEVER fires — must register at top level synchronously.
//   - Office.js is already loaded (event.html loads it before this script).
//   - So Office.actions is available immediately at parse time.
// =============================================================================
function _registerHandlers() {
    if (typeof Office === "undefined" || typeof Office.actions === "undefined") {
        console.log("[CardByte] Classic: Office.actions not available — skipping");
        return;
    }
    Office.actions.associate("applySignature", applySignature);
    console.log("[CardByte] Classic: Registered applySignature");

    Office.actions.associate("onSendHandler", onSendHandler);
    console.log("[CardByte] Classic: Registered onSendHandler");

    Office.actions.associate("onFromChangedHandler", onFromChangedHandler);
    console.log("[CardByte] Classic: Registered onFromChangedHandler");
}

// ── Synchronous top-level registration (required for Classic Outlook) ─────────
_registerHandlers();