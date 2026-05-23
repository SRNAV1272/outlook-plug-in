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
 * AES-CBC encryption is implemented here in pure ES5 (no Web Crypto) so the
 * email address is encrypted the same way as the modern handler before being
 * sent to the server.
 *
 * This file is referenced by the manifest's JSRuntime.Url override so it loads
 * only in Classic Outlook. All other platforms use the modern event-handler.js.
 *
 * Events handled:
 *   OnNewMessageCompose   → applySignature       (req set 1.10)
 *   OnMessageSend         → onSendHandler        (req set 1.12, SoftBlock)
 *   OnMessageFromChanged  → onFromChangedHandler (req set 1.13)
 */

"use strict";

// =============================================================================
// AES / Crypto constants  (must match modern event-handler.js exactly)
// =============================================================================
var AES_KEY = "fnItrY2YfozBqCC2B4XsfqHIvZku3kUOq3DFkbO64kk=";
var AES_IV = "3YapeNfJDung7TXxeKXn4g==";

// =============================================================================
// Base64 helpers (no atob/btoa reliability issues in JS-only runtime)
// =============================================================================
var B64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function b64Encode(bytes) {
    var result = "";
    var i;
    for (i = 0; i < bytes.length - 2; i += 3) {
        result += B64_CHARS[(bytes[i] >> 2) & 0x3F];
        result += B64_CHARS[((bytes[i] & 0x03) << 4) | ((bytes[i + 1] >> 4) & 0x0F)];
        result += B64_CHARS[((bytes[i + 1] & 0x0F) << 2) | ((bytes[i + 2] >> 6) & 0x03)];
        result += B64_CHARS[bytes[i + 2] & 0x3F];
    }
    var rem = bytes.length % 3;
    if (rem === 1) {
        result += B64_CHARS[(bytes[i] >> 2) & 0x3F];
        result += B64_CHARS[(bytes[i] & 0x03) << 4];
        result += "==";
    } else if (rem === 2) {
        result += B64_CHARS[(bytes[i] >> 2) & 0x3F];
        result += B64_CHARS[((bytes[i] & 0x03) << 4) | ((bytes[i + 1] >> 4) & 0x0F)];
        result += B64_CHARS[(bytes[i + 1] & 0x0F) << 2];
        result += "=";
    }
    return result;
}

function b64Decode(str) {
    // Normalise URL-safe base64 and strip padding variation
    str = str.replace(/-/g, "+").replace(/_/g, "/");
    var pad = str.length % 4;
    if (pad === 2) str += "==";
    else if (pad === 3) str += "=";

    var lookup = new Array(256);
    for (var c = 0; c < B64_CHARS.length; c++) lookup[B64_CHARS.charCodeAt(c)] = c;
    lookup["=".charCodeAt(0)] = 0;

    var out = [];
    for (var i = 0; i < str.length; i += 4) {
        var a = lookup[str.charCodeAt(i)];
        var b = lookup[str.charCodeAt(i + 1)];
        var cv = lookup[str.charCodeAt(i + 2)];
        var d = lookup[str.charCodeAt(i + 3)];
        out.push((a << 2) | (b >> 4));
        if (str[i + 2] !== "=") out.push(((b & 0x0F) << 4) | (cv >> 2));
        if (str[i + 3] !== "=") out.push(((cv & 0x03) << 6) | d);
    }
    return out;   // plain Array of byte values
}

// =============================================================================
// Pure-JS AES-CBC encryption (ES5, no Web Crypto)
//
// Implements FIPS-197 AES + CBC mode with PKCS#7 padding.
// Produces output byte-identical to window.crypto.subtle AES-CBC encryption
// using the same key and IV.
// =============================================================================

