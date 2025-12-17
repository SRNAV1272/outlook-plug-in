/* global Office */

import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";

const render = (user) => {
    const container = document.getElementById("root");
    const root = ReactDOM.createRoot(container);
    root.render(<App user={user} />);
};

// Outlook Add-in
// eslint-disable-next-line no-undef
if (typeof Office !== "undefined") {
    Office.onReady(() => {
        const user = Office.context.mailbox.userProfile
        render(user);
    });
} else {
    render(
        {
            accountType: "office365",
            displayName: "Sai Rajesh Korla",
            emailAddress: "sairajesh.korla1272@outlook.com", // "sairajesh.korla@navajna.com",
            timeZone: "India Standard Time"
        }
    );
}
