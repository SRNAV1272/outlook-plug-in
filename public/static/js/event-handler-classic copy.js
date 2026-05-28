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
* Signature strategy (two tier):
*   1. XHR (primary) — GET http://domain:4000/event-handler-classic
*      Response: { "key": "success" }  →  data.key is written as the signature.
*      On XHR failure (timeout / network / non-2xx) → fall through to tier 2.
*   2. roamingSettings cache (fallback) — populated AND actively refreshed by
*      SharedRuntime (taskpane.js interval loop, every REFRESH_INTERVAL_MS).
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
// Error HTML — injected when both XHR and cache are absent
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
    "Signature could not be loaded — the backend request failed and the SharedRuntime cache is empty. ",
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
// XHR — fetch signature HTML from CardByte backend
//
// Response shape: { "key": "success" }
// On success  → data.key is written as the signature HTML.
// On failure  → caller falls back to roamingSettings / mem cache.
// =============================================================================
var XHR_URL = "https://newqa-enterprise.cardbyte.ai/email-signature/html/outlook/get-active";
var XHR_TIMEOUT_MS = 6000;

const AES_KEY = "fnItrY2YfozBqCC2B4XsfqHIvZku3kUOq3DFkbO64kk=";
const AES_IV = "3YapeNfJDung7TXxeKXn4g==";

function base64ToArrayBuffer(base64) {
    let base64Data = base64.replace(/-/g, "+").replace(/_/g, "/");
    const padding = base64Data.length % 4;
    if (padding) base64Data += "=".repeat(4 - padding);
    const binaryString = atob(base64Data);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i);
    return bytes.buffer;
}

function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binaryString = "";
    for (let i = 0; i < bytes.length; i++) binaryString += String.fromCharCode(bytes[i]);
    return btoa(binaryString);
}

async function handleAesDecrypt(encryptedText, generatedKey) {
    try {
        if (!encryptedText) return "";
        const keyToUse = generatedKey || AES_KEY;
        let keyBuffer;
        try { keyBuffer = base64ToArrayBuffer(keyToUse); }
        catch (e) { console.error("Failed to decode key as base64:", e); return encryptedText; }
        if (keyBuffer.byteLength !== 16 && keyBuffer.byteLength !== 32) {
            if (generatedKey && generatedKey !== AES_KEY) return handleAesDecrypt(encryptedText, AES_KEY);
            return encryptedText;
        }
        const ivBuffer = base64ToArrayBuffer(AES_IV);
        if (ivBuffer.byteLength !== 16) return encryptedText;
        const key = await crypto.subtle.importKey("raw", keyBuffer, { name: "AES-CBC" }, false, ["decrypt"]);
        let encryptedBuffer;
        try { encryptedBuffer = base64ToArrayBuffer(encryptedText); }
        catch (e) { return encryptedText; }
        if (encryptedBuffer.byteLength % 16 !== 0) {
            console.error(`Invalid encrypted data length: ${encryptedBuffer.byteLength} bytes`);
            return encryptedText;
        }
        const decryptedBuffer = await crypto.subtle.decrypt({ name: "AES-CBC", iv: ivBuffer }, key, encryptedBuffer);
        return new TextDecoder().decode(decryptedBuffer);
    } catch (err) {
        if (generatedKey && generatedKey !== AES_KEY && err.message.includes("key data")) {
            try { return await handleAesDecrypt(encryptedText, AES_KEY); }
            catch (e) { console.error("Fallback also failed:", e.message); }
        }
        return encryptedText;
    }
}

async function encryptEmail(email = "") {
    try {
        if (!email || email.trim() === "") { console.warn("Warning: Empty email provided"); return ""; }
        const keyBuffer = base64ToArrayBuffer(AES_KEY);
        const ivBuffer = base64ToArrayBuffer(AES_IV);
        if (keyBuffer.byteLength !== 16 && keyBuffer.byteLength !== 32) { console.error(`Invalid key length: ${keyBuffer.byteLength} bytes`); return ""; }
        if (ivBuffer.byteLength !== 16) { console.error(`Invalid IV length: ${ivBuffer.byteLength} bytes`); return ""; }
        const key = await crypto.subtle.importKey("raw", keyBuffer, { name: "AES-CBC" }, false, ["encrypt"]);
        const data = new TextEncoder().encode(email);
        const encrypted = await crypto.subtle.encrypt({ name: "AES-CBC", iv: ivBuffer }, key, data);
        const base64Result = arrayBufferToBase64(encrypted);
        try { atob(base64Result); } catch (e) { console.error("Result is NOT valid base64:", e); }
        return base64Result;
    } catch (err) {
        console.error("Encryption error:", err);
        return "";
    }
}