// AES S-box
var SBOX = [
    0x63, 0x7c, 0x77, 0x7b, 0xf2, 0x6b, 0x6f, 0xc5, 0x30, 0x01, 0x67, 0x2b, 0xfe, 0xd7, 0xab, 0x76,
    0xca, 0x82, 0xc9, 0x7d, 0xfa, 0x59, 0x47, 0xf0, 0xad, 0xd4, 0xa2, 0xaf, 0x9c, 0xa4, 0x72, 0xc0,
    0xb7, 0xfd, 0x93, 0x26, 0x36, 0x3f, 0xf7, 0xcc, 0x34, 0xa5, 0xe5, 0xf1, 0x71, 0xd8, 0x31, 0x15,
    0x04, 0xc7, 0x23, 0xc3, 0x18, 0x96, 0x05, 0x9a, 0x07, 0x12, 0x80, 0xe2, 0xeb, 0x27, 0xb2, 0x75,
    0x09, 0x83, 0x2c, 0x1a, 0x1b, 0x6e, 0x5a, 0xa0, 0x52, 0x3b, 0xd6, 0xb3, 0x29, 0xe3, 0x2f, 0x84,
    0x53, 0xd1, 0x00, 0xed, 0x20, 0xfc, 0xb1, 0x5b, 0x6a, 0xcb, 0xbe, 0x39, 0x4a, 0x4c, 0x58, 0xcf,
    0xd0, 0xef, 0xaa, 0xfb, 0x43, 0x4d, 0x33, 0x85, 0x45, 0xf9, 0x02, 0x7f, 0x50, 0x3c, 0x9f, 0xa8,
    0x51, 0xa3, 0x40, 0x8f, 0x92, 0x9d, 0x38, 0xf5, 0xbc, 0xb6, 0xda, 0x21, 0x10, 0xff, 0xf3, 0xd2,
    0xcd, 0x0c, 0x13, 0xec, 0x5f, 0x97, 0x44, 0x17, 0xc4, 0xa7, 0x7e, 0x3d, 0x64, 0x5d, 0x19, 0x73,
    0x60, 0x81, 0x4f, 0xdc, 0x22, 0x2a, 0x90, 0x88, 0x46, 0xee, 0xb8, 0x14, 0xde, 0x5e, 0x0b, 0xdb,
    0xe0, 0x32, 0x3a, 0x0a, 0x49, 0x06, 0x24, 0x5c, 0xc2, 0xd3, 0xac, 0x62, 0x91, 0x95, 0xe4, 0x79,
    0xe7, 0xc8, 0x37, 0x6d, 0x8d, 0xd5, 0x4e, 0xa9, 0x6c, 0x56, 0xf4, 0xea, 0x65, 0x7a, 0xae, 0x08,
    0xba, 0x78, 0x25, 0x2e, 0x1c, 0xa6, 0xb4, 0xc6, 0xe8, 0xdd, 0x74, 0x1f, 0x4b, 0xbd, 0x8b, 0x8a,
    0x70, 0x3e, 0xb5, 0x66, 0x48, 0x03, 0xf6, 0x0e, 0x61, 0x35, 0x57, 0xb9, 0x86, 0xc1, 0x1d, 0x9e,
    0xe1, 0xf8, 0x98, 0x11, 0x69, 0xd9, 0x8e, 0x94, 0x9b, 0x1e, 0x87, 0xe9, 0xce, 0x55, 0x28, 0xdf,
    0x8c, 0xa1, 0x89, 0x0d, 0xbf, 0xe6, 0x42, 0x68, 0x41, 0x99, 0x2d, 0x0f, 0xb0, 0x54, 0xbb, 0x16
];

// AES round constants
var RCON = [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36];

function xtime(b) { return ((b << 1) ^ ((b & 0x80) ? 0x1b : 0)) & 0xff; }

function gmul(a, b) {
    var p = 0, i;
    for (i = 0; i < 8; i++) {
        if (b & 1) p ^= a;
        var hiBit = a & 0x80;
        a = (a << 1) & 0xff;
        if (hiBit) a ^= 0x1b;
        b >>= 1;
    }
    return p;
}

