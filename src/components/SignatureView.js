import { useEffect, useRef, useState, useCallback } from "react";
import {
    Box,
    Button,
    CircularProgress,
    Paper,
    Stack,
    Typography,
    Chip,
    Fade,
    Divider,
    Tooltip,
} from "@mui/material";
import {
    CheckCircle,
    AlertCircle,
    Globe,
    Users,
    UserPlus,
    Building,
    Mail,
    MailOpen,
    Sparkles,
    Shield,
    Star,
    ChevronDown,
    ChevronUp,
    RefreshCw,
    Zap,
    FileText,
    Info,
    Lock,
} from "lucide-react";
import { toast } from "react-toastify";
import DefaultTemplate from "./SignatureComponents/Assets/Images/DefaultTemplate.svg";
import usernotfound from "../components/SignatureComponents/Assets/Images/usernotfound.gif";
import signnotassigned from "../components/SignatureComponents/Assets/Images/signnotassigned.webp";
import SignaturePreview from "./Signaturepreview";

// ─────────────────────────────────────────────────────────────────────────────
// Brand logo
// Replace this with your CardByte logo. You can either:
//   1) import an asset:  import cardbyteLogo from "./assets/cardbyte-logo.png";
//      and set  const CARDBYTE_LOGO = cardbyteLogo;
//   2) or paste a base64 data URI here:  const CARDBYTE_LOGO = "data:image/png;base64,...";
// Leave it empty ("") to fall back to the clean text wordmark shown in the header.
// ─────────────────────────────────────────────────────────────────────────────
const CARDBYTE_LOGO = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAANwAAAA0CAYAAADhTVZuAAAACXBIWXMAAAsTAAALEwEAmpwYAAAGWGlUWHRYTUw6Y29tLmFkb2JlLnhtcAAAAAAAPD94cGFja2V0IGJlZ2luPSLvu78iIGlkPSJXNU0wTXBDZWhpSHpyZVN6TlRjemtjOWQiPz4gPHg6eG1wbWV0YSB4bWxuczp4PSJhZG9iZTpuczptZXRhLyIgeDp4bXB0az0iQWRvYmUgWE1QIENvcmUgNi4wLWMwMDIgNzkuMTY0NDg4LCAyMDIwLzA3LzEwLTIyOjA2OjUzICAgICAgICAiPiA8cmRmOlJERiB4bWxuczpyZGY9Imh0dHA6Ly93d3cudzMub3JnLzE5OTkvMDIvMjItcmRmLXN5bnRheC1ucyMiPiA8cmRmOkRlc2NyaXB0aW9uIHJkZjphYm91dD0iIiB4bWxuczp4bXA9Imh0dHA6Ly9ucy5hZG9iZS5jb20veGFwLzEuMC8iIHhtbG5zOnhtcE1NPSJodHRwOi8vbnMuYWRvYmUuY29tL3hhcC8xLjAvbW0vIiB4bWxuczpzdEV2dD0iaHR0cDovL25zLmFkb2JlLmNvbS94YXAvMS4wL3NUeXBlL1Jlc291cmNlRXZlbnQjIiB4bWxuczpwaG90b3Nob3A9Imh0dHA6Ly9ucy5hZG9iZS5jb20vcGhvdG9zaG9wLzEuMC8iIHhtbG5zOmRjPSJodHRwOi8vcHVybC5vcmcvZGMvZWxlbWVudHMvMS4xLyIgeG1wOkNyZWF0b3JUb29sPSJBZG9iZSBQaG90b3Nob3AgMjIuMCAoV2luZG93cykiIHhtcDpDcmVhdGVEYXRlPSIyMDIyLTAyLTI4VDE1OjEwOjUyKzA1OjMwIiB4bXA6TWV0YWRhdGFEYXRlPSIyMDIyLTAyLTI4VDE1OjEwOjUyKzA1OjMwIiB4bXA6TW9kaWZ5RGF0ZT0iMjAyMi0wMi0yOFQxNToxMDo1MiswNTozMCIgeG1wTU06SW5zdGFuY2VJRD0ieG1wLmlpZDo2M2NkMTQ1My1jNTA0LTQ5NDEtYWE2My1kNWYzOTRmZWUwODQiIHhtcE1NOkRvY3VtZW50SUQ9ImFkb2JlOmRvY2lkOnBob3Rvc2hvcDo0YTQ2NDE0NS1lYjJkLWZlNGQtOTg0MS02NGUwOGU0M2FiYTkiIHhtcE1NOk9yaWdpbmFsRG9jdW1lbnRJRD0ieG1wLmRpZDpmNTEyYmI2Ni05YjJjLThkNDQtYjQyZS1kNDdlMjA5ZDNlMzYiIHBob3Rvc2hvcDpDb2xvck1vZGU9IjMiIGRjOmZvcm1hdD0iaW1hZ2UvcG5nIj4gPHhtcE1NOkhpc3Rvcnk+IDxyZGY6U2VxPiA8cmRmOmxpIHN0RXZ0OmFjdGlvbj0iY3JlYXRlZCIgc3RFdnQ6aW5zdGFuY2VJRD0ieG1wLmlpZDo2M2NkMTQ1My1jNTA0LTQ5NDEtYWE2My1kNWYzOTRmZWUwODQiIHN0RXZ0OndoZW49IjIwMjItMDItMjhUMTU6MTA6NTIrMDU6MzAiIHN0RXZ0OnNvZnR3YXJlQWdlbnQ9IkFkb2JlIFBob3Rvc2hvcCAyMi4wIChXaW5kb3dzKSIvPiA8cmRmOmxpIHN0RXZ0OmFjdGlvbj0ic2F2ZWQiIHN0RXZ0Omluc3RhbmNlSUQ9InhtcC5paWQ6NjNjZDE0NTMtYzUwNC00OTQxLWFhNjMtZDVmMzk0ZmVlMDg0IiBzdEV2dDp3aGVuPSIyMDIyLTAyLTI4VDE1OjEwOjUyKzA1OjMwIiBzdEV2dDpzb2Z0d2FyZUFnZW50PSJBZG9iZSBQaG90b3Nob3AgMjIuMCAoV2luZG93cykiIHN0RXZ0OmNoYW5nZWQ9Ii8iLz4gPC9yZGY6U2VxPiA8L3htcE1NOkhpc3Rvcnk+IDxwaG90b3Nob3A6RG9jdW1lbnRBbmNlc3RvcnM+IDxyZGY6QmFnPiA8cmRmOmxpPnhtcC5kaWQ6MmJiNmVlZmUtYjkyNS1jZDRmLWIyYzctODc1M2I0ZDBjMTljPC9yZGY6bGk+IDwvcmRmOkJhZz4gPC9waG90b3Nob3A6RG9jdW1lbnRBbmNlc3RvcnM+IDwvcmRmOkRlc2NyaXB0aW9uPiA8L3JkZjpSREY+IDwveDp4bXBtZXRhPiA8P3hwYWNrZXQgZW5kPSJyIj8+TzjcNwAAE8hJREFUeNrtnQd8TVccx9OFlqLVodXSoXtXl+6B2qOlQ4cdJIQkhCRCpogROyFWErWJGKktS7ZMsWsVkYlGkCB+vb8jN17irby8IHn3//kcT+676713vuc/z7lmAE5LLV9pSjOxxn5vdrsb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"; // ← placeholder (was a large inline base64 string)