function _fetchSignatureViaXhr(onSuccess, onError) {
    var platform = Office.context.diagnostics.platform;
    var xPlatform = platform === Office.PlatformType.Mac ? "MAC" : "WINDOWS";

    encryptEmail(Office.context.mailbox.userProfile.emailAddress)
        .then(function (encryptedMail) {
            console.warn("[CardByte] Classic: Encrypted Email...", encryptedMail);

            var xhr = new XMLHttpRequest();
            xhr.open("GET", XHR_URL, true);
            xhr.timeout = XHR_TIMEOUT_MS;
            xhr.setRequestHeader("Accept", "application/json");
            xhr.setRequestHeader("username", encryptedMail);
            xhr.setRequestHeader("X-Platform", xPlatform);

            xhr.onreadystatechange = function () {
                if (xhr.readyState !== 4) return;
                if (xhr.status >= 200 && xhr.status < 300) {
                    handleAesDecrypt(xhr.responseText)
                        .then(function (decryptedData) {
                            try {
                                var parsed = JSON.parse(decryptedData);
                                var html = parsed && parsed.html ? parsed.html : null;
                                if (html) {
                                    console.log("[CardByte] Classic: XHR succeeded — html length:", html.length);
                                    onSuccess(html);
                                } else {
                                    console.warn("[CardByte] Classic: XHR response missing html field — falling back");
                                    onError("missing-html");
                                }
                            } catch (parseErr) {
                                console.warn("[CardByte] Classic: XHR JSON parse error:", parseErr, "— falling back");
                                onError("parse-error");
                            }
                        })
                        .catch(function (decryptErr) {
                            console.warn("[CardByte] Classic: AES decrypt failed:", decryptErr, "— falling back");
                            onError("decrypt-error");
                        });
                } else {
                    console.warn("[CardByte] Classic: XHR HTTP", xhr.status, "— falling back");
                    onError("http-" + xhr.status);
                }
            };

            xhr.ontimeout = function () {
                console.warn("[CardByte] Classic: XHR timed out after", XHR_TIMEOUT_MS, "ms — falling back");
                onError("timeout");
            };

            xhr.onerror = function () {
                console.warn("[CardByte] Classic: XHR network error — falling back");
                onError("network-error");
            };

            xhr.send();
        })
        .catch(function (encryptErr) {
            console.warn("[CardByte] Classic: Email encryption failed:", encryptErr, "— falling back");
            onError("encrypt-error");
        });
}
// =============================================================================
// Core apply logic
//
// Primary   → XHR to CardByte backend (http://domain:4000/event-handler-classic).
//             data.key from the response is inserted as the signature HTML.
// Fallback  → roamingSettings / mem cache (SharedRuntime-populated).
// Both fail → inject visible error into compose body so user is informed.
// =============================================================================
function applySignatureCore(item, event) {
    console.log("[CardByte] Classic: applySignatureCore — attempting XHR");

    _fetchSignatureViaXhr(
        // ── XHR success ──────────────────────────────────────────────────────
        function (signatureHtml) {
            setSignature(item, _buildWrapped(signatureHtml), function (ok) {
                if (!ok) console.warn("[CardByte] Classic: XHR signature write failed");
                event.completed();
            });
        },
        // ── XHR failure → fall back to cache ─────────────────────────────────
        function (reason) {
            console.warn("[CardByte] Classic: XHR failed (" + reason + ") — checking cache");
            var cached = getCached();
            if (cached) {
                console.log("[CardByte] Classic: cache hit — writing cached signature");
                setSignature(item, _buildWrapped(cached), function (ok) {
                    if (!ok) console.warn("[CardByte] Classic: cached signature write failed");
                    event.completed();
                });
                return;
            }
            // Both XHR and cache failed — diagnose and inject error.
            var rsRaw = null;
            try { rsRaw = Office.context.roamingSettings.get(CACHE_KEY); } catch (e) { }
            console.error(
                "[CardByte] Classic: XHR + cache MISS — roamingSettings entry:",
                rsRaw,
                "| _memStore entry:", _memStore[CACHE_KEY]
            );
            console.warn("[CardByte] Classic: injecting error message into compose body");
            setSignature(item, ERROR_HTML, function (ok) {
                if (!ok) console.error("[CardByte] Classic: error injection also failed");
                event.completed();
            });
        }
    );
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

    // At send time, attempt XHR first for the freshest signature,
    // then fall back to cache if XHR fails.
    _fetchSignatureViaXhr(
        function (signatureHtml) {
            setSignature(item, _buildWrapped(signatureHtml), function () {
                guarded.completed({ allowEvent: true });
            });
        },
        function (reason) {
            console.warn("[CardByte] Classic: onSendHandler XHR failed (" + reason + ") — checking cache");
            var html = getCached();
            if (html) {
                // Re-apply latest cached signature at send time to catch any updates.
                setSignature(item, _buildWrapped(html), function () {
                    guarded.completed({ allowEvent: true });
                });
            } else {
                // Cache still absent at send time — allow send but log clearly.
                console.error("[CardByte] Classic: onSendHandler — XHR + cache absent at send time, sending without signature");
                guarded.completed({ allowEvent: true });
            }
        }
    );
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