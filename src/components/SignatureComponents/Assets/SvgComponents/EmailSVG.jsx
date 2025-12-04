import React from "react";

const Index = ({ color = "#000", size = 100 }) => {
    return (
        <svg
            viewBox="0 0 512 512"
            width={size}
            height={size}
            xmlns="http://www.w3.org/2000/svg"
            style={{ display: "block", color }}
            preserveAspectRatio="xMidYMid meet"
        >

            {/* Envelope Outline */}
            <rect
                x="56"
                y="120"
                width="400"
                height="272"
                rx="36"
                ry="36"
                fill="none"
                stroke="currentColor"
                strokeWidth="24"
            />

            {/* Top Flap */}
            <path
                d="M80 140 L256 290 L432 140"
                fill="none"
                stroke="currentColor"
                strokeWidth="22"
                strokeLinecap="round"
                strokeLinejoin="round"
            />

            {/* Bottom left */}
            <path
                d="M80 380 L210 260"
                fill="none"
                stroke="currentColor"
                strokeWidth="22"
                strokeLinecap="round"
            />

            {/* Bottom right */}
            <path
                d="M430 380 L300 260"
                fill="none"
                stroke="currentColor"
                strokeWidth="22"
                strokeLinecap="round"
            />

        </svg>
    );
};

export default Index;
