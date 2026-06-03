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
const CB_SIG_START = "__CBSIG_START_7F2C9D4E__";
const CB_SIG_END = "__CBSIG_END_7F2C9D4E__";
const WRAP_TOP_PX = 40;
const WRAP_BOTTOM_PX = 40;

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

var SENTINEL_TD_STYLE =
    "font-size:0px;color:#ffffff;line-height:0;max-height:0;"
    + "overflow:hidden;mso-hide:all;display:none;width:0;";

function _wrapSignature(html) {
    return (
        "<table role=\"presentation\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\" style=\"border:0;border-collapse:collapse;\">"
        + "<tr>"
        + "<td style=\"" + SENTINEL_TD_STYLE + "\">"
        + CB_SIG_START
        + "</td>"
        + "</tr>"
        + "<tr>"
        + "<td style=\"padding-top:" + WRAP_TOP_PX + "px;"
        + "padding-bottom:" + WRAP_BOTTOM_PX + "px;\">"
        + html
        + "</td>"
        + "</tr>"
        + "<tr>"
        + "<td style=\"" + SENTINEL_TD_STYLE + "\">"
        + CB_SIG_END
        + "</td>"
        + "</tr>"
        + "</table>"
    );
}

function clearDefaultSignature(item) {
    return new Promise((resolve) => {
        if (typeof item.body?.setSignatureAsync !== "function") {
            resolve();
            return;
        }
        item.body.setSignatureAsync(
            "",
            { coercionType: Office.CoercionType.Html },
            () => resolve()
        );
    });
}

