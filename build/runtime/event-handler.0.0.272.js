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

// ─── OWA Signature DOM Lock ───────────────────────────────────────────────────
// Holds a reference to the active MutationObserver so we can disconnect it
// before re-injecting (avoids observer → re-inject → observer loops).
let _owaMutationObserver = null;

/**
 * After Office.js injects the signature HTML into OWA's compose body, the
 * editor re-serializes the DOM and strips contenteditable="false" from child
 * nodes.  This function re-applies the lock directly on the live DOM element
 * and then watches for any tampering via a MutationObserver.
 *
 * Call this ONLY on OWA (isOWA() === true) and AFTER bodySetSignatureAsync
 * has resolved.
 *
 * @param {number} [retries=5]   How many times to retry finding the iframe/element.
 * @param {number} [delayMs=400] ms to wait between retries.
 */
async function lockSignatureInOWADom(retries = 5, delayMs = 400) {
    // Disconnect any previous observer to avoid duplicate watchers
    if (_owaMutationObserver) {
        _owaMutationObserver.disconnect();
        _owaMutationObserver = null;
    }

    let doc = null;

    // OWA renders the compose body inside an <iframe>.  The iframe may not be
    // present immediately after setSignatureAsync resolves, so we retry.
    for (let attempt = 0; attempt < retries; attempt++) {
        doc = _findOWABodyDocument();
        if (doc) break;
        console.log(`[CardByte] OWA body iframe not found yet, retrying (${attempt + 1}/${retries})…`);
        await new Promise(r => setTimeout(r, delayMs));
    }

    if (!doc) {
        console.warn("[CardByte] Could not locate OWA compose body document — DOM lock skipped.");
        return;
    }

    // Find and lock the signature element
    _applyDomLock(doc);

    // Watch for OWA resetting the attribute or the user deleting the element
    _owaMutationObserver = new MutationObserver(() => {
        const sigEl = doc.querySelector('[data-cbsig="true"]');

        if (!sigEl) {
            // Signature node was removed — re-inject
            console.warn("[CardByte] Signature element removed from DOM — re-injecting…");
            _owaMutationObserver.disconnect();
            _owaMutationObserver = null;
            _reInjectSignatureOWA();
            return;
        }

        // OWA may reset contenteditable — silently re-apply without firing the observer
        const ce = sigEl.getAttribute("contenteditable");
        const pe = sigEl.style.pointerEvents;

        if (ce !== "false" || pe !== "none") {
            // Temporarily disconnect to prevent re-entrancy
            _owaMutationObserver.disconnect();
            _applyDomLock(doc);
            // Re-connect after applying
            _owaMutationObserver.observe(doc.body, _mutationObserverConfig());
        }
    });

    _owaMutationObserver.observe(doc.body, _mutationObserverConfig());
    console.log("[CardByte] OWA signature locked and MutationObserver active.");
}

/** Returns the MutationObserver config object (keeps it DRY). */
function _mutationObserverConfig() {
    return {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["contenteditable", "style"],
        characterData: false, // not needed; avoids noisy text-node callbacks
    };
}

/**
 * Walks every iframe in the top-level document looking for one whose
 * contentDocument contains our [data-cbsig] sentinel.
 * Returns the contentDocument or null.
 */
function _findOWABodyDocument() {
    // OWA sometimes uses a named / titled iframe
    const candidates = Array.from(document.querySelectorAll("iframe"));

    for (const iframe of candidates) {
        try {
            const d = iframe.contentDocument || iframe.contentWindow?.document;
            if (d && d.querySelector('[data-cbsig="true"]')) return d;
        } catch (_) {
            // Cross-origin iframe — skip
        }
    }

    // Also check the top-level document in case OWA renders inline (rare)
    if (document.querySelector('[data-cbsig="true"]')) return document;

    return null;
}

/**
 * Applies the three-pronged lock to the [data-cbsig] element:
 *   1. contenteditable="false"  — tells the browser the node is read-only
 *   2. pointer-events: none     — cursor can't enter the element at all
 *   3. user-select: none        — text can't be selected / highlighted
 */
