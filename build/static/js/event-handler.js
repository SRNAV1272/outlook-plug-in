// ─── Constants ────────────────────────────────────────────────────────────────

const AES_KEY = "fnItrY2YfozBqCC2B4XsfqHIvZku3kUOq3DFkbO64kk=";
const AES_IV  = "3YapeNfJDung7TXxeKXn4g==";

const SESSION_KEY        = "cardbyte_session_id";
const CACHE_KEY          = "cardbyte_cached_signature";
const CACHE_SESSION_KEY  = "cardbyte_cached_signature_session";
const CACHE_TIMESTAMP_KEY= "cardbyte_cached_signature_ts";
const CACHE_TTL_MS       = 5 * 60 * 1000; // 5 minutes

const SIG_SENTINEL_OPEN  = "<!--CBSIG_START-->";
const SIG_SENTINEL_CLOSE = "<!--CBSIG_END-->";

// ─── String-level Signature Replacement ──────────────────────────────────────
//
// Core insight: never round-trip through DOMParser.
// OWA embeds blob: / cid: image URLs that only live in OWA's internal
// representation. Parsing through DOMParser in the add-in iframe discards them.
//
// Strategy:
//   • On first inject: find the reply-chain boundary purely via regex,
//     insert sentinel-wrapped signature HTML before it (or at end).
//   • On re-inject:  regex-replace the sentinel block in one shot.
//   • Everything outside the sentinel block is passed through as-is —
//     zero DOM serialization, zero image mangling.

/**
 * Returns the index in `bodyHtml` where the reply chain starts,
 * or bodyHtml.length if there is no reply chain.
 *
 * Detection covers:
 *   - <blockquote          (Gmail / OWA quoted content)
 *   - <hr                  (classic Outlook reply divider)
 *   - id="divReplyContainer" / id="appendonsend"   (OWA reply zone)
 *   - class="gmail_quote" / class="yahoo_quoted"
 *   - <div … border-top … (Outlook forward header)
 */
