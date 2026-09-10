"use strict";

// =============================================================================
//  CardByte Outlook Add-in — event-handler.js
//
//  v7.9.2. TAMPER CHECKING IS NOW INLINED — NO EXTERNAL DEPENDENCY.
//
//  What changed since v7.9.1:
//   • The entire html-content-signature module has been inlined into this file,
//     eliminating the load-order race condition that caused every send to
//     rewrite the body on Windows Classic.
//   • getHcs() now returns the inlined implementation directly — no global
//     lookup, no deployment-order dependency.
//   • The module is wrapped in a local closure, so it does not pollute the
//     global scope and cannot be interfered with by other scripts.
//   • This is a PURE INLINE — no semantic changes to the verification logic.
// =============================================================================

const CB_VERSION = "v7.9.2-inlined-tamper-check";

// ─────────────────────────────────────────────────────────────────────────────
//  HTML-CONTENT-SIGNATURE — INLINED (v2)
//  Full implementation, exactly as shipped, wrapped in a local closure.
//  This eliminates the load-order dependency that caused silent failures
//  on Windows Classic when the external file was evaluated second.
// ─────────────────────────────────────────────────────────────────────────────

const HtmlContentSignature = (function () {
    "use strict";

    var VERSION = "hcs2";

    /* ---------------------------------------------------------------- tables */

    // Elements whose content is raw text, not markup.
    var RAW_TEXT = {
        script: 1, style: 1, title: 1, textarea: 1,
        xmp: 1, noscript: 1, noframes: 1, plaintext: 1
    };

    // Elements that force a visual break between text runs.
    var BLOCK = {
        address: 1, article: 1, aside: 1, blockquote: 1, body: 1, br: 1,
        caption: 1, center: 1, col: 1, colgroup: 1, dd: 1, details: 1, dialog: 1,
        dir: 1, div: 1, dl: 1, dt: 1, fieldset: 1, figcaption: 1, figure: 1,
        footer: 1, form: 1, h1: 1, h2: 1, h3: 1, h4: 1, h5: 1, h6: 1, header: 1,
        hgroup: 1, hr: 1, html: 1, legend: 1, li: 1, main: 1, menu: 1, nav: 1,
        ol: 1, optgroup: 1, option: 1, p: 1, pre: 1, section: 1, summary: 1,
        table: 1, tbody: 1, td: 1, tfoot: 1, th: 1, thead: 1, tr: 1, ul: 1
    };

    // URL-bearing attributes, in FIXED order so emission is deterministic.
    var URL_ATTRS = [
        "src", "srcset", "poster", "background", "data",
        "xlink:href", "formaction", "action", "dynsrc", "lowsrc"
    ];

    var NAMED = {
        amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00A0",
        ensp: "\u2002", emsp: "\u2003", thinsp: "\u2009", zwnj: "\u200C", zwj: "\u200D",
        lrm: "\u200E", rlm: "\u200F", shy: "\u00AD",
        ndash: "\u2013", mdash: "\u2014", lsquo: "\u2018", rsquo: "\u2019",
        sbquo: "\u201A", ldquo: "\u201C", rdquo: "\u201D", bdquo: "\u201E",
        dagger: "\u2020", Dagger: "\u2021", bull: "\u2022", hellip: "\u2026",
        permil: "\u2030", prime: "\u2032", Prime: "\u2033", lsaquo: "\u2039",
        rsaquo: "\u203A", oline: "\u203E", frasl: "\u2044", euro: "\u20AC",
        trade: "\u2122", copy: "\u00A9", reg: "\u00AE", deg: "\u00B0",
        plusmn: "\u00B1", middot: "\u00B7", laquo: "\u00AB", raquo: "\u00BB",
        times: "\u00D7", divide: "\u00F7", frac12: "\u00BD", frac14: "\u00BC",
        frac34: "\u00BE", pound: "\u00A3", yen: "\u00A5", cent: "\u00A2",
        curren: "\u00A4", sect: "\u00A7", para: "\u00B6", micro: "\u00B5",
        iexcl: "\u00A1", iquest: "\u00BF", brvbar: "\u00A6", uml: "\u00A8",
        not: "\u00AC", macr: "\u00AF", acute: "\u00B4", cedil: "\u00B8",
        sup1: "\u00B9", sup2: "\u00B2", sup3: "\u00B3", ordm: "\u00BA", ordf: "\u00AA",
        agrave: "\u00E0", aacute: "\u00E1", acirc: "\u00E2", atilde: "\u00E3",
        auml: "\u00E4", aring: "\u00E5", ccedil: "\u00E7", egrave: "\u00E8",
        eacute: "\u00E9", ecirc: "\u00EA", euml: "\u00EB", igrave: "\u00EC",
        iacute: "\u00ED", icirc: "\u00EE", iuml: "\u00EF", ntilde: "\u00F1",
        ograve: "\u00F2", oacute: "\u00F3", ocirc: "\u00F4", otilde: "\u00F5",
        ouml: "\u00F6", ugrave: "\u00F9", uacute: "\u00FA", ucirc: "\u00FB",
        uuml: "\u00FC", yacute: "\u00FD", szlig: "\u00DF",
        Agrave: "\u00C0", Aacute: "\u00C1", Auml: "\u00C4", Ccedil: "\u00C7",
        Egrave: "\u00C8", Eacute: "\u00C9", Ouml: "\u00D6", Uuml: "\u00DC",
        Ntilde: "\u00D1"
    };

    // Entities browsers decode even without a trailing semicolon.
    var NO_SEMI = {
        amp: 1, lt: 1, gt: 1, quot: 1, nbsp: 1, copy: 1, reg: 1, deg: 1, pound: 1,
        yen: 1, cent: 1, sect: 1, middot: 1, times: 1, divide: 1, not: 1, shy: 1,
        macr: 1, acute: 1, uml: 1, para: 1, micro: 1
    };

    // Invisible / formatting characters that cannot change what is rendered.
    var ZERO_WIDTH = /[\u00AD\u200B\u200C\u200D\u200E\u200F\u2060\u2061\u2062\u2063\u2064\uFEFF]/g;
    // Everything HTML treats as collapsible whitespace, incl. NBSP + Unicode spaces.
    var WHITESPACE = /[\t\n\f\r \u000B\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]+/g;

    var DEFAULTS = {
        links: true,        // capture <a href> / <area href> targets
        media: true,        // capture src / srcset / poster / background / ...
        css: true,          // capture <style> bodies and style="" url()s
        scriptBodies: true, // capture <script> bodies
        breaks: true,       // emit break tokens at block boundaries
        normalizeUnicode: true, // NFC, so composed vs decomposed compare equal
        lowercaseUrls: false,   // off: URL paths are case-sensitive
        // Collapse cid:/blob:/data: URLs to one placeholder. REQUIRED when
        // comparing against a live Outlook draft body: the host rewrites remote
        // <img src> to cid: attachment references as soon as the signature is
        // inserted, so a strict URL compare reports every desktop draft as tampered.
        // http(s) URLs stay strict - those are the ones worth guarding.
        hostRewrittenUrls: false
    };

    /* --------------------------------------------------------------- helpers */

    function options(o) {
        var out = {}, k;
        for (k in DEFAULTS) if (DEFAULTS.hasOwnProperty(k)) out[k] = DEFAULTS[k];
        if (o) for (k in o) if (o.hasOwnProperty(k) && out.hasOwnProperty(k)) out[k] = o[k];
        return out;
    }

    function fromCodePoint(cp) {
        if (cp < 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return "\uFFFD";
        if (cp > 0xffff) {
            cp -= 0x10000;
            return String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
        }
        return String.fromCharCode(cp);
    }

    var ENT_RE = /&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31})(;?)/g;

    function decodeEntities(str) {
        if (str.indexOf("&") === -1) return str;
        return str.replace(ENT_RE, function (m, body, semi) {
            if (body.charAt(0) === "#") {
                var cp = body.charAt(1) === "x" || body.charAt(1) === "X"
                    ? parseInt(body.slice(2), 16)
                    : parseInt(body.slice(1), 10);
                if (isNaN(cp)) return m;
                return fromCodePoint(cp);
            }
            if (NAMED.hasOwnProperty(body) && (semi || NO_SEMI[body])) return NAMED[body];
            // Unknown entity: leave verbatim. Deterministic on every host.
            return m;
        });
    }

    function normalizeText(s, o) {
        s = s.replace(ZERO_WIDTH, "");
        if (o.normalizeUnicode && typeof s.normalize === "function") {
            try { s = s.normalize("NFC"); } catch (e) { /* older hosts */ }
        }
        return s.replace(WHITESPACE, " ");
    }

    // Browsers strip tabs/newlines/CRs from URLs and trim surrounding whitespace.
    function normalizeUrl(v, o) {
        if (v == null) return "";
        v = decodeEntities(String(v)).replace(/[\t\n\r]+/g, "").replace(ZERO_WIDTH, "");
        v = v.replace(/^[\s\u00A0]+|[\s\u00A0]+$/g, "");
        if (o.hostRewrittenUrls && /^(?:cid|blob|data):/i.test(v)) return "@embedded";
        return o.lowercaseUrls ? v.toLowerCase() : v;
    }

    function normalizeSrcset(v, o) {
        var parts = String(v == null ? "" : v).split(",");
        var res = [], i, p, sp, url, desc;
        for (i = 0; i < parts.length; i++) {
            p = decodeEntities(parts[i]).replace(WHITESPACE, " ").replace(/^ | $/g, "");
            if (!p) continue;
            sp = p.indexOf(" ");
            url = sp === -1 ? p : p.slice(0, sp);
            desc = sp === -1 ? "" : " " + p.slice(sp + 1);
            res.push(normalizeUrl(url, o) + desc);
        }
        return res.join(",");
    }

    var CSS_URL_RE = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)/gi;

    function cssUrls(css, o) {
        var found = [], m;
        CSS_URL_RE.lastIndex = 0;
        while ((m = CSS_URL_RE.exec(css)) !== null) {
            var u = normalizeUrl(m[1] != null ? m[1] : (m[2] != null ? m[2] : m[3]), o);
            if (u) found.push(u);
            if (CSS_URL_RE.lastIndex === m.index) CSS_URL_RE.lastIndex++; // guard
        }
        return found;
    }

    /* ---------------------------------------------------------- token emitter */

    function Emitter(o) {
        this.o = o;
        this.tokens = [];
        this.buf = [];
        this.pendingSpace = false;
    }

    Emitter.prototype.flush = function () {
        if (this.buf.length) {
            this.tokens.push(["t", this.buf.join("")]);
            this.buf.length = 0;
        }
        this.pendingSpace = false;
    };

    Emitter.prototype.text = function (raw, alreadyDecoded) {
        if (!raw) return;
        var t = normalizeText(alreadyDecoded ? raw : decodeEntities(raw), this.o);
        if (!t) return;
        if (t === " ") { if (this.buf.length) this.pendingSpace = true; return; }
        var lead = t.charAt(0) === " ";
        var trail = t.charAt(t.length - 1) === " ";
        var core = t.replace(/^ +| +$/g, "");
        if (this.buf.length && (this.pendingSpace || lead)) this.buf.push(" ");
        this.buf.push(core);
        this.pendingSpace = trail;
    };

    Emitter.prototype.token = function (arr) {
        this.flush();
        this.tokens.push(arr);
    };

    Emitter.prototype.brk = function () {
        if (!this.o.breaks) { if (this.buf.length) this.pendingSpace = true; return; }
        this.flush();
        var last = this.tokens[this.tokens.length - 1];
        if (!this.tokens.length) return;
        if (last && last.length === 1 && last[0] === "b") return;
        this.tokens.push(["b"]);
    };

    Emitter.prototype.element = function (tag, getAttr) {
        var o = this.o, i, a, v;

        if (BLOCK[tag]) this.brk();

        if (o.media) {
            for (i = 0; i < URL_ATTRS.length; i++) {
                a = URL_ATTRS[i];
                v = getAttr(a);
                if (v == null) continue;
                this.token(["u", tag, a, a === "srcset" ? normalizeSrcset(v, o) : normalizeUrl(v, o)]);
            }
        }

        if (o.links && (tag === "a" || tag === "area" || tag === "link")) {
            v = getAttr("href");
            if (v != null) this.token(["h", tag, normalizeUrl(v, o)]);
        }

        if (tag === "img" || tag === "image" || tag === "input" || tag === "object" ||
            tag === "embed" || tag === "iframe" || tag === "video" || tag === "audio" ||
            tag === "svg" || tag === "canvas") {
            this.token(["e", tag]);
            if (tag === "input") {
                v = getAttr("type");
                if (v != null) this.token(["a", "type", normalizeText(decodeEntities(String(v)), o)]);
                v = getAttr("value");
                if (v != null) this.token(["a", "value", normalizeText(decodeEntities(String(v)), o)]);
            }
        }

        if (o.css) {
            v = getAttr("style");
            if (v != null) {
                var urls = cssUrls(decodeEntities(String(v)), o);
                for (i = 0; i < urls.length; i++) this.token(["c", urls[i]]);
            }
        }
    };

    Emitter.prototype.rawBody = function (tag, body) {
        var o = this.o, i, urls;
        if (tag === "style") {
            if (!o.css) return;
            body = normalizeText(decodeEntities(body), o).replace(/^ +| +$/g, "");
            this.token(["s", "style", body]);
            return;
        }
        if (tag === "script") {
            if (!o.scriptBodies) return;
            body = body.replace(WHITESPACE, " ").replace(/^ +| +$/g, "");
            this.token(["s", "script", body]);
            return;
        }
        if (tag === "textarea" || tag === "title") {
            this.token(["s", tag, normalizeText(decodeEntities(body), o).replace(/^ +| +$/g, "")]);
            return;
        }
        this.text(body);
    };

    Emitter.prototype.finish = function () {
        this.flush();
        var t = this.tokens;
        while (t.length && t[t.length - 1].length === 1 && t[t.length - 1][0] === "b") t.pop();
        return t;
    };

    /* --------------------------------------------------- tokenizer (default) */

    function attrGetter(attrs) {
        return function (name) {
            return attrs.hasOwnProperty(name) ? attrs[name] : null;
        };
    }

    var ATTR_RE = /([^\s=\/>"'][^\s=\/>]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]*)))?/g;

    function parseAttrs(src) {
        var attrs = {}, m, name;
        ATTR_RE.lastIndex = 0;
        while ((m = ATTR_RE.exec(src)) !== null) {
            if (ATTR_RE.lastIndex === m.index) { ATTR_RE.lastIndex++; continue; }
            name = m[1].toLowerCase();
            if (name === "/" || !name) continue;
            var val = m[2] != null ? m[2] : (m[3] != null ? m[3] : (m[4] != null ? m[4] : ""));
            if (!attrs.hasOwnProperty(name)) attrs[name] = val;
        }
        return attrs;
    }

    function tokenize(html, o) {
        var s = html == null ? "" : String(html);
        var n = s.length, i = 0, em = new Emitter(o), guard = 0;

        while (i < n) {
            if (++guard > n * 4 + 16) break;

            var lt = s.indexOf("<", i);
            if (lt < 0) { em.text(s.slice(i)); break; }
            if (lt > i) em.text(s.slice(i, lt));

            var next = s.charAt(lt + 1);

            if (s.substr(lt, 4) === "<!--") {
                var endC = s.indexOf("-->", lt + 4);
                if (endC < 0) { i = n; break; }
                i = endC + 3;
                continue;
            }
            if (next === "!" || next === "?") {
                var endB = s.indexOf(">", lt + 2);
                i = endB < 0 ? n : endB + 1;
                continue;
            }

            var isEnd = next === "/";
            var nameStart = lt + (isEnd ? 2 : 1);
            var ch = s.charAt(nameStart);
            if (!/[a-zA-Z]/.test(ch)) {
                em.text("<");
                i = lt + 1;
                continue;
            }

            var p = nameStart;
            while (p < n && /[^\s\/>]/.test(s.charAt(p))) p++;
            var tag = s.slice(nameStart, p).toLowerCase();

            var q = p, quote = "";
            while (q < n) {
                var c = s.charAt(q);
                if (quote) { if (c === quote) quote = ""; }
                else if (c === '"' || c === "'") quote = c;
                else if (c === ">") break;
                q++;
            }
            var attrSrc = s.slice(p, q);
            i = (q < n ? q + 1 : n);

            if (isEnd) {
                if (BLOCK[tag]) em.brk();
                if (o.links && tag === "a") em.token(["/h"]);
                continue;
            }

            var attrs = parseAttrs(attrSrc);
            em.element(tag, attrGetter(attrs));

            if (RAW_TEXT[tag]) {
                if (tag === "plaintext") { em.rawBody(tag, s.slice(i)); i = n; continue; }
                var close = -1, from = i;
                var lower = s.toLowerCase(), needle = "</" + tag;
                close = lower.indexOf(needle, from);
                if (close < 0) { em.rawBody(tag, s.slice(from)); i = n; continue; }
                em.rawBody(tag, s.slice(from, close));
                i = close;
            }
        }

        return em.finish();
    }

    /* ------------------------------------------------- DOM path (diagnostic) */

    var TEXT_NODE = 3, ELEMENT_NODE = 1;

    function domParserSupportsHtml() {
        try {
            if (typeof DOMParser === "undefined") return false;
            var d = new DOMParser().parseFromString("<i>x</i>", "text/html");
            return !!(d && d.body && d.body.textContent === "x");
        } catch (e) { return false; }
    }

    function parseToBody(html) {
        var str = html == null ? "" : String(html);
        if (domParserSupportsHtml()) {
            var d = new DOMParser().parseFromString(str, "text/html");
            if (d && d.body) return d.body;
        }
        if (typeof document !== "undefined" && document.implementation &&
            document.implementation.createHTMLDocument) {
            var doc = document.implementation.createHTMLDocument("");
            doc.body.innerHTML = str.replace(
                /\s(src|srcset|background|poster|lowsrc|dynsrc)\s*=/gi,
                " data-hcs-$1="
            );
            return doc.body;
        }
        return null;
    }

    function domAttrGetter(el) {
        return function (name) {
            if (el.hasAttribute && el.hasAttribute(name)) return el.getAttribute(name);
            if (el.hasAttribute && el.hasAttribute("data-hcs-" + name)) {
                return el.getAttribute("data-hcs-" + name);
            }
            return null;
        };
    }

    function tokenizeDom(html, o) {
        var body = parseToBody(html);
        var em = new Emitter(o);
        if (!body) return null;

        var stack = [{ node: body, i: 0, entered: false }];
        while (stack.length) {
            var top = stack[stack.length - 1];
            var node = top.node;

            if (!top.entered) {
                top.entered = true;
                if (node !== body && node.nodeType === ELEMENT_NODE) {
                    var tag = String(node.tagName || "").toLowerCase();
                    em.element(tag, domAttrGetter(node));
                    if (RAW_TEXT[tag]) {
                        em.rawBody(tag, node.textContent || "");
                        stack.pop();
                        continue;
                    }
                }
            }

            var kids = node.childNodes;
            if (kids && top.i < kids.length) {
                var child = kids[top.i++];
                if (child.nodeType === TEXT_NODE) em.text(child.nodeValue || "", true);
                else if (child.nodeType === ELEMENT_NODE) stack.push({ node: child, i: 0, entered: false });
                continue;
            }

            if (node !== body && node.nodeType === ELEMENT_NODE) {
                var t2 = String(node.tagName || "").toLowerCase();
                if (BLOCK[t2]) em.brk();
                if (o.links && t2 === "a") em.token(["/h"]);
            }
            stack.pop();
        }
        return em.finish();
    }

    /* ------------------------------------------------- marked region extraction */

    var VOID = {
        area: 1, base: 1, br: 1, col: 1, embed: 1, hr: 1, img: 1, input: 1,
        link: 1, meta: 1, param: 1, source: 1, track: 1, wbr: 1
    };

    function isAlpha(c) { return (c >= 65 && c <= 90) || (c >= 97 && c <= 122); }
    function isTagNameEnd(c) {
        return c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 47 || c === 62;
    }

    function extractMarkedRegions(html, attr) {
        var s = String(html == null ? "" : html);
        var a = String(attr).toLowerCase();
        var found = [];
        if (!s || s.indexOf("<") === -1) return found;

        var lower = s.toLowerCase();
        if (lower.indexOf(a) === -1) return found;

        var n = s.length, i = 0;
        var openTag = "", depth = 0, innerStart = 0, openValue = "", openStart = 0;

        while (i < n) {
            var lt = s.indexOf("<", i);
            if (lt < 0) break;

            if (s.charCodeAt(lt + 1) === 33 && s.charCodeAt(lt + 2) === 45 && s.charCodeAt(lt + 3) === 45) {
                var ec = s.indexOf("-->", lt + 4);
                i = ec < 0 ? n : ec + 3;
                continue;
            }
            var nc = s.charCodeAt(lt + 1);
            if (nc === 33 || nc === 63) {
                var eb = s.indexOf(">", lt + 2);
                i = eb < 0 ? n : eb + 1;
                continue;
            }

            var isEnd = nc === 47;
            var ns = lt + (isEnd ? 2 : 1);
            if (!isAlpha(s.charCodeAt(ns))) { i = lt + 1; continue; }

            var p = ns;
            while (p < n && !isTagNameEnd(s.charCodeAt(p))) p++;
            var tag = lower.slice(ns, p);

            var q = p, quote = 0;
            while (q < n) {
                var c = s.charCodeAt(q);
                if (quote) { if (c === quote) quote = 0; }
                else if (c === 34 || c === 39) quote = c;
                else if (c === 62) break;
                q++;
            }
            var afterTag = (q < n ? q + 1 : n);
            var selfClosing = !!VOID[tag] || (function () {
                var k = q - 1;
                while (k > p && isTagNameEnd(s.charCodeAt(k)) && s.charCodeAt(k) !== 47) k--;
                return s.charCodeAt(k) === 47;
            })();

            if (depth > 0) {
                if (tag === openTag) {
                    if (isEnd) {
                        if (--depth === 0) {
                            found.push({
                                value: openValue, tag: openTag, inner: s.slice(innerStart, lt),
                                start: openStart, end: afterTag
                            });
                        }
                    } else if (!selfClosing) depth++;
                }
            } else if (!isEnd && !selfClosing && q - p > a.length) {
                var attrSrc = lower.slice(p, q);
                var attrs = attrSrc.indexOf(a) === -1 ? null : parseAttrs(s.slice(p, q));
                if (attrs && attrs.hasOwnProperty(a)) {
                    openTag = tag;
                    depth = 1;
                    innerStart = afterTag;
                    openStart = lt;
                    openValue = decodeEntities(attrs[a] || "");
                }
            }

            i = afterTag;
            if (!isEnd && RAW_TEXT[tag]) {
                var close = lower.indexOf("</" + tag, i);
                i = close < 0 ? n : close;
            }
        }

        if (depth > 0) {
            found.push({
                value: openValue, tag: openTag, inner: s.slice(innerStart),
                start: openStart, end: s.length
            });
        }
        return found;
    }

    /* ------------------------------------------------- draft / quote splitting */

    var QUOTE_MARKERS = [
        "appendonsend",
        "divrplyfwdmsg",
        "mail-editor-reference-message-container",
        "-----original message-----",
        "-------- original message --------",
        "id=\"stopspelling\"", "id='stopspelling'",
        "blockquote type=\"cite\"", "blockquote type='cite'",
        "gmail_quote",
        "yahoo_quoted",
        "ms-outlook-mobile-reference-message",
        "border-top:solid #e1e1e1 1.0pt"
    ];

    function splitDraftAtQuote(html) {
        var s = String(html == null ? "" : html);
        var lower = s.toLowerCase();
        var at = -1;
        for (var i = 0; i < QUOTE_MARKERS.length; i++) {
            var hit = lower.indexOf(QUOTE_MARKERS[i]);
            if (hit !== -1 && (at === -1 || hit < at)) at = hit;
        }
        if (at === -1) return { live: s, quoted: "", boundary: s.length };
        var lt = s.lastIndexOf("<", at);
        if (lt !== -1) at = lt;
        return { live: s.slice(0, at), quoted: s.slice(at), boundary: at };
    }

    var PROFILES = {
        strict: {},
        body: { css: false, scriptBodies: false, hostRewrittenUrls: true }
    };

    function keyOf(tok) { return JSON.stringify(tok); }

    function tokEq(x, y, wild) {
        if (x.length !== y.length) return false;
        for (var i = 0; i < x.length; i++) {
            if (x[i] === y[i]) continue;
            if (wild && x[0] === "u" && i === 3 && (x[3] === "@embedded" || y[3] === "@embedded")) continue;
            return false;
        }
        return true;
    }

    function runsEqual(a, b, wild) {
        if (a.length !== b.length) return false;
        for (var i = 0; i < a.length; i++) if (!tokEq(a[i], b[i], wild)) return false;
        return true;
    }

    function stripEdgeBreaks(toks) {
        var a = 0, b = toks.length;
        while (a < b && toks[a].length === 1 && toks[a][0] === "b") a++;
        while (b > a && toks[b - 1].length === 1 && toks[b - 1][0] === "b") b--;
        return toks.slice(a, b);
    }

    function indexOfTokenRun(hay, needle, wild) {
        if (!needle.length) return -1;
        var hk = hay.map(keyOf), nk = needle.map(keyOf);
        var limit = hk.length - nk.length, i, j, ok;
        for (i = 0; i <= limit; i++) {
            ok = true;
            for (j = 0; j < nk.length; j++) if (hk[i + j] !== nk[j]) { ok = false; break; }
            if (ok) return i;
        }
        if (!wild) return -1;
        for (i = 0; i <= limit; i++) {
            ok = true;
            for (j = 0; j < needle.length; j++) if (!tokEq(hay[i + j], needle[j], true)) { ok = false; break; }
            if (ok) return i;
        }
        return -1;
    }

    function overlap(expected, actual) {
        var want = stripEdgeBreaks(expected).filter(function (t) { return t[0] !== "b"; });
        if (!want.length) return 1;
        var bag = {}, i, k;
        for (i = 0; i < actual.length; i++) {
            k = keyOf(actual[i]);
            bag[k] = (bag[k] || 0) + 1;
        }
        var hit = 0;
        for (i = 0; i < want.length; i++) {
            k = keyOf(want[i]);
            if (bag[k] > 0) { bag[k]--; hit++; }
        }
        return hit / want.length;
    }

    function verifyRegion(expectedHtml, containerHtml, o) {
        var opt = options(o);
        var exp = stripEdgeBreaks(tokenize(expectedHtml, opt));
        var act = tokenize(containerHtml, opt);
        if (!exp.length) return { verdict: "absent", at: -1, overlap: 0 };
        var at = indexOfTokenRun(act, exp, opt.hostRewrittenUrls);
        if (at >= 0) return { verdict: "identical", at: at, overlap: 1 };
        var ov = overlap(exp, act);
        return { verdict: ov >= 0.5 ? "modified" : "absent", at: -1, overlap: ov };
    }

    function verifyExact(expectedHtml, actualHtml, o) {
        var opt = options(o);
        var exp = stripEdgeBreaks(tokenize(expectedHtml, opt));
        var act = stripEdgeBreaks(tokenize(actualHtml, opt));
        if (runsEqual(exp, act, opt.hostRewrittenUrls)) return { verdict: "identical", at: 0, overlap: 1 };
        var ov = overlap(exp, act);
        return { verdict: ov >= 0.5 ? "modified" : "absent", at: -1, overlap: ov };
    }

    function verifyInDraft(expectedHtml, bodyHtml, o) {
        var opt = options(o);
        var attr = (o && o.markAttr) || "data-cb-sig";
        var sigId = o && o.sigId != null ? String(o.sigId) : null;

        var split = splitDraftAtQuote(bodyHtml);
        var hasQuote = split.boundary < String(bodyHtml == null ? "" : bodyHtml).length;
        var scope = hasQuote ? "live-of-reply" : "whole-body";

        var all = extractMarkedRegions(bodyHtml, attr);
        var live = [], quoted = 0;
        for (var i = 0; i < all.length; i++) {
            if (all[i].start < split.boundary) live.push(all[i]);
            else quoted++;
        }

        var quotedCopy = null;
        function describe(extra) {
            if (quotedCopy === null) {
                quotedCopy = !!split.quoted &&
                    verifyRegion(expectedHtml, split.quoted, opt).verdict === "identical";
            }
            return extra +
                (quoted ? ", " + quoted + " marked copy/copies in the quote" : "") +
                (quotedCopy ? ", intact copy in the quote (ignored)" : "");
        }

        if (live.length > 1) {
            return {
                verdict: "duplicate", scope: scope, quotedCopy: quotedCopy,
                reason: describe(live.length + " signature blocks in the live area")
            };
        }

        if (live.length === 1) {
            if (sigId !== null && String(live[0].value) !== sigId) {
                return {
                    verdict: "id-changed", scope: scope, quotedCopy: quotedCopy,
                    reason: describe("live block has id=" + live[0].value + ", target=" + sigId)
                };
            }
            var r = verifyExact(expectedHtml, live[0].inner, opt);
            if (r.verdict === "identical") {
                return {
                    verdict: "identical", scope: scope, quotedCopy: false,
                    reason: "marked live block, overlap=1.00" +
                        (quoted ? ", " + quoted + " marked copy/copies in the quote (ignored)" : "")
                };
            }
            return {
                verdict: r.verdict, scope: scope, quotedCopy: quotedCopy,
                reason: describe("marked live block, overlap=" + r.overlap.toFixed(2))
            };
        }

        var r2 = verifyRegion(expectedHtml, split.live, opt);
        if (r2.verdict === "identical") {
            return {
                verdict: "identical", scope: scope, quotedCopy: false,
                reason: "unmarked live area, overlap=1.00"
            };
        }
        return {
            verdict: r2.verdict, scope: scope, quotedCopy: quotedCopy,
            reason: describe("unmarked live area, overlap=" + r2.overlap.toFixed(2))
        };
    }

    /* -------------------------------------------------------------- public API */

    function tokensOf(html, o) { return tokenize(html, options(o)); }

    function serialize(tokens) {
        return VERSION + ":" + tokens.length + ":" + JSON.stringify(tokens);
    }

    function signature(html, o) { return serialize(tokensOf(html, o)); }

    function signatureFromDom(html, o) {
        var t = tokenizeDom(html, options(o));
        return t ? serialize(t) : null;
    }

    function equal(a, b, o) {
        var sa = signature(a, o), sb = signature(b, o);
        return sa.length === sb.length && sa === sb;
    }

    function diff(a, b, o) {
        var ta = tokensOf(a, o), tb = tokensOf(b, o);
        var n = Math.max(ta.length, tb.length);
        for (var i = 0; i < n; i++) {
            var x = ta[i] ? JSON.stringify(ta[i]) : "(missing)";
            var y = tb[i] ? JSON.stringify(tb[i]) : "(missing)";
            if (x !== y) return { equal: false, index: i, left: x, right: y };
        }
        return { equal: true, index: -1, left: null, right: null };
    }

    function digest(html, o) {
        var s = signature(html, o), h = 0x811c9dc5;
        for (var i = 0; i < s.length; i++) {
            h ^= s.charCodeAt(i);
            h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
        }
        return ("0000000" + h.toString(16)).slice(-8) + "-" + s.length.toString(36);
    }

    return {
        VERSION: VERSION,
        DEFAULTS: DEFAULTS,
        PROFILES: PROFILES,
        extractMarkedRegions: extractMarkedRegions,
        splitDraftAtQuote: splitDraftAtQuote,
        verifyInDraft: verifyInDraft,
        verifyRegion: verifyRegion,
        verifyExact: verifyExact,
        indexOfTokenRun: indexOfTokenRun,
        signature: signature,
        signatureFromDom: signatureFromDom,
        tokens: tokensOf,
        equal: equal,
        diff: diff,
        digest: digest,
        domParserSupportsHtml: domParserSupportsHtml,
        _internals: { decodeEntities: decodeEntities, normalizeUrl: normalizeUrl }
    };
})();

