import React from "react";

const Index = ({ color = "#000", size = 100 }) => {
    return (
        <svg
            viewBox="0 0 1024 1024"
            width={size}
            height={size}
            xmlns="http://www.w3.org/2000/svg"
            style={{ display: "block", color }}
            preserveAspectRatio="xMidYMid meet"
        >

            {/* Handset */}
            <path
                d="M210 300
                   C160 320 150 380 150 430
                   L150 660
                   C150 710 170 760 220 780
                   L270 780
                   C320 760 330 700 330 650
                   L330 450
                   C330 390 310 330 260 300 Z"
                fill="currentColor"
            />

            {/* Fax Body */}
            <path
                d="M390 260
                   Q390 210 440 190
                   H720
                   Q770 190 770 240
                   V360
                   H860
                   Q930 360 930 430
                   V760
                   Q930 830 860 830
                   H390
                   Q350 830 350 780
                   V310
                   Q350 280 390 260 Z"
                fill="currentColor"
            />

            {/* Paper */}
            <rect
                x="470"
                y="240"
                width="260"
                height="130"
                rx="12"
                fill="none"
                stroke="currentColor"
                strokeWidth="18"
            />

            {/* Display */}
            <rect
                x="550"
                y="440"
                width="260"
                height="90"
                rx="16"
                fill="none"
                stroke="currentColor"
                strokeWidth="18"
            />

            {/* Buttons */}
            <g fill="none" stroke="currentColor" strokeWidth="14">
                <rect x="560" y="580" width="90" height="40" rx="18" />
                <rect x="670" y="580" width="90" height="40" rx="18" />
                <rect x="780" y="580" width="90" height="40" rx="18" />

                <rect x="560" y="660" width="90" height="40" rx="18" />
                <rect x="670" y="660" width="90" height="40" rx="18" />
                <rect x="780" y="660" width="90" height="40" rx="18" />
            </g>
        </svg>
    );
};

export default Index;
