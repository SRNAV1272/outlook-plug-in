/*!
 * html-content-signature v2
 * ------------------------------------------------------------------
 * Deterministic canonical signature of an HTML body's *rendered content*,
 * for detecting tampering by comparing two signatures.
 *
 * Design goals (in priority order):
 *   1. HOST INDEPENDENCE - the default path is a pure string tokenizer, so
 *      New Outlook (Chromium/WebView2) and Classic Outlook (mshtml/IE11)
 *      produce byte-identical signatures. No DOMParser required.
 *   2. UNFORGEABLE ENCODING - tokens are JSON-encoded, so no text content
 *      can imitate a structural token (the old "|"/":" scheme could).
 *   3. NO BLIND SPOTS THAT CHANGE WHAT THE USER SEES OR CLICKS -
 *      link targets, srcset, CSS urls, style/script bodies are covered.
 *   4. NO FALSE POSITIVES on benign re-serialization - comments, inline
 *      wrapper churn, entity form, whitespace form, NBSP, zero-width junk.
 *
 * Usage:
 *   var sig = HtmlContentSignature.signature(html);        // canonical string
 *   HtmlContentSignature.equal(a, b);                      // boolean
 *   HtmlContentSignature.diff(a, b);                       // where they differ
 *   HtmlContentSignature.digest(html);                     // short, NON-crypto
 *
 * NOTE ON TRUST: this is an integrity *diff*, not a MAC. If the baseline
 * signature travels with the message or is stored client-side, an attacker
 * who can edit the HTML can also edit the baseline. Sign/HMAC the canonical
 * string server-side if you need authenticity, not just change detection.
 */