// ─────────────────────────────────────────────────────────────────────────────
//  CONFIG
// ─────────────────────────────────────────────────────────────────────────────

const AES_KEY = "fnItrY2YfozBqCC2B4XsfqHIvZku3kUOq3DFkbO64kk=";
const AES_IV = "3YapeNfJDung7TXxeKXn4g==";
const BASE_URL = "https://enterprise.cardbyte.ai/email-signature";

// The backend's one account-level refusal: HTTP 412 + PlanExpiredException.
const HTTP_PLAN_EXPIRED = 412;
const PLAN_EXPIRED_RE = /PlanExpired/i;

// A lapsed subscription invalidates the cached HTML as much as the live copy.
const PURGE_CACHE_ON_PLAN_EXPIRED = true;

// The id standing for "the user's default (non-rule) signature".
const DEFAULT_ID = "default";

// localStorage / sessionStorage keys
const K_SESSION = "cardbyte_session_id";
const K_SIG_CACHE = "cardbyte_sig_cache";
const K_SIG_CACHE_LEGACY_DEFAULT = "cardbyte_cached_signature";
const K_RULES = "cardbyte_cached_rules";
const K_RULES_TS = "cardbyte_cached_rules_ts";
const K_ACTIVE_SIG = "cardbyte_active_sig_id";
const K_ACTIVE_SIG_TS = "cardbyte_active_sig_ts";

