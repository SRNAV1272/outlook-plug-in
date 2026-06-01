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

function getOrCreateSessionId() {
    let sid = sessionStorage.getItem(SESSION_KEY);
    if (!sid) {
        sid = crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36);
        sessionStorage.setItem(SESSION_KEY, sid);
    }
    return sid;
}

// FIX: Added skipSessionCheck option so onSendHandler (which runs in a separate
// iframe/JS context with a fresh sessionStorage) can still read the cached
// signature that was stored by applySignature in the compose iframe.

function getCachedSignature({ skipTtl = false, skipSessionCheck = false } = {}) {
    // If skipping session check, just return whatever is in cache directly
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

function isMobile() {
    const p = detectPlatform();
    return p === "mobile-ios" || p === "mobile-android";
}

function isOWA() { return detectPlatform() === "owa"; }
function isMac() { return detectPlatform() === "mac"; }

function getMaxHtmlSize() {
    return isMobile() ? MAX_SAFE_HTML_SIZE_MOBILE : MAX_SAFE_HTML_SIZE;
}

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
            "https://ns-enterprise.cardbyte.ai/email-signature/html/outlook/get-active",
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
            "https://ns-renderer.cardbyte.ai/render-signature",
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

function compressBase64Image(dataUrl, maxWidth, quality) {
    if (maxWidth === undefined) maxWidth = isMobile() ? MOBILE_MAX_IMAGE_WIDTH : 300;
    if (quality === undefined) quality = isMobile() ? MOBILE_IMAGE_QUALITY : 0.7;

    return new Promise((resolve) => {
        if (dataUrl.startsWith("data:image/gif")) { resolve(dataUrl); return; }
        const img = new Image();
        img.onload = () => {
            try {
                const canvas = document.createElement("canvas");
                let width = img.width;
                let height = img.height;
                if (width > maxWidth) { height = Math.round((height * maxWidth) / width); width = maxWidth; }
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext("2d");
                const isPng = dataUrl.startsWith("data:image/png");
                if (isPng) {
                    ctx.clearRect(0, 0, width, height);
                    ctx.drawImage(img, 0, 0, width, height);
                    let result = canvas.toDataURL("image/png");
                    if (result.length >= dataUrl.length) { resolve(dataUrl); return; }
                    console.log(`[CardByte] Compressed PNG: ${(dataUrl.length / 1024).toFixed(0)}KB -> ${(result.length / 1024).toFixed(0)}KB`);
                    resolve(result); return;
                }
                ctx.drawImage(img, 0, 0, width, height);
                let result = canvas.toDataURL("image/jpeg", quality);
                if (result.length >= dataUrl.length) result = canvas.toDataURL("image/png");
                if (result.length >= dataUrl.length) { resolve(dataUrl); return; }
                console.log(`[CardByte] Compressed: ${(dataUrl.length / 1024).toFixed(0)}KB -> ${(result.length / 1024).toFixed(0)}KB`);
                resolve(result);
            } catch (e) { console.warn("[CardByte] Canvas compression failed:", e); resolve(dataUrl); }
        };
        img.onerror = () => resolve(dataUrl);
        img.src = dataUrl;
    });
}

async function compressImagesInHtml(html) {
    if (!html) return html;

    const parser = new DOMParser();
    const doc = parser.parseFromString(html, "text/html");
    const profileImg = doc.querySelector('img[alt="Profile Photo"]');

    if (!profileImg) return html;

    const src = profileImg.getAttribute('src');
    if (!src || !src.startsWith('data:image/')) return html;

    console.log(`[CardByte] Compressing profile picture (${(src.length / 1024).toFixed(0)}KB)`);

    const compressed = await compressBase64Image(src);
    if (compressed === src) return html;

    console.log(`[CardByte] Profile picture compressed: ${(src.length / 1024).toFixed(0)}KB -> ${(compressed.length / 1024).toFixed(0)}KB`);

    return html.replace(src, compressed);
}

function extractBase64Images(html) {
    const images = [];
    let index = 0;
    const cleanedHtml = html.replace(
        /src\s*=\s*"data:(image\/([^;]+));base64,([^"]+)"/gi,
        (_match, mimeType, extension, base64Data) => {
            const cid = `cardbyte_img_${index}`;
            const safeExt = extension.replace(/[^a-z0-9]/gi, "") || "png";
            const fileName = `${cid}.${safeExt}`;
            images.push({ cid, fileName, mimeType, base64Data });
            index++;
            return `src="cid:${cid}"`;
        }
    );
    return { cleanedHtml, images };
}

