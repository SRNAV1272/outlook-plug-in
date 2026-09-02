"use strict";

// =============================================================================
//  CardByte Outlook Add-in — event-handler.js (v7.6.0)
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
//   • Compose does ONE body write per event instead of four.
//
//  WRITE TOKEN. Windows/OWA share one runtime, so OnNewMessageCompose and
//  OnMessageRecipientsChanged overlap and both write the body across long
//  awaits. Each entry point takes a seq from beginWrite(); a write is dropped
//  if seq is no longer current. Last decision wins deterministically instead of
//  by network luck. beginWrite() also resets the failure ledger AND the
//  per-decision recipient memo — see v7.6 (β).
//
// -----------------------------------------------------------------------------
//  CHANGES IN v7.6.0 — THE CACHE ACTUALLY EXPIRES NOW
//
//  Reported symptom: "the cache buster is not working anywhere — rules cache,
//  get-active cache, signature cache. Nothing refreshes every 5 minutes."
//  Correct, and there were FOUR independent causes. SIG_TTL_MS, RULES_TTL_MS
//  and the 5-minute intent are unchanged; what changed is that they now bind.
//
//  α. SIG_TTL_MS WAS DEAD CODE ON THE READ PATH. resolveSigHtml — the only door
//     into signature HTML — opened with:
//
//         const cached = sigCache.get(key, { skipTtl: true });
//
//     so sigCache.get's `skipTtl || Date.now() - entry.ts <= SIG_TTL_MS` always
//     short-circuited on the first operand. prefetchSignatures passed the same
//     flag, so it never re-warmed an aged entry either. The ONLY eviction was
//     sigCache.purge(), called from exactly one place: Office.onReady — which
//     (per the BOOTSTRAP note) the Windows classic event runtime does not run,
//     and which on Windows/OWA fires once for a runtime that then lives across
//     every activation. Effective TTL on desktop: "until Outlook restarts".
//     Mac/mobile refetched every time only because their WKWebView and its
//     localStorage are thrown away per activation — which is exactly why this
//     presented as "works on the phone, never on the desktop".
//
//     Now: the read path is TTL-checked, and a stale copy is retained ONLY as
//     the offline/failure fallback (source "cache-stale"). Freshness and
//     resilience are separate concerns and are now separately expressed.
//
//     CONSEQUENCE — SIG_PURGE_MS HAD TO MOVE. It was 5 minutes, i.e. equal to
//     the TTL, which was harmless while nothing expired but would now delete
//     precisely the stale copies the fallback depends on. Purging is about
//     unbounded localStorage growth, not freshness; it is now 12h and runs per
//     decision rather than per runtime.
//
//  β. TWO MEMO LAYERS NEVER RE-READ STORAGE. _sigMap (the v7.5 parse cache) and
//     store's _mem both hold for the runtime's entire life, and on Windows/OWA
//     that is every activation. The taskpane writes the SAME origin's
//     localStorage — the legacy-default migration depends on that — so a
//     pane-side refresh was invisible here forever. Identical failure mode to
//     the CustomProperties bug fixed in v7.5.2, one layer down.
//
//     Now: invalidateCaches() sits beside invalidateProps(item) at the top of
//     all four entry points. Within one activation the parse is still cached,
//     which is all optimisation (V) was ever after.
//
//  γ. K_SIG_CACHE_LEGACY_DEFAULT HAD NO TIMESTAMP, so once written it shadowed
//     the real default cache entry permanently. It is now migrated into the
//     id-keyed map with ts=0 (usable as a fallback, immediately stale) and the
//     legacy key is deleted. One-way, idempotent, runs at most once per device.
//
//  δ. THERE WAS NO HTTP CACHE BUSTER AT ALL. All three GETs went out bare: no
//     `cache: "no-store"`, no query param, no request-side Cache-Control. If
//     the backend omits Cache-Control but sends ETag/Last-Modified, WebView2
//     applies heuristic caching and mshtml (classic bundle) is far more
//     aggressive. A correct app-level refetch could therefore still return the
//     old body — and setCachedRules/sigCache.set would then re-stamp
//     ts = Date.now() on stale content and restart the 5-minute clock, which is
//     what made rules look frozen despite RULES_TTL_MS being implemented
//     correctly. Every request now carries `cache: "no-store"` and a `_=`
//     param.
//
//     DELIBERATELY NOT request headers: adding Cache-Control/Pragma widens the
//     preflight's Access-Control-Request-Headers, and if the backend's
//     Access-Control-Allow-Headers does not list them every call fails with the
//     "TypeError: Load failed" of prereq (a). The query param achieves the same
//     with zero CORS surface change. Fix it server-side too (`Cache-Control:
//     no-store` on all three endpoints) and this becomes belt-and-braces.
//
//  ε. failureMsg WAS A ReferenceError. resolveSigHtml's plan-expired branch read
//     `failureMsg`, which was never destructured from the fetch result — so the
//     one branch that exists to show the server's own wording threw instead,
//     landed in the catch, and reported "offline". A lapsed subscription was
//     being reported as a network problem. Now destructured.
//
//  ζ. RECIPIENTS ARE READ ONCE PER DECISION, not three to five times. Each read
//     costs up to FETCH_BUDGET_MS_COLD, plus the (K) 400ms cold retry, and both
//     To and Cc. applySignature read them for the baseline snapshot,
//     findMatchingRule read them again to evaluate, and evaluateAndApply read
//     them a THIRD time for the snapshot to persist; decideSendId read them and
//     then findMatchingRule read them again INSIDE the send budget. A memo
//     keyed on the write token collapses that to one read per decision and is
//     invalidated by beginWrite(), so it can never span two decisions.
//
//     Only SUCCESSFUL reads are memoised: a null (unreadable) read must stay
//     retryable, and the empty-list recheck in onRecipientsChangedHandler
//     passes {force:true} because re-reading is its entire purpose.
//
//     SIDE BENEFIT, and arguably a correctness fix: the snapshot persisted now
//     describes the SAME recipient set the rules were evaluated against. It
//     previously came from a later, independent read.
//
//  η. SMALLER THINGS. Digest memoised (applyById and verifySignatureOnBody both
//     computed HCS.digest over the same HTML — two full tokenisations per send).
//     Rules JSON parsed once per raw string, and the enabled/sorted candidate
//     list memoised on that parsed object. describeRulesSource() no longer
//     JSON.parses the whole ruleset just to produce a log line. sigCache writes
//     coalesce to one JSON.stringify per tick instead of one per set (prefetch
//     did N full stringifies of up to 100KB apiece). Size checks use a UTF-8
//     length counter rather than allocating a Blob. prefetch id list uses a Set.
//     Compose skips the customProps saveAsync when id AND snapshot both already
//     match.
//
//  UNCHANGED ON PURPOSE: every Mac/mobile fix (cold budgets, the recipient
//  re-read retry, the roamed-id guard, DEFAULT_ID prefetch), the whole
//  send-time verification and replacement path, the notification ledger, and
//  X_PLATFORM_MAP — see the warning on that constant.
//
//  DECISION NOW WORTH REVISITING: v7.5.2 (AA) set revalidate:false at compose,
//  justified as "duplicating what SIG_TTL_MS already bounds". It was not
//  bounding anything, so that removed the last refresh mechanism entirely. With
//  (α) in place the justification is finally true and false is the right
//  default; set it back to true only if admin-side edits must land mid-compose
//  rather than within one TTL window. The account-scoped dedupe key already
//  stops it racing a prefetch.
//
// -----------------------------------------------------------------------------
//  CHANGES IN v7.5.2 — THE MANUAL PIN IS READ THE WAY CLASSIC READS IT
//
//  X. THE TASKPANE'S MANUAL OVERRIDE WAS INVISIBLE, AND THEN DELETED. The
//     Classic build calls loadCustomPropertiesAsync on every read and writes
//     item properties from one place, additively. This build memoised ONE
//     CustomProperties handle per item in a WeakMap for the runtime's life, and
//     on Windows/OWA — one long-lived runtime — that produced two failures:
//
//       READ STALENESS. OnNewMessageCompose cached the bag before the user
//       opened the pane. The pane wrote cardbyte_manual_sig_id through its own
//       handle. The next OnMessageRecipientsChanged read the CACHED bag, saw no
//       pin, evaluated the rules, and switched the signature.
//
//       WRITE CLOBBER. saveAsync serialises the whole in-memory bag, so
//       markActiveSignature writing a stale one DELETED the pin from the item.
//
//     Mac and mobile were unaffected: a fresh WKWebView per activation leaves
//     the WeakMap empty, accidentally matching Classic. Windows/OWA only.
//
//     Now: invalidateProps() at the top of all four entry points and
//     getProps({fresh:true}) before every write. Reads WITHIN one activation
//     still share the handle — full per-read reloading would cost ~13 round
//     trips and a cold Mac/mobile send budget cannot absorb that.
//
//  Y. THE PIN IS CHECKED BEFORE THE COMPOSE-TIME STATE RESET, as in Classic's
//     runPipeline. applySignature cleared P_ACTIVE_SIG unconditionally, forcing
//     a body rewrite every time a pinned draft was reopened.
//
//  Z. VALIDATION MOVED INTO getManualOverride, so both call sites agree: an
//     unresolvable pin ("", "null", "undefined") is treated as no pin.
//
//  AA. OPTIMISATIONS. revalidate:false at compose; the in-flight dedupe key is
//     account-scoped so a fetch for the previous identity cannot repopulate the
//     new one's cache after a From change; the dead self-assignment is gone.
//
// -----------------------------------------------------------------------------
//  CHANGES IN v7.5.1 — VERIFICATION IS SCOPED TO THE LIVE COMPOSE AREA
//
//  W. TAMPERING WAS NOT DETECTED ON REPLIES OR FORWARDS. A draft body on a
//     reply also carries the quoted thread, and that thread routinely holds an
//     INTACT COPY of the same signature — any earlier mail in the thread that
//     we signed. v7.5.0 searched the whole body, so that copy answered "is the
//     signature intact?" on behalf of the live one: an edited or deleted live
//     signature came back "identical". New compose was unaffected because it
//     has no quoted text, which is exactly how the bug presented in the field.
//
//     verifySignatureOnBody now delegates to HCS.verifyInDraft, which splits the
//     body at the quoted-thread boundary and inspects only the LIVE part. Marked
//     copies inside the quote are DISCARDED rather than counted as duplicates —
//     a second, quieter bug: every reply in a thread we had signed before
//     reported "duplicate" and got rewritten for nothing.
//
//     DELIBERATE COST: with Outlook set to place the signature BELOW the quoted
//     text, the live block falls outside the live slice, the verdict is always
//     "absent", and every send rewrites — i.e. pre-verification behaviour. That
//     is preferred over trusting a trailing marked block, which on a
//     reply-to-our-own-mail is indistinguishable from the oldest quoted
//     signature at the bottom of the thread.
//
// -----------------------------------------------------------------------------
//  CHANGES IN v7.5.0 — THE SEND NO LONGER REWRITES A CORRECT SIGNATURE
//  (requires html-content-signature.js concatenated ahead of this file)
//
//  Q. onSendCore resolved an id and rewrote the body every time, including the
//     common case where the body already carried exactly that signature. Send
//     time now READS the draft, compares, and writes ONLY when the draft's copy
//     is missing, edited, duplicated, or belongs to a different id. The
//     comparison is content-based, not textual: Outlook rewrites a signature
//     the moment it lands (remote images become cid:, Word rewrites CSS and
//     injects MsoNormal/o:p/lang markup), so comparing HTML strings would report
//     every desktop draft as tampered. See PROFILES.body for what is compared.
//
//  R. EVERY WRITE IS WRAPPED IN <div data-cb-sig="{id}">. There is no API for
//     reading back just the signature, and setSignatureAsync does not put the
//     block at the end of a reply, so the wrapper is the only reliable anchor.
//     Drafts written by v7.4 have no wrapper and fall back to a token-run search.
//
//  S. EVERY UNCERTAIN OUTCOME STILL WRITES. Body unreadable, module not loaded,
//     marker stripped, HTML rewritten past recognition — all resolve to "write
//     it". A false positive costs one body write; a false negative never leaves
//     a wrong signature. VERIFY_AT_SEND=false restores v7.4 in one flag.
//
//  T. APPEND-ONLY HOSTS ARE DETECT-ONLY BY DEFAULT. Mobile has only
//     appendOnSendAsync, so "re-insert" there means "add a second signature".
//     When merely ABSENT it is still appended; when present but wrong, v7.5 logs
//     and leaves it. APPEND_ON_TAMPER=true appends regardless.
//
//  U. P_SIG_DIGEST records what was written, so a mismatch caused by an admin
//     updating the signature server-side is logged as such instead of as a user
//     edit. Informational only — both cases re-insert.
//
//  V. OPTIMISATIONS. encryptEmail memoised; the signature cache map parsed once
//     per runtime instead of on every get/set/purge. (See v7.6 β for the
//     staleness that second one introduced.)
//
//  NOT ADDRESSED, ON PURPOSE: this detects tampering, it does not prove
//  authorship. The expected copy comes from the local cache, which anyone with
//  the device can edit; a user who edits after OnMessageSend completes is
//  outside the add-in's reach. If the requirement is "the recipient can verify
//  the signature was not altered", enforce it on the server or gateway.
//
// -----------------------------------------------------------------------------
//  CHANGES IN v7.4.0 — THE NOTIFICATION BAR IS TWO MESSAGES, NOT SIX
//
//  M. Only two things are worth interrupting the user with: "the signature is
//     on the mail", and "it is not / may be wrong, and here is why". The
//     progress chatter and NOTIFY_LEVEL are gone; timings go to the console.
//
//  N. FAILURES ARE REPORTED FROM ONE PLACE, AT THE END OF THE RUN. Previously
//     every notifyError fired the instant it was reached: a failure that was
//     subsequently recovered from still flashed, and — notificationMessages
//     being last-write-wins on one key — a later "Signature applied" could
//     silently overwrite a real error. Every step now RECORDS (recordFailure)
//     and reportOutcome() emits exactly one message once the outcome is known.
//     The ledger is reset by beginWrite(), i.e. once per decision.
//
//  O. EVERY API STEP FEEDS THE LEDGER. An HTTP status and a transport failure
//     stay distinct all the way to the message, because "check your connection"
//     and "contact Admin" are different instructions — see prereq (a).
//     BACKGROUND WORK IS SILENT: prefetch and revalidate never record.
//
//  P. SEND TIME RAISES FAILURES ONLY. The send is never blocked, and a success
//     message at send has nothing to land on because the item is already closing.
//
// -----------------------------------------------------------------------------
//  EARLIER FIXES STILL LOAD-BEARING (v7.1–v7.3), CONDENSED — DO NOT REVERT:
//
//   A. Roamed rules expire. R_RULES_TS exists because an untimestamped roamed
//      copy made getCachedRules() non-null forever, poisoning every "null means
//      go fetch" caller. skipTtl (send time) still accepts an aged copy.
//   B. A From change clears the ROAMED rules too, not just localStorage —
//      otherwise the empty local cache fell through to the previous identity's.
//   C. Rules with no signatureId are not candidates (they would match, request
//      /rules-config/get/null, 404, and shadow the rule that should have won).
//      Priority is coerced: a NaN comparator lets Array#sort order arbitrarily.
//   D/I. X-Platform. The backend accepts WINDOWS only; MAC/MOBILE come back
//      non-2xx. X_PLATFORM_MAP is where that collapse happens — see the warning
//      on the constant, the shipped value contradicts this note.
//   E. "No recipients" is an ANSWER, not a failure. getRecipients returns null
//      for "the host did not answer", [] for "genuinely none". Only null blocks
//      evaluation. v7.1 conflated them and pinned a rule signature to the body
//      forever once the To line was cleared. Mid-typing flicker is handled by
//      EMPTY_RECIP_SETTLE_MS, not by refusing to evaluate.
//   F. An unknown compose type does not block on its own. Sender and recipient
//      are filtered FIRST; compose type is consulted only when a surviving
//      candidate is context-scoped. This is what makes mobile work.
//   G. The blocked fallback does not reuse an id decided for a recipient set
//      that no longer exists when the current list is confirmed EMPTY.
//   H. R_ACTIVE_SIG is MAILBOX-scoped, i.e. cross-device. Consulted only when
//      the recipient list could not be read at all.
//   J. DEFAULT_ID is prefetched on every platform, mobile included.
//   K. Cold budgets and the recipient re-read retry cover mobile, not just Mac.
//   L. Hosts without setSignatureAsync still persist the compose decision, so
//      the send runtime can act on it via appendOnSendAsync.
//
//  MOBILE PLATFORM LIMIT, NOT FIXABLE HERE: OnMessageRecipientsChanged is not
//  raised by Outlook mobile. The signature does not visibly update while
//  composing on a phone — the correction happens at send.
//
//  ALSO NOT FIXABLE HERE: recipient POLLING and the 4-minute MAC_KEEPALIVE were
//  removed in v7.0 — deferring event.completed() for 4 min can delay or drop
//  OnMessageSend, since the event runtime serialises activations.
//
//  DEPLOYMENT PREREQS FOR MAC / MOBILE:
//   a) /.well-known/microsoft-officeaddins-allowed.json must list the add-in id
//      and this file's URL, and the API must send CORS headers. Otherwise every
//      fetch from the Mac event runtime rejects with "TypeError: Load failed".
//      An HTTP status in the log is (D); a "Load failed" TypeError is this.
//   b) XML (add-in only) manifest with LaunchEvents: OnNewMessageCompose,
//      OnMessageRecipientsChanged, OnMessageFromChanged, OnMessageSend.
//   c) Mac debugging: defaults write com.microsoft.Outlook
//      OfficeWebAddinDeveloperExtras -bool true, then Safari > Develop.
// =============================================================================

