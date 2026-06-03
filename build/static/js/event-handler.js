// ─── Constants ────────────────────────────────────────────────────────────────

const AES_KEY = "fnItrY2YfozBqCC2B4XsfqHIvZku3kUOq3DFkbO64kk=";
const AES_IV = "3YapeNfJDung7TXxeKXn4g==";

// localStorage keys
const CACHE_KEY = "cardbyte_cached_signature";
const CACHE_SESSION_KEY = "cardbyte_cached_signature_session";
const CACHE_TIMESTAMP_KEY = "cardbyte_cached_signature_ts";
const SESSION_KEY = "cardbyte_session_id";
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// CB_SIG sentinel tokens — embedded as HTML comments.
// HTML comments are preserved through OWA's sanitizer.
// Used for tampering detection in onSendHandler.
const CB_SIG_START = "<!--CBSIG_START_7F2C9D4E-->";
const CB_SIG_END = "<!--CBSIG_END_7F2C9D4E-->";

// Per-compose-item insertion tracker. Prevents double-insertion when
// applySignature fires more than once for the same item in a session.
const _insertedItems = new Set();

// ─── Platform ─────────────────────────────────────────────────────────────────

function detectPlatform() {
    const p = (Office?.context?.platform || "").toLowerCase();
    const ua = (navigator?.userAgent || "").toLowerCase();

    if (p === "ios" || p === "iphone" || p === "ipad") return "mobile-ios";
    if (p === "android") return "mobile-android";

    if (ua.includes("outlookmobile") || ua.includes("outlook-ios") || ua.includes("outlook-android"))
        return ua.includes("android") ? "mobile-android" : "mobile-ios";

    if ((p === "officeonline" || p === "web" || p === "") &&
        (ua.includes("iphone") || ua.includes("ipad") || ua.includes("android")))
        return ua.includes("android") ? "mobile-android" : "mobile-ios";

    if (p === "mac") return "mac";

    if ((p === "" || p === "desktop") &&
        (ua.includes("macintosh") || ua.includes("mac os x")) &&
        !ua.includes("iphone") && !ua.includes("ipad"))
        return "mac";

    if (p === "officeonline" || p === "web" || p === "") return "owa";
    return "desktop"; // retained for detectPlatform callers, but no longer routed to Classic path
}

// ─── Session cache ────────────────────────────────────────────────────────────

function _getSessionId() {
    let sid = sessionStorage.getItem(SESSION_KEY);
    if (!sid) {
        sid = (crypto.randomUUID?.() ?? Date.now().toString(36));
        sessionStorage.setItem(SESSION_KEY, sid);
    }
    return sid;
}

function _clearCache() {
    localStorage.removeItem(CACHE_KEY);
    localStorage.removeItem(CACHE_SESSION_KEY);
    localStorage.removeItem(CACHE_TIMESTAMP_KEY);
}

function getCachedSignature({ skipTtl = false, skipSessionCheck = false } = {}) {
    if (skipSessionCheck) return localStorage.getItem(CACHE_KEY);

    const sid = _getSessionId();
    if (localStorage.getItem(CACHE_SESSION_KEY) !== sid) {
        console.log("[CardByte] New session — clearing cache");
        _clearCache();
        return null;
    }

    if (!skipTtl) {
        const ts = parseInt(localStorage.getItem(CACHE_TIMESTAMP_KEY) || "0", 10);
        if (Date.now() - ts > CACHE_TTL_MS) {
            console.log("[CardByte] Cache TTL expired — clearing");
            _clearCache();
            return null;
        }
    }

    return localStorage.getItem(CACHE_KEY);
}

function setCachedSignature(html) {
    try {
        localStorage.setItem(CACHE_KEY, html);
        localStorage.setItem(CACHE_SESSION_KEY, _getSessionId());
        localStorage.setItem(CACHE_TIMESTAMP_KEY, Date.now().toString());
    } catch (_) { }
}

// ─── Crypto ───────────────────────────────────────────────────────────────────

function _b64ToBuffer(b64) {
    let s = b64.replace(/-/g, "+").replace(/_/g, "/");
    const pad = s.length % 4;
    if (pad) s += "=".repeat(4 - pad);
    const bin = atob(s);
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    return buf.buffer;
}

function _bufferToB64(buf) {
    const bytes = new Uint8Array(buf);
    let s = "";
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
}

async function _aesKey(usage) {
    return crypto.subtle.importKey("raw", _b64ToBuffer(AES_KEY), { name: "AES-CBC" }, false, [usage]);
}

