/**
 * CardByte Signature Manager — event-handler-classic.js
 * =============================================================================
 *
 * Target runtime: Classic Outlook for Windows — JSRuntime (Office.js LaunchEvent)
 *
 * This handler is the JSRuntime override for Classic Outlook on Windows. Other
 * Outlook surfaces (New Outlook, OWA, Mac, mobile) load the WebView build at
 * event.html. See manifest.xml → v11.JSRuntime.Url for the manifest binding.
 *
 * Responsibilities
 * ----------------
 *   applySignature        — OnNewMessageCompose handler
 *                           Fetch the signature for the current From-address
 *                           and write it into the compose body.
 *
 *   onSendHandler         — OnMessageSend handler (pass-through)
 *                           Allow the send unconditionally within Outlook's
 *                           ~5-second hard budget. The signature should
 *                           already be in the body from applySignature; no
 *                           XHR is performed here, which prevents the
 *                           "add-in is unavailable" dialog.
 *
 *   onFromChangedHandler  — OnMessageFromChanged handler
 *                           Re-fetch the signature for the new From-address.
 *
 * Design notes
 * ------------
 *   - Encryption uses Web Crypto (`crypto.subtle`). If this turns out to be
 *     unavailable in some JSRuntime build, the diagnostic log will point to
 *     the exact failure and we fall back to a CryptoJS-bundled variant
 *     (see git history). The original assumption that JSRuntime is
 *     crypto-less was never empirically verified for current builds.
 *
 *   - The Office.js LaunchEvent runtime in Classic Outlook does not expose a
 *     console. A short diagnostic block is prepended to the compose body so
 *     the operator can read what the handler did. Toggle DIAG_ENABLED below
 *     to disable it for production builds.
 *
 *   - Required infrastructure for this file to run successfully:
 *       1. Manifest <AppDomains> lists the backend host.
 *       2. /.well-known/microsoft-officeaddins-allowed.json on the add-in
 *          origin lists this file's absolute URL under "allowed".
 *     Without both, every XHR returns status 0 / onerror.
 */
"use strict";

// ─── Configuration ────────────────────────────────────────────────────────────

var CONFIG = {
    // Backend endpoint. Sends encrypted email in `username` header.
    XHR_URL: "https://newqa-enterprise.cardbyte.ai/email-signature/html/outlook/get-active",
    XHR_TIMEOUT_MS: 6000,

    // AES-CBC key + IV (base64). Same scheme as WebView clients so the backend
    // protocol is identical.
    //
    // TODO(security): Move encryption server-side and stop shipping the key in
    // client code. Tracked separately.
    AES_KEY_B64: "fnItrY2YfozBqCC2B4XsfqHIvZku3kUOq3DFkbO64kk=",
    AES_IV_B64: "3YapeNfJDung7TXxeKXn4g==",

    // Signature cache key for Office.roamingSettings.
    CACHE_KEY: "cardbyte_sig_html",

    // Visible spacing wrapped around the signature when written to body.
    WRAP_TOP_PX: 40,
    WRAP_BOTTOM_PX: 40,

    // Send handler must complete within Outlook's hard send budget (~5s).
    SEND_HANDLER_TIMEOUT_MS: 3000,

    // Compose / from-changed handlers have a softer budget.
    COMPOSE_HANDLER_TIMEOUT_MS: 10000,

    // Set to false for production builds. When true, every applySignature
    // invocation prepends a yellow diagnostic block to the compose body.
    DIAG_ENABLED: true
};

// ─── Diagnostic log ───────────────────────────────────────────────────────────
//
// Buffer is flushed into the compose body at the end of applySignature.
// Classic Outlook on Windows has no accessible console, so this is the only
// way to read runtime state during development.

