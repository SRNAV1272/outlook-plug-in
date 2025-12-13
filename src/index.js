import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";

const render = () => {
  const container = document.getElementById("root");
  const root = ReactDOM.createRoot(container);
  root.render(<App />);
};

// 🔹 If running inside Outlook
if (typeof Office !== "undefined") {
  Office.onReady(() => {
    render();
  });
} else {
  // 🔹 Normal browser (localhost, preview, dev)
  render();
}
