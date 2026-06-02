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

// ─── Signature Body Helpers ───────────────────────────────────────────────────

function replaceSignatureInBody(bodyHtml, cachedSig) {
    if (!bodyHtml) return "";

    if (!cachedSig) {
        console.warn("[CardByte] replaceSignatureInBody: no cached signature — body unchanged.");
        return bodyHtml;
    }

    const parser = new DOMParser();
    const doc = parser.parseFromString(bodyHtml, "text/html");
    const body = doc.body;

    const freshHtml = `<div data-cbsig="true" style="margin-top:40px"></div>${cachedSig}<div style="margin-top:40px"></div>`;

    // Helper: insert freshHtml nodes before referenceNode, or append if null.
    function insertFreshSig(referenceNode, parent) {
        const tmp = parser.parseFromString(freshHtml, "text/html").body;
        while (tmp.firstChild) {
            if (referenceNode) {
                parent.insertBefore(tmp.firstChild, referenceNode);
            } else {
                parent.appendChild(tmp.firstChild);
            }
        }
    }

    const sentinel = body.querySelector('[data-cbsig="true"]');

    if (sentinel) {
        // ── Remove CardByte-injected nodes after the sentinel ────────────────
        // Stop at the first reply-chain boundary to preserve quoted threads.
        let node = sentinel.nextSibling;
        while (node) {
            const next = node.nextSibling;
            if (_isReplyChainBoundary(node)) break;
            node.parentNode.removeChild(node);
            node = next;
        }

        // ── Swap sentinel for fresh signature ────────────────────────────────
        insertFreshSig(sentinel, sentinel.parentNode);
        sentinel.remove();

    } else {
        // ── Sentinel was deleted — re-insert before reply chain or at end ────
        const replyChainStart = _findReplyChainStart(body);
        insertFreshSig(replyChainStart, body); // null → appends at end
    }

    return body.innerHTML;
}

function _isReplyChainBoundary(node) {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) return false;

    const tag = node.tagName?.toUpperCase();

    if (tag === "HR") return true;           // Classic Outlook reply divider
    if (tag === "BLOCKQUOTE") return true;   // Gmail / OWA quoted content

    const id = (node.id || "").toLowerCase();
    const cls = (node.className || "").toLowerCase();
    const dm = node.getAttribute?.("data-marker") || "";

    if (id.includes("divreplycontainer")) return true;  // OWA reply container
    if (id.includes("appendonsend")) return true;  // OWA reply zone
    if (cls.includes("gmail_quote")) return true;
    if (cls.includes("yahoo_quoted")) return true;
    if (dm.includes("__pblfooter")) return true;  // some mail clients

    // Outlook desktop forward/reply header div (has a top border style)
    const style = node.getAttribute?.("style") || "";
    if (tag === "DIV" && style.includes("border-top")) return true;

    return false;
}

function _findReplyChainStart(bodyEl) {
    for (const child of Array.from(bodyEl.childNodes)) {
        if (_isReplyChainBoundary(child)) return child;
    }
    return null;
}

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
    } catch (_) { }
}

const MAX_SAFE_HTML_SIZE = 500_000;
const MAX_SAFE_HTML_SIZE_MOBILE = 200_000;
const MOBILE_MAX_IMAGE_WIDTH = 200;
const MOBILE_IMAGE_QUALITY = 0.5;

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

/**
 * Reads the current compose body as HTML.
 */
function getBodyAsync(item) {
    return new Promise((resolve, reject) => {
        item.body.getAsync(Office.CoercionType.Html, (r) => {
            if (r.status === Office.AsyncResultStatus.Succeeded) resolve(r.value);
            else reject(r.error);
        });
    });
}

/**
 * Writes a full HTML string back as the compose body.
 * Used after replaceSignatureInBody to set the stitched result.
 */
function setBodyAsync(item, html) {
    return new Promise((resolve, reject) => {
        item.body.setAsync(html, { coercionType: Office.CoercionType.Html }, (r) => {
            if (r.status === Office.AsyncResultStatus.Succeeded) resolve();
            else reject(r.error);
        });
    });
}

function bodySetSignatureAsync(item, html) {
    return new Promise((resolve, reject) => {
        const sizeInBytes = new Blob([html]).size;

        if (sizeInBytes <= 100 * 1024 && typeof item.body.setSignatureAsync === "function") {
            item.body.setSignatureAsync(
                html,
                { coercionType: Office.CoercionType.Html },
                (r) => {
                    if (r.status === Office.AsyncResultStatus.Succeeded) resolve();
                    else reject(r.error);
                }
            );
        } else {
            if (typeof item.body.setSelectedDataAsync !== "function") {
                reject(new Error("setSelectedDataAsync not available"));
                return;
            }
            item.body.setSelectedDataAsync(
                html,
                { coercionType: Office.CoercionType.Html },
                (r) => {
                    if (r.status === Office.AsyncResultStatus.Succeeded) resolve();
                    else reject(r.error);
                }
            );
        }
    });
}