(function (root, factory) {
    "use strict";
    if (typeof module === "object" && module.exports) module.exports = factory();
    else root.HtmlContentSignature = factory();
})(typeof self !== "undefined" ? self : this, function () {
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
        // "a.png 1x,  b.png 2x" -> "a.png 1x,b.png 2x" (order preserved, ws collapsed)
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
        if (!this.tokens.length) return;                 // no leading break
        if (last && last.length === 1 && last[0] === "b") return; // no doubles
        this.tokens.push(["b"]);
    };

    // Shared per-element handling for both the tokenizer and the DOM walker.
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

        // <img> must always be visible in the signature, even with no src,
        // because its mere presence is rendered content.
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
        // noscript / noframes / xmp / plaintext: treat body as visible text
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
            // First occurrence wins, matching the HTML parser.
            if (!attrs.hasOwnProperty(name)) attrs[name] = val;
        }
        return attrs;
    }

    function tokenize(html, o) {
        var s = html == null ? "" : String(html);
        var n = s.length, i = 0, em = new Emitter(o), guard = 0;

        while (i < n) {
            if (++guard > n * 4 + 16) break; // paranoia: never loop forever

            var lt = s.indexOf("<", i);
            if (lt < 0) { em.text(s.slice(i)); break; }
            if (lt > i) em.text(s.slice(i, lt));

            var next = s.charAt(lt + 1);

            // Comments (incl. IE conditional comments) - skipped on every host.
            if (s.substr(lt, 4) === "<!--") {
                var endC = s.indexOf("-->", lt + 4);
                if (endC < 0) { i = n; break; }
                i = endC + 3;
                continue;
            }
            // Doctype, CDATA, processing instructions, bogus comments.
            if (next === "!" || next === "?") {
                var endB = s.indexOf(">", lt + 2);
                i = endB < 0 ? n : endB + 1;
                continue;
            }

            var isEnd = next === "/";
            var nameStart = lt + (isEnd ? 2 : 1);
            var ch = s.charAt(nameStart);
            if (!/[a-zA-Z]/.test(ch)) {           // a literal "<" in text
                em.text("<");
                i = lt + 1;
                continue;
            }

            var p = nameStart;
            while (p < n && /[^\s\/>]/.test(s.charAt(p))) p++;
            var tag = s.slice(nameStart, p).toLowerCase();

            // Find the tag's ">" while respecting quoted attribute values.
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
                // case-insensitive search for "</tag"
                var lower = s.toLowerCase(), needle = "</" + tag;
                close = lower.indexOf(needle, from);
                if (close < 0) { em.rawBody(tag, s.slice(from)); i = n; continue; }
                em.rawBody(tag, s.slice(from, close));
                i = close; // end tag consumed on the next iteration
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
            // Neutralise loading attributes so an inert parse cannot hit the network,
            // then read them back from their data-* twins.
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

    /* ------------------------------------------------- marked region extraction
  
       Locating "the signature" inside a draft body needs an anchor, because
       setSignatureAsync does NOT always put the block at the end (on a reply it
       sits above the quoted original). Wrap what you write in a marked element
       and pull it back out by that attribute.
  
       Void elements never open a depth level; raw-text elements are skipped so a
       marker mentioned inside <style> or a comment cannot be mistaken for one.
    ------------------------------------------------------------------------- */

    var VOID = {
        area: 1, base: 1, br: 1, col: 1, embed: 1, hr: 1, img: 1, input: 1,
        link: 1, meta: 1, param: 1, source: 1, track: 1, wbr: 1
    };

    function isAlpha(c) { return (c >= 65 && c <= 90) || (c >= 97 && c <= 122); }
    function isTagNameEnd(c) {
        return c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 47 || c === 62;
    }

    /**
     * Every element carrying `attr`, with its inner HTML and the attribute value.
     *
     * PERFORMANCE NOTE: this is one flat loop over char codes on purpose. The
     * first version walked tags through a callback and allocated a descriptor
     * object per tag; V8 ran it at ~14ms for three calls and then, once the
     * function was optimised, at ~575ms on the SAME 140KB input - a 40x deopt
     * cliff that would land squarely inside the send budget. Do not reintroduce
     * a per-tag callback or per-tag object here.
     *
     * @returns {Array<{value:string, inner:string, tag:string}>}
     */
    function extractMarkedRegions(html, attr) {
        var s = String(html == null ? "" : html);
        var a = String(attr).toLowerCase();
        var found = [];
        if (!s || s.indexOf("<") === -1) return found;

        var lower = s.toLowerCase();
        if (lower.indexOf(a) === -1) return found;   // no marker anywhere: done

        var n = s.length, i = 0;
        var openTag = "", depth = 0, innerStart = 0, openValue = "";

        while (i < n) {
            var lt = s.indexOf("<", i);
            if (lt < 0) break;

            // <!-- comment -->  (also swallows IE conditional comment blocks)
            if (s.charCodeAt(lt + 1) === 33 && s.charCodeAt(lt + 2) === 45 && s.charCodeAt(lt + 3) === 45) {
                var ec = s.indexOf("-->", lt + 4);
                i = ec < 0 ? n : ec + 3;
                continue;
            }
            var nc = s.charCodeAt(lt + 1);
            if (nc === 33 || nc === 63) {              // doctype / PI / bogus comment
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
            // "/>" or a void element never opens a depth level.
            var selfClosing = !!VOID[tag] || (function () {
                var k = q - 1;
                while (k > p && isTagNameEnd(s.charCodeAt(k)) && s.charCodeAt(k) !== 47) k--;
                return s.charCodeAt(k) === 47;
            })();

            if (depth > 0) {
                if (tag === openTag) {
                    if (isEnd) {
                        if (--depth === 0) {
                            found.push({ value: openValue, tag: openTag, inner: s.slice(innerStart, lt) });
                        }
                    } else if (!selfClosing) depth++;
                }
            } else if (!isEnd && !selfClosing && q - p > a.length) {
                // Search WITHIN this tag only. `lower.indexOf(a, p)` would scan to the
                // end of the document for every tag that lacks the marker - O(n^2), and
                // ~155ms on a 140KB reply thread.
                var attrSrc = lower.slice(p, q);
                var attrs = attrSrc.indexOf(a) === -1 ? null : parseAttrs(s.slice(p, q));
                if (attrs && attrs.hasOwnProperty(a)) {
                    openTag = tag;
                    depth = 1;
                    innerStart = afterTag;
                    openValue = decodeEntities(attrs[a] || "");
                }
            }

            i = afterTag;
            // Never look for markers inside <style>/<script>/<textarea>/<title>.
            if (!isEnd && RAW_TEXT[tag]) {
                var close = lower.indexOf("</" + tag, i);
                i = close < 0 ? n : close;
            }
        }

        // Unclosed marker (truncated body, or the host mangled the wrapper): take
        // everything after it rather than reporting nothing.
        if (depth > 0) found.push({ value: openValue, tag: openTag, inner: s.slice(innerStart) });
        return found;
    }

    /* ------------------------------------------------------------ verification */

    // Ready-made option sets. `body` is the one to use against a draft body.
    var PROFILES = {
        // Byte-for-byte content equality. For comparing two stored copies.
        strict: {},
        // For comparing a stored signature against what is in an Outlook draft.
        // CSS and script bodies are excluded because the Word and OWA editors
        // rewrite style blocks and inline CSS wholesale - keeping them guarantees a
        // mismatch on every desktop draft. What remains is what tampering has to
        // touch to be harmful: visible text, link targets, image identity, order.
        body: { css: false, scriptBodies: false, hostRewrittenUrls: true }
    };

    function keyOf(tok) { return JSON.stringify(tok); }

    /**
     * Token equality with ONE asymmetric allowance: when hostRewrittenUrls is on,
     * "@embedded" in the URL slot of a ["u", tag, attr, url] token matches any
     * URL on the other side. The cached copy says
     * src="https://cdn.example/logo.png"; the draft says src="cid:image001.png"
     * because Outlook attached and rewrote it. Both describe the same image.
     *
     * KNOWN LIMIT: this means an attacker who replaces the logo with ANOTHER
     * cid: attachment is not caught by URL. Image count, position, and every
     * text and href token are still compared strictly, which is what makes a
     * misleading signature hard to build.
     */
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

    // Index of the first contiguous occurrence of `needle` in `hay`, or -1.
    // Exact string-key pass first (fast); only retried with the URL wildcard if
    // that misses and the caller asked for host tolerance.
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

    // Fraction of the expected tokens present anywhere in the body (multiset).
    // Diagnostic only: it separates "edited" from "not there at all".
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

    /**
     * Is `expectedHtml` present, unmodified, inside `containerHtml`?
     *
     * @returns {{verdict:"identical"|"modified"|"absent", at:number, overlap:number}}
     *   identical - found as an intact contiguous run
     *   modified  - much of it is there but not intact
     *   absent    - not meaningfully there at all
     */
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

    /** Direct equality of two HTML fragments under a profile. */
    function verifyExact(expectedHtml, actualHtml, o) {
        var opt = options(o);
        var exp = stripEdgeBreaks(tokenize(expectedHtml, opt));
        var act = stripEdgeBreaks(tokenize(actualHtml, opt));
        if (runsEqual(exp, act, opt.hostRewrittenUrls)) return { verdict: "identical", at: 0, overlap: 1 };
        var ov = overlap(exp, act);
        return { verdict: ov >= 0.5 ? "modified" : "absent", at: -1, overlap: ov };
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

    // FNV-1a 32-bit + length. Short, stable, NOT cryptographic - do not use it
    // as the sole tamper check against a motivated attacker.
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
});
"use strict";

// =============================================================================
//  CardByte Outlook Add-in — event-handler.js (v7.5)
//
//  ARCHITECTURE: THE SIGNATURE ID IS THE STATE. THE HTML IS A DISPOSABLE CACHE.
//
//  Every decision point produces an id (a rule's signatureId, or DEFAULT_ID).
//  The id is persisted on the item; HTML is always re-derivable from the id via
//  cache-then-network. Consequences:
//
//   • Send time is uniform: decide id -> resolve html -> ONE body write.
//     No "trust whatever is in the body", so a deleted or race-clobbered
//     signature block is corrected at send.
//   • The Mac send runtime (fresh WKWebView, empty localStorage) is no longer a
//     special case — a cache miss is just a bounded fetch.
//   • Compose does ONE body write per event instead of four (v6 ran
//     applySignatureCore's cached-apply + its post-network re-apply, twice
//     over, concurrently with the rule apply — see WRITE TOKEN below).
//
//  WRITE TOKEN. Windows/OWA share one runtime, so OnNewMessageCompose and
//  OnMessageRecipientsChanged overlap and both write the body across long
//  awaits. Each entry point takes a seq from beginWrite(); a write is dropped
//  if seq is no longer current. Last decision wins deterministically instead of
//  by network luck.
//
// -----------------------------------------------------------------------------
//  CHANGES IN v7.5.0 — THE SEND NO LONGER REWRITES A SIGNATURE THAT IS ALREADY
//  CORRECT (requires html-content-signature.js concatenated ahead of this file)
//
//  Q. onSendCore resolved an id and then rewrote the body every single time,
//     including the overwhelmingly common case where the body already carried
//     exactly that signature. Send time now READS the draft, compares it against
//     the resolved HTML, and writes ONLY when the draft's copy is missing,
//     edited, duplicated, or belongs to a different id.
//
//     The comparison is content-based, not textual: Outlook rewrites a
//     signature the moment it lands (remote images become cid: attachments,
//     Word rewrites CSS and injects MsoNormal/o:p/lang markup, entities and
//     whitespace reflow), so comparing HTML strings would report every desktop
//     draft as tampered. See PROFILES.body in html-content-signature.js for
//     exactly what is and is not compared, and why.
//
//  R. EVERY WRITE IS NOW WRAPPED IN <div data-cb-sig="{id}">. There is no API
//     for reading back just the signature, and setSignatureAsync does not put
//     the block at the end of a reply, so the wrapper is the only reliable
//     anchor. Drafts written by v7.4 have no wrapper and fall back to a
//     token-run search over the whole body.
//
//  S. EVERY UNCERTAIN OUTCOME STILL WRITES. Body unreadable, module not loaded,
//     marker stripped, HTML rewritten past recognition — all resolve to "write
//     it", i.e. v7.4 behaviour. A false positive costs one body write; a false
//     negative never leaves a wrong signature. VERIFY_AT_SEND=false restores
//     v7.4 unconditionally, in one flag.
//
//  T. APPEND-ONLY HOSTS ARE DETECT-ONLY BY DEFAULT. Mobile has no
//     setSignatureAsync, only appendOnSendAsync, so "re-insert" there means
//     "add a second signature next to the edited one". When the signature is
//     merely ABSENT (the normal mobile path — nothing runs at compose) it is
//     still appended. When it is present but wrong, v7.5 logs and leaves it;
//     set APPEND_ON_TAMPER=true to append regardless.
//
//  U. P_SIG_DIGEST records what was written, so a mismatch caused by an admin
//     updating the signature server-side is logged as such instead of as a
//     user edit. Informational only — both cases re-insert. It rides the same
//     saveAsync as the id and snapshot: no extra round trip.
//
//  V. OPTIMISATIONS. encryptEmail is memoised (static IV = deterministic
//     output; it was paying an importKey+encrypt per API call, once per id in
//     prefetch). The signature cache map is parsed once per runtime instead of
//     JSON.parsing every cached signature's HTML on every get/set/purge; the
//     from-change handler invalidates the parsed copy along with the keys.
//
//  NOT ADDRESSED, ON PURPOSE: this detects tampering, it does not prove
//  authorship. The expected copy comes from the local cache, which anyone with
//  the device can edit; and a user who edits the signature after OnMessageSend
//  completes is outside the add-in's reach entirely. If the requirement is
//  "the recipient can verify the signature was not altered", enforce it on the
//  server or gateway, not here.
//
// -----------------------------------------------------------------------------
//  CHANGES IN v7.4.0 — THE NOTIFICATION BAR IS TWO MESSAGES, NOT SIX
//
//  M. ONLY TWO THINGS ARE WORTH INTERRUPTING THE USER WITH: "the signature is
//     on the mail", and "it is not / may be wrong, and here is why".
//     "Preparing your signature...", "Loading your signature...",
//     "Verifying signature..." and the per-phase timings are gone, along with
//     NOTIFY_LEVEL — there is no longer anything to set a level on. Timings
//     still go to the console via timed(), which is where QA reads them.
//
//  N. FAILURES ARE REPORTED FROM ONE PLACE, AT THE END OF THE RUN. Previously
//     every notifyError call site fired the instant it was reached, which had
//     two bad consequences: a failure that was subsequently recovered from
//     still flashed at the user, and — because notificationMessages is
//     last-write-wins on one key — a later "Signature applied" could silently
//     overwrite a real error.
//
//     Every step that can fail now RECORDS the failure (recordFailure) in a
//     per-run ledger, and reportOutcome() emits exactly one message once the
//     outcome is actually known:
//
//       fatal failure recorded -> that failure's message (persistent)
//       degraded (rules)       -> rules could not be consulted, so the applied
//                                 signature may not be the one a rule wanted
//       applied, nothing wrong -> "Signature applied", auto-cleared
//       nothing to say         -> silence: manual override, a deferred mobile
//                                 compose (L), or a stale write dropped by the
//                                 write token
//
//     The ledger is reset by beginWrite(), i.e. exactly once per decision, so
//     an error from a superseded evaluation cannot be reported against a newer
//     one.
//
//  O. EVERY API STEP FEEDS THE LEDGER, NOT JUST THE FINAL BODY WRITE. Covered:
//     /rules-config/get-active, /html/outlook/get-active,
//     /rules-config/get/{id}, each of their timeouts, the MAX_SIG_BYTES
//     ceiling, and both setSignatureAsync and appendOnSendAsync. An HTTP
//     status and a transport failure stay distinct all the way to the message,
//     because "check your connection" and "contact Admin" are different
//     instructions to give someone — see prereq (a) for why the distinction is
//     load-bearing on Mac/mobile.
//
//     BACKGROUND WORK IS SILENT BY DESIGN. prefetchSignatures (J) and
//     revalidateSigHtml never record: neither has any bearing on what is on
//     the mail right now, and a warm-up failure is not the user's problem.
//
//  P. SEND TIME RAISES FAILURES ONLY. The send is still never blocked
//     (allowEvent: true), and a success message at send has nothing to land on
//     because the item is already closing — so onSendCore reports a failure if
//     there is one and otherwise clears the bar.
//
// -----------------------------------------------------------------------------
//  CHANGES IN v7.3.0 — THE EMPTY-RECIPIENT DEFAULT NOW WORKS ON MOBILE
//
//  v7.2 fixed the empty-recipient case for Windows/OWA by making "no
//  recipients" an evaluable state. Mobile still failed, for reasons entirely
//  separate from that change. Mobile is the platform where NOTHING runs at
//  compose time, so every one of these lands at send:
//
//   F. STRICT COMPOSE-TYPE BLOCKED THE SEND-TIME EVALUATION, AND THE FALLBACK
//      WAS THE OLD RULE ID. Most likely cause of the reported symptom. Mobile
//      does not support getComposeTypeAsync, so detectComposeType returns null;
//      at send `strictComposeType` is on, so findMatchingRule returned
//      `blocked: true` immediately. decideSendId then hit
//      `if (blocked && fallback) return fallback` — and the fallback is the
//      PREVIOUSLY PERSISTED RULE ID. Emptying the recipients therefore
//      reapplied the rule signature at send, which is exactly "the default is
//      not applied".
//
//      The blocking is now granular. Compose type is consulted only when it can
//      still change the answer: sender and recipient are filtered FIRST, and if
//      no enabled rule survives that filter, no rule can match whatever the
//      compose type is — so the default applies and nothing is blocked. With an
//      empty recipient list every internal/external rule drops out, which for
//      most tenants leaves zero candidates. If candidates do survive and the
//      highest-priority one is context-agnostic ("all"/unset), it wins outright
//      without needing the compose type either.
//
//   G. THE BLOCKED FALLBACK REUSED AN ID DECIDED FOR A DIFFERENT RECIPIENT SET.
//      By construction, decideSendId only reaches the blocked branch when the
//      persisted snapshot does NOT match the current one — so the persisted id
//      was chosen under recipients that no longer exist. When the current list
//      is confirmed EMPTY, that id cannot be right and the default is used
//      instead. (Left alone when the list is merely different: dropping a
//      possibly-correct rule signature is worse than reapplying it.)
//
//   H. ROAMED ACTIVE ID LEAKED ACROSS DEVICES. R_ACTIVE_SIG is mailbox-scoped,
//      so a rule id decided on the desktop roams to the phone. On mobile —
//      where nothing is persisted on the item because no compose event fires —
//      getActiveSignatureId() fell through to that roamed value and applied
//      another device's decision to this mail. The roamed tier is now consulted
//      only when the recipient list could not be read at all.
//
//   I. X_PLATFORM_MAP CONTRADICTED ITS OWN DOCUMENTATION. Fix (D) says MAC and
//      MOBILE are collapsed onto WINDOWS because the backend has no bucket for
//      them — but the map shipped as `{ MAC: "MAC", ... }`, so Mac and every
//      mobile client (which resolve to MAC) kept sending a value the header
//      itself says comes back non-2xx. Every fetch on those platforms then
//      fails, and the default signature is the id least likely to be in cache
//      when the recipients are emptied. Now mapped to WINDOWS as documented.
//      VERIFY AGAINST YOUR BACKEND: if it does accept MAC, revert this one line
//      rather than the rest of the fix.
//
//   J. DEFAULT_ID IS NOW PREFETCHED ON MOBILE. prefetching was skipped wholesale
//      on mobile, so when a rule matched, the default HTML was never warmed —
//      and the empty-recipient transition needs precisely that id, on a cold
//      runtime, inside the send budget. Rule signatures are still not
//      prefetched on mobile (bandwidth); the single default is.
//
//   K. COLD-RUNTIME BUDGETS NOW COVER MOBILE. Mobile got the 5s desktop send
//      budget and the 2.5s recipient-read budget despite starting as cold as
//      Mac. Both now use the cold-start values, and the Mac-only recipient
//      re-read retry applies to mobile too. A slow read that times out is
//      classified as UNREADABLE, which blocks evaluation — so a budget that is
//      too tight reintroduces the bug it was meant to prevent.
//
//   L. HOSTS WITHOUT setSignatureAsync NO LONGER LOSE THE COMPOSE DECISION.
//      Mobile has no setSignatureAsync, so a compose-time apply cannot succeed
//      there; evaluateAndApply treated that as "nothing applied" and skipped
//      persisting the id, discarding the decision. The id is now persisted
//      anyway so the send runtime can act on it via appendOnSendAsync, and the
//      user-facing error is suppressed when the host simply cannot write yet.
//
//  MOBILE PLATFORM LIMIT, NOT FIXABLE HERE: OnMessageRecipientsChanged is not
//  raised by Outlook mobile. The signature therefore does not visibly update
//  while composing on a phone — the correction happens at send. If it must be
//  live there, that is the one place recipient polling would have to come back.
//
// -----------------------------------------------------------------------------
//  CHANGES IN v7.2.0 — "NO RECIPIENTS" IS AN ANSWER, NOT A FAILURE
//  (v7.1 symptom: remove every recipient from a mail that had already matched a
//   rule, and the rule's signature stayed on the body. The default never came
//   back.)
//
//   E. EMPTY RECIPIENT LIST vs FAILED RECIPIENT READ. v7.1 conflated the two:
//      officeAsync falls back to null on timeout/error, getRecipients turned
//      that into [], and findMatchingRule returned `blocked: true` for any
//      empty list. evaluateAndApply's blocked branch then found the previously
//      persisted P_ACTIVE_SIG and returned early — so the rule signature was
//      pinned to the body for the rest of the compose session. It only ever
//      looked right on first compose, where applySignature clears the active id
//      before evaluating and so has nothing to keep.
//
//      Zero recipients is a perfectly evaluable state: hasInternal and
//      hasExternal are both false, "internal"/"external" rules correctly fail
//      to match, and an "all" rule (or DEFAULT_ID) legitimately wins. What
//      actually prevents evaluation is a read that never returned.
//
//      getRecipients / getAllRecipientEmails / serializeRecipients now return
//      null for "the host did not answer" and [] / "" for "genuinely none".
//      findMatchingRule blocks on null only. Every snapshot call site is
//      null-guarded; markActiveSignature already removes P_RECIP_SNAPSHOT when
//      handed null, which makes send time re-evaluate rather than trust a
//      snapshot that was never taken.
//
//      SUPERSEDES v7.1 change note 2. That note is why this bug shipped: it
//      described "an empty recipient list no longer resets the body to the
//      default" as the intended cure for OWA's mid-typing flicker. The flicker
//      is real, but blocking on emptiness was too blunt a fix. The flicker is
//      now handled where it belongs — EMPTY_RECIP_SETTLE_MS in
//      onRecipientsChangedHandler re-reads before acting on a newly empty list,
//      so deleting the last recipient in order to retype it does not churn the
//      body. Do NOT reinstate the block; widen the debounce instead.
//
//  CHANGES IN v7.1.0 — RULES ARE FETCHED / EVALUATED CORRECTLY
//  (v7.0 symptom: rules looked right in the React taskpane but were wrong or
//   frozen here. All four causes were in this file, not the backend.)
//
//   A. ROAMED RULES NOW EXPIRE. v7.0's readRoamedRules() had no timestamp, so
//      once cb_rules was written getCachedRules() returned non-null FOREVER.
//      That poisoned every "null means go fetch" caller — applySignature's
//      warm-up (`if (getCachedRules()) return;`) and findMatchingRule's live
//      fetch — so admin edits never reached the event runtime. The roamed copy
//      now carries R_RULES_TS and is TTL-checked exactly like the local copy;
//      skipTtl (send time) still accepts it, which is what keeps the Mac cold
//      start working.
//
//   B. FROM-CHANGE NOW CLEARS THE ROAMED COPY. onFromChangedHandler removed the
//      localStorage keys only, so after an account switch the empty local cache
//      fell through to roaming and matched against the PREVIOUS identity's
//      rules. R_RULES / R_RULES_TS / R_ACTIVE_SIG are now cleared too.
//
//   C. RULES WITH NO signatureId ARE NO LONGER CANDIDATES. v7.0 filtered on
//      `r.enabled` alone (the React view also requires r.signatureId). Such a
//      rule would match, stringify to the literal "null", request
//      /rules-config/get/null, 404, leave the body untouched — and shadow the
//      lower-priority rule that should have won. Priority is also coerced with
//      `?? 0`: a missing priority produced NaN, and a NaN comparator makes
//      Array#sort return an arbitrary order, i.e. an arbitrary "first match".
//
//   D. X-PLATFORM. v7.0 started reporting the REAL platform (MAC / MOBILE),
//      which the backend has no bucket for — hence non-2xx on
//      /rules-config/get-active. The React taskpane read the non-existent
//      Office.context.platform, always got "", and therefore always sent
//      WINDOWS, which is why it worked. X_PLATFORM_MAP now collapses MAC and
//      MOBILE onto WINDOWS. Empty the map once the backend accepts the real
//      values — that is the only reason to touch it.
//
//  CHANGES FROM v6 THAT ALTER BEHAVIOUR — VALIDATE THESE:
//   1. Recipient POLLING and the 4-minute MAC_KEEPALIVE are gone. Deferring
//      event.completed() for 4 min can delay or drop OnMessageSend, since the
//      event runtime serialises activations. Recipient tracking now relies on
//      the OnMessageRecipientsChanged LaunchEvent. Confirm it fires on your Mac
//      build; if it does not, re-add polling there specifically.
//   2. (Superseded by (E) above.) Emptying the recipient list DOES return the
//      body to the default signature — that is the correct evaluation result,
//      not a reset. Mid-typing flicker is suppressed by debouncing, not by
//      refusing to evaluate.
//   3. X_PLATFORM_FORCE is removed. The real platform is detected, including a
//      new "OWA" value, then mapped through X_PLATFORM_MAP before it is sent.
//   4. Default-signature HTML shares the one id-keyed cache (id = "default").
//      The legacy cardbyte_cached_signature key is still read, so a warm cache
//      written by the taskpane build is not thrown away.
//
//  DEPLOYMENT PREREQS FOR MAC / MOBILE (not fixable in this file):
//   a) /.well-known/microsoft-officeaddins-allowed.json must list the add-in id
//      and this file's URL, and the API must send CORS headers. Otherwise every
//      fetch from the Mac event runtime rejects with "TypeError: Load failed".
//      Note the shape of the failure: an HTTP status in the log is (D) above,
//      a "Load failed" TypeError is this. The two now also reach the user as
//      different notifications — see (O).
//   b) XML (add-in only) manifest with LaunchEvents: OnNewMessageCompose,
//      OnMessageRecipientsChanged, OnMessageFromChanged, OnMessageSend.
//      Mobile honours only a subset — confirm which ones your build actually
//      raises before assuming a handler ran.
//   c) Mac debugging: defaults write com.microsoft.Outlook
//      OfficeWebAddinDeveloperExtras -bool true, then Safari > Develop.
// =============================================================================

const CB_VERSION = "v7.5.0";

// ─────────────────────────────────────────────────────────────────────────────
//  CONFIG
// ─────────────────────────────────────────────────────────────────────────────

const AES_KEY = "fnItrY2YfozBqCC2B4XsfqHIvZku3kUOq3DFkbO64kk=";
const AES_IV = "3YapeNfJDung7TXxeKXn4g==";
const BASE_URL = "https://ns-enterprise.cardbyte.ai/email-signature";

// The id standing for "the user's default (non-rule) signature".
// Replace with a real backend id when /html/outlook/get-active returns one;
// that removes the only remaining special case in resolveSigHtml().
const DEFAULT_ID = "default";

// localStorage / sessionStorage keys
const K_SESSION = "cardbyte_session_id";
const K_SIG_CACHE = "cardbyte_sig_cache";              // { [id]: { html, ts } }
const K_SIG_CACHE_LEGACY_DEFAULT = "cardbyte_cached_signature";
const K_RULES = "cardbyte_cached_rules";
const K_RULES_TS = "cardbyte_cached_rules_ts";
const K_ACTIVE_SIG = "cardbyte_active_sig_id";
const K_ACTIVE_SIG_TS = "cardbyte_active_sig_ts";

// Item custom properties — the cross-runtime channel (survives Mac's fresh
// WKWebView per event, unlike localStorage).
const P_ACTIVE_SIG = "cardbyte_active_sig_id";
const P_MANUAL_SIG = "cardbyte_manual_sig_id";
const P_COMPOSE_TYPE = "cardbyte_compose_type";
const P_RECIP_SNAPSHOT = "cardbyte_recip_snapshot";

// v7.5. Digest of the signature HTML that was actually written, so send time can
// tell "the user edited the signature" from "the signature changed on the server
// since compose". Purely informational — both outcomes re-insert — but without
// it every legitimate admin edit looks like tampering in the logs.
const P_SIG_DIGEST = "cardbyte_sig_digest";

// roamingSettings — mailbox-scoped, ~32KB total. Small values only; never HTML.
// NOTE (H): mailbox-scoped means CROSS-DEVICE. R_ACTIVE_SIG is a last-resort
// hint, never evidence about the item currently being composed.
const R_ACTIVE_SIG = "cb_active_sig";
const R_RULES = "cb_rules";
const R_RULES_TS = "cb_rules_ts";   // FIX (A): roamed rules were immortal without this
const R_RULES_MAX_BYTES = 20 * 1024;

const SIG_TTL_MS = 5 * 60 * 1000;
const SIG_PURGE_MS = 5 * 60 * 1000;
const RULES_TTL_MS = 5 * 60 * 1000;
const ACTIVE_SIG_MAX_AGE_MS = 1 * 60 * 1000;

// One size ceiling, actually enforced. v6 declared 500KB/200KB constants and
// then hardcoded 100KB in the apply path; observed rule signatures are ~42KB.
const MAX_SIG_BYTES = 100 * 1024;

// ─────────────────────────────────────────────────────────────────────────────
//  v7.5 — SEND-TIME VERIFICATION CONFIG
// ─────────────────────────────────────────────────────────────────────────────

// The attribute every written signature is wrapped in. Changing it orphans
// wrappers already sitting in open drafts; those degrade to the unmarked
// token-run path, so it is safe, just less precise for one compose session.
const SIG_MARK_ATTR = "data-cb-sig";

// Master switch. false = v7.4 behaviour: always rewrite at send. Turn this off
// first if a signature ever fails to appear on a sent mail — it isolates the
// entire feature in one flag.
const VERIFY_AT_SEND = true;

// Hosts without setSignatureAsync (mobile) can only APPEND. Re-inserting there
// leaves the tampered copy in place AND adds a correct one — two signatures on
// one mail, which reads as a broken add-in rather than an enforced policy.
//   false — detect and log only on append-only hosts (default)
//   true  — append the correct signature anyway
const APPEND_ON_TAMPER = false;

// Resolved once. html-content-signature.js must be concatenated ahead of this
// file into the deployed bundle (it is UMD and attaches to `self`); when it is
// absent, verification degrades to a no-op and v7.4 behaviour returns.
const HCS = typeof HtmlContentSignature !== "undefined" ? HtmlContentSignature : null;
const SIG_PROFILE = HCS ? HCS.PROFILES.body : null;

// Send budgets. FIX (K): "cold" is Mac AND mobile — both get a fresh runtime
// with empty localStorage per event, so both may have to fetch inside the send.
// const SEND_BUDGET_MS_COLD = 12_000;
// const SEND_BUDGET_MS = 5_000;
// const FETCH_BUDGET_MS = 2_500;
// const FETCH_BUDGET_MS_COLD = 5_000;
const SEND_BUDGET_MS_COLD = 20_000;
const SEND_BUDGET_MS = 10_000;

const FETCH_BUDGET_MS_COLD = 8_000;
const FETCH_BUDGET_MS = 5_000;
const COMPOSE_TYPE_TIMEOUT_MS = 1_500;

// Let OWA's recipient events settle before reading; avoids a burst of
// evaluations while an address is still being typed.
const RECIPIENT_SETTLE_MS = 350;

// FIX (E). Extra settle applied ONLY when the list has just become empty.
// Deleting the last recipient in order to retype it is the common case, and
// without this the body would churn rule -> default -> rule. This is the right
// place to widen if OWA still flickers on your build — do not go back to
// treating "empty" as "cannot evaluate".
const EMPTY_RECIP_SETTLE_MS = 400;

// FIX (I). This map exists because the backend accepts WINDOWS only — MAC and
// MOBILE come back non-2xx, which is what makes every fetch fail on those
// platforms. v7.1/v7.2 documented that collapse but shipped `MAC: "MAC"`, so it
// never actually happened; mobile resolves to MAC and was hit hardest.
// Empty this map — `{}` — once the API accepts the real values. If your backend
// DOES accept MAC, change this line back and re-test; nothing else depends on it.
const X_PLATFORM_MAP = { MAC: "MAC", MOBILE: "MAC", OWA: "WINDOWS" };

// PRODUCT DECISION, all platforms.
//   false: recipientType "internal" matches if ANY recipient is internal, so a
//          mixed To matches both the internal and external rules and priority
//          decides.
//   true : "internal" matches only when EVERY recipient is internal.
//
// Note both readings agree on an EMPTY list: hasInternal and hasExternal are
// false, so neither "internal" nor "external" matches and only an "all" rule
// (or the default) can win. That is deliberate — see (E) and (F).
const INTERNAL_REQUIRES_NO_EXTERNAL = false;

const NOTIF_KEY = "cardbyte_sig_status";

// FIX (M). The bar carries exactly two kinds of message:
//   • "Signature applied" — success, auto-cleared after NOTIFY_CLEAR_MS
//   • a failure reason    — raised only once the outcome is known, and left up
//                           (errorMessage is dismissed by the user, not by us)
// There is no progress chatter and no NOTIFY_LEVEL any more; per-phase timings
// are console-only via timed().
const NOTIFY_CLEAR_MS = 3000;
const MSG_APPLIED = "Signature applied";

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
//  v6 read Office.context.platform, which does not exist — it resolved to ""
//  and every classification fell through to a user-agent guess (and, with
//  X_PLATFORM_FORCE set, to the literal "WINDOWS"). The real property is
//  Office.context.diagnostics.platform (Mailbox 1.5+); UA stays as fallback.
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

    // diagnostics unavailable (requirement set < 1.5, or a stripped runtime).
    if (ua.includes("outlook-android")) return (_platform = "mobile-android");
    if (ua.includes("outlook-ios") || ua.includes("outlookmobile")) return (_platform = uaMobile() || "mobile-ios");
    const m = uaMobile();
    if (m) return (_platform = m);
    if (ua.includes("macintosh") || ua.includes("mac os x")) return (_platform = "mac");

    return (_platform = "owa");
}

const isMac = () => detectPlatform() === "mac";
const isMobile = () => detectPlatform().startsWith("mobile-");

// Fresh runtime per event, empty localStorage, slower network. Mac and mobile
// behave the same way here and get the same budgets — see (K).
const isColdRuntime = () => isMac() || isMobile();

function getXPlatform() {
    const p = detectPlatform();
    const base =
        p === "mac" ? "MAC" :
            // Outlook for iOS reports MAC: the backend has no iOS bucket, and
            // iOS shares the Apple/WebKit rendering path, so MAC is the closest
            // accepted value. Must precede the isMobile() branch, which would
            // otherwise claim it. Android still reports MOBILE.
            p === "mobile-ios" ? "MAC" :
                p === "owa" ? "OWA" :
                    isMobile() ? "MAC" :
                        "WINDOWS";
    return X_PLATFORM_MAP[base] || base;
}

// ─────────────────────────────────────────────────────────────────────────────
//  ASYNC UTILITIES
// ─────────────────────────────────────────────────────────────────────────────

// Note: this bounds how long we WAIT, it cannot cancel the underlying work.
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

// Wrap a callback-style Office API in a promise with a hard ceiling, resolving
// to `fallback` on failure or timeout so no caller can hang.
//
// IMPORTANT (E): callers that must distinguish "the host answered with nothing"
// from "the host did not answer" have to inspect the resolved value, not the
// payload inside it — on failure this resolves to `fallback`, which is null by
// default. getRecipients depends on exactly that.
function officeAsync(fn, { ms = COMPOSE_TYPE_TIMEOUT_MS, fallback = null, label = "office call" } = {}) {
    return new Promise((resolve) => {
        let done = false;
        const finish = (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
        const timer = setTimeout(() => { warn(`${label} timed out after ${ms}ms`); finish(fallback); }, ms);
        try {
            fn((res) => {
                if (res?.status !== Office.AsyncResultStatus.Succeeded) {
                    warn(`${label} failed:`, res?.error?.message);
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

// ─────────────────────────────────────────────────────────────────────────────
//  WRITE TOKEN
//  Guards every body/state write against a newer decision made during an await.
//
//  FIX (N): taking a new seq also RESETS THE FAILURE LEDGER. A decision and the
//  failures reported against it are the same unit of work — an error from an
//  evaluation that has since been superseded must never surface against the new
//  one. beginWrite() is called at the top of every entry point, before any
//  fetch, which is exactly the boundary we want.
// ─────────────────────────────────────────────────────────────────────────────

let _writeSeq = 0;
const beginWrite = () => { clearFailures(); return ++_writeSeq; };
const isCurrent = (seq) => seq === _writeSeq;

// Recipient snapshot of the last evaluation in THIS runtime. Declared up here
// rather than between the entry points so it is unambiguously initialised
// before any handler can read it.
//
// "" is a real value (evaluated, no recipients) and must never be conflated
// with null (never read). Only ever assign a non-null snapshot to it.
let _lastSnapshot = "";

// ─────────────────────────────────────────────────────────────────────────────
//  NOTIFICATIONS
//
//  Two messages, one key, one writer (reportOutcome). Nothing in this file
//  should call showNotification/notifyError directly except reportOutcome —
//  everything else records a failure and lets the outcome be decided once.
// ─────────────────────────────────────────────────────────────────────────────

// `icon` is documented as required for type "informationalMessage" and is meant
// to be an image resource id from the manifest's <Resources><bt:Images>. OWA
// tolerates an unknown id and renders the message without an icon; Windows
// desktop is stricter. "none" is what shipped and works — to be robust across
// hosts, declare an image resource and put its id here.
const NOTIF_ICON = "none";

// Guards the auto-clear timer: it only clears the message it was scheduled for,
// so a later error can never be wiped by an earlier success's timeout.
let _notifSeq = 0;

function showNotification(item, message, type = "informationalMessage") {
    try {
        const nm = item?.notificationMessages;
        if (typeof nm?.replaceAsync !== "function") {
            warn("notificationMessages unavailable on this item — skipping:", message);
            return;
        }

        let msg = String(message || "");
        if (!msg) return;
        if (msg.length > 150) msg = `${msg.slice(0, 147)}...`; // host hard limit

        const details = { type, message: msg };
        if (type === "informationalMessage") {
            details.icon = NOTIF_ICON;
            details.persistent = false;
        }

        _notifSeq++;
        nm.replaceAsync(NOTIF_KEY, details, (r) => {
            if (r?.status === Office.AsyncResultStatus.Succeeded) return;
            // replaceAsync fails when the key is not present yet — add instead.
            try {
                nm.addAsync(NOTIF_KEY, details, (r2) => {
                    if (r2?.status !== Office.AsyncResultStatus.Succeeded) {
                        warn("notification failed:", r2?.error?.code, r2?.error?.message, details);
                    }
                });
            } catch (e) {
                warn("notification addAsync threw:", e);
            }
        });
    } catch (e) {
        warn("showNotification threw, ignoring:", e);
    }
}

function removeNotification(item) {
    try { item?.notificationMessages?.removeAsync?.(NOTIF_KEY, () => { }); } catch (_) { }
}

// Clear after a delay, but only if nothing newer has been shown since.
function clearNotificationSoon(item, ms = NOTIFY_CLEAR_MS) {
    const mine = _notifSeq;
    setTimeout(() => {
        if (mine === _notifSeq) removeNotification(item);
    }, ms);
}

// ─────────────────────────────────────────────────────────────────────────────
//  FAILURE LEDGER (N) / (O)
//
//  Any step may fail: the rules call, either signature call, their timeouts,
//  the size ceiling, or the body write itself. None of them notify at the point
//  of failure — they record here, and reportOutcome() raises ONE message when
//  the outcome is known. That is what makes "recovered from a failure" silent
//  and "applied, but the rules were unreachable" honest.
//
//  RANK breaks ties when several things go wrong in one run: the most specific
//  and most actionable message wins, and a fatal failure always outranks a
//  degradation. First writer wins within a rank, since the earliest failure is
//  usually the cause of the later ones.
// ─────────────────────────────────────────────────────────────────────────────

const FAILURES = {
    // ── FATAL: nothing was written to the body ────────────────────────────────
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
    // ── DEGRADED: something WAS applied, but the rules could not be consulted,
    //    so it may be the default where a rule should have won. Worth saying;
    //    not worth the fatal wording. Deliberately outcome-neutral, because
    //    this is reported both when the default was applied and when a
    //    previously applied signature was left in place.
    rules_offline: {
        rank: 2, fatal: false,
        msg: "Couldn't reach the signature service, so your signature rules weren't checked. Check your connection.",
    },
    rules_error: {
        rank: 2, fatal: false,
        msg: "Couldn't load your signature rules. Please contact Admin.",
    },
};

let _failure = null;          // { kind, rank, fatal, msg }
let _rulesFetchError = null;  // "offline" | "server" | null
let _reported = false;        // has a message actually been raised this run?

function clearFailures() {
    _failure = null;
    _rulesFetchError = null;
    _reported = false;
}

const hasFailure = () => _failure !== null;
const wasReported = () => _reported;

function recordFailure(kind, detail = "") {
    const f = FAILURES[kind];
    if (!f) { warn("recordFailure: unknown kind", kind); return; }
    warn(`failure recorded: ${kind}${detail ? ` — ${detail}` : ""}`);
    if (!_failure || f.rank > _failure.rank) _failure = { kind, ...f };
}

// A null/absent HTTP status means the request never got an answer (transport,
// CORS, timeout — prereq (a)); anything else is the server answering badly.
const failureKindFor = (status) => (status == null ? "offline" : "server");

// The rules call records its own outcome separately: whether it MATTERS depends
// on whether a cached ruleset covered for it, which only findMatchingRule knows.
const noteRulesFetchError = (kind) => { _rulesFetchError = kind; };
const rulesFailureKind = () => (_rulesFetchError === "offline" ? "rules_offline" : "rules_error");

/**
 * THE ONLY PLACE A NOTIFICATION IS RAISED.
 *
 * @param {"applied"|"failed"|"quiet"} outcome
 *   applied — the signature is on the body
 *   failed  — it is not, and no more specific failure was recorded
 *   quiet   — there was nothing to do (manual override, deferred mobile
 *             compose, blocked evaluation that kept a good signature)
 */
function reportOutcome(item, outcome) {
    // _reported is set only when something is actually put on the bar, so the
    // entry-point catch blocks can tell "nothing was said" from "already said".
    const show = (msg, type) => { _reported = true; showNotification(item, msg, type); };

    if (_failure) return show(_failure.msg, "errorMessage");
    if (outcome === "applied") {
        show(MSG_APPLIED, "informationalMessage");
        clearNotificationSoon(item);
        return;
    }
    if (outcome === "failed") return show(FAILURES.write_failed.msg, "errorMessage");
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
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
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

// v7.5 OPTIMISATION: memoised. The IV is static, so the ciphertext for a given
// email never changes — yet this was called once per API request, including
// once per id inside prefetchSignatures, each call paying a WebCrypto importKey
// + encrypt round trip. One entry is enough: the runtime serves one mailbox.
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
//  L1 memory (this runtime) / L2 localStorage (empty in Mac and mobile event
//  runtimes) / L3 roamingSettings (mailbox-scoped, so it reaches every runtime
//  AND every device, tiny budget).
// ─────────────────────────────────────────────────────────────────────────────

const _mem = new Map();

const store = {
    get(key) {
        if (_mem.has(key)) return _mem.get(key);
        try {
            const v = localStorage.getItem(key);
            if (v != null) { _mem.set(key, v); return v; }
        } catch (_) { }
        return null;
    },
    set(key, val) {
        _mem.set(key, val);
        try { localStorage.setItem(key, val); } catch (_) { }
    },
    remove(...keys) {
        keys.forEach((k) => _mem.delete(k));
        try { keys.forEach((k) => localStorage.removeItem(k)); } catch (_) { }
    },
    getJson(key) {
        try { const v = store.get(key); return v ? JSON.parse(v) : null; } catch (_) { return null; }
    },
    setJson(key, val) {
        try { store.set(key, JSON.stringify(val)); } catch (_) { }
    },
};

const roam = {
    get(key) {
        try { return Office?.context?.roamingSettings?.get(key) ?? null; } catch (_) { return null; }
    },
    set(key, val) {
        try {
            const rs = Office?.context?.roamingSettings;
            if (!rs) return;
            rs.set(key, val);
            rs.saveAsync(() => { });
        } catch (_) { }
    },
    remove(key) {
        try {
            const rs = Office?.context?.roamingSettings;
            if (!rs) return;
            rs.remove(key);
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

// ─────────────────────────────────────────────────────────────────────────────
//  SIGNATURE HTML CACHE — one id-keyed map, DEFAULT_ID included.
//  HTML is disposable: a miss costs a fetch, never correctness.
// ─────────────────────────────────────────────────────────────────────────────

// v7.5 OPTIMISATION: the map is parsed once and mutated in memory. read()
// previously JSON.parsed the FULL map — every cached signature's HTML, up to
// 100KB apiece — on every get/set/purge; prefetchSignatures alone triggered
// one full parse per candidate id. Writes still go straight through to
// localStorage; only the parse is cached. Single-runtime safe: nothing else in
// this runtime writes K_SIG_CACHE (the taskpane writes the LEGACY key, which
// is read directly below and never cached here).
let _sigMap = null;

const sigCache = {
    read() {
        if (_sigMap) return _sigMap;
        _sigMap = store.getJson(K_SIG_CACHE) || {};
        return _sigMap;
    },
    write(map) { _sigMap = map; store.setJson(K_SIG_CACHE, map); },

    get(id, { skipTtl = false } = {}) {
        const key = String(id);
        const entry = sigCache.read()[key];
        if (entry?.html) {
            if (skipTtl || Date.now() - entry.ts <= SIG_TTL_MS) return entry.html;
            log(`sig cache stale for id=${key}`);
        }
        // Migration: a warm default written by the taskpane build.
        if (key === DEFAULT_ID) {
            const legacy = store.get(K_SIG_CACHE_LEGACY_DEFAULT);
            if (legacy) { log("sig cache: using legacy default key"); return legacy; }
        }
        return null;
    },

    set(id, html) {
        if (!html) return;
        const map = sigCache.read();
        map[String(id)] = { html, ts: Date.now() };
        sigCache.write(map);
    },

    purge() {
        const map = sigCache.read();
        const now = Date.now();
        let n = 0;
        for (const id of Object.keys(map)) {
            if (now - (map[id]?.ts || 0) > SIG_PURGE_MS) { delete map[id]; n++; }
        }
        if (n) { sigCache.write(map); log(`purged ${n} stale signature cache entr${n === 1 ? "y" : "ies"}`); }
    },
};

// ─────────────────────────────────────────────────────────────────────────────
//  RULES CACHE — mirrored to roaming when small enough, so the Mac and mobile
//  send runtimes can evaluate without a network round trip.
//
//  FIX (A). Both tiers are now age-checked against the SAME TTL. v7.0 checked
//  only the local timestamp and then fell back to an untimestamped roamed copy,
//  so `getCachedRules()` could never return null once roaming had been written
//  — and null is what every caller uses to mean "go fetch". skipTtl still
//  accepts an aged copy: at send time a stale ruleset beats no ruleset.
// ─────────────────────────────────────────────────────────────────────────────

function readRoamedRules({ skipTtl = false } = {}) {
    try {
        const raw = roam.get(R_RULES);
        if (!raw) return null;
        const ts = parseInt(roam.get(R_RULES_TS) || "0", 10);
        if (!skipTtl && (!ts || Date.now() - ts > RULES_TTL_MS)) {
            log(`roamed rules stale (age=${ts ? Date.now() - ts : "unknown"}ms)`);
            return null;
        }
        return JSON.parse(raw);
    } catch (_) { return null; }
}

function getCachedRules({ skipTtl = false } = {}) {
    const ts = parseInt(store.get(K_RULES_TS) || "0", 10);
    if (skipTtl || (ts && Date.now() - ts <= RULES_TTL_MS)) {
        const local = store.getJson(K_RULES);
        if (local) return local;
    } else if (ts) {
        log(`rules cache stale (age=${Date.now() - ts}ms)`);
    }
    return readRoamedRules({ skipTtl });
}

function setCachedRules(rulesJson) {
    store.setJson(K_RULES, rulesJson);
    store.set(K_RULES_TS, Date.now().toString());
    try {
        const s = JSON.stringify(rulesJson);
        if (s.length <= R_RULES_MAX_BYTES) {
            roam.set(R_RULES, s);
            roam.set(R_RULES_TS, Date.now().toString());
        } else {
            // Drop the roamed copy rather than leaving an older, smaller
            // ruleset in place — a stale roam is worse than a cold fetch.
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
}

// Which tier answered, for the log line in findMatchingRule. Diagnostic only.
function describeRulesSource() {
    const ts = parseInt(store.get(K_RULES_TS) || "0", 10);
    if (store.getJson(K_RULES)) return `local (age=${ts ? Date.now() - ts : "?"}ms)`;
    const rts = parseInt(roam.get(R_RULES_TS) || "0", 10);
    if (roam.get(R_RULES)) return `roamed (age=${rts ? Date.now() - rts : "unknown"}ms)`;
    return "none";
}

// ─────────────────────────────────────────────────────────────────────────────
//  ITEM CUSTOM PROPERTIES
//  ONE shared handle per item, and saveAsync is AWAITED. v6 fired and forgot,
//  so a Send moments after compose could read a property that never landed —
//  and concurrent writers silently clobbered each other's keys.
// ─────────────────────────────────────────────────────────────────────────────

const _propsByItem = new WeakMap();

function getProps(item) {
    if (_propsByItem.has(item)) return _propsByItem.get(item);
    const p = officeAsync((cb) => item.loadCustomPropertiesAsync(cb), {
        ms: isColdRuntime() ? FETCH_BUDGET_MS_COLD : FETCH_BUDGET_MS,
        label: "loadCustomPropertiesAsync",
    }).then((res) => res?.value ?? null);
    _propsByItem.set(item, p);
    return p;
}

async function getItemProp(item, key) {
    try {
        const v = (await getProps(item))?.get(key);
        return v == null ? null : String(v);
    } catch (_) { return null; }
}

async function setItemProps(item, kv) {
    const props = await getProps(item);
    if (!props) return false;
    try {
        for (const [k, v] of Object.entries(kv)) {
            if (v == null) props.remove(k);
            else props.set(k, String(v));
        }
        const res = await officeAsync((cb) => props.saveAsync(cb), {
            ms: isColdRuntime() ? FETCH_BUDGET_MS_COLD : FETCH_BUDGET_MS,
            label: "customProps saveAsync",
        });
        return !!res;
    } catch (e) {
        warn("setItemProps threw:", e);
        return false;
    }
}

const getManualOverride = (item) => getItemProp(item, P_MANUAL_SIG);

// ─────────────────────────────────────────────────────────────────────────────
//  ACTIVE SIGNATURE ID (+ recipient snapshot)
//  This is the authoritative state. Item props are the primary channel;
//  localStorage and roaming are fallbacks.
// ─────────────────────────────────────────────────────────────────────────────

// `snapshot` may legitimately be "" (evaluated with no recipients). A null
// snapshot means we never got a reliable read, and the property is REMOVED
// rather than written — decideSendId then re-evaluates instead of trusting a
// comparison against a snapshot that was never taken. See (E).
async function markActiveSignature(item, id, snapshot = null, digest = null) {
    if (id == null) {
        store.remove(K_ACTIVE_SIG, K_ACTIVE_SIG_TS);
        roam.remove(R_ACTIVE_SIG);
    } else {
        store.set(K_ACTIVE_SIG, String(id));
        store.set(K_ACTIVE_SIG_TS, Date.now().toString());
        roam.set(R_ACTIVE_SIG, String(id));
    }
    if (!item) return;

    const kv = {
        [P_ACTIVE_SIG]: id == null ? null : String(id),
        [P_RECIP_SNAPSHOT]: id == null ? null : snapshot,
    };
    // v7.5: the digest rides the SAME saveAsync — a second awaited round trip
    // inside a cold send budget is a real cost. Cleared with the id; otherwise
    // only written when supplied, so callers that omit it leave it alone.
    if (id == null) kv[P_SIG_DIGEST] = null;
    else if (digest != null) kv[P_SIG_DIGEST] = String(digest);

    await setItemProps(item, kv);
}

/**
 * FIX (H). `allowRoam` exists because R_ACTIVE_SIG is MAILBOX-scoped, not
 * device-scoped: the id the desktop decided for some other mail roams to the
 * phone. On mobile, where no compose event runs and the item properties are
 * empty, that roamed value was the only thing left and got applied to an
 * unrelated item. Callers that successfully read the current recipient list
 * have enough information to decide locally and must pass allowRoam:false.
 */
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
//
//  FIX (O). No fetch function notifies. Each one reports WHAT went wrong to its
//  caller — `failure` for the signature calls, noteRulesFetchError for the
//  rules call — and resolveSigHtml / findMatchingRule decide whether it is
//  worth telling the user about.
// ─────────────────────────────────────────────────────────────────────────────

function apiHeaders(encryptedMail, extra = {}) {
    return { username: encryptedMail, "X-Platform": getXPlatform(), ...extra };
}

async function fetchRules(encryptedMail) {
    const xp = getXPlatform();
    try {
        const res = await fetch(`${BASE_URL}/rules-config/get-active`, {
            method: "GET",
            headers: apiHeaders(encryptedMail, { "Content-Type": "application/json" }),
        });
        if (!res.ok) {
            // Status is logged WITH the platform header: a 4xx that disappears
            // when X-Platform is WINDOWS is fix (I), not a backend outage.
            let body = "";
            try { body = (await res.text()).slice(0, 200); } catch (_) { }
            warn(`rules fetch returned ${res.status} (X-Platform=${xp})`, body);
            noteRulesFetchError(failureKindFor(res.status));
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
        // "TypeError: Load failed" in a cold runtime means the well-known
        // allowlist / CORS setup is wrong. See header prereq (a).
        err(`fetchRules failed (X-Platform=${xp}):`, e);
        noteRulesFetchError("offline");
        return null;
    }
}

// Default signature. Returns { html, explicit, failure }:
//   explicit — the server gave a definitive answer, so an empty result means
//              "unassigned", not "unknown".
//   failure  — ledger kind for a genuine failure, or null. A 404 is NOT a
//              failure here: it is the definitive "nothing assigned" answer,
//              and resolveSigHtml turns that into the unassigned message.
async function fetchDefaultSignature(encryptedMail) {
    const xp = getXPlatform();
    try {
        const res = await fetch(`${BASE_URL}/html/outlook/get-active`, {
            method: "GET",
            headers: apiHeaders(encryptedMail),
        });
        if (!res.ok) {
            let msg = "";
            try { const b = JSON.parse(await res.text()); msg = String(b?.message || b?.error || ""); } catch (_) { }
            warn(`default signature fetch failed: ${res.status} (X-Platform=${xp})`, msg);
            const notFound = res.status === 404 || /not\s*found/i.test(msg);
            return {
                html: null,
                explicit: notFound,
                failure: notFound ? null : failureKindFor(res.status),
            };
        }
        let html = null;
        try {
            html = JSON.parse(await aesDecrypt(await res.text()))?.html;
        } catch (e) {
            // 2xx that we cannot read is a server-side problem, not a network one.
            warn("default signature response unreadable:", e.message);
            return { html: null, explicit: false, failure: "server" };
        }
        return { html, explicit: true, failure: null };
    } catch (e) {
        warn(`fetchDefaultSignature crashed (X-Platform=${xp}):`, e);
        return { html: null, explicit: false, failure: "offline" };
    }
}

// Same { html, explicit, failure } shape as fetchDefaultSignature so
// resolveSigHtml can treat both uniformly.
async function fetchSignatureById(id, encryptedMail) {
    try {
        const res = await fetch(`${BASE_URL}/rules-config/get/${encodeURIComponent(id)}`, {
            method: "GET",
            headers: apiHeaders(encryptedMail),
        });
        if (!res.ok) {
            err(`signature fetch failed id=${id}: ${res.status} (X-Platform=${getXPlatform()})`);
            const notFound = res.status === 404;
            return {
                html: null,
                explicit: notFound,
                failure: notFound ? null : failureKindFor(res.status),
            };
        }
        let html = null;
        try {
            html = JSON.parse(await aesDecrypt(await res.text()))?.html || null;
        } catch (e) {
            warn(`signature response unreadable id=${id}:`, e.message);
            return { html: null, explicit: false, failure: "server" };
        }
        if (!html) warn("signature HTML empty for id:", id);
        return { html, explicit: true, failure: null };
    } catch (e) {
        err(`fetchSignatureById crashed id=${id}:`, e);
        return { html: null, explicit: false, failure: "offline" };
    }
}

/**
 * THE CORE OF THE ID-AS-STATE DESIGN: id -> HTML, cache then network.
 *
 * `unassigned` distinguishes "the server answered definitively and there is no
 * signature for this user" (an admin problem) from "we could not reach or parse
 * the server" (a transient problem). The two need different messages — without
 * the distinction a misconfiguration is indistinguishable from flaky network.
 *
 * FIX (O). This is where an API failure becomes a user-facing failure, via the
 * ledger. `silent` exists for background callers (prefetch): a warm-up that
 * fails has not affected the mail in front of the user and must not notify.
 *
 * @returns {Promise<{ html: string|null, source: "cache"|"network"|"none", unassigned: boolean }>}
 */
async function resolveSigHtml(id, userEmail, { allowNetwork = true, budgetMs = null, silent = false } = {}) {
    const key = String(id);
    const budget = budgetMs ?? (isColdRuntime() ? FETCH_BUDGET_MS_COLD : FETCH_BUDGET_MS);
    const fail = (kind, detail) => { if (!silent) recordFailure(kind, detail); };

    // FIX (C) belt-and-braces: a rule that slipped through with no signatureId
    // would otherwise be requested as the literal "null" / "undefined".
    if (!key || key === "null" || key === "undefined") {
        warn("resolveSigHtml called with a non-id — refusing to fetch:", key);
        // A configuration fault, not a transport one: nothing the user can retry.
        fail("server", `non-id "${key}"`);
        return { html: null, source: "none", unassigned: false };
    }

    const cached = sigCache.get(key, { skipTtl: true });
    if (cached) return { html: cached, source: "cache", unassigned: false };

    if (!allowNetwork || !userEmail) {
        warn(`cannot resolve id=${key} (allowNetwork=${allowNetwork}, user=${!!userEmail})`);
        fail("offline", "no network permitted or no user email");
        return { html: null, source: "none", unassigned: false };
    }

    try {
        const enc = await encryptEmail(userEmail);
        const { html, explicit, failure } = key === DEFAULT_ID
            ? await withTimeout(fetchDefaultSignature(enc), budget, "default fetch")
            : await withTimeout(fetchSignatureById(key, enc), budget, `sig fetch ${key}`);
        if (html) {
            sigCache.set(key, html);
            return { html, source: "network", unassigned: false };
        }
        // Definitive empty answer = nothing is assigned server-side.
        if (explicit) {
            fail("unassigned", `id=${key}`);
            return { html: null, source: "none", unassigned: true };
        }
        fail(failure || "server", `id=${key}`);
        return { html: null, source: "none", unassigned: false };
    } catch (e) {
        // withTimeout rejected: the call never came back inside the budget.
        warn(`resolveSigHtml failed id=${key}:`, e.message);
        fail("offline", `id=${key} ${e.message}`);
        return { html: null, source: "none", unassigned: false };
    }
}

// Revalidate in the background and refresh the cache. Returns fresh HTML only
// when it actually differs from what we already applied.
//
// Silent on purpose (O): the user already has a signature on the mail, and a
// failed revalidation does not change that. Failures are logged, not reported.
async function revalidateSigHtml(id, userEmail, appliedHtml) {
    const key = String(id);
    try {
        const enc = await encryptEmail(userEmail);
        const { html } = key === DEFAULT_ID
            ? await fetchDefaultSignature(enc)
            : await fetchSignatureById(key, enc);
        if (!html) return null;
        sigCache.set(key, html);
        return html === appliedHtml ? null : html;
    } catch (e) {
        warn(`revalidate failed id=${key}:`, e.message);
        return null;
    }
}

/**
 * FIX (J). DEFAULT_ID is warmed on EVERY platform, mobile included.
 *
 * The default is the id most likely to be needed at the worst possible moment:
 * a rule matched at compose (so only the rule's HTML got cached), the user then
 * clears the To line, and the correct answer flips to the one id nobody
 * fetched — on a cold runtime, inside the send budget. Rule signatures stay off
 * mobile for bandwidth; the single default is worth it.
 *
 * Silent (O): this is speculative warm-up. If it fails, the id will be fetched
 * again when it is actually needed, and THAT failure is the one worth showing.
 */
async function prefetchSignatures(userEmail, { includeRules = true } = {}) {
    const ids = [];

    if (includeRules) {
        const rulesJson = getCachedRules({ skipTtl: true });
        for (const r of enabledRulesWithSignatures(rulesJson)) {
            const id = String(r.signatureId);
            if (!ids.includes(id)) ids.push(id);
        }
    }
    if (!ids.includes(DEFAULT_ID)) ids.push(DEFAULT_ID);

    const missing = ids.filter((id) => !sigCache.get(id, { skipTtl: true }));
    if (!missing.length) return;
    log(`prefetching ${missing.length} signature(s):`, missing.join(", "));
    await Promise.allSettled(missing.map((id) => resolveSigHtml(id, userEmail, { silent: true })));
}

// ─────────────────────────────────────────────────────────────────────────────
//  RECIPIENTS
//
//  FIX (E). THE RETURN CONTRACT IS THREE-VALUED, AND CALLERS DEPEND ON IT:
//     null  — the host did not answer (timeout, error, unsupported item).
//             Nothing can be concluded; do not evaluate, do not snapshot.
//     []    — the host answered: there are no recipients. This is a RESULT.
//             Rules evaluate against it normally and the default wins.
//     [...] — the host answered with recipients.
//
//  v7.1 collapsed the first two into [] and then treated any empty list as
//  "cannot evaluate", which pinned a rule signature to the body forever once
//  the user cleared the To line. Keep the three states distinct.
//
//  NOTE: a failed recipient read is a HOST failure, not an API failure, and it
//  is not reported on its own — it surfaces as the rules/blocked path deciding
//  to keep whatever is already on the body.
// ─────────────────────────────────────────────────────────────────────────────

async function getRecipients(field) {
    const res = await officeAsync((cb) => field.getAsync(cb), {
        // FIX (K): cold runtimes are slower; 2.5s was turning slow mobile reads
        // into "unreadable", which blocks evaluation entirely.
        ms: isColdRuntime() ? FETCH_BUDGET_MS_COLD : FETCH_BUDGET_MS,
        label: "recipients getAsync",
    });
    // officeAsync resolves to its fallback (null) on failure/timeout; a
    // successful result with no recipients has .value === [].
    return res ? (res.value || []) : null;
}

async function getAllRecipientEmails(item) {
    if (!item?.to?.getAsync) return null;

    const [to, cc] = await Promise.all([
        getRecipients(item.to),
        item.cc?.getAsync ? getRecipients(item.cc) : Promise.resolve([]),
    ]);

    // A failed To read makes the whole picture unusable. A failed Cc read is
    // survivable — To alone already decides internal/external in every shipped
    // rule — so it degrades to an empty Cc rather than poisoning the result.
    if (to === null) return null;
    if (cc === null) warn("cc read failed — evaluating against To only");

    return [...new Set(
        [...to, ...(cc || [])].map((r) => (r.emailAddress || "").toLowerCase().trim()).filter(Boolean)
    )];
}

/**
 * FIX (K). Cold runtimes (Mac AND mobile) sometimes answer null or an empty
 * list on the first read of a list that is in fact populated. Retry once, and
 * prefer the retry only if it actually answered — a null retry must never
 * overwrite a good first read.
 */
async function readRecipientEmails(item) {
    let emails = await getAllRecipientEmails(item);
    if ((emails === null || emails.length === 0) && isColdRuntime()) {
        await sleep(400);
        const retry = await getAllRecipientEmails(item);
        if (retry !== null) emails = retry;
    }
    return emails;
}

// Preserves the three-valued contract: null in, null out. "" means "evaluated,
// no recipients" and is a legitimate snapshot value to persist and compare.
const serializeRecipients = (emails) => (emails === null ? null : [...emails].sort().join(","));

// ─────────────────────────────────────────────────────────────────────────────
//  COMPOSE TYPE
//  Resolution order: this runtime's cache -> the item property written at
//  compose -> live detection. Step 2 is what lets a cold send runtime inherit
//  the compose runtime's answer instead of re-deriving it from an API that
//  misreports (Mac) or is absent (mobile). Unknown is null, never a silent
//  "compose".
//
//  ON MOBILE STEP 2 IS USUALLY EMPTY, because no compose-time event runs to
//  write it — which is why findMatchingRule must not treat an unknown compose
//  type as fatal on its own. See (F).
// ─────────────────────────────────────────────────────────────────────────────

const _composeTypeByItem = new WeakMap();

// Multi-letter reply/forward prefixes. Bare "R:"/"I:" are deliberately absent:
// a false positive would misclassify a new mail as a reply.
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

    // The heuristic may only ever promote to "reply".
    if (REPLY_PREFIX_RE.test(subject)) {
        log("composeType inferred 'reply' from subject prefix");
        return "reply";
    }
    // A subject with no reply prefix is weak evidence of a new mail — not good
    // enough at send time, where guessing wrong overwrites a correct signature.
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

    let t = await detectComposeType(item, strict);
    if (!t && !strict) {
        warn("composeType undetermined — assuming 'compose' (non-strict caller)");
        t = "compose";
    }
    if (t) {
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

/**
 * FIX (C). The ONE place that decides which rules are candidates — the React
 * taskpane's equivalent filter is `r.enabled && r.signatureId`, and the two
 * must agree or the pane and the mail disagree about which rule wins.
 *
 * A rule with no signatureId is not a usable rule: it would match, resolve to
 * the string "null", 404, and — worse — shadow the lower-priority rule that
 * should have applied. Priority is coerced because a missing one yields NaN,
 * and a comparator that returns NaN leaves Array#sort free to order however it
 * likes, i.e. an arbitrary "highest priority" match.
 */
function enabledRulesWithSignatures(rulesJson) {
    const all = (rulesJson?.rulesList || []).filter((r) => r && r.enabled);
    const usable = all.filter(
        (r) => r.signatureId != null && String(r.signatureId).trim() !== ""
    );
    const dropped = all.length - usable.length;
    if (dropped) {
        warn(`${dropped} enabled rule(s) have no signatureId — ignored`,
            all.filter((r) => !usable.includes(r)).map((r) => r.rule ?? r.priority));
    }
    return usable.sort((a, b) => (Number(a.priority) || 0) - (Number(b.priority) || 0));
}

// With zero recipients both flags are false, so "internal" and "external" both
// fail and only "all" (or no recipientType) can match — which is exactly the
// behaviour that returns an emptied mail to the default signature. See (E).
function recipientTypeMatches(recipientType, hasInternal, hasExternal) {
    const rt = (recipientType || "").toLowerCase().trim();
    if (!rt || rt === "all") return true;
    if (rt === "internal") return INTERNAL_REQUIRES_NO_EXTERNAL ? hasInternal && !hasExternal : hasInternal;
    if (rt === "external") return hasExternal;
    return true;
}

// A rule that applies regardless of reply/compose. These can be decided without
// knowing the compose type at all — the hinge of fix (F).
function isContextAgnostic(rule) {
    const rc = (rule?.context || "").toLowerCase().trim();
    return !rc || rc === "all";
}

function contextMatches(ruleContext, composeType) {
    const rc = (ruleContext || "").toLowerCase().trim();
    if (!rc || rc === "all") return true;
    if (!composeType) return false; // conservative: never match on an unknown
    return rc === composeType.toLowerCase();
}

function senderMatches(rule, senderEmail) {
    if (!rule.Senders?.length) return true;
    const sender = (senderEmail || "").toLowerCase().trim();
    return rule.Senders.some((raw) => {
        const s = (raw || "").toLowerCase().trim();
        if (s === "*" || s === "all") return true;
        if (s.startsWith("*@")) return sender.endsWith(s.slice(1));
        return s === sender;
    });
}

/**
 * @returns {Promise<{ rule: object|null, blocked: boolean }>}
 *   blocked = we could not evaluate safely, so the caller must NOT treat a null
 *   rule as "the default applies".
 *
 *   FIX (E): an EMPTY but successfully read recipient list is NOT blocked. No
 *   recipient can be internal or external, so recipient-scoped rules drop out
 *   and `{ rule: null, blocked: false }` tells the caller the default applies.
 *
 *   FIX (F): NEITHER IS AN UNKNOWN COMPOSE TYPE, unless it can actually change
 *   the answer. Sender and recipient are filtered first; the compose type is
 *   consulted only when a surviving candidate is context-scoped. This is what
 *   makes mobile work — getComposeTypeAsync does not exist there, and the old
 *   unconditional bail-out sent every send-time evaluation down the "reuse the
 *   persisted rule id" path, which is precisely the reported bug.
 *
 *   FIX (O): "no rules available at all" is the one rules failure worth
 *   reporting, and it is recorded HERE rather than in fetchRules — a failed
 *   fetch that a cached ruleset covered for changed nothing the user can see.
 *   It is recorded as a DEGRADATION, not a fatal error: a signature still gets
 *   applied, it just may not be the one a rule wanted.
 */
async function findMatchingRule(item, senderEmail, {
    allowNetwork = false,
    budgetMs = null,
    strictComposeType = false,
    persistComposeType = false,
} = {}) {
    const budget = budgetMs ?? (isColdRuntime() ? FETCH_BUDGET_MS_COLD : FETCH_BUDGET_MS);

    let rulesJson = getCachedRules({ skipTtl: strictComposeType });
    let source = rulesJson ? describeRulesSource() : "none";

    if (!rulesJson && allowNetwork && senderEmail) {
        warn("rules not cached — live fetch");
        const enc = await encryptEmail(senderEmail);
        rulesJson = await withTimeout(fetchRules(enc), budget, "rules fetch")
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
        // Deliberately NOT blocked — see (E).
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

    // Everything decidable WITHOUT the compose type, in priority order.
    const candidates = rules.filter(
        (r) => senderMatches(r, senderEmail) && recipientTypeMatches(r.recipientType, hasInternal, hasExternal)
    );

    log("rule evaluation:", {
        version: CB_VERSION,
        platform: detectPlatform(),
        xPlatform: getXPlatform(),
        rulesSource: source,          // local / roamed / network — with age
        strict: strictComposeType,
        senderDomain,
        recipients: emails.length,
        hasInternal,
        hasExternal,
        domains,
        rules: rules.length,
        candidates: candidates.length,
    });

    // FIX (F), part 1. Nothing survives sender+recipient, so no rule can match
    // whatever the compose type turns out to be. The default applies, and this
    // is NOT a blocked evaluation. On an empty recipient list this is the usual
    // outcome, since internal/external rules all drop out here.
    if (!candidates.length) {
        log("no rule can match this recipient set — default applies");
        if (persistComposeType) {
            // Still worth recording for the send runtime; not worth waiting for.
            getComposeType(item, { persist: true }).catch(() => { });
        }
        return { rule: null, blocked: false };
    }

    const composeType = await getComposeType(item, {
        strict: strictComposeType,
        persist: persistComposeType,
    });

    // FIX (F), part 2. Compose type is unknown (mobile, or a strict caller with
    // no persisted property). If the top candidate does not care about context,
    // it wins anyway. Only when it does care is this genuinely undecidable.
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
        log(
            c ? ">>> MATCH" : "    skip ",
            `| priority=${r.priority} | context=${r.context}(${c})`,
            `| recipientType=${r.recipientType} | sigId=${r.signatureId}`
        );
        if (c) return { rule: r, blocked: false };
    }

    log("no rule matched — default applies");
    return { rule: null, blocked: false };
}

// ─────────────────────────────────────────────────────────────────────────────
//  SIGNATURE VERIFICATION (v7.5)
//
//  Reads the draft, finds our signature block, and reports whether it is still
//  the one we put there. Never writes, never records a failure: a verification
//  problem is not a user-facing problem, it just means "rewrite as before".
//
//  WHY WRAP WHAT WE WRITE: there is no Office API for "give me the signature
//  block". body.getAsync returns the whole draft, and setSignatureAsync does
//  not put the block at the end — on a reply it sits ABOVE the quoted original
//  — so nothing positional can be relied on. Every write is therefore wrapped
//  in <div data-cb-sig="{id}">. Drafts written by v7.4 have no wrapper; those
//  fall back to a token-run search over the whole body.
//
//  WHAT IS COMPARED (HtmlContentSignature.PROFILES.body):
//    IN : visible text, link hrefs, image identity and order, block structure.
//    OUT: <style> bodies, inline CSS, <script>, cid:/blob:/data: URLs.
//  Excluded because the Word/OWA editors rewrite CSS wholesale and Outlook
//  rewrites remote <img src> to cid: attachment references the moment a
//  signature is inserted — including them reports every desktop draft as
//  tampered. A purely cosmetic CSS edit is therefore not detected; accepted
//  deliberately, since a signature attack has to change text, a link, or an
//  image to be worth mounting.
// ─────────────────────────────────────────────────────────────────────────────

function escAttr(v) {
    return String(v)
        .replace(/&/g, "&amp;")
        .replace(/"/g, "&quot;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

// Deliberately a bare <div> with one data attribute: no id (would collide if a
// mail somehow carried two), no class, no styling that could alter layout.
const wrapSignature = (html, id) => `<div ${SIG_MARK_ATTR}="${escAttr(id)}">${html}</div>`;

// null = could not read (host lacks the API, or the call failed/timed out).
// "" is a legitimate value: an empty draft body.
async function readBodyHtml(item) {
    if (typeof item?.body?.getAsync !== "function") return null;
    const res = await officeAsync(
        (cb) => item.body.getAsync(Office.CoercionType.Html, cb),
        { ms: isColdRuntime() ? FETCH_BUDGET_MS_COLD : FETCH_BUDGET_MS, label: "body getAsync" }
    );
    return res ? String(res.value ?? "") : null;
}

/**
 * Is `expectedHtml` still intact on the draft?
 *
 * @returns {Promise<{verdict:string, reason:string, note:string}>}
 *   identical  — untouched. The ONLY verdict that suppresses the write.
 *   modified   — recognisably our signature, edited.
 *   absent     — not on the body at all (normal on mobile, where nothing is
 *                written at compose; also "the user deleted it").
 *   duplicate  — more than one signature block present.
 *   id-changed — the block belongs to a different signature id, so the
 *                difference is explained by the id changing, not by an edit.
 *   unknown    — could not tell. Treated as "write it".
 */
async function verifySignatureOnBody(item, expectedHtml, id) {
    if (!VERIFY_AT_SEND) return { verdict: "unknown", reason: "verification disabled", note: "" };
    if (!HCS) return { verdict: "unknown", reason: "signature module not loaded", note: "" };

    const body = await readBodyHtml(item);
    if (body === null) return { verdict: "unknown", reason: "body unreadable on this host", note: "" };

    // Did the expected copy itself change since compose? If so, a mismatch
    // below is an admin edit propagating, not a user tampering.
    let note = "";
    try {
        const prev = await getItemProp(item, P_SIG_DIGEST);
        if (prev && prev !== HCS.digest(expectedHtml, SIG_PROFILE)) {
            note = "expected copy changed since compose (server-side update, not an edit)";
        }
    } catch (_) { }

    const regions = HCS.extractMarkedRegions(body, SIG_MARK_ATTR);

    if (regions.length > 1) {
        return { verdict: "duplicate", reason: `${regions.length} signature blocks on the body`, note };
    }
    if (regions.length === 1) {
        if (String(regions[0].value) !== String(id)) {
            return { verdict: "id-changed", reason: `body has id=${regions[0].value}, target=${id}`, note };
        }
        const r = HCS.verifyExact(expectedHtml, regions[0].inner, SIG_PROFILE);
        return { verdict: r.verdict, reason: `marked block, overlap=${r.overlap.toFixed(2)}`, note };
    }

    // No wrapper: a v7.4 draft, or the host's HTML filter dropped the
    // attribute. Search for the token run anywhere in the body instead — less
    // precise about WHICH copy it found, but enough to answer "is an intact
    // copy present".
    const r = HCS.verifyRegion(expectedHtml, body, SIG_PROFILE);
    return { verdict: r.verdict, reason: `unmarked body, overlap=${r.overlap.toFixed(2)}`, note };
}

// ─────────────────────────────────────────────────────────────────────────────
//  BODY WRITES
//  setSignatureAsync REPLACES the signature block, so reapplying the same id is
//  idempotent. appendOnSendAsync is a send-time-only fallback for hosts without
//  setSignatureAsync (Mailbox < 1.10, and Outlook mobile) — it appends, hence
//  the failure guard.
// ─────────────────────────────────────────────────────────────────────────────

// Hosts without setSignatureAsync cannot write anything at compose time; the
// write has to wait for appendOnSendAsync at send. Mobile is the case that
// matters — see (L).
const hostCanSetSignature = (item) => typeof item?.body?.setSignatureAsync === "function";

/**
 * FIX (N). Records failures instead of notifying. `silent` is for the
 * background revalidation rewrite, which happens after the outcome has already
 * been reported and must not retroactively colour it.
 */
async function writeSignature(item, html, { isSendTime = false, silent = false, sigId = null } = {}) {
    const fail = (kind, detail) => { if (!silent) recordFailure(kind, detail); };

    // v7.5: wrap so send time can find this block again. The wrapper counts
    // towards MAX_SIG_BYTES because it is part of what goes on the mail.
    const payload = sigId == null ? html : wrapSignature(html, sigId);

    const bytes = new Blob([payload]).size;
    if (bytes > MAX_SIG_BYTES) {
        warn(`signature ${bytes}B exceeds ${MAX_SIG_BYTES}B — not applying`);
        fail("too_large", `${bytes}B > ${MAX_SIG_BYTES}B`);
        return false;
    }

    if (hostCanSetSignature(item)) {
        const res = await officeAsync(
            (cb) => item.body.setSignatureAsync(payload, { coercionType: Office.CoercionType.Html }, cb),
            { ms: isColdRuntime() ? FETCH_BUDGET_MS_COLD : FETCH_BUDGET_MS, label: "setSignatureAsync" }
        );
        if (res) { log(`signature written (${bytes}B)`); return true; }
    } else if (!isSendTime) {
        // FIX (L). Not an error, and not the user's problem: this host defers
        // all signature writing to send. Record NOTHING, notify NOTHING, and let
        // the decision be persisted so the send runtime can act on it.
        log("setSignatureAsync unavailable at compose on this host — deferring the write to send");
        return false;
    } else {
        warn("setSignatureAsync unavailable on this host");
    }

    if (isSendTime && typeof item.body?.appendOnSendAsync === "function") {
        const res = await officeAsync(
            (cb) => item.body.appendOnSendAsync(payload, { coercionType: Office.CoercionType.Html }, cb),
            { ms: isColdRuntime() ? FETCH_BUDGET_MS_COLD : FETCH_BUDGET_MS, label: "appendOnSendAsync" }
        );
        if (res) { log("signature appended via appendOnSendAsync"); return true; }
    }

    fail("write_failed", isSendTime ? "setSignatureAsync/appendOnSendAsync" : "setSignatureAsync");
    return false;
}

/**
 * Apply the signature for `id`, guarded by the write token.
 * Fast path applies a cached copy immediately; revalidation rewrites only if
 * the server copy differs AND no newer decision has been made meanwhile.
 *
 * FIX (M)/(N). No notifications here at all — not the old "Loading your
 * signature...", not the success, not the errors. It returns a boolean and
 * leaves the ledger populated; the caller reports once.
 */
async function applyById(item, id, userEmail, seq, { revalidate = false, isSendTime = false } = {}) {
    const key = String(id);
    const t0 = Date.now();
    const nothing = (status) => ({ applied: false, status, verdict: null, digest: null });

    // Nothing can be written at compose on this host — do not fetch, do not
    // record. evaluateAndApply still persists the id for the send runtime (L).
    if (!isSendTime && !hostCanSetSignature(item)) {
        log(`host cannot write at compose — id=${key} decided but not applied yet`);
        return nothing("deferred");
    }

    const { html, source, unassigned } = await resolveSigHtml(key, userEmail, {
        budgetMs: isSendTime ? (isColdRuntime() ? FETCH_BUDGET_MS_COLD : FETCH_BUDGET_MS) : 10_000,
    });

    if (!html) {
        // Never blank the body or substitute a guess: whatever is there already
        // is better than nothing. resolveSigHtml has already recorded WHY —
        // unassigned / offline / server — so the message is specific.
        warn(`could not resolve id=${key} (unassigned=${unassigned}) — leaving body as-is`);
        if (!hasFailure()) recordFailure("offline", `unresolved id=${key}`);
        return nothing("failed");
    }
    if (!isCurrent(seq)) { log(`stale write dropped (seq=${seq}, current=${_writeSeq})`); return nothing("stale"); }

    const digest = HCS ? HCS.digest(html, SIG_PROFILE) : null;
    let sendVerdict = null;

    // ── v7.5. THE ONLY NEW DECISION IN THE APPLY PATH ────────────────────────
    // At send, compare before writing; an untouched draft is not written to.
    // Compose still writes unconditionally: it is the runtime that PUTS the
    // signature there, it has just decided the id, and setSignatureAsync is
    // idempotent anyway.
    if (isSendTime) {
        const v = await verifySignatureOnBody(item, html, key);
        sendVerdict = v.verdict;
        log(`send verify id=${key}: ${v.verdict} (${v.reason})${v.note ? ` — ${v.note}` : ""}`);

        if (v.verdict === "identical") {
            log("draft signature matches — leaving the body untouched");
            timed(`applyById (${key}, unchanged)`, t0);
            return { applied: true, status: "unchanged", verdict: v.verdict, digest };
        }

        // Append-only host and something IS there but wrong: appending would
        // produce two signatures on one mail. Report, do not duplicate.
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

    if (revalidate && source === "cache" && userEmail && !isSendTime) {
        // Background only — never blocks the user, never races the token, and
        // never touches the notification bar or the ledger.
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
//  Everything at compose time funnels through here: pick an id, apply it once,
//  persist it, and report ONCE. Replaces v6's applySignatureCore +
//  onRecipientsChanged pair, which each wrote the body independently.
// ─────────────────────────────────────────────────────────────────────────────

async function evaluateAndApply(item, mailbox, seq, { allowNetwork = true } = {}) {
    const t0 = Date.now();
    const userEmail = mailbox?.userProfile?.emailAddress;

    const override = await getManualOverride(item);
    if (override) {
        // The user chose this signature themselves; we have neither news nor a
        // complaint. Leave the bar exactly as it is.
        log("manual override active — leaving signature untouched:", override);
        return;
    }

    const { rule, blocked } = await findMatchingRule(item, userEmail, {
        allowNetwork,
        persistComposeType: true,
    });

    if (blocked) {
        // Could not evaluate (no rules, unreadable recipients, or a genuinely
        // undecidable context-scoped candidate). Do NOT reset the body to the
        // default — that was v6's mid-typing flicker. An EMPTY recipient list no
        // longer lands here, and neither does an unknown compose type on its
        // own; see (E) and (F).
        const active = await getItemProp(item, P_ACTIVE_SIG);
        if (active) {
            log("evaluation blocked — keeping active id:", active);
            // Nothing changed on the body, but if the reason we are blocked is
            // that the API is unreachable, the user should know the rules were
            // never checked. reportOutcome stays silent when the ledger is empty.
            if (isCurrent(seq)) reportOutcome(item, "quiet");
            return;
        }
        log("evaluation blocked and nothing applied yet — applying default");
    }

    const targetId = rule ? String(rule.signatureId) : DEFAULT_ID;
    if (!isCurrent(seq)) { log("stale evaluation dropped"); return; }

    const result = await applyById(item, targetId, userEmail, seq, { revalidate: true });
    const applied = result.applied;

    // FIX (L). Persist the decision even when this host could not write it yet
    // (mobile has no setSignatureAsync). Without this the compose-time decision
    // was discarded and the send runtime had to start from nothing.
    const deferred = result.status === "deferred";
    if ((applied || deferred) && isCurrent(seq)) {
        // May be null if the post-apply read failed; markActiveSignature then
        // removes the snapshot property so send time re-evaluates rather than
        // comparing against something we never measured.
        const snapshot = serializeRecipients(await readRecipientEmails(item));
        // v7.5: the digest travels with the id, so send time can distinguish a
        // server-side update from a user edit. Null on a deferred compose —
        // nothing was written, so there is nothing to have a digest of.
        await markActiveSignature(item, targetId, snapshot, result.digest);
        if (deferred) log(`id=${targetId} persisted for the send runtime to apply`);
    }

    // ONE message for the whole evaluation (N). A deferred compose is "quiet":
    // nothing is wrong, the write simply happens at send.
    if (isCurrent(seq)) {
        reportOutcome(item, applied ? "applied" : deferred ? "quiet" : "failed");
    }
    timed(`evaluateAndApply (${targetId})`, t0);
}

// ─────────────────────────────────────────────────────────────────────────────
//  SEND
//  Phase 1 decides an id with no body writes. Phase 2 resolves and writes once.
//  On mobile this is the ONLY phase that runs — no compose-time event fires
//  there — so every decision has to be reachable from here.
// ─────────────────────────────────────────────────────────────────────────────

async function decideSendId(item, userEmail) {
    // null = unreadable. Never used as a snapshot, and never compared equal to
    // a persisted one — an unreadable list must force re-evaluation, not a
    // lucky match. "" (no recipients) IS comparable and IS persistable.
    const currentSnap = serializeRecipients(await readRecipientEmails(item));

    const override = await getManualOverride(item);
    if (override) return { id: override, snapshot: currentSnap, reason: "manual override", persist: false };

    const [activeId, snapshot] = await Promise.all([
        getItemProp(item, P_ACTIVE_SIG),
        getItemProp(item, P_RECIP_SNAPSHOT),
    ]);

    // Recipients unchanged since the compose-time decision: skip re-evaluation
    // (the expensive, cold-runtime-hostile part) but still reapply the id.
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
        // Includes the emptied-recipient-list case: evaluation succeeded and
        // nothing matched, so the default is right even though an earlier rule
        // id may still be persisted on the item.
        return { id: DEFAULT_ID, snapshot: currentSnap, reason: "no rule matched", persist: true };
    }

    // FIX (G). We only reach here when the persisted snapshot did NOT match the
    // current one, so any persisted id was decided for a recipient set that no
    // longer exists. With the list confirmed EMPTY that id cannot be right — no
    // recipient-scoped rule applies to nobody — so use the default rather than
    // reapplying a stale rule signature. (When the list is merely different we
    // still prefer the persisted id: dropping a possibly-correct rule signature
    // is worse than reapplying it.)
    if (currentSnap === "") {
        return { id: DEFAULT_ID, snapshot: currentSnap, reason: "blocked, but recipients confirmed empty", persist: true };
    }

    // FIX (H). allowRoam only when we could not read the recipients at all. If
    // we read them, we have enough to decide here, and the roamed id may belong
    // to a different device entirely.
    const fallback = activeId || await getActiveSignatureId(item, { allowRoam: currentSnap === null });
    if (fallback) {
        return { id: fallback, snapshot: currentSnap, reason: "evaluation blocked — persisted id", persist: false };
    }
    return { id: DEFAULT_ID, snapshot: currentSnap, reason: "last resort", persist: false };
}

async function onSendCore(item, mailbox) {
    const t0 = Date.now();
    const userEmail = mailbox?.userProfile?.emailAddress;
    const seq = beginWrite();

    const { id, snapshot, reason, persist } = await decideSendId(item, userEmail);
    log(`onSend: target id=${id} (${reason})`);

    // v7.5: applyById verifies before writing at send. status === "unchanged"
    // means the draft already carried exactly this signature and the body was
    // NOT touched — the common case, and the point of the whole exercise.
    const r = await applyById(item, id, userEmail, seq, { isSendTime: true });

    if (r.applied && persist) await markActiveSignature(item, id, snapshot, r.digest);

    // Console-only on purpose: the item is already closing (P), and telling a
    // user "your signature was edited so we restored it" as the mail leaves is
    // unactionable — and wrong when they edited it deliberately. If tamper
    // events need visibility, POST telemetry from here, fire-and-forget,
    // never awaited inside the send budget.
    if (r.verdict && r.verdict !== "identical") {
        warn(`signature altered on the draft (${r.verdict}) — ` +
            (r.status === "written" ? "re-inserted from cache" : "left as-is, host cannot replace"));
    }

    // FIX (P). The mail is already on its way out, so "Signature applied" has
    // nothing to land on — only a failure is worth raising here. The send is
    // never blocked either way (onSendHandler always allows the event).
    if (r.applied && !hasFailure()) removeNotification(item);
    else reportOutcome(item, r.applied ? "applied" : "failed");

    timed(`onSendCore (${r.status})`, t0);
}

// ─────────────────────────────────────────────────────────────────────────────
//  ENTRY POINTS
// ─────────────────────────────────────────────────────────────────────────────

// Every handler completes exactly once, even if the body throws.
function makeCompleter(label, t0, event, args) {
    let done = false;
    return () => {
        if (done) return;
        done = true;
        timed(label, t0);
        try { event.completed(args); } catch (_) { }
    };
}

const applySignature = async function (event = { completed: () => { } }) {
    const t0 = Date.now();
    const mailbox = Office?.context?.mailbox;
    const item = mailbox?.item;
    const complete = makeCompleter("applySignature total", t0, event);

    try {
        if (!item) return complete();
        log(`applySignature start — ${CB_VERSION} on ${detectPlatform()} (X-Platform: ${getXPlatform()})`);

        // FIX (M): no "Preparing your signature..." — the bar stays empty until
        // there is an outcome. FIX (N): beginWrite() also clears the ledger, so
        // everything below is attributed to this decision only.
        const seq = beginWrite();
        const userEmail = mailbox?.userProfile?.emailAddress;

        await markActiveSignature(item, null);

        // Persist the compose type here, in a runtime where the API behaves.
        // The send runtime reads it instead of re-deriving it.
        const composeTypeP = getComposeType(item, { persist: true })
            .then((t) => log("composeType at compose:", t))
            .catch((e) => warn("composeType resolution failed:", e));

        // Warm the rules cache before evaluating. With fix (A) getCachedRules()
        // genuinely returns null once the TTL lapses, so this actually refetches
        // — in v7.0 an immortal roamed copy made it a permanent no-op.
        //
        // A failure here is NOT reported directly: fetchRules only notes the
        // reason, and findMatchingRule decides whether it mattered (O).
        const rulesP = (async () => {
            if (!userEmail) return;
            if (getCachedRules()) { log("rules cache warm:", describeRulesSource()); return; }
            await fetchRules(await encryptEmail(userEmail));
        })().catch((e) => warn("rules refresh failed:", e));

        await Promise.allSettled([composeTypeP, rulesP]);

        // Only overwrite the baseline with a real reading — a null would make
        // the next recipients-changed event compare against nothing.
        const snap0 = serializeRecipients(await readRecipientEmails(item));
        if (snap0 !== null) _lastSnapshot = snap0;

        await evaluateAndApply(item, mailbox, seq);

        // FIX (J). Mobile gets the default warmed, but not every rule signature.
        // Silent by design — see prefetchSignatures.
        if (userEmail) {
            prefetchSignatures(userEmail, { includeRules: !isMobile() })
                .catch((e) => warn("prefetch failed:", e));
        }
    } catch (e) {
        err("applySignature error:", e);
        // An exception escaped the flow. Only speak if nothing has been said
        // yet — never overwrite a message this run already raised.
        if (item && !wasReported()) reportOutcome(item, "failed");
    } finally {
        complete();
    }
};

// NOTE: Outlook mobile does not raise OnMessageRecipientsChanged, so on a phone
// this handler simply never runs and the signature does not update live while
// composing. The send-time path is what corrects it there.
const onRecipientsChangedHandler = async function (event = { completed: () => { } }) {
    const t0 = Date.now();
    const mailbox = Office?.context?.mailbox;
    const item = mailbox?.item;
    const complete = makeCompleter("onRecipientsChanged total", t0, event);

    try {
        if (!item) return complete();

        // Let the host settle: OWA fires per keystroke-ish, and a half-typed
        // address produces a recipient set we do not want to evaluate.
        await sleep(RECIPIENT_SETTLE_MS);

        let snapshot = serializeRecipients(await readRecipientEmails(item));
        if (snapshot === null) { log("recipient read failed — skipping"); return complete(); }

        // FIX (E). The list has just gone empty. That is a legitimate state and
        // WILL be evaluated — but it is also the midpoint of "delete the last
        // recipient, type a new one", so re-read once before acting to avoid a
        // rule -> default -> rule churn. Widen EMPTY_RECIP_SETTLE_MS here if a
        // host still flickers; do not go back to skipping the evaluation.
        if (snapshot === "" && _lastSnapshot !== "") {
            await sleep(EMPTY_RECIP_SETTLE_MS);
            const recheck = serializeRecipients(await readRecipientEmails(item));
            if (recheck === null) { log("recipient re-read failed — skipping"); return complete(); }
            snapshot = recheck;
        }

        if (snapshot === _lastSnapshot) { log("recipients unchanged — skipping"); return complete(); }
        _lastSnapshot = snapshot;

        log(snapshot === ""
            ? "all recipients removed — re-evaluating (default expected)"
            : "recipients changed — re-evaluating");
        await evaluateAndApply(item, mailbox, beginWrite());
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
        log("from changed — re-evaluating for the new account");

        const seq = beginWrite();
        const userEmail = mailbox?.userProfile?.emailAddress;

        // The account changed, so every cached signature and rule belongs to
        // the previous identity. FIX (B): clearRulesCache() drops the ROAMED
        // copy too — v7.0 cleared localStorage only, and the next read fell
        // straight through to roaming and matched the old account's rules.
        store.remove(K_SIG_CACHE, K_SIG_CACHE_LEGACY_DEFAULT);
        _sigMap = null; // v7.5: the parsed map mirrors K_SIG_CACHE — drop it too
        clearRulesCache();
        await markActiveSignature(item, null);

        if (userEmail) await fetchRules(await encryptEmail(userEmail));

        const snap0 = serializeRecipients(await readRecipientEmails(item));
        if (snap0 !== null) _lastSnapshot = snap0;

        await evaluateAndApply(item, mailbox, seq);
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
    // Always allow the send: a signature problem must never block the user.
    const complete = makeCompleter("onSendHandler total", t0, event, { allowEvent: true });

    try {
        if (!item) return complete();
        log(`onSendHandler start — ${CB_VERSION} on ${detectPlatform()}`);
        // FIX (M): no "Verifying signature..." — onSendCore reports failures only.

        // FIX (K): mobile is a cold runtime too and needs the same headroom.
        const budget = isColdRuntime() ? SEND_BUDGET_MS_COLD : SEND_BUDGET_MS;
        await withTimeout(onSendCore(item, mailbox), budget, "onSendCore");
    } catch (e) {
        // Ran out of budget or threw: the signature probably did not make it, so
        // report rather than silently clearing the bar as v7.3 did.
        warn("onSend timeout/error:", e.message);
        if (!hasFailure()) recordFailure("offline", `onSendCore: ${e.message}`);
        if (!wasReported()) reportOutcome(item, "failed");
    } finally {
        complete();
    }
};

// ─────────────────────────────────────────────────────────────────────────────
//  BOOTSTRAP
//  NOTE: on Windows classic the event runtime does not run Office.onReady —
//  never put logic here that a handler depends on.
// ─────────────────────────────────────────────────────────────────────────────

Office.onReady(() => {
    log(`ready — ${CB_VERSION} | platform=${detectPlatform()} | X-Platform=${getXPlatform()} | session=${getSessionId()}`);
    try {
        const d = Office.context.mailbox?.diagnostics;
        if (d) log(`host=${d.hostName} version=${d.hostVersion}`);
    } catch (_) { }
    log("rules cache at startup:", describeRulesSource());
    sigCache.purge();
});

if (typeof Office !== "undefined" && Office.actions?.associate) {
    Office.actions.associate("applySignature", applySignature);
    Office.actions.associate("onSendHandler", onSendHandler);
    Office.actions.associate("onFromChangedHandler", onFromChangedHandler);
    Office.actions.associate("onRecipientsChangedHandler", onRecipientsChangedHandler);
    log(`${CB_VERSION} handlers registered`);
} else {
    log("Office.actions unavailable — LaunchEvent path inactive (Outlook 2016/2019)");
}