const CB_VERSION = "v7.6.0";

// ─────────────────────────────────────────────────────────────────────────────
//  CONFIG
// ─────────────────────────────────────────────────────────────────────────────

const AES_KEY = "fnItrY2YfozBqCC2B4XsfqHIvZku3kUOq3DFkbO64kk=";
const AES_IV = "3YapeNfJDung7TXxeKXn4g==";
const BASE_URL = "https://enterprise.cardbyte.ai/email-signature";

// The backend's one account-level refusal: HTTP 412 + PlanExpiredException.
// Distinct from every other non-2xx because it is definitive, global to the
// mailbox, and not retryable — no other id will succeed either.
const HTTP_PLAN_EXPIRED = 412;
const PLAN_EXPIRED_RE = /PlanExpired/i;

// A lapsed subscription invalidates the cached HTML as much as the live copy,
// and without this a warm cache hides the expiry until SIG_TTL_MS lapses.
// Set false if the product prefers cached signatures to keep working through
// an expiry (they will, silently, for as long as the cache lives).
const PURGE_CACHE_ON_PLAN_EXPIRED = true;

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
// since compose". Purely informational — both outcomes re-insert.
const P_SIG_DIGEST = "cardbyte_sig_digest";

// roamingSettings — mailbox-scoped, ~32KB total. Small values only; never HTML.
// NOTE (H): mailbox-scoped means CROSS-DEVICE. R_ACTIVE_SIG is a last-resort
// hint, never evidence about the item currently being composed.
const R_ACTIVE_SIG = "cb_active_sig";
const R_RULES = "cb_rules";
const R_RULES_TS = "cb_rules_ts";   // FIX (A): roamed rules were immortal without this
const R_RULES_MAX_BYTES = 20 * 1024;

