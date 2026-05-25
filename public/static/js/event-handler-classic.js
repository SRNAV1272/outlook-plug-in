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
// AES / Crypto constants  (must match modern event-handler.js exactly)
// =============================================================================
var AES_KEY = "fnItrY2YfozBqCC2B4XsfqHIvZku3kUOq3DFkbO64kk=";
var AES_IV = "3YapeNfJDung7TXxeKXn4g==";

// =============================================================================
// Base64 helpers
// =============================================================================
var B64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function b64Encode(bytes) {
    var result = "", i;
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
    str = str.replace(/-/g, "+").replace(/_/g, "/");
    var pad = str.length % 4;
    if (pad === 2) str += "==";
    else if (pad === 3) str += "=";
    var lookup = new Array(256), c;
    for (c = 0; c < B64_CHARS.length; c++) lookup[B64_CHARS.charCodeAt(c)] = c;
    lookup["=".charCodeAt(0)] = 0;
    var out = [], i;
    for (i = 0; i < str.length; i += 4) {
        var a = lookup[str.charCodeAt(i)],
            b = lookup[str.charCodeAt(i + 1)],
            cv = lookup[str.charCodeAt(i + 2)],
            d = lookup[str.charCodeAt(i + 3)];
        out.push((a << 2) | (b >> 4));
        if (str[i + 2] !== "=") out.push(((b & 0x0F) << 4) | (cv >> 2));
        if (str[i + 3] !== "=") out.push(((cv & 0x03) << 6) | d);
    }
    return out;
}

// =============================================================================
// Pure-JS AES-CBC encryption (ES5, no Web Crypto)
// =============================================================================
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

var RCON = [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36];

function gmul(a, b) {
    var p = 0, i, hiBit;
    for (i = 0; i < 8; i++) {
        if (b & 1) p ^= a;
        hiBit = a & 0x80;
        a = (a << 1) & 0xff;
        if (hiBit) a ^= 0x1b;
        b >>= 1;
    }
    return p;
}

function aesKeyExpansion(keyBytes) {
    var nk = keyBytes.length / 4, nr = nk + 6, w = [], i, temp;
    for (i = 0; i < nk; i++)
        w[i] = [keyBytes[4 * i], keyBytes[4 * i + 1], keyBytes[4 * i + 2], keyBytes[4 * i + 3]];
    for (i = nk; i < 4 * (nr + 1); i++) {
        temp = w[i - 1].slice();
        if (i % nk === 0) {
            temp = [SBOX[temp[1]], SBOX[temp[2]], SBOX[temp[3]], SBOX[temp[0]]];
            temp[0] ^= RCON[(i / nk) - 1];
        } else if (nk > 6 && i % nk === 4) {
            temp = [SBOX[temp[0]], SBOX[temp[1]], SBOX[temp[2]], SBOX[temp[3]]];
        }
        w[i] = [w[i - nk][0] ^ temp[0], w[i - nk][1] ^ temp[1], w[i - nk][2] ^ temp[2], w[i - nk][3] ^ temp[3]];
    }
    return { w: w, nr: nr };
}

function addRoundKey(state, w, round) {
    for (var c = 0; c < 4; c++)
        for (var r = 0; r < 4; r++)
            state[r][c] ^= w[round * 4 + c][r];
}

function subBytes(state) {
    for (var r = 0; r < 4; r++)
        for (var c = 0; c < 4; c++)
            state[r][c] = SBOX[state[r][c]];
}