function addInlineImageAttachment(item, { cid, fileName, base64Data }) {
    return new Promise((resolve, reject) => {
        if (typeof item.addFileAttachmentFromBase64Async !== "function") {
            console.warn("[CardByte] addFileAttachmentFromBase64Async not available");
            resolve(false); return;
        }
        item.addFileAttachmentFromBase64Async(
            base64Data, fileName, { isInline: true, contentId: cid },
            (result) => {
                if (result.status === Office.AsyncResultStatus.Succeeded) resolve(true);
                else { console.error(`[CardByte] Attach failed ${cid}:`, result.error); reject(result.error); }
            }
        );
    });
}

function bodySetSignatureAsync(item, html) {
    return new Promise((resolve, reject) => {
        if (typeof item.body.setSignatureAsync !== "function") { reject(new Error("setSignatureAsync not available")); return; }
        item.body.setSignatureAsync(html, { coercionType: Office.CoercionType.Html }, (r) => {
            if (r.status === "succeeded") resolve(); else reject(r.error);
        });
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

// FIX: Added skipSessionCheck param so onSendHandler (separate iframe, fresh
// sessionStorage) can still read the signature cached by the compose iframe.
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
                    await new Promise(r => setTimeout(r, 1000 * attempt)); // 1s, then 2s
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
            // Compress immediately after fetch and store compressed version
            fetched = await compressImagesInHtml(fetched);
            CACHED_SIGNATURE_HTML = fetched;
            setCachedSignature(fetched);  // ← store compressed, not raw
        }

        if (fetched == null) {
            console.error(`[CardByte] All ${MAX_RETRIES + 1} fetch attempts failed. Last error:`, lastError);
        }
    }

    // FIX: If signature is still null (server down, cache miss, no email, etc.)
    // fall back to a minimal identity signature instead of inserting "null".
    // Fallback only if everything above — fresh fetch, retries — all came up empty
    if (!fetched) {
        // Last-ditch: try reading stale cache, bypassing both session and TTL checks
        const staleCache = getCachedSignature({ skipTtl: true, skipSessionCheck: true });
        if (staleCache) {
            console.warn("[CardByte] Using stale cached signature as last resort after all retries failed.");
            fetched = staleCache;
        } else {
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
                </table>
            `;
        }
    }

    // let compressedSignature = await compressImagesInHtml(fetched);
    // compressedSignature = "<div style='margin-top:40px'></div>" + compressedSignature + "<div style='margin-top:40px'></div>";

    let finalSignature = `
        <table role="presentation" cellpadding="0" cellspacing="0" border="0">
        <tr>
            <td style="padding-top:40px; padding-bottom:40px;">
            ${fetched}
            </td>
        </tr>
        </table>
        `;

    console.log("[CardByte] ════════════════════════════════════",
        fetched ? "Applying signature" : "No cached signature, will fetch from server",
        finalSignature, item?.body
    );

    // await bodySetSignatureAsync(item, finalSignature);
    // await moveCursorToTop(item);
    try {
        await bodySetSignatureAsync(item, finalSignature);
    } catch (err) {
        const isOutOfRange =
            err?.code === 5009 ||
            (typeof err?.message === "string" &&
                err.message.toLowerCase().includes("argumentoutofrange"));

        if (isOutOfRange) {
            console.warn("[CardByte] ArgumentOutOfRangeException — HTML too large. Diagnosing size...");

            // 1. Extract profile photo src
            const profileSrc = extractProfilePhotoSrc(fetched);
            const totalHtmlBytes = new TextEncoder().encode(finalSignature).length;

            let profileSrcBytes = 0;
            if (profileSrc) {
                profileSrcBytes = new TextEncoder().encode(profileSrc).length;
            }

            // 2. Calculate sizes
            const htmlWithoutImageBytes = totalHtmlBytes - profileSrcBytes;
            const LIMIT_KB = 100;
            const totalHtmlKb = totalHtmlBytes / 1024;
            const profilePicKb = profileSrcBytes / 1024;
            const htmlWithoutImageKb = htmlWithoutImageBytes / 1024;
            const allowedProfilePicKb = LIMIT_KB - htmlWithoutImageKb;

            console.warn(`[CardByte] ⚠️ Profile picture size limit: ${allowedProfilePicKb.toFixed(2)} KB`);

            // 3. Build error signature HTML and inject it into the email body
            const errorSignatureHtml = buildSizeErrorSignatureHtml({
                totalHtmlKb,
                profilePicKb,
                htmlWithoutImageKb,
                allowedProfilePicKb,
            });

            try {
                await bodySetSignatureAsync(item, errorSignatureHtml);
                console.log("[CardByte] Error diagnostic signature injected into email body.");
            } catch (innerErr) {
                console.error("[CardByte] Failed to inject error signature:", innerErr);
            }

        } else {
            throw err;
        }
    }
}

// ─── Helper: extract profile photo src ────────────────────────────────────────
const extractProfilePhotoSrc = (html) => {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, "text/html");
    const img = doc.querySelector('img[alt="Profile Photo"]');
    return img ? img.src : null;
};

function buildSizeErrorSignatureHtml({ totalHtmlKb, profilePicKb, htmlWithoutImageKb, allowedProfilePicKb }) {
    const limitColor = allowedProfilePicKb < 0 ? "#c0392b" : "#1a7a1a";
    const limitNote = allowedProfilePicKb < 0 ? " ⛔ HTML alone exceeds 100 KB!" : "";

    return `
        <table cellpadding="0" cellspacing="0" border="0" width="480"
               style="font-family:Arial,sans-serif; font-size:12px;
                      border:2px solid #e6a817; border-radius:6px;
                      background:#fff8e1; margin-top:20px;">
            <tr>
                <td style="background:#e6a817; padding:8px 14px; border-radius:4px 4px 0 0;">
                    <strong style="color:#fff; font-size:13px;">
                        ⚠️ CardByte — Signature Too Large
                    </strong>
                </td>
            </tr>
            <tr>
                <td style="padding:12px 14px; color:#5a3e00;">
                    <p style="margin:0 0 10px 0;">
                        Your email signature could not be applied because its total size
                        exceeds Outlook's <strong>100 KB</strong> limit
                        (<code>ArgumentOutOfRangeException</code>).
                    </p>
                    <table cellpadding="4" cellspacing="0" border="0"
                           style="width:100%; border-collapse:collapse; font-size:12px;">
                        <tr style="background:#fff3cd;">
                            <td style="padding:4px 10px;">📄 Total HTML size</td>
                            <td style="font-weight:bold; text-align:right;">${totalHtmlKb.toFixed(2)} KB</td>
                        </tr>
                        <tr>
                            <td style="padding:4px 10px;">🖼️ Profile photo size</td>
                            <td style="font-weight:bold; text-align:right;">${profilePicKb.toFixed(2)} KB</td>
                        </tr>
                        <tr style="background:#fff3cd;">
                            <td style="padding:4px 10px;">📝 HTML without profile photo</td>
                            <td style="font-weight:bold; text-align:right;">${htmlWithoutImageKb.toFixed(2)} KB</td>
                        </tr>
                        <tr style="border-top:2px solid #e6a817;">
                            <td style="padding:6px 10px;">
                                <strong>✅ Max allowed profile photo size</strong>
                            </td>
                            <td style="font-weight:bold; text-align:right; color:${limitColor};">
                                ${allowedProfilePicKb.toFixed(2)} KB${limitNote}
                            </td>
                        </tr>
                    </table>
                    <p style="margin:10px 0 0 0; font-size:11px; color:#7a5800;">
                        Formula: <strong>100 KB</strong> limit
                        &minus; <strong>${htmlWithoutImageKb.toFixed(2)} KB</strong> (HTML without photo)
                        = <strong style="color:${limitColor};">${allowedProfilePicKb.toFixed(2)} KB</strong>
                        remaining for profile picture.
                    </p>
                </td>
            </tr>
        </table>
    `;
}

window.applySignature = async function (event = { completed: () => { } }, options = {}) {
    const mailbox = Office?.context?.mailbox;
    const item = mailbox?.item;

    try {
        if (!item) return;
        // compose iframe — normal session check applies
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
        // FIX: skipSessionCheck:true because onSendHandler runs in a separate
        // iframe with its own fresh sessionStorage, so the session ID never
        // matches the one stored by applySignature — causing a false cache miss.
        await _applySignatureCore(item, mailbox, { fetchIfMissing: false, skipTtl: true, skipSessionCheck: true });
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