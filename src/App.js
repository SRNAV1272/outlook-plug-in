/* global Office */
import React, { useEffect, useState } from "react";
import { getOfficeToken, login, setToken, getToken } from "./services/authService";
import LoginForm from "./components/LoginForm";
import SignatureView from "./components/SignatureView";
// import SignatureView from "./";

export default function App({ user }) {
  const [mode, setMode] = useState("init"); // init | login | ready
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    // console.log("sdkjahdskjashdkjasd", )
    init();
  }, []);

  async function init() {
    setLoading(true);
    setError("");

    // 1️⃣ Check cached token
    const cached = getToken();
    if (cached) {
      await loadSignature();
      return;
    }

    // 2️⃣ Try Office SSO (ONLY if available)
    try {
      const token = await getOfficeToken();
      const payload = decodeJwt(token);
      setToken(token, payload.exp, "aad");
      await loadSignature();
    } catch (e) {
      console.warn("SSO unavailable or failed → login fallback", e);
      setMode("ready");
      setLoading(false);
    }
  }

  async function loadSignature() {
    try {
      setLoading(true);
      // const data = await fetchSignature(); // MUST return { html }
      // setSignature(data.html);
      setMode("ready");
    } catch (e) {
      console.error("Signature load failed", e);
      setError("Unable to load signature");
      setMode("ready");
    } finally {
      setLoading(false);
    }
  }

  async function handleLogin(form) {
    try {
      setLoading(true);
      await login(form.username, form.password);
      await loadSignature();
    } catch {
      setError("Invalid username or password");
      setMode("ready");
    } finally {
      setLoading(false);
    }
  }

  function applySignature(signature) {
    if (!signature) return;

    // ✅ Ensure Office.js is available
    if (typeof Office === "undefined") {
      console.error("Office.js not available");
      return;
    }

    Office.onReady(() => {
      const item = Office.context?.mailbox?.item;

      // ✅ Must be in compose mode
      if (!item || !item.body) {
        console.error("Not in compose mode");
        return;
      }

      item.body.setSignatureAsync(
        signature,
        { coercionType: Office.CoercionType.Html },
        (result) => {
          if (result.status === Office.AsyncResultStatus.Failed) {
            console.error("Apply signature failed:", result.error);
            alert(result.error.message);
          } else {
            console.log("Signature applied successfully");
          }
        }
      );
    });
  }

  if (mode === "login") {
    return <LoginForm onLogin={handleLogin} loading={loading} error={error} />;
  }

  if (mode === "ready") {
    return (
      <SignatureView
        user={user}
        apply={applySignature}
        refresh={loadSignature}
        loading={loading}
        error={error}
      />
    );
  }

  return <div>Initializing add-in…</div>;
}

function decodeJwt(token) {
  const base64 = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(atob(base64));
}
