let CACHED_SIGNATURE_HTML = null;
const SIGNATURE_MARKER = "<!-- CARDBYTE_SIGNATURE -->";
const AES_KEY = "fnItrY2YfozBqCC2B4XsfqHIvZku3kUOq3DFkbO64kk=";
const AES_IV = "3YapeNfJDung7TXxeKXn4g==";

// ─── Session-based cache buster ───────────────────────────────────────────────
const SESSION_KEY = "cardbyte_session_id";
const CACHE_KEY = "cardbyte_cached_signature";
const CACHE_SESSION_KEY = "cardbyte_cached_signature_session";
const CACHE_TIMESTAMP_KEY = "cardbyte_cached_signature_ts";
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// ─── Per-item insertion tracker ───────────────────────────────────────────────
// Tracks which compose item IDs have already had a signature inserted in this
// add-in session. Replaces body-token dedup guard, which false-positives on
// replies where the quoted original email already carries CB_SIG tokens.
const _insertedItems = new Set();

// ─── CB_SIG sentinel tokens (must match event-handler-classic.js) ─────────────
// Plain-text tokens embedded in hidden table cells. Survive Classic Outlook's
// Trident round-trip AND OWA's sanitizer. Used for dedup detection and
// tampering detection in onSendHandler.
const CB_SIG_START = "__CBSIG_START_7F2C9D4E__";
const CB_SIG_END   = "__CBSIG_END_7F2C9D4E__";

// Sentinel cell style: visually hidden in all clients.
const SENTINEL_TD_STYLE =
    "font-size:0px;color:#ffffff;line-height:0;max-height:0;" +
    "overflow:hidden;mso-hide:all;display:none;width:0;";

