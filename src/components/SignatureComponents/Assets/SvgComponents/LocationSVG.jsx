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

            {/* Outer Pin Shape */}
            <path
                d="M256 40
                   C166 40 96 110 96 200
                   C96 310 256 472 256 472
                   C256 472 416 310 416 200
                   C416 110 346 40 256 40 Z"
                fill="none"
                stroke="currentColor"
                strokeWidth="26"
                strokeLinejoin="round"
            />

            {/* Inner Circle */}
            <circle
                cx="256"
                cy="200"
                r="70"
                fill="none"
                stroke="currentColor"
                strokeWidth="26"
            />

        </svg>
    );
};

export default Index;