var _diag = (function () {
    var buf = [];

    function push(level, msg) {
        buf.push("[" + new Date().toISOString() + "] [" + level + "] " + msg);
        // console may not exist on JSRuntime — guard the call.
        try { if (typeof console !== "undefined") console.log("[CardByte]", level, msg); } catch (_) { }
    }

    function buildHtmlBlock() {
        var escaped = buf.join("\n")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");

        return [
            "<div style='",
            "margin:0 0 16px 0;",
            "padding:12px 16px;",
            "border:2px solid #d9534f;",
            "border-radius:4px;",
            "background-color:#fff3cd;",
            "font-family:Consolas,Courier New,monospace;",
            "font-size:11px;",
            "color:#333;",
            "white-space:pre-wrap;",
            "'>",
            "<strong style='color:#d9534f;font-size:13px;'>",
            "[CardByte DIAGNOSTIC LOG — DELETE THIS BLOCK BEFORE SENDING]",
            "</strong><br/><br/>",
            escaped,
            "</div>"
        ].join("");
    }

    return {
        info: function (m) { push("INFO", m); },
        warn: function (m) { push("WARN", m); },
        error: function (m) { push("ERROR", m); },
        html: buildHtmlBlock
    };
})();

// ─── Base64 ↔ ArrayBuffer ─────────────────────────────────────────────────────

function _base64ToArrayBuffer(b64) {
    var bin = atob(b64);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
}

function _arrayBufferToBase64(buffer) {
    var bytes = new Uint8Array(buffer);
    var bin = "";
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
}

// ─── Encryption (Web Crypto AES-CBC) ──────────────────────────────────────────

/**
 * Encrypts the user's email address using AES-CBC. The base64 ciphertext is
 * sent in the `username` request header.
 *
 * Returns a Promise resolving to the base64 ciphertext, or rejecting with the
 * underlying error. The caller is expected to catch and fall back gracefully.
 */
function encryptEmail(email) {
    if (!email || !email.trim()) {
        return Promise.reject(new Error("encryptEmail: empty email"));
    }
    if (typeof crypto === "undefined" || !crypto.subtle) {
        return Promise.reject(new Error("encryptEmail: crypto.subtle unavailable in this runtime"));
    }

    var keyBuf = _base64ToArrayBuffer(CONFIG.AES_KEY_B64);
    var ivBuf = _base64ToArrayBuffer(CONFIG.AES_IV_B64);
    var dataBuf = new TextEncoder().encode(email);

    return crypto.subtle
        .importKey("raw", keyBuf, { name: "AES-CBC" }, false, ["encrypt"])
        .then(function (key) {
            return crypto.subtle.encrypt({ name: "AES-CBC", iv: ivBuf }, key, dataBuf);
        })
        .then(_arrayBufferToBase64);
}

/**
 * Decrypts the backend response. Returns a Promise resolving to the plaintext
 * string (typically JSON).
 */
function decryptResponse(cipherB64) {
    if (!cipherB64) return Promise.reject(new Error("decryptResponse: empty input"));
    if (typeof crypto === "undefined" || !crypto.subtle) {
        return Promise.reject(new Error("decryptResponse: crypto.subtle unavailable in this runtime"));
    }

    var keyBuf = _base64ToArrayBuffer(CONFIG.AES_KEY_B64);
    var ivBuf = _base64ToArrayBuffer(CONFIG.AES_IV_B64);
    var cipherBuf = _base64ToArrayBuffer(cipherB64);

    return crypto.subtle
        .importKey("raw", keyBuf, { name: "AES-CBC" }, false, ["decrypt"])
        .then(function (key) {
            return crypto.subtle.decrypt({ name: "AES-CBC", iv: ivBuf }, key, cipherBuf);
        })
        .then(function (plainBuf) {
            return new TextDecoder().decode(plainBuf);
        });
}

// ─── Cache (Office.roamingSettings + in-process memo) ─────────────────────────

var _memCache = {};

function cacheGet() {
    if (_memCache[CONFIG.CACHE_KEY]) {
        _diag.info("Cache hit (mem)");
        return _memCache[CONFIG.CACHE_KEY].html;
    }
    try {
        var entry = Office.context.roamingSettings.get(CONFIG.CACHE_KEY);
        if (entry && entry.html) {
            _diag.info("Cache hit (roamingSettings) — size: " + entry.html.length);
            _memCache[CONFIG.CACHE_KEY] = entry;
            return entry.html;
        }
    } catch (e) {
        _diag.warn("roamingSettings.get threw: " + e.message);
    }
    _diag.info("Cache miss");
    return null;
}

