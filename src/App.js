/* global Office */
import React, { useCallback, useEffect, useState } from "react";
import { getOfficeToken, login, setToken, getToken } from "./services/authService";
import LoginForm from "./components/LoginForm";
import SignatureView from "./components/SignatureView";

// =============================================================================
//  CardByte taskpane — App.js (aligned with event-handler.js v7.5.1)
//
//  WHY THIS FILE CHANGED
//
//  The event runtime moved to "the signature ID is the state, the HTML is a
//  disposable cache" (v7.5). The taskpane was still on the old contract: it
//  wrote raw HTML with setSignatureAsync and set ONE item property
//  (cardbyte_manual_sig_id). Three consequences, all of which looked like
//  "the event handler stopped switching signatures":
//
//   1. P_MANUAL_SIG WAS A PERMANENT VETO. evaluateAndApply returns early on it
//      and decideSendId returns it before consulting any rule, and nothing ever
//      removed it. One manual apply pinned the draft for its whole life — no
//      recipient change, no From change, no send-time correction. There is now
//      an explicit unpin (`unpinSignature`), which is the only real cure.
//
//   2. THE MANUAL WRITE WAS INVISIBLE TO SEND-TIME VERIFICATION. v7.5 wraps
//      every write in <div data-cb-sig="{id}"> because there is no API for
//      reading back just the signature block. An unwrapped manual write falls
//      through to the unmarked token-run search, which only happens to succeed
//      while resolveSigHtml({id}) returns content equivalent to what was
//      written. Manual writes are now wrapped identically.
//
//   3. THE PROPERTY BAG WAS CLOBBERED. CustomProperties.saveAsync serialises
//      the WHOLE in-memory bag, and the event runtime memoises one handle per
//      item for its lifetime. On Windows/OWA (shared, long-lived runtime) a
//      handle loaded before this pane's write gets written back afterwards and
//      DELETES the manual flag. Fixed on the event-handler side by
//      invalidating that cache per activation; this file keeps its own handle
//      per item and re-reads after every save so the two stay in step.
//
//  THE FOUR PROPERTY NAMES AND THE WRAPPER ATTRIBUTE BELOW ARE A SHARED ABI.
//  Change one here and you must change it in event-handler.js. Better: move
//  this block into a cb-contract.js that both bundles import.
// =============================================================================

const P_MANUAL_SIG = "cardbyte_manual_sig_id";
const P_ACTIVE_SIG = "cardbyte_active_sig_id";
const P_SIG_DIGEST = "cardbyte_sig_digest";
const P_RECIP_SNAPSHOT = "cardbyte_recip_snapshot";

const SIG_MARK_ATTR = "data-cb-sig";

// The id standing for "the user's default (non-rule) signature". MUST match
// DEFAULT_ID in event-handler.js: any other value for the default is requested
// at /rules-config/get/{id}, 404s, and reaches the user as "No signature is
// assigned to your account".
const DEFAULT_ID = "default";

// The event runtime enforces this, not the 500KB/200KB the old file declared.
// Writing something larger here means the send-time re-insert fails with
// "Signature exceeds the allowed size" — so hold the same ceiling.
const MAX_SIG_BYTES = 100 * 1024;

// html-content-signature.js is UMD and attaches to `self`. Bundle it into the
// taskpane as well as the event bundle and the digest recorded here is directly
// comparable with the one the event runtime computes. Absent, we record no
// digest — send time then cannot tell an admin-side update from a user edit,
// which is informational only (both re-insert).
const HCS = null;
const SIG_PROFILE = HCS ? HCS.PROFILES.body : null;

// ─────────────────────────────────────────────────────────────────────────────
//  PLATFORM DETECTION
//
//  The old version read Office.context.platform, which DOES NOT EXIST — the
//  same fault event-handler.js documents as fix (D). It always resolved to "",
//  so every branch fell through to the user-agent guess and isMac() could never
//  return true (detectPlatform never returned "mac" at all). The real property
//  is Office.context.diagnostics.platform, Mailbox 1.5+; UA stays as fallback
//  for stripped runtimes and older requirement sets.
// ─────────────────────────────────────────────────────────────────────────────

