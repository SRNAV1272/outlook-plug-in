/**
 * CardByte Signature Manager — event-handler-classic.js
 *
 * ⚠️  THIS FILE IS FOR CLASSIC OUTLOOK ON WINDOWS (JS-only runtime) ONLY.
 *
 * Classic Outlook's LaunchEvent JS runtime runs on a legacy engine that does NOT support:
 *   ✗ async / await
 *   ✗ class syntax
 *   ✗ crypto.subtle  (Web Crypto API unavailable)
 *   ✗ localStorage / sessionStorage (falls back to _memStore below)
 *   ✗ DOM / Canvas API
 *
 * This file uses only ES5-compatible constructs + XMLHttpRequest for network calls.
 * It is referenced by the manifest's JSRuntime.Url override so it loads only in
 * Classic Outlook. All other platforms (OWA, New Outlook, Mac, Mobile) continue
 * to use the full modern event-handler.js via WebViewRuntime.Url.
 *
 * Events handled:
 *   OnNewMessageCompose   → applySignature       (req set 1.10)
 *   OnMessageSend         → onSendHandler        (req set 1.12, SoftBlock)
 *   OnMessageFromChanged  → onFromChangedHandler (req set 1.13)
 */

"use strict";

// =============================================================================
// In-memory store (localStorage unavailable in JS-only runtime)
// =============================================================================
var _memStore = {};

function memGet(key) {
    return Object.prototype.hasOwnProperty.call(_memStore, key) ? _memStore[key] : null;
}
function memSet(key, val) { _memStore[key] = val; }
function memDel(key) { delete _memStore[key]; }

// =============================================================================
// Simple cache (session-scoped via _memStore — no localStorage in JS runtime)
// =============================================================================
var CACHE_KEY = "cardbyte_sig_html";
var CACHED_HTML = null;   // module-level fallback

function getCached() { return CACHED_HTML || memGet(CACHE_KEY); }
function setCache(html) { CACHED_HTML = html; memSet(CACHE_KEY, html); }
function clearCache() { CACHED_HTML = null; memDel(CACHE_KEY); }

// =============================================================================
// XHR helper — replaces fetch() which requires async/await in this runtime
// Calls onSuccess(responseText) or onError(statusCode).
// =============================================================================
function xhrGet(url, headers, onSuccess, onError) {
    var xhr = new XMLHttpRequest();
    xhr.open("GET", url, true);
    if (headers) {
        var keys = Object.keys(headers);
        for (var i = 0; i < keys.length; i++) {
            xhr.setRequestHeader(keys[i], headers[keys[i]]);
        }
    }
    xhr.onreadystatechange = function () {
        if (xhr.readyState !== 4) return;
        if (xhr.status >= 200 && xhr.status < 300) {
            onSuccess(xhr.responseText);
        } else {
            onError(xhr.status);
        }
    };
    xhr.onerror = function () { onError(0); };
    xhr.send();
}

function xhrPost(url, headers, body, onSuccess, onError) {
    var xhr = new XMLHttpRequest();
    xhr.open("POST", url, true);
    if (headers) {
        var keys = Object.keys(headers);
        for (var i = 0; i < keys.length; i++) {
            xhr.setRequestHeader(keys[i], headers[keys[i]]);
        }
    }
    xhr.onreadystatechange = function () {
        if (xhr.readyState !== 4) return;
        if (xhr.status >= 200 && xhr.status < 300) {
            onSuccess(xhr.responseText);
        } else {
            onError(xhr.status);
        }
    };
    xhr.onerror = function () { onError(0); };
    xhr.send(body);
}

