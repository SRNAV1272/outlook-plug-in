import React, { useEffect, useState } from "react";
import { getOfficeToken, login, setToken, getToken } from "./services/authService";
import { fetchSignature } from "./services/apiClient";
import LoginForm from "./components/LoginForm";
import SignatureView from "./components/SignatureView";

export default function App() {
  const [mode, setMode] = useState("init"); // init | login | ready
  const [loading, setLoading] = useState(false);
  const [signature, setSignature] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
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
      setMode("login");
      setLoading(false);
    }
  }

  async function loadSignature() {
    try {
      setLoading(true);
      const data = await fetchSignature(); // MUST return { html }
      setSignature(data.html);
      setMode("ready");
    } catch (e) {
      console.error("Signature load failed", e);
      setError("Unable to load signature");
      setMode("login");
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
      setMode("login");
    } finally {
      setLoading(false);
    }
  }

  function applySignature() {
    if (!signature) return;

    Office.context.mailbox.item.body.setSignatureAsync(
      signature,
      { coercionType: Office.CoercionType.Html },
      (result) => {
        if (result.status === Office.AsyncResultStatus.Failed) {
          console.error(result.error);
          alert(result.error.message);
        }
      }
    );
  }

  if (mode === "login") {
    return <LoginForm onLogin={handleLogin} loading={loading} error={error} />;
  }

  if (mode === "ready") {
    return (
      <SignatureView
        html={signature}
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