// Item custom properties
const P_ACTIVE_SIG = "cardbyte_active_sig_id";
const P_MANUAL_SIG = "cardbyte_manual_sig_id";
const P_COMPOSE_TYPE = "cardbyte_compose_type";
const P_RECIP_SNAPSHOT = "cardbyte_recip_snapshot";
const P_ERR_STICKY = "cardbyte_err_sticky";
const P_SIG_DIGEST = "cardbyte_sig_digest";

// roamingSettings
const R_ACTIVE_SIG = "cb_active_sig";
const R_ACTIVE_SIG_TS = "cb_active_sig_ts";
const R_RULES = "cb_rules";
const R_RULES_TS = "cb_rules_ts";
const R_RULES_MAX_BYTES = 20 * 1024;

// FRESHNESS
const CACHE_TTL_MS = 5 * 60 * 1000;
const SIG_TTL_MS = CACHE_TTL_MS;
const RULES_TTL_MS = CACHE_TTL_MS;
const ACTIVE_SIG_MAX_AGE_MS = 1 * 60 * 1000;

// EVICTION
const PURGE_MS = 30 * 60 * 1000;
const SIG_PURGE_MS = PURGE_MS;
const DEFAULT_SIG_PURGE_MS = 5 * 60 * 1000;

const MAX_SIG_BYTES = 100 * 1024;

// ─────────────────────────────────────────────────────────────────────────────
//  v7.5 — SEND-TIME VERIFICATION CONFIG
// ─────────────────────────────────────────────────────────────────────────────

const SIG_MARK_ATTR = "data-cb-sig";
const TAMPER_TAG =
    `<div style="margin:0 0 6px 0;font:italic 11px Arial,Helvetica,sans-serif;color:#7a6134;">` +
    `Signature re-inserted</div>`;

const VERIFY_AT_SEND = true;
const APPEND_ON_TAMPER = false;
const REWRITE_ON_TAMPER_AT_SEND = false;

// ─────────────────────────────────────────────────────────────────────────────
//  v7.9.2 — HTML-CONTENT-SIGNATURE RESOLUTION (INLINED)
//  The module is now defined at the top of this file. getHcs() returns the
//  inlined implementation directly — no global lookup, no load-order race.
// ─────────────────────────────────────────────────────────────────────────────

let _hcs = null;

function getHcs() {
    if (_hcs) return _hcs;
    // The inlined module is available as HtmlContentSignature in this scope.
    // We use the same detection as before, but it will always succeed now.
    try {
        if (typeof HtmlContentSignature !== "undefined" && HtmlContentSignature) {
            _hcs = HtmlContentSignature;
        }
    } catch (_) { }
    return _hcs;
}

// The comparison profile, resolved through the same lazy path.
const sigProfile = () => {
    const h = getHcs();
    return h ? h.PROFILES.body : null;
};

function describeHcs() {
    const h = getHcs();
    if (h) return `loaded (${h.VERSION || "version unknown"})`;
    return "NOT LOADED — this should never happen with the inlined module";
}

let _hcsLogged = false;

function logHcsStatus(where, { always = false } = {}) {
    if (_hcsLogged && !always) return;
    _hcsLogged = true;
    const line = `html-content-signature: ${describeHcs()} [${where}]`;
    if (getHcs()) log(line); else err(line);
}

// Send budgets
const SEND_BUDGET_MS_COLD = 20_000;
const SEND_BUDGET_MS = 5_000;

const FETCH_BUDGET_MS_COLD = 8_000;
const FETCH_BUDGET_MS = 5_000;
const COMPOSE_TYPE_TIMEOUT_MS = 1_500;

const RECIPIENT_SETTLE_MS = 350;
const EMPTY_RECIP_SETTLE_MS = 400;

const X_PLATFORM_MAP = { MAC: "MAC", MOBILE: "MAC", OWA: "WINDOWS" };
const INTERNAL_REQUIRES_NO_EXTERNAL = false;
const EMPTY_RECIPIENTS_MEANS_DEFAULT = true;

// ─────────────────────────────────────────────────────────────────────────────
//  NOTIFICATION CONFIG
// ─────────────────────────────────────────────────────────────────────────────

const NOTIF_KEY = "cardbyte_sig_status";
const NOTIF_ICON = "v11.icon16";
const TASKPANE_COMMAND_ID = "v11.msgComposeOpenButton";
const NOTIF_ACTION_TEXT = "Open add-in pane";
const CLEAR_ERROR_ON_LATER_SUCCESS = false;
const STICKY_MAX_SHOWS = 3;

// ─────────────────────────────────────────────────────────────────────────────
//  LOGGING
// ─────────────────────────────────────────────────────────────────────────────

const log = (...a) => console.log("[CardByte]", ...a);
const warn = (...a) => console.warn("[CardByte]", ...a);
const err = (...a) => console.error("[CardByte]", ...a);
const since = (t0) => `${Date.now() - t0}ms`;
const timed = (label, t0) => log(`⏱ ${label}: ${since(t0)}`);

// ─────────────────────────────────────────────────────────────────────────────
//  PLATFORM
// ─────────────────────────────────────────────────────────────────────────────

let _platform = null;

function detectPlatform() {
    if (_platform) return _platform;

    const PT = typeof Office !== "undefined" ? Office.PlatformType : null;
    const d = (() => {
        try { return Office?.context?.diagnostics?.platform || null; } catch (_) { return null; }
    })();
    const ua = (() => {
        try { return (navigator?.userAgent || "").toLowerCase(); } catch (_) { return ""; }
    })();

    const uaMobile = () => {
        if (ua.includes("android")) return "mobile-android";
        if (ua.includes("iphone") || ua.includes("ipad")) return "mobile-ios";
        return null;
    };

    if (d && PT) {
        if (d === PT.iOS) return (_platform = "mobile-ios");
        if (d === PT.Android) return (_platform = "mobile-android");
        if (d === PT.Mac) return (_platform = "mac");
        if (d === PT.PC) return (_platform = "windows");
        if (d === PT.OfficeOnline) return (_platform = uaMobile() || "owa");
        if (d === PT.Universal) return (_platform = uaMobile() || "owa");
    }

    if (ua.includes("outlook-android")) return (_platform = "mobile-android");
    if (ua.includes("outlook-ios") || ua.includes("outlookmobile")) return (_platform = uaMobile() || "mobile-ios");
    const m = uaMobile();
    if (m) return (_platform = m);
    if (ua.includes("macintosh") || ua.includes("mac os x")) return (_platform = "mac");

    return (_platform = "owa");
}