// ─────────────────────────────────────────────────────────────────────────────
// Color Schema (from EmailSignatureRules component)
// ─────────────────────────────────────────────────────────────────────────────
const COLORS = {
    primary: "#1e293b",
    primaryLight: "#312e81",
    accent: "#5b21b6",
    success: "#10b981",
    successBg: "#dcfce7",
    successBorder: "#bbf7d0",
    error: "#dc2626",
    errorBg: "#fee2e2",
    warning: "#f59e0b",
    warningBg: "#fef3c7",
    info: "#3b82f6",
    infoBg: "#eff6ff",
    infoBorder: "#bfdbfe",
    purple: "#8b5cf6",
    purpleBg: "#f5f3ff",
    purpleBorder: "#ddd6fe",
    gray: "#94a3b8",
    grayBg: "#f1f5f9",
    grayBorder: "#e2e8f0",
    border: "#e2e8f0",
    surface: "#ffffff",
    background: "#f8fafc",
};

// ─────────────────────────────────────────────────────────────────────────────
// API Constants (mirroring event-handler.js)
// ─────────────────────────────────────────────────────────────────────────────
const AES_KEY = "fnItrY2YfozBqCC2B4XsfqHIvZku3kUOq3DFkbO64kk=";
const AES_IV = "3YapeNfJDung7TXxeKXn4g==";
const BASE_URL = "https://newqa-enterprise.cardbyte.ai/email-signature";

const CACHE_KEY = "cardbyte_cached_signature";
const CACHE_SESSION_KEY = "cardbyte_cached_signature_session";
const CACHE_TIMESTAMP_KEY = "cardbyte_cached_signature_ts";
const CACHE_TTL_MS = 5 * 60 * 1000;

const RULES_CACHE_KEY = "cardbyte_cached_rules";
const RULES_CACHE_TIMESTAMP_KEY = "cardbyte_cached_rules_ts";
const RULES_CACHE_TTL_MS = 5 * 60 * 1000;

const SIG_BY_ID_CACHE_KEY = "cardbyte_sig_by_id";
const SIG_BY_ID_TTL_MS = 5 * 60 * 1000;

const SESSION_KEY = "cardbyte_session_id";