function shiftRows(state) {
    var tmp;
    tmp = state[1][0]; state[1][0] = state[1][1]; state[1][1] = state[1][2]; state[1][2] = state[1][3]; state[1][3] = tmp;
    tmp = state[2][0]; state[2][0] = state[2][2]; state[2][2] = tmp;
    tmp = state[2][1]; state[2][1] = state[2][3]; state[2][3] = tmp;
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

function aesEncryptBlock(blockBytes, keySchedule) {
    var nr = keySchedule.nr, w = keySchedule.w, state = [[], [], [], []], i, r, c;
    for (c = 0; c < 4; c++) for (r = 0; r < 4; r++) state[r][c] = blockBytes[c * 4 + r];
    addRoundKey(state, w, 0);
    for (i = 1; i < nr; i++) { subBytes(state); shiftRows(state); mixColumns(state); addRoundKey(state, w, i); }
    subBytes(state); shiftRows(state); addRoundKey(state, w, nr);
    var out = new Array(16);
    for (c = 0; c < 4; c++) for (r = 0; r < 4; r++) out[c * 4 + r] = state[r][c];
    return out;
}

function pkcs7Pad(bytes, blockSize) {
    var pad = blockSize - (bytes.length % blockSize), result = bytes.slice(), i;
    for (i = 0; i < pad; i++) result.push(pad);
    return result;
}

function aesEncryptCBC(plaintext, keyBase64, ivBase64) {
    var keyBytes = b64Decode(keyBase64), ivBytes = b64Decode(ivBase64), msgBytes = [], i, code;
    for (i = 0; i < plaintext.length; i++) {
        code = plaintext.charCodeAt(i);
        if (code < 0x80) { msgBytes.push(code); }
        else if (code < 0x800) { msgBytes.push(0xC0 | (code >> 6)); msgBytes.push(0x80 | (code & 0x3F)); }
        else { msgBytes.push(0xE0 | (code >> 12)); msgBytes.push(0x80 | ((code >> 6) & 0x3F)); msgBytes.push(0x80 | (code & 0x3F)); }
    }
    msgBytes = pkcs7Pad(msgBytes, 16);
    var keySchedule = aesKeyExpansion(keyBytes), prev = ivBytes, cipherBytes = [], b, j, block, encrypted;
    for (b = 0; b < msgBytes.length; b += 16) {
        block = msgBytes.slice(b, b + 16);
        for (j = 0; j < 16; j++) block[j] ^= prev[j];
        encrypted = aesEncryptBlock(block, keySchedule);
        cipherBytes = cipherBytes.concat(encrypted);
        prev = encrypted;
    }
    return b64Encode(cipherBytes);
}

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
// Signature cache — two tiers + 5-minute TTL
//
// _memStore       : fast same-session path (dies on runtime restart).
// roamingSettings : survives restarts. Stores { html, ts } — accepted only
//                   if TTL is still valid.
// =============================================================================
var CACHE_KEY = "cardbyte_sig_html";
var CACHE_TTL_MS = 5 * 60 * 1000;   // 5 minutes
var _memStore = {};               // { html, ts }

function _rsGet() {
    try { var rs = Office.context.roamingSettings; return rs ? rs.get(CACHE_KEY) : null; }
    catch (e) { return null; }
}

function _rsSet(entry) {
    try {
        var rs = Office.context.roamingSettings;
        if (!rs) return;
        rs.set(CACHE_KEY, entry);
        rs.saveAsync(function (r) {
            if (r.status !== Office.AsyncResultStatus.Succeeded)
                console.warn("[CardByte] Classic: roamingSettings save failed");
        });
    } catch (e) { console.warn("[CardByte] Classic: roamingSettings set error", e); }
}

function _rsDel() {
    try {
        var rs = Office.context.roamingSettings;
        if (!rs) return;
        rs.remove(CACHE_KEY);
        rs.saveAsync(function () { });
    } catch (e) { }
}

function _isExpired(entry) {
    return !entry || !entry.ts || (Date.now() - entry.ts) > CACHE_TTL_MS;
}

function getCached() {
    // 1. Same-session mem path — fastest, no RS read
    var memEntry = _memStore[CACHE_KEY];
    if (memEntry) {
        if (_isExpired(memEntry)) {
            console.log("[CardByte] Classic: mem cache expired");
            clearCache();
            return null;
        }
        return memEntry.html;
    }
    // 2. roamingSettings — runtime was restarted (e.g. OnMessageSend after OnNewMessageCompose)
    var rsEntry = _rsGet();
    if (!rsEntry || _isExpired(rsEntry)) {
        if (rsEntry) { console.log("[CardByte] Classic: roamingSettings cache expired"); _rsDel(); }
        return null;
    }
    _memStore[CACHE_KEY] = rsEntry;   // promote to mem for this session
    return rsEntry.html;
}

function setCache(html) {
    var entry = { html: html, ts: Date.now() };
    _memStore[CACHE_KEY] = entry;
    _rsSet(entry);
}

function clearCache() {
    delete _memStore[CACHE_KEY];
    _rsDel();
}

// =============================================================================
// Embedded signature HTML
// Replace SIGNATURE_HTML with your actual signature markup.
// =============================================================================
var SIGNATURE_HTML = '<table cellpadding="0" cellspacing="0" border="0" width="610" xmlns:v="urn:schemas-microsoft-com:vml" style="border-collapse:collapse;border-spacing:0;margin:0;padding:0;width:610px;table-layout:fixed;font-family:Arial,Helvetica,sans-serif;vertical-align:top;mso-table-lspace:0;mso-table-rspace:0;-ms-text-size-adjust:100%;-webkit-text-size-adjust:100%;background-color:#ffffff;"><colgroup><col width="190" style="width:190px;"><col width="420" style="width:420px;"></colgroup><tr><td rowspan="8" width="190" align="center" valign="middle" style="width:190px;padding:0;text-align:center;vertical-align:middle;border:none;margin:0;line-height:normal;mso-line-height-rule:exactly;"><table cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;margin:0;padding:0;table-layout:fixed;"><tr><td align="center" valign="middle" style="padding:0 40px 0 0;"><table cellpadding="0" cellspacing="0" border="0" align="center" style="border-collapse:collapse;margin:0;padding:0;table-layout:fixed;margin-left:auto;margin-right:auto;"><tr><td align="center" valign="middle" style="padding:0;"><img src="https://upload.wikimedia.org/wikipedia/commons/a/a7/Camponotus_flavomarginatus_ant.jpg" width="150" height="120" alt="Company Logo" style="display:block;border:0;width:150px;height:120px;" vspace="0" hspace="0" border="0"></td></tr></table></td></tr></table></td><td width="420" align="left" valign="top" style="width:420px;padding:0;text-align:left;vertical-align:top;border:none;margin:0;line-height:normal;mso-line-height-rule:exactly;"><p style="font-family:Arial,Helvetica,sans-serif;font-size:12pt;color:#000000;line-height:1;margin:0;padding:0;">Sai Rajesh Korla</p></td></tr><tr><td width="420" align="left" valign="top" style="width:420px;padding:0;text-align:left;vertical-align:top;border:none;margin:0;line-height:normal;mso-line-height-rule:exactly;"><p style="font-family:Arial,Helvetica,sans-serif;font-size:12pt;color:#000000;line-height:1;margin:0;padding:0;">Software Engineer ( MERN Stack )</p></td></tr><tr><td width="420" align="left" valign="top" style="width:420px;padding:0;text-align:left;vertical-align:top;border:none;margin:0;line-height:normal;mso-line-height-rule:exactly;"><p style="font-family:Arial,Helvetica,sans-serif;font-size:12pt;color:#000000;font-weight:normal;font-style:normal;text-decoration:none;margin:0;padding:0;">Telephone: 0124434887</p></td></tr><tr><td width="420" align="left" valign="top" style="width:420px;padding:0;text-align:left;vertical-align:top;border:none;margin:0;line-height:normal;mso-line-height-rule:exactly;"><p style="font-family:Arial,Helvetica,sans-serif;font-size:12pt;color:#000000;font-weight:normal;font-style:normal;text-decoration:none;margin:0;padding:0;">Mobile: +917024899020</p></td></tr><tr><td width="420" align="left" valign="top" style="width:420px;padding:0;text-align:left;vertical-align:top;border:none;margin:0;line-height:normal;mso-line-height-rule:exactly;"><p style="font-family:Arial,Helvetica,sans-serif;font-size:12pt;color:#000000;font-weight:normal;font-style:normal;text-decoration:none;margin:0;padding:0;line-height:1.4;">Ayyappa Society, Hyderabad, Telangana, India, 500001</p></td></tr><tr><td width="420" align="left" valign="top" style="width:420px;padding:0;text-align:left;vertical-align:top;border:none;margin:0;line-height:normal;mso-line-height-rule:exactly;"><p style="font-family:Arial,Helvetica,sans-serif;font-size:12pt;color:#000000;line-height:1;margin:0;padding:0;">CIN No. : L74899DL1991PLC044843</p></td></tr><tr><td width="420" align="left" valign="top" style="width:420px;padding:0;text-align:left;vertical-align:top;border:none;margin:0;line-height:normal;mso-line-height-rule:exactly;"><p style="font-family:Arial,Helvetica,sans-serif;font-size:12pt;color:#000000;font-weight:normal;font-style:normal;text-decoration:none;margin:0;padding:0;">Website: www.navajna.com</p></td></tr></table>';

// =============================================================================
// API fetch — builds signature HTML from server response
// =============================================================================

// function fetchSignatureHtml(user, onDone) {
//     var platform = Office.context.diagnostics.platform;
//     var xPlatform = platform === Office.PlatformType.Mac ? "MAC" : "WINDOWS";

//     Promise.resolve(encryptEmail(user))
//         .then(function (encryptedMail) {
//             console.warn("[CardByte] Classic: Encrypted Email...", encryptedMail);

//             var xhr = new XMLHttpRequest();
//             xhr.open("GET", "https://newqa-enterprise.cardbyte.ai/email-signature/html/outlook/get-active", true);
//             xhr.setRequestHeader("username", encryptedMail);
//             xhr.setRequestHeader("X-Platform", xPlatform);

//             xhr.onreadystatechange = function () {
//                 if (xhr.readyState !== 4) return;
//                 if (xhr.status === 200) {
//                     Promise.resolve(handleAesDecrypt(xhr.responseText))
//                         .then(function (decryptedData) {
//                             var html = JSON.parse(decryptedData)?.html || null;
//                             console.log("[CardByte] Classic: Using NEW renderer");
//                             onDone(null, html);
//                         })
//                         .catch(function (e) {
//                             console.error("[CardByte] Classic: decrypt error", e);
//                             onDone("Decrypt error: " + JSON.stringify(e), null);
//                         });
//                 } else if (xhr.status === 0) {
//                     var corsMsg = "Network error (status 0) — possible CORS block or no connectivity."
//                         + " URL: https://newqa-enterprise.cardbyte.ai/email-signature/html/outlook/get-active";
//                     console.error("[CardByte] Classic: " + corsMsg);
//                     onDone(corsMsg, null);
//                 } else {
//                     var errMsg = "XHR failed — HTTP " + xhr.status + " " + xhr.statusText
//                         + (xhr.responseText ? " | Response: " + xhr.responseText.slice(0, 300) : "");
//                     console.error("[CardByte] Classic:", errMsg);
//                     onDone(errMsg, null);
//                 }
//             };

//             xhr.onerror = function () {
//                 var netMsg = "XHR onerror — network-level failure (CORS, DNS, or connectivity)."
//                     + " URL: https://newqa-enterprise.cardbyte.ai/email-signature/html/outlook/get-active";
//                 console.error("[CardByte] Classic:", netMsg);
//                 onDone(netMsg, null);
//             };

//             xhr.send();
//         })
//         .catch(function (err) {
//             console.error("[CardByte] Classic: encryptEmail error", err);
//             onDone("encryptEmail error: " + JSON.stringify(err), null);
//         });
// }
// Replace your fetchSignatureHtml function with this
// function fetchSignatureHtml(user, onDone) {
//     var platform = Office.context.diagnostics.platform;
//     var xPlatform = platform === Office.PlatformType.Mac ? "MAC" : "WINDOWS";

//     Promise.resolve(encryptEmail(user))
//         .then(function (encryptedMail) {
//             console.log("[CardByte] Classic: Encrypted Email...", encryptedMail);

//             // Use randomuser.me API's CORS support by sending your request through it
//             // Create a unique cache-busting parameter
//             var callbackName = "jsonp_callback_" + Date.now() + "_" + Math.random().toString(36).substr(2, 8);

//             // Method 1: Try XHR with CORS proxy (if you have one)
//             // Method 2: Use randomuser.me as a JSONP proxy (not ideal but works)

//             // Better approach: Use a CORS proxy service (temporary for testing)
//             var corsProxy = "https://api.allorigins.win/raw?url=";
//             var targetUrl = "https://newqa-enterprise.cardbyte.ai/email-signature/html/outlook/get-active";

//             var xhr = new XMLHttpRequest();
//             xhr.open("GET", corsProxy + encodeURIComponent(targetUrl), true);
//             xhr.setRequestHeader("username", encryptedMail);
//             xhr.setRequestHeader("X-Platform", xPlatform);

//             xhr.onreadystatechange = function () {
//                 if (xhr.readyState !== 4) return;
//                 if (xhr.status === 200) {
//                     try {
//                         // The proxy returns the response directly
//                         var response = JSON.parse(xhr.responseText);
//                         Promise.resolve(handleAesDecrypt(response))
//                             .then(function (decryptedData) {
//                                 var html = JSON.parse(decryptedData)?.html || null;
//                                 console.log("[CardByte] Classic: Using NEW renderer via proxy");
//                                 onDone(null, html);
//                             })
//                             .catch(function (e) {
//                                 console.error("[CardByte] Classic: decrypt error", e);
//                                 onDone("Decrypt error: " + JSON.stringify(e), null);
//                             });
//                     } catch (e) {
//                         console.error("[CardByte] Classic: parse error", e);
//                         onDone("Parse error: " + e.message, null);
//                     }
//                 } else {
//                     console.error("[CardByte] Classic: XHR failed", xhr.status);
//                     onDone("HTTP " + xhr.status, null);
//                 }
//             };

//             xhr.onerror = function () {
//                 console.error("[CardByte] Classic: XHR onerror");
//                 onDone("Network error", null);
//             };

//             xhr.send();
//         })
//         .catch(function (err) {
//             console.error("[CardByte] Classic: encryptEmail error", err);
//             onDone("encryptEmail error: " + JSON.stringify(err), null);
//         });
// }

// function fetchSignatureHtml(user, onDone) {
//     var platform = Office.context.diagnostics.platform;
//     var xPlatform = platform === Office.PlatformType.Mac ? "MAC" : "WINDOWS";

//     Promise.resolve(encryptEmail(user))
//         .then(function (encryptedMail) {
//             console.warn("[CardByte] Classic: Encrypted Email...", encryptedMail);

//             var xhr = new XMLHttpRequest();
//             xhr.open("GET", "https://newqa-enterprise.cardbyte.ai/email-signature/html/outlook/get-active", true);
//             xhr.setRequestHeader("username", encryptedMail);
//             xhr.setRequestHeader("X-Platform", xPlatform);
//             xhr.setRequestHeader("Accept", "application/json");

//             xhr.onreadystatechange = function () {
//                 if (xhr.readyState !== 4) return;

//                 var contentType = xhr.getResponseHeader("Content-Type");
//                 console.log("[CardByte] Classic: Response Content-Type:", contentType);

//                 if (xhr.status === 200) {
//                     Promise.resolve(handleAesDecrypt(xhr.responseText))
//                         .then(function (decryptedData) {
//                             var html = JSON.parse(decryptedData)?.html || null;
//                             console.log("[CardByte] Classic: Using NEW renderer");
//                             onDone(null, html);
//                         })
//                         .catch(function (e) {
//                             console.error("[CardByte] Classic: decrypt error", e);
//                             onDone("Decrypt error: " + JSON.stringify(e), null);
//                         });
//                 } else if (xhr.status === 0) {
//                     var corsMsg = "Network error (status 0) — possible CORS block or no connectivity."
//                         + " URL: https://newqa-enterprise.cardbyte.ai/email-signature/html/outlook/get-active\n"
//                         + "Response Content-Type: " + (contentType || "none");
//                     console.error("[CardByte] Classic: " + corsMsg);
//                     onDone(corsMsg, null);
//                 } else {
//                     var errMsg = "XHR failed — HTTP " + xhr.status + " " + xhr.statusText
//                         + (xhr.responseText ? " | Response: " + xhr.responseText.slice(0, 300) : "");
//                     console.error("[CardByte] Classic:", errMsg);
//                     onDone(errMsg, null);
//                 }
//             };

//             xhr.onerror = function () {
//                 var netMsg = "XHR onerror — network-level failure (CORS, DNS, or connectivity)."
//                     + " URL: https://newqa-enterprise.cardbyte.ai/email-signature/html/outlook/get-active";
//                 console.error("[CardByte] Classic:", netMsg);
//                 onDone(netMsg, null);
//             };

//             xhr.send();
//         })
//         .catch(function (err) {
//             console.error("[CardByte] Classic: encryptEmail error", err);
//             onDone("encryptEmail error: " + JSON.stringify(err), null);
//         });
// }

function fetchSignatureHtml(user, onDone) {
    var platform = Office.context.diagnostics.platform;
    var xPlatform = platform === Office.PlatformType.Mac ? "MAC" : "WINDOWS";

    Promise.resolve(encryptEmail(user))
        .then(function (encryptedMail) {
            console.warn("[CardByte] Classic: Encrypted Email...", encryptedMail);

            fetch("https://newqa-enterprise.cardbyte.ai/email-signature/html/outlook/get-active", {
                method: "GET",
                headers: {
                    "username": encryptedMail,
                    "X-Platform": xPlatform,
                    "Accept": "application/json"
                }
            })
                .then(function (response) {
                    console.log("[CardByte] Classic: Response Content-Type:", response.headers.get("Content-Type"));

                    if (!response.ok) {
                        return response.json().then(function (errorText) {
                            var errMsg = "Fetch failed — HTTP " + response.status + " " + response.statusText
                                + (errorText ? " | Response: " + errorText.slice(0, 300) : "");
                            console.error("[CardByte] Classic:", errMsg);
                            onDone(errMsg, null);
                            throw new Error(errMsg);
                        });
                    }

                    return response.json();
                })
                .then(function (responseText) {
                    return Promise.resolve(handleAesDecrypt(responseText));
                })
                .then(function (decryptedData) {
                    var html = JSON.parse(decryptedData)?.html || null;
                    console.log("[CardByte] Classic: Using NEW renderer");
                    onDone(null, html);
                })
                .catch(function (error) {
                    // Check for network errors (including CORS)
                    if (error.message && error.message.includes("Failed to fetch")) {
                        var netMsg = "Network error — possible CORS block or no connectivity."
                            + " URL: https://newqa-enterprise.cardbyte.ai/email-signature/html/outlook/get-active";
                        console.error("[CardByte] Classic:", netMsg);
                        onDone(netMsg, null);
                    } else if (error.message && error.message.startsWith("Fetch failed")) {
                        // Error already handled in response.ok check
                        // Do nothing as onDone was already called
                    } else {
                        console.error("[CardByte] Classic: decrypt or parse error", error);
                        onDone("Decrypt error: " + JSON.stringify(error), null);
                    }
                });
        })
        .catch(function (err) {
            console.error("[CardByte] Classic: encryptEmail error", err);
            onDone("encryptEmail error: " + JSON.stringify(err), null);
        });
}

// =============================================================================
// Write path — setSignatureAsync with prependAsync fallback
//
// setSignatureAsync requires req-set 1.10 and a full Exchange Online mailbox.
// Dev-tenant / trial accounts (e.g. *.onmicrosoft.com auto-provisioned) often
// return "The operation is not supported" even when the API exists on the
// object. prependAsync (req-set 1.1) works on virtually every mailbox type
// and is used as the fallback.
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
            if (result.status === Office.AsyncResultStatus.Succeeded || result.status === "succeeded") {
                console.log("[CardByte] Classic: prependAsync succeeded");
                onDone(true);
            } else {
                console.error("[CardByte] Classic: prependAsync failed:", result.error && result.error.message);
                onDone(false);
            }
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
            if (result.status === Office.AsyncResultStatus.Succeeded || result.status === "succeeded") {
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
// Core apply logic
//
// Strategy: write immediately so the event never times out, then fire the XHR
// in the background. If the fetch returns before the event window closes AND
// the result differs from what was written, we do a second write to upgrade
// the signature. event.completed() is always called after the first write.
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

function applySignatureCore(userEmail, item, event) {
    var cached = getCached();
    if (cached) {
        console.log("[CardByte] Classic: using cached signature");
        setSignature(item, cached + userEmail + '<span>Cached</span>', function (ok) {
            if (!ok) console.warn("[CardByte] Classic: signature write failed");
            event.completed();
        });
        return;
    }

    // No cache — write SIGNATURE_HTML immediately so event.completed() fires
    // without waiting on the network, then attempt XHR upgrade in background.
    var immediate = _buildWrapped(SIGNATURE_HTML);
    setSignature(item, immediate, function (ok) {
        if (!ok) console.warn("[CardByte] Classic: immediate write failed");
        event.completed();   // always complete after first write
    });

    // Background XHR — updates the signature if fetch succeeds in time.
    // Does NOT block event.completed().
    fetchSignatureHtml(userEmail, function (err, html) {
        if (err || !html) {
            var errorBlock = "<div style='margin-top:16px;padding:10px;border:1px solid #c00;"
                + "background:#fff0f0;font-family:monospace;font-size:11px;color:#c00;"
                + "max-width:600px;word-break:break-all;'>"
                + "<strong>[CardByte] Signature fetch error:</strong><br>"
                + (err ? err.replace(/</g, "&lt;").replace(/>/g, "&gt;") : "html was null/empty")
                + "</div>";
            // Best-effort: inject error block after the fallback signature already written
            setSignature(item, _buildWrapped(SIGNATURE_HTML + errorBlock), function (ok) {
                console.log("[CardByte] Classic: error-injected signature write", ok ? "succeeded" : "failed");
            });
            return;
        }
        var wrapped = _buildWrapped(html);
        setCache(wrapped);
        setSignature(item, wrapped, function (ok) {
            console.log("[CardByte] Classic: background signature upgrade", ok ? "succeeded" : "failed (item closed — ok)");
        });
    });
}

// =============================================================================
// Guarded event.completed — fires exactly once, with timeout safety
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

/** OnNewMessageCompose */
function applySignature(event) {
    if (!event) event = { completed: function () { } };
    var guarded = makeGuardedEvent(event, 12000);
    var mailbox = (typeof Office !== "undefined" && Office.context && Office.context.mailbox)
        ? Office.context.mailbox : null;
    var item = mailbox ? mailbox.item : null;
    const userProfile = mailbox?.userProfile || {};
    const userEmail = userProfile?.emailAddress;
    if (!item) { console.warn("[CardByte] Classic: applySignature — no item"); guarded.completed(); return; }
    applySignatureCore(userEmail, item, guarded);
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

    // roamingSettings cache survives runtime restarts — use it to avoid a
    // second API call. Fall back to SIGNATURE_HTML only if cache is empty.
    var html = getCached();
    if (html) {
        setSignature(item, html, function () { guarded.completed({ allowEvent: true }); });
    } else {
        guarded.completed({ allowEvent: true });
        // fetchSignatureHtml(function (fetched) {
        //     var wrapped = "<div style='margin-top:40px'></div>"
        //         + (fetched || SIGNATURE_HTML)
        //         + "<div style='margin-top:40px'></div>";
        //     setCache(wrapped);
        //     setSignature(item, wrapped, function () { guarded.completed({ allowEvent: true }); });
        // });
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
    // clearCache();
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