function cacheSet(html) {
    var entry = { html: html, ts: Date.now() };
    _memCache[CONFIG.CACHE_KEY] = entry;
    try {
        Office.context.roamingSettings.set(CONFIG.CACHE_KEY, entry);
        Office.context.roamingSettings.saveAsync(function () { });
    } catch (e) {
        _diag.warn("roamingSettings.set threw: " + e.message);
    }
}

function cacheClear() {
    delete _memCache[CONFIG.CACHE_KEY];
    try {
        Office.context.roamingSettings.remove(CONFIG.CACHE_KEY);
        Office.context.roamingSettings.saveAsync(function () { });
    } catch (_) { }
}

// ─── Compose-body write path ──────────────────────────────────────────────────

function _wrapSignature(html) {
    return "<div style='margin-top:" + CONFIG.WRAP_TOP_PX + "px'></div>"
        + html
        + "<div style='margin-top:" + CONFIG.WRAP_BOTTOM_PX + "px'></div>";
}

/**
 * Writes a signature HTML block into the compose body. Tries
 * setSignatureAsync (the recommended API) first, falling back to
 * prependAsync if the former is unavailable or fails.
 *
 * Calls onDone(success: boolean).
 */
function writeSignature(item, html, onDone) {
    function fallbackPrepend() {
        if (typeof item.body.prependAsync !== "function") {
            _diag.error("No write path available — neither setSignatureAsync nor prependAsync");
            onDone(false);
            return;
        }
        item.body.prependAsync(
            html,
            { coercionType: Office.CoercionType.Html },
            function (result) {
                var ok = result.status === Office.AsyncResultStatus.Succeeded;
                if (!ok) _diag.error("prependAsync failed: " + (result.error && result.error.message));
                onDone(ok);
            }
        );
    }

    if (typeof item.body.setSignatureAsync !== "function") {
        _diag.warn("setSignatureAsync unavailable — using prependAsync");
        fallbackPrepend();
        return;
    }

    item.body.setSignatureAsync(
        html,
        { coercionType: Office.CoercionType.Html },
        function (result) {
            if (result.status === Office.AsyncResultStatus.Succeeded) {
                _diag.info("setSignatureAsync succeeded");
                onDone(true);
            } else {
                _diag.warn("setSignatureAsync failed: "
                    + (result.error && result.error.message)
                    + " — trying prependAsync");
                fallbackPrepend();
            }
        }
    );
}

/**
 * Prepends the diagnostic log block to the compose body. No-op when
 * CONFIG.DIAG_ENABLED is false. Always calls onDone() so the event
 * lifecycle can complete.
 */
function writeDiagnostics(item, onDone) {
    if (!CONFIG.DIAG_ENABLED) { onDone(); return; }
    if (typeof item.body.prependAsync !== "function") {
        _diag.warn("Cannot inject diagnostics — prependAsync unavailable");
        onDone();
        return;
    }
    item.body.prependAsync(
        _diag.html(),
        { coercionType: Office.CoercionType.Html },
        function () { onDone(); }
    );
}

// ─── Backend fetch ────────────────────────────────────────────────────────────

/**
 * Resolves the user's email + platform from the Office context.
 * Throws on missing email.
 */
function resolveContext() {
    var email = "";
    var platform = "WINDOWS";
    try {
        email = (Office.context.mailbox.userProfile.emailAddress || "").trim();
        var p = Office.context.diagnostics.platform;
        if (p === Office.PlatformType.Mac || p === "Mac") platform = "MAC";
    } catch (e) {
        throw new Error("resolveContext: " + e.message);
    }
    if (!email) throw new Error("resolveContext: no email address available");
    return { email: email, platform: platform };
}

/**
 * Fetches the signature HTML from the backend. Calls onSuccess(html) on a
 * fully successful round-trip, otherwise onError(reasonString).
 *
 * The encrypted email travels in the `username` request header, matching the
 * WebView client protocol exactly.
 */