function bodySetSignatureAsync(item, html) {
    return new Promise((resolve, reject) => {
        const sizeInBytes = new Blob([html]).size;

        if (sizeInBytes <= 100 * 1024 &&
            typeof item.body.setSignatureAsync === "function") {
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

// ─── applySignature (compose time) — unchanged ────────────────────────────────

async function _applySignatureCore(item, mailbox, { fetchIfMissing = false, skipTtl = false, skipSessionCheck = false } = {}) {
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

        if (fetched != null) {
            CACHED_SIGNATURE_HTML = fetched;
            setCachedSignature(fetched);
        }

        if (fetched == null) {
            console.error(`[CardByte] All ${MAX_RETRIES + 1} fetch attempts failed. Last error:`, lastError);
        }
    }

    if (!fetched) {
        const staleCache = getCachedSignature({ skipTtl: true, skipSessionCheck: true });
        if (staleCache) {
            console.warn("[CardByte] Using stale cached signature as last resort after all retries failed.");
            fetched = staleCache;
        } else {
            console.warn("[CardByte] No signature available — using fallback identity signature.");
            fetched = `
            <div contenteditable="false" data-cbsig="true">
                <table cellpadding="0" cellspacing="0" border="0" width="400">
                  <tr>
                    <td style="font-family:Arial,sans-serif;font-size:12px;">
                      <strong>${userProfile.displayName || ""}</strong><br/>
                      ${userProfile.emailAddress || ""}<br/>
                      <span style="color:#999;">Sent via CardByte</span>
                    </td>
                  </tr>
                </table>
            </div>
            `;
        }
    }

    let finalSignature = _wrapSignature(fetched);

    console.log("[CardByte] ════════════════════════════════════",
        fetched ? "Applying signature" : "No cached signature, will fetch from server",
        finalSignature, item?.body
    );

    try {
        await clearDefaultSignature(item);
    } catch (e) {
        console.warn("[CardByte] Failed to clear Outlook signature:", e);
    }

    await bodySetSignatureAsync(item, finalSignature);
    await moveCursorToTop(item);
}

// ─── onSend helpers ───────────────────────────────────────────────────────────

function _getBodyAsync(item) {
    return new Promise((resolve, reject) => {
        item.body.getAsync(
            Office.CoercionType.Html,
            { asyncContext: null },
            (result) => {
                if (result.status === Office.AsyncResultStatus.Succeeded) {
                    resolve(result.value || "");
                } else {
                    reject(result.error);
                }
            }
        );
    });
}

function _setBodyAsync(item, html) {
    return new Promise((resolve, reject) => {
        item.body.setAsync(
            html,
            { coercionType: Office.CoercionType.Html },
            (result) => {
                if (result.status === Office.AsyncResultStatus.Succeeded) {
                    resolve();
                } else {
                    reject(result.error);
                }
            }
        );
    });
}

function _hasCidImages(bodyHtml) {
    return /src=["']cid:/i.test(bodyHtml);
}

function _escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function _guessMimeType(filename) {
    const ext = (filename || "").split(".").pop().toLowerCase();
    const map = {
        jpg: "image/jpeg", jpeg: "image/jpeg",
        png: "image/png",  gif: "image/gif",
        webp: "image/webp", bmp: "image/bmp",
        svg: "image/svg+xml"
    };
    return map[ext] || "image/jpeg";
}

function _getAttachmentContentAsync(item, attachmentId) {
    return new Promise((resolve, reject) => {
        item.getAttachmentContentAsync(attachmentId, (result) => {
            if (result.status === Office.AsyncResultStatus.Succeeded) {
                resolve(result.value.content); // already base64 for binary types
            } else {
                reject(result.error);
            }
        });
    });
}

// Converts every cid: reference in bodyHtml to a base64 data URI so that
// setAsync doesn't orphan the MIME attachment wiring.
async function _resolveCidImages(bodyHtml, item) {
    const cidPattern = /src=["']cid:([^"']+)["']/gi;
    const cids = [];
    let match;

    while ((match = cidPattern.exec(bodyHtml)) !== null) {
        cids.push(match[1]);
    }

    if (cids.length === 0) return bodyHtml;

    const attachments = item.attachments || [];

    for (const cid of cids) {
        const normalizedCid = cid.replace(/^<|>$/g, "");

        const attachment = attachments.find(a => {
            const aid = (a.id || "").replace(/^<|>$/g, "");
            return (
                aid === normalizedCid ||
                a.name === normalizedCid.split("@")[0]
            );
        });

        if (!attachment) {
            console.warn(`[CardByte] No attachment found for cid:${cid}`);
            continue;
        }

        try {
            const base64  = await _getAttachmentContentAsync(item, attachment.id);
            const mime    = _guessMimeType(attachment.name);
            const dataUri = `data:${mime};base64,${base64}`;

            bodyHtml = bodyHtml.replace(
                new RegExp(`src=["']cid:${_escapeRegex(cid)}["']`, "gi"),
                `src="${dataUri}"`
            );

            console.log(`[CardByte] Resolved cid:${cid} → base64 (${attachment.name})`);
        } catch (err) {
            console.warn(`[CardByte] Failed to resolve cid:${cid}`, err);
        }
    }

    return bodyHtml;
}

// Strips ONLY the first (compose-area) CB wrapper table and injects
// freshSignatureHtml in its place. Reply-chain CB signatures are never
// touched because indexOf() returns only the first occurrence.
function _stripAndInjectComposeSignature(bodyHtml, freshSignatureHtml) {
    const startMarkerPos = bodyHtml.indexOf(CB_SIG_START);
    const endMarkerPos   = bodyHtml.indexOf(CB_SIG_END);

    if (startMarkerPos === -1 || endMarkerPos === -1 || endMarkerPos < startMarkerPos) {
        console.warn("[CardByte] No compose-area CB signature found — prepending fresh signature.");
        return freshSignatureHtml + bodyHtml;
    }

    const outerTableStart = bodyHtml.lastIndexOf("<table", startMarkerPos);
    if (outerTableStart === -1) {
        console.warn("[CardByte] CB_SIG_START found but no wrapping <table> — falling back to marker-only strip.");
        const fallbackEnd = bodyHtml.indexOf("</table>", endMarkerPos);
        if (fallbackEnd === -1) return freshSignatureHtml + bodyHtml;
        return (
            bodyHtml.slice(0, startMarkerPos) +
            freshSignatureHtml +
            bodyHtml.slice(fallbackEnd + "</table>".length)
        );
    }

    const CLOSE_TAG     = "</table>";
    const outerTableEnd = bodyHtml.indexOf(CLOSE_TAG, endMarkerPos);
    if (outerTableEnd === -1) {
        console.warn("[CardByte] Could not find closing </table> after CB_SIG_END — stripping to end.");
        return bodyHtml.slice(0, outerTableStart) + freshSignatureHtml;
    }

    const outerTableEndFull = outerTableEnd + CLOSE_TAG.length;
    const before = bodyHtml.slice(0, outerTableStart);
    const after  = bodyHtml.slice(outerTableEndFull);

    console.log(
        `[CardByte] Stripped compose CB signature (chars ${outerTableStart}–${outerTableEndFull}). ` +
        `Reply chain preserved (${after.length} chars follow).`
    );

    return before + freshSignatureHtml + after;
}

// Resolves the signature HTML from cache, then server, then identity fallback.
async function _resolveSignatureHtml(mailbox) {
    let sigHtml = getCachedSignature({ skipTtl: true, skipSessionCheck: true });

    if (!sigHtml) {
        const userEmail = mailbox?.userProfile?.emailAddress;
        if (userEmail) {
            try {
                console.warn("[CardByte] onSend: cache miss — attempting live fetch.");
                sigHtml = await renderSignatureOnServer(userEmail);
                if (sigHtml) setCachedSignature(sigHtml);
            } catch (err) {
                console.error("[CardByte] onSend: live fetch failed:", err);
            }
        }
    }

    if (!sigHtml) {
        const p = mailbox?.userProfile || {};
        console.warn("[CardByte] onSend: using fallback identity signature.");
        sigHtml = `
            <div contenteditable="false" data-cbsig="true">
              <table cellpadding="0" cellspacing="0" border="0" width="400">
                <tr>
                  <td style="font-family:Arial,sans-serif;font-size:12px;">
                    <strong>${p.displayName || ""}</strong><br/>
                    ${p.emailAddress || ""}
                  </td>
                </tr>
              </table>
            </div>`;
    }

    return sigHtml;
}

// ─── onSend core ──────────────────────────────────────────────────────────────
//
// Decision tree:
//
//   Has existing CB sig in body?
//   ├── NO  → setSignatureAsync (safe: nothing in compose zone to strip,
//   │          reply chain untouched)
//   └── YES → cid: images present?
//             ├── NO  → surgical _stripAndInjectComposeSignature + setAsync
//             └── YES → resolve cid: → base64, verify none remain unresolved,
//                        then surgical strip+inject + setAsync

async function _applySignatureOnSend(item, mailbox) {
    let bodyHtml;
    try {
        bodyHtml = await _getBodyAsync(item);
    } catch (err) {
        console.error("[CardByte] onSend: getAsync failed — aborting.", err);
        return;
    }

    const hasExistingCBSig = bodyHtml.indexOf(CB_SIG_START) !== -1;

    // ── No existing CB signature ───────────────────────────────────────────────
    // User deleted it, or applySignature failed at compose time.
    // setSignatureAsync only touches the Outlook signature zone — it never
    // reaches into the reply chain and there's nothing in the compose zone
    // to accidentally strip.
    if (!hasExistingCBSig) {
        console.warn("[CardByte] onSend: no CB signature found — injecting via setSignatureAsync.");
        const sigHtml = await _resolveSignatureHtml(mailbox);
        try {
            await bodySetSignatureAsync(item, _wrapSignature(sigHtml));
        } catch (err) {
            console.error("[CardByte] onSend: setSignatureAsync failed:", err);
        }
        return;
    }

    // ── Existing CB signature present — surgical replacement ───────────────────
    if (_hasCidImages(bodyHtml)) {
        console.log("[CardByte] onSend: cid: images detected — resolving to base64 before setAsync.");
        try {
            bodyHtml = await _resolveCidImages(bodyHtml, item);
        } catch (err) {
            // Resolution failed entirely — safest to leave the existing
            // compose-area sig untouched rather than risk destroying images.
            console.warn("[CardByte] onSend: cid: resolution failed — skipping replacement.", err);
            return;
        }

        // Guard: if any cid: refs remain unresolved (Mac lazy-attachment issue),
        // abort setAsync to protect the images.
        const unresolvedCount = (bodyHtml.match(/src=["']cid:/gi) || []).length;
        if (unresolvedCount > 0) {
            console.warn(`[CardByte] onSend: ${unresolvedCount} cid: ref(s) still unresolved — skipping setAsync.`);
            return;
        }
    }

    const sigHtml     = await _resolveSignatureHtml(mailbox);
    const patchedBody = _stripAndInjectComposeSignature(bodyHtml, _wrapSignature(sigHtml));

    try {
        await _setBodyAsync(item, patchedBody);
        console.log("[CardByte] onSend: surgical replacement complete.");
    } catch (err) {
        console.error("[CardByte] onSend: setAsync failed:", err);
    }
}

// ─── Public handlers ──────────────────────────────────────────────────────────

window.applySignature = async function (event = { completed: () => {} }, options = {}) {
    const mailbox = Office?.context?.mailbox;
    const item    = mailbox?.item;

    try {
        await _applySignatureCore(item, mailbox, { fetchIfMissing: true });
    } catch (err) {
        console.error("[CardByte] Error in applySignature:", err);
    } finally {
        event.completed();
    }
};

window.onSendHandler = async function (event = { completed: () => {} }) {
    const mailbox = Office?.context?.mailbox;
    const item    = mailbox?.item;

    try {
        if (!item) return;
        await _applySignatureOnSend(item, mailbox);
    } catch (err) {
        console.error("[CardByte] Error in onSendHandler:", err);
    } finally {
        event.completed({ allowEvent: true });
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