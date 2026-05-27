/* global Office, OfficeRuntime */
import { useEffect, useRef, useState } from "react";
import { Box, Button, CircularProgress, Grid, Paper, Skeleton, Stack, Typography } from "@mui/material";
import { toast } from "react-toastify";
import DefaultTemplate from "./SignatureComponents/Assets/Images/DefaultTemplate.svg";
import usernotfound from "../components/SignatureComponents/Assets/Images/usernotfound.gif";
import signnotassigned from "../components/SignatureComponents/Assets/Images/signnotassigned.webp";
import html2canvas from "html2canvas";

// ─────────────────────────────────────────────────────────────────────────────
// globalThis cache helpers
// These mirror the helpers in App.jsx — same TTL, same key.
// Writing here ensures the cache is populated even when the prefetch loop
// hasn't run yet (e.g. first open, non-Classic platform).
// ─────────────────────────────────────────────────────────────────────────────
const MEM_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes — must match App.jsx

function setMemCache(html) {
    try {
        window.MEMORY_SIGNATURE = { html, ts: Date.now() };
        console.log("[CardByte] SignatureView MemCache: written ✅", new Date().toISOString());
    } catch (e) {
        console.warn("[CardByte] SignatureView MemCache: write failed —", e);
    }
}

function getMemCache() {
    try {
        const entry = window.MEMORY_SIGNATURE;
        if (!entry?.html || !entry?.ts) return null;
        const age = Date.now() - entry.ts;
        if (age > MEM_CACHE_TTL_MS) {
            console.log("[CardByte] SignatureView MemCache: expired (age=%dms)", age);
            window.MEMORY_SIGNATURE = null;
            return null;
        }
        return entry.html;
    } catch {
        return null;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Props
//   Office          — Office global object
//   user            — mailbox user profile
//   apply           — async (signatureHtml: string) => void
//   autoApply       — true when opened automatically via ItemEdit form
//   isMobile        — true on iOS / Android Outlook
//   platform        — 'mobile-ios' | 'mobile-android' | 'owa' | 'desktop'
//   cachedSignature — html string from App.jsx's getMemCache(), or null
// ─────────────────────────────────────────────────────────────────────────────
export default function SignatureView({
    Office,
    user,
    apply,
    autoApply = false,
    isMobile = false,
    platform = "desktop",
    cachedSignature = null,
}) {
    const [form, setForm] = useState(cachedSignature); // ← pre-seed from cache
    const [error, setError] = useState("");
    const [showLegacy, setShowLegacy] = useState(false);
    // If cachedSignature is already available, skip the loading skeleton entirely
    const [load, setLoad] = useState(!cachedSignature);
    const [snapshot, setSnapshot] = useState(null);
    const containerRef = useRef(null);

    // Auto-apply state: idle | applying | done | failed
    const [autoApplyStatus, setAutoApplyStatus] = useState("idle");
    // Prevent double-fire if form state re-renders
    const autoApplyFiredRef = useRef(false);

    /* ── Signature preview via html2canvas ──────────────────── */
    useEffect(() => {
        if (containerRef.current && !isMobile) {
            // Skip html2canvas on mobile — it is slow and unreliable on Outlook mobile WebView
            html2canvas(containerRef.current).then(canvas => {
                setSnapshot(canvas.toDataURL("image/png"));
            }).catch(() => setSnapshot(null));
        }
    }, [form, isMobile]);

    /* ── AUTO-APPLY on form load ─────────────────────────────
       Fires once when:
         • autoApply === true  (opened by Outlook via ItemEdit / mobile compose)
         • form is loaded (not null)
       Covers:  Outlook 2016 / 2019 (ItemEdit trigger)
                Outlook Mobile iOS / Android (ItemEdit trigger)
    ────────────────────────────────────────────────────────── */
    useEffect(() => {
        if (!autoApply) return; // manual open — skip
        if (!form) return; // not loaded yet — wait
        if (autoApplyFiredRef.current) return; // already ran

        autoApplyFiredRef.current = true;
        setAutoApplyStatus("applying");
        console.log(`[CardByte] Auto-apply triggered — platform: ${platform}`);

        apply(form)
            .then(() => {
                console.log("[CardByte] Auto-apply succeeded");
                setAutoApplyStatus("done");

                // Collapse the pane after a short delay — user won't see it flash open
                // closeContainer is available on desktop; on mobile it may not be — safe to ignore
                setTimeout(() => {
                    try {
                        if (typeof Office?.context?.ui?.closeContainer === "function") {
                            Office.context.ui.closeContainer();
                        }
                    } catch { /* not available on all platforms */ }
                }, isMobile ? 1200 : 800);
            })
            .catch((err) => {
                console.error("[CardByte] Auto-apply failed:", err);
                setAutoApplyStatus("failed");
                // Don't close the pane — show the manual button so the user can retry
            });
    }, [autoApply, form, apply, Office, platform, isMobile]);

    /* ── AES / Encryption helpers ────────────────────────────── */
    const AES_KEY = "fnItrY2YfozBqCC2B4XsfqHIvZku3kUOq3DFkbO64kk=";
    const AES_IV = "3YapeNfJDung7TXxeKXn4g==";

    function base64ToArrayBuffer(base64) {
        let b = base64.replace(/-/g, "+").replace(/_/g, "/");
        const pad = b.length % 4; if (pad) b += "=".repeat(4 - pad);
        const bin = atob(b), bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return bytes.buffer;
    }

    async function handleAesDecrypt(encryptedText, generatedKey) {
        try {
            if (!encryptedText) return "";
            const keyToUse = generatedKey || AES_KEY;
            let keyBuffer;
            try { keyBuffer = base64ToArrayBuffer(keyToUse); } catch { return encryptedText; }
            if (keyBuffer.byteLength !== 16 && keyBuffer.byteLength !== 32) {
                if (generatedKey && generatedKey !== AES_KEY) return handleAesDecrypt(encryptedText, AES_KEY);
                return encryptedText;
            }
            const ivBuffer = base64ToArrayBuffer(AES_IV);
            if (ivBuffer.byteLength !== 16) return encryptedText;
            const key = await crypto.subtle.importKey("raw", keyBuffer, { name: "AES-CBC" }, false, ["decrypt"]);
            let encryptedBuffer;
            try { encryptedBuffer = base64ToArrayBuffer(encryptedText); } catch { return encryptedText; }
            if (encryptedBuffer.byteLength % 16 !== 0) return encryptedText;
            const decryptedBuffer = await crypto.subtle.decrypt({ name: "AES-CBC", iv: ivBuffer }, key, encryptedBuffer);
            return new TextDecoder().decode(decryptedBuffer);
        } catch (err) {
            if (generatedKey && generatedKey !== AES_KEY && err.message?.includes("key data")) {
                try { return await handleAesDecrypt(encryptedText, AES_KEY); } catch { }
            }
            return encryptedText;
        }
    }

    async function encryptEmail(email = "") {
        try {
            if (!email?.trim()) return "";
            const keyBuffer = base64ToArrayBuffer(AES_KEY);
            const ivBuffer = base64ToArrayBuffer(AES_IV);
            const key = await crypto.subtle.importKey("raw", keyBuffer, { name: "AES-CBC" }, false, ["encrypt"]);
            const encrypted = await crypto.subtle.encrypt({ name: "AES-CBC", iv: ivBuffer }, key, new TextEncoder().encode(email));
            const bytes = new Uint8Array(encrypted);
            let bin = ""; for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
            return btoa(bin);
        } catch { return ""; }
    }

    /* ── API fetch ───────────────────────────────────────────── */
    async function renderSignatureOnServer(userEmail) {
        try {
            const encryptedMail = await encryptEmail(userEmail);
            const xPlatform = platform === Office.PlatformType.Mac ? "MAC" : "WINDOWS";
            const primaryRes = await fetch(
                "https://newqa-enterprise.cardbyte.ai/email-signature/html/outlook/get-active",
                {
                    method: "GET",
                    headers: {
                        'Content-Type': 'application/json',
                        username: encryptedMail,
                        "X-Platform": xPlatform
                    }
                }
            );
            if (primaryRes.ok) {
                const data = await primaryRes.text();
                const decryptedData = await handleAesDecrypt(data);
                const html = JSON.parse(decryptedData)?.html || null;
                console.log("[CardByte] Using NEW renderer");

                // ── Write to globalThis cache on successful fetch ──────────
                if (html) {
                    setMemCache(html);
                    await apply(html);
                }
                return html;
            }
            console.warn("[CardByte] Primary failed → legacy fallback");
        } catch (err) { console.warn("[CardByte] Primary crashed:", err); }

        try {
            const legacyRes = await fetch(
                "https://qa-renderer.cardbyte.ai/render-signature",
                { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: userEmail }) }
            );
            if (!legacyRes.ok) throw new Error("Legacy renderer failed");
            const legacyData = await legacyRes.json();
            const html = legacyData?.finalHtml || null;
            console.log("[CardByte] Using LEGACY renderer");
            setShowLegacy(true);

            // ── Write legacy result to globalThis cache too ───────────────
            if (html) setMemCache(html);
            return html;
        } catch (err) { console.error("[CardByte] Both renderers failed:", err); return null; }
    }

    /* ── Fetch effect — skips entirely when cachedSignature was provided ── */
    useEffect(() => {
        const encryptAndFetch = async () => {
            if (!user?.emailAddress) return;

            // Fast path: App.jsx already gave us a fresh cache hit — skip the network call.
            // getMemCache() re-validates TTL in case time passed since the prop was computed.
            const memHit = getMemCache();
            if (memHit) {
                console.log("[CardByte] SignatureView: skipping fetch — using MemCache");
                setForm(memHit);
                setLoad(false);
                return;
            }

            // Cache miss (expired, busted, or first open) — fetch from server.
            console.log("[CardByte] SignatureView: cache miss — fetching from server");
            setLoad(true);
            try {
                const apiResponse = await renderSignatureOnServer(user.emailAddress);
                setForm(prev => apiResponse ?? prev);
            } catch (e) {
                console.error(e);
                setError(e?.response?.data?.message || "Failed to load signature");
            } finally {
                setLoad(false);
            }
        };
        encryptAndFetch();
    }, [user]);

    /* ── Manual apply ────────────────────────────────────────── */
    const applyHTML = async () => {
        try {
            const settings = Office.context.roamingSettings;
            settings.saveAsync((result) => {
                if (result.status !== Office.AsyncResultStatus.Succeeded)
                    console.error("❌ Failed to save roaming settings", result.error);
            });
            await apply(form);
            toast.success("Signature applied successfully!");
            // Reset auto-apply status so banner updates
            if (autoApply) setAutoApplyStatus("done");
        } catch (err) {
            toast.error(err?.response?.data?.message || err?.message || "Failed to apply signature, please try again.");
            console.error("[CardByte] Manual apply error:", err);
        }
    };

    /* ── CarByte logo (inline so it works offline) ───────────── */
    const cardbyte_logo = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAANwAAAA0CAYAAADhTVZuAAAACXBIWXMAAAsTAAALEwEAmpwYAAAGWGlUWHRYTUw6Y29tLmFkb2JlLnhtcAAAAAAAPD94cGFja2V0IGJlZ2luPSLvu78iIGlkPSJXNU0wTXBDZWhpSHpyZVN6TlRjemtjOWQiPz4gPHg6eG1wbWV0YSB4bWxuczp4PSJhZG9iZTpuczptZXRhLyIgeDp4bXB0az0iQWRvYmUgWE1QIENvcmUgNi4wLWMwMDIgNzkuMTY0NDg4LCAyMDIwLzA3LzEwLTIyOjA2OjUzICAgICAgICAiPiA8cmRmOlJERiB4bWxuczpyZGY9Imh0dHA6Ly93d3cudzMub3JnLzE5OTkvMDIvMjItcmRmLXN5bnRheC1ucyMiPiA8cmRmOkRlc2NyaXB0aW9uIHJkZjphYm91dD0iIiB4bWxuczp4bXA9Imh0dHA6Ly9ucy5hZG9iZS5jb20veGFwLzEuMC8iIHhtbG5zOnhtcE1NPSJodHRwOi8vbnMuYWRvYmUuY29tL3hhcC8xLjAvbW0vIiB4bWxuczpzdEV2dD0iaHR0cDovL25zLmFkb2JlLmNvbS94YXAvMS4wL3NUeXBlL1Jlc291cmNlRXZlbnQjIiB4bWxuczpwaG90b3Nob3A9Imh0dHA6Ly9ucy5hZG9iZS5jb20vcGhvdG9zaG9wLzEuMC8iIHhtbG5zOmRjPSJodHRwOi8vcHVybC5vcmcvZGMvZWxlbWVudHMvMS4xLyIgeG1wOkNyZWF0b3JUb29sPSJBZG9iZSBQaG90b3Nob3AgMjIuMCAoV2luZG93cykiIHhtcDpDcmVhdGVEYXRlPSIyMDIyLTAyLTI4VDE1OjEwOjUyKzA1OjMwIiB4bXA6TWV0YWRhdGFEYXRlPSIyMDIyLTAyLTI4VDE1OjEwOjUyKzA1OjMwIiB4bXA6TW9kaWZ5RGF0ZT0iMjAyMi0wMi0yOFQxNToxMDo1MiswNTozMCIgeG1wTU06SW5zdGFuY2VJRD0ieG1wLmlpZDo2M2NkMTQ1My1jNTA0LTQ5NDEtYWE2My1kNWYzOTRmZWUwODQiIHhtcE1NOkRvY3VtZW50SUQ9ImFkb2JlOmRvY2lkOnBob3Rvc2hvcDo0YTQ2NDE0NS1lYjJkLWZlNGQtOTg0MS02NGUwOGU0M2FiYTkiIHhtcE1NOk9yaWdpbmFsRG9jdW1lbnRJRD0ieG1wLmRpZDpmNTEyYmI2Ni05YjJjLThkNDQtYjQyZS1kNDdlMjA5ZDNlMzYiIHBob3Rvc2hvcDpDb2xvck1vZGU9IjMiIGRjOmZvcm1hdD0iaW1hZ2UvcG5nIj4gPHhtcE1NOkhpc3Rvcnk+IDxyZGY6U2VxPiA8cmRmOmxpIHN0RXZ0OmFjdGlvbj0iY3JlYXRlZCIgc3RFdnQ6aW5zdGFuY2VJRD0ieG1wLmlpZDo2M2NkMTQ1My1jNTA0LTQ5NDEtYWE2My1kNWYzOTRmZWUwODQiIHN0RXZ0OndoZW49IjIwMjItMDItMjhUMTU6MTA6NTIrMDU6MzAiIHN0RXZ0OnNvZnR3YXJlQWdlbnQ9IkFkb2JlIFBob3Rvc2hvcCAyMi4wIChXaW5kb3dzKSIvPiA8cmRmOmxpIHN0RXZ0OmFjdGlvbj0ic2F2ZWQiIHN0RXZ0Omluc3RhbmNlSUQ9InhtcC5paWQ6NjNjZDE0NTMtYzUwNC00OTQxLWFhNjMtZDVmMzk0ZmVlMDg0IiBzdEV2dDp3aGVuPSIyMDIyLTAyLTI4VDE1OjEwOjUyKzA1OjMwIiBzdEV2dDpzb2Z0d2FyZUFnZW50PSJBZG9iZSBQaG90b3Nob3AgMjIuMCAoV2luZG93cykiIHN0RXZ0OmNoYW5nZWQ9Ii8iLz4gPC9yZGY6U2VxPiA8L3htcE1NOkhpc3Rvcnk+IDxwaG90b3Nob3A6RG9jdW1lbnRBbmNlc3RvcnM+IDxyZGY6QmFnPiA8cmRmOmxpPnhtcC5kaWQ6MmJiNmVlZmUtYjkyNS1jZDRmLWIyYzctODc1M2I0ZDBjMTljPC9yZGY6bGk+IDwvcmRmOkJhZz4gPC9waG90b3Nob3A6RG9jdW1lbnRBbmNlc3RvcnM+IDwvcmRmOkRlc2NyaXB0aW9uPiA8L3JkZjpSREY+IDwveDp4bXBtZXRhPiA8P3hwYWNrZXQgZW5kPSJyIj8+TzjcNwAAE8hJREFUeNrtnQd8TVccx9OFlqLVodXSoXtXl+6B2qOlQ4cdJIQkhCRCpogROyFWErWJGKktS7ZMsWsVkYlGkCB+vb8jN17irby8IHn3//kcT+676973zvec/z7lmAE5LLV9pSjOxxn5vdrsb/1FEEVOVOwJcvvK9K2KCkq8Ap0iNkZiUTASuOwj/tQcQvOMYzv5XqACnAKdIVciSjYfQx2EnLN0iYOURCfOxYXCYGocdsacU4BTgFDGm7Eo6I2BznhUPN98EuPokwH3OboyaEg0L13B4zU9G0r4cBThFFKmsXL8OTF6UAusJu0phkxv/ZhvuuUvSfJFYFHQAp7MuKsApooihUlh0TdJmibCfGlMGtrLg7Ybz7HgMkcxN24nRWLXlqDhOAU4RRSooBZeuwEMyH+2nxmoETm7uEnhjpsdikHO4gDQy8YwCnCKKqMq1S8dw8fg0FBzxQGH2+lve/+9CkQTTbjjoAVwpeBKgIydFC/C8/VNx+MR/CnCmLHl5ecjMzEROTg6uXbtmst/DpZM+yNpWG2c2momWuckMZ+NaojBrbek+5/67ApfZcXCcpj9wqv4dI5rWE6Lw1/pDyD57SQHO1OTKlSv48ccf8corr+Drr79GRkaGSX4PRTmbkLHeDFnbayEnsumNFtEEmZtvgHc+9Wfg6kmcl8YjZ590CbioCgGnqu3GzozDYJdw2E2Jxdbok7jOSIwCnHYpLi5GZGQk/Pz84OrqCgcHB4wdOxYzZszAhg0bcPTo0WoDXJs2bfDEE0/g/fffx6lTp0wSuHPJnXDmbzMJtGYSaM/cbAQv/EkBXVF8Q5xIcYLznENw8jkCV99kCaJ4g8Gz944RaQRPvyQk7MlWgFPrNBcUwNfXFx06dMCLL76IJk2aoFmzZnj++efx3HPP4ZlnnhGvLVq0QL9+/bBjx467Hrhu3bqhefPm+PLLL9VquNGjR6N169Ziv86dO4vWsWNHoRmtrKzEoFNdBhi1cv0q8qLfRNaOWmVhKwNeMxRGmWHfmjpwdPHAGO8tcJu7X2oHSyCqOHiymWkjmZjUePNX78PJzAIFOFm2bNmCTz75BI0bN8brr7+Or776SrSPP/4Y7733noDs008/Fds+//xz6cpmcHd3r/bA/fDDD3jkkUfEZ37jjTdKX1944QXcd9994nPyeH9//+rJW/Fl5EW9LgH3oGbgpHYlvgH2hrwHOyd72DtZw81rArx8N8Nr4X54+KXDdbZh2o7QuUjHDnWPEP7dys1HcLnwmmkDx85EbUZfh6M9Oye1GrUcIWvXrp3YTui4vW7duujSpctdH4TQB7jevXuLQYba+syZM2IftiNHjmDjxo0YNmwYHn/8cTRs2BDr16+vhsAVShrubQm4OtqBS2iAtA0tMNrZDW7j7eEw1hbWDuNgN34pPHxjMHnRXslUTBLwGGRmijRCHAY5h0n/T0R0SqZpArdu3To8/PDD+PDDD/H999/j5ZdfFqDRnNq8eTNOnDghTM2zZ89i//79WLt2rdAKYWFh1cKH0wVcr1698Nhjj+HYsWMazzNmzBjUrl0b3377LS5fvlzNgCuSgHtHJ3BXE+ojfeP7sJeA6zdyNrpYLEN78yXo0M8XPYbMw3CPrfBasEcCbw/cfBIMB68kjdBvTCj8Vu0zLeD27NkjNBYDCgwu0F+jDxMeHl5jopT6AMegSkpKitbz0Nymmblv3z6j3R8HLQaksrKyqg64awXIjXpNAu4hrcAVJ9aTgGuBHkMD8U3fYHQctAxdLRZL4C1Bu/4BaNPHD79ar8SoyRESdOnwmp8CF5/KmJkJ6Ou4E0HbjpgOcL///rswJdu2bSvA42thYSFqihgLOMqgQYNQv359xMXFGe3+CBt9RF3XrhxwFyTgXtUJHJJrI2zFd/is1yYJtqUCtvLt+77zRevnuEEkyKf4p2P8XMPMTELnNCMOw8bvQkZ2Qc0HLjExUUDGIMi7776Lli1b4vz58zUqHG5M4AYPHiyAi4+PN9r9eXt7i4ANTfWqAy6/BLi62oFLfQDrAzuj5R+b0GXwX2qB62b5FzoPCpS03TzxauGyBZ5+yQI8+mgVBY91mYxgcoZCjQeOo+vTTz+N7777TgQNli1bVuPyT8YE7ptvvhED1D///FO9gLtyFrm7miN7Zz2dwAX7d9UKnCp4HcwXoXXvefhp2AqMnBgu+XepmLQwrcJazkICbnd6ds0GrqioSEQeqdk++ugjEYmsCu2WnZ2NQ4cOieifMeTff//VWLlAP+jw4cM4ffp0me2dOnXSC7i0tDSN1126dKkw/XguFgUYS1hIQK2pLWBTeeDykBtpXOBUW7v+CySNNx89bVfDcVo0vP33YsI83WYmgye2XlHSMXGiaLpGA3fw4EGRWyNoL730EoYOHWrUH3nNmjUwNzcX+boPPvgAn332Gfr27Vsa2XRycsKvv/4KDw+PMsfRP/rtt9/Evnv37i3dHhQUJM5hbW19y7UCAgJEaJ/XYqSVpvHPP/8sjpHD/tRMmoD7888/0ahRI41VKIzU0gJgJHfXrl03f+38fBw/flz/3iHtz+urDhhTp04VGu7AgQM6j2cKJjY2Fn///Te2b98uosf6SHFRpgTccxJw9asEOBFYGRwo+Xbz0L7/Qgwcu0kCKhGTF6UKqBgcUQcb59xxJnnKgdyaHzRhx2HOjZ2wadOmmDBhglFAY6dgcIFhdlakMMXAzs7G4Mxrr70moCGETCrTf1SVVatWCU3Ctnv3brHNxsYGjz76qNg2b9680n0vXLiAHj16iPwYBw2eW66IefbZZ0VVjJ2dnQCOiWxNwBFuRh+Zb3NxcRElbHylyU1w5aBSeSioSZk+GThwoM7vhZFN5i5ZtULgOCgwMvzFF1+IVAMHEw4Yr776qrA8aIGoyooVK8Qx/M7Y7rnnHpEbZLpCV61icWGGBFzTKgXupn8XgFa95uKHIWtg4xUjZodPWpgiIHMpAY2F0ebjwuA8ezdSD+aZRlqAmoYwyMB5enoaBTh2XnYEdiZ2RpaIsQSsZ8+eePvttwUQb775lrgu/6aWUxWO3jyOJmBoaCjmz5+PevXqCZgIlqwhCTZLr6h52FkJGTsur0UTkWYytxE0dmRWy2gCrn///uKeCFaDBg3EdWjmPfTQQ6hTp47QfoSRecjywu0cCGgxaBNaENyPsxYohJTfFf1L3mufPn1gYWEhosYjR44UvqcsHDR47JtvvskUKbgAABjUSURBVMmUKbgAABjQSURBVJqCVatWITAwUFgCuN6kcpdOaa6cLr78L3LCmyA7tEGVAXezBaCjeQA6DQrGH6O2YfSUGDGLnGYmAySj5L83hh0wRqRVK/CRExISRIkUI6yxTEp2AmoiwkaY+De1kKq5SI1BoIinWB2oAw4bYSKddbVuLqwRuUoL0DAnakxsVOLFO6LVv3NMKWBCjBVh6A5kJOhQM2bXsF2o4lPiblAmK0YUBiGdTNR5DRkOEAISwIQSSLOeXLGMTUTmNqXcB2VzQDFjBqAc0mXsPqQJ8HXWkBbdgRiJ4YtF4bz5sYEUBqMGi7oqhNGQK2H0kxDgcR7z7s48jHCUAiRLQ7lMNg7y5e4mESmEA6gMJFD1J/rL81CAYJVhBJQDWFNqS7i0bQoB0N4fUxJKQ1GUzLBrSxZUF6dBJxZdDpwHgHxARf0TAHRXkDbXieDmQHIAIXvFh5Kx4N1L4gFJqwFG8PalC4HsGMqyeIWOGQXkJNWl3e09xyabXIJnxZW5I4E4sn29fmqeS6jHPBwHc0GyCzqFvn5Xih2vBBCogBSWGrAFQNlMlVBo7pAAAAABJRU5ErkJggg==";

    /* ── RENDER: spinner while auto-applying ─────────────────── */
    if (autoApply && (autoApplyStatus === "idle" || autoApplyStatus === "applying")) {
        return (
            <Box display="flex" flexDirection="column" alignItems="center" justifyContent="center"
                sx={{ minHeight: isMobile ? "100vh" : 120, p: 3, gap: 2 }}>
                <CircularProgress size={isMobile ? 36 : 28} sx={{ color: "#0b2e79" }} />
                <Typography fontFamily="Plus Jakarta Sans" fontSize={isMobile ? "14px" : "12px"} color="#555" textAlign="center">
                    Applying your CardByte signature…
                </Typography>
            </Box>
        );
    }

    /* ── RENDER: full pane (manual open, or after auto-apply finishes) ── */
    return (
        <Grid container justifyContent="center" rowGap={2}>
            <Grid size={{ xs: 11.5 }}>
                <Box display="flex" alignItems="center" justifyContent="start">
                    <Typography fontFamily="Raleway" color="#3b3535ff" fontSize="12px" fontWeight="bold">
                        Welcome to
                    </Typography>
                    <img src={cardbyte_logo} width={150} alt="cardbyte" />
                </Box>
                <Typography fontFamily="Plus Jakarta Sans" color="#595959" fontSize="12px">
                    {isMobile
                        ? "Tap Apply to add your CardByte signature to this email."
                        : "This is the signature set up for you by your Organisation Administrator. Click apply to add the signature to your mail."}
                </Typography>

                {/* Auto-apply result banners */}
                {autoApply && autoApplyStatus === "done" && (
                    <Box mt={1} px={1.5} py={0.75}
                        sx={{ background: "#dff6dd", borderRadius: "6px", border: "1px solid #a7d7a8" }}>
                        <Typography fontFamily="Plus Jakarta Sans" fontSize="12px" color="#107c10">
                            ✓ Signature applied automatically
                        </Typography>
                    </Box>
                )}
                {autoApply && autoApplyStatus === "failed" && (
                    <Box mt={1} px={1.5} py={0.75}
                        sx={{ background: "#fde7e9", borderRadius: "6px", border: "1px solid #f4b8bd" }}>
                        <Typography fontFamily="Plus Jakarta Sans" fontSize="12px" color="#a80000">
                            ⚠ Auto-apply failed — tap "Apply Signature" to retry.
                        </Typography>
                    </Box>
                )}

                {/* Debug info in development */}
                {process.env.NODE_ENV === "development" && (
                    <Typography fontSize="10px" color="#bbb" mt={0.5}>
                        platform: {platform} | autoApply: {String(autoApply)}
                    </Typography>
                )}
            </Grid>

            <Grid size={{ xs: 11, lg: 4 }}>
                {load ? (
                    <Paper elevation={0} sx={{ p: 1, borderRadius: 8, width: "100%", maxWidth: "800px", margin: "0 auto", display: "flex", flexDirection: "column", alignItems: "center" }}>
                        <Box display="flex" flexDirection="column" alignItems="center" justifyContent="center" mt={4}>
                            <img src={DefaultTemplate} alt="loading" width="100%" />
                            <Box mt={3} width="80%">
                                <Skeleton variant="text" width="60%" height={28} sx={{ mx: "auto", borderRadius: 1 }} animation="wave" />
                                <Skeleton variant="text" width="80%" height={20} sx={{ mx: "auto", mt: 1, borderRadius: 1 }} animation="wave" />
                            </Box>
                        </Box>
                    </Paper>
                ) : (
                    <Paper elevation={0} sx={{ borderRadius: 8, width: "100%", maxWidth: "800px", margin: "0 auto", display: "flex", flexDirection: "column", alignItems: "center" }}>
                        {form === null ? (
                            <Box display="flex" flexDirection="column" alignItems="center" justifyContent="center" mt={4}>
                                <Box textAlign="center">
                                    <img src={error ? usernotfound : signnotassigned} alt="status" width="100%" />
                                    <Typography fontFamily="Plus Jakarta Sans" variant="h6" gutterBottom>
                                        {error || "No Signature Assigned !"}
                                    </Typography>
                                    <Typography fontFamily="Plus Jakarta Sans" variant="body2" color="text.secondary">
                                        Please Contact Admin !
                                    </Typography>
                                </Box>
                            </Box>
                        ) : (
                            <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: "8px", padding: "16px", display: "inline-block", minWidth: "100%" }}>
                                <style>{`
                  .sig-scroll-box::-webkit-scrollbar { height: 3px; }
                  .sig-scroll-box::-webkit-scrollbar-track { background: transparent; }
                  .sig-scroll-box::-webkit-scrollbar-thumb { background: #0B2E79; border-radius: 99px; }
                `}</style>

                                <div className="sig-scroll-box" style={{ width: "100%", background: "#fff", borderRadius: "8px", position: "relative", overflowX: "auto", overflowY: "hidden" }}>
                                    {showLegacy ? (
                                        <div
                                            ref={(el) => {
                                                if (el) {
                                                    const contentWidth = el.scrollWidth;
                                                    const containerWidth = el.parentElement?.clientWidth || contentWidth;
                                                    if (contentWidth > containerWidth) {
                                                        const scale = containerWidth / contentWidth;
                                                        el.style.transform = `scale(${scale})`;
                                                        el.style.transformOrigin = "top left";
                                                        el.style.width = `${100 / scale}%`;
                                                        requestAnimationFrame(() => {
                                                            if (el.parentElement)
                                                                el.parentElement.style.height = `${el.scrollHeight * scale}px`;
                                                        });
                                                    }
                                                }
                                            }}
                                            style={{ display: "inline-block", textAlign: "left", padding: "10px" }}
                                            dangerouslySetInnerHTML={{ __html: form }}
                                        />
                                    ) : isMobile ? (
                                        // On mobile: render HTML directly — html2canvas is unreliable in mobile WebViews
                                        <div style={{ padding: "10px", overflowX: "auto" }}
                                            dangerouslySetInnerHTML={{ __html: form }} />
                                    ) : snapshot ? (
                                        <img src={snapshot} alt="Signature preview" style={{ width: "150%", borderRadius: "8px" }} />
                                    ) : (
                                        <p>Loading preview…</p>
                                    )}
                                </div>

                                {/* Hidden off-screen div used by html2canvas on desktop */}
                                {!isMobile && (
                                    <div ref={containerRef} style={{ position: "absolute", left: "-9999px" }}>
                                        <div dangerouslySetInnerHTML={{ __html: form }} />
                                    </div>
                                )}

                                <Stack mt={1} direction="row" justifyContent="center" width="100%">
                                    <Button
                                        onClick={applyHTML}
                                        variant="outlined"
                                        size={isMobile ? "medium" : "small"}
                                        sx={{
                                            width: isMobile ? "220px" : "180px",
                                            height: isMobile ? "48px" : "40px",
                                            marginRight: "8px",
                                            backgroundColor: "#0b2e79",
                                            borderRadius: "13px",
                                            fontSize: isMobile ? "15px" : "13px",
                                            fontFamily: "Plus Jakarta Sans",
                                            textTransform: "capitalize",
                                            color: "#fff",
                                            // Larger tap target on mobile
                                            touchAction: "manipulation",
                                            "&:hover": { color: "#fff", borderColor: "#144CC9", backgroundColor: "#506AA3" },
                                        }}
                                    >
                                        Apply Signature
                                    </Button>
                                </Stack>
                            </div>
                        )}
                    </Paper>
                )}
            </Grid>
        </Grid>
    );
}