// Key expansion — supports 128-bit (16 bytes) and 256-bit (32 bytes) keys
function aesKeyExpansion(keyBytes) {
    var nk = keyBytes.length / 4;   // 4 or 8
    var nr = nk + 6;                // 10 or 14 rounds
    var w = [];
    var i;

    // Copy original key into w as 4-byte words
    for (i = 0; i < nk; i++) {
        w[i] = [keyBytes[4 * i], keyBytes[4 * i + 1], keyBytes[4 * i + 2], keyBytes[4 * i + 3]];
    }

    for (i = nk; i < 4 * (nr + 1); i++) {
        var temp = w[i - 1].slice();
        if (i % nk === 0) {
            // RotWord + SubWord + Rcon
            temp = [SBOX[temp[1]], SBOX[temp[2]], SBOX[temp[3]], SBOX[temp[0]]];
            temp[0] ^= RCON[(i / nk) - 1];
        } else if (nk > 6 && i % nk === 4) {
            temp = [SBOX[temp[0]], SBOX[temp[1]], SBOX[temp[2]], SBOX[temp[3]]];
        }
        w[i] = [
            w[i - nk][0] ^ temp[0],
            w[i - nk][1] ^ temp[1],
            w[i - nk][2] ^ temp[2],
            w[i - nk][3] ^ temp[3]
        ];
    }
    return { w: w, nr: nr };
}

// Add round key (XOR state columns with key schedule words)
function addRoundKey(state, w, round) {
    for (var c = 0; c < 4; c++) {
        for (var r = 0; r < 4; r++) {
            state[r][c] ^= w[round * 4 + c][r];
        }
    }
}

function subBytes(state) {
    for (var r = 0; r < 4; r++)
        for (var c = 0; c < 4; c++)
            state[r][c] = SBOX[state[r][c]];
}

function shiftRows(state) {
    var tmp;
    // Row 1: shift left 1
    tmp = state[1][0]; state[1][0] = state[1][1]; state[1][1] = state[1][2]; state[1][2] = state[1][3]; state[1][3] = tmp;
    // Row 2: shift left 2
    tmp = state[2][0]; state[2][0] = state[2][2]; state[2][2] = tmp;
    tmp = state[2][1]; state[2][1] = state[2][3]; state[2][3] = tmp;
    // Row 3: shift left 3 (= shift right 1)
    tmp = state[3][3]; state[3][3] = state[3][2]; state[3][2] = state[3][1]; state[3][1] = state[3][0]; state[3][0] = tmp;
}

function mixColumns(state) {
    for (var c = 0; c < 4; c++) {
        var s0 = state[0][c], s1 = state[1][c], s2 = state[2][c], s3 = state[3][c];
        state[0][c] = gmul(0x02, s0) ^ gmul(0x03, s1) ^ s2 ^ s3;
        state[1][c] = s0 ^ gmul(0x02, s1) ^ gmul(0x03, s2) ^ s3;
        state[2][c] = s0 ^ s1 ^ gmul(0x02, s2) ^ gmul(0x03, s3);
        state[3][c] = gmul(0x03, s0) ^ s1 ^ s2 ^ gmul(0x02, s3);
    }
}

// Encrypt a single 16-byte block — returns Array of 16 byte values
function aesEncryptBlock(blockBytes, keySchedule) {
    var nr = keySchedule.nr;
    var w = keySchedule.w;

    // Build 4x4 state matrix (column-major)
    var state = [[], [], [], []];
    var i, r, c;
    for (c = 0; c < 4; c++)
        for (r = 0; r < 4; r++)
            state[r][c] = blockBytes[c * 4 + r];

    addRoundKey(state, w, 0);

    for (var round = 1; round < nr; round++) {
        subBytes(state);
        shiftRows(state);
        mixColumns(state);
        addRoundKey(state, w, round);
    }
    // Final round (no MixColumns)
    subBytes(state);
    shiftRows(state);
    addRoundKey(state, w, nr);

    // Flatten back to byte array
    var out = new Array(16);
    for (c = 0; c < 4; c++)
        for (r = 0; r < 4; r++)
            out[c * 4 + r] = state[r][c];
    return out;
}