function _applyDomLock(doc) {
    const sigEl = doc.querySelector('[data-cbsig="true"]');
    if (!sigEl) {
        console.warn("[CardByte] _applyDomLock: [data-cbsig] element not found.");
        return;
    }

    sigEl.setAttribute("contenteditable", "false");
    sigEl.style.pointerEvents = "none";
    sigEl.style.userSelect = "none";
    sigEl.style.webkitUserSelect = "none"; // Safari / older Chrome
    console.log("[CardByte] DOM lock applied to signature element.");
}

/**
 * Called when the MutationObserver detects the signature was deleted.
 * Re-runs the full signature injection pipeline for OWA.
 */
async function _reInjectSignatureOWA() {
    const mailbox = Office?.context?.mailbox;
    const item = mailbox?.item;
    if (!item) return;

    try {
        // Step 1: Read current body
        const currentBody = await new Promise((resolve, reject) => {
            item.body.getAsync(Office.CoercionType.Html, (r) => {
                if (r.status === Office.AsyncResultStatus.Succeeded) resolve(r.value);
                else reject(r.error);
            });
        });

        // Step 2: Surgical replace — only touch the signature zone
        const newBody = replaceSignatureInBody(currentBody);

        // Step 3: setAsync with the stitched body (reply chain intact)
        await new Promise((resolve, reject) => {
            item.body.setAsync(newBody, { coercionType: Office.CoercionType.Html }, (r) => {
                if (r.status === Office.AsyncResultStatus.Succeeded) resolve();
                else reject(r.error);
            });
        });

        console.log("[CardByte] Signature surgically replaced — reply chain preserved.");

        // Step 4: Re-lock
        await lockSignatureInOWADom();

    } catch (err) {
        console.error("[CardByte] _reInjectSignatureOWA failed:", err);
    }
}

/**
 * Surgically replaces only the CardByte signature zone in the body HTML.
 *
 * Strategy:
 *   - Parse the body with DOMParser
 *   - Find [data-cbsig="true"] — this is our sentinel anchor
 *   - Remove it and the signature content that follows it
 *     (stopping before any reply-chain dividers like <hr>, blockquote, or
 *      OWA's own "x-sigseparator" / "gmail_quote" / "yahoo_quoted" markers)
 *   - Insert the fresh signature exactly where the old one was
 *   - Leave everything before (user's typed content) and after
 *     (quoted reply chain) completely untouched
 */
function replaceSignatureInBody(bodyHtml) {
    if (!bodyHtml) return "";

    const cachedSig = getCachedSignature({ skipTtl: true, skipSessionCheck: true });
    if (!cachedSig) {
        console.warn("[CardByte] replaceSignatureInBody: no cached signature.");
        return bodyHtml; // return unchanged — don't corrupt the body
    }

    const parser = new DOMParser();
    const doc = parser.parseFromString(bodyHtml, "text/html");
    const body = doc.body;

    // ── Locate the sentinel ──────────────────────────────────────────────────
    const sentinel = body.querySelector('[data-cbsig="true"]');

    if (sentinel) {
        // Remove nodes AFTER the sentinel until we hit a reply-chain marker
        // (blockquote, hr, OWA/Gmail/Yahoo quoted-reply wrappers).
        // These are nodes injected by CardByte between the sentinel and the
        // reply chain — i.e. the actual signature table + trailing spacer.
        let node = sentinel.nextSibling;
        while (node) {
            const next = node.nextSibling;
            if (_isReplyChainBoundary(node)) break; // stop — don't touch reply chain
            node.parentNode.removeChild(node);
            node = next;
        }

        // Replace the sentinel itself with the fresh signature block
        const wrapperStyle = "margin-top:40px; pointer-events:none; user-select:none; -webkit-user-select:none;";
        const freshHtml = `<div contenteditable="false" data-cbsig="true" style="${wrapperStyle}"></div>${cachedSig}<div style="margin-top:40px"></div>`;
        const fragment = document.createRange().createContextualFragment(freshHtml);
        sentinel.parentNode.replaceChild(fragment, sentinel);

    } else {
        // Sentinel was deleted entirely by the user — append signature just
        // before the reply chain so it lands in the right position.
        const replyChainStart = _findReplyChainStart(body);

        const wrapperStyle = "margin-top:40px; pointer-events:none; user-select:none; -webkit-user-select:none;";
        const freshHtml = `<div contenteditable="false" data-cbsig="true" style="${wrapperStyle}"></div>${cachedSig}<div style="margin-top:40px"></div>`;
        const fragment = document.createRange().createContextualFragment(freshHtml);

        if (replyChainStart) {
            // Insert just before the reply chain
            body.insertBefore(fragment, replyChainStart);
        } else {
            // New compose — just append at the end
            body.appendChild(fragment);
        }
    }

    return body.innerHTML;
}

