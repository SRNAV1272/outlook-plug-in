// import React, { useEffect, useState } from "react";
// import { getOfficeToken, login, setToken, getToken } from "./services/authService";
// import { fetchSignature } from "./services/apiClient";
// import LoginForm from "./components/LoginForm";
// import SignatureView from "./components/SignatureView";

// export default function App() {
//   const [mode, setMode] = useState("init");

//   useEffect(() => { init(); }, []);

//   async function init() {
//     const token = getToken();
//     if (token) return load();

//     try {
//       const office = await getOfficeToken();
//       const exp = JSON.parse(atob(office.split('.')[1])).exp;
//       setToken(office, exp, "aad");
//       load();
//     } catch {
//       // setMode("ready");
//       load()
//     }
//   }

//   async function load() {
//     setMode("ready");
//   }

//   function apply(html) {
//     console.log("APPLY SIGNATURE:", html);
//     Office.context.mailbox.item.body.setSignatureAsync(html, { coercionType: Office.CoercionType.Html });
//   }

//   async function handleLogin(f) {
//     await login(f.username, f.password);
//     load();
//   }
//   console.log("MODE:", mode);
//   if (mode === "login") return <LoginForm onLogin={handleLogin} />;
//   if (mode === "ready") return <SignatureView apply={apply} refresh={load} />;
//   return <div>Loading...</div>;
// }
// import React, { useEffect, useState } from "react";
// import { getOfficeToken, login, setToken, getToken } from "./services/authService";
// import { fetchSignature } from "./services/apiClient";
// import LoginForm from "./components/LoginForm";
// import SignatureView from "./components/SignatureView";

// export default function App() {

//   const [mode, setMode] = useState("init");   // init | login | ready
//   const [loading, setLoading] = useState(true);
//   const [signature, setSignature] = useState("");
//   const [error, setError] = useState("");

//   useEffect(() => {
//     init();
//   }, []);

//   async function init() {
//     setLoading(true);
//     setError("");

//     const cached = getToken();
//     if (cached) {
//       await loadSignature();
//       return;
//     }

//     try {
//       const token = await getOfficeToken();
//       const payload = decodeJwt(token);
//       setToken(token, payload.exp, "aad");
//       await loadSignature();
//     } catch (e) {
//       console.warn("SSO failed, switching to login", e);
//       setMode("ready");
//       setLoading(false);
//     }
//   }

//   async function loadSignature() {
//     try {
//       setLoading(true);
//       // const data = await fetchSignature();
//       // setSignature(data.html);
//       setMode("ready");
//     } catch (e) {
//       console.error("Failed to load signature", e);
//       setError(e.message || "Failed to load signature");
//       setMode("ready");
//     } finally {
//       setLoading(false);
//     }
//   }

//   async function handleLogin(form) {
//     try {
//       setLoading(true);
//       await login(form.username, form.password);
//       await loadSignature();
//     } catch (e) {
//       setError("Invalid username or password");
//       setMode("ready");
//     } finally {
//       setLoading(false);
//     }
//   }

//   function applySignature(signature) {
//     if (!signature) return;

//     Office.context.mailbox.item.body.setSignatureAsync(
//       signature,
//       { coercionType: Office.CoercionType.Html },
//       (result) => {
//         if (result.status === Office.AsyncResultStatus.Failed) {
//           console.error("Failed to apply signature:", result.error);
//           alert("Failed to apply signature: " + result.error.message);
//         }
//       }
//     );
//   }

//   if (mode === "login") {
//     return <LoginForm onLogin={handleLogin} loading={loading} error={error} />;
//   }

//   if (mode === "ready") {
//     return (
//       <SignatureView
//         html={signature}
//         apply={applySignature}
//         refresh={loadSignature}
//         loading={loading}
//         error={error}
//       />
//     );
//   }

//   return <div>Initializing add-in...</div>;
// }

// // ✅ JWT decode helper
// function decodeJwt(token) {
//   const base64 = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
//   return JSON.parse(atob(base64));
// }
