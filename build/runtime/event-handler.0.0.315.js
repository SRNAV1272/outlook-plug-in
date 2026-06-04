// ─────────────────────────────────────────────────────────────────────────────
// CardByte Outlook Add-in — event-handler.js
//
// Write strategy (Modern Office.js):
//
//   PATH A  setSignatureAsync  — new mail only, html < 100 KB
//           Outlook manages the signature slot natively.
//           Cursor is reset to top via a no-op setSelectedDataAsync("") after.
//
//   PATH B  _writeWithBoundaryAsync — reply / forward OR large HTML
//           1. getAsync          — read full body (CIDs intact)
//           2. Split             — composeArea | chainArea at reply boundary
//           3. stripSignatures   — clean compose area only (chain untouched)
//           4. setAsync(full)    — atomic full-body replace:
//                                  cleanCompose + sig + chainArea
//                                  CIDs survive because chainArea is written
//                                  back verbatim from the getAsync read.
//           5. setSelectedDataAsync("", Text) — cursor reset to top (best-effort)
//
//   FALLBACK inside PATH B (_writeWithSelectedDataAsync):
//           Used only when setAsync is unavailable (edge-case Outlook builds).
//           prependAsync("") attempts cursor-to-top before setSelectedDataAsync.
//
// onSendHandler:
//   Boundary-aware check-first pattern:
//     - Split body at reply boundary → composeArea | chainArea
//     - If CB_SIG tokens found in composeArea → signature intact, skip write
//     - Otherwise → stripSignatures on both halves, re-inject above chain
//     - setAsync(cleanCompose + sig + cleanChain) — always allows send
// ─────────────────────────────────────────────────────────────────────────────

// ─── Constants ────────────────────────────────────────────────────────────────

let CACHED_SIGNATURE_HTML = null;
const SIGNATURE_MARKER = "<!-- CARDBYTE_SIGNATURE -->";
const AES_KEY = "fnItrY2YfozBqCC2B4XsfqHIvZku3kUOq3DFkbO64kk=";
const AES_IV = "3YapeNfJDung7TXxeKXn4g==";

// ─── Session-based cache keys ─────────────────────────────────────────────────

const SESSION_KEY = "cardbyte_session_id";
const CACHE_KEY = "cardbyte_cached_signature";
const CACHE_SESSION_KEY = "cardbyte_cached_signature_session";
const CACHE_TIMESTAMP_KEY = "cardbyte_cached_signature_ts";
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// ─── Per-item insertion tracker ───────────────────────────────────────────────
// Tracks which compose item IDs have already had a signature inserted in this
// add-in session. Prevents double-insertion without relying on body-token
// presence (which false-positives on replies carrying the original CB_SIG).

const _insertedItems = new Set();

// ─── CB_SIG sentinel tokens ───────────────────────────────────────────────────
// Plain-text tokens embedded in hidden table cells.
// Survive Classic Outlook's Trident round-trip AND OWA's sanitizer.
// Used for dedup detection and tampering detection in onSendHandler.

const CB_SIG_START = "__CBSIG_START_7F2C9D4E__";
const CB_SIG_END = "__CBSIG_END_7F2C9D4E__";

const SENTINEL_TD_STYLE =
    "font-size:0px;color:#ffffff;line-height:0;max-height:0;" +
    "overflow:hidden;mso-hide:all;display:none;width:0;";

// ─── Reply-chain boundary patterns ───────────────────────────────────────────
// Ordered most-specific → least-specific.