function fetchSignature(onSuccess, onError) {
    var ctx;
    try {
        ctx = resolveContext();
    } catch (e) {
        _diag.error(e.message);
        onError("context-error");
        return;
    }

    _diag.info("Email: " + ctx.email + " | Platform: " + ctx.platform);
    _diag.info("crypto.subtle available: " + (typeof crypto !== "undefined" && !!crypto.subtle));

    encryptEmail(ctx.email).then(function (encrypted) {
        _diag.info("Encrypted email: " + encrypted);

        var xhr;
        try { xhr = new XMLHttpRequest(); }
        catch (e) {
            _diag.error("XHR constructor threw: " + e.message);
            onError("xhr-construct-error");
            return;
        }

        try {
            xhr.open("GET", CONFIG.XHR_URL, true);
            xhr.timeout = CONFIG.XHR_TIMEOUT_MS;
            xhr.setRequestHeader("username", encrypted);
            xhr.setRequestHeader("X-Platform", ctx.platform);
        } catch (e) {
            _diag.error("xhr.open/setRequestHeader threw: " + e.message);
            onError("xhr-setup-error");
            return;
        }

        xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4) return;

            _diag.info("XHR readyState=4 | status=" + xhr.status
                + " | statusText=" + (xhr.statusText || "(empty)"));

            // Log response headers (empty = CORS-blocked at network/runtime layer).
            try {
                var h = xhr.getAllResponseHeaders();
                _diag.info("Response headers: "
                    + (h ? h.replace(/\r\n/g, " | ") : "(empty — likely CORS/runtime block)"));
            } catch (e) {
                _diag.warn("getAllResponseHeaders threw: " + e.message);
            }

            if (xhr.status >= 200 && xhr.status < 300) {
                _diag.info("Response body length: " + (xhr.responseText ? xhr.responseText.length : 0));

                decryptResponse(xhr.responseText).then(function (plaintext) {
                    var parsed;
                    try { parsed = JSON.parse(plaintext); }
                    catch (parseErr) {
                        _diag.warn("Decrypted JSON parse error: " + parseErr.message
                            + " | preview: " + plaintext.substring(0, 200));
                        onError("parse-error");
                        return;
                    }
                    var html = parsed && parsed.html;
                    if (!html) {
                        _diag.warn("Decrypted payload missing 'html' field. Preview: "
                            + plaintext.substring(0, 200));
                        onError("missing-html");
                        return;
                    }
                    _diag.info("Signature decoded — html length: " + html.length);
                    onSuccess(html);
                })["catch"](function (decErr) {
                    _diag.error("Decryption failed: " + decErr.message);
                    onError("decrypt-failed");
                });
            } else {
                _diag.warn("XHR HTTP " + xhr.status + " — non-2xx response");
                onError("http-" + xhr.status);
            }
        };

        xhr.ontimeout = function () {
            _diag.warn("XHR timed out after " + CONFIG.XHR_TIMEOUT_MS + " ms");
            onError("timeout");
        };

        xhr.onerror = function () {
            // status:0 + onerror with empty response headers signals the
            // request never reached the network — typically a missing
            // well-known authorization or AppDomains entry.
            _diag.error("XHR onerror — status: " + xhr.status
                + " (connection/CORS/runtime block before HTTP response)");
            onError("network-error");
        };

        try {
            xhr.send();
            _diag.info("xhr.send() dispatched");
        } catch (e) {
            _diag.error("xhr.send threw: " + e.message);
            onError("xhr-send-error");
        }
    })["catch"](function (encErr) {
        _diag.error("Email encryption failed: " + encErr.message);
        onError("encrypt-failed");
    });
}

// ─── Apply flow ───────────────────────────────────────────────────────────────

/**
 * Tries the backend first, then the cache, then gives up gracefully.
 * Always completes the event when done.
 */