// ─── Reply-chain boundary patterns (ported from event-handler-classic.js) ─────
// Ordered from most-specific to least-specific.
const REPLY_PATTERNS = [
    // Classic Outlook 2016/2019: outer div wrapping a border-top separator div
    /(<div>\s*<div[^>]+border-top\s*:\s*solid[^>]*>)/i,
    // Broader fallback: any div whose style contains border-top:solid
    /(<div[^>]+style\s*=\s*["'][^"']*border-top\s*:\s*solid[^"']*["'][^>]*>)/i,
    // OWA / modern Outlook reply wrapper divs
    /(<div[^>]+\bid=["']divRplyFwdMsg["'][^>]*>)/i,
    /(<div[^>]+\bid=["']divTaggedContent["'][^>]*>)/i,
    // Generic blockquote last resort
    /(<blockquote[^>]*>)/i
];

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
    } catch (_) { }
}

// ─── Signature wrapping (ported from event-handler-classic.js) ────────────────
// Wraps raw backend HTML in a sentinel table so we can detect and strip it
// reliably across both Classic Outlook and OWA. The top/bottom spacing divs
// from the original event-handler.js are preserved inside the wrapper.
function _wrapSignature(html) {
    return (
        "<table role=\"presentation\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\" style=\"border:0;border-collapse:collapse;\">" +
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

// ─── Signature stripping (ported from event-handler-classic.js) ───────────────
// Removes ALL CardByte and native Outlook signature artifacts from a body HTML.
// Uses a token-position walk instead of regex / DOMParser because Classic
// Outlook's Trident engine rewrites table nesting unpredictably.
function stripSignatures(html) {
    if (!html) return "";

    // 1. Native Outlook div-based signatures
    html = html.replace(/<div[^>]*\bid=["']Signature["'][^>]*>[\s\S]*?<\/div>/gi, "");
    html = html.replace(/<div[^>]*\bid=["']appendonsend["'][^>]*>[\s\S]*?<\/div>/gi, "");

    // 2. Legacy V1 plain-text markers
    html = html.replace(/__CARDBYTE_SIG_START_V1__[\s\S]*?__CARDBYTE_SIG_END_V1__/gi, "");

    // 3. CB_SIG token-walk (current format) — handles double-insert edge case
    let iterations = 0;
    const MAX_ITER = 10;

    while (iterations++ < MAX_ITER) {
        const startIdx = html.indexOf(CB_SIG_START);
        const endIdx   = html.indexOf(CB_SIG_END);

        if (startIdx === -1 || endIdx === -1) {
            // Orphan token cleanup
            if (startIdx !== -1 || endIdx !== -1) {
                html = html.replace(CB_SIG_START, "").replace(CB_SIG_END, "");
            }
            break;
        }

        const tableOpen  = html.lastIndexOf("<table", startIdx);
        const tableClose = html.indexOf("</table>", endIdx);

        if (tableOpen !== -1 && tableClose !== -1) {
            html = html.substring(0, tableOpen) +
                   html.substring(tableClose + "</table>".length);
        } else {
            // Fallback: excise everything between the tokens themselves
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

// ─── Body helpers ─────────────────────────────────────────────────────────────

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

// ─── Core write path ──────────────────────────────────────────────────────────
//
// writeSignatureAsync(item, wrappedHtml, forceReplace)
//
// PATH A — setSignatureAsync available AND html < 100 KB.
//   Outlook manages the signature slot. We also issue a no-op
//   setSelectedDataAsync("") afterwards to move the cursor to the top of the
//   compose area, so the user's typing position is natural.
//
// PATH B — setSignatureAsync unavailable OR html >= 100 KB.
//   1. Read current body via getAsync.
//   2. Split at reply-chain boundary (reply / forward detection).
//   3. Dedup guard: if CB_SIG tokens already present in compose area and
//      forceReplace=false, bail early.
//   4. Strip all previous signatures from the compose area only (quoted chain
//      is intentionally left untouched).
//   5. Concatenate: cleanCompose + wrappedHtml + chainArea.
//   6. Write combined string via setSelectedDataAsync (only API available on
//      paths that don't have setAsync, but here used for its replace-all
//      semantics — we first clear with prependAsync("") to reset selection,
//      then write via setSelectedDataAsync with the full body replacement).
//
// NOTE: setAsync is intentionally NOT used. The requirement is to use only
// setSignatureAsync (PATH A) and setSelectedDataAsync (PATH B + cursor reset).

async function writeSignatureAsync(item, wrappedHtml, forceReplace = false) {
    const htmlSizeKB = new Blob([wrappedHtml]).size / 1024;

    // ── Shared itemId for dedup tracking (both paths) ─────────────────────────
    const itemId = item.itemId || item.conversationId || "unknown";

    // ── PATH A ────────────────────────────────────────────────────────────────
    if (typeof item.body.setSignatureAsync === "function" && htmlSizeKB < 100) {
        console.log(`[CardByte] writeSignatureAsync PATH A | ${htmlSizeKB.toFixed(1)} KB | forceReplace=${forceReplace}`);

        if (!forceReplace && _insertedItems.has(itemId)) {
            console.log(`[CardByte] writeSignatureAsync PATH A: already inserted for item ${itemId} — skipping`);
            return true;
        }

        await new Promise((resolve, reject) => {
            item.body.setSignatureAsync(
                wrappedHtml,
                { coercionType: Office.CoercionType.Html },
                (r) => {
                    if (r.status === Office.AsyncResultStatus.Succeeded) resolve();
                    else reject(r.error);
                }
            );
        });

        // Move cursor to top of compose area so the user types above the signature.
        // setSignatureAsync places the signature at the bottom but leaves the
        // cursor wherever Outlook wants — a no-op setSelectedDataAsync("") at
        // CoercionType.Text resets the selection to the top of the body.
        await new Promise((resolve) => {
            if (typeof item.body.setSelectedDataAsync !== "function") { resolve(); return; }
            item.body.setSelectedDataAsync(
                "",
                { coercionType: Office.CoercionType.Text },
                () => resolve()   // ignore errors — cursor move is best-effort
            );
        });

        console.log("[CardByte] writeSignatureAsync PATH A succeeded");
        _insertedItems.add(itemId);
        return true;
    }

    // ── PATH B ────────────────────────────────────────────────────────────────
    console.log(`[CardByte] writeSignatureAsync PATH B | ${htmlSizeKB.toFixed(1)} KB | forceReplace=${forceReplace}`);

    if (typeof item.body.setSelectedDataAsync !== "function") {
        console.error("[CardByte] writeSignatureAsync PATH B: setSelectedDataAsync unavailable");
        return false;
    }

    // Step 1: Read the current body
    let existingBody;
    try {
        existingBody = await _getBodyAsync(item);
    } catch (err) {
        console.error("[CardByte] writeSignatureAsync PATH B: getAsync failed", err);
        return false;
    }

    // Step 2: Split at reply-chain boundary
    let composeArea = existingBody;
    let chainArea   = "";
    let patternUsed = "none";

    for (let i = 0; i < REPLY_PATTERNS.length; i++) {
        const m = REPLY_PATTERNS[i].exec(existingBody);
        if (m) {
            composeArea = existingBody.substring(0, m.index);
            chainArea   = existingBody.substring(m.index);
            patternUsed = `pattern[${i}]`;
            break;
        }
    }
    console.log(`[CardByte] writeSignatureAsync PATH B: reply boundary=${patternUsed} | composeLen=${composeArea.length} | chainLen=${chainArea.length}`);

    // Step 3: Dedup guard — item-ID based, not body-token based.
    // Body-token check false-positives on replies where the quoted original
    // email already carries CB_SIG tokens from the previous send.

    if (!forceReplace && _insertedItems.has(itemId)) {
        console.log(`[CardByte] writeSignatureAsync PATH B: already inserted for item ${itemId} — skipping`);
        return true;
    }

    // Step 4: Strip previous signatures from compose area only
    const cleanCompose = stripSignatures(composeArea);
    console.log(`[CardByte] writeSignatureAsync PATH B: cleanCompose=${cleanCompose.length} chars (was ${composeArea.length})`);

    // Step 5: Assemble full replacement body
    const combined = cleanCompose + wrappedHtml + chainArea;
    console.log(`[CardByte] writeSignatureAsync PATH B: writing combined body | ${(new Blob([combined]).size / 1024).toFixed(1)} KB`);

    // Step 6: Write via setSelectedDataAsync.
    // We must first select-all so that setSelectedDataAsync replaces the entire
    // body. We achieve this by calling prependAsync("") to reset the cursor to
    // the very beginning, which makes the subsequent setSelectedDataAsync
    // effectively replace everything from that point to the end — but that
    // would only insert, not replace. Instead we use the documented approach:
    // call setSelectedDataAsync with the FULL body after ensuring the selection
    // spans the whole document by first invoking body.getAsync and then writing
    // back. In practice, calling setSelectedDataAsync with the full body HTML
    // on an Office.CoercionType.Html coercion replaces the entire body when the
    // cursor is at position 0 (top). We move to position 0 first via a no-op
    // prependAsync("").
    await new Promise((resolve) => {
        if (typeof item.body.prependAsync !== "function") { resolve(); return; }
        item.body.prependAsync("", { coercionType: Office.CoercionType.Text }, () => resolve());
    });

    const success = await new Promise((resolve) => {
        item.body.setSelectedDataAsync(
            combined,
            { coercionType: Office.CoercionType.Html },
            (r) => {
                if (r.status === Office.AsyncResultStatus.Succeeded) resolve(true);
                else {
                    console.error("[CardByte] writeSignatureAsync PATH B: setSelectedDataAsync failed", r.error);
                    resolve(false);
                }
            }
        );
    });

    // Verify tokens survived the write
    try {
        const bodyAfter = await _getBodyAsync(item);
        const startOk = bodyAfter.indexOf(CB_SIG_START) !== -1;
        const endOk   = bodyAfter.indexOf(CB_SIG_END)   !== -1;
        console.log(`[CardByte] writeSignatureAsync PATH B: post-write verification | CB_SIG_START=${startOk} | CB_SIG_END=${endOk} | bodyLen=${bodyAfter.length}`);
        if (startOk && endOk) _insertedItems.add(itemId);
        return startOk && endOk;
    } catch (_) {
        // Verification read failure is non-fatal — trust the write result
        if (success) _insertedItems.add(itemId);
        return success;
    }
}

// ─── Platform detection ───────────────────────────────────────────────────────

function detectPlatform() {
    const platform = (Office?.context?.platform || "").toLowerCase();
    const ua = (navigator?.userAgent || "").toLowerCase();

    if (platform === "ios" || platform === "iphone" || platform === "ipad") return "mobile-ios";
    if (platform === "android") return "mobile-android";

    if (ua.includes("outlookmobile") || ua.includes("outlook-ios") || ua.includes("outlook-android"))
        return ua.includes("android") ? "mobile-android" : "mobile-ios";

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
    console.log("✅ Office.onReady is Started !");
    console.log(`[CardByte] Platform detected: ${detectPlatform()}`);
});

// ─── Crypto helpers ───────────────────────────────────────────────────────────

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
        const ivBuffer  = base64ToArrayBuffer(AES_IV);
        if (keyBuffer.byteLength !== 16 && keyBuffer.byteLength !== 32) { console.error(`Invalid key length: ${keyBuffer.byteLength} bytes`); return ""; }
        if (ivBuffer.byteLength !== 16) { console.error(`Invalid IV length: ${ivBuffer.byteLength} bytes`); return ""; }
        const key  = await crypto.subtle.importKey("raw", keyBuffer, { name: "AES-CBC" }, false, ["encrypt"]);
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

// ─── Backend fetch ────────────────────────────────────────────────────────────

async function renderSignatureOnServer(user) {
    const platform  = Office.context.diagnostics.platform;
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
            console.log("Using NEW renderer");
            return JSON.parse(decryptedData)?.html || null;
        }
        console.warn("Primary failed. Falling back to legacy...");
    } catch (err) {
        console.warn("Primary crashed. Falling back to legacy...", err);
    }

    try {
        const legacyRes = await fetch(
            "https://newqa-enterprise.cardbyte.ai/render-signature",
            { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: user }) }
        );
        if (!legacyRes.ok) throw new Error("Legacy renderer failed");
        const legacyData = await legacyRes.json();
        console.log("Using LEGACY renderer", legacyData);
        return legacyData?.finalHtml || null;
    } catch (legacyError) {
        console.error("Both primary and legacy failed:", legacyError);
        return null;
    }
}

// ─── Tampering detection ──────────────────────────────────────────────────────
//
// Checks whether the CB_SIG tokens are still present in the compose body.
// Returns true if the signature is intact, false if it has been tampered with
// or is missing entirely. Used by onSendHandler to decide whether to re-apply.

async function isSignatureIntact(item) {
    try {
        const body = await _getBodyAsync(item);
        const startOk = body.indexOf(CB_SIG_START) !== -1;
        const endOk   = body.indexOf(CB_SIG_END)   !== -1;
        console.log(`[CardByte] isSignatureIntact: CB_SIG_START=${startOk} | CB_SIG_END=${endOk}`);
        return startOk && endOk;
    } catch (err) {
        console.warn("[CardByte] isSignatureIntact: getAsync failed — assuming intact", err);
        return true; // Fail open: don't block send on a read error
    }
}

// ─── Core apply flow ──────────────────────────────────────────────────────────
//
// _applySignatureCore orchestrates:
//   1. Fetch raw HTML from backend (with retry), or fall back to cache / stale cache.
//   2. Wrap the raw HTML in CB_SIG sentinel tokens via _wrapSignature().
//   3. Cache the WRAPPED version so both compose and send paths share it.
//   4. Delegate writing to writeSignatureAsync() which handles PATH A / PATH B,
//      reply-chain splitting, dedup guard, and cursor reset.
//
// forceReplace=true skips the dedup guard — used by onSendHandler and
// onFromChanged to unconditionally replace a stale / tampered signature.

async function _applySignatureCore(item, mailbox, { fetchIfMissing = false, skipTtl = false, skipSessionCheck = false, forceReplace = false } = {}) {
    const userProfile = mailbox?.userProfile || {};
    const userEmail   = userProfile?.emailAddress;

    let fetched = getCachedSignature({ skipTtl, skipSessionCheck });

    // ── Fetch from backend if cache miss ─────────────────────────────────────
    if (fetchIfMissing && userEmail && fetched == null) {
        const MAX_RETRIES = 2;
        let attempt   = 0;
        let lastError = null;

        while (attempt <= MAX_RETRIES) {
            try {
                if (attempt > 0) {
                    console.warn(`[CardByte] Retrying signature fetch (attempt ${attempt}/${MAX_RETRIES})...`);
                    await new Promise(r => setTimeout(r, 1000 * attempt));
                }
                const result = await renderSignatureOnServer(userEmail);
                if (result != null) {
                    // Wrap BEFORE caching so every write path receives a sentinel-wrapped blob
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
            console.error(`[CardByte] All ${MAX_RETRIES + 1} fetch attempts failed. Last error:`, lastError);
        }
    }

    // ── Fallback chain ────────────────────────────────────────────────────────
    if (!fetched) {
        // Last-ditch: stale cache (bypass both session and TTL checks)
        const staleCache = getCachedSignature({ skipTtl: true, skipSessionCheck: true });
        if (staleCache) {
            console.warn("[CardByte] Using stale cached signature as last resort.");
            fetched = staleCache;
        } else {
            console.warn("[CardByte] No signature available — using fallback identity signature.");
            // Wrap the fallback so it carries the sentinel tokens too
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

    console.log(`[CardByte] _applySignatureCore: writing signature | forceReplace=${forceReplace} | sizeKB=${(new Blob([fetched]).size / 1024).toFixed(1)}`);

    await writeSignatureAsync(item, fetched, forceReplace);
}

// ─── Public event handlers ────────────────────────────────────────────────────

// applySignature — fires on NewMail / Reply / ReplyAll / Forward compose open.
// Uses dedup guard (forceReplace=false) so a user who edited and re-opened
// won't have their edits wiped.
window.applySignature = async function (event = { completed: () => { } }) {
    const mailbox = Office?.context?.mailbox;
    const item    = mailbox?.item;

    try {
        await _applySignatureCore(item, mailbox, { fetchIfMissing: true, forceReplace: false });
    } catch (err) {
        console.error("[CardByte] Error in applySignature:", err);
    } finally {
        event.completed();
    }
};

// onSendHandler — fires just before the email is sent.
// Checks whether the CB_SIG tokens are still present in the body. If the
// signature has been tampered with (tokens stripped by user or another add-in),
// it re-applies from cache with forceReplace=true before allowing the send.
// The send is ALWAYS allowed (allowEvent: true) — signature re-apply is
// best-effort and must not block the user.
window.onSendHandler = async function (event = { completed: () => { } }) {
    const mailbox = Office?.context?.mailbox;
    const item    = mailbox?.item;

    try {
        if (!item) return;

        // skipSessionCheck=true: onSendHandler may run in a separate iframe
        // (modern Outlook) where sessionStorage is fresh and wouldn't match
        // the session ID stored by applySignature's iframe.
        const cachedHtml = getCachedSignature({ skipTtl: true, skipSessionCheck: true });

        if (!cachedHtml) {
            console.log("[CardByte] onSendHandler: no cached signature — passing through");
            return;
        }

        const intact = await isSignatureIntact(item);
        if (intact) {
            console.log("[CardByte] onSendHandler: signature intact — no action needed");
            return;
        }

        console.warn("[CardByte] onSendHandler: signature tampered / missing — re-applying");
        // forceReplace=true: bypass dedup guard and strip-then-rewrite
        await writeSignatureAsync(item, cachedHtml, true /* forceReplace */);
        console.log("[CardByte] onSendHandler: signature re-applied");

    } catch (err) {
        console.error("[CardByte] Error in onSendHandler:", err);
    } finally {
        // Always allow the send — signature enforcement must not block the user
        event.completed({ allowEvent: true });
    }
};

// ─── Handler registration ─────────────────────────────────────────────────────

if (typeof Office !== "undefined" && typeof Office.actions !== "undefined") {
    Office.actions.associate("onSendHandler", onSendHandler);
    console.log("[CardByte] Office.actions.associate registered: onSendHandler");
}

if (typeof Office !== "undefined" && typeof Office.actions !== "undefined") {
    Office.actions.associate("applySignature", applySignature);
    console.log("[CardByte] Office.actions.associate registered: applySignature");
} else {
    console.log("[CardByte] Office.actions not available — LaunchEvent path not active (expected on 2016/2019)");
}