import React from "react";

const CalendarIcon = ({ disabled }) => {
  const strokeColor = disabled ? "#808080" : "#134BC8";

  return (
    <svg
      width="100%"
      height="100%"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <g filter="url(#filter0_d_15_268)">
        <path
          d="M3 8.26667V19C3 19.5523 3.44772 20 4 20H20C20.5523 20 21 19.5523 21 19V8.26667M3 8.26667V5C3 4.44772 3.44772 4 4 4H20C20.5523 4 21 4.44772 21 5V8.26667M3 8.26667H21"
          stroke={strokeColor}
          strokeLinejoin="round"
        />
      </g>
      <g filter="url(#filter1_d_15_268)">
        <path
          d="M7 2V5"
          stroke={strokeColor}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>
      <g filter="url(#filter2_d_15_268)">
        <path
          d="M17 2V5"
          stroke={strokeColor}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>
      {[11, 14, 17].map((y) =>
        [18, 13, 8].map((x) => (
          <g
            key={`${x}-${y}`}
            filter={`url(#filter${y === 11 ? 3 : y === 14 ? 9 : 4}_d_15_268)`}
          >
            <path
              d={`M${x} ${y}H${x - 2}`}
              stroke={strokeColor}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </g>
        ))
      )}

      <defs>
        <filter
          id="filter0_d_15_268"
          x="1.5"
          y="3.5"
          width="21"
          height="19"
          filterUnits="userSpaceOnUse"
          colorInterpolationFilters="sRGB"
        >
          <feFlood floodOpacity="0" result="BackgroundImageFix" />
          <feColorMatrix
            in="SourceAlpha"
            type="matrix"
            values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0"
            result="hardAlpha"
          />
          <feOffset dy="1" />
          <feGaussianBlur stdDeviation="0.5" />
          <feColorMatrix
            type="matrix"
            values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.1 0"
          />
          <feBlend
            mode="normal"
            in2="BackgroundImageFix"
            result="effect1_dropShadow_15_268"
          />
          <feBlend
            mode="normal"
            in="SourceGraphic"
            in2="effect1_dropShadow_15_268"
            result="shape"
          />
        </filter>
        {/* Include other filters (filter1_d_15_268, filter2_d_15_268, etc.) here if needed for visual effects */}
      </defs>
    </svg>
  );
};

export default CalendarIcon;
