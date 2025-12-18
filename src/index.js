/* global Office */

import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";

const render = (user) => {
    const container = document.getElementById("root");

    if (!container) return;

    const root = ReactDOM.createRoot(container);
    root.render(<App user={user} />);
};

const getUserFromOffice = () => {
    try {
        if (
            Office?.context &&
            Office.context.mailbox &&
            Office.context.mailbox.userProfile
        ) {
            return Office.context.mailbox.userProfile;
        }
    } catch (e) {
        console.warn("Office context not ready:", e);
    }

    return null;
};

// Outlook Add-in
if (typeof Office !== "undefined") {
    Office.onReady((info) => {
        if (info.host === Office.HostType.Outlook) {
            const user = getUserFromOffice();

            render(
                user ?? {
                    accountType: "office365",
                    displayName: "Test User",
                    emailAddress: "test@outlook.com",
                    timeZone: "India Standard Time",
                }
            );
        } else {
            // Office loaded but NOT Outlook
            render({
                accountType: "office365",
                displayName: "Sai Rajesh Korla",
                emailAddress: "sairajesh.korla1272@outlook.com",
                timeZone: "India Standard Time",
            });
        }
    });
} else {
    // Browser / local testing
    render({
        accountType: "office365",
        displayName: "Sai Rajesh Korla",
        emailAddress: "sairajesh.korla1272@outlook.com",
        timeZone: "India Standard Time",
    });
}