function _findReplyChainIndex(bodyHtml) {
    const patterns = [
        // blockquote (any attrs)
        /<blockquote[\s>]/i,
        // HR tag
        /<hr[\s/>]/i,
        // OWA reply container / append-on-send
        /id=["']?divReplyContainer/i,
        /id=["']?appendonsend/i,
        // Gmail / Yahoo quotes
        /class=["'][^"']*gmail_quote/i,
        /class=["'][^"']*yahoo_quoted/i,
        // Outlook forward header div with border-top
        /<div[^>]+border-top[^>]*>/i,
        // Common "From:" header patterns inside a div (forward block)
        /<div[^>]*>\s*[-_]+\s*(?:Original Message|Forwarded message)/i,
    ];

    let earliest = bodyHtml.length;
    for (const re of patterns) {
        const m = re.exec(bodyHtml);
        if (m && m.index < earliest) earliest = m.index;
    }
    return earliest;
}

/**
 * Wraps signature HTML in sentinel comments for reliable future replacement.
 */
function _wrapSig(sigHtml) {
    return `\n${SIG_SENTINEL_OPEN}\n<div style="margin-top:40px"></div>\n${sigHtml}\n<div style="margin-top:40px"></div>\n${SIG_SENTINEL_CLOSE}\n`;
}

/**
 * Injects or replaces the CardByte signature into bodyHtml at the string level.
 *
 * @param {string} bodyHtml  - Full HTML string from item.body.getAsync
 * @param {string} sigHtml   - Rendered signature HTML to inject
 * @returns {string}         - Updated HTML string, ready for item.body.setAsync
 */
function replaceSignatureInBody(bodyHtml, sigHtml) {
    if (!bodyHtml) return bodyHtml ?? "";
    if (!sigHtml)  { console.warn("[CardByte] replaceSignatureInBody: empty sigHtml — body unchanged"); return bodyHtml; }

    const wrapped = _wrapSig(sigHtml);

    // ── Case 1: sentinel already present — replace in one regex shot ──────────
    const sentinelRe = new RegExp(
        `${SIG_SENTINEL_OPEN}[\\s\\S]*?${SIG_SENTINEL_CLOSE}`,
        "i"
    );
    if (sentinelRe.test(bodyHtml)) {
        return bodyHtml.replace(sentinelRe, wrapped.trim());
    }

    // ── Case 2: no sentinel — first inject ────────────────────────────────────
    // Support legacy sentinel too (data-cbsig="true" div injected by old code)
    const legacyRe = /<div[^>]+data-cbsig=["']true["'][^>]*>[\s\S]*?(?:<\/div>)?/i;
    if (legacyRe.test(bodyHtml)) {
        // Replace legacy block; trim everything after it up to the reply chain
        // by splitting on legacy sentinel, keeping part[0] as the preamble.
        const parts = bodyHtml.split(legacyRe);
        const preamble = parts[0];
        const tail     = parts.slice(1).join(""); // anything after (reply chain etc.)
        return preamble + wrapped + tail;
    }

    // ── Case 3: fresh compose / no sentinel at all ────────────────────────────
    const replyIdx = _findReplyChainIndex(bodyHtml);
    return bodyHtml.slice(0, replyIdx) + wrapped + bodyHtml.slice(replyIdx);
}

// ─── Crypto Helpers ───────────────────────────────────────────────────────────

function _base64ToBuffer(b64) {
    const s = b64.replace(/-/g, "+").replace(/_/g, "/");
    const pad = s.length % 4;
    const padded = pad ? s + "=".repeat(4 - pad) : s;
    const bin = atob(padded);
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    return buf.buffer;
}

function _bufferToBase64(buf) {
    const bytes = new Uint8Array(buf);
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s);
}

async function _importAesKey(b64Key, usage) {
    const buf = _base64ToBuffer(b64Key);
    if (buf.byteLength !== 16 && buf.byteLength !== 32) throw new Error(`Bad AES key length: ${buf.byteLength}`);
    return crypto.subtle.importKey("raw", buf, { name: "AES-CBC" }, false, [usage]);
}

async function handleAesDecrypt(cipherB64, keyB64 = AES_KEY) {
    if (!cipherB64) return "";
    try {
        const key = await _importAesKey(keyB64, "decrypt");
        const iv  = _base64ToBuffer(AES_IV);
        const ct  = _base64ToBuffer(cipherB64);
        if (ct.byteLength % 16 !== 0) throw new Error(`Bad ciphertext length: ${ct.byteLength}`);
        const plain = await crypto.subtle.decrypt({ name: "AES-CBC", iv }, key, ct);
        return new TextDecoder().decode(plain);
    } catch (err) {
        // Fallback to hardcoded key if a custom key was tried
        if (keyB64 !== AES_KEY) return handleAesDecrypt(cipherB64, AES_KEY);
        console.error("[CardByte] AES decrypt failed:", err);
        return cipherB64; // return cipher text as-is rather than crashing
    }
}

async function encryptEmail(email = "") {
    if (!email.trim()) { console.warn("[CardByte] encryptEmail: empty email"); return ""; }
    try {
        const key  = await _importAesKey(AES_KEY, "encrypt");
        const iv   = _base64ToBuffer(AES_IV);
        const data = new TextEncoder().encode(email);
        const enc  = await crypto.subtle.encrypt({ name: "AES-CBC", iv }, key, data);
        return _bufferToBase64(enc);
    } catch (err) {
        console.error("[CardByte] encryptEmail failed:", err);
        return "";
    }
}

// ─── Session / Cache ──────────────────────────────────────────────────────────

function _getOrCreateSessionId() {
    let sid = sessionStorage.getItem(SESSION_KEY);
    if (!sid) {
        sid = (crypto.randomUUID?.() ?? Date.now().toString(36));
        sessionStorage.setItem(SESSION_KEY, sid);
    }
    return sid;
}

/**
 * @param {{ skipTtl?: boolean, skipSessionCheck?: boolean }} opts
 * @returns {string|null}
 */
function getCachedSignature({ skipTtl = false, skipSessionCheck = false } = {}) {
    const cached = localStorage.getItem(CACHE_KEY);
    if (!cached) return null;

    if (!skipSessionCheck) {
        const sid = _getOrCreateSessionId();
        if (localStorage.getItem(CACHE_SESSION_KEY) !== sid) {
            console.log("[CardByte] New session — clearing cache");
            _clearCache();
            return null;
        }
    }

    if (!skipTtl) {
        const ts = parseInt(localStorage.getItem(CACHE_TIMESTAMP_KEY) || "0", 10);
        if (Date.now() - ts > CACHE_TTL_MS) {
            console.log("[CardByte] Cache TTL expired — clearing");
            _clearCache();
            return null;
        }
    }

    return cached;
}

function setCachedSignature(html) {
    try {
        const sid = _getOrCreateSessionId();
        localStorage.setItem(CACHE_KEY, html);
        localStorage.setItem(CACHE_SESSION_KEY, sid);
        localStorage.setItem(CACHE_TIMESTAMP_KEY, String(Date.now()));
    } catch (_) { /* quota exceeded — silent */ }
}

function _clearCache() {
    localStorage.removeItem(CACHE_KEY);
    localStorage.removeItem(CACHE_SESSION_KEY);
    localStorage.removeItem(CACHE_TIMESTAMP_KEY);
}

// ─── Platform Detection ───────────────────────────────────────────────────────

function detectPlatform() {
    const platform = (Office?.context?.platform || "").toLowerCase();
    const ua = (navigator?.userAgent || "").toLowerCase();
    const isMobileUA = ua.includes("iphone") || ua.includes("ipad") || ua.includes("android");
    const isMobileOutlook = ua.includes("outlookmobile") || ua.includes("outlook-ios") || ua.includes("outlook-android");

    if (platform === "ios" || platform === "iphone" || platform === "ipad") return "mobile-ios";
    if (platform === "android") return "mobile-android";
    if (isMobileOutlook) return ua.includes("android") ? "mobile-android" : "mobile-ios";
    if ((platform === "officeonline" || platform === "web" || platform === "") && isMobileUA)
        return ua.includes("android") ? "mobile-android" : "mobile-ios";
    if (platform === "mac") return "mac";
    if ((platform === "" || platform === "desktop") && ua.includes("mac") && !isMobileUA) return "mac";
    if (platform === "officeonline" || platform === "web" || platform === "") return "owa";
    return "desktop";
}

// ─── Server Fetch ─────────────────────────────────────────────────────────────

async function renderSignatureOnServer(userEmail) {
    const xPlatform = Office?.context?.diagnostics?.platform === Office?.PlatformType?.Mac ? "MAC" : "WINDOWS";
    const encryptedMail = await encryptEmail(userEmail);

    // Primary: new renderer
    try {
        const res = await fetch(
            "https://newqa-enterprise.cardbyte.ai/email-signature/html/outlook/get-active",
            { method: "GET", headers: { username: encryptedMail, "X-Platform": xPlatform } }
        );
        if (res.ok) {
            const text = await res.text();
            const decrypted = await handleAesDecrypt(text);
            const html = JSON.parse(decrypted)?.html;
            if (html) { console.log("[CardByte] Using NEW renderer"); return html; }
        }
    } catch (err) {
        console.warn("[CardByte] Primary renderer failed:", err);
    }

    // Fallback: legacy renderer
    try {
        const res = await fetch(
            "https://newqa-enterprise.cardbyte.ai/render-signature",
            { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: userEmail }) }
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const html = data?.finalHtml;
        if (html) { console.log("[CardByte] Using LEGACY renderer"); return html; }
    } catch (err) {
        console.error("[CardByte] Both renderers failed:", err);
    }

    return null;
}

// ─── Office API Wrappers ──────────────────────────────────────────────────────

function getBodyAsync(item) {
    return new Promise((resolve, reject) => {
        item.body.getAsync(Office.CoercionType.Html, (r) =>
            r.status === Office.AsyncResultStatus.Succeeded ? resolve(r.value) : reject(r.error)
        );
    });
}

function setBodyAsync(item, html) {
    return new Promise((resolve, reject) => {
        item.body.setAsync(html, { coercionType: Office.CoercionType.Html }, (r) =>
            r.status === Office.AsyncResultStatus.Succeeded ? resolve() : reject(r.error)
        );
    });
}

/**
 * Fallback for when getAsync is unavailable (old Outlook builds).
 * Uses setSignatureAsync if available and body is small enough,
 * otherwise setSelectedDataAsync.
 */
function _injectDirectAsync(item, html) {
    return new Promise((resolve, reject) => {
        const wrapped = _wrapSig(html);
        const sizeOk  = new Blob([wrapped]).size <= 100 * 1024;

        if (sizeOk && typeof item.body.setSignatureAsync === "function") {
            item.body.setSignatureAsync(wrapped, { coercionType: Office.CoercionType.Html }, (r) =>
                r.status === Office.AsyncResultStatus.Succeeded ? resolve() : reject(r.error)
            );
        } else if (typeof item.body.setSelectedDataAsync === "function") {
            item.body.setSelectedDataAsync(wrapped, { coercionType: Office.CoercionType.Html }, (r) =>
                r.status === Office.AsyncResultStatus.Succeeded ? resolve() : reject(r.error)
            );
        } else {
            reject(new Error("[CardByte] No suitable inject API available"));
        }
    });
}

// ─── Signature Resolution ─────────────────────────────────────────────────────

/**
 * Resolves the signature HTML to use, with retry logic and stale-cache fallback.
 */
async function _resolveSignatureHtml(mailbox, { fetchIfMissing = false, skipTtl = false, skipSessionCheck = false } = {}) {
    const userEmail = mailbox?.userProfile?.emailAddress;
    const userProfile = mailbox?.userProfile ?? {};

    // 1. Try fresh cache
    let sigHtml = getCachedSignature({ skipTtl, skipSessionCheck });

    // 2. Fetch from server if allowed and cache is empty
    if (fetchIfMissing && userEmail && sigHtml == null) {
        const MAX_RETRIES = 2;
        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            if (attempt > 0) {
                console.warn(`[CardByte] Retry ${attempt}/${MAX_RETRIES}…`);
                await new Promise(r => setTimeout(r, 1000 * attempt));
            }
            try {
                const result = await renderSignatureOnServer(userEmail);
                if (result != null) { sigHtml = result; break; }
            } catch (err) {
                console.warn(`[CardByte] Fetch attempt ${attempt + 1} failed:`, err);
            }
        }

        if (sigHtml != null) {
            setCachedSignature(sigHtml);
        } else {
            console.error("[CardByte] All fetch attempts failed.");
        }
    }

    // 3. Stale cache as last resort
    if (!sigHtml) {
        const stale = getCachedSignature({ skipTtl: true, skipSessionCheck: true });
        if (stale) { console.warn("[CardByte] Using stale cache."); sigHtml = stale; }
    }

    // 4. Minimal fallback identity block
    if (!sigHtml) {
        console.warn("[CardByte] No signature available — using identity fallback.");
        sigHtml = `
            <table cellpadding="0" cellspacing="0" border="0" width="400">
              <tr>
                <td style="font-family:Arial,sans-serif;font-size:12px;">
                  <strong>${userProfile.displayName || ""}</strong><br/>
                  ${userProfile.emailAddress || ""}<br/>
                  <span style="color:#999;">Sent via CardByte</span>
                </td>
              </tr>
            </table>`;
    }

    return sigHtml;
}

// ─── Core Apply Logic ─────────────────────────────────────────────────────────

async function _applySignatureCore(item, mailbox, opts = {}) {
    const sigHtml = await _resolveSignatureHtml(mailbox, opts);

    try {
        // ── Primary path: read-modify-write at string level ───────────────────
        // This preserves OWA's internal blob:/cid: image references because
        // we never parse the HTML through DOMParser; we only slice strings.
        const currentBody = await getBodyAsync(item);
        const newBody     = replaceSignatureInBody(currentBody, sigHtml);
        await setBodyAsync(item, newBody);
        console.log("[CardByte] Signature applied via string-level replace.");
    } catch (err) {
        // ── Fallback: getAsync unavailable (old builds) ───────────────────────
        console.warn("[CardByte] getAsync unavailable — using direct inject fallback:", err);
        await _injectDirectAsync(item, sigHtml);
    }
}

// ─── Public Entry Points ──────────────────────────────────────────────────────

window.applySignature = async function (event = { completed: () => {} }) {
    const { mailbox } = Office?.context ?? {};
    const item        = mailbox?.item;
    try {
        await _applySignatureCore(item, mailbox, { fetchIfMissing: true });
    } catch (err) {
        console.error("[CardByte] applySignature error:", err);
    } finally {
        event.completed();
    }
};

window.onSendHandler = async function (event = { completed: () => {} }) {
    const { mailbox } = Office?.context ?? {};
    const item        = mailbox?.item;
    try {
        if (!item) return;

        // On send: use stale cache if needed — never block send due to network
        const cachedSig = getCachedSignature({ skipTtl: true, skipSessionCheck: true });
        if (!cachedSig) {
            console.warn("[CardByte] onSendHandler: no cached sig — sending as-is.");
            return;
        }

        const currentBody = await getBodyAsync(item);
        const newBody     = replaceSignatureInBody(currentBody, cachedSig);
        await setBodyAsync(item, newBody);
        console.log("[CardByte] onSendHandler: signature enforced.");
    } catch (err) {
        console.error("[CardByte] onSendHandler error:", err);
    } finally {
        event.completed({ allowEvent: true }); // never block send
    }
};

// ─── Office Action Registration ───────────────────────────────────────────────

Office.onReady(() => {
    console.log(`[CardByte] Office ready. Platform: ${detectPlatform()}`);
});

if (typeof Office?.actions !== "undefined") {
    Office.actions.associate("onSendHandler", onSendHandler);
    Office.actions.associate("applySignature", applySignature);
    console.log("[CardByte] Office.actions registered: onSendHandler, applySignature");
} else {
    console.log("[CardByte] Office.actions unavailable — expected on Outlook 2016/2019");
}