let _platform = null;

export function detectPlatform() {
  if (_platform) return _platform;

  const PT = typeof Office !== "undefined" ? Office.PlatformType : null;
  const d = (() => {
    try { return Office?.context?.diagnostics?.platform || null; } catch { return null; }
  })();
  const ua = (() => {
    try { return (navigator?.userAgent || "").toLowerCase(); } catch { return ""; }
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
  if (ua.includes("outlook-ios") || ua.includes("outlookmobile")) {
    return (_platform = uaMobile() || "mobile-ios");
  }
  const m = uaMobile();
  if (m) return (_platform = m);
  if (ua.includes("macintosh") || ua.includes("mac os x")) return (_platform = "mac");

  return (_platform = "owa");
}

export const isMobilePlatform = () => detectPlatform().startsWith("mobile-");
export const isOWAPlatform = () => detectPlatform() === "owa";
export const isMacPlatform = () => detectPlatform() === "mac";

// Hosts with no setSignatureAsync (mobile) cannot write from the pane at all.
// Surfacing this is better than letting the apply silently reject: the send-time
// handler is what puts a signature on the mail there.
const hostCanSetSignature = (item) => typeof item?.body?.setSignatureAsync === "function";

// ─────────────────────────────────────────────────────────────────────────────
//  ITEM CUSTOM PROPERTIES
//
//  One handle per item, and saveAsync is AWAITED — a fire-and-forget save races
//  a Send that happens moments later and the property never lands. The handle is
//  dropped after every successful save so the next read reflects anything the
//  event runtime wrote in between; keeping it would recreate the clobber this
//  file exists to fix, just in the other direction.
// ─────────────────────────────────────────────────────────────────────────────

const _propsByItem = new WeakMap();

function loadCustomProps(item) {
  if (!item) return Promise.resolve(null);
  if (_propsByItem.has(item)) return _propsByItem.get(item);

  const p = new Promise((resolve) => {
    if (typeof item.loadCustomPropertiesAsync !== "function") return resolve(null);
    try {
      item.loadCustomPropertiesAsync((res) =>
        resolve(res?.status === Office.AsyncResultStatus.Succeeded ? res.value : null));
    } catch { resolve(null); }
  });

  _propsByItem.set(item, p);
  return p;
}

const invalidateProps = (item) => { if (item) _propsByItem.delete(item); };

/** One awaited saveAsync for a whole decision. `null` removes a key. */
async function setItemProps(item, kv) {
  const props = await loadCustomProps(item);
  if (!props) return false;
  try {
    for (const [k, v] of Object.entries(kv)) {
      if (v == null) props.remove(k);
      else props.set(k, String(v));
    }
    const ok = await new Promise((resolve) =>
      props.saveAsync((res) => resolve(res?.status === Office.AsyncResultStatus.Succeeded)));
    invalidateProps(item);
    return ok;
  } catch (e) {
    console.warn("[CardByte] setItemProps threw:", e);
    invalidateProps(item);
    return false;
  }
}

async function getItemProp(item, key) {
  try {
    const v = (await loadCustomProps(item))?.get(key);
    return v == null ? null : String(v);
  } catch { return null; }
}

// ─────────────────────────────────────────────────────────────────────────────
//  BODY WRITE
// ─────────────────────────────────────────────────────────────────────────────

function escAttr(v) {
  return String(v)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Byte-identical to wrapSignature() in event-handler.js: a bare <div> with one
// data attribute. No id (would collide if a mail carried two), no class, no
// styling that could alter layout.
const wrapSignature = (html, id) => `<div ${SIG_MARK_ATTR}="${escAttr(id)}">${html}</div>`;

function bodySetSignatureAsync(item, html) {
  return new Promise((resolve, reject) => {
    if (!hostCanSetSignature(item)) {
      reject(new Error("This version of Outlook can't set the signature from here."));
      return;
    }
    item.body.setSignatureAsync(html, { coercionType: Office.CoercionType.Html }, (r) =>
      r?.status === Office.AsyncResultStatus.Succeeded ? resolve() : reject(r?.error || new Error("setSignatureAsync failed")));
  });
}

// An id the event runtime can actually resolve. resolveSigHtml() refuses the
// literal "null"/"undefined" and records a config failure, so catch it here
// where we can tell the user something useful instead.
function isResolvableId(id) {
  const s = String(id ?? "").trim();
  return s !== "" && s !== "null" && s !== "undefined";
}

// ─────────────────────────────────────────────────────────────────────────────
//  AUTO-APPLY CONTEXT
//  ?autoApply=1 → the pane was opened automatically via ItemEdit form load
//  (Outlook 2016 / 2019 / mobile — no LaunchEvent support there).
// ─────────────────────────────────────────────────────────────────────────────

function isAutoApplyContext() {
  try {
    return new URLSearchParams(window.location.search).get("autoApply") === "1";
  } catch { return false; }
}

// ─────────────────────────────────────────────────────────────────────────────
//  APP
// ─────────────────────────────────────────────────────────────────────────────

export default function App({ user }) {
  const [mode, setMode] = useState("init");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  // Which id, if any, the user has pinned on THIS item. Drives the unpin
  // control — without a way back, a pin is permanent for the draft.
  const [pinnedId, setPinnedId] = useState(null);

  const autoApply = isAutoApplyContext();
  const platform = detectPlatform();
  const mobile = isMobilePlatform();

  const readPinnedId = useCallback(async () => {
    const item = Office?.context?.mailbox?.item;
    if (!item) return;
    invalidateProps(item); // the event runtime may have written since we last read
    setPinnedId(await getItemProp(item, P_MANUAL_SIG));
  }, []);

  const loadSignature = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      await readPinnedId();
      setMode("ready");
    } catch (e) {
      console.warn("[CardByte] loadSignature failed:", e);
      setError("Couldn't load your signature. Check your connection and try again.");
      setMode("ready");
    } finally {
      setLoading(false);
    }
  }, [readPinnedId]);

  const init = useCallback(async () => {
    setLoading(true);
    setError("");
    if (getToken()) return loadSignature();
    try {
      const token = await getOfficeToken();
      const payload = decodeJwt(token);
      setToken(token, payload?.exp, "aad");
      await loadSignature();
    } catch (e) {
      // The old version set mode "ready" here, so LoginForm was unreachable and
      // an SSO failure showed an empty signature view instead of a sign-in.
      console.warn("[CardByte] SSO unavailable — falling back to sign-in", e);
      setMode("login");
      setLoading(false);
    }
  }, [loadSignature]);

  useEffect(() => { init(); }, [init]);

  /* ── Manual apply / unpin ─────────────────────────────────────────────── */

  /**
   * Apply a signature the user picked, and pin it so the rules engine leaves it
   * alone for the rest of this draft.
   *
   * `sigId` must be a real rule signatureId, or DEFAULT_ID for the user's
   * non-rule signature. A display-only id 404s in the event runtime.
   */
  const applySignature = useCallback(async (signature, sigId) => {
    setError("");

    if (!signature) { setError("That signature is empty. Pick another one."); return false; }
    if (!isResolvableId(sigId)) {
      console.error("[CardByte] applySignature called without a resolvable id:", sigId);
      setError("That signature can't be applied. Please contact your administrator.");
      return false;
    }

    const item = Office?.context?.mailbox?.item;
    if (!item) { setError("Open a message first, then apply a signature."); return false; }
    if (!hostCanSetSignature(item)) {
      // Mobile. Nothing to write here; the send-time handler is what applies it.
      setError("This version of Outlook applies signatures when you send. Your choice has been saved.");
      await setItemProps(item, { [P_MANUAL_SIG]: String(sigId) });
      setPinnedId(String(sigId));
      return false;
    }

    const payload = wrapSignature(signature, sigId);
    const bytes = new Blob([payload]).size;
    if (bytes > MAX_SIG_BYTES) {
      console.error(`[CardByte] signature ${bytes}B exceeds ${MAX_SIG_BYTES}B — not applying`);
      setError("This signature is too large to apply. Please contact your administrator.");
      return false;
    }

    setLoading(true);
    try {
      await bodySetSignatureAsync(item, payload);

      // The id IS the state. Record it as the ACTIVE id too, so the event
      // runtime's compose short-circuit and its send-time verification both see
      // a body they can account for instead of an unexplained block.
      await setItemProps(item, {
        [P_MANUAL_SIG]: String(sigId),
        [P_ACTIVE_SIG]: String(sigId),
        // Cleared rather than left stale: a digest from an earlier rule apply
        // makes send time log a deliberate user action as a server-side update.
        [P_SIG_DIGEST]: HCS ? HCS.digest(signature, SIG_PROFILE) : null,
        // A manual choice is recipient-independent, so a snapshot would be a
        // lie. Removing it makes send time re-evaluate rather than trust a
        // comparison against something never measured.
        [P_RECIP_SNAPSHOT]: null,
      });

      setPinnedId(String(sigId));
      console.log("[CardByte] manual signature applied and pinned:", sigId, `(${bytes}B)`);
      return true;
    } catch (e) {
      console.error("[CardByte] applySignature failed:", e);
      setError("Couldn't apply that signature. Try again, or contact your administrator.");
      return false;
    } finally {
      setLoading(false);
    }
  }, []);

  /**
   * Hand this draft back to the rules.
   *
   * Removing P_ACTIVE_SIG as well is what makes the next recipient change or
   * send actually RE-EVALUATE: applyById short-circuits at compose when
   * P_ACTIVE_SIG already equals the target id, and decideSendId reuses it when
   * the recipient snapshot still matches. Clearing only P_MANUAL_SIG would lift
   * the veto and then keep applying the same signature anyway.
   *
   * The body is deliberately not rewritten here — the next event corrects it,
   * and on hosts where no event fires, send time does.
   */
  const unpinSignature = useCallback(async () => {
    const item = Office?.context?.mailbox?.item;
    if (!item) return false;

    setLoading(true);
    setError("");
    try {
      const ok = await setItemProps(item, {
        [P_MANUAL_SIG]: null,
        [P_ACTIVE_SIG]: null,
        [P_SIG_DIGEST]: null,
        [P_RECIP_SNAPSHOT]: null,
      });
      if (!ok) {
        setError("Couldn't switch back to automatic. Try again.");
        return false;
      }
      setPinnedId(null);
      console.log("[CardByte] manual override cleared — rules resume on the next change or send");
      return true;
    } finally {
      setLoading(false);
    }
  }, []);

  /* ── Auth ─────────────────────────────────────────────────────────────── */

  const handleLogin = useCallback(async (form) => {
    setLoading(true);
    setError("");
    try {
      await login(form.username, form.password);
      await loadSignature();
    } catch {
      setError("That username or password didn't work.");
      setMode("login");
    } finally {
      setLoading(false);
    }
  }, [loadSignature]);

  /* ── Render ───────────────────────────────────────────────────────────── */

  if (mode === "login") {
    return <LoginForm onLogin={handleLogin} loading={loading} error={error} />;
  }

  if (mode === "ready") {
    return (
      <SignatureView
        Office={Office}
        user={user}
        apply={applySignature}
        unpin={unpinSignature}
        pinnedId={pinnedId}
        defaultId={DEFAULT_ID}
        refresh={loadSignature}
        loading={loading}
        error={error}
        autoApply={autoApply}
        isMobile={mobile}
        platform={platform}
      />
    );
  }

  return <div>Loading your signatures…</div>;
}

function decodeJwt(token) {
  try {
    const part = String(token).split(".")[1];
    if (!part) return null;
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), "=")));
  } catch {
    return null;
  }
}