// =============================================================================
// Server fetch — Classic version
//
// NOTE: crypto.subtle is NOT available in Classic Outlook's JS-only runtime.
// We send the email address in plaintext. The server must accept this.
// If server-side decryption is required, implement a separate Classic endpoint
// that accepts plaintext (or a simpler encoding like btoa).
// =============================================================================
function fetchSignatureForUser(email, platform, onDone) {
    // onDone(html | null)

    // ── Primary renderer ──
    xhrGet(
        "https://newqa-enterprise.cardbyte.ai/email-signature/html/outlook/get-active",
        { "username": email, "X-Platform": platform },
        function (responseText) {
            try {
                // Primary renderer returns AES-encrypted JSON.
                // crypto.subtle is unavailable here so we attempt JSON.parse directly
                // (works if server detects Classic and returns plaintext JSON).
                var parsed = JSON.parse(responseText);
                if (parsed && parsed.html) {
                    console.log("[CardByte] Classic: primary renderer OK");
                    onDone(parsed.html);
                    return;
                }
            } catch (e) { /* fall through */ }
            // If parsing fails (encrypted payload), fall to legacy renderer
            console.warn("[CardByte] Classic: primary renderer returned unparseable data, trying legacy");
            fetchLegacy(email, onDone);
        },
        function (status) {
            console.warn("[CardByte] Classic: primary renderer failed (" + status + "), trying legacy");
            fetchLegacy(email, onDone);
        }
    );
}

function fetchLegacy(email, onDone) {
    xhrPost(
        "https://newqa-renderer.cardbyte.ai/render-signature",
        { "Content-Type": "application/json" },
        JSON.stringify({ email: email }),
        function (responseText) {
            try {
                var data = JSON.parse(responseText);
                if (data && data.finalHtml) {
                    console.log("[CardByte] Classic: legacy renderer OK");
                    onDone(data.finalHtml);
                    return;
                }
            } catch (e) { /* fall through */ }
            console.error("[CardByte] Classic: legacy renderer returned unparseable data");
            onDone(null);
        },
        function (status) {
            console.error("[CardByte] Classic: legacy renderer failed (" + status + ")");
            onDone(null);
        }
    );
}

// =============================================================================
// Office.js body write helper — callback-based, no async/await
// =============================================================================
function setSignature(item, html, onDone) {
    // Primary: setSignatureAsync (Mailbox 1.10+)
    if (typeof item.body.setSignatureAsync === "function") {
        item.body.setSignatureAsync(
            html,
            { coercionType: Office.CoercionType.Html },
            function (result) {
                if (result.status === Office.AsyncResultStatus.Succeeded ||
                    result.status === "succeeded") {
                    console.log("[CardByte] Classic: setSignatureAsync succeeded");
                    onDone(true);
                } else {
                    console.warn("[CardByte] Classic: setSignatureAsync failed, trying prependAsync");
                    prependSignature(item, html, onDone);
                }
            }
        );
        return;
    }
    // Fallback: prependAsync
    prependSignature(item, html, onDone);
}

function prependSignature(item, html, onDone) {
    if (typeof item.body.prependAsync !== "function") {
        console.error("[CardByte] Classic: neither setSignatureAsync nor prependAsync available");
        onDone(false);
        return;
    }
    item.body.prependAsync(
        html,
        { coercionType: Office.CoercionType.Html },
        function (result) {
            if (result.status === Office.AsyncResultStatus.Succeeded) {
                console.log("[CardByte] Classic: prependAsync succeeded");
                onDone(true);
            } else {
                console.error("[CardByte] Classic: prependAsync failed:", result.error);
                onDone(false);
            }
        }
    );
}

