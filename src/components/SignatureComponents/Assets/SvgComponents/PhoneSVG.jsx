import React from "react";

const PhoneSVG = ({ color = "#000", size = 24 }) => {
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 24 24"   // ✅ FIXED
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
        >
            <path
                d="M21 16.5V20C21 20.55 20.55 21 20 21C9.95 21 3 14.05 3 4C3 3.45 3.45 3 4 3H7.5C8.05 3 8.5 3.45 8.5 4C8.5 5.1 8.67 6.15 9 7.15C9.13 7.56 9.03 8.01 8.73 8.31L7 10.05C8.35 12.85 11.15 15.65 13.95 17L15.69 15.27C15.99 14.97 16.44 14.87 16.85 15C17.85 15.33 18.9 15.5 20 15.5C20.55 15.5 21 15.95 21 16.5Z"
                stroke={color}
                strokeWidth="1.5"
                strokeLinejoin="round"
                strokeLinecap="round"
            />
        </svg>
    );
};

export default PhoneSVG;