async function encryptEmail(email = "") {
    if (!email?.trim()) return "";
    try {
        const key = await _aesKey("encrypt");
        const enc = await crypto.subtle.encrypt(
            { name: "AES-CBC", iv: _b64ToBuffer(AES_IV) },
            key,
            new TextEncoder().encode(email)
        );
        return _bufferToB64(enc);
    } catch (err) {
        console.error("[CardByte] encryptEmail failed:", err);
        return "";
    }
}

async function decryptResponse(cipherB64) {
    if (!cipherB64) return "";
    try {
        const buf = _b64ToBuffer(cipherB64);
        if (buf.byteLength % 16 !== 0) throw new Error(`Bad length: ${buf.byteLength}`);
        const key = await _aesKey("decrypt");
        const dec = await crypto.subtle.decrypt({ name: "AES-CBC", iv: _b64ToBuffer(AES_IV) }, key, buf);
        return new TextDecoder().decode(dec);
    } catch (err) {
        console.warn("[CardByte] decryptResponse failed — using raw:", err.message);
        return cipherB64;
    }
}

// ─── Signature wrapping / stripping ──────────────────────────────────────────

function _wrapSignature(html) {
    return `${CB_SIG_START}${html}${CB_SIG_END}`;
}

// Removes ALL CardByte and native Outlook signature artifacts from an HTML string.
function stripSignatures(html) {
    if (!html) return "";

    // Native Outlook div-based signatures
    html = html.replace(/<div[^>]*\bid=["']Signature["'][^>]*>[\s\S]*?<\/div>/gi, "");
    html = html.replace(/<div[^>]*\bid=["']appendonsend["'][^>]*>[\s\S]*?<\/div>/gi, "");

    // Legacy V1 markers
    html = html.replace(/__CARDBYTE_SIG_START_V1__[\s\S]*?__CARDBYTE_SIG_END_V1__/gi, "");

    // CB_SIG comment-sentinel walk — loop handles double-insert edge case.
    for (let i = 0; i < 10; i++) {
        const si = html.indexOf(CB_SIG_START);
        const ei = html.indexOf(CB_SIG_END);
        if (si === -1 && ei === -1) break;

        if (si === -1 || ei === -1) {
            html = html.replace(CB_SIG_START, "").replace(CB_SIG_END, "");
            break;
        }

        html = html.slice(0, si) + html.slice(ei + CB_SIG_END.length);
    }

    // Cosmetic clean-up
    return html
        .replace(/(?:\s*<br\s*\/?>)+\s*$/gi, "")
        .replace(/<div>\s*<\/div>/gi, "")
        .replace(/<p>\s*<\/p>/gi, "");
}

// ─── Body helpers ─────────────────────────────────────────────────────────────

function _getBodyAsync(item) {
    return new Promise((resolve, reject) => {
        if (typeof item.body.getAsync !== "function") return reject(new Error("getAsync unavailable"));
        item.body.getAsync(Office.CoercionType.Html, r =>
            r.status === Office.AsyncResultStatus.Succeeded ? resolve(r.value || "") : reject(r.error)
        );
    });
}

function _prependEmpty(item) {
    return new Promise(resolve => {
        if (typeof item.body.prependAsync !== "function") return resolve();
        item.body.prependAsync("", { coercionType: Office.CoercionType.Text }, () => resolve());
    });
}

function _setSelectedData(item, html) {
    return new Promise(resolve => {
        item.body.setSelectedDataAsync(
            html,
            { coercionType: Office.CoercionType.Html },
            r => resolve(r.status === Office.AsyncResultStatus.Succeeded)
        );
    });
}

// ─── Write signature ──────────────────────────────────────────────────────────
//
// Two paths — chosen in order:
//
// PATH A  setSignatureAsync + sig < 100 KB
//   Outlook manages its own signature slot. Fast, reliable, no body read needed.
//   A no-op setSelectedDataAsync("") moves the cursor to the top afterwards.
//
// PATH B  OWA / modern Outlook / Mac
//   Read body → strip any existing CardByte sig → prepend new sig → write.
//   Outlook owns the quoted thread structure; no chain reassembly needed.
//   On forceReplace (onSendHandler), same strip-then-write logic applies,
//   guaranteeing the output is exactly: [user draft] + [new signature].

async function writeSignatureAsync(item, wrappedHtml, forceReplace = false) {
    const sizeKB = new Blob([wrappedHtml]).size / 1024;
    const itemId = item.itemId || item.conversationId || "unknown";

    console.log(`[CardByte] writeSignatureAsync | ${sizeKB.toFixed(1)} KB | forceReplace=${forceReplace} | platform=${detectPlatform()}`);

    // ── PATH A ────────────────────────────────────────────────────────────────
    if (typeof item.body.setSignatureAsync === "function" && sizeKB < 100) {
        if (!forceReplace && _insertedItems.has(itemId)) {
            console.log("[CardByte] PATH A: already inserted — skipping");
            return true;
        }

        await new Promise((resolve, reject) =>
            item.body.setSignatureAsync(wrappedHtml, { coercionType: Office.CoercionType.Html }, r =>
                r.status === Office.AsyncResultStatus.Succeeded ? resolve() : reject(r.error)
            )
        );

        // Move cursor to top (best-effort)
        if (typeof item.body.setSelectedDataAsync === "function") {
            await new Promise(resolve =>
                item.body.setSelectedDataAsync("", { coercionType: Office.CoercionType.Text }, () => resolve())
            );
        }

        _insertedItems.add(itemId);
        console.log("[CardByte] PATH A: succeeded");
        return true;
    }

    if (typeof item.body.setSelectedDataAsync !== "function") {
        console.error("[CardByte] setSelectedDataAsync unavailable — cannot insert");
        return false;
    }

    // ── PATH B  OWA / modern Outlook / Mac ────────────────────────────────────
    // Always read the live body so we can strip any existing CardByte signature
    // before writing. This is the critical step that prevents duplication on
    // forceReplace (onSendHandler): old sig is removed, new sig is appended,
    // leaving exactly [clean user draft] + [new signature].
    if (!forceReplace && _insertedItems.has(itemId)) {
        console.log("[CardByte] PATH B: already inserted — skipping");
        return true;
    }

    let currentBody = "";
    try {
        currentBody = await _getBodyAsync(item);
    } catch (_) {
        console.warn("[CardByte] PATH B: getAsync failed — treating body as empty");
    }

    // Strip old CardByte sig (and any native Outlook sig) from the live body.
    // On a fresh compose this is a no-op. On forceReplace it removes the old
    // signature so the new one won't be appended on top of it.
    const cleanBody = stripSignatures(currentBody);

    // Reassemble: clean user draft first, then new wrapped signature at the end.
    // Signature goes at the END so the user's text appears above it naturally.
    const combined = cleanBody + wrappedHtml;

    // prependAsync("") moves the internal cursor to position 0 so
    // setSelectedDataAsync replaces from the very beginning of the body.
    await _prependEmpty(item);
    const ok = await _setSelectedData(item, combined);
    if (ok) _insertedItems.add(itemId);

    console.log(`[CardByte] PATH B: ${ok ? "succeeded" : "failed"}`);
    return ok;
}

// ─── Backend fetch ────────────────────────────────────────────────────────────

async function renderSignatureOnServer(email) {
    const xPlatform = Office.context.diagnostics.platform === Office.PlatformType.Mac ? "MAC" : "WINDOWS";
    const encrypted = await encryptEmail(email);
    if (!encrypted) throw new Error("Email encryption failed");

    // Primary endpoint
    try {
        const res = await fetch(
            "https://newqa-enterprise.cardbyte.ai/email-signature/html/outlook/get-active",
            { method: "GET", headers: { username: encrypted, "X-Platform": xPlatform } }
        );
        if (res.ok) {
            const plain = await decryptResponse(await res.text());
            const html = JSON.parse(plain)?.html;
            if (html) { console.log("[CardByte] NEW renderer OK"); return html; }
        }
        console.warn("[CardByte] Primary endpoint failed — trying legacy");
    } catch (err) {
        console.warn("[CardByte] Primary endpoint threw — trying legacy:", err.message);
    }

    // Legacy fallback
    const res = await fetch(
        "https://newqa-enterprise.cardbyte.ai/render-signature",
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email }) }
    );
    if (!res.ok) throw new Error(`Legacy renderer HTTP ${res.status}`);
    const data = await res.json();
    if (!data?.finalHtml) throw new Error("Legacy renderer: missing finalHtml");
    console.log("[CardByte] LEGACY renderer OK");
    return data.finalHtml;
}

// ─── Tampering detection ──────────────────────────────────────────────────────

async function isSignatureIntact(item) {
    try {
        const body = await _getBodyAsync(item);
        const ok = body.includes(CB_SIG_START) && body.includes(CB_SIG_END);
        console.log(`[CardByte] isSignatureIntact: ${ok}`);
        return ok;
    } catch (_) {
        console.warn("[CardByte] isSignatureIntact: read failed — assuming intact");
        return true;
    }
}

// ─── Core apply flow ──────────────────────────────────────────────────────────

async function _applySignatureCore(item, mailbox, {
    fetchIfMissing = false,
    skipTtl = false,
    skipSessionCheck = false,
    forceReplace = false,
} = {}) {
    const profile = mailbox?.userProfile ?? {};
    const email = profile?.emailAddress;

    let wrapped = getCachedSignature({ skipTtl, skipSessionCheck });

    if (fetchIfMissing && email && !wrapped) {
        let lastErr = null;

        for (let attempt = 0; attempt <= 2; attempt++) {
            try {
                if (attempt > 0) {
                    console.warn(`[CardByte] Retry fetch attempt ${attempt}/2`);
                    await new Promise(r => setTimeout(r, 1000 * attempt));
                }
                const html = await renderSignatureOnServer(email);
                if (html) {
                    wrapped = _wrapSignature(html);
                    setCachedSignature(wrapped);
                    break;
                }
                lastErr = new Error("Server returned null");
            } catch (err) {
                lastErr = err;
                console.warn(`[CardByte] Fetch attempt ${attempt + 1} failed:`, err.message);
            }
        }

        if (!wrapped) console.error("[CardByte] All fetch attempts failed:", lastErr?.message);
    }

    // Fallback chain
    if (!wrapped) {
        wrapped = getCachedSignature({ skipTtl: true, skipSessionCheck: true });
        if (wrapped) {
            console.warn("[CardByte] Using stale cached signature");
        } else {
            console.warn("[CardByte] No signature available — using fallback identity");
            wrapped = _wrapSignature(
                `<table cellpadding="0" cellspacing="0" border="0" width="400">
                   <tr><td style="font-family:Arial,sans-serif;font-size:12px;">
                     <strong>${profile.displayName || ""}</strong><br/>
                     ${profile.emailAddress || ""}<br/>
                     <span style="color:#999;">Sent via CardByte</span>
                   </td></tr>
                 </table>`
            );
        }
    }

    console.log(`[CardByte] Applying signature | forceReplace=${forceReplace} | sizeKB=${(new Blob([wrapped]).size / 1024).toFixed(1)}`);
    await writeSignatureAsync(item, wrapped, forceReplace);
}

// ─── Office.onReady ───────────────────────────────────────────────────────────

Office.onReady(() => {
    console.log("✅ Office.onReady is Started !");
    console.log(`[CardByte] Platform detected: ${detectPlatform()}`);
});

// ─── Event handlers ───────────────────────────────────────────────────────────

window.applySignature = async function (event = { completed: () => { } }) {
    const mailbox = Office?.context?.mailbox;
    try {
        await _applySignatureCore(mailbox?.item, mailbox, { fetchIfMissing: true });
    } catch (err) {
        console.error("[CardByte] applySignature error:", err);
    } finally {
        event.completed();
    }
};

window.onSendHandler = async function (event = { completed: () => { } }) {
    const mailbox = Office?.context?.mailbox;
    const item = mailbox?.item;
    try {
        if (!item) return;

        // skipSessionCheck=true: onSendHandler may run in a separate iframe
        // (modern Outlook) with fresh sessionStorage — won't match compose iframe's SID.
        const cached = getCachedSignature({ skipTtl: true, skipSessionCheck: true });
        if (!cached) {
            console.log("[CardByte] onSendHandler: no cached signature — passing through");
            return;
        }

        // Always re-apply on send with forceReplace=true.
        // writeSignatureAsync will: read body → stripSignatures (removes old sig)
        // → write cleanBody + new sig. No duplication possible.
        console.log("[CardByte] onSendHandler: re-applying signature to ensure integrity");
        await writeSignatureAsync(item, cached, true /* forceReplace */);

    } catch (err) {
        console.error("[CardByte] onSendHandler error:", err);
    } finally {
        event.completed({ allowEvent: true });
    }
};

// ─── Handler registration ─────────────────────────────────────────────────────

if (typeof Office !== "undefined" && Office.actions) {
    Office.actions.associate("applySignature", applySignature);
    Office.actions.associate("onSendHandler", onSendHandler);
    console.log("[CardByte] Handlers registered: applySignature, onSendHandler");
} else {
    console.log("[CardByte] Office.actions unavailable — LaunchEvent path inactive (expected on Outlook 2016/2019)");
}