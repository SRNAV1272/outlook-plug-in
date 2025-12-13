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

            <circle
                cx="256"
                cy="256"
                r="180"
                stroke="currentColor"
                strokeWidth="26"
                fill="none"
            />

            <ellipse
                cx="256"
                cy="256"
                rx="70"
                ry="175"
                stroke="currentColor"
                strokeWidth="22"
                fill="none"
            />

            <line
                x1="90"
                y1="256"
                x2="422"
                y2="256"
                stroke="currentColor"
                strokeWidth="22"
            />

            <ellipse
                cx="256"
                cy="198"
                rx="150"
                ry="38"
                stroke="currentColor"
                strokeWidth="20"
                fill="none"
            />

            <ellipse
                cx="256"
                cy="314"
                rx="150"
                ry="38"
                stroke="currentColor"
                strokeWidth="20"
                fill="none"
            />

            <circle
                cx="256"
                cy="256"
                r="180"
                stroke="currentColor"
                strokeWidth="8"
                opacity="0.25"
                fill="none"
            />
        </svg>
    );
};

export default Index;