const isMac = () => detectPlatform() === "mac";
const isMobile = () => detectPlatform().startsWith("mobile-");
const isColdRuntime = () => isMac() || isMobile();

let _xPlatform = null;

function getXPlatform() {
    if (_xPlatform) return _xPlatform;
    const p = detectPlatform();
    const base =
        p === "mac" ? "MAC" :
            p === "mobile-ios" ? "MAC" :
                p === "owa" ? "OWA" :
                    isMobile() ? "MAC" :
                        "WINDOWS";
    return (_xPlatform = X_PLATFORM_MAP[base] || base);
}

// ─────────────────────────────────────────────────────────────────────────────
//  ASYNC UTILITIES
// ─────────────────────────────────────────────────────────────────────────────

function withTimeout(promise, ms, label = "operation") {
    let timer;
    return Promise.race([
        Promise.resolve(promise).finally(() => clearTimeout(timer)),
        new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
        }),
    ]);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const budgetMs = () => (isColdRuntime() ? FETCH_BUDGET_MS_COLD : FETCH_BUDGET_MS);

function officeAsync(fn, { ms = COMPOSE_TYPE_TIMEOUT_MS, fallback = null, label = "office call" } = {}) {
    return new Promise((resolve) => {
        let done = false;
        const finish = (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
        const timer = setTimeout(() => { warn(`${label} timed out after ${ms}ms`); finish(fallback); }, ms);
        try {
            fn((res) => {
                if (res?.status !== Office.AsyncResultStatus.Succeeded) {
                    warn(`${label} failed:`, res?.error?.code, res?.error?.message);
                    return finish(fallback);
                }
                finish(res);
            });
        } catch (e) {
            warn(`${label} threw:`, e);
            finish(fallback);
        }
    });
}

function utf8Len(s) {
    let n = 0;
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c < 0x80) n += 1;
        else if (c < 0x800) n += 2;
        else if (c >= 0xd800 && c <= 0xdbff) { n += 4; i++; }
        else n += 3;
    }
    return n;
}

// ─────────────────────────────────────────────────────────────────────────────
//  WRITE TOKEN
// ─────────────────────────────────────────────────────────────────────────────

let _writeSeq = 0;

function beginWrite() {
    clearFailures();
    _recipCache = { seq: -1, emails: null };
    _writeSeq++;
    purgeExpiredStorage();
    return _writeSeq;
}

const isCurrent = (seq) => seq === _writeSeq;

let _lastSnapshot = "";

// ─────────────────────────────────────────────────────────────────────────────
//  NOTIFICATIONS (v7.9)
// ─────────────────────────────────────────────────────────────────────────────

const canUseInsight = () => {
    try {
        return !isMobile() &&
            Office.context.requirements?.isSetSupported("Mailbox", "1.10") === true &&
            !!Office.MailboxEnums?.ItemNotificationMessageType?.InsightMessage &&
            !!Office.MailboxEnums?.ActionType?.ShowTaskPane;
    } catch (_) { return false; }
};

let _stickyActive = false;
const _stickyShownByItem = new WeakMap();

function removeNotification(item, { force = false } = {}) {
    if (_stickyActive && !force) {
        log("removeNotification suppressed — an unacknowledged error is on the bar");
        return;
    }
    try { item?.notificationMessages?.removeAsync?.(NOTIF_KEY, () => { }); } catch (_) { }
}

function showErrorBar(item, message, { action = true, contextData = null } = {}) {
    try {
        const nm = item?.notificationMessages;
        if (typeof nm?.replaceAsync !== "function") {
            warn("notificationMessages unavailable on this item — skipping:", message);
            return;
        }

        let msg = String(message || "");
        if (!msg) return;
        if (msg.length > 150) msg = `${msg.slice(0, 147)}...`;

        const wantsAction = action && canUseInsight();

        const details = wantsAction
            ? {
                type: Office.MailboxEnums.ItemNotificationMessageType.InsightMessage,
                message: msg,
                icon: NOTIF_ICON,
                actions: [{
                    actionType: Office.MailboxEnums.ActionType.ShowTaskPane,
                    actionText: NOTIF_ACTION_TEXT,
                    commandId: TASKPANE_COMMAND_ID,
                    contextData: contextData ?? {},
                }],
            }
            : {
                type: "errorMessage",
                message: msg,
            };

        const addIt = () => {
            nm.addAsync(NOTIF_KEY, details, (r2) => {
                if (r2?.status === Office.AsyncResultStatus.Succeeded) return;
                try {
                    nm.removeAsync(NOTIF_KEY, () => {
                        nm.addAsync(NOTIF_KEY, details, (r3) => {
                            if (r3?.status === Office.AsyncResultStatus.Succeeded) return;
                            warn("notification failed:", r3?.error?.code, r3?.error?.message, details);
                            if (wantsAction) showErrorBar(item, message, { action: false });
                        });
                    });
                } catch (e) {
                    warn("notification remove/add threw:", e);
                }
            });
        };

        nm.replaceAsync(NOTIF_KEY, details, (r) => {
            if (r?.status === Office.AsyncResultStatus.Succeeded) return;
            try { addIt(); } catch (e) { warn("notification addAsync threw:", e); }
        });
    } catch (e) {
        warn("showErrorBar threw, ignoring:", e);
    }
}

async function readSticky(item) {
    const raw = await getItemProp(item, P_ERR_STICKY);
    if (!raw) return null;
    try {
        const v = JSON.parse(raw);
        return v && v.msg ? v : null;
    } catch (_) { return null; }
}

function persistSticky(item, kind, msg, shows) {
    _stickyActive = true;
    setItemProps(item, {
        [P_ERR_STICKY]: JSON.stringify({ kind, msg, shows, ts: Date.now() }),
    }).catch((e) => warn("sticky persist failed:", e));
}

async function clearSticky(item) {
    _stickyActive = false;
    if (item) _stickyShownByItem.delete(item);
    removeNotification(item, { force: true });
    try { await setItemProps(item, { [P_ERR_STICKY]: null }); }
    catch (e) { warn("sticky clear failed:", e); }
}

async function restoreStickyError(item, { show = true } = {}) {
    const s = item ? await readSticky(item) : null;
    _stickyActive = !!s;
    if (!s || !show) return;

    if (_stickyShownByItem.get(item)) return;

    const shows = Number(s.shows) || 0;
    if (shows >= STICKY_MAX_SHOWS) {
        log(`sticky error suppressed after ${shows} shows — clearing`);
        await clearSticky(item);
        return;
    }

    _stickyShownByItem.set(item, true);
    log(`re-raising the unacknowledged error bar (${s.kind}, show ${shows + 1})`);
    showErrorBar(item, s.msg, {
        action: true,
        contextData: {
            kind: s.kind,
            version: CB_VERSION,
            platform: detectPlatform(),
            restored: true,
        },
    });
    persistSticky(item, s.kind, s.msg, shows + 1);
}

// ─────────────────────────────────────────────────────────────────────────────
//  FAILURE LEDGER
// ─────────────────────────────────────────────────────────────────────────────

const FAILURES = {
    offline: {
        rank: 3, fatal: true,
        msg: "Couldn't reach the signature service. Check your connection and try again, or contact Admin.",
    },
    server: {
        rank: 3, fatal: true,
        msg: "The signature service returned an error. Please contact Admin.",
    },
    unassigned: {
        rank: 4, fatal: true,
        msg: "No signature is assigned to your account. Please contact Admin.",
    },
    too_large: {
        rank: 4, fatal: true,
        msg: "Signature exceeds the allowed size. Please contact Admin.",
    },
    write_failed: {
        rank: 4, fatal: true,
        msg: "Signature could not be applied. Please contact Admin.",
    },
    rules_offline: {
        rank: 2, fatal: false,
        msg: "Couldn't reach the signature service, so your signature rules weren't checked. Check your connection.",
    },
    rules_error: {
        rank: 2, fatal: false,
        msg: "Couldn't load your signature rules. Please contact Admin.",
    },
    plan_expired: {
        rank: 5, fatal: true,
        msg: "Your subscription plan has expired. Please contact Admin.",
    },
};

let _failure = null;
let _rulesFetchError = null;
let _reported = false;

function clearFailures() {
    _failure = null;
    _rulesFetchError = null;
    _reported = false;
}

const hasFailure = () => _failure !== null;
const wasReported = () => _reported;

function recordFailure(kind, detail = "", serverMsg = null) {
    const f = FAILURES[kind];
    if (!f) { warn("recordFailure: unknown kind", kind); return; }
    warn(`failure recorded: ${kind}${detail ? ` — ${detail}` : ""}`);
    if (!_failure || f.rank > _failure.rank) {
        _failure = { kind, ...f, msg: serverMsg || f.msg };
    }
}

const failureKindFor = (status) => (status == null ? "offline" : "server");
const noteRulesFetchError = (kind) => { _rulesFetchError = kind; };
const rulesFailureKind = () => (_rulesFetchError === "offline" ? "rules_offline" : "rules_error");

function reportOutcome(item, outcome, { action = true } = {}) {
    const ctx = (kind) => ({
        kind,
        version: CB_VERSION,
        platform: detectPlatform(),
        account: accountKey(),
        at: Date.now(),
    });

    const raise = (kind, msg) => {
        _reported = true;
        _stickyActive = true;
        if (item) _stickyShownByItem.set(item, true);
        showErrorBar(item, msg, { action, contextData: ctx(kind) });
        if (action) persistSticky(item, kind, msg, 1);
    };

    if (_failure) { raise(_failure.kind, _failure.msg); return; }
    if (outcome === "failed") { raise("write_failed", FAILURES.write_failed.msg); return; }

    if (outcome === "applied" && CLEAR_ERROR_ON_LATER_SUCCESS && _stickyActive) {
        log("later success — clearing the outstanding error");
        clearSticky(item).catch(() => { });
        return;
    }
    removeNotification(item);
}

// ─────────────────────────────────────────────────────────────────────────────
//  CRYPTO — AES-CBC via Web Crypto
// ─────────────────────────────────────────────────────────────────────────────

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
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
}

async function importAesKey(usage) {
    const keyBuffer = base64ToArrayBuffer(AES_KEY);
    if (keyBuffer.byteLength !== 16 && keyBuffer.byteLength !== 32) {
        throw new Error(`AES key must be 16 or 32 bytes, got ${keyBuffer.byteLength}`);
    }
    return crypto.subtle.importKey("raw", keyBuffer, { name: "AES-CBC" }, false, [usage]);
}

async function aesDecrypt(encryptedText) {
    if (!encryptedText) return "";
    try {
        const key = await importAesKey("decrypt");
        const iv = base64ToArrayBuffer(AES_IV);
        if (iv.byteLength !== 16) throw new Error("AES IV must be 16 bytes");
        const plain = await crypto.subtle.decrypt(
            { name: "AES-CBC", iv },
            key,
            base64ToArrayBuffer(encryptedText)
        );
        return new TextDecoder().decode(plain);
    } catch (e) {
        warn("aesDecrypt failed, returning input unchanged:", e.message);
        return encryptedText;
    }
}

let _encCache = { plain: null, cipher: null };