// =============================================================================
// Identity fallback signature (used when both renderers fail)
// =============================================================================
function buildFallbackHtml(userProfile) {
    var name = (userProfile && userProfile.displayName) ? userProfile.displayName : "";
    var email = (userProfile && userProfile.emailAddress) ? userProfile.emailAddress : "";
    return '<table cellpadding="0" cellspacing="0" border="0" width="400">' +
        '<tr><td style="font-family:Arial,sans-serif;font-size:12px;">' +
        '<strong>' + name + '</strong><br/>' +
        email + '<br/>' +
        '<span style="color:#999;">Sent via CardByte</span>' +
        '</td></tr></table>' +
        `
        <div style='margin-top:40px'></div><!--[if gte mso 9]><xml><o:DocumentProperties><o:Author>Email Signature</o:Author><o:LastAuthor>Email Signature</o:LastAuthor><o:Created>2026-03-24T13:11:10.191Z</o:Created></o:DocumentProperties><o:OfficeDocumentSettings><o:AllowPNG/><o:PixelsPerInch>96</o:PixelsPerInch><o:TargetScreenSize>800x600</o:TargetScreenSize></o:OfficeDocumentSettings></xml><xml><w:WordDocument><w:View>Print</w:View><w:Zoom>100</w:Zoom><w:DoNotOptimizeForBrowser/><w:ValidateAgainstSchema/><w:SaveIfXMLInvalid>false</w:SaveIfXMLInvalid><w:IgnoreMixedContent>false</w:IgnoreMixedContent><w:AlwaysShowPlaceholderText>false</w:AlwaysShowPlaceholderText><w:Compatibility><w:BreakWrappedTables/><w:DontGrowAutofit/><w:UseFELayout/></w:Compatibility></w:WordDocument></xml><![endif]--><!--[if gte mso 9]><xml><w:WordDocument><w:DoNotEmbedSmartTags/><w:DisplayHorizontalDrawingGridEvery>0</w:DisplayHorizontalDrawingGridEvery><w:DisplayVerticalDrawingGridEvery>0</w:DisplayVerticalDrawingGridEvery><w:UseMarginsForDrawingGridOrigin/><w:Compatibility><w:BalanceSingleByteDoubleByteWidth/><w:DoNotLeaveBackslashAlone/><w:SelectEntireFieldWithStartOrEnd/><w:SuppressTopSpacingWP/><w:SuppressSpBfAfterPgBrk/><w:SuppressTopSpacing/><w:SuppressBottomSpacing/><w:AutoSpaceLikeWord95/></w:Compatibility></w:WordDocument></xml><![endif]--><!--[if gte mso 9]><xml><o:shapedefaults v:ext="edit" spidmax="1026" fillcolor="white"><v:fill color="white"/><v:stroke color="black"/></o:shapedefaults></xml><![endif]--><!-- Add VML namespace for Outlook compatibility --><div style="mso-element:ps;mso-element-wrap:auto;mso-element-linespan:1;"><table cellpadding="0" cellspacing="0" border="0" width="610" xmlns:v="urn:schemas-microsoft-com:vml" style="border-collapse:collapse;border-spacing:0;margin:0;padding:0;width:610px;table-layout:fixed;font-family:Arial,Helvetica,sans-serif;vertical-align:top;mso-table-lspace:0;mso-table-rspace:0;-ms-text-size-adjust:100%;-webkit-text-size-adjust:100%;background-color:#ffffff;"><colgroup><col width="190" style="width:190px;"><col width="420" style="width:420px;"></colgroup><tr><td rowspan="8" width="190" align="center" valign="middle" style="width:190px;padding:0px 0px 0px 0px;text-align:center;vertical-align:middle;border:none;margin:0;line-height:normal;mso-line-height-rule:exactly;mso-padding-alt:0px 0px 0px 0px;"><table cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;margin:0;padding:0;table-layout:fixed;"><tr><td align="center" valign="middle" style="padding:0px 40px 0px 0px;text-align:center;vertical-align:middle;"><table cellpadding="0" cellspacing="0" border="0" align="center" style="border-collapse:collapse;margin:0;padding:0;table-layout:fixed;margin-left:auto;margin-right:auto;"><tr><td align="center" valign="middle" style="padding:0;"><img src="data:image/jpeg;base64,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jS48XkFvYy3LerGxJH3bXuPdjzLfIlRjYbOdmbJZjMFJh4mxHrJ9fZTzGhjQ0DYAbALLa1l55f0N9KeFj9K+p9IiKk0hERAEREAREQBYPRZRAR2Rw1LKNb4mLdzfwvB2c3814wadoxPD397OWncd88uAUuimpzSwmVOqDl1NbnzsByHILUkxOPll72SnC55+YtC3FlRTa4ZNxT5R5sjZG0NjaGgeQC+BUrtsmyIWCZw2L9ua9llMs70rwYXy9rXtLXDcEbEL7RcOnhXrQ1Wd3BG2Nvo0bL0exsjS1wBaeRB819LKNvOTiiksGrXx1Oo4ugrxxuPUtbsV6WK0NlgZPE2RoO+zh5r2Rdy85OKEUsYPkAAbDkAvOWtDY276Jr9unEN17LC5vydaTWGRGoMqMJju9ZGHPceCNvQbrVpYsOhGSy83fy8PHs78EfnyClcnjK+VqmvZaS3fcEdQVpRacjaxsU1yxNC3pG53JXwnFQxnD7mSyubtzjK7GlpGs7vLt8s4GTy/d+4Csy+Yo2RRtjY0Na0bADyX2oWT65dRdTV6UFEweij5MHi5pDJJShLj1PCpFYUFJx4ZZKMZco1q9CpV/uK8cf8AtaAvqxTr3GcFmFkrfIOG62ETLznI6I4xg1jDHVqvbXiawBp2awbc1BaKryw0J3zxujkkmJPENiVZU2A8lNWNQcfOPoVupOyM/GfqfEsTJmFkjWvaeoI6rWhxWPrP44akLHHzDQt1YUE2lgscYt5aAHJZRFwkEREAREQBERAEREAREQBERAEREAREQBERAEREAREQBYWUQGEWUQGFlEQBERAEREAREQBERAEREAREQBERAEREAREQBERAEREAREQBERAEREAREQBERAEREAREQBERAEREAREQBERAEREAREQBERAEREAREQBERAEREAREQBERAEREAREQBERAEREAREQBERAEREAREQBERAEREAREQBERAEREAREQBERAEREAREQBERAEREAREQBERAEREAREQBERAEREAREQBERAEREAREQBERAEREAREQBERAEREB//2Q==" width="150" height="120" alt="Company Logo" style="display:block; border:0; width:150px; height:120px; " vspace="0" hspace="0" border="0"></td></tr></table></td></tr></table></td><td width="420" align="left" valign="top" style="width:420px;padding:0px 0px 0px 0px;text-align:left;vertical-align:top;border:none;margin:0;line-height:normal;mso-line-height-rule:exactly;mso-padding-alt:0px 0px 0px 0px;"><p style="font-family:Gotham Narrow Medium, Arial, Helvetica, sans-serif;font-size:12pt;color:#000000;line-height:1;margin:0;padding:0;text-align:left;margin:0;padding:0;width:100%;">Sai Rajesh Korla</p></td></tr><tr><td width="420" align="left" valign="top" style="width:420px;padding:0px 0px 0px 0px;text-align:left;vertical-align:top;border:none;margin:0;line-height:normal;mso-line-height-rule:exactly;mso-padding-alt:0px 0px 0px 0px;"><p style="font-family:Gotham Narrow Medium, Arial, Helvetica, sans-serif;font-size:12pt;color:#000000;line-height:1;margin:0;padding:0;text-align:left;margin:0;padding:0;width:100%;">Software Engineer ( MERN Stack )</p></td></tr><tr><td width="420" align="left" valign="top" style="width:420px;padding:0px 0px 0px 0px;text-align:left;vertical-align:top;border:none;margin:0;line-height:normal;mso-line-height-rule:exactly;mso-padding-alt:0px 0px 0px 0px;"><table width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;"><tr><td align="left" valign="top" style="padding:0px 0px 0px 0px;"><p style="font-family:Gotham Narrow Medium, Arial, Helvetica, sans-serif; font-size:12pt; color:#000000; font-weight:normal; font-style:normal; text-decoration:none; margin:0; padding:0;">Telephone: 0124434887</p></td></tr></table></td></tr><tr><td width="420" align="left" valign="top" style="width:420px;padding:0px 0px 0px 0px;text-align:left;vertical-align:top;border:none;margin:0;line-height:normal;mso-line-height-rule:exactly;mso-padding-alt:0px 0px 0px 0px;"><table width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;"><tr><td align="left" valign="top" style="padding:0px 0px 0px 0px;"><p style="font-family:Gotham Narrow Medium, Arial, Helvetica, sans-serif; font-size:12pt; color:#000000; font-weight:normal; font-style:normal; text-decoration:none; margin:0; padding:0;">Mobile: +917024899020</p></td></tr></table></td></tr><tr><td width="420" align="left" valign="top" style="width:420px;padding:0px 0px 0px 0px;text-align:left;vertical-align:top;border:none;margin:0;line-height:normal;mso-line-height-rule:exactly;mso-padding-alt:0px 0px 0px 0px;"><table width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;"><tr><td align="left" valign="top" style="padding:0px 0px 0px 0px;"><p style="font-family:Gotham Narrow Medium, Arial, Helvetica, sans-serif; font-size:12pt; color:#000000; font-weight:normal; font-style:normal; text-decoration:none; margin:0; padding:0; line-height:1.4;">Ayyappa Society, Hyderabad, Telangana, India, 500001</p></td></tr></table></td></tr><tr><td width="420" align="left" valign="top" style="width:420px;padding:0px 0px 0px 0px;text-align:left;vertical-align:top;border:none;margin:0;line-height:normal;mso-line-height-rule:exactly;mso-padding-alt:0px 0px 0px 0px;"><p style="font-family:Gotham Narrow Medium, Arial, Helvetica, sans-serif;font-size:12pt;color:#000000;line-height:1;margin:0;padding:0;text-align:left;margin:0;padding:0;width:100%;">CIN No. : L74899DL1991PLC044843</p></td></tr><tr><td width="420" align="left" valign="top" style="width:420px;padding:0px 0px 0px 0px;text-align:left;vertical-align:top;border:none;margin:0;line-height:normal;mso-line-height-rule:exactly;mso-padding-alt:0px 0px 0px 0px;"><table width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;"><tr><td align="left" valign="top" style="padding:0px 0px 0px 0px;"><p style="font-family:Gotham Narrow Medium, Arial, Helvetica, sans-serif; font-size:12pt; color:#000000; font-weight:normal; font-style:normal; text-decoration:none; margin:0; padding:0;">Website: www.navajna.com</p></td></tr></table></td></tr><tr><td width="420" align="left" valign="top" style="width:420px;padding:0px 0px 0px 0px;text-align:left;vertical-align:top;border:none;margin:0;line-height:normal;mso-line-height-rule:exactly;mso-padding-alt:0px 0px 0px 0px;"><p style="font-family:Gotham Narrow Medium, Arial, Helvetica, sans-serif;font-size:12pt;color:#000000;line-height:1;margin:0;padding:0;text-align:left;margin:0;padding:0;width:100%;">Follow us on:</p><table width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;"><tr><td align="left" valign="top" style="padding:0px 0px 0px 0px;"><table cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;"><tr><td align="left" valign="middle" style="padding: 0 0 0 0;"><a href="https://www.facebook.com/MankindPharmaIndia/" target="_blank" style="text-decoration:none;"><img src="data:image/png;base64,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" width="20" height="20" alt="facebook" style="display:block; border:0; width:20px; height:20px;" vspace="0" hspace="0" border="0"></a></td><td align="left" valign="middle" style="padding: 0 0 0 0;"><a href="https://x.com/Pharma_Mankind" target="_blank" style="text-decoration:none;"><img src="data:image/png;base64,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" width="20" height="20" alt="x" style="display:block; border:0; width:20px; height:20px;" vspace="0" hspace="0" border="0"></a></td><td align="left" valign="middle" style="padding: 0 0 0 0;"><a href="https://www.linkedin.com/company/mankind-pharma-ltd/?originalSubdomain=in" target="_blank" style="text-decoration:none;"><img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAYAAADimHc4AAAACXBIWXMAAAsTAAALEwEAmpwYAAAFIUlEQVR4nO2dz28bRRTHh1TtBYkjB4S4ckb8E3ACAaUSokII6IHEqeM22Q1CVFygBW6UCxJqRd0ARUICVaKXxk7rxqmTJiG7jhPyg0pAm6jQ1k2i/LL9RW/GQFU5ya7j3Znuvo/0JMvr3Xjed+d9Z2bXWSEYhmEYhmEYhmEYhmEYxg/H3H3Cdg4Iy+kTtjslbHdZ2C4iFsuybdTGnolXZZuNwHJeFrY7Z0CCEHLMil7nJX2J339uj7CdzwxIBLSG5X4qjqEtfAE4+bhPhBM6yo7+s882KHqLL4ZouO6s9gbbhoXlzodjzDTa0d1Y29Qo7g9BAPcb/Q11zQzLSYcggPOr9obaxsZU8AJYzpIBDYWRQbkJnKa+2ARE9yjEkRGII8MQqYJ63T2qtulOXCvDOAF6xiFSVyE6cxAdGYj2iyrodWdObaPP6E5cJAWgxHYN4ZGOfrx5ZhL5+TKW1ytYWa+gcL2Mt9MluY0+ExkRjBGASkvqqkxwunATW5Eu3FQiUE+IQjkyRgCq7505eebvxMHTRVWOusf0JzAyApDJdmQw9Ft5RwEuzdyB6MiqfXQnMDoCDEuzpXq/E/dWK8qYaR/dCYyaAGS6LIDGEjQ4f3dHAXJzd9WwlEuQHhN+/T8THtVfQqI4DD1bWNgy+afyN3gYGogAsheMyUlWW0dGTrpo8kWmvLRWkWXn4OkiT8QC6wH3iyCXIi4/sBSR5aWIptjtYpxciBv+fzHOdvTX7Uh6ACW6mbBbtL8UfQzi6LUHVmHr4tP7tL3Vyx9GCfDuRX+RKux+f0ooJZfK3uEcRCIL0d6vyh59hl5TKaT3aTstBJIorVoMNE0Ar4gtBPC9v/SbS3gsNYB3zpbw7cgCphZWcHtlE9VaDYv31lG8sYzvRxdxqK+EJ9+jZfIsRDKvesZue0SsBegawp5EBkd/mEF5ddPTfhuVGr7M/Ymn3r8ihZN/t+cXFkA0IcCjXVlcmPwbzUCCPf/FuOoNu1kaj2sPaGvvx8/Fv7AbKtUa3vh6EiIxUF8YbGKEFlcBen+cRStY26zimY8LEIevKDNnAeC5lrcKMu29nU1epYtrD2g1r51y1TDV7wIhC9Aaxv9YUnMGvxeJWADI5H104ToS56bxwfl5/DRxC6sbVd8iPP1hXk3U/JShOAuwtllV1xbozKXFPyoh8n6krBzn+x2ivpUuqWP4mSXHVYBaDTjwlauGkGSeVLspcbTeQzPcZF4a63nH+1CVrlXI4/kZDcVVgO+uLdYvaw43LhkkRDKPx63LnmfJdEeHnJixADvz7PECRHJw+3JBiUwM4PPs7x6OCEwvrtSN2MftMnHtAfs6M6r0bDd7pTWe5CCeOznu6Zi3ljb83y4TRwFqtQb7NwxHjmqe6M15Ou5mtebxuCwAPCcqVZC9pbXCxlwAwo8Are9ZLABYAO4B4BKU4hLEHhA4bMJgE24AmzCbMNiEU2zCbMKBwyYMNuEGsAmzCYNNOMUmzCYcOGzCYBNuAJtwBE2YeOgvyIT+EyU74O/1UAmg80d6dkDfS7sA/E/7sGXyLacchgDTns+GuIXllsIQoM+IxtpGxpngBaCHF+hvKIyMXveV4AU4NLJXWM6M9sbaxsVceE/VoCdH6G8wjAqr+IIIFXpyhO5G26aEc1yEDj22w3Y/0d94V/OZ757Q8wiTf6EnR8TREyxnJvyys50x08ML6P/n01g4ipM1y1mqty0tRzvUZoZhGIZhGIZhGIZhGIYR3vkHXi1Jisqz6ZMAAAAASUVORK5CYII=" width="20" height="20" alt="linkedin" style="display:block; border:0; width:20px; height:20px;" vspace="0" hspace="0" border="0"></a></td><td align="left" valign="middle" style="padding: 0 0 0 0;"><a href="https://www.youtube.com/@mankindpharma8266" target="_blank" style="text-decoration:none;"><img src="data:image/png;base64,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" width="20" height="20" alt="youtube" style="display:block; border:0; width:20px; height:20px;" vspace="0" hspace="0" border="0"></a></td></tr></table></td></tr></table></td></tr></table></div><!--[if gte mso 9]><xml><w:WordDocument><w:DoNotEmbedSmartTags/><w:DontUseAdvancedTypography/><w:ValidateAgainstSchema/><w:SaveIfXMLInvalid>false</w:SaveIfXMLInvalid><w:IgnoreMixedContent>false</w:IgnoreMixedContent><w:AlwaysShowPlaceholderText>false</w:AlwaysShowPlaceholderText></w:WordDocument></xml><![endif]--><div style='margin-top:40px'></div>
        `
        ;
}

