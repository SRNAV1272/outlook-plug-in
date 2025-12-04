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

            {/* Phone body */}
            <rect
                x="136"
                y="40"
                width="240"
                height="432"
                rx="36"
                ry="36"
                fill="none"
                stroke="currentColor"
                strokeWidth="22"
            />

            {/* Screen */}
            <rect
                x="160"
                y="92"
                width="192"
                height="300"
                rx="18"
                ry="18"
                fill="none"
                stroke="currentColor"
                strokeWidth="18"
                opacity="0.9"
            />

            {/* Speaker */}
            <rect
                x="215"
                y="62"
                width="82"
                height="16"
                rx="8"
                fill="currentColor"
                opacity="0.7"
            />

            {/* Home button */}
            <rect
                x="214"
                y="412"
                width="84"
                height="32"
                rx="16"
                fill="none"
                stroke="currentColor"
                strokeWidth="16"
            />

        </svg>
    );
};

export default Index;