const REPLY_PATTERNS = [
    // Classic Outlook 2016/2019 — outer div wrapping a border-top separator
    /(<div>\s*<div[^>]+border-top\s*:\s*solid[^>]*>)/i,
    // Broader fallback — any div whose style contains border-top:solid
    /(<div[^>]+style\s*=\s*["'][^"']*border-top\s*:\s*solid[^"']*["'][^>]*>)/i,
    // OWA / modern Outlook reply wrapper divs
    /(<div[^>]+\bid=["']divRplyFwdMsg["'][^>]*>)/i,
    /(<div[^>]+\bid=["']divTaggedContent["'][^>]*>)/i,
    // Generic blockquote last resort
    /(<blockquote[^>]*>)/i,
];


// ─────────────────────────────────────────────────────────────────────────────
// SESSION / CACHE HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function getOrCreateSessionId() {
    let sid = sessionStorage.getItem(SESSION_KEY);
    if (!sid) {
        sid = crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36);
        sessionStorage.setItem(SESSION_KEY, sid);
    }
    return sid;
}

function getCachedSignature({ skipTtl = false, skipSessionCheck = false } = {}) {
    if (skipSessionCheck) {
        return localStorage.getItem(CACHE_KEY);
    }

    const currentSid = getOrCreateSessionId();
    const cachedSid = localStorage.getItem(CACHE_SESSION_KEY);

    if (cachedSid !== currentSid) {
        console.log("[CardByte] New session detected — clearing cached signature");
        localStorage.removeItem(CACHE_KEY);
        localStorage.removeItem(CACHE_SESSION_KEY);
        localStorage.removeItem(CACHE_TIMESTAMP_KEY);
        return null;
    }

    if (!skipTtl) {
        const ts = parseInt(localStorage.getItem(CACHE_TIMESTAMP_KEY) || "0", 10);
        if (Date.now() - ts > CACHE_TTL_MS) {
            console.log("[CardByte] Cache TTL expired — clearing cached signature");
            localStorage.removeItem(CACHE_KEY);
            localStorage.removeItem(CACHE_SESSION_KEY);
            localStorage.removeItem(CACHE_TIMESTAMP_KEY);
            return null;
        }
    }

    return localStorage.getItem(CACHE_KEY);
}

function setCachedSignature(html) {
    const currentSid = getOrCreateSessionId();
    try {
        localStorage.setItem(CACHE_KEY, html);
        localStorage.setItem(CACHE_SESSION_KEY, currentSid);
        localStorage.setItem(CACHE_TIMESTAMP_KEY, Date.now().toString());
    } catch (_) { /* storage quota exceeded — silently skip */ }
}


// ─────────────────────────────────────────────────────────────────────────────
// SIGNATURE WRAPPING / STRIPPING
// ─────────────────────────────────────────────────────────────────────────────

// _wrapSignature
// Wraps raw backend HTML in a CB_SIG sentinel table so we can detect and strip
// it reliably across Classic Outlook and OWA.

function _wrapSignature(html) {
    return (
        "<table role=\"presentation\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\"" +
        " style=\"border:0;border-collapse:collapse;\">" +
        "<tr>" +
        "<td style=\"" + SENTINEL_TD_STYLE + "\">" + CB_SIG_START + "</td>" +
        "</tr>" +
        "<tr>" +
        "<td style=\"padding-top:40px;padding-bottom:40px;\">" +
        html +
        "</td>" +
        "</tr>" +
        "<tr>" +
        "<td style=\"" + SENTINEL_TD_STYLE + "\">" + CB_SIG_END + "</td>" +
        "</tr>" +
        "</table>"
    );
}

// stripSignatures
// Removes ALL CardByte and native Outlook signature artifacts from a body HTML.
// Uses a token-position walk (no DOMParser) — safe in Classic Outlook's Trident
// environment where table nesting is rewritten unpredictably.

function stripSignatures(html) {
    if (!html) return "";

    // 1. Native Outlook div-based signatures
    html = html.replace(/<div[^>]*\bid=["']Signature["'][^>]*>[\s\S]*?<\/div>/gi, "");
    html = html.replace(/<div[^>]*\bid=["']appendonsend["'][^>]*>[\s\S]*?<\/div>/gi, "");

    // 2. Legacy V1 plain-text markers
    html = html.replace(/__CARDBYTE_SIG_START_V1__[\s\S]*?__CARDBYTE_SIG_END_V1__/gi, "");

    // 3. CB_SIG token-walk — handles double-insert edge case, up to 10 passes
    let iterations = 0;
    const MAX_ITER = 10;

    while (iterations++ < MAX_ITER) {
        const startIdx = html.indexOf(CB_SIG_START);
        const endIdx = html.indexOf(CB_SIG_END);

        if (startIdx === -1 || endIdx === -1) {
            // Orphan token cleanup
            if (startIdx !== -1 || endIdx !== -1) {
                html = html.replace(CB_SIG_START, "").replace(CB_SIG_END, "");
            }
            break;
        }

        const tableOpen = html.lastIndexOf("<table", startIdx);
        const tableClose = html.indexOf("</table>", endIdx);

        if (tableOpen !== -1 && tableClose !== -1) {
            html = html.substring(0, tableOpen) +
                html.substring(tableClose + "</table>".length);
        } else {
            // Fallback: excise everything between the tokens
            html = html.substring(0, startIdx) +
                html.substring(endIdx + CB_SIG_END.length);
        }
    }

    // 4. Cosmetic clean-up
    html = html.replace(/(?:\s*<br\s*\/?>)+\s*$/gi, "");
    html = html.replace(/<div>\s*<\/div>/gi, "");
    html = html.replace(/<p>\s*<\/p>/gi, "");

    return html;
}


// ─────────────────────────────────────────────────────────────────────────────
// BODY HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function _getBodyAsync(item) {
    return new Promise((resolve, reject) => {
        if (typeof item.body.getAsync !== "function") {
            reject(new Error("getAsync unavailable"));
            return;
        }
        item.body.getAsync(Office.CoercionType.Html, (r) => {
            if (r.status === Office.AsyncResultStatus.Succeeded) resolve(r.value || "");
            else reject(r.error);
        });
    });
}


// ─────────────────────────────────────────────────────────────────────────────
// REPLY / FORWARD DETECTION
// ─────────────────────────────────────────────────────────────────────────────

function isReplyOrForward(item) {
    // Modern API: composeType available in requirement set 1.10+
    if (item?.composeType !== undefined) {
        return (
            item.composeType === Office.MailboxEnums.ComposeType.Reply ||
            item.composeType === Office.MailboxEnums.ComposeType.Forward
        );
    }
    // Fallback: inReplyTo is set on replies/forwards, null on new mails
    if (item?.inReplyTo !== undefined) {
        return item.inReplyTo != null;
    }
    return false;
}


// ─────────────────────────────────────────────────────────────────────────────
// WRITE PATHS
// ─────────────────────────────────────────────────────────────────────────────

// _splitAtBoundary
// Splits a full body string at the reply-chain boundary.
// Returns { composeArea, chainArea, patternUsed }.

function _splitAtBoundary(fullBody) {
    for (let i = 0; i < REPLY_PATTERNS.length; i++) {
        const m = REPLY_PATTERNS[i].exec(fullBody);
        if (m) {
            return {
                composeArea: fullBody.substring(0, m.index),
                chainArea: fullBody.substring(m.index),
                patternUsed: `pattern[${i}]`,
            };
        }
    }
    return { composeArea: fullBody, chainArea: "", patternUsed: "none" };
}

// ─── _writeWithSelectedDataAsync ─────────────────────────────────────────────
// Fallback path used only when setAsync is unavailable.
// Less reliable for full-body replace in OWA reply context — setAsync is
// always preferred. Classic Outlook uses _setBody (which wraps setAsync)
// directly, so this path is mainly a safety net for edge-case builds.

async function _writeWithSelectedDataAsync(item, combined) {
    // prependAsync("") attempts cursor-to-top before the replace.
    // Works on Desktop; ignored by OWA in reply context — hence setAsync preferred.
    await new Promise((resolve) => {
        if (typeof item.body.prependAsync !== "function") { resolve(); return; }
        item.body.prependAsync(
            "",
            { coercionType: Office.CoercionType.Text },
            () => resolve()
        );
    });

    return new Promise((resolve) => {
        item.body.setSelectedDataAsync(
            combined,
            { coercionType: Office.CoercionType.Html },
            (r) => {
                if (r.status === Office.AsyncResultStatus.Succeeded) {
                    console.log("[CardByte] _writeWithSelectedDataAsync: succeeded");
                    resolve(true);
                } else {
                    console.error("[CardByte] _writeWithSelectedDataAsync: failed", r.error);
                    resolve(false);
                }
            }
        );
    });
}

// ─── _writeWithBoundaryAsync ──────────────────────────────────────────────────
//
// Core write path for PATH B (reply/forward and large HTML).
//
// STRATEGY:
//   1. getAsync          — read full body HTML (CIDs preserved as opaque strings)
//   2. _splitAtBoundary  — composeArea | chainArea
//   3. stripSignatures   — clean compose area only; chainArea is untouched
//   4. setAsync(full)    — atomic full-body replace:
//                          cleanCompose + wrappedHtml + chainArea
//                          CIDs survive: read from getAsync, written back verbatim
//   5. setSelectedDataAsync("", Text) — cursor reset to top (best-effort, non-fatal)
//
// FALLBACK: if setAsync unavailable → _writeWithSelectedDataAsync(combined)

async function _writeWithBoundaryAsync(item, wrappedHtml) {
    // ── Step 1: Read full body ─────────────────────────────────────────────────
    let existingBody;
    try {
        existingBody = await _getBodyAsync(item);
    } catch (err) {
        console.error("[CardByte] _writeWithBoundaryAsync: getAsync failed", err);
        return false;
    }

    // ── Step 2: Split at reply-chain boundary ──────────────────────────────────
    const { composeArea, chainArea, patternUsed } = _splitAtBoundary(existingBody);
    console.log(
        `[CardByte] _writeWithBoundaryAsync: boundary=${patternUsed}` +
        ` | composeLen=${composeArea.length} | chainLen=${chainArea.length}`
    );

    // ── Step 3: Strip old signature from compose area only ─────────────────────
    // chainArea is intentionally untouched — CIDs and quoted content live here.
    const cleanCompose = stripSignatures(composeArea);

    // ── Step 4: Assemble full replacement ──────────────────────────────────────
    // cleanCompose + new signature + original chain (CIDs intact)
    const combined = cleanCompose + wrappedHtml + chainArea;
    const combinedKB = (new Blob([combined]).size / 1024).toFixed(1);
    console.log(`[CardByte] _writeWithBoundaryAsync: writing ${combinedKB} KB via setAsync`);

    const setAsyncAvailable = typeof item.body.setAsync === "function";
    const setSelectedAvailable = typeof item.body.setSelectedDataAsync === "function";

    // ── Step 5a: setAsync — true full-body replace ─────────────────────────────
    if (setAsyncAvailable) {
        const writeOk = await new Promise((resolve) => {
            item.body.setAsync(
                combined,
                { coercionType: Office.CoercionType.Html },
                (r) => {
                    if (r.status === Office.AsyncResultStatus.Succeeded) {
                        console.log("[CardByte] _writeWithBoundaryAsync: setAsync succeeded");
                        resolve(true);
                    } else {
                        console.error("[CardByte] _writeWithBoundaryAsync: setAsync failed", r.error);
                        resolve(false);
                    }
                }
            );
        });

        if (!writeOk) {
            // setAsync failed — fall through to setSelectedDataAsync
            if (setSelectedAvailable) {
                console.warn("[CardByte] _writeWithBoundaryAsync: setAsync failed — falling back to setSelectedDataAsync");
                return await _writeWithSelectedDataAsync(item, combined);
            }
            return false;
        }

        // ── Step 5b: Cursor reset to top of compose area ───────────────────────
        // After setAsync the cursor lands at position 0. A no-op
        // setSelectedDataAsync(Text) confirms and locks it there so the user
        // types above the signature. Best-effort — failure is non-fatal.
        await new Promise((resolve) => {
            if (!setSelectedAvailable) { resolve(); return; }
            item.body.setSelectedDataAsync(
                "",
                { coercionType: Office.CoercionType.Text },
                () => resolve()
            );
        });

        console.log("[CardByte] _writeWithBoundaryAsync: cursor reset done");
        return true;
    }

    // ── setAsync unavailable — direct fallback ─────────────────────────────────
    console.warn("[CardByte] _writeWithBoundaryAsync: setAsync unavailable — using setSelectedDataAsync fallback");
    return await _writeWithSelectedDataAsync(item, combined);
}


// ─────────────────────────────────────────────────────────────────────────────
// writeSignatureAsync — orchestrates PATH A / PATH B
// ─────────────────────────────────────────────────────────────────────────────
//
// PATH A — setSignatureAsync, new mail, html < 100 KB
//   Outlook manages the signature slot. Clears the slot first (avoids
//   double-appending), then writes the new HTML, then resets cursor to top.
//   Skipped entirely for reply/forward — setSignatureAsync places the sig
//   BELOW the reply chain on OWA/modern Outlook.
//
// PATH B — _writeWithBoundaryAsync, reply/forward or large HTML
//   Boundary-aware setAsync-based full-body replace (see above).

async function writeSignatureAsync(item, wrappedHtml, forceReplace = false) {
    const htmlSizeKB = new Blob([wrappedHtml]).size / 1024;
    const itemId = item.itemId || item.conversationId || "unknown";
    const replyOrForward = isReplyOrForward(item);

    // ── PATH A — setSignatureAsync (new mail only) ─────────────────────────────
    if (
        typeof item.body.setSignatureAsync === "function" &&
        htmlSizeKB < 100 &&
        !replyOrForward
    ) {
        console.log(
            `[CardByte] writeSignatureAsync PATH A (new mail)` +
            ` | ${htmlSizeKB.toFixed(1)} KB | forceReplace=${forceReplace}`
        );

        if (!forceReplace && _insertedItems.has(itemId)) {
            console.log(`[CardByte] PATH A: already inserted for ${itemId} — skipping`);
            return true;
        }

        // Clear slot first to avoid double-appending on re-open
        await new Promise((resolve, reject) => {
            item.body.setSignatureAsync(
                "",
                { coercionType: Office.CoercionType.Html },
                (r) => r.status === Office.AsyncResultStatus.Succeeded ? resolve() : reject(r.error)
            );
        });

        await new Promise((resolve, reject) => {
            item.body.setSignatureAsync(
                wrappedHtml,
                { coercionType: Office.CoercionType.Html },
                (r) => r.status === Office.AsyncResultStatus.Succeeded ? resolve() : reject(r.error)
            );
        });

        // Cursor to top of compose area
        await new Promise((resolve) => {
            if (typeof item.body.setSelectedDataAsync !== "function") { resolve(); return; }
            item.body.setSelectedDataAsync(
                "",
                { coercionType: Office.CoercionType.Text },
                () => resolve()
            );
        });

        console.log("[CardByte] PATH A succeeded");
        _insertedItems.add(itemId);
        return true;
    }

    // ── PATH B — boundary-aware (reply/forward or large HTML) ─────────────────
    console.log(
        `[CardByte] writeSignatureAsync PATH B` +
        ` (${replyOrForward ? "reply/forward" : "large HTML"})` +
        ` | ${htmlSizeKB.toFixed(1)} KB | forceReplace=${forceReplace}`
    );

    if (!forceReplace && _insertedItems.has(itemId)) {
        console.log(`[CardByte] PATH B: already inserted for ${itemId} — skipping`);
        return true;
    }

    const success = await _writeWithBoundaryAsync(item, wrappedHtml);

    if (success) {
        // Post-write token verification
        try {
            const bodyAfter = await _getBodyAsync(item);
            const startOk = bodyAfter.indexOf(CB_SIG_START) !== -1;
            const endOk = bodyAfter.indexOf(CB_SIG_END) !== -1;
            console.log(
                `[CardByte] PATH B: post-write verification` +
                ` | CB_SIG_START=${startOk} | CB_SIG_END=${endOk}`
            );
            if (startOk && endOk) _insertedItems.add(itemId);
            return startOk && endOk;
        } catch (_) {
            _insertedItems.add(itemId);
            return true;
        }
    }

    return false;
}


// ─────────────────────────────────────────────────────────────────────────────
// PLATFORM DETECTION
// ─────────────────────────────────────────────────────────────────────────────

function detectPlatform() {
    const platform = (Office?.context?.platform || "").toLowerCase();
    const ua = (navigator?.userAgent || "").toLowerCase();

    if (platform === "ios" || platform === "iphone" || platform === "ipad") return "mobile-ios";
    if (platform === "android") return "mobile-android";

    if (
        ua.includes("outlookmobile") ||
        ua.includes("outlook-ios") ||
        ua.includes("outlook-android")
    ) return ua.includes("android") ? "mobile-android" : "mobile-ios";

    if (
        (platform === "officeonline" || platform === "web" || platform === "") &&
        (ua.includes("iphone") || ua.includes("ipad") || ua.includes("android"))
    ) return ua.includes("android") ? "mobile-android" : "mobile-ios";

    if (platform === "mac") return "mac";

    if (
        (platform === "" || platform === "desktop") &&
        (ua.includes("macintosh") || ua.includes("mac os x")) &&
        !ua.includes("iphone") &&
        !ua.includes("ipad")
    ) return "mac";

    if (platform === "officeonline" || platform === "web" || platform === "") return "owa";
    return "desktop";
}

function isOWA() { return detectPlatform() === "owa"; }
function isMac() { return detectPlatform() === "mac"; }

Office.onReady(() => {
    console.log("✅ Office.onReady is Started!");
    console.log(`[CardByte] Platform detected: ${detectPlatform()}`);
});


// ─────────────────────────────────────────────────────────────────────────────
// CRYPTO HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function base64ToArrayBuffer(base64) {
    let b64 = base64.replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64.length % 4;
    if (pad) b64 += "=".repeat(4 - pad);
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
}

function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
}

async function handleAesDecrypt(encryptedText, generatedKey) {
    try {
        if (!encryptedText) return "";

        const keyToUse = generatedKey || AES_KEY;
        let keyBuffer;
        try {
            keyBuffer = base64ToArrayBuffer(keyToUse);
        } catch (e) {
            console.error("Failed to decode key as base64:", e);
            return encryptedText;
        }

        if (keyBuffer.byteLength !== 16 && keyBuffer.byteLength !== 32) {
            if (generatedKey && generatedKey !== AES_KEY) return handleAesDecrypt(encryptedText, AES_KEY);
            return encryptedText;
        }

        const ivBuffer = base64ToArrayBuffer(AES_IV);
        if (ivBuffer.byteLength !== 16) return encryptedText;

        const key = await crypto.subtle.importKey(
            "raw", keyBuffer, { name: "AES-CBC" }, false, ["decrypt"]
        );

        let encryptedBuffer;
        try {
            encryptedBuffer = base64ToArrayBuffer(encryptedText);
        } catch (e) {
            return encryptedText;
        }

        if (encryptedBuffer.byteLength % 16 !== 0) {
            console.error(`Invalid encrypted data length: ${encryptedBuffer.byteLength} bytes`);
            return encryptedText;
        }

        const decryptedBuffer = await crypto.subtle.decrypt(
            { name: "AES-CBC", iv: ivBuffer }, key, encryptedBuffer
        );
        return new TextDecoder().decode(decryptedBuffer);

    } catch (err) {
        if (generatedKey && generatedKey !== AES_KEY && err.message.includes("key data")) {
            try { return await handleAesDecrypt(encryptedText, AES_KEY); }
            catch (e) { console.error("Fallback decrypt also failed:", e.message); }
        }
        return encryptedText;
    }
}

async function encryptEmail(email = "") {
    try {
        if (!email || email.trim() === "") {
            console.warn("Warning: Empty email provided");
            return "";
        }

        const keyBuffer = base64ToArrayBuffer(AES_KEY);
        const ivBuffer = base64ToArrayBuffer(AES_IV);

        if (keyBuffer.byteLength !== 16 && keyBuffer.byteLength !== 32) {
            console.error(`Invalid key length: ${keyBuffer.byteLength} bytes`);
            return "";
        }
        if (ivBuffer.byteLength !== 16) {
            console.error(`Invalid IV length: ${ivBuffer.byteLength} bytes`);
            return "";
        }

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


// ─────────────────────────────────────────────────────────────────────────────
// BACKEND FETCH
// ─────────────────────────────────────────────────────────────────────────────

async function renderSignatureOnServer(user) {
    const platform = Office.context.diagnostics.platform;
    const xPlatform = platform === Office.PlatformType.Mac ? "MAC" : "WINDOWS";

    try {
        const encryptedMail = await encryptEmail(user);
        const primaryRes = await fetch(
            "https://newqa-enterprise.cardbyte.ai/email-signature/html/outlook/get-active",
            { method: "GET", headers: { username: encryptedMail, "X-Platform": xPlatform } }
        );
        if (primaryRes.ok) {
            const data = await primaryRes.text();
            const decryptedData = await handleAesDecrypt(data);
            console.log("[CardByte] Using NEW renderer");
            return JSON.parse(decryptedData)?.html || null;
        }
        console.warn("[CardByte] Primary renderer failed. Falling back to legacy...");
    } catch (err) {
        console.warn("[CardByte] Primary renderer crashed. Falling back to legacy...", err);
    }

    try {
        const legacyRes = await fetch(
            "https://newqa-enterprise.cardbyte.ai/render-signature",
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ email: user }),
            }
        );
        if (!legacyRes.ok) throw new Error("Legacy renderer failed");
        const legacyData = await legacyRes.json();
        console.log("[CardByte] Using LEGACY renderer", legacyData);
        return legacyData?.finalHtml || null;
    } catch (legacyError) {
        console.error("[CardByte] Both primary and legacy renderers failed:", legacyError);
        return null;
    }
}


// ─────────────────────────────────────────────────────────────────────────────
// TAMPERING DETECTION
// ─────────────────────────────────────────────────────────────────────────────
//
// Checks whether CB_SIG tokens are still present in the compose body.
// Returns true if intact; false if stripped or absent.
// Used by onSendHandler to decide whether to re-apply.

async function isSignatureIntact(item) {
    try {
        const body = await _getBodyAsync(item);
        const startOk = body.indexOf(CB_SIG_START) !== -1;
        const endOk = body.indexOf(CB_SIG_END) !== -1;
        console.log(`[CardByte] isSignatureIntact: CB_SIG_START=${startOk} | CB_SIG_END=${endOk}`);
        return startOk && endOk;
    } catch (err) {
        // Fail open — don't block send on a read error
        console.warn("[CardByte] isSignatureIntact: getAsync failed — assuming intact", err);
        return true;
    }
}


// ─────────────────────────────────────────────────────────────────────────────
// CORE APPLY FLOW
// ─────────────────────────────────────────────────────────────────────────────
//
// _applySignatureCore
//   1. Fetch raw HTML from backend (with retry), or fall back to cache / stale cache.
//   2. Wrap the raw HTML in CB_SIG sentinel tokens via _wrapSignature().
//   3. Cache the WRAPPED version so both compose and send paths share it.
//   4. Delegate writing to writeSignatureAsync() → PATH A or PATH B.
//
// forceReplace=true skips the dedup guard — used by onSendHandler and
// onFromChanged to unconditionally replace a stale or tampered signature.

async function _applySignatureCore(
    item,
    mailbox,
    { fetchIfMissing = false, skipTtl = false, skipSessionCheck = false, forceReplace = false } = {}
) {
    const userProfile = mailbox?.userProfile || {};
    const userEmail = userProfile?.emailAddress;

    let fetched = getCachedSignature({ skipTtl, skipSessionCheck });

    // ── Fetch from backend if cache miss ──────────────────────────────────────
    if (fetchIfMissing && userEmail && fetched == null) {
        const MAX_RETRIES = 2;
        let attempt = 0;
        let lastError = null;

        while (attempt <= MAX_RETRIES) {
            try {
                if (attempt > 0) {
                    console.warn(`[CardByte] Retrying signature fetch (attempt ${attempt}/${MAX_RETRIES})...`);
                    await new Promise(r => setTimeout(r, 1000 * attempt));
                }
                const result = await renderSignatureOnServer(userEmail);
                if (result != null) {
                    // Wrap BEFORE caching — every write path receives a sentinel-wrapped blob
                    fetched = _wrapSignature(result);
                    CACHED_SIGNATURE_HTML = fetched;
                    setCachedSignature(fetched);
                    break;
                }
                lastError = new Error("Server returned null");
            } catch (err) {
                lastError = err;
                console.warn(`[CardByte] Fetch attempt ${attempt + 1} failed:`, err);
            }
            attempt++;
        }

        if (fetched == null) {
            console.error(
                `[CardByte] All ${MAX_RETRIES + 1} fetch attempts failed. Last error:`, lastError
            );
        }
    }

    // ── Fallback chain ────────────────────────────────────────────────────────
    if (!fetched) {
        const staleCache = getCachedSignature({ skipTtl: true, skipSessionCheck: true });
        if (staleCache) {
            console.warn("[CardByte] Using stale cached signature as last resort.");
            fetched = staleCache;
        } else {
            console.warn("[CardByte] No signature available — using fallback identity signature.");
            const fallbackHtml = `
                <table cellpadding="0" cellspacing="0" border="0" width="400">
                  <tr>
                    <td style="font-family:Arial,sans-serif;font-size:12px;">
                      <strong>${userProfile.displayName || ""}</strong><br/>
                      ${userProfile.emailAddress || ""}<br/>
                      <span style="color:#999;">Sent via CardByte</span>
                    </td>
                  </tr>
                </table>`;
            fetched = _wrapSignature(fallbackHtml);
        }
    }

    console.log(
        `[CardByte] _applySignatureCore: writing signature` +
        ` | forceReplace=${forceReplace}` +
        ` | sizeKB=${(new Blob([fetched]).size / 1024).toFixed(1)}`
    );

    await writeSignatureAsync(item, fetched, forceReplace);
}


// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC EVENT HANDLERS
// ─────────────────────────────────────────────────────────────────────────────

// applySignature
// Fires on NewMail / Reply / ReplyAll / Forward compose open.
// forceReplace=false — dedup guard prevents wiping user edits on re-open.

window.applySignature = async function (event = { completed: () => { } }) {
    const mailbox = Office?.context?.mailbox;
    const item = mailbox?.item;

    try {
        await _applySignatureCore(item, mailbox, { fetchIfMissing: true, forceReplace: false });
    } catch (err) {
        console.error("[CardByte] Error in applySignature:", err);
    } finally {
        event.completed();
    }
};

// onSendHandler
// Fires just before the email is sent.
//
// Boundary-aware check-first pattern:
//   1. Read full body → split at reply boundary
//   2. Check whether CB_SIG tokens are present in composeArea (above chain)
//   3. If YES  → signature intact, skip body write entirely
//   4. If NO   → strip any stray sigs from both halves, re-inject above chain
//                setAsync(cleanCompose + sig + cleanChain)
//
// The send is ALWAYS allowed (allowEvent: true).
// Signature re-apply is best-effort and must never block the user.

window.onSendHandler = async function (event = { completed: () => { } }) {
    const mailbox = Office?.context?.mailbox;
    const item = mailbox?.item;

    try {
        if (!item) return;

        const cachedHtml = getCachedSignature({ skipTtl: true, skipSessionCheck: true });
        if (!cachedHtml) {
            console.log("[CardByte] onSendHandler: no cached signature — passing through");
            return;
        }

        // ── Read and split ─────────────────────────────────────────────────────
        let fullBody;
        try {
            fullBody = await _getBodyAsync(item);
        } catch (err) {
            console.error("[CardByte] onSendHandler: getAsync failed — passing through", err);
            return;
        }

        const { composeArea, chainArea, patternUsed } = _splitAtBoundary(fullBody);
        console.log(
            `[CardByte] onSendHandler: boundary=${patternUsed}` +
            ` | composeLen=${composeArea.length} | chainLen=${chainArea.length}`
        );

        // ── Check-first: is signature already above the chain? ─────────────────
        const sigInComposeArea =
            composeArea.indexOf(CB_SIG_START) !== -1 &&
            composeArea.indexOf(CB_SIG_END) !== -1;

        if (sigInComposeArea) {
            console.log("[CardByte] onSendHandler: signature intact above chain — skipping write");
            return;
        }

        // ── Signature missing or below chain — rebuild ─────────────────────────
        console.warn("[CardByte] onSendHandler: signature not in compose area — re-inserting");

        const cleanCompose = stripSignatures(composeArea);
        const cleanChain = stripSignatures(chainArea);   // strip any stray sig below boundary
        const combined = cleanCompose + cachedHtml + cleanChain;

        await new Promise((resolve) => {
            item.body.setAsync(
                combined,
                { coercionType: Office.CoercionType.Html },
                (r) => {
                    if (r.status === Office.AsyncResultStatus.Succeeded) {
                        console.log("[CardByte] onSendHandler: re-inject succeeded");
                    } else {
                        console.error("[CardByte] onSendHandler: re-inject failed", r.error);
                    }
                    resolve();
                }
            );
        });

        console.log("[CardByte] onSendHandler: done");

    } catch (err) {
        console.error("[CardByte] Error in onSendHandler:", err);
    } finally {
        event.completed({ allowEvent: true });
    }
};


// ─────────────────────────────────────────────────────────────────────────────
// HANDLER REGISTRATION
// ─────────────────────────────────────────────────────────────────────────────

if (typeof Office !== "undefined" && typeof Office.actions !== "undefined") {
    Office.actions.associate("onSendHandler", onSendHandler);
    console.log("[CardByte] Office.actions.associate registered: onSendHandler");
}

if (typeof Office !== "undefined" && typeof Office.actions !== "undefined") {
    Office.actions.associate("applySignature", applySignature);
    console.log("[CardByte] Office.actions.associate registered: applySignature");
} else {
    console.log(
        "[CardByte] Office.actions not available — LaunchEvent path not active" +
        " (expected on Classic Outlook 2016/2019)"
    );
}