// ─────────────────────────────────────────────────────────────────────────────
// Props
//   Office      — Office global object
//   user        — mailbox user profile
//   apply       — async (signatureHtml: string) => void
//   autoApply   — true when opened automatically via ItemEdit form
//   isMobile    — true on iOS / Android Outlook
//   platform    — 'mobile-ios' | 'mobile-android' | 'owa' | 'desktop'
// ─────────────────────────────────────────────────────────────────────────────
export default function SignatureView({
    Office,
    user,
    apply,
    autoApply = false,
    isMobile = false,
    platform = "desktop",
}) {
    const [signatures, setSignatures] = useState([]); // Filtered signatures for this user
    const [allRulesCount, setAllRulesCount] = useState(0); // Total rules (for display)
    const [hiddenCount, setHiddenCount] = useState(0); // Rules hidden due to sender mismatch
    const [error, setError] = useState("");
    const [load, setLoad] = useState(false);
    const [expandedCards, setExpandedCards] = useState({});
    const [applyingId, setApplyingId] = useState(null);

    // ─── Mac detection ───────────────────────────────────────────────────────
    const isMac =
        typeof Office !== "undefined" &&
        Office?.context?.diagnostics?.platform === Office?.PlatformType?.Mac;

    // ─── Platform helpers ────────────────────────────────────────────────────
    const getXPlatform = useCallback(() => {
        const p = (Office?.context?.platform || "").toLowerCase();
        if (p === "mac") return "MAC";
        if (p === "mobile-ios" || p === "mobile-android") return "MOBILE";
        return "WINDOWS";
    }, [Office]);

    /* ── CRYPTO — AES-CBC via Web Crypto API (same as event-handler.js) ── */
    function base64ToArrayBuffer(base64) {
        let b = base64.replace(/-/g, "+").replace(/_/g, "/");
        const pad = b.length % 4;
        if (pad) b += "=".repeat(4 - pad);
        const bin = atob(b);
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
            try { keyBuffer = base64ToArrayBuffer(keyToUse); }
            catch (e) { console.error("Failed to decode key:", e); return encryptedText; }

            if (keyBuffer.byteLength !== 16 && keyBuffer.byteLength !== 32) {
                if (generatedKey && generatedKey !== AES_KEY) return handleAesDecrypt(encryptedText, AES_KEY);
                return encryptedText;
            }

            const ivBuffer = base64ToArrayBuffer(AES_IV);
            if (ivBuffer.byteLength !== 16) return encryptedText;

            const key = await crypto.subtle.importKey("raw", keyBuffer, { name: "AES-CBC" }, false, ["decrypt"]);

            let encryptedBuffer;
            try { encryptedBuffer = base64ToArrayBuffer(encryptedText); }
            catch { return encryptedText; }

            const decryptedBuffer = await crypto.subtle.decrypt({ name: "AES-CBC", iv: ivBuffer }, key, encryptedBuffer);
            return new TextDecoder().decode(decryptedBuffer);
        } catch (err) {
            return encryptedText;
        }
    }

    async function encryptEmail(email = "") {
        try {
            if (!email || email.trim() === "") return "";
            const keyBuffer = base64ToArrayBuffer(AES_KEY);
            const ivBuffer = base64ToArrayBuffer(AES_IV);
            const key = await crypto.subtle.importKey("raw", keyBuffer, { name: "AES-CBC" }, false, ["encrypt"]);
            const data = new TextEncoder().encode(email);
            const encrypted = await crypto.subtle.encrypt({ name: "AES-CBC", iv: ivBuffer }, key, data);
            return arrayBufferToBase64(encrypted);
        } catch (err) {
            return "";
        }
    }

    /* ── STORAGE HELPERS (same as event-handler.js) ─────────────────────────── */
    const store = {
        get: (key) => { try { return localStorage.getItem(key); } catch (_) { return null; } },
        set: (key, val) => { try { localStorage.setItem(key, val); } catch (_) { } },
        remove: (...keys) => { try { keys.forEach(k => localStorage.removeItem(k)); } catch (_) { } },
        getJson: (key) => { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : null; } catch (_) { return null; } },
        setJson: (key, val) => { try { localStorage.setItem(key, JSON.stringify(val)); } catch (_) { } },
    };

    function getOrCreateSessionId() {
        try {
            let sid = sessionStorage.getItem(SESSION_KEY);
            if (!sid) {
                sid = crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36);
                sessionStorage.setItem(SESSION_KEY, sid);
            }
            return sid;
        } catch (_) {
            return "mobile-session";
        }
    }

    /* ── DEFAULT SIGNATURE CACHE ──────────────────────────────────────────── */
    function getCachedSignature({ skipTtl = false, skipSessionCheck = false } = {}) {
        if (skipSessionCheck) return store.get(CACHE_KEY);

        const currentSid = getOrCreateSessionId();
        if (store.get(CACHE_SESSION_KEY) !== currentSid) {
            store.remove(CACHE_KEY, CACHE_SESSION_KEY, CACHE_TIMESTAMP_KEY);
            return null;
        }

        if (!skipTtl) {
            const ts = parseInt(store.get(CACHE_TIMESTAMP_KEY) || "0", 10);
            if (Date.now() - ts > CACHE_TTL_MS) {
                store.remove(CACHE_KEY, CACHE_SESSION_KEY, CACHE_TIMESTAMP_KEY);
                return null;
            }
        }
        return store.get(CACHE_KEY);
    }

    function setCachedSignature(html) {
        const sid = getOrCreateSessionId();
        try {
            store.set(CACHE_KEY, html);
            store.set(CACHE_SESSION_KEY, sid);
            store.set(CACHE_TIMESTAMP_KEY, Date.now().toString());
        } catch (_) { }
    }

    /* ── RULES CACHE ───────────────────────────────────────────────────────── */
    function getCachedRules({ skipTtl = false, skipSessionCheck = false } = {}) {
        if (skipSessionCheck) return store.getJson(RULES_CACHE_KEY);

        const currentSid = getOrCreateSessionId();
        if (store.get(CACHE_SESSION_KEY) !== currentSid) {
            store.remove(RULES_CACHE_KEY, RULES_CACHE_TIMESTAMP_KEY);
            return null;
        }

        if (!skipTtl) {
            const ts = parseInt(store.get(RULES_CACHE_TIMESTAMP_KEY) || "0", 10);
            if (Date.now() - ts > RULES_CACHE_TTL_MS) {
                store.remove(RULES_CACHE_KEY, RULES_CACHE_TIMESTAMP_KEY);
                return null;
            }
        }
        return store.getJson(RULES_CACHE_KEY);
    }

    function setCachedRules(rulesJson) {
        const sid = getOrCreateSessionId();
        try {
            store.setJson(RULES_CACHE_KEY, rulesJson);
            store.set(RULES_CACHE_TIMESTAMP_KEY, Date.now().toString());
            store.set(CACHE_SESSION_KEY, sid);
        } catch (_) { }
    }

    /* ── PER-SIGNATURE-ID HTML CACHE ───────────────────────────────────────── */
    function _readSigByIdMap() { return store.getJson(SIG_BY_ID_CACHE_KEY) || {}; }
    function _writeSigByIdMap(map) { store.setJson(SIG_BY_ID_CACHE_KEY, map); }

    function getSigById(signatureId, { skipTtl = false } = {}) {
        const id = String(signatureId);
        const map = _readSigByIdMap();
        const entry = map[id];
        if (!entry) return null;
        if (!skipTtl && Date.now() - entry.ts > SIG_BY_ID_TTL_MS) {
            console.log(`[CardByte] sigById TTL expired for id=${id}`);
            return null;
        }
        return entry.html;
    }

    function setSigById(signatureId, html) {
        const id = String(signatureId);
        const map = _readSigByIdMap();
        map[id] = { html, ts: Date.now() };
        _writeSigByIdMap(map);
        console.log(`[CardByte] sigById cached: id=${id}`);
    }

    /* ── API LAYER (same as event-handler.js) ─────────────────────────────── */
    async function fetchAndCacheRules(encryptedMail, xPlatform) {
        try {
            const res = await fetch(`${BASE_URL}/rules-config/get-active`, {
                method: "GET",
                headers: {
                    "Content-Type": "application/json",
                    username: encryptedMail,
                    "X-Platform": xPlatform,
                },
            });
            if (!res.ok) {
                console.warn("[CardByte] Rules fetch returned", res.status);
                return null;
            }

            const parsed = JSON.parse(await res.text());
            const rulesJson = parsed?.rulesJson;
            if (!rulesJson) {
                console.warn("[CardByte] Rules response had no rulesJson");
                return null;
            }

            setCachedRules(rulesJson);
            console.log("[CardByte] rulesJson fetched and cached");
            return rulesJson;
        } catch (err) {
            console.error("[CardByte] fetchAndCacheRules failed:", err);
            return null;
        }
    }

    async function renderSignatureOnServer(userEmail) {
        try {
            const encryptedMail = await encryptEmail(userEmail);
            const xPlatform = getXPlatform();

            const primaryRes = await fetch(`${BASE_URL}/html/outlook/get-active`, {
                method: "GET",
                headers: {
                    username: encryptedMail,
                    "X-Platform": xPlatform,
                },
            });

            if (primaryRes.ok) {
                const data = await primaryRes.text();
                const decryptedData = await handleAesDecrypt(data);
                const html = JSON.parse(decryptedData)?.html + `<table><tr><td>${xPlatform}</td></tr></table>`;

                if (html === "" || html == null) {
                    return { html: null, explicit: true, reason: "unassigned" };
                }
                return { html, explicit: true };
            }

            // ─── Non-OK: inspect the error body ───
            let serverMessage = "";
            try {
                const errText = await primaryRes.text();
                const errJson = JSON.parse(errText);
                serverMessage = (errJson?.message || errJson?.error || "").toString();
            } catch { /* body not JSON — leave blank */ }

            console.warn("[CardByte] Primary fetch failed:", primaryRes.status, serverMessage);

            // "Primary card not found" (and similar) = definitive: no signature exists for this user
            const notFound =
                primaryRes.status === 404 ||
                /not\s*found/i.test(serverMessage) ||
                /ResourceNotFound/i.test(serverMessage);

            if (notFound) {
                return { html: null, explicit: true, reason: "notFound" };
            }

            // Any other server error (5xx, etc.) — transient/unknown
            return { html: null, explicit: false, reason: "serverError" };
        } catch (err) {
            console.warn("[CardByte] renderSignatureOnServer crashed:", err);
            return { html: null, explicit: false, reason: "network" };
        }
    }

    async function fetchSignatureById(signatureId, encryptedMail, xPlatform) {
        try {
            const res = await fetch(`${BASE_URL}/rules-config/get/${signatureId}`, {
                method: "GET",
                headers: {
                    username: encryptedMail,
                    "X-Platform": xPlatform,
                },
            });
            if (!res.ok) {
                console.error("[CardByte] Signature fetch failed:", res.status);
                return null;
            }
            const rawText = await res.text();
            const decrypted = await handleAesDecrypt(rawText);
            return JSON.parse(decrypted)?.html || null;
        } catch (err) {
            console.error("[CardByte] fetchSignatureById crashed:", err);
            return null;
        }
    }

    async function getOrFetchSignatureById(signatureId, encryptedMail, xPlatform, { skipTtl = false } = {}) {
        const id = String(signatureId);
        const cached = getSigById(id, { skipTtl });
        if (cached) {
            console.log(`[CardByte] ✅ sigById cache hit: id=${id}`);
            return cached;
        }
        console.log(`[CardByte] 🌐 sigById cache miss — fetching id=${id}`);
        const html = await fetchSignatureById(id, encryptedMail, xPlatform);
        if (html) setSigById(id, html);
        return html;
    }

    /* ════════════════════════════════════════════════════════════════════════
       SENDER MATCHING LOGIC (mirrors event-handler.js senderMatches exactly)
       ════════════════════════════════════════════════════════════════════════ */

    /**
     * Checks if the current user is allowed to see this rule's signature.
     *
     * VISIBLE if:
     *   • Senders is empty / undefined / ["*"]  → all users
     *   • Senders array includes user.emailAddress (case-insensitive)
     *
     * HIDDEN if:
     *   • Senders is a specific list and does NOT include user.emailAddress
     */
    function senderMatches(rule, currentSenderEmail) {
        // No senders specified = all users (wildcard)
        if (!rule.Senders || rule.Senders.length === 0) return true;

        // Single wildcard = all users
        if (rule.Senders.length === 1 && rule.Senders[0] === "*") return true;

        // Specific sender list — check if current user is in it
        const sender = (currentSenderEmail || "").toLowerCase().trim();
        if (!sender) return false;

        return rule.Senders.some(s => (s || "").toLowerCase().trim() === sender);
    }

    /* ════════════════════════════════════════════════════════════════════════
       MAIN FETCH: List signatures filtered by sender match + default at top
       ════════════════════════════════════════════════════════════════════════ */
    const fetchAllSignatures = useCallback(async () => {
        if (!user?.emailAddress) return;
        setLoad(true);
        setError("");

        try {
            const xPlatform = getXPlatform();
            const encryptedMail = await encryptEmail(user.emailAddress);
            const resultList = [];
            let totalRules = 0;
            let hiddenRules = 0;

            // ─── 1. Fetch rules (or use cache) ──────────────────────────────────
            let rulesJson = getCachedRules();
            if (!rulesJson) {
                rulesJson = await fetchAndCacheRules(encryptedMail, xPlatform);
            }

            // ─── 2. Fetch DEFAULT signature (always at top, always visible) ──────
            let defaultHtml = getCachedSignature();
            let defaultExplicit = false;
            let defaultReason = null;

            if (!defaultHtml) {
                const { html, explicit, reason } = await renderSignatureOnServer(user.emailAddress);
                if (html) {
                    defaultHtml = html;
                    setCachedSignature(html);
                }
                defaultExplicit = explicit;
                defaultReason = reason;
            }

            if (defaultHtml) {
                resultList.push({
                    id: "default",
                    html: defaultHtml,
                    rule: null,
                    isDefault: true,
                    signatureId: "default",
                    name: "Default Signature",
                    description: "Applied when no rules match",
                    priority: 0,
                });
            }

            // ─── 3. Fetch rule signatures — FILTERED by sender match ───────────
            if (rulesJson) {
                // Get ALL enabled rules, sorted by priority
                const allEnabledRules = (rulesJson?.rulesList || [])
                    .filter(r => r.enabled && r.signatureId)
                    .sort((a, b) => a.priority - b.priority);

                totalRules = allEnabledRules.length;

                console.log(`[CardByte] Evaluating ${totalRules} rule(s) for sender: ${user.emailAddress}`);

                for (const rule of allEnabledRules) {
                    // ─── SENDER FILTER ───
                    const isVisible = senderMatches(rule, user.emailAddress);

                    if (!isVisible) {
                        console.log(`[CardByte] 🔒 HIDDEN for ${user.emailAddress}: "${rule.rule || rule.priority}" | senders=[${(rule.Senders || []).join(", ")}]`);
                        hiddenRules++;
                        continue; // Skip this rule — user is not in the sender list
                    }

                    console.log(`[CardByte] ✅ VISIBLE for ${user.emailAddress}: "${rule.rule || rule.priority}" | senders=[${(rule.Senders || []).join(", ")}]`);

                    const ruleHtml = await getOrFetchSignatureById(rule.signatureId, encryptedMail, xPlatform);
                    if (ruleHtml) {
                        resultList.push({
                            id: `rule-${rule.ruleId || rule.priority}`,
                            html: ruleHtml,
                            rule: rule,
                            isDefault: false,
                            signatureId: rule.signatureId,
                            name: rule.rule || rule.description || `Rule ${rule.priority}`,
                            description: rule.description || "",
                            priority: rule.priority,
                        });
                    } else {
                        console.warn(`[CardByte] Could not fetch signature for rule: ${rule.rule || rule.priority}`);
                    }
                }
            }

            setSignatures(resultList);
            setAllRulesCount(totalRules);
            setHiddenCount(hiddenRules);

            // Expand default by default
            if (defaultHtml) {
                setExpandedCards(prev => ({ ...prev, default: true }));
            }

            if (resultList.length === 0) {
                let msg;
                switch (defaultReason) {
                    case "notFound":
                    case "unassigned":
                        msg = "Signature not found. Please contact Admin.";
                        break;
                    case "serverError":
                        msg = "Signature not found. Please contact Admin.";
                        break;
                    case "network":
                        msg = "Couldn't reach the signature service. Check your connection and try again.";
                        break;
                    default:
                        msg = "Signature not found. Please contact Admin.";
                }
                setError(msg);
            }

            console.log(`[CardByte] Loaded ${resultList.length} signature(s) total (${hiddenRules} hidden due to sender filter)`);
        } catch (e) {
            console.error("[CardByte] fetchAllSignatures error:", e);
            setError(e?.message || "Failed to load signatures");
        } finally {
            setLoad(false);
        }
    }, [user, getXPlatform]);

    useEffect(() => {
        fetchAllSignatures();
    }, [fetchAllSignatures]);

    /* ── Manual apply ────────────────────────────────────────── */
    const applyHTML = async (html, sigName, cardId, signatureId) => {
        setApplyingId(cardId);
        try {
            await apply(html, signatureId);          // <-- pass id
            toast.success(`${sigName || "Signature"} applied successfully!`);
        } catch (err) {
            toast.error(err?.message || "Failed to apply signature, please try again.");
            console.error("[CardByte] Manual apply error:", err);
        } finally {
            setApplyingId(null);
        }
    };

    /* ── Toggle card expand ──────────────────────────────────── */
    const toggleExpand = (id) => {
        setExpandedCards(prev => ({ ...prev, [id]: !prev[id] }));
    };

    /* ── Brand logo (placeholder — see CARDBYTE_LOGO at top of file) ── */
    const cardbyte_logo = CARDBYTE_LOGO;

    /* ── Compact rule chips ──────────────────────────────────── */
    const chipSx = (color, bg) => ({
        background: bg || COLORS.grayBg,
        color,
        fontSize: "10px",
        fontWeight: 600,
        height: 20,
        borderRadius: "6px",
        "& .MuiChip-label": { px: 0.75 },
        "& .MuiChip-icon": { color, fontSize: 11, ml: "4px", mr: "-2px" },
    });

    const renderRuleChips = (sig) => {
        if (sig.isDefault) {
            return (
                <Chip
                    size="small"
                    icon={<Star size={11} />}
                    label="Default"
                    sx={{ ...chipSx(COLORS.success, COLORS.successBg), border: `1px solid ${COLORS.successBorder}` }}
                />
            );
        }

        const rule = sig.rule;
        if (!rule) return null;

        const senderTypeConfig = {
            all: { icon: <Globe size={11} />, color: COLORS.success, bg: COLORS.successBg, label: "All users" },
            azure_group: { icon: <Users size={11} />, color: COLORS.info, bg: COLORS.infoBg, label: `Azure: ${rule.groupName || rule.GroupId || "Group"}` },
            specific_users: { icon: <UserPlus size={11} />, color: COLORS.purple, bg: COLORS.purpleBg, label: rule.groupName || "Selected users" },
        };

        const emailTypeConfig = {
            all: { icon: <Globe size={11} />, label: "All emails" },
            compose: { icon: <Mail size={11} />, label: "New emails" },
            reply: { icon: <MailOpen size={11} />, label: "Replies" },
        };

        const recipientConfig = {
            all: { icon: <Globe size={11} />, color: COLORS.success, label: "All recipients" },
            internal: { icon: <Building size={11} />, color: COLORS.info, label: "Internal" },
            external: { icon: <UserPlus size={11} />, color: COLORS.purple, label: "External" },
            specific: { icon: <Shield size={11} />, color: COLORS.accent, label: "Specific" },
        };

        const isAzure = rule.isAzureAdGroup || rule.azureAdGroup || false;
        const hasSpecificSenders = rule.Senders && rule.Senders.length > 0 && rule.Senders[0] !== "*";
        const sender = isAzure
            ? senderTypeConfig.azure_group
            : hasSpecificSenders
                ? senderTypeConfig.specific_users
                : senderTypeConfig.all;

        const emailType = emailTypeConfig[rule.context] || emailTypeConfig.all;
        const recipient = recipientConfig[rule.recipientType] || recipientConfig.all;

        return (
            <Stack direction="row" flexWrap="wrap" gap={0.5}>
                <Chip size="small" icon={sender.icon} label={sender.label} sx={chipSx(sender.color, sender.bg)} />
                <Chip size="small" icon={emailType.icon} label={emailType.label} sx={chipSx(COLORS.gray, COLORS.grayBg)} />
                <Chip size="small" icon={recipient.icon} label={recipient.label} sx={chipSx(recipient.color, recipient.bg)} />
                {sig.signatureId && (
                    <Tooltip title="Signature ID">
                        <Chip
                            size="small"
                            icon={<Sparkles size={11} />}
                            label={sig.signatureId.slice(0, 8)}
                            sx={{ ...chipSx(COLORS.primary, `${COLORS.primary}10`), fontFamily: "monospace" }}
                        />
                    </Tooltip>
                )}
            </Stack>
        );
    };

    /* ── RENDER: loading state ──────────────────────────────── */
    if (load) {
        return (
            <Box
                display="flex"
                flexDirection="column"
                alignItems="center"
                justifyContent="center"
                sx={{ minHeight: isMobile ? "100vh" : "80vh", p: 2, gap: 1.5, background: COLORS.background }}
            >
                <CircularProgress size={isMobile ? 32 : 26} sx={{ color: COLORS.primary }} />
                <Typography fontFamily="Plus Jakarta Sans" fontSize={isMobile ? "13px" : "12px"} color={COLORS.gray}>
                    Loading your signatures…
                </Typography>
            </Box>
        );
    }

    /* ── RENDER: full pane (optimized for the narrow taskpane) ─────────────── */
    return (
        <Box sx={{ background: COLORS.background, minHeight: "100vh", p: 1.25 }}>
            {/* ── Compact Header ─────────────────────────────────────────────── */}
            <Paper
                elevation={0}
                sx={{
                    p: 1.5,
                    borderRadius: "10px",
                    background: `linear-gradient(135deg, ${COLORS.primary} 0%, ${COLORS.primaryLight} 55%, ${COLORS.accent} 100%)`,
                    color: "#fff",
                    mb: 1.25,
                    position: "relative",
                    overflow: "hidden",
                }}
            >
                <Box sx={{ position: "absolute", top: "-45%", right: "-15%", width: 130, height: 130, background: "radial-gradient(circle, rgba(139,92,246,0.35), transparent 70%)", borderRadius: "50%", pointerEvents: "none" }} />

                <Box display="flex" alignItems="center" gap={1} position="relative" zIndex={1}>
                    <Box sx={{ background: "rgba(255,255,255,0.15)", backdropFilter: "blur(8px)", p: 0.75, borderRadius: "8px", border: "1px solid rgba(255,255,255,0.2)", display: "flex" }}>
                        <Sparkles size={16} />
                    </Box>
                    <Box sx={{ flex: 1, minWidth: 0 }}>
                        {cardbyte_logo ? (
                            <img src={cardbyte_logo} width={112} alt="CardByte" style={{ borderRadius: 4, display: "block" }} />
                        ) : (
                            <Typography fontFamily="Raleway" fontSize="17px" fontWeight={800} sx={{ letterSpacing: "-0.4px", lineHeight: 1.05 }}>
                                CardByte
                            </Typography>
                        )}
                    </Box>
                    {signatures.length > 0 && (
                        <Chip
                            size="small"
                            icon={<FileText size={11} />}
                            label={signatures.length}
                            sx={{
                                background: "rgba(255,255,255,0.15)",
                                color: "#fff",
                                fontSize: "11px",
                                fontWeight: 700,
                                height: 22,
                                borderRadius: "7px",
                                "& .MuiChip-label": { px: 0.75 },
                                "& .MuiChip-icon": { color: "#fff", fontSize: 12 },
                            }}
                        />
                    )}
                </Box>

                <Typography fontFamily="Plus Jakarta Sans" fontSize="11px" sx={{ mt: 1, opacity: 0.85, position: "relative", zIndex: 1, lineHeight: 1.35 }}>
                    {isMobile
                        ? "Tap a signature to apply it to this email."
                        : "Select a signature to apply it. Only signatures assigned to you are shown."}
                </Typography>

                {process.env.NODE_ENV === "development" && (
                    <Typography fontSize="9px" color="rgba(255,255,255,0.5)" mt={0.75} position="relative" zIndex={1} sx={{ wordBreak: "break-all" }}>
                        {platform} · mac:{String(isMac)} · {user?.emailAddress}
                    </Typography>
                )}
            </Paper>

            {/* ── Info Banner (compact) ──────────────────────────────────────── */}
            {signatures.length > 1 && (
                <Box
                    sx={{
                        background: COLORS.infoBg,
                        border: `1px solid ${COLORS.infoBorder}`,
                        borderRadius: "8px",
                        p: "8px 10px",
                        mb: 1.25,
                        display: "flex",
                        alignItems: "flex-start",
                        gap: 0.75,
                    }}
                >
                    <Info size={13} color={COLORS.info} style={{ flexShrink: 0, marginTop: 1 }} />
                    <Typography fontSize="11px" color={COLORS.info} sx={{ lineHeight: 1.35 }}>
                        Default applies when no rule matches. Rules run top-to-bottom by priority.
                    </Typography>
                </Box>
            )}

            {/* ── Signature List ─────────────────────────────────────────────── */}
            {signatures.length === 0 ? (
                <Paper
                    elevation={0}
                    sx={{
                        p: 3,
                        borderRadius: "10px",
                        background: COLORS.surface,
                        border: `1px solid ${COLORS.border}`,
                        textAlign: "center",
                    }}
                >
                    <Box sx={{ width: 52, height: 52, background: COLORS.grayBg, borderRadius: "14px", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 12px" }}>
                        <AlertCircle size={24} color={COLORS.gray} />
                    </Box>
                    <Typography fontFamily="Plus Jakarta Sans" fontSize="15px" color={COLORS.primary} fontWeight={700} gutterBottom>
                        {error || "No Signatures Available"}
                    </Typography>
                    <Typography fontFamily="Plus Jakarta Sans" fontSize="12px" color={COLORS.gray}>
                        Please contact your Admin.
                    </Typography>
                </Paper>
            ) : (
                <Stack spacing={1.25}>
                    {signatures.map((sig) => {
                        const isExpanded = expandedCards[sig.id] !== false;
                        const isDefault = sig.isDefault;
                        const isApplying = applyingId === sig.id;

                        return (
                            <Paper
                                key={sig.id}
                                elevation={0}
                                sx={{
                                    borderRadius: "10px",
                                    overflow: "hidden",
                                    background: COLORS.surface,
                                    border: `1.5px solid ${isDefault ? COLORS.success : COLORS.border}`,
                                    boxShadow: isDefault ? "0 0 0 2px rgba(16,185,129,0.08)" : "0 1px 2px rgba(0,0,0,0.04)",
                                    transition: "all 0.15s",
                                    "&:hover": {
                                        boxShadow: "0 3px 12px rgba(0,0,0,0.09)",
                                        borderColor: isDefault ? COLORS.success : COLORS.primary,
                                    },
                                }}
                            >
                                {/* Card Header */}
                                <Box
                                    sx={{
                                        p: 1.25,
                                        display: "flex",
                                        alignItems: "flex-start",
                                        gap: 1,
                                        cursor: "pointer",
                                        background: isDefault ? "rgba(16,185,129,0.04)" : "transparent",
                                    }}
                                    onClick={() => toggleExpand(sig.id)}
                                >
                                    {/* Priority / Default badge */}
                                    <Box
                                        sx={{
                                            width: 28,
                                            height: 28,
                                            borderRadius: "8px",
                                            background: isDefault ? COLORS.success : COLORS.primary,
                                            color: "#fff",
                                            display: "flex",
                                            alignItems: "center",
                                            justifyContent: "center",
                                            fontSize: "12px",
                                            fontWeight: 700,
                                            flexShrink: 0,
                                            mt: 0.25,
                                        }}
                                    >
                                        {isDefault ? <Star size={14} /> : sig.priority}
                                    </Box>

                                    {/* Title + Chips */}
                                    <Box sx={{ flex: 1, minWidth: 0 }}>
                                        <Typography fontWeight={600} fontSize="13px" color={COLORS.primary} noWrap>
                                            {sig.name}
                                        </Typography>
                                        {sig.description && (
                                            <Typography fontSize="10px" color={COLORS.gray} noWrap sx={{ mt: 0.2 }}>
                                                {sig.description}
                                            </Typography>
                                        )}
                                        <Box sx={{ mt: 0.6 }}>
                                            {renderRuleChips(sig)}
                                        </Box>
                                    </Box>

                                    {/* Expand toggle */}
                                    <Box sx={{ color: COLORS.gray, display: "flex", mt: 0.25 }}>
                                        {isExpanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                                    </Box>
                                </Box>

                                {/* Expanded Content */}
                                {isExpanded && (
                                    <Fade in>
                                        <Box>
                                            <Divider sx={{ borderColor: COLORS.border }} />

                                            {/* Signature Preview */}
                                            <Box sx={{ p: 1.25, background: "#fff" }}>
                                                <style>{`
                          .sig-scroll-box-${sig.id}::-webkit-scrollbar { height: 5px; }
                          .sig-scroll-box-${sig.id}::-webkit-scrollbar-track { background: ${COLORS.grayBg}; border-radius: 99px; }
                          .sig-scroll-box-${sig.id}::-webkit-scrollbar-thumb { background: ${COLORS.primary}; border-radius: 99px; }
                          .sig-scroll-box-${sig.id}::-webkit-scrollbar-thumb:hover { background: ${COLORS.primaryLight}; }
                        `}</style>

                                                <Box
                                                    className={`sig-scroll-box-${sig.id}`}
                                                    sx={{
                                                        display: "block",
                                                        overflowX: "auto",
                                                        overflowY: "hidden",
                                                        WebkitOverflowScrolling: "touch",
                                                        background: "#fff",
                                                        borderRadius: "6px",
                                                        border: `1px solid ${COLORS.border}`,
                                                        p: 0.75,
                                                    }}
                                                >
                                                    {/* <Box
                                                        sx={{
                                                            display: "inline-block",
                                                            whiteSpace: "nowrap",
                                                            p: 1,
                                                        }}
                                                        dangerouslySetInnerHTML={{ __html: sig.html }}
                                                    /> */}
                                                    <Box sx={{ p: 1.25, background: "#fff" }}>
                                                        <SignaturePreview
                                                            html={sig.html}
                                                            borderColor={COLORS.border}
                                                            trackColor={COLORS.grayBg}
                                                            thumbColor={COLORS.primary}
                                                            minScale={isMobile ? 0.35 : 0.3}
                                                        />
                                                    </Box>
                                                </Box>
                                            </Box>

                                            {/* Action Footer */}
                                            <Box
                                                sx={{
                                                    px: 1.25,
                                                    py: 1,
                                                    display: "flex",
                                                    justifyContent: "space-between",
                                                    alignItems: "center",
                                                    gap: 1,
                                                    background: COLORS.background,
                                                    borderTop: `1px solid ${COLORS.border}`,
                                                }}
                                            >
                                                <Box sx={{ minWidth: 0 }}>
                                                    {isDefault ? (
                                                        <Typography fontSize="10px" color={COLORS.success} fontWeight={600} sx={{ display: "flex", alignItems: "center", gap: 0.4, lineHeight: 1.2 }}>
                                                            <CheckCircle size={11} />
                                                            Auto-applied fallback
                                                        </Typography>
                                                    ) : (
                                                        <Typography fontSize="10px" color={COLORS.gray} sx={{ lineHeight: 1.2 }}>
                                                            Priority {sig.priority} · Rule-based
                                                        </Typography>
                                                    )}
                                                </Box>

                                                <Button
                                                    onClick={() => applyHTML(sig.html, sig.name, sig.id, sig.signatureId)}
                                                    variant="contained"
                                                    size="small"
                                                    disabled={isApplying}
                                                    startIcon={isApplying ? <CircularProgress size={11} sx={{ color: "#fff" }} /> : <Zap size={13} />}
                                                    sx={{
                                                        flexShrink: 0,
                                                        backgroundColor: isDefault ? COLORS.success : COLORS.primary,
                                                        borderRadius: "7px",
                                                        fontSize: "11px",
                                                        fontFamily: "Plus Jakarta Sans",
                                                        textTransform: "capitalize",
                                                        color: "#fff",
                                                        px: 1.5,
                                                        py: 0.6,
                                                        boxShadow: "none",
                                                        "& .MuiButton-startIcon": { mr: 0.5 },
                                                        "&:hover": {
                                                            backgroundColor: isDefault ? "#059669" : COLORS.primaryLight,
                                                            boxShadow: `0 3px 10px ${isDefault ? "rgba(16,185,129,0.3)" : "rgba(30,41,59,0.2)"}`,
                                                        },
                                                        "&:disabled": {
                                                            backgroundColor: isDefault ? "#6ee7b7" : "#94a3b8",
                                                        },
                                                    }}
                                                >
                                                    {isApplying ? "Applying…" : "Apply"}
                                                </Button>
                                            </Box>
                                        </Box>
                                    </Fade>
                                )}
                            </Paper>
                        );
                    })}
                </Stack>
            )}

            {/* ── Refresh Button ─────────────────────────────────────────────── */}
            <Box sx={{ display: "flex", justifyContent: "center", mt: 2, mb: 2 }}>
                <Button
                    onClick={fetchAllSignatures}
                    variant="outlined"
                    size="small"
                    startIcon={<RefreshCw size={13} />}
                    sx={{
                        borderColor: COLORS.border,
                        color: COLORS.gray,
                        borderRadius: "7px",
                        fontSize: "11px",
                        fontFamily: "Plus Jakarta Sans",
                        textTransform: "capitalize",
                        py: 0.5,
                        "&:hover": {
                            borderColor: COLORS.primary,
                            color: COLORS.primary,
                            background: `${COLORS.primary}05`,
                        },
                    }}
                >
                    Refresh
                </Button>
            </Box>
        </Box>
    );
}