// PKCS#7 padding
function pkcs7Pad(bytes, blockSize) {
    var pad = blockSize - (bytes.length % blockSize);
    var result = bytes.slice();
    for (var i = 0; i < pad; i++) result.push(pad);
    return result;
}

/**
 * aesEncryptCBC(plaintext, keyBase64, ivBase64) → base64 ciphertext string
 *
 * Byte-identical output to:
 *   window.crypto.subtle.encrypt({ name:"AES-CBC", iv }, key, data)
 */
function aesEncryptCBC(plaintext, keyBase64, ivBase64) {
    // Decode key and IV
    var keyBytes = b64Decode(keyBase64);
    var ivBytes = b64Decode(ivBase64);

    // UTF-8 encode plaintext (ASCII-safe for email addresses)
    var msgBytes = [];
    for (var i = 0; i < plaintext.length; i++) {
        var code = plaintext.charCodeAt(i);
        if (code < 0x80) {
            msgBytes.push(code);
        } else if (code < 0x800) {
            msgBytes.push(0xC0 | (code >> 6));
            msgBytes.push(0x80 | (code & 0x3F));
        } else {
            msgBytes.push(0xE0 | (code >> 12));
            msgBytes.push(0x80 | ((code >> 6) & 0x3F));
            msgBytes.push(0x80 | (code & 0x3F));
        }
    }

    // PKCS#7 pad to block boundary
    msgBytes = pkcs7Pad(msgBytes, 16);

    // Expand key once
    var keySchedule = aesKeyExpansion(keyBytes);

    // CBC encrypt
    var prev = ivBytes;
    var cipherBytes = [];
    for (var b = 0; b < msgBytes.length; b += 16) {
        var block = msgBytes.slice(b, b + 16);
        // XOR with previous ciphertext block (or IV for first block)
        for (var j = 0; j < 16; j++) block[j] ^= prev[j];
        var encrypted = aesEncryptBlock(block, keySchedule);
        cipherBytes = cipherBytes.concat(encrypted);
        prev = encrypted;
    }

    return b64Encode(cipherBytes);
}

/**
 * encryptEmail(email) → base64 ciphertext (synchronous)
 * Matches the modern handler's encryptEmail() output exactly.
 */
function encryptEmail(email) {
    if (!email || email.trim() === "") {
        console.warn("[CardByte] Classic: empty email for encryption");
        return "";
    }
    try {
        return aesEncryptCBC(email, AES_KEY, AES_IV);
    } catch (e) {
        console.error("[CardByte] Classic: encryption error:", e);
        return "";
    }
}

// =============================================================================
// In-memory store (localStorage unavailable in JS-only runtime)
// =============================================================================
var _memStore = {};
function memGet(k) { return Object.prototype.hasOwnProperty.call(_memStore, k) ? _memStore[k] : null; }
function memSet(k, v) { _memStore[k] = v; }
function memDel(k) { delete _memStore[k]; }

// =============================================================================
// Simple cache
// =============================================================================
var CACHE_KEY = "cardbyte_sig_html";
var CACHED_HTML = null;

function getCached() { return CACHED_HTML || memGet(CACHE_KEY); }
function setCache(html) { CACHED_HTML = html; memSet(CACHE_KEY, html); }
function clearCache() { CACHED_HTML = null; memDel(CACHE_KEY); }