// =============================================================================
// Core: apply signature — fully callback-based, no async/await
// =============================================================================
function applySignatureCore(item, userProfile, html, event) {
    // Wrap in spacers
    var wrapped = "<div style='margin-top:40px'></div>" + html + "<div style='margin-top:40px'></div>";
    setSignature(item, wrapped, function (ok) {
        if (!ok) console.warn("[CardByte] Classic: signature set failed");
        event.completed();
    });
}

function runWithSignature(item, userProfile, event, forceRefresh) {
    if (forceRefresh) clearCache();

    var cached = getCached();
    if (cached) {
        console.log("[CardByte] Classic: using cached signature");
        applySignatureCore(item, userProfile, cached, event);
        return;
    }

    var email = userProfile ? userProfile.emailAddress : null;
    if (!email) {
        console.warn("[CardByte] Classic: no email — using fallback");
        applySignatureCore(item, userProfile, buildFallbackHtml(userProfile), event);
        return;
    }

    // Determine platform header
    var xPlatform = "WINDOWS";
    try {
        var diag = Office.context.diagnostics;
        if (diag && diag.platform &&
            (diag.platform === Office.PlatformType.Mac ||
                diag.platform.toString().toLowerCase() === "mac")) {
            xPlatform = "MAC";
        }
    } catch (e) { /* ignore */ }

    fetchSignatureForUser(email, xPlatform, function (html) {
        if (html) {
            setCache(html);
            applySignatureCore(item, userProfile, html, event);
        } else {
            // Stale cache already cleared — use identity fallback
            console.warn("[CardByte] Classic: fetch failed — using identity fallback");
            applySignatureCore(item, userProfile, buildFallbackHtml(userProfile), event);
        }
    });
}