// FRESHNESS. These are now actually enforced on the read path — see v7.6 (α).
// Lower them and signatures refresh sooner at the cost of more requests; the
// in-flight dedupe map and the HTTP cache buster together keep that bounded.
const SIG_TTL_MS = 5 * 60 * 1000;
const RULES_TTL_MS = 5 * 60 * 1000;
const ACTIVE_SIG_MAX_AGE_MS = 1 * 60 * 1000;

// EVICTION, NOT FRESHNESS. v7.6 (α): this was 5 min, i.e. equal to SIG_TTL_MS,
// which was harmless while the TTL never fired but would now delete exactly the
// stale copies resolveSigHtml falls back on when the network is down. Purging
// exists to stop localStorage growing without bound, so it is deliberately much
// longer than the TTL. Must stay > SIG_TTL_MS or the offline fallback is lost.
const SIG_PURGE_MS = 12 * 60 * 60 * 1000;

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
// Prepended to the signature when send-time verification found the draft's copy
// altered and re-inserted it. Not currently emitted — see the note in applyById.
const TAMPER_TAG =
    `<div style="margin:0 0 6px 0;font:italic 11px Arial,Helvetica,sans-serif;color:#7a6134;">` +
    `Signature re-inserted</div>`;

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
const SEND_BUDGET_MS_COLD = 20_000;
const SEND_BUDGET_MS = 5_000;

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

// ⚠ FIX (I), STILL CONTRADICTORY — READ BEFORE TOUCHING.
// The surrounding documentation says the backend accepts WINDOWS only, and that
// MAC/MOBILE come back non-2xx, which is what makes every fetch fail on those
// platforms. The v7.6 review deliberately did NOT change this line: the shipped
// value maps MAC -> "MAC", so either the note is out of date or the fix was
// reverted after testing and the note was not. VERIFY AGAINST YOUR BACKEND and
// then correct whichever of the two is wrong. If MAC is rejected, this must
// read `{ MAC: "WINDOWS", MOBILE: "WINDOWS", OWA: "WINDOWS" }`.
// Empty the map — `{}` — once the API accepts the real values.
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
const NOTIFY_CLEAR_MS = 3000;
const MSG_APPLIED = "Signature applied";
// Shown while the signature is being decided and fetched. Raised only by
// showLoading(), and always superseded or removed by reportOutcome().
const MSG_LOADING = "Applying your signature...";

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
//  and every classification fell through to a user-agent guess. The real
//  property is Office.context.diagnostics.platform (Mailbox 1.5+).
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

// Resolved once: detectPlatform() is memoised, but this ran a map lookup and a
// chain of comparisons on every request and every log line.
let _xPlatform = null;

function getXPlatform() {
    if (_xPlatform) return _xPlatform;
    const p = detectPlatform();
    const base =
        p === "mac" ? "MAC" :
            // Outlook for iOS reports MAC: the backend has no iOS bucket, and
            // iOS shares the Apple/WebKit rendering path, so MAC is the closest
            // accepted value. Must precede the isMobile() branch.
            p === "mobile-ios" ? "MAC" :
                p === "owa" ? "OWA" :
                    isMobile() ? "MAC" :
                        "WINDOWS";
    return (_xPlatform = X_PLATFORM_MAP[base] || base);
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

// The one place the per-call Office/network ceiling is decided.
const budgetMs = () => (isColdRuntime() ? FETCH_BUDGET_MS_COLD : FETCH_BUDGET_MS);

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

// UTF-8 byte length without allocating a Blob. The old `new Blob([payload]).size`
// materialised a copy of up to MAX_SIG_BYTES on every write purely to measure it,
// and Blob is the sort of constructor the classic bundle's runtime is least
// reliable about.
function utf8Len(s) {
    let n = 0;
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c < 0x80) n += 1;
        else if (c < 0x800) n += 2;
        else if (c >= 0xd800 && c <= 0xdbff) { n += 4; i++; }  // surrogate pair
        else n += 3;
    }
    return n;
}