// =============================================================================
// XHR helpers (replaces fetch + async/await)
// =============================================================================
function xhrGet(url, headers, onSuccess, onError) {
    var xhr = new XMLHttpRequest();
    xhr.open("GET", url, true);
    var keys = Object.keys(headers || {});
    for (var i = 0; i < keys.length; i++) xhr.setRequestHeader(keys[i], headers[keys[i]]);
    xhr.onreadystatechange = function () {
        if (xhr.readyState !== 4) return;
        if (xhr.status >= 200 && xhr.status < 300) onSuccess(xhr.responseText);
        else onError(xhr.status);
    };
    xhr.onerror = function () { onError(0); };
    xhr.send();
}

function xhrPost(url, headers, body, onSuccess, onError) {
    var xhr = new XMLHttpRequest();
    xhr.open("POST", url, true);
    var keys = Object.keys(headers || {});
    for (var i = 0; i < keys.length; i++) xhr.setRequestHeader(keys[i], headers[keys[i]]);
    xhr.onreadystatechange = function () {
        if (xhr.readyState !== 4) return;
        if (xhr.status >= 200 && xhr.status < 300) onSuccess(xhr.responseText);
        else onError(xhr.status);
    };
    xhr.onerror = function () { onError(0); };
    xhr.send(body);
}

// =============================================================================
// AES decrypt helper for server responses
// The server returns AES-CBC encrypted JSON — we need to decrypt it too.
// Uses the same pure-JS AES tables (inverse S-box path).
// =============================================================================
var INV_SBOX = (function () {
    var t = new Array(256);
    for (var i = 0; i < 256; i++) t[SBOX[i]] = i;
    return t;
}());

function invShiftRows(state) {
    var tmp;
    tmp = state[1][3]; state[1][3] = state[1][2]; state[1][2] = state[1][1]; state[1][1] = state[1][0]; state[1][0] = tmp;
    tmp = state[2][0]; state[2][0] = state[2][2]; state[2][2] = tmp;
    tmp = state[2][1]; state[2][1] = state[2][3]; state[2][3] = tmp;
    tmp = state[3][0]; state[3][0] = state[3][1]; state[3][1] = state[3][2]; state[3][2] = state[3][3]; state[3][3] = tmp;
}

function invSubBytes(state) {
    for (var r = 0; r < 4; r++)
        for (var c = 0; c < 4; c++)
            state[r][c] = INV_SBOX[state[r][c]];
}

function invMixColumns(state) {
    for (var c = 0; c < 4; c++) {
        var s0 = state[0][c], s1 = state[1][c], s2 = state[2][c], s3 = state[3][c];
        state[0][c] = gmul(0x0e, s0) ^ gmul(0x0b, s1) ^ gmul(0x0d, s2) ^ gmul(0x09, s3);
        state[1][c] = gmul(0x09, s0) ^ gmul(0x0e, s1) ^ gmul(0x0b, s2) ^ gmul(0x0d, s3);
        state[2][c] = gmul(0x0d, s0) ^ gmul(0x09, s1) ^ gmul(0x0e, s2) ^ gmul(0x0b, s3);
        state[3][c] = gmul(0x0b, s0) ^ gmul(0x0d, s1) ^ gmul(0x09, s2) ^ gmul(0x0e, s3);
    }
}

function aesDecryptBlock(blockBytes, keySchedule) {
    var nr = keySchedule.nr;
    var w = keySchedule.w;
    var state = [[], [], [], []];
    var r, c;
    for (c = 0; c < 4; c++)
        for (r = 0; r < 4; r++)
            state[r][c] = blockBytes[c * 4 + r];

    addRoundKey(state, w, nr);

    for (var round = nr - 1; round >= 1; round--) {
        invShiftRows(state);
        invSubBytes(state);
        addRoundKey(state, w, round);
        invMixColumns(state);
    }
    invShiftRows(state);
    invSubBytes(state);
    addRoundKey(state, w, 0);

    var out = new Array(16);
    for (c = 0; c < 4; c++)
        for (r = 0; r < 4; r++)
            out[c * 4 + r] = state[r][c];
    return out;
}

