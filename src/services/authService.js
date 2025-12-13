/* global OfficeRuntime */

const STORAGE_KEY = "signature_addin_token";

export function setToken(token, exp, type) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ token, exp, type }));
}

export function getToken() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;

  const data = JSON.parse(raw);
  if (data.exp < Math.floor(Date.now() / 1000)) {
    localStorage.removeItem(STORAGE_KEY);
    return null;
  }
  return data;
}

export async function getOfficeToken() {
  if (!window.OfficeRuntime || !OfficeRuntime.auth) {
    throw new Error("OfficeRuntime not available");
  }

  return OfficeRuntime.auth.getAccessToken({
    allowSignInPrompt: true,
    allowConsentPrompt: true,
  });
}

export async function login(username, password) {
  const res = await fetch(
    process.env.REACT_APP_API_BASE_URL + "/auth/login",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    }
  );

  if (!res.ok) throw new Error("Login failed");

  const data = await res.json();
  const exp = Math.floor(Date.now() / 1000) + data.expiresIn;
  setToken(data.token, exp, "app");
}