/**
 * Returns true if a DOM node is the start of a quoted reply chain.
 * Covers OWA, Gmail, Yahoo, and generic Outlook reply markers.
 */
function _isReplyChainBoundary(node) {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) return false;

    const tag = node.tagName?.toUpperCase();

    // <hr> is Outlook's classic reply divider
    if (tag === "HR") return true;

    // <blockquote> is used by Gmail/OWA for quoted content
    if (tag === "BLOCKQUOTE") return true;

    const id = (node.id || "").toLowerCase();
    const cls = (node.className || "").toLowerCase();
    const dataAttr = node.getAttribute?.("data-marker") || "";

    // OWA wraps quoted content in a div with these identifiers
    if (id.includes("divreplycontainer")) return true;
    if (id.includes("appendonsend")) return true;     // OWA reply zone
    if (cls.includes("gmail_quote")) return true;
    if (cls.includes("yahoo_quoted")) return true;
    if (dataAttr.includes("__pblfooter")) return true; // some clients

    // Outlook desktop uses a specific style marker
    const style = node.getAttribute?.("style") || "";
    if (style.includes("border-top") && tag === "DIV") return true;

    return false;
}

/**
 * Walks the body's direct children to find the first reply-chain node.
 * Returns the node, or null if this is a fresh compose.
 */
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

function bodySetSignatureAsync(item, html) {
    return new Promise((resolve, reject) => {
        const sizeInBytes = new Blob([html]).size;

        if (sizeInBytes <= 100 * 1024 &&
            typeof item.body.setSignatureAsync === "function") {

            item.body.setSignatureAsync(
                html,
                { coercionType: Office.CoercionType.Html },
                (r) => {
                    if (r.status === Office.AsyncResultStatus.Succeeded) {
                        resolve();
                    } else {
                        reject(r.error);
                    }
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
                    if (r.status === Office.AsyncResultStatus.Succeeded) {
                        resolve();
                    } else {
                        reject(r.error);
                    }
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

    // ── OWA: pointer-events:none is pre-baked into the wrapper so that even
    //    before the MutationObserver activates, the element is interaction-proof.
    //    For non-OWA platforms the wrapper stays neutral (no pointer-events rule)
    //    since Classic Outlook / Mac ignore CSS on the compose body anyway.
    const wrapperStyle = isOWA()
        ? "margin-top:40px; pointer-events:none; user-select:none; -webkit-user-select:none;"
        : "margin-top:40px";

    let finalSignature = `<div contenteditable="false" data-cbsig="true" style="${wrapperStyle}"></div>${fetched}<div style='margin-top:40px'></div>`;

    console.log("[CardByte] ════════════════════════════════════",
        fetched ? "Applying signature" : "No cached signature, will fetch from server",
        finalSignature, item?.body
    );

    await bodySetSignatureAsync(item, finalSignature);

    // ── OWA post-injection DOM lock ──────────────────────────────────────────
    // Must run AFTER bodySetSignatureAsync resolves so the element exists in the
    // live DOM.  No-op on Classic Outlook / Mac (DOM is not accessible there).
    if (isOWA()) {
        // Fire-and-forget: don't await so we don't block event.completed()
        lockSignatureInOWADom().catch(err =>
            console.warn("[CardByte] lockSignatureInOWADom failed:", err)
        );
    }
    // ─────────────────────────────────────────────────────────────────────────
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
        // FIX: skipSessionCheck:true because onSendHandler runs in a separate
        // iframe with its own fresh sessionStorage, so the session ID never
        // matches the one stored by applySignature — causing a false cache miss.
        // await _applySignatureCore(item, mailbox, { fetchIfMissing: false, skipTtl: true, skipSessionCheck: true });
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