function applySignatureCore(item, guardedEvent) {
    _diag.info("applySignatureCore — attempting backend");

    fetchSignature(
        // Success — write fetched signature, refresh cache.
        function (html) {
            cacheSet(html);
            writeSignature(item, _wrapSignature(html), function (ok) {
                if (!ok) _diag.warn("Fetched signature write failed");
                writeDiagnostics(item, function () { guardedEvent.completed(); });
            });
        },
        // Failure — fall back to cache.
        function (reason) {
            _diag.warn("Backend failed (" + reason + ") — falling back to cache");
            var cached = cacheGet();
            if (cached) {
                writeSignature(item, _wrapSignature(cached), function (ok) {
                    if (!ok) _diag.warn("Cached signature write failed");
                    writeDiagnostics(item, function () { guardedEvent.completed(); });
                });
            } else {
                _diag.error("Backend miss + cache miss — no signature to write");
                writeDiagnostics(item, function () { guardedEvent.completed(); });
            }
        }
    );
}

// ─── Guarded event.completed ──────────────────────────────────────────────────
//
// Outlook's LaunchEvent runtime hard-kills the handler if event.completed()
// is not called within the platform budget. We wrap the raw event in a
// guard that fires completed() at most once, with a safety timer.

function makeGuardedEvent(event, timeoutMs) {
    var done = false;
    var timer = setTimeout(function () {
        if (done) return;
        _diag.warn("Event guard timeout (" + timeoutMs + "ms) — forcing complete");
        complete();
    }, timeoutMs);

    function complete(opts) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try {
            if (opts) event.completed(opts);
            else event.completed();
        } catch (e) {
            _diag.error("event.completed threw: " + e.message);
        }
    }
    return { completed: complete };
}

// ─── Event handlers ───────────────────────────────────────────────────────────

function applySignature(event) {
    var guarded = makeGuardedEvent(event || { completed: function () { } },
        CONFIG.COMPOSE_HANDLER_TIMEOUT_MS);
    _diag.info("=== applySignature START ===");

    var item = _safeGetItem();
    if (!item) {
        _diag.error("No mailbox item available");
        guarded.completed();
        return;
    }

    applySignatureCore(item, guarded);
}

/**
 * Send handler is intentionally a pass-through. The signature is already in
 * the compose body from applySignature, so re-fetching here would only add
 * latency and risk exceeding Outlook's ~5-second send budget — which is what
 * triggers the "add-in is unavailable" dialog.
 */
function onSendHandler(event) {
    var guarded = makeGuardedEvent(event || { completed: function () { } },
        CONFIG.SEND_HANDLER_TIMEOUT_MS);
    _diag.info("onSendHandler — pass-through (allowEvent=true)");
    guarded.completed({ allowEvent: true });
}

function onFromChangedHandler(event) {
    var guarded = makeGuardedEvent(event || { completed: function () { } },
        CONFIG.COMPOSE_HANDLER_TIMEOUT_MS);
    _diag.info("onFromChangedHandler fired — clearing cache and re-fetching");

    var item = _safeGetItem();
    if (!item) { guarded.completed(); return; }

    cacheClear();
    applySignatureCore(item, guarded);
}

function _safeGetItem() {
    try {
        return Office && Office.context && Office.context.mailbox
            ? Office.context.mailbox.item
            : null;
    } catch (_) { return null; }
}

// ─── Registration ─────────────────────────────────────────────────────────────
//
// Office.actions.associate MUST be called synchronously at top level. The
// runtime evaluates the file, registers handlers, then dispatches events
// against the names. Wrapping this in Office.onReady or any async wrapper
// causes silent registration failures.

(function registerHandlers() {
    if (typeof Office === "undefined" || !Office.actions) {
        _diag.error("Office.actions unavailable — handler registration skipped");
        return;
    }
    try {
        Office.actions.associate("applySignature", applySignature);
        Office.actions.associate("onSendHandler", onSendHandler);
        Office.actions.associate("onFromChangedHandler", onFromChangedHandler);
        _diag.info("Handlers registered. crypto.subtle: "
            + (typeof crypto !== "undefined" && !!crypto.subtle));
    } catch (e) {
        _diag.error("Office.actions.associate threw: " + e.message);
    }
})();