// ─────────────────────────────────────────────────────────────────────────────
//  WRITE TOKEN
//  Guards every body/state write against a newer decision made during an await.
//
//  FIX (N): taking a new seq also RESETS THE FAILURE LEDGER. A decision and the
//  failures reported against it are the same unit of work — an error from an
//  evaluation that has since been superseded must never surface against the new
//  one.
//
//  v7.6 (ζ): it also resets the RECIPIENT MEMO, for the same reason. One
//  decision reads the recipient list once; the next decision reads it again.
// ─────────────────────────────────────────────────────────────────────────────

let _writeSeq = 0;

function beginWrite() {
    clearFailures();
    _recipCache = { seq: -1, emails: null };
    _writeSeq++;
    // Cheap, and this is the only per-decision hook that runs on every host —
    // Office.onReady does not fire in the Windows classic event runtime, which
    // is why purging from there evicted nothing for the runtime's whole life.
    sigCache.purge();
    return _writeSeq;
}

const isCurrent = (seq) => seq === _writeSeq;

// Recipient snapshot of the last evaluation in THIS runtime.
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

// `icon` must be an image resource id declared in the manifest's
// <Resources><bt:Images>, resolved against the VersionOverrides in effect —
// event handlers run under V1_1, so the v11.* ids are the right ones.
const NOTIF_ICON = "v11.icon16";

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
//  the outcome is known.
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
    //    so it may be the default where a rule should have won.
    rules_offline: {
        rank: 2, fatal: false,
        msg: "Couldn't reach the signature service, so your signature rules weren't checked. Check your connection.",
    },
    rules_error: {
        rank: 2, fatal: false,
        msg: "Couldn't load your signature rules. Please contact Admin.",
    },

    // Outranks every other fatal (rank 5): once the plan has expired every
    // subsequent call fails too, and this is the one message that explains why.
    plan_expired: {
        rank: 5, fatal: true,
        msg: "Your subscription plan has expired. Please contact Admin.",
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

function recordFailure(kind, detail = "", serverMsg = null) {
    const f = FAILURES[kind];
    if (!f) { warn("recordFailure: unknown kind", kind); return; }
    warn(`failure recorded: ${kind}${detail ? ` — ${detail}` : ""}`);
    if (!_failure || f.rank > _failure.rank) {
        _failure = { kind, ...f, msg: serverMsg || f.msg };
    }
}

// A null/absent HTTP status means the request never got an answer (transport,
// CORS, timeout — prereq (a)); anything else is the server answering badly.
const failureKindFor = (status) => (status == null ? "offline" : "server");

// The rules call records its own outcome separately: whether it MATTERS depends
// on whether a cached ruleset covered for it, which only findMatchingRule knows.
const noteRulesFetchError = (kind) => { _rulesFetchError = kind; };
const rulesFailureKind = () => (_rulesFetchError === "offline" ? "rules_offline" : "rules_error");

/**
 * The progress message. Deliberately NOT recorded in _reported: this is
 * progress, not an outcome, so an entry-point catch block must still treat
 * "only the loading message was shown" as nothing having been said. Every path
 * that raises it ends in reportOutcome(), which replaces it on success/failure
 * and removes it on "quiet" — so it cannot get stranded on the bar.
 */
function showLoading(item) {
    showNotification(item, MSG_LOADING, "informationalMessage");
}

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
    // Chunked: String.fromCharCode.apply on a 100KB array blows the argument
    // limit on some hosts, and a per-byte += on a large payload is the slowest
    // thing in the decrypt path.
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

// v7.5 OPTIMISATION: memoised. The IV is static, so the ciphertext for a given
// email never changes — yet this was called once per API request, including
// once per id inside prefetchSignatures, each paying a WebCrypto importKey +
// encrypt round trip. One entry is enough: the runtime serves one mailbox.
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
//
//  v7.6 (β): _mem is per-runtime and the taskpane writes the SAME origin's
//  localStorage. Anything that can be written by the pane must be dropped from
//  _mem at the start of every activation — see invalidateCaches().
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

/**
 * v7.6 (β). DROP EVERY CROSS-RUNTIME MEMO. Called at the top of all four entry
 * points, beside invalidateProps(item).
 *
 * The parsed signature map, the parsed ruleset and store's raw-string cache all
 * survived for the life of the runtime, which on Windows/OWA is every
 * activation of the whole Outlook session. The taskpane writes the same
 * localStorage; so does another window on the same profile. Without this, a
 * refresh performed anywhere else was invisible here forever — the exact
 * failure mode v7.5.2 fixed one layer up, for CustomProperties.
 *
 * Cost: one JSON.parse of each key, once per activation. That is what the
 * within-activation memo was actually worth; holding it longer was never a
 * measured saving, only an unmeasured staleness.
 */
function invalidateCaches() {
    flushSigCache();          // never discard a pending write
    _sigMap = null;
    _rulesParsed = { raw: null, json: null };
    _enabledCache = { src: null, list: null };
    _mem.delete(K_SIG_CACHE);
    _mem.delete(K_SIG_CACHE_LEGACY_DEFAULT);
    _mem.delete(K_RULES);
    _mem.delete(K_RULES_TS);
    _mem.delete(K_ACTIVE_SIG);
    _mem.delete(K_ACTIVE_SIG_TS);
}

// ─────────────────────────────────────────────────────────────────────────────
//  SIGNATURE HTML CACHE — one id-keyed map, DEFAULT_ID included.
//  HTML is disposable: a miss costs a fetch, never correctness.
//
//  v7.6: writes COALESCE. Each set() previously JSON.stringified the entire map
//  — every cached signature's HTML, up to 100KB apiece — and prefetchSignatures
//  fires several sets in the same tick. They now mark the map dirty and one
//  flush runs at the end of the tick (or explicitly, via flushSigCache()).
//  Losing an unflushed write costs a refetch, never correctness.
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

    /**
     * v7.6 (γ). The taskpane's legacy default key carried no timestamp, so once
     * present it shadowed the id-keyed entry forever — nothing could expire it
     * and nothing could refresh it. Fold it in ONCE with ts=0: usable as an
     * offline fallback, immediately stale for freshness purposes, and gone from
     * the legacy key so this can never run twice.
     */
    migrateLegacy() {
        let legacy = null;
        try { legacy = store.get(K_SIG_CACHE_LEGACY_DEFAULT); } catch (_) { }
        if (!legacy) return;
        if (!_sigMap[DEFAULT_ID]) {
            _sigMap[DEFAULT_ID] = { html: legacy, ts: 0 };
            log("sig cache: migrated the legacy default key (marked stale)");
        }
        store.remove(K_SIG_CACHE_LEGACY_DEFAULT);
        scheduleSigFlush();
    },

    /**
     * @param {boolean} skipTtl  return an aged entry anyway. Callers use this
     *   ONLY for the offline/failure fallback and for send-time last resorts —
     *   never as the primary read, which is what made SIG_TTL_MS dead code
     *   before v7.6 (α).
     */
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

    // Eviction, not expiry — see SIG_PURGE_MS. Runs per decision now, because
    // Office.onReady does not fire in the Windows classic event runtime.
    purge() {
        let map;
        try { map = sigCache.read(); } catch (_) { return; }
        const now = Date.now();
        let n = 0;
        for (const id of Object.keys(map)) {
            if (now - (map[id]?.ts || 0) > SIG_PURGE_MS) { delete map[id]; n++; }
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
//  RULES CACHE — mirrored to roaming when small enough, so the Mac and mobile
//  send runtimes can evaluate without a network round trip.
//
//  FIX (A). Both tiers are age-checked against the SAME TTL. v7.0 checked only
//  the local timestamp and then fell back to an untimestamped roamed copy, so
//  getCachedRules() could never return null once roaming had been written — and
//  null is what every caller uses to mean "go fetch". skipTtl still accepts an
//  aged copy: at send time a stale ruleset beats no ruleset.
//
//  v7.6 (η). Parsed once per raw string. This was JSON.parsing the whole
//  ruleset on every call, including from describeRulesSource(), which needed
//  nothing but "is there one".
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
    // Prime the parse memo with the object we already hold, so the evaluation
    // that follows this fetch does not re-parse what it just serialised.
    _rulesParsed = { raw: s, json: rulesJson };

    try {
        if (s.length <= R_RULES_MAX_BYTES) {
            roam.set(R_RULES, s);
            roam.set(R_RULES_TS, Date.now().toString());
        } else {
            // Drop the roamed copy rather than leaving an older, smaller ruleset
            // in place — a stale roam is worse than a cold fetch.
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

// Which tier answered, for the log line in findMatchingRule. Diagnostic only —
// so it inspects raw strings and never parses.
function describeRulesSource() {
    const ts = parseInt(store.get(K_RULES_TS) || "0", 10);
    if (store.get(K_RULES)) return `local (age=${ts ? Date.now() - ts : "?"}ms)`;
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

/**
 * v7.5.2. THE HANDLE IS NOT TRUSTED ACROSS ACTIVATIONS OR ACROSS WRITES.
 *
 * The Classic build calls loadCustomPropertiesAsync on EVERY read, and that is
 * why the taskpane's manual pin has always worked there. This build memoised one
 * handle per item for the runtime's whole life, which on Windows/OWA broke the
 * pin two ways: a stale READ missed a pin written by the pane, and — worse —
 * saveAsync serialises the WHOLE in-memory bag, so saving a stale one DELETED
 * the pin from the item permanently.
 *
 * Reloading on every read (full Classic parity) would cost ~13 round trips per
 * activation, which a cold Mac/mobile send budget cannot absorb. So: fresh at
 * the START of every activation (invalidateProps) and fresh before every WRITE,
 * with reads inside one activation sharing that handle.
 */
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

// Called once at the top of every entry point, BEFORE anything reads or writes.
function invalidateProps(item) { if (item) _propsByItem.delete(item); }

async function getItemProp(item, key) {
    try {
        const v = (await getProps(item))?.get(key);
        return v == null ? null : String(v);
    } catch (_) { return null; }
}

/**
 * Loads a FRESH bag before mutating it, because saveAsync writes the whole bag
 * back: any key the pane added since we last loaded would be dropped. The fresh
 * handle stays cached afterwards, so reads later in this activation see what we
 * just wrote without another round trip.
 */
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

/**
 * The pinned signature id, or null. Classic parity: validation lives HERE, so
 * every caller gets the same answer. An unresolvable pin ("", "null",
 * "undefined") would otherwise outrank every rule and then fail to fetch,
 * leaving the mail with whatever happened to be on it.
 */
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
//
//  v7.6 (δ). EVERY REQUEST BUSTS THE HTTP CACHE. Without this, a correct
//  app-level refetch could still be answered from the WebView's own cache, and
//  the result would then be re-stamped with a fresh ts — which is what made the
//  5-minute TTLs look inert even where they were implemented correctly.
//  Request-side Cache-Control headers are deliberately NOT used: they widen the
//  CORS preflight and would fail closed against a backend whose
//  Access-Control-Allow-Headers does not list them (prereq (a)).
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

// Shown verbatim only when it is a real sentence: an exception class name or an
// over-long string falls back to the canned wording rather than putting Java
// package paths on the notification bar.
function serverMessage(raw) {
    const s = String(raw || "").trim();
    if (!s) return null;
    if (/^[\w$]+(\.[\w$]+){2,}$/.test(s)) return null;   // FQCN, not a message
    return s.length <= 150 ? s : null;                    // host hard limit
}

// Reads a non-2xx body ONCE and classifies it. `message` is display-safe;
// `error` (the exception class) is used only for matching.
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
            // Status is logged WITH the platform header: a 4xx that disappears
            // when X-Platform is WINDOWS is fix (I), not a backend outage.
            const { message, planExpired, raw } = await readApiError(res);
            warn(`rules fetch returned ${res.status} (X-Platform=${xp})`, raw);
            if (planExpired) {
                // Recorded directly, breaking the "fetches never record" rule of
                // (O) deliberately: this is an account-level fact, not a rules
                // degradation, and it is true whether or not a cached ruleset
                // covers for the failed fetch.
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
        // "TypeError: Load failed" in a cold runtime means the well-known
        // allowlist / CORS setup is wrong. See header prereq (a).
        err(`fetchRules failed (X-Platform=${xp}):`, e);
        noteRulesFetchError("offline");
        return null;
    }
}

// Default signature. Returns { html, explicit, failure, failureMsg }:
//   explicit — the server gave a definitive answer, so an empty result means
//              "unassigned", not "unknown".
//   failure  — ledger kind for a genuine failure, or null. A 404 is NOT a
//              failure here: it is the definitive "nothing assigned" answer.
async function fetchDefaultSignature(encryptedMail) {
    const xp = getXPlatform();
    try {
        const res = await fetch(apiUrl("/html/outlook/get-active"), apiInit(encryptedMail));
        if (!res.ok) {
            const { message, planExpired, raw } = await readApiError(res);
            warn(`default signature fetch failed: ${res.status} (X-Platform=${xp})`, raw);
            if (planExpired) {
                // explicit:false on purpose — resolveSigHtml checks `explicit`
                // BEFORE `failure`, and this is not "nothing assigned".
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
            // 2xx that we cannot read is a server-side problem, not a network one.
            warn("default signature response unreadable:", e.message);
            return { html: null, explicit: false, failure: "server", failureMsg: null };
        }
        return { html, explicit: true, failure: null, failureMsg: null };
    } catch (e) {
        warn(`fetchDefaultSignature crashed (X-Platform=${xp}):`, e);
        return { html: null, explicit: false, failure: "offline", failureMsg: null };
    }
}

// Same shape as fetchDefaultSignature so resolveSigHtml can treat both uniformly.
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

// Two activations overlap on Windows/OWA, and prefetch races the evaluation.
// Without this they all miss the cold cache and all fetch the same id.
const _inFlight = new Map();

function dedupe(key, make) {
    const existing = _inFlight.get(key);
    if (existing) { log(`joining in-flight fetch: ${key}`); return existing; }
    const p = make().finally(() => _inFlight.delete(key));
    _inFlight.set(key, p);
    return p;
}

/**
 * THE CORE OF THE ID-AS-STATE DESIGN: id -> HTML, cache then network.
 *
 * v7.6 (α). FRESHNESS AND RESILIENCE ARE NOW SEPARATE. The primary read is
 * TTL-checked; the aged copy is kept only to answer with when the network
 * cannot. Previously this opened with skipTtl:true, which meant a cached
 * signature was served forever on any runtime that outlived one activation —
 * i.e. every Windows/OWA session — and SIG_TTL_MS never bound at all.
 *
 * `unassigned` distinguishes "the server answered definitively and there is no
 * signature for this user" (an admin problem) from "we could not reach or parse
 * the server" (a transient problem). The two need different messages.
 *
 * FIX (O). This is where an API failure becomes a user-facing failure, via the
 * ledger. `silent` exists for background callers (prefetch): a warm-up that
 * fails has not affected the mail in front of the user and must not notify.
 *
 * @returns {Promise<{html: string|null, source: "cache"|"cache-stale"|"network"|"none", unassigned: boolean}>}
 */
async function resolveSigHtml(id, userEmail, { allowNetwork = true, budgetMs: budget = null, silent = false } = {}) {
    const key = String(id);
    const ms = budget ?? budgetMs();
    const fail = (kind, detail, msg = null) => { if (!silent) recordFailure(kind, detail, msg); };

    // FIX (C) belt-and-braces: a rule that slipped through with no signatureId
    // would otherwise be requested as the literal "null" / "undefined".
    if (!key || key === "null" || key === "undefined") {
        warn("resolveSigHtml called with a non-id — refusing to fetch:", key);
        // A configuration fault, not a transport one: nothing the user can retry.
        fail("server", `non-id "${key}"`);
        return { html: null, source: "none", unassigned: false };
    }

    const fresh = sigCache.get(key);
    if (fresh) return { html: fresh, source: "cache", unassigned: false };

    // Held for the failure path only. Reading it now costs nothing (the map is
    // already parsed) and guarantees the fallback is available even if a later
    // purge or wipe runs in between.
    const stale = sigCache.get(key, { skipTtl: true });
    if (stale) log(`id=${key} cache stale (age=${sigCache.age(key)}ms) — refreshing`);

    // ── FALLBACK ORDER WHEN THE NETWORK CANNOT ANSWER ────────────────────────
    //   1. our own stale copy of THIS id — still the right signature, just old
    //   2. the cached DEFAULT — the right shape of thing, wrong id
    //   3. nothing, and leave the body alone
    //
    // (2) is cache-only on purpose: this runs at the failure point, the budget
    // is already spent (or the network is already known to be unreachable), so
    // a second round trip would turn one timeout into two. The default is
    // warmed on every platform by prefetchSignatures (J).
    //
    // The recorded failure kind is DELIBERATELY left untouched in both cases:
    // the user is still told what actually went wrong, because the mail is
    // going out with something other than a freshly confirmed signature.
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
        // Account-scoped: onFromChangedHandler clears the cache, but a fetch
        // already in flight for the PREVIOUS identity would otherwise resolve
        // afterwards and write that identity's HTML into the new one's cache.
        const inner = dedupe(`sig:${String(userEmail).toLowerCase()}:${key}`, () => (
            key === DEFAULT_ID ? fetchDefaultSignature(enc) : fetchSignatureById(key, enc)
        ).then((r) => {
            // Cache from the inner promise: a fetch that overran the budget
            // still warms the cache for the next activation instead of being
            // discarded and refetched.
            if (r.html) sigCache.set(key, r.html);
            return r;
        }));

        // v7.6 (ε): failureMsg is destructured. It was read in the plan-expired
        // branch below without ever being bound, so that branch threw a
        // ReferenceError into the catch and a lapsed subscription was reported
        // to the user as "check your connection".
        const { html, explicit, failure, failureMsg } = await withTimeout(
            inner, ms, key === DEFAULT_ID ? "default fetch" : `sig fetch ${key}`);

        if (html) return { html, source: "network", unassigned: false };

        if (failure === "plan_expired") {
            // No fallback here at all: the subscription is what lapsed, so a
            // cached copy is no more licensed than the live one — and silently
            // serving it is exactly how an expiry goes unnoticed for a TTL.
            fail("plan_expired", `id=${key}`, failureMsg);
            if (PURGE_CACHE_ON_PLAN_EXPIRED) { sigCache.wipe(); clearRulesCache(); }
            return { html: null, source: "none", unassigned: false, planExpired: true };
        }

        // Definitive empty answer = nothing is assigned server-side. A stale
        // copy of an id the server now disowns is still the last thing the
        // admin published for it, so it is preferred to a blank signature —
        // but the failure stands and the user is told.
        if (explicit) {
            fail("unassigned", `id=${key}`);
            return fallback(true);
        }
        fail(failure || "server", `id=${key}`);
        return fallback();
    } catch (e) {
        // withTimeout rejected: the call never came back inside the budget.
        warn(`resolveSigHtml failed id=${key}:`, e.message);
        fail("offline", `id=${key} ${e.message}`);
        return fallback();
    }
}

// Revalidate in the background and refresh the cache. Returns fresh HTML only
// when it actually differs from what we already applied.
//
// Silent on purpose (O): the user already has a signature on the mail, and a
// failed revalidation does not change that. Failures are logged, not reported.
// Goes through the same dedupe map so it cannot double up with a prefetch.
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
 *
 * v7.6: TTL-checked, so this now genuinely re-warms an aged entry instead of
 * seeing every entry as present forever.
 */
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
    flushSigCache();   // one stringify for the whole batch
}

// ─────────────────────────────────────────────────────────────────────────────
//  RECIPIENTS
//
//  FIX (E). THE RETURN CONTRACT IS THREE-VALUED, AND CALLERS DEPEND ON IT:
//     null  — the host did not answer (timeout, error, unsupported item).
//             Nothing can be concluded; do not evaluate, do not snapshot.
//     []    — the host answered: there are no recipients. This is a RESULT.
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
        ms: budgetMs(),
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
 * ONE READ PER DECISION — v7.6 (ζ).
 *
 * Each call costs up to FETCH_BUDGET_MS_COLD for To plus the same for Cc, plus
 * the (K) 400ms cold retry. It was being called three times per compose
 * evaluation and twice inside the send budget, for the same list. The memo is
 * keyed on the write token, so beginWrite() invalidates it and no result can
 * ever cross a decision boundary.
 *
 * ONLY SUCCESSFUL READS ARE MEMOISED. A null means the host did not answer, and
 * that must stay retryable — caching it would turn one slow read into a whole
 * decision's worth of "unreadable", which is exactly the (K) failure mode.
 *
 * FIX (K). Cold runtimes (Mac AND mobile) sometimes answer null or an empty
 * list on the first read of a list that is in fact populated. Retry once, and
 * prefer the retry only if it actually answered — a null retry must never
 * overwrite a good first read.
 *
 * @param {boolean} force  bypass the memo. Used by the empty-list recheck,
 *   where re-reading the same list is the entire point.
 */
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

    // Only a value that came from getComposeTypeAsync or a subject prefix is
    // authoritative. The non-strict assumption below is a GUESS, and caching or
    // persisting a guess poisons every later evaluation: the persisted-property
    // short circuit above would make a reply guessed as "compose" (the API
    // returns "" and the subject is not populated yet at OnNewMessageCompose)
    // stay "compose" for the life of the draft, so every context:"reply" rule
    // is skipped — including at send, where the API would by then have answered
    // correctly.
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
 *
 * v7.6: memoised on the parsed ruleset object (which parseRules keeps stable),
 * because findMatchingRule and prefetchSignatures both call this per activation
 * and it filters, allocates and sorts every time.
 */
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

// Pull the address out of whatever shape the backend used for an entry.
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

/**
 * `Senders` has arrived as an array of strings, as a bare string, and as an
 * array of objects. The old version read `.length` (truthy on a string) and
 * then called `.some` on it, which throws — and that rejection propagated out
 * of the `.filter` in findMatchingRule, killing the whole evaluation. Object
 * entries threw the same way inside `.toLowerCase()`.
 *
 * An unreadable list is NOT treated as "unrestricted": that silently widens a
 * rule to every sender in the tenant. Only a genuinely absent or empty list is.
 */
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

    if (!matched) {
        log(`senderMatches: no entry matched | priority=${rule?.priority}`,
            `| sender=${sender} | Senders=${JSON.stringify(list).slice(0, 300)}`);
    }
    return matched;
}

/**
 * @returns {Promise<{ rule: object|null, blocked: boolean }>}
 *   blocked = we could not evaluate safely, so the caller must NOT treat a null
 *   rule as "the default applies".
 *
 *   FIX (E): an EMPTY but successfully read recipient list is NOT blocked.
 *   FIX (F): NEITHER IS AN UNKNOWN COMPOSE TYPE, unless it can actually change
 *   the answer. Sender and recipient are filtered first; the compose type is
 *   consulted only when a surviving candidate is context-scoped. This is what
 *   makes mobile work — getComposeTypeAsync does not exist there.
 *   FIX (O): "no rules available at all" is recorded HERE rather than in
 *   fetchRules — a failed fetch that a cached ruleset covered for changed
 *   nothing the user can see. Recorded as a DEGRADATION, not a fatal error.
 */
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
//  not put the block at the end — on a reply it sits ABOVE the quoted original.
//  Every write is therefore wrapped in <div data-cb-sig="{id}">. Drafts written
//  by v7.4 have no wrapper and fall back to a token-run search.
//
//  WHAT IS COMPARED (HtmlContentSignature.PROFILES.body):
//    IN : visible text, link hrefs, image identity and order, block structure.
//    OUT: <style> bodies, inline CSS, <script>, cid:/blob:/data: URLs.
//  Excluded because the Word/OWA editors rewrite CSS wholesale and Outlook
//  rewrites remote <img src> to cid: attachment references the moment a
//  signature is inserted. A purely cosmetic CSS edit is therefore not detected;
//  accepted deliberately, since a signature attack has to change text, a link,
//  or an image to be worth mounting.
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

/**
 * v7.6 (η). Memoised. HCS.digest tokenises the entire signature HTML, and it
 * was called twice over the same string on every send — once by applyById for
 * P_SIG_DIGEST and once by verifySignatureOnBody for the admin-edit note.
 */
let _digestCache = { html: null, digest: null };

function sigDigest(html) {
    if (!HCS || html == null) return null;
    if (_digestCache.html === html) return _digestCache.digest;
    let d = null;
    try { d = HCS.digest(html, SIG_PROFILE); } catch (e) { warn("digest failed:", e); return null; }
    _digestCache = { html, digest: d };
    return d;
}

// null = could not read (host lacks the API, or the call failed/timed out).
// "" is a legitimate value: an empty draft body.
async function readBodyHtml(item) {
    if (typeof item?.body?.getAsync !== "function") return null;
    const res = await officeAsync(
        (cb) => item.body.getAsync(Office.CoercionType.Html, cb),
        { ms: budgetMs(), label: "body getAsync" }
    );
    return res ? String(res.value ?? "") : null;
}

/**
 * Is `expectedHtml` still intact on the draft?
 *
 * v7.5.1: the region classification lives in HCS.verifyInDraft, shared with the
 * Classic build. It splits the body at the quoted-thread boundary and only ever
 * inspects the LIVE area.
 *
 * @returns {Promise<{verdict:string, reason:string, note:string}>}
 *   identical  — untouched. The ONLY verdict that suppresses the write.
 *   modified   — recognisably our signature, edited.
 *   absent     — not in the live area (normal on mobile; also "user deleted it").
 *   duplicate  — more than one signature block in the live area.
 *   id-changed — the live block belongs to a different signature id.
 *   unknown    — could not tell. Treated as "write it".
 */
async function verifySignatureOnBody(item, expectedHtml, id) {
    if (!VERIFY_AT_SEND) return { verdict: "unknown", reason: "verification disabled", note: "" };
    if (!HCS) return { verdict: "unknown", reason: "signature module not loaded", note: "" };

    const body = await readBodyHtml(item);
    if (body === null) return { verdict: "unknown", reason: "body unreadable on this host", note: "" };

    // Did the expected copy itself change since we applied it? If so, a
    // mismatch below is an admin edit propagating, not a user tampering.
    let note = "";
    try {
        const prev = await getItemProp(item, P_SIG_DIGEST);
        if (prev && prev !== sigDigest(expectedHtml)) {
            note = "expected copy changed since compose (server-side update, not an edit)";
        }
    } catch (_) { }

    try {
        const r = HCS.verifyInDraft(expectedHtml, body, {
            ...SIG_PROFILE, markAttr: SIG_MARK_ATTR, sigId: id,
        });
        return { verdict: r.verdict, reason: `${r.scope}: ${r.reason}`, note };
    } catch (e) {
        // The comparison must never take the send down with it.
        warn("verifyInDraft threw:", e);
        return { verdict: "unknown", reason: `comparison failed: ${e.message}`, note };
    }
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
            { ms: budgetMs(), label: "appendOnSendAsync" }
        );
        if (res) { log("signature appended via appendOnSendAsync"); return true; }
    }

    fail("write_failed", isSendTime ? "setSignatureAsync/appendOnSendAsync" : "setSignatureAsync");
    return false;
}

/**
 * Apply the signature for `id`, guarded by the write token.
 *
 * FIX (M)/(N). No notifications here at all. It returns a result and leaves the
 * ledger populated; the caller reports once.
 *
 * @returns {Promise<{applied:boolean, status:string, verdict:string|null, digest:string|null}>}
 *   status: written | unchanged | detected | deferred | stale | failed
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

    // At compose, skip the write when this id is already the applied one.
    // OnMessageRecipientsChanged fires repeatedly as a recipient is typed and
    // resolved, and each pass previously re-resolved the HTML and rewrote the
    // body even when the decision had not changed — the visible "signatures
    // inserted one after another until the right rule wins". applySignature
    // clears P_ACTIVE_SIG on entry, so the FIRST insertion is unaffected.
    if (!isSendTime) {
        const activeNow = await getItemProp(item, P_ACTIVE_SIG);
        if (activeNow && String(activeNow) === key) {
            log(`compose: id=${key} already applied — no rewrite`);
            timed(`applyById (${key}, already-applied)`, t0);
            return { applied: true, status: "unchanged", verdict: null, digest: null };
        }
    }

    const { html, source, unassigned } = await resolveSigHtml(key, userEmail, {
        // Compose can afford a longer wait than a send; it is not racing the
        // user's click and there is no send budget wrapping it.
        budgetMs: isSendTime ? budgetMs() : 10_000,
    });

    if (!html) {
        // Never blank the body or substitute a guess: whatever is there already
        // is better than nothing. resolveSigHtml has already recorded WHY —
        // unassigned / offline / server / plan_expired — so the message is specific.
        warn(`could not resolve id=${key} (unassigned=${unassigned}) — leaving body as-is`);
        if (!hasFailure()) recordFailure("offline", `unresolved id=${key}`);
        return nothing("failed");
    }
    if (!isCurrent(seq)) { log(`stale write dropped (seq=${seq}, current=${_writeSeq})`); return nothing("stale"); }

    const digest = sigDigest(html);
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
        // NOTE: TAMPER_TAG is deliberately NOT prepended here. Re-inserting is
        // policy enforcement, not an accusation — and the user may have edited
        // the signature on purpose. Prepend it only if the product wants a
        // visible marker on the outgoing mail.
        if (!isCurrent(seq)) { log("stale write dropped after verification"); return nothing("stale"); }
    }

    const ok = await writeSignature(item, html, { isSendTime, sigId: key });
    if (!ok) return nothing("failed");
    log(`applied id=${key} from ${source} in ${since(t0)}`);

    if (revalidate && source !== "network" && userEmail && !isSendTime) {
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
//  persist it, and report ONCE.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Persist the decision, unless the item already says exactly this.
 *
 * v7.6: markActiveSignature costs a loadCustomPropertiesAsync + a saveAsync,
 * and OnMessageRecipientsChanged fires repeatedly while an address is typed.
 * When the id AND the snapshot both already match, there is nothing to write.
 * The digest is written when supplied and different, since that is what tells
 * send time an admin edit from a user edit.
 */
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
    const userEmail = mailbox?.userProfile?.emailAddress;

    const override = await getManualOverride(item);
    if (override) {
        // The pane writes P_ACTIVE_SIG alongside the override, so these agreeing
        // means the pinned signature is genuinely on the body and there is
        // nothing to do or say. They disagree when the pane's body write failed,
        // when a pre-contract pane pinned without wrapping, or when the write
        // lost a race — in which case doing nothing leaves the draft carrying a
        // signature nobody chose.
        const activeNow = await getItemProp(item, P_ACTIVE_SIG);
        if (activeNow && String(activeNow) === String(override)) {
            log("manual override active and already on the body:", override);
            return;
        }
        log("manual override active but body state unknown — reapplying:", override);
        showLoading(item);
        const rOv = await applyById(item, override, userEmail, seq, { revalidate: false });
        // Snapshot is null on purpose: a manual choice is recipient-independent,
        // and markActiveSignature removes the property, so send time re-evaluates
        // instead of comparing against a snapshot that means nothing.
        if (rOv.applied && isCurrent(seq)) {
            await markActiveSignature(item, override, null, rOv.digest);
        }
        if (isCurrent(seq)) {
            reportOutcome(item, rOv.applied ? "applied" : rOv.status === "deferred" ? "quiet" : "failed");
        }
        return;
    }

    // Progress goes up only after the override check, so a user-chosen
    // signature never flashes a message about work that is not happening.
    showLoading(item);

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

    // v7.5.2 (AA): revalidate:false. This fired a fetch for the SAME id on every
    // cache-hit apply — one guaranteed request per compose and per recipient
    // change — bypassing the dedupe map so it could race a prefetch. With v7.6
    // (α) the TTL genuinely bounds staleness at five minutes, which is what that
    // change assumed all along. Set back to true only if admin-side edits must
    // land mid-compose rather than within one TTL window.
    const result = await applyById(item, targetId, userEmail, seq, { revalidate: false });
    const applied = result.applied;

    // FIX (L). Persist the decision even when this host could not write it yet
    // (mobile has no setSignatureAsync). Without this the compose-time decision
    // was discarded and the send runtime had to start from nothing.
    const deferred = result.status === "deferred";
    if ((applied || deferred) && isCurrent(seq)) {
        // v7.6 (ζ): this is the SAME read findMatchingRule evaluated against —
        // memoised on the write token — so the snapshot now describes the set
        // the decision was actually made for. It may still be null if the read
        // failed, in which case markActiveSignature removes the property and
        // send time re-evaluates rather than comparing against nothing.
        const snapshot = serializeRecipients(await readRecipientEmails(item));
        await persistDecision(item, targetId, snapshot, result.digest);
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
    // v7.6 (ζ): findMatchingRule below reuses this exact read.
    const currentSnap = serializeRecipients(await readRecipientEmails(item));

    // getManualOverride validates and returns null for an unresolvable pin, so
    // an unusable value falls through to normal rule evaluation. persist:false —
    // a pin is the user's decision, not an evaluation result to record.
    const override = await getManualOverride(item);
    if (override) {
        return { id: override, snapshot: currentSnap, reason: "manual override", persist: false };
    }

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
    const fallbackId = activeId || await getActiveSignatureId(item, { allowRoam: currentSnap === null });
    if (fallbackId) {
        return { id: fallbackId, snapshot: currentSnap, reason: "evaluation blocked — persisted id", persist: false };
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

    // Make sure anything the send warmed survives the runtime, which on a cold
    // host is about to be torn down with the item.
    flushSigCache();
    timed(`onSendCore (${r.status})`, t0);
}

// ─────────────────────────────────────────────────────────────────────────────
//  ENTRY POINTS
//
//  Every one of them opens with the same three lines: invalidateProps (v7.5.2 —
//  the pane may have pinned since the last activation), invalidateCaches (v7.6
//  β — the pane may have refreshed storage since the last activation), and
//  beginWrite (a new decision: new write token, empty ledger, no recipient memo
//  carried over).
// ─────────────────────────────────────────────────────────────────────────────

// Every handler completes exactly once, even if the body throws.
function makeCompleter(label, t0, event, args) {
    let done = false;
    return () => {
        if (done) return;
        done = true;
        flushSigCache();   // never end an activation with a pending cache write
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
        invalidateProps(item);
        invalidateCaches();
        log(`applySignature start — ${CB_VERSION} on ${detectPlatform()} (X-Platform: ${getXPlatform()})`);

        // FIX (M): no "Preparing your signature..." — the bar stays empty until
        // there is an outcome. FIX (N): beginWrite() also clears the ledger, so
        // everything below is attributed to this decision only.
        const seq = beginWrite();
        const userEmail = mailbox?.userProfile?.emailAddress;

        // v7.5.2 (Y). The pin is checked BEFORE the state reset, matching
        // Classic's runPipeline. Clearing P_ACTIVE_SIG on a pinned draft forces
        // a needless body write on every re-open.
        const pinned = await getManualOverride(item);
        if (pinned) log("manual override present at compose — not resetting active id:", pinned);
        else await markActiveSignature(item, null);

        // Persist the compose type here, in a runtime where the API behaves.
        // The send runtime reads it instead of re-deriving it.
        const composeTypeP = getComposeType(item, { persist: true })
            .then((t) => log("composeType at compose:", t))
            .catch((e) => warn("composeType resolution failed:", e));

        // Warm the rules cache before evaluating. With fix (A) getCachedRules()
        // genuinely returns null once the TTL lapses, so this actually refetches
        // — and with v7.6 (β) it is no longer answered by a memo written before
        // the taskpane's last refresh, nor (δ) by the WebView's HTTP cache.
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
        // the next recipients-changed event compare against nothing. Memoised,
        // so evaluateAndApply below reuses this read rather than repeating it.
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
        invalidateProps(item);   // v7.5.2 — the pane may have pinned since the last event
        invalidateCaches();      // v7.6 (β)

        // v7.6 (ζ): the token is taken HERE, before the first recipient read,
        // not later when evaluateAndApply is called. It is what scopes the
        // recipient memo, so a read taken before it would be attributed to the
        // PREVIOUS decision and could be answered from that decision's memo.
        const seq = beginWrite();

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
            // force:true — re-reading is the entire point, so the memo must not
            // answer with the empty list we are trying to double-check.
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
        invalidateProps(item);   // v7.5.2
        invalidateCaches();      // v7.6 (β)
        log("from changed — re-evaluating for the new account");

        const seq = beginWrite();
        const userEmail = mailbox?.userProfile?.emailAddress;

        // The account changed, so every cached signature and rule belongs to
        // the previous identity. FIX (B): clearRulesCache() drops the ROAMED
        // copy too — v7.0 cleared localStorage only, and the next read fell
        // straight through to roaming and matched the old account's rules.
        sigCache.wipe();         // also drops the parsed map and any pending flush
        _inFlight.clear();
        _encCache = { plain: null, cipher: null };
        _digestCache = { html: null, digest: null };
        clearRulesCache();
        await markActiveSignature(item, null);

        if (userEmail) await fetchRules(await encryptEmail(userEmail));

        const snap0 = serializeRecipients(await readRecipientEmails(item));
        if (snap0 !== null) _lastSnapshot = snap0;

        await evaluateAndApply(item, mailbox, seq);

        // The new identity's cache is empty by definition — warm it now rather
        // than at send, where the budget is tighter.
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
    // Always allow the send: a signature problem must never block the user.
    const complete = makeCompleter("onSendHandler total", t0, event, { allowEvent: true });

    try {
        if (!item) return complete();
        // v7.5.2. CRITICAL at send: the pane's pin is very often written during
        // this compose session, i.e. after the compose activation cached its bag.
        invalidateProps(item);
        invalidateCaches();      // v7.6 (β) — and the pane may have refreshed the HTML too
        log(`onSendHandler start — ${CB_VERSION} on ${detectPlatform()}`);

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
//  never put logic here that a handler depends on. That is precisely why
//  sigCache.purge() moved into beginWrite() in v7.6: purging from here evicted
//  nothing at all on the one platform where the runtime outlives the activation.
// ─────────────────────────────────────────────────────────────────────────────

Office.onReady(() => {
    log(`ready — ${CB_VERSION} | platform=${detectPlatform()} | X-Platform=${getXPlatform()} | session=${getSessionId()}`);
    try {
        const d = Office.context.mailbox?.diagnostics;
        if (d) log(`host=${d.hostName} version=${d.hostVersion}`);
    } catch (_) { }
    log("rules cache at startup:", describeRulesSource());
    if (!HCS) warn("html-content-signature.js not loaded — send-time verification disabled");
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