function moveCursorToTop(item) {
    return new Promise((resolve) => {
        try {
            if (typeof item.body?.prependAsync !== "function") { resolve(); return; }
            item.body.prependAsync("", { coercionType: Office.CoercionType.Text }, () => {
                if (typeof item.body?.setSelectedDataAsync !== "function") { resolve(); return; }
                item.body.setSelectedDataAsync("", { coercionType: Office.CoercionType.Text }, () => resolve());
            });
        } catch { resolve(); }
    });
}

// ─── Signature fetch + resolve ────────────────────────────────────────────────

async function _resolveSignatureHtml(mailbox, { fetchIfMissing = false, skipTtl = false, skipSessionCheck = false } = {}) {
    const userProfile = mailbox?.userProfile || {};
    const userEmail = userProfile?.emailAddress;

    let fetched = getCachedSignature({ skipTtl, skipSessionCheck });

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
                    fetched = result;
                    break;
                }
                lastError = new Error("Server returned null");
            } catch (err) {
                lastError = err;
                console.warn(`[CardByte] Fetch attempt ${attempt + 1} failed:`, err);
            }
            attempt++;
        }

        if (fetched != null) {
            CACHED_SIGNATURE_HTML = fetched;
            setCachedSignature(fetched);
        } else {
            console.error(`[CardByte] All ${MAX_RETRIES + 1} fetch attempts failed. Last error:`, lastError);
        }
    }

    // Last-ditch: stale cache beats nothing
    if (!fetched) {
        const staleCache = getCachedSignature({ skipTtl: true, skipSessionCheck: true });
        if (staleCache) {
            console.warn("[CardByte] Using stale cached signature as last resort.");
            fetched = staleCache;
        }
    }

    // Absolute fallback: minimal identity block
    if (!fetched) {
        console.warn("[CardByte] No signature available — using fallback identity signature.");
        fetched = `
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

    return fetched;
}

// ─── Main entry points ────────────────────────────────────────────────────────

async function _applySignatureCore(item, mailbox, { fetchIfMissing = false, skipTtl = false, skipSessionCheck = false } = {}) {
    const sigHtml = await _resolveSignatureHtml(mailbox, { fetchIfMissing, skipTtl, skipSessionCheck });

    let currentBody = null;
    try {
        currentBody = await getBodyAsync(item);
    } catch (err) {
        console.warn("[CardByte] getAsync failed — falling back to bodySetSignatureAsync:", err);
    }

    if (currentBody !== null) {
        console.log("[CardByte] ════ Applying signature (surgical replace)");
        const newBody = replaceSignatureInBody(currentBody, sigHtml);
        await setBodyAsync(item, newBody);
    } else {
        // Fallback: getAsync unavailable (old Outlook build)
        console.log("[CardByte] ════ Applying signature (direct inject fallback)");
        const wrapper = `<div data-cbsig="true" style="margin-top:40px"></div>${sigHtml}<div style="margin-top:40px"></div>`;
        await bodySetSignatureAsync(item, wrapper);
    }
}

window.applySignature = async function (event = { completed: () => { } }, options = {}) {
    const mailbox = Office?.context?.mailbox;
    const item = mailbox?.item;

    try {
        await _applySignatureCore(item, mailbox, { fetchIfMissing: true });
    } catch (err) {
        console.error("[CardByte] Error in applySignature:", err);
    } finally {
        event.completed();
    }
};

window.onSendHandler = async function (event = { completed: () => { } }) {
    const mailbox = Office?.context?.mailbox;
    const item = mailbox?.item;

    try {
        if (!item) return;

        const cachedSig = getCachedSignature({ skipTtl: true, skipSessionCheck: true });

        if (!cachedSig) {
            console.warn("[CardByte] onSendHandler: no cached signature — sending as-is.");
            return;
        }

        const currentBody = await getBodyAsync(item);
        const newBody = replaceSignatureInBody(currentBody, cachedSig);
        await setBodyAsync(item, newBody);

        console.log("[CardByte] onSendHandler: signature enforced — reply chain preserved.");

    } catch (err) {
        console.error("[CardByte] Error in onSendHandler:", err);
    } finally {
        event.completed({ allowEvent: true }); // never block send
    }
};

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