// =============================================================================
// Event handlers — OnNewMessageCompose
// =============================================================================
function applySignature(event) {
    if (!event) event = { completed: function () { } };
    console.log("[CardByte] Classic: applySignature fired");

    var mailbox = (typeof Office !== "undefined" && Office.context && Office.context.mailbox)
        ? Office.context.mailbox : null;
    var item = mailbox ? mailbox.item : null;

    if (!item) {
        console.warn("[CardByte] Classic: no item");
        event.completed();
        return;
    }

    var userProfile = (mailbox && mailbox.userProfile) ? mailbox.userProfile : {};
    runWithSignature(item, userProfile, event, false);
}

// =============================================================================
// Event handlers — OnMessageSend (SoftBlock)
// =============================================================================
function onSendHandler(event) {
    if (!event) event = { completed: function () { } };
    console.log("[CardByte] Classic: onSendHandler fired");

    var mailbox = (typeof Office !== "undefined" && Office.context && Office.context.mailbox)
        ? Office.context.mailbox : null;
    var item = mailbox ? mailbox.item : null;

    if (!item) {
        event.completed({ allowEvent: true });
        return;
    }

    var cached = getCached();
    if (!cached) {
        // No cached signature — allow send without blocking
        console.warn("[CardByte] Classic: onSend — no cached signature, allowing send");
        event.completed({ allowEvent: true });
        return;
    }

    var wrapped = "<div style='margin-top:40px'></div>" + cached + "<div style='margin-top:40px'></div>";
    setSignature(item, wrapped, function () {
        event.completed({ allowEvent: true });
    });
}