async function encryptEmail(email = "") {
    if (!email.trim()) return "";
    if (_encCache.plain === email) return _encCache.cipher;
    try {
        const key = await importAesKey("encrypt");
        const iv = base64ToArrayBuffer(AES_IV);
        const enc = await crypto.subtle.encrypt(
            { name: "AES-CBC", iv },
            key,
            new TextEncoder().encode(email)
        );
        const cipher = arrayBufferToBase64(enc);
        _encCache = { plain: email, cipher };
        return cipher;
    } catch (e) {
        err("encryptEmail failed:", e);
        return "";
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//  STORAGE
// ─────────────────────────────────────────────────────────────────────────────

const _mem = new Map();
let _senderEmail = "";

const accountKey = () => (_senderEmail || "unknown").replace(/[\s/\\'"]/g, "_");
const nsKey = (key) => `${key}:${accountKey()}`;

async function resolveSender(item, mailbox) {
    const profile = (() => {
        try { return String(mailbox?.userProfile?.emailAddress || "").trim().toLowerCase(); }
        catch (_) { return ""; }
    })();
    let from = "";
    if (typeof item?.from?.getAsync === "function") {
        const res = await officeAsync((cb) => item.from.getAsync(cb), { ms: budgetMs(), label: "from getAsync" });
        from = String(res?.value?.emailAddress || "").trim().toLowerCase();
    }
    const next = from || profile;
    if (next !== _senderEmail) {
        _mem.clear();
        _sigMap = null;
        _rulesParsed = { raw: null, json: null };
        _enabledCache = { src: null, list: null };
        _inFlight.clear();
        _encCache = { plain: null, cipher: null };
    }
    _senderEmail = next;
    return _senderEmail;
}

const store = {
    get(key) {
        const k = nsKey(key);
        if (_mem.has(k)) return _mem.get(k);
        try {
            const v = localStorage.getItem(k);
            if (v != null) { _mem.set(k, v); return v; }
        } catch (_) { }
        return null;
    },
    set(key, val) {
        const k = nsKey(key);
        _mem.set(k, val);
        try { localStorage.setItem(k, val); } catch (_) { }
    },
    remove(...keys) {
        keys.forEach((key) => _mem.delete(nsKey(key)));
        try { keys.forEach((key) => localStorage.removeItem(nsKey(key))); } catch (_) { }
    },
    getRaw(key) { try { return localStorage.getItem(key); } catch (_) { return null; } },
    removeRaw(key) { try { localStorage.removeItem(key); } catch (_) { } },
    getJson(key) {
        try { const v = store.get(key); return v ? JSON.parse(v) : null; } catch (_) { return null; }
    },
    setJson(key, val) {
        try { store.set(key, JSON.stringify(val)); } catch (_) { }
    },
};

const roam = {
    get(key) {
        try { return Office?.context?.roamingSettings?.get(nsKey(key)) ?? null; } catch (_) { return null; }
    },
    set(key, val) {
        try {
            const rs = Office?.context?.roamingSettings;
            if (!rs) return;
            rs.set(nsKey(key), val);
            rs.saveAsync(() => { });
        } catch (_) { }
    },
    remove(key) {
        try {
            const rs = Office?.context?.roamingSettings;
            if (!rs) return;
            rs.remove(nsKey(key));
            rs.saveAsync(() => { });
        } catch (_) { }
    },
};

function getSessionId() {
    try {
        let sid = sessionStorage.getItem(K_SESSION);
        if (!sid) {
            sid = crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36);
            sessionStorage.setItem(K_SESSION, sid);
        }
        return sid;
    } catch (_) {
        return "no-session";
    }
}

function invalidateCaches() {
    flushSigCache();
    _sigMap = null;
    _rulesParsed = { raw: null, json: null };
    _enabledCache = { src: null, list: null };
    _mem.clear();
}

// ─────────────────────────────────────────────────────────────────────────────
//  SIGNATURE HTML CACHE
// ─────────────────────────────────────────────────────────────────────────────

let _sigMap = null;
let _sigDirty = false;
let _sigFlushTimer = null;

function flushSigCache() {
    if (_sigFlushTimer) { clearTimeout(_sigFlushTimer); _sigFlushTimer = null; }
    if (!_sigDirty || !_sigMap) return;
    _sigDirty = false;
    store.setJson(K_SIG_CACHE, _sigMap);
}

function scheduleSigFlush() {
    _sigDirty = true;
    if (_sigFlushTimer) return;
    _sigFlushTimer = setTimeout(() => { _sigFlushTimer = null; flushSigCache(); }, 0);
}

const sigCache = {
    read() {
        if (_sigMap) return _sigMap;
        _sigMap = store.getJson(K_SIG_CACHE) || {};
        sigCache.migrateLegacy();
        return _sigMap;
    },

    migrateLegacy() {
        let legacy = null;
        try { legacy = store.getRaw(K_SIG_CACHE_LEGACY_DEFAULT) || store.get(K_SIG_CACHE_LEGACY_DEFAULT); } catch (_) { }
        if (!legacy) return;
        if (!_sigMap[DEFAULT_ID]) {
            _sigMap[DEFAULT_ID] = { html: legacy, ts: 0 };
            log("sig cache: migrated the legacy default key (marked stale)");
        }
        store.removeRaw(K_SIG_CACHE_LEGACY_DEFAULT);
        store.remove(K_SIG_CACHE_LEGACY_DEFAULT);
        scheduleSigFlush();
    },

    get(id, { skipTtl = false } = {}) {
        const entry = sigCache.read()[String(id)];
        if (!entry?.html) return null;
        if (skipTtl || Date.now() - entry.ts <= SIG_TTL_MS) return entry.html;
        return null;
    },

    age(id) {
        const entry = sigCache.read()[String(id)];
        return entry ? Date.now() - (entry.ts || 0) : null;
    },

    set(id, html) {
        if (!html) return;
        sigCache.read()[String(id)] = { html, ts: Date.now() };
        scheduleSigFlush();
    },

    purge() {
        let map;
        try { map = sigCache.read(); } catch (_) { return; }
        const now = Date.now();
        let n = 0;
        for (const id of Object.keys(map)) {
            const ceiling = id === DEFAULT_ID ? DEFAULT_SIG_PURGE_MS : SIG_PURGE_MS;
            if (now - (map[id]?.ts || 0) > ceiling) { delete map[id]; n++; }
        }
        if (n) { scheduleSigFlush(); log(`purged ${n} expired signature cache entr${n === 1 ? "y" : "ies"}`); }
    },

    wipe() {
        _sigMap = {};
        _sigDirty = false;
        if (_sigFlushTimer) { clearTimeout(_sigFlushTimer); _sigFlushTimer = null; }
        store.remove(K_SIG_CACHE, K_SIG_CACHE_LEGACY_DEFAULT);
        log("signature cache wiped");
    },
};

// ─────────────────────────────────────────────────────────────────────────────
//  RULES CACHE
// ─────────────────────────────────────────────────────────────────────────────

let _rulesParsed = { raw: null, json: null };

function parseRules(raw) {
    if (!raw) return null;
    if (_rulesParsed.raw === raw) return _rulesParsed.json;
    try {
        const json = JSON.parse(raw);
        _rulesParsed = { raw, json };
        return json;
    } catch (_) { return null; }
}

function readRoamedRules({ skipTtl = false } = {}) {
    try {
        const raw = roam.get(R_RULES);
        if (!raw) return null;
        const ts = parseInt(roam.get(R_RULES_TS) || "0", 10);
        if (!skipTtl && (!ts || Date.now() - ts > RULES_TTL_MS)) {
            log(`roamed rules stale (age=${ts ? Date.now() - ts : "unknown"}ms)`);
            return null;
        }
        return parseRules(raw);
    } catch (_) { return null; }
}

function getCachedRules({ skipTtl = false } = {}) {
    const ts = parseInt(store.get(K_RULES_TS) || "0", 10);
    if (skipTtl || (ts && Date.now() - ts <= RULES_TTL_MS)) {
        const local = parseRules(store.get(K_RULES));
        if (local) return local;
    } else if (ts) {
        log(`rules cache stale (age=${Date.now() - ts}ms)`);
    }
    return readRoamedRules({ skipTtl });
}

function setCachedRules(rulesJson) {
    let s = null;
    try { s = JSON.stringify(rulesJson); } catch (_) { }
    if (s == null) return;

    store.set(K_RULES, s);
    store.set(K_RULES_TS, Date.now().toString());
    _rulesParsed = { raw: s, json: rulesJson };

    try {
        if (s.length <= R_RULES_MAX_BYTES) {
            roam.set(R_RULES, s);
            roam.set(R_RULES_TS, Date.now().toString());
        } else {
            roam.remove(R_RULES);
            roam.remove(R_RULES_TS);
            warn(`rulesJson too large to roam (${s.length}B) — cold runtimes will fetch live`);
        }
    } catch (_) { }
}

function clearRulesCache() {
    store.remove(K_RULES, K_RULES_TS);
    roam.remove(R_RULES);
    roam.remove(R_RULES_TS);
    _rulesParsed = { raw: null, json: null };
    _enabledCache = { src: null, list: null };
}

function describeRulesSource() {
    const ts = parseInt(store.get(K_RULES_TS) || "0", 10);
    if (store.get(K_RULES)) return `local (age=${ts ? Date.now() - ts : "?"}ms)`;
    const rts = parseInt(roam.get(R_RULES_TS) || "0", 10);
    if (roam.get(R_RULES)) return `roamed (age=${rts ? Date.now() - rts : "unknown"}ms)`;
    return "none";
}

function purgeExpiredStorage() {
    const now = Date.now();
    const tsOf = (v) => parseInt(v || "0", 10);
    const expired = (ts) => !ts || now - ts > PURGE_MS;

    sigCache.purge();

    try {
        if (store.get(K_RULES) && expired(tsOf(store.get(K_RULES_TS)))) {
            store.remove(K_RULES, K_RULES_TS);
            _rulesParsed = { raw: null, json: null };
            _enabledCache = { src: null, list: null };
            log("purged the local rules cache");
        }
        if (roam.get(R_RULES) && expired(tsOf(roam.get(R_RULES_TS)))) {
            roam.remove(R_RULES);
            roam.remove(R_RULES_TS);
            log("purged the roamed rules cache");
        }
        if (store.get(K_ACTIVE_SIG) && expired(tsOf(store.get(K_ACTIVE_SIG_TS)))) {
            store.remove(K_ACTIVE_SIG, K_ACTIVE_SIG_TS);
            log("purged the local active signature id");
        }
        if (roam.get(R_ACTIVE_SIG) && expired(tsOf(roam.get(R_ACTIVE_SIG_TS)))) {
            roam.remove(R_ACTIVE_SIG);
            roam.remove(R_ACTIVE_SIG_TS);
            log("purged the roamed active signature id");
        }
    } catch (e) {
        warn("purgeExpiredStorage threw, ignoring:", e);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//  ITEM CUSTOM PROPERTIES
// ─────────────────────────────────────────────────────────────────────────────

const _propsByItem = new WeakMap();

function getProps(item, { fresh = false } = {}) {
    if (fresh) _propsByItem.delete(item);
    if (_propsByItem.has(item)) return _propsByItem.get(item);
    const p = officeAsync((cb) => item.loadCustomPropertiesAsync(cb), {
        ms: budgetMs(),
        label: "loadCustomPropertiesAsync",
    }).then((res) => res?.value ?? null);
    _propsByItem.set(item, p);
    return p;
}

function invalidateProps(item) { if (item) _propsByItem.delete(item); }

async function getItemProp(item, key) {
    try {
        const v = (await getProps(item))?.get(key);
        return v == null ? null : String(v);
    } catch (_) { return null; }
}

async function setItemProps(item, kv) {
    const props = await getProps(item, { fresh: true });
    if (!props) return false;
    try {
        for (const [k, v] of Object.entries(kv)) {
            if (v == null) props.remove(k);
            else props.set(k, String(v));
        }
        const res = await officeAsync((cb) => props.saveAsync(cb), {
            ms: budgetMs(),
            label: "customProps saveAsync",
        });
        return !!res;
    } catch (e) {
        warn("setItemProps threw:", e);
        return false;
    }
}

async function getManualOverride(item) {
    const raw = await getItemProp(item, P_MANUAL_SIG);
    const s = raw == null ? "" : String(raw).trim();
    if (s === "" || s === "null" || s === "undefined") {
        if (s !== "") warn("ignoring an unresolvable manual override:", s);
        return null;
    }
    return s;
}

// ─────────────────────────────────────────────────────────────────────────────
//  ACTIVE SIGNATURE ID (+ recipient snapshot)
// ─────────────────────────────────────────────────────────────────────────────

async function markActiveSignature(item, id, snapshot = null, digest = null) {
    if (id == null) {
        store.remove(K_ACTIVE_SIG, K_ACTIVE_SIG_TS);
        roam.remove(R_ACTIVE_SIG);
        roam.remove(R_ACTIVE_SIG_TS);
    } else {
        store.set(K_ACTIVE_SIG, String(id));
        store.set(K_ACTIVE_SIG_TS, Date.now().toString());
        roam.set(R_ACTIVE_SIG, String(id));
        roam.set(R_ACTIVE_SIG_TS, Date.now().toString());
    }
    if (!item) return;

    const kv = {
        [P_ACTIVE_SIG]: id == null ? null : String(id),
        [P_RECIP_SNAPSHOT]: id == null ? null : snapshot,
    };
    if (id == null) kv[P_SIG_DIGEST] = null;
    else if (digest != null) kv[P_SIG_DIGEST] = String(digest);

    await setItemProps(item, kv);
}

async function getActiveSignatureId(item = null, { allowRoam = true } = {}) {
    if (item) {
        const fromItem = await getItemProp(item, P_ACTIVE_SIG);
        if (fromItem) return fromItem;
    }
    const id = store.get(K_ACTIVE_SIG);
    if (id) {
        const ts = parseInt(store.get(K_ACTIVE_SIG_TS) || "0", 10);
        if (!ts || Date.now() - ts <= ACTIVE_SIG_MAX_AGE_MS) return id;
    }
    if (!allowRoam) return null;
    const roamed = roam.get(R_ACTIVE_SIG);
    if (roamed) warn("falling back to the ROAMED active id — may belong to another device");
    return roamed ? String(roamed) : null;
}

// ─────────────────────────────────────────────────────────────────────────────
//  API
// ─────────────────────────────────────────────────────────────────────────────

function apiUrl(path) {
    return `${BASE_URL}${path}${path.indexOf("?") === -1 ? "?" : "&"}_=${Date.now()}`;
}

function apiHeaders(encryptedMail, extra = {}) {
    return { username: encryptedMail, "X-Platform": getXPlatform(), ...extra };
}

const apiInit = (encryptedMail, extra) => ({
    method: "GET",
    cache: "no-store",
    headers: apiHeaders(encryptedMail, extra),
});

function serverMessage(raw) {
    const s = String(raw || "").trim();
    if (!s) return null;
    if (/^[\w$]+(\.[\w$]+){2,}$/.test(s)) return null;
    return s.length <= 150 ? s : null;
}

async function readApiError(res) {
    let body = null;
    try { body = JSON.parse(await res.text()); } catch (_) { }
    const message = serverMessage(body?.message);
    const planExpired =
        res.status === HTTP_PLAN_EXPIRED || PLAN_EXPIRED_RE.test(String(body?.error || ""));
    return { message, planExpired, raw: String(body?.message || body?.error || "") };
}

async function fetchRules(encryptedMail) {
    const xp = getXPlatform();
    try {
        const res = await fetch(
            apiUrl("/rules-config/get-active"),
            apiInit(encryptedMail, { "Content-Type": "application/json" })
        );
        if (!res.ok) {
            const { message, planExpired, raw } = await readApiError(res);
            warn(`rules fetch returned ${res.status} (X-Platform=${xp})`, raw);
            if (planExpired) {
                recordFailure("plan_expired", "rules-config", message);
            }
            noteRulesFetchError(planExpired ? "server" : failureKindFor(res.status));
            return null;
        }
        const rulesJson = JSON.parse(await res.text())?.rulesJson;
        if (!rulesJson) {
            warn("rules response had no rulesJson");
            noteRulesFetchError("server");
            return null;
        }
        setCachedRules(rulesJson);
        log(`rulesJson fetched and cached (${(rulesJson.rulesList || []).length} rule(s), X-Platform=${xp})`);
        return rulesJson;
    } catch (e) {
        err(`fetchRules failed (X-Platform=${xp}):`, e);
        noteRulesFetchError("offline");
        return null;
    }
}

async function fetchDefaultSignature(encryptedMail) {
    const xp = getXPlatform();
    try {
        const res = await fetch(apiUrl("/html/outlook/get-active"), apiInit(encryptedMail));
        if (!res.ok) {
            const { message, planExpired, raw } = await readApiError(res);
            warn(`default signature fetch failed: ${res.status} (X-Platform=${xp})`, raw);
            if (planExpired) {
                return { html: null, explicit: false, failure: "plan_expired", failureMsg: message };
            }
            const notFound = res.status === 404 || /not\s*found/i.test(raw);
            return {
                html: null,
                explicit: notFound,
                failure: notFound ? null : failureKindFor(res.status),
                failureMsg: null,
            };
        }
        let html = null;
        try {
            html = JSON.parse(await aesDecrypt(await res.text()))?.html || null;
        } catch (e) {
            warn("default signature response unreadable:", e.message);
            return { html: null, explicit: false, failure: "server", failureMsg: null };
        }
        return { html, explicit: true, failure: null, failureMsg: null };
    } catch (e) {
        warn(`fetchDefaultSignature crashed (X-Platform=${xp}):`, e);
        return { html: null, explicit: false, failure: "offline", failureMsg: null };
    }
}

async function fetchSignatureById(id, encryptedMail) {
    try {
        const res = await fetch(
            apiUrl(`/rules-config/get/${encodeURIComponent(id)}`),
            apiInit(encryptedMail)
        );
        if (!res.ok) {
            const { message, planExpired, raw } = await readApiError(res);
            err(`signature fetch failed id=${id}: ${res.status} (X-Platform=${getXPlatform()})`, raw);
            if (planExpired) {
                return { html: null, explicit: false, failure: "plan_expired", failureMsg: message };
            }
            const notFound = res.status === 404;
            return {
                html: null,
                explicit: notFound,
                failure: notFound ? null : failureKindFor(res.status),
                failureMsg: null,
            };
        }
        let html = null;
        try {
            html = JSON.parse(await aesDecrypt(await res.text()))?.html || null;
        } catch (e) {
            warn(`signature response unreadable id=${id}:`, e.message);
            return { html: null, explicit: false, failure: "server", failureMsg: null };
        }
        if (!html) warn("signature HTML empty for id:", id);
        return { html, explicit: true, failure: null, failureMsg: null };
    } catch (e) {
        err(`fetchSignatureById crashed id=${id}:`, e);
        return { html: null, explicit: false, failure: "offline", failureMsg: null };
    }
}

const _inFlight = new Map();

function dedupe(key, make) {
    const existing = _inFlight.get(key);
    if (existing) { log(`joining in-flight fetch: ${key}`); return existing; }
    const p = make().finally(() => _inFlight.delete(key));
    _inFlight.set(key, p);
    return p;
}

async function resolveSigHtml(id, userEmail, { allowNetwork = true, budgetMs: budget = null, silent = false } = {}) {
    const key = String(id);
    const ms = budget ?? budgetMs();
    const fail = (kind, detail, msg = null) => { if (!silent) recordFailure(kind, detail, msg); };

    if (!key || key === "null" || key === "undefined") {
        warn("resolveSigHtml called with a non-id — refusing to fetch:", key);
        fail("server", `non-id "${key}"`);
        return { html: null, source: "none", unassigned: false };
    }

    const fresh = sigCache.get(key);
    if (fresh) return { html: fresh, source: "cache", unassigned: false };

    const stale = sigCache.get(key, { skipTtl: true });
    if (stale) log(`id=${key} cache stale (age=${sigCache.age(key)}ms) — refreshing`);

    const fallback = (unassigned = false) => {
        if (stale) {
            warn(`serving the STALE cached copy of id=${key} (age=${sigCache.age(key)}ms)`);
            return { html: stale, source: "cache-stale", unassigned: false };
        }
        if (key !== DEFAULT_ID) {
            const def = sigCache.get(DEFAULT_ID, { skipTtl: true });
            if (def) {
                warn(`id=${key} unresolved — injecting the cached DEFAULT signature instead`);
                return { html: def, source: "cache-stale", unassigned, fellBackToDefault: true };
            }
        }
        return { html: null, source: "none", unassigned };
    };

    if (!allowNetwork || !userEmail) {
        warn(`cannot resolve id=${key} (allowNetwork=${allowNetwork}, user=${!!userEmail})`);
        fail("offline", "no network permitted or no user email");
        return fallback();
    }

    try {
        const enc = await encryptEmail(userEmail);
        const inner = dedupe(`sig:${String(userEmail).toLowerCase()}:${key}`, () => (
            key === DEFAULT_ID ? fetchDefaultSignature(enc) : fetchSignatureById(key, enc)
        ).then((r) => {
            if (r.html) sigCache.set(key, r.html);
            return r;
        }));

        const { html, explicit, failure, failureMsg } = await withTimeout(
            inner, ms, key === DEFAULT_ID ? "default fetch" : `sig fetch ${key}`);

        if (html) return { html, source: "network", unassigned: false };

        if (failure === "plan_expired") {
            fail("plan_expired", `id=${key}`, failureMsg);
            if (PURGE_CACHE_ON_PLAN_EXPIRED) { sigCache.wipe(); clearRulesCache(); }
            return { html: null, source: "none", unassigned: false, planExpired: true };
        }

        if (explicit) {
            fail("unassigned", `id=${key}`);
            return fallback(true);
        }
        fail(failure || "server", `id=${key}`);
        return fallback();
    } catch (e) {
        warn(`resolveSigHtml failed id=${key}:`, e.message);
        fail("offline", `id=${key} ${e.message}`);
        return fallback();
    }
}

async function revalidateSigHtml(id, userEmail, appliedHtml) {
    const key = String(id);
    try {
        const enc = await encryptEmail(userEmail);
        const { html } = await dedupe(`sig:${String(userEmail).toLowerCase()}:${key}`, () => (
            key === DEFAULT_ID ? fetchDefaultSignature(enc) : fetchSignatureById(key, enc)
        ).then((r) => { if (r.html) sigCache.set(key, r.html); return r; }));
        if (!html) return null;
        return html === appliedHtml ? null : html;
    } catch (e) {
        warn(`revalidate failed id=${key}:`, e.message);
        return null;
    }
}

async function prefetchSignatures(userEmail, { includeRules = true } = {}) {
    const ids = new Set([DEFAULT_ID]);

    if (includeRules) {
        const rulesJson = getCachedRules({ skipTtl: true });
        for (const r of enabledRulesWithSignatures(rulesJson)) ids.add(String(r.signatureId));
    }

    const missing = [...ids].filter((id) => !sigCache.get(id));
    if (!missing.length) return;
    log(`prefetching ${missing.length} signature(s):`, missing.join(", "));
    await Promise.allSettled(missing.map((id) => resolveSigHtml(id, userEmail, { silent: true })));
    flushSigCache();
}

// ─────────────────────────────────────────────────────────────────────────────
//  RECIPIENTS
// ─────────────────────────────────────────────────────────────────────────────

async function getRecipients(field) {
    const res = await officeAsync((cb) => field.getAsync(cb), {
        ms: budgetMs(),
        label: "recipients getAsync",
    });
    return res ? (res.value || []) : null;
}

async function getAllRecipientEmails(item) {
    if (!item?.to?.getAsync) return null;

    const [to, cc] = await Promise.all([
        getRecipients(item.to),
        item.cc?.getAsync ? getRecipients(item.cc) : Promise.resolve([]),
    ]);

    if (to === null) return null;
    if (cc === null) warn("cc read failed — evaluating against To only");

    return [...new Set(
        [...to, ...(cc || [])].map((r) => (r.emailAddress || "").toLowerCase().trim()).filter(Boolean)
    )];
}

let _recipCache = { seq: -1, emails: null };

async function readRecipientEmails(item, { force = false } = {}) {
    if (!force && _recipCache.seq === _writeSeq && _recipCache.emails !== null) {
        return _recipCache.emails;
    }

    let emails = await getAllRecipientEmails(item);
    if ((emails === null || emails.length === 0) && isColdRuntime()) {
        await sleep(400);
        const retry = await getAllRecipientEmails(item);
        if (retry !== null) emails = retry;
    }

    if (emails !== null) _recipCache = { seq: _writeSeq, emails };
    return emails;
}

const serializeRecipients = (emails) => (emails === null ? null : [...emails].sort().join(","));

// ─────────────────────────────────────────────────────────────────────────────
//  COMPOSE TYPE
// ─────────────────────────────────────────────────────────────────────────────

const _composeTypeByItem = new WeakMap();
const REPLY_PREFIX_RE = /^\s*(re|aw|sv|vs|antw|res|ref|fw|fwd|wg|tr|vb|rv|enc|odp|доб|回复|转发)\s*(\[\d+\])?\s*:/i;

async function detectComposeType(item, strict) {
    const res = await officeAsync((cb) => item.getComposeTypeAsync(cb), {
        label: "getComposeTypeAsync",
    });
    const raw = String(res?.value?.composeType || "").toLowerCase();
    log("getComposeTypeAsync raw =", JSON.stringify(raw));

    if (raw === "reply" || raw === "replyall" || raw === "forward") return "reply";
    if (raw === "newmail") return "compose";

    const subjRes = await officeAsync((cb) => item.subject.getAsync(cb), { label: "subject getAsync" });
    const subject = String(subjRes?.value || "");

    if (REPLY_PREFIX_RE.test(subject)) {
        log("composeType inferred 'reply' from subject prefix");
        return "reply";
    }
    if (!strict && subject.trim() !== "") return "compose";

    return null;
}

async function getComposeType(item, { strict = false, persist = false } = {}) {
    if (_composeTypeByItem.has(item)) return _composeTypeByItem.get(item);

    const fromProp = await getItemProp(item, P_COMPOSE_TYPE);
    if (fromProp === "compose" || fromProp === "reply") {
        log("composeType from item props:", fromProp);
        _composeTypeByItem.set(item, fromProp);
        return fromProp;
    }

    const t = await detectComposeType(item, strict);
    const authoritative = t !== null;

    if (!t && !strict) {
        warn("composeType undetermined — assuming 'compose' for this call only (not cached)");
        return "compose";
    }
    if (t && authoritative) {
        _composeTypeByItem.set(item, t);
        if (persist) await setItemProps(item, { [P_COMPOSE_TYPE]: t });
    }
    return t;
}

// ─────────────────────────────────────────────────────────────────────────────
//  RULE MATCHING
// ─────────────────────────────────────────────────────────────────────────────

function getDomain(email) {
    const at = (email || "").lastIndexOf("@");
    return at === -1 ? "" : email.slice(at + 1).toLowerCase();
}

let _enabledCache = { src: null, list: null };

function enabledRulesWithSignatures(rulesJson) {
    if (!rulesJson) return [];
    if (_enabledCache.src === rulesJson) return _enabledCache.list;

    const all = (rulesJson.rulesList || []).filter((r) => r && r.enabled);
    const usable = [];
    const dropped = [];
    for (const r of all) {
        if (r.signatureId != null && String(r.signatureId).trim() !== "") usable.push(r);
        else dropped.push(r.rule ?? r.priority);
    }
    if (dropped.length) {
        warn(`${dropped.length} enabled rule(s) have no signatureId — ignored`, dropped);
    }
    usable.sort((a, b) => (Number(a.priority) || 0) - (Number(b.priority) || 0));

    _enabledCache = { src: rulesJson, list: usable };
    return usable;
}

function recipientTypeMatches(recipientType, hasInternal, hasExternal) {
    const rt = (recipientType || "").toLowerCase().trim();
    if (!rt || rt === "all") return true;
    if (rt === "internal") return INTERNAL_REQUIRES_NO_EXTERNAL ? hasInternal && !hasExternal : hasInternal;
    if (rt === "external") return hasExternal;
    return true;
}

function isContextAgnostic(rule) {
    const rc = (rule?.context || "").toLowerCase().trim();
    return !rc || rc === "all";
}

function contextMatches(ruleContext, composeType) {
    const rc = (ruleContext || "").toLowerCase().trim();
    if (!rc || rc === "all") return true;
    if (!composeType) return false;
    return rc === composeType.toLowerCase();
}

function senderEntryAddress(entry) {
    if (entry == null) return "";
    if (typeof entry === "string") return entry.trim().toLowerCase();
    if (typeof entry === "object") {
        const v = entry.email ?? entry.emailAddress ?? entry.address ??
            entry.smtpAddress ?? entry.userPrincipalName ?? entry.upn ?? "";
        return String(v).trim().toLowerCase();
    }
    return String(entry).trim().toLowerCase();
}

function senderMatches(rule, senderEmail) {
    const raw = rule?.Senders;
    let list = null;
    if (Array.isArray(raw)) list = raw;
    else if (typeof raw === "string" && raw.trim() !== "") list = [raw];
    else if (raw != null && typeof raw === "object") list = [raw];

    if (!list || list.length === 0) return true;

    const sender = (senderEmail || "").toLowerCase().trim();
    const senderDomain = getDomain(sender);

    const matched = list.some((entry) => {
        const s = senderEntryAddress(entry);
        if (!s) return false;
        if (s === "*" || s === "all") return true;
        if (s.startsWith("*@")) return !!senderDomain && sender.endsWith(s.slice(1));
        if (s.startsWith("@")) return !!senderDomain && sender.endsWith(s);
        if (!s.includes("@")) return !!senderDomain && s === senderDomain;
        return s === sender;
    });

    return matched;
}

async function findMatchingRule(item, senderEmail, {
    allowNetwork = false,
    budgetMs: budget = null,
    strictComposeType = false,
    persistComposeType = false,
} = {}) {
    const ms = budget ?? budgetMs();

    let rulesJson = getCachedRules({ skipTtl: strictComposeType });
    let source = rulesJson ? describeRulesSource() : "none";

    if (!rulesJson && allowNetwork && senderEmail) {
        warn("rules not cached — live fetch");
        const enc = await encryptEmail(senderEmail);
        rulesJson = await withTimeout(fetchRules(enc), ms, "rules fetch")
            .catch((e) => { warn("rules fetch timed out:", e.message); noteRulesFetchError("offline"); return null; });
        source = rulesJson ? "network" : "none";
    }
    if (!rulesJson) {
        warn("no rules available");
        recordFailure(rulesFailureKind(), "rule evaluation could not run");
        return { rule: null, blocked: true };
    }

    const emails = await readRecipientEmails(item);

    if (emails === null) {
        warn("recipient list unreadable — refusing to evaluate");
        return { rule: null, blocked: true };
    }
    if (emails.length === 0) {
        if (EMPTY_RECIPIENTS_MEANS_DEFAULT) {
            log("no recipients — default applies (EMPTY_RECIPIENTS_MEANS_DEFAULT)");
            if (persistComposeType) getComposeType(item, { persist: true }).catch(() => { });
            return { rule: null, blocked: false };
        }
        log("no recipients — evaluating as an empty recipient set");
    }

    const senderDomain = getDomain(senderEmail);
    let hasInternal = false;
    let hasExternal = false;
    const domains = [];
    for (const e of emails) {
        const d = getDomain(e);
        if (d && !domains.includes(d)) domains.push(d);
        if (senderDomain && d === senderDomain) hasInternal = true;
        else hasExternal = true;
    }

    const rules = enabledRulesWithSignatures(rulesJson);

    const candidates = rules.filter(
        (r) => senderMatches(r, senderEmail) && recipientTypeMatches(r.recipientType, hasInternal, hasExternal)
    );

    log("rule evaluation:", {
        version: CB_VERSION,
        platform: detectPlatform(),
        xPlatform: getXPlatform(),
        rulesSource: source,
        strict: strictComposeType,
        senderDomain,
        recipients: emails.length,
        hasInternal,
        hasExternal,
        domains,
        rules: rules.length,
        candidates: candidates.length,
    });

    if (!candidates.length) {
        log("no rule can match this recipient set — default applies");
        if (persistComposeType) {
            getComposeType(item, { persist: true }).catch(() => { });
        }
        return { rule: null, blocked: false };
    }

    const composeType = await getComposeType(item, {
        strict: strictComposeType,
        persist: persistComposeType,
    });

    if (strictComposeType && !composeType) {
        const top = candidates[0];
        if (isContextAgnostic(top)) {
            log(`composeType unknown but top candidate is context-agnostic — matching priority=${top.priority}`);
            return { rule: top, blocked: false };
        }
        warn("composeType unknown at send and the top candidate is context-scoped — cannot decide");
        return { rule: null, blocked: true };
    }

    for (const r of candidates) {
        const c = contextMatches(r.context, composeType);
        if (c) return { rule: r, blocked: false };
    }

    log("no rule matched — default applies");
    return { rule: null, blocked: false };
}

// ─────────────────────────────────────────────────────────────────────────────
//  SIGNATURE VERIFICATION (v7.5) — NOW USING INLINED MODULE
// ─────────────────────────────────────────────────────────────────────────────

function escAttr(v) {
    return String(v)
        .replace(/&/g, "&amp;")
        .replace(/"/g, "&quot;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

const wrapSignature = (html, id) => `<div ${SIG_MARK_ATTR}="${escAttr(id)}">${html}</div>`;

let _digestCache = { html: null, digest: null };

function sigDigest(html) {
    const hcs = getHcs();
    if (!hcs || html == null) return null;
    if (_digestCache.html === html) return _digestCache.digest;
    let d = null;
    try { d = hcs.digest(html, sigProfile()); } catch (e) { warn("digest failed:", e); return null; }
    _digestCache = { html, digest: d };
    return d;
}

async function readBodyHtml(item) {
    if (typeof item?.body?.getAsync !== "function") return null;
    const res = await officeAsync(
        (cb) => item.body.getAsync(Office.CoercionType.Html, cb),
        { ms: budgetMs(), label: "body getAsync" }
    );
    return res ? String(res.value ?? "") : null;
}

async function verifySignatureOnBody(item, expectedHtml, id) {
    if (!VERIFY_AT_SEND) return { verdict: "unknown", reason: "verification disabled", note: "" };

    const hcs = getHcs();
    if (!hcs) {
        // With the inlined module, this should never happen, but we keep the
        // check for safety. If it does fire, it means the inlining broke.
        logHcsStatus("verifySignatureOnBody", { always: true });
        return { verdict: "unknown", reason: "signature module not loaded", note: "" };
    }

    const body = await readBodyHtml(item);
    if (body === null) return { verdict: "unknown", reason: "body unreadable on this host", note: "" };

    let note = "";
    try {
        const prev = await getItemProp(item, P_SIG_DIGEST);
        if (prev && prev !== sigDigest(expectedHtml)) {
            note = "expected copy changed since compose (server-side update, not an edit)";
        }
    } catch (_) { }

    try {
        const opt = { ...sigProfile(), markAttr: SIG_MARK_ATTR, sigId: id };
        const marked = hcs.extractMarkedRegions(body, SIG_MARK_ATTR);
        if (!marked.length) {
            const split = hcs.splitDraftAtQuote(body);
            const scope = split.boundary < body.length ? "live-of-reply" : "whole-body";
            const rr = hcs.verifyRegion(expectedHtml, split.live, opt);
            return { verdict: rr.verdict, reason: `${scope}: marker-free token match`, note };
        }
        const r = hcs.verifyInDraft(expectedHtml, body, opt);
        if (r.verdict === "modified" && !REWRITE_ON_TAMPER_AT_SEND) {
            warn(`send verify: marked block present but modified (${r.scope}) — tolerated, not rewriting`);
            return { verdict: "identical", reason: `${r.scope}: marked block present, edit tolerated`, note };
        }
        return { verdict: r.verdict, reason: `${r.scope}: ${r.reason}`, note };
    } catch (e) {
        warn("verifyInDraft threw:", e);
        return { verdict: "unknown", reason: `comparison failed: ${e.message}`, note };
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//  BODY WRITES
// ─────────────────────────────────────────────────────────────────────────────

const hostCanSetSignature = (item) => typeof item?.body?.setSignatureAsync === "function";

async function writeSignature(item, html, { isSendTime = false, silent = false, sigId = null } = {}) {
    const fail = (kind, detail) => { if (!silent) recordFailure(kind, detail); };

    const payload = sigId == null ? html : wrapSignature(html, sigId);

    const bytes = utf8Len(payload);
    if (bytes > MAX_SIG_BYTES) {
        warn(`signature ${bytes}B exceeds ${MAX_SIG_BYTES}B — not applying`);
        fail("too_large", `${bytes}B > ${MAX_SIG_BYTES}B`);
        return false;
    }

    if (hostCanSetSignature(item)) {
        const res = await officeAsync(
            (cb) => item.body.setSignatureAsync(payload, { coercionType: Office.CoercionType.Html }, cb),
            { ms: budgetMs(), label: "setSignatureAsync" }
        );
        if (res) { log(`signature written (${bytes}B)`); return true; }
    } else if (!isSendTime) {
        log("setSignatureAsync unavailable at compose on this host — deferring the write to send");
        return false;
    } else {
        warn("setSignatureAsync unavailable on this host");
    }

    if (isSendTime && typeof item.body?.appendOnSendAsync === "function") {
        const res = await officeAsync(
            (cb) => item.body.appendOnSendAsync(payload, { coercionType: Office.CoercionType.Html }, cb),
            { ms: budgetMs(), label: "appendOnSendAsync" }
        );
        if (res) { log("signature appended via appendOnSendAsync"); return true; }
    }

    fail("write_failed", isSendTime ? "setSignatureAsync/appendOnSendAsync" : "setSignatureAsync");
    return false;
}

async function applyById(item, id, userEmail, seq, { revalidate = false, isSendTime = false } = {}) {
    const key = String(id);
    const t0 = Date.now();
    const nothing = (status) => ({ applied: false, status, verdict: null, digest: null });

    if (!isSendTime && !hostCanSetSignature(item)) {
        log(`host cannot write at compose — id=${key} decided but not applied yet`);
        return nothing("deferred");
    }

    if (!isSendTime) {
        const activeNow = await getItemProp(item, P_ACTIVE_SIG);
        if (activeNow && String(activeNow) === key) {
            log(`compose: id=${key} already applied — no rewrite`);
            timed(`applyById (${key}, already-applied)`, t0);
            return { applied: true, status: "unchanged", verdict: null, digest: null };
        }
    }

    const { html, source, unassigned } = await resolveSigHtml(key, userEmail, {
        budgetMs: isSendTime ? budgetMs() : 10_000,
    });

    if (!html) {
        warn(`could not resolve id=${key} (unassigned=${unassigned}) — leaving body as-is`);
        if (!hasFailure()) recordFailure("offline", `unresolved id=${key}`);
        return nothing("failed");
    }
    if (!isCurrent(seq)) { log(`stale write dropped (seq=${seq}, current=${_writeSeq})`); return nothing("stale"); }

    const digest = sigDigest(html);
    let sendVerdict = null;

    if (isSendTime) {
        const v = await verifySignatureOnBody(item, html, key);
        sendVerdict = v.verdict;
        log(`send verify id=${key}: ${v.verdict} (${v.reason})${v.note ? ` — ${v.note}` : ""}`);

        if (v.verdict === "identical") {
            log("draft signature matches — leaving the body untouched");
            timed(`applyById (${key}, unchanged)`, t0);
            return { applied: true, status: "unchanged", verdict: v.verdict, digest };
        }

        const somethingIsThere = v.verdict === "modified" || v.verdict === "duplicate" || v.verdict === "id-changed";
        if (somethingIsThere && !hostCanSetSignature(item) && !APPEND_ON_TAMPER) {
            warn(`verdict=${v.verdict} but this host can only append — not duplicating the signature`);
            timed(`applyById (${key}, detected-only)`, t0);
            return { applied: true, status: "detected", verdict: v.verdict, digest };
        }
        if (!isCurrent(seq)) { log("stale write dropped after verification"); return nothing("stale"); }
    }

    const ok = await writeSignature(item, html, { isSendTime, sigId: key });
    if (!ok) return nothing("failed");
    log(`applied id=${key} from ${source} in ${since(t0)}`);

    if (revalidate && source !== "network" && userEmail && !isSendTime) {
        revalidateSigHtml(key, userEmail, html).then(async (fresh) => {
            if (!fresh || !isCurrent(seq)) return;
            log(`id=${key} changed on server — rewriting`);
            await writeSignature(item, fresh, { silent: true, sigId: key });
        }).catch(() => { });
    }
    return { applied: true, status: "written", verdict: sendVerdict, digest };
}

// ─────────────────────────────────────────────────────────────────────────────
//  THE SINGLE DECISION PATH
// ─────────────────────────────────────────────────────────────────────────────

async function persistDecision(item, id, snapshot, digest) {
    const [curId, curSnap] = await Promise.all([
        getItemProp(item, P_ACTIVE_SIG),
        getItemProp(item, P_RECIP_SNAPSHOT),
    ]);
    const sameId = curId != null && String(curId) === String(id);
    const sameSnap = snapshot === null ? curSnap === null : curSnap === snapshot;
    if (sameId && sameSnap && digest == null) {
        log("decision unchanged — skipping customProps write");
        return;
    }
    await markActiveSignature(item, id, snapshot, digest);
}

async function evaluateAndApply(item, mailbox, seq, { allowNetwork = true } = {}) {
    const t0 = Date.now();
    const userEmail = _senderEmail || mailbox?.userProfile?.emailAddress;

    const override = await getManualOverride(item);
    if (override) {
        const activeNow = await getItemProp(item, P_ACTIVE_SIG);
        if (activeNow && String(activeNow) === String(override)) {
            log("manual override active and already on the body:", override);
            return;
        }
        log("manual override active but body state unknown — reapplying:", override);
        const rOv = await applyById(item, override, userEmail, seq, { revalidate: false });
        if (rOv.applied && isCurrent(seq)) {
            await markActiveSignature(item, override, null, rOv.digest);
        }
        if (isCurrent(seq)) {
            reportOutcome(item, rOv.applied ? "applied" : rOv.status === "deferred" ? "quiet" : "failed");
        }
        return;
    }

    const { rule, blocked } = await findMatchingRule(item, userEmail, {
        allowNetwork,
        persistComposeType: true,
    });

    if (blocked) {
        const active = await getItemProp(item, P_ACTIVE_SIG);
        if (active) {
            log("evaluation blocked — keeping active id:", active);
            if (isCurrent(seq)) reportOutcome(item, "quiet");
            return;
        }
        log("evaluation blocked and nothing applied yet — applying default");
    }

    const targetId = rule ? String(rule.signatureId) : DEFAULT_ID;
    if (!isCurrent(seq)) { log("stale evaluation dropped"); return; }

    const result = await applyById(item, targetId, userEmail, seq, { revalidate: false });
    const applied = result.applied;
    const deferred = result.status === "deferred";

    if ((applied || deferred) && isCurrent(seq)) {
        const snapshot = serializeRecipients(await readRecipientEmails(item));
        await persistDecision(item, targetId, snapshot, result.digest);
        if (deferred) log(`id=${targetId} persisted for the send runtime to apply`);
    }

    if (isCurrent(seq)) {
        reportOutcome(item, applied ? "applied" : deferred ? "quiet" : "failed");
    }
    timed(`evaluateAndApply (${targetId})`, t0);
}

// ─────────────────────────────────────────────────────────────────────────────
//  SEND
// ─────────────────────────────────────────────────────────────────────────────

async function decideSendId(item, userEmail) {
    const currentSnap = serializeRecipients(await readRecipientEmails(item));

    const override = await getManualOverride(item);
    if (override) {
        return { id: override, snapshot: currentSnap, reason: "manual override", persist: false };
    }

    const [activeId, snapshot] = await Promise.all([
        getItemProp(item, P_ACTIVE_SIG),
        getItemProp(item, P_RECIP_SNAPSHOT),
    ]);

    if (activeId && snapshot !== null && currentSnap !== null && snapshot === currentSnap) {
        return { id: activeId, snapshot: currentSnap, reason: "recipients unchanged since compose", persist: false };
    }

    const { rule, blocked } = await findMatchingRule(item, userEmail, {
        allowNetwork: true,
        strictComposeType: true,
    });

    if (rule) {
        return { id: String(rule.signatureId), snapshot: currentSnap, reason: `rule priority=${rule.priority}`, persist: true };
    }

    if (!blocked) {
        return { id: DEFAULT_ID, snapshot: currentSnap, reason: "no rule matched", persist: true };
    }

    if (currentSnap === "") {
        return { id: DEFAULT_ID, snapshot: currentSnap, reason: "blocked, but recipients confirmed empty", persist: true };
    }

    const fallbackId = activeId || await getActiveSignatureId(item, { allowRoam: currentSnap === null });
    if (fallbackId) {
        return { id: fallbackId, snapshot: currentSnap, reason: "evaluation blocked — persisted id", persist: false };
    }
    return { id: DEFAULT_ID, snapshot: currentSnap, reason: "last resort", persist: false };
}

async function onSendCore(item, mailbox) {
    const t0 = Date.now();

    if (!_senderEmail) {
        _senderEmail = String(mailbox?.userProfile?.emailAddress || "").trim().toLowerCase();
    }
    const userEmail = _senderEmail || mailbox?.userProfile?.emailAddress;
    const seq = beginWrite();

    const { id, reason, persist } = await decideSendId(item, userEmail);
    log(`onSend: target id=${id} (${reason})`);

    const r = await applyById(item, id, userEmail, seq, { isSendTime: true });

    void persist;

    if (r.verdict && r.verdict !== "identical") {
        warn(`signature altered on the draft (${r.verdict}) — ` +
            (r.status === "written" ? "re-inserted from cache" : "left as-is, host cannot replace"));
    }

    if (r.applied && !hasFailure()) removeNotification(item);
    else reportOutcome(item, r.applied ? "applied" : "failed", { action: false });

    flushSigCache();
    timed(`onSendCore (${r.status})`, t0);
}

// ─────────────────────────────────────────────────────────────────────────────
//  ENTRY POINTS
// ─────────────────────────────────────────────────────────────────────────────

function makeCompleter(label, t0, event, args) {
    let done = false;
    return () => {
        if (done) return;
        done = true;
        flushSigCache();
        timed(label, t0);
        try { event.completed(args); } catch (e) { err("event.completed threw:", e); }
    };
}

const applySignature = async function (event = { completed: () => { } }) {
    const t0 = Date.now();
    const mailbox = Office?.context?.mailbox;
    const item = mailbox?.item;
    const complete = makeCompleter("applySignature total", t0, event);

    try {
        if (!item) return complete();
        invalidateProps(item);
        invalidateCaches();
        await resolveSender(item, mailbox);
        log(`applySignature start — ${CB_VERSION} on ${detectPlatform()} (X-Platform: ${getXPlatform()}) account=${accountKey()}`);

        // v7.9.2: The module is inlined, so this will always report success.
        logHcsStatus("applySignature");

        await restoreStickyError(item);

        const seq = beginWrite();
        const userEmail = _senderEmail || mailbox?.userProfile?.emailAddress;

        const pinned = await getManualOverride(item);
        if (pinned) log("manual override present at compose — not resetting active id:", pinned);
        else await markActiveSignature(item, null);

        const composeTypeP = getComposeType(item, { persist: true })
            .then((t) => log("composeType at compose:", t))
            .catch((e) => warn("composeType resolution failed:", e));

        const rulesP = (async () => {
            if (!userEmail) return;
            if (getCachedRules()) { log("rules cache warm:", describeRulesSource()); return; }
            await fetchRules(await encryptEmail(userEmail));
        })().catch((e) => warn("rules refresh failed:", e));

        await Promise.allSettled([composeTypeP, rulesP]);

        const snap0 = serializeRecipients(await readRecipientEmails(item));
        if (snap0 !== null) _lastSnapshot = snap0;

        await evaluateAndApply(item, mailbox, seq);

        if (userEmail) {
            prefetchSignatures(userEmail, { includeRules: !isMobile() })
                .catch((e) => warn("prefetch failed:", e));
        }
    } catch (e) {
        err("applySignature error:", e);
        if (item && !wasReported()) reportOutcome(item, "failed");
    } finally {
        complete();
    }
};

const onRecipientsChangedHandler = async function (event = { completed: () => { } }) {
    const t0 = Date.now();
    const mailbox = Office?.context?.mailbox;
    const item = mailbox?.item;
    const complete = makeCompleter("onRecipientsChanged total", t0, event);

    try {
        if (!item) return complete();
        invalidateProps(item);
        invalidateCaches();
        await resolveSender(item, mailbox);

        logHcsStatus("onRecipientsChanged");

        await restoreStickyError(item);

        const seq = beginWrite();

        await sleep(RECIPIENT_SETTLE_MS);

        let snapshot = serializeRecipients(await readRecipientEmails(item));
        if (snapshot === null) { log("recipient read failed — skipping"); return complete(); }

        if (snapshot === "" && _lastSnapshot !== "") {
            await sleep(EMPTY_RECIP_SETTLE_MS);
            const recheck = serializeRecipients(await readRecipientEmails(item, { force: true }));
            if (recheck === null) { log("recipient re-read failed — skipping"); return complete(); }
            snapshot = recheck;
        }

        if (snapshot === _lastSnapshot) { log("recipients unchanged — skipping"); return complete(); }
        _lastSnapshot = snapshot;

        log(snapshot === ""
            ? "all recipients removed — re-evaluating (default expected)"
            : "recipients changed — re-evaluating");
        await evaluateAndApply(item, mailbox, seq);
    } catch (e) {
        err("onRecipientsChangedHandler error:", e);
        if (item && !wasReported()) reportOutcome(item, "failed");
    } finally {
        complete();
    }
};

const onFromChangedHandler = async function (event = { completed: () => { } }) {
    const t0 = Date.now();
    const mailbox = Office?.context?.mailbox;
    const item = mailbox?.item;
    const complete = makeCompleter("onFromChanged total", t0, event);

    try {
        if (!item) return complete();
        invalidateProps(item);
        invalidateCaches();
        const prev = _senderEmail;
        await resolveSender(item, mailbox);
        log(`from changed — re-evaluating for the new account (${prev || "?"} -> ${_senderEmail || "?"})`);

        logHcsStatus("onFromChanged");

        await clearSticky(item);

        const seq = beginWrite();
        const userEmail = _senderEmail || mailbox?.userProfile?.emailAddress;

        _inFlight.clear();
        _digestCache = { html: null, digest: null };
        await markActiveSignature(item, null);

        if (userEmail && !getCachedRules()) await fetchRules(await encryptEmail(userEmail));

        const snap0 = serializeRecipients(await readRecipientEmails(item));
        if (snap0 !== null) _lastSnapshot = snap0;

        await evaluateAndApply(item, mailbox, seq);

        if (userEmail) {
            prefetchSignatures(userEmail, { includeRules: !isMobile() })
                .catch((e) => warn("prefetch failed:", e));
        }
    } catch (e) {
        err("onFromChangedHandler error:", e);
        if (item && !wasReported()) reportOutcome(item, "failed");
    } finally {
        complete();
    }
};

const onSendHandler = async function (event = { completed: () => { } }) {
    const t0 = Date.now();
    const mailbox = Office?.context?.mailbox;
    const item = mailbox?.item;
    const complete = makeCompleter("onSendHandler total", t0, event, { allowEvent: true });

    try {
        if (!item) return complete();
        invalidateProps(item);
        invalidateCaches();
        log(`onSendHandler start — ${CB_VERSION} on ${detectPlatform()}`);

        // v7.9.2: Always reports success since the module is inlined.
        logHcsStatus("onSendHandler", { always: true });

        await restoreStickyError(item, { show: false });

        const budget = isColdRuntime() ? SEND_BUDGET_MS_COLD : SEND_BUDGET_MS;
        await withTimeout(onSendCore(item, mailbox), budget, "onSendCore");
    } catch (e) {
        warn("onSend timeout/error:", e.message);
        _writeSeq++;
        if (!hasFailure()) recordFailure("offline", `onSendCore: ${e.message}`);
        if (!wasReported()) reportOutcome(item, "failed", { action: false });
    } finally {
        complete();
    }
};

// ─────────────────────────────────────────────────────────────────────────────
//  BOOTSTRAP
// ─────────────────────────────────────────────────────────────────────────────

if (typeof Office !== "undefined" && typeof Office.onReady === "function") {
    Office.onReady(() => {
        log(`ready — ${CB_VERSION} | platform=${detectPlatform()} | X-Platform=${getXPlatform()} | session=${getSessionId()}`);
        try {
            const d = Office.context.mailbox?.diagnostics;
            if (d) log(`host=${d.hostName} version=${d.hostVersion}`);
        } catch (_) { }
        logHcsStatus("Office.onReady", { always: true });
        if (!canUseInsight()) {
            log("actionable notifications unavailable on this host — error bars will have no button");
        }
    });
}

if (typeof Office !== "undefined" && Office.actions?.associate) {
    Office.actions.associate("applySignature", applySignature);
    Office.actions.associate("onSendHandler", onSendHandler);
    Office.actions.associate("onFromChangedHandler", onFromChangedHandler);
    Office.actions.associate("onRecipientsChangedHandler", onRecipientsChangedHandler);
    log(`${CB_VERSION} handlers registered`);
} else {
    log("Office.actions unavailable — LaunchEvent path inactive (Outlook 2016/2019)");
}