function aesDecryptCBC(cipherBase64, keyBase64, ivBase64) {
    var keyBytes = b64Decode(keyBase64);
    var ivBytes = b64Decode(ivBase64);
    var cipherBytes = b64Decode(cipherBase64);
    var keySchedule = aesKeyExpansion(keyBytes);

    var plainBytes = [];
    var prev = ivBytes;
    for (var b = 0; b < cipherBytes.length; b += 16) {
        var block = cipherBytes.slice(b, b + 16);
        var decrypted = aesDecryptBlock(block, keySchedule);
        for (var j = 0; j < 16; j++) decrypted[j] ^= prev[j];
        plainBytes = plainBytes.concat(decrypted);
        prev = block;
    }

    // Remove PKCS#7 padding
    var pad = plainBytes[plainBytes.length - 1];
    if (pad > 0 && pad <= 16) plainBytes = plainBytes.slice(0, plainBytes.length - pad);

    // UTF-8 decode
    var str = "";
    for (var i = 0; i < plainBytes.length;) {
        var byte1 = plainBytes[i++];
        if (byte1 < 0x80) {
            str += String.fromCharCode(byte1);
        } else if ((byte1 & 0xE0) === 0xC0) {
            str += String.fromCharCode(((byte1 & 0x1F) << 6) | (plainBytes[i++] & 0x3F));
        } else {
            str += String.fromCharCode(
                ((byte1 & 0x0F) << 12) |
                ((plainBytes[i++] & 0x3F) << 6) |
                (plainBytes[i++] & 0x3F)
            );
        }
    }
    return str;
}

function handleAesDecrypt(encryptedText) {
    if (!encryptedText) return "";
    try {
        return aesDecryptCBC(encryptedText, AES_KEY, AES_IV);
    } catch (e) {
        console.error("[CardByte] Classic: decryption error:", e);
        return encryptedText;  // return as-is if decryption fails
    }
}

// =============================================================================
// Server fetch — uses encrypted email, matches modern handler
// =============================================================================
function fetchSignatureForUser(email, platform, onDone) {
    var encryptedEmail = encryptEmail(email);
    if (!encryptedEmail) {
        console.error("[CardByte] Classic: email encryption failed, trying with plaintext");
        encryptedEmail = email;
    }

    // ── Primary renderer ──
    xhrGet(
        "https://newqa-enterprise.cardbyte.ai/email-signature/html/outlook/get-active",
        { "username": encryptedEmail, "X-Platform": platform },
        function (responseText) {
            try {
                var decrypted = handleAesDecrypt(responseText);
                var parsed = JSON.parse(decrypted);
                if (parsed && parsed.html) {
                    console.log("[CardByte] Classic: primary renderer OK");
                    onDone(parsed.html);
                    return;
                }
            } catch (e) { /* fall through to JSON parse without decrypt */ }
            // Try raw JSON in case server returns unencrypted for this client
            try {
                var raw = JSON.parse(responseText);
                if (raw && raw.html) {
                    console.log("[CardByte] Classic: primary renderer OK (plaintext)");
                    onDone(raw.html);
                    return;
                }
            } catch (e2) { /* fall through */ }
            console.warn("[CardByte] Classic: primary renderer unparseable, trying legacy");
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
            console.error("[CardByte] Classic: legacy renderer unparseable");
            onDone(null);
        },
        function (status) {
            console.error("[CardByte] Classic: legacy renderer failed (" + status + ")");
            onDone(null);
        }
    );
}

// =============================================================================
// Office.js body write helpers
// =============================================================================
function setSignature(item, html, onDone) {
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
    prependSignature(item, html, onDone);
}

function prependSignature(item, html, onDone) {
    if (typeof item.body.prependAsync !== "function") {
        console.error("[CardByte] Classic: no write method available");
        onDone(false);
        return;
    }
    item.body.prependAsync(html, { coercionType: Office.CoercionType.Html }, function (result) {
        if (result.status === Office.AsyncResultStatus.Succeeded) {
            console.log("[CardByte] Classic: prependAsync succeeded");
            onDone(true);
        } else {
            console.error("[CardByte] Classic: prependAsync failed:", result.error);
            onDone(false);
        }
    });
}

// =============================================================================
// Identity fallback
// =============================================================================
function buildFallbackHtml(userProfile) {
    var name = (userProfile && userProfile.displayName) ? userProfile.displayName : "";
    var email = (userProfile && userProfile.emailAddress) ? userProfile.emailAddress : "";
    email = encryptEmail(email)
    return '<table cellpadding="0" cellspacing="0" border="0" width="400">' +
        '<tr><td style="font-family:Arial,sans-serif;font-size:12px;">' +
        '<strong>' + name + '</strong><br/>' + email + '<br/>' +
        '<span style="color:#999;">Sent via CardByte</span>' +
        '</td></tr></table>';
}

// =============================================================================
// Core logic
// =============================================================================
function applySignatureCore(item, userProfile, html, event) {
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
            console.warn("[CardByte] Classic: all fetches failed — using identity fallback");
            applySignatureCore(item, userProfile, buildFallbackHtml(userProfile), event);
        }
    });
}

// =============================================================================
// Event handlers
// =============================================================================
function applySignature(event) {
    if (!event) event = { completed: function () { } };
    console.log("[CardByte] Classic: applySignature fired");
    var mailbox = (typeof Office !== "undefined" && Office.context && Office.context.mailbox)
        ? Office.context.mailbox : null;
    var item = mailbox ? mailbox.item : null;
    if (!item) { console.warn("[CardByte] Classic: no item"); event.completed(); return; }
    runWithSignature(item, (mailbox && mailbox.userProfile) ? mailbox.userProfile : {}, event, false);
}

function onSendHandler(event) {
    if (!event) event = { completed: function () { } };
    console.log("[CardByte] Classic: onSendHandler fired");
    var mailbox = (typeof Office !== "undefined" && Office.context && Office.context.mailbox)
        ? Office.context.mailbox : null;
    var item = mailbox ? mailbox.item : null;
    if (!item) { event.completed({ allowEvent: true }); return; }

    var cached = getCached();
    if (!cached) {
        console.warn("[CardByte] Classic: onSend — no cached signature, allowing send");
        event.completed({ allowEvent: true });
        return;
    }
    var wrapped = "<div style='margin-top:40px'></div>" + cached + "<div style='margin-top:40px'></div>";
    setSignature(item, wrapped, function () { event.completed({ allowEvent: true }); });
}

function onFromChangedHandler(event) {
    if (!event) event = { completed: function () { } };
    console.log("[CardByte] Classic: onFromChangedHandler fired");
    var mailbox = (typeof Office !== "undefined" && Office.context && Office.context.mailbox)
        ? Office.context.mailbox : null;
    var item = mailbox ? mailbox.item : null;
    if (!item) { event.completed(); return; }

    if (item.from && typeof item.from.getAsync === "function") {
        item.from.getAsync(function (result) {
            var newEmail = (result.status === Office.AsyncResultStatus.Succeeded && result.value)
                ? result.value.emailAddress : null;
            var profile = {};
            if (mailbox && mailbox.userProfile) {
                profile.displayName = mailbox.userProfile.displayName;
                profile.emailAddress = newEmail || mailbox.userProfile.emailAddress;
            }
            clearCache();
            runWithSignature(item, profile, event, false);
        });
    } else {
        clearCache();
        runWithSignature(item, (mailbox && mailbox.userProfile) ? mailbox.userProfile : {}, event, false);
    }
}

// =============================================================================
// Office.actions.associate — synchronous top-level (required for Classic Outlook)
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

_registerHandlers();