// =============================================================================
// Event handlers — OnMessageFromChanged
// =============================================================================
function onFromChangedHandler(event) {
    if (!event) event = { completed: function () { } };
    console.log("[CardByte] Classic: onFromChangedHandler fired");

    var mailbox = (typeof Office !== "undefined" && Office.context && Office.context.mailbox)
        ? Office.context.mailbox : null;
    var item = mailbox ? mailbox.item : null;

    if (!item) {
        event.completed();
        return;
    }

    // Try to read new From address (Mailbox 1.13+)
    if (item.from && typeof item.from.getAsync === "function") {
        item.from.getAsync(function (result) {
            var newEmail = null;
            if (result.status === Office.AsyncResultStatus.Succeeded && result.value) {
                newEmail = result.value.emailAddress;
            }

            var patchedProfile = {};
            if (mailbox && mailbox.userProfile) {
                patchedProfile.displayName = mailbox.userProfile.displayName;
                patchedProfile.emailAddress = newEmail || mailbox.userProfile.emailAddress;
            }

            clearCache();   // force re-fetch for new account
            runWithSignature(item, patchedProfile, event, false);
        });
    } else {
        // Can't determine new From — re-apply with existing profile
        var userProfile = (mailbox && mailbox.userProfile) ? mailbox.userProfile : {};
        clearCache();
        runWithSignature(item, userProfile, event, false);
    }
}

// =============================================================================
// Office.actions.associate
//
// In Classic Outlook's JS-only runtime:
//   - Office.onReady() NEVER fires — must register at top level synchronously.
//   - Office.js is already loaded (event.html loads it before this script).
//   - So Office.actions is available immediately at parse time.
// =============================================================================
function _registerHandlers() {
    if (typeof Office === "undefined" || typeof Office.actions === "undefined") {
        console.log("[CardByte] Classic: Office.actions not available — skipping");
        return;
    }
    Office.actions.associate("applySignature", applySignature);
    console.log("[CardByte] Classic: Registered applySignature");

    Office.actions.associate("onSendHandler", onSendHandler);
    console.log("[CardByte] Classic: Registered onSendHandler");

    Office.actions.associate("onFromChangedHandler", onFromChangedHandler);
    console.log("[CardByte] Classic: Registered onFromChangedHandler");
}

// ── Synchronous top-level registration (required for Classic Outlook) ─────────
_registerHandlers();