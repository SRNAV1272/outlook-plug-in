import React from "react";

export const getWidth = (size, w, h) => w > h ? size : size * w / h;
export const getHeight = (size, w, h) => h > w ? size : size * h / w;

export function IconAvatar(
  {
    borderTopRightRadius = 0,
    borderTopLeftRadius = 0,
    borderBottomLeftRadius = 0,
    borderBottomRightRadius = 0, image, size, borderRadius = 20, color = "none", isMui = false, opacity = 1,
    boxID = ""
  }
) {
  const [aspectRatio, setAspectRatio] = React.useState({ naturalWidth: 1, naturalHeight: 1 })
  const ICON = image
  return (
    <>
      {
        isMui ?
          <ICON sx={{ color: color, width: size, height: size }} /> :
          <img
            src={image}
            alt="User"
            style={{
              width: size ? getWidth(size, aspectRatio?.naturalWidth, aspectRatio?.naturalHeight) : '100%',
              height: size ? getHeight(size, aspectRatio?.naturalWidth, aspectRatio?.naturalHeight) : 'auto',
              maxWidth: '100%',
              // borderRadius,
              borderTopRightRadius,
              borderTopLeftRadius: borderTopLeftRadius,
              borderBottomLeftRadius,
              borderBottomRightRadius,
              color: color,
              opacity: opacity,
              display: 'block', // Prevent inline gaps
              objectFit: 'contain' // Keep image aspect ratio safe inside container
            }}
            onLoad={(e) => {
              const target = e.target;
              try {
                setAspectRatio({
                  naturalWidth: target.naturalWidth,
                  naturalHeight: target.naturalHeight
                });
              } catch (err) {
                console.error(err);
              }
            }}
          />
      }
    </>
  )
}

// export function generateEmailSignatureHTML(
//   dataURL,
//   allFields = [],
//   freshLinkForBanner,
//   showBanner
// ) {
//   const CONTAINER_WIDTH = 600;
//   const ICON_SIZE = 25;

//   /* ---------- DISCLAIMER ---------- */
//   const disclaimerField = allFields.find(
//     f => f.key === "disclaimer" && f.show
//   );

//   /* ---------- SOCIAL LINKS ---------- */
//   const socialLinks = allFields
//     .filter(i => i?.key?.toLowerCase()?.startsWith("social"))
//     .filter(i => i?.show);

//   const iconOnlyLinks = socialLinks.filter(i => !i?.label);
//   const buttonLinks = socialLinks.filter(i => i?.label);

//   /* ---------- SIGNATURE IMAGE ---------- */
//   const signatureImageHTML =
//     typeof dataURL === "string" && dataURL.trim()
//       ? `
// <tr>
//   <td style="padding-bottom:8px;">
//     <img
//       src="${dataURL}"
//       width="${CONTAINER_WIDTH * 0.7}"
//       style="display:block;border:1px solid #ddd;border-radius:8px;"
//       alt="Signature"
//     />
//   </td>
// </tr>`
//       : "";

//   /* ---------- ICON ONLY RENDERER ---------- */
//   //   const renderIcon = link => `
//   // <td style="padding-right:8px;padding-bottom:8px;">
//   //   <a href="${link.link}" target="_blank" style="text-decoration:none;">
//   //     <img
//   //       src="${link.value}"
//   //       width="${ICON_SIZE}"
//   //       height="${ICON_SIZE}"
//   //       style="display:block;border:0;"
//   //       alt=""
//   //     />
//   //   </a>
//   // </td>`;
//   const renderIcon = link => `
//     <td
//       style="
//         padding-right:8px;
//         padding-bottom:8px;
//       "
//     >
//       <a
//         href="${link.link}"
//         style="display:inline-block;text-decoration:none;"
//       >
//         <img
//           src="${link.value}"
//           width="${ICON_SIZE}"
//           height="${ICON_SIZE}"
//           style="display:block;border:0;outline:none;text-decoration:none;"
//           alt=""
//         />
//       </a>
//     </td>
//     `;


//   /* ---------- BUTTON RENDERER ---------- */
//   const renderButton = link => `
// <td valign="middle" style="padding-right:8px;padding-bottom:8px;">
//   <table cellpadding="0" cellspacing="0" border="0">
//     <tr>
//       <td valign="middle" style="padding-right:6px;">
//         <img
//           src="${link.value}"
//           width="${ICON_SIZE}"
//           height="${ICON_SIZE}"
//           style="display:block;border:0;"
//           alt=""
//         />
//       </td>
//       <td
//         valign="middle"
//         style="
//           font-family:Arial,sans-serif;
//           font-size:12px;
//           line-height:22px;
//           mso-line-height-rule:exactly;
//           white-space:nowrap;
//           color:#0b2e79ff;
//         ">
//         <a href="${link.link}" target="_blank"
//           style="color:#0b2e79ff;text-decoration:none;">
//           ${link.label}
//         </a>
//       </td>
//     </tr>
//   </table>
// </td>`;

//   /* ---------- TOP ROW (icons + max 2 buttons) ---------- */
//   const topButtons = buttonLinks.slice(0, 2);
//   const remainingButtons = buttonLinks.slice(2);

//   const topRowHTML =
//     iconOnlyLinks.length || topButtons.length
//       ? `
// <tr>
//   <td style="padding-top:8px;padding-bottom:6px;">
//     <table cellpadding="0" cellspacing="0" border="0">
//       <tr>
//         ${iconOnlyLinks.map(renderIcon).join("")}
//         ${topButtons.map(renderButton).join("")}
//       </tr>
//     </table>
//   </td>
// </tr>`
//       : "";

//   /* ---------- REMAINING BUTTON ROWS (2 PER ROW) ---------- */
//   const chunkArray = (arr, size) =>
//     arr.reduce((acc, _, i) =>
//       i % size ? acc : [...acc, arr.slice(i, i + size)], []);

//   const buttonRowsHTML = chunkArray(remainingButtons, 2)
//     .map(
//       row => `
// <tr>
//   <td style="padding-top:6px;">
//     <table cellpadding="0" cellspacing="0" border="0">
//       <tr>
//         ${row.map(renderButton).join("")}
//       </tr>
//     </table>
//   </td>
// </tr>`
//     )
//     .join("");

//   /* ---------- BANNER ---------- */
//   const bannerHTML =
//     typeof freshLinkForBanner === "string" &&
//       freshLinkForBanner.trim() &&
//       showBanner
//       ? `
// <tr>
//   <td style="padding-top:8px;padding-bottom:8px;">
//     <img
//       src="${freshLinkForBanner}"
//       width="${CONTAINER_WIDTH}"
//       height="90"
//       style="display:block;border:1px solid #ddd;border-radius:8px;"
//       alt="Banner"
//     />
//   </td>
// </tr>`
//       : "";

//   /* ---------- DISCLAIMER ---------- */
//   const disclaimerHTML = disclaimerField
//     ? `
// <tr>
//   <td style="padding-top:8px;">
//     <p style="
//       margin:0;
//       font-size:11px;
//       line-height:1.45;
//       color:#777;
//       font-family:Arial,sans-serif;">
//       ${disclaimerField.value.replace(/\n+/g, " ")}
//     </p>
//   </td>
// </tr>`
//     : "";

//   /* ---------- FINAL HTML ---------- */
//   return `
// <table cellpadding="0" cellspacing="0" border="0"
//   width="${CONTAINER_WIDTH}"
//   style="width:${CONTAINER_WIDTH}px;font-family:Arial,sans-serif;">
//   ${signatureImageHTML}
//   ${topRowHTML}
//   ${buttonRowsHTML}
//   ${bannerHTML}
//   ${disclaimerHTML}
//   <tr>
//   <td style="padding-top:6px;">
//   <table cellpadding="0" cellspacing="0" border="0">
// <tr>
// <td
//   rowspan="1"
//   colspan="2"
//   align="left"
//   valign="middle"
// >
//   <span style="
//     font-family: Lucida Sans Unicode;
//     font-size: 16px;
//     font-weight: bold;
//     color: #1A73E8;
//     text-decoration: underline;
//   ">
//     John Doe Lucida Sans Unicode
//   </span>
// </td>
// </tr>
// </table>
// `.trim();
// }

export function generateEmailSignatureHTML(
  dataURL,
  allFields = [],
  freshLinkForBanner,
  showBanner
) {
  const CONTAINER_WIDTH = 600;
  const ICON_SIZE = 25;

  /* ---------- DISCLAIMER ---------- */
  const disclaimerField = allFields.find(
    f => f.key === "disclaimer" && f.show
  );

  /* ---------- SOCIAL LINKS ---------- */
  const socialLinks = allFields
    .filter(i => i?.key?.toLowerCase()?.startsWith("social"))
    .filter(i => i?.show);

  const iconOnlyLinks = socialLinks.filter(i => !i?.label);
  const buttonLinks = socialLinks.filter(i => i?.label);

  /* ---------- SIGNATURE IMAGE ---------- */
  const signatureImageHTML =
    typeof dataURL === "string" && dataURL.trim()
      ? `
<tr>
  <td style="padding-bottom:8px;">
    <img
      src="${dataURL}"
      width="${CONTAINER_WIDTH * 0.7}"
      style="display:block;border:1px solid #ddd;border-radius:8px;"
      alt="Signature"
    />
  </td>
</tr>`
      : "";
  console.log("sdjhajdshadshkjasd", signatureImageHTML, freshLinkForBanner)
  /* ---------- ICON ONLY RENDERER ---------- */
  const renderIcon = link => `
    <td
      style="
        padding-right:8px;
        padding-bottom:8px;
      "
    >
      <a
        href="${link.link}"
        style="display:inline-block;text-decoration:none;"
      >
        <img
          src="${link.value}"
          width="${ICON_SIZE}"
          height="${ICON_SIZE}"
          style="display:block;border:0;outline:none;text-decoration:none;"
          alt=""
        />
      </a>
    </td>
    `;


  /* ---------- BUTTON RENDERER ---------- */
  const renderButton = link => `
<td valign="middle" style="padding-right:8px;padding-bottom:8px;">
  <table cellpadding="0" cellspacing="0" border="0">
    <tr>
      <td valign="middle" style="padding-right:6px;">
        <img
          src="${link.value}"
          width="${ICON_SIZE}"
          height="${ICON_SIZE}"
          style="display:block;border:0;"
          alt=""
        />
      </td>
      <td
        valign="middle"
        style="
          font-family:Arial,sans-serif;
          font-size:12px;
          line-height:22px;
          mso-line-height-rule:exactly;
          white-space:nowrap;
          color:#0b2e79ff;
        ">
        <a href="${link.link}" target="_blank"
          style="color:#0b2e79ff;text-decoration:none;">
          ${link.label}
        </a>
      </td>
    </tr>
  </table>
</td>`;

  /* ---------- TOP ROW (icons + max 2 buttons) ---------- */
  const topButtons = buttonLinks.slice(0, 2);
  const remainingButtons = buttonLinks.slice(2);

  const topRowHTML =
    iconOnlyLinks.length || topButtons.length
      ? `
<tr>
  <td style="padding-top:8px;padding-bottom:6px;">
    <table cellpadding="0" cellspacing="0" border="0">
      <tr>
        ${iconOnlyLinks.map(renderIcon).join("")}
        ${topButtons.map(renderButton).join("")}
      </tr>
    </table>
  </td>
</tr>`
      : "";

  /* ---------- REMAINING BUTTON ROWS (2 PER ROW) ---------- */
  const chunkArray = (arr, size) =>
    arr.reduce((acc, _, i) =>
      i % size ? acc : [...acc, arr.slice(i, i + size)], []);

  const buttonRowsHTML = chunkArray(remainingButtons, 2)
    .map(
      row => `
<tr>
  <td style="padding-top:6px;">
    <table cellpadding="0" cellspacing="0" border="0">
      <tr>
        ${row.map(renderButton).join("")}
      </tr>
    </table>
  </td>
</tr>`
    )
    .join("");

  /* ---------- BANNER (TRULY RESPONSIVE) ---------- */
  const bannerHTML =
    typeof freshLinkForBanner === "string" &&
      freshLinkForBanner.trim()
      ? `
<tr>
  <td style="padding-top:8px;padding-bottom:8px;">
    <img
      src="${freshLinkForBanner}"
      width="${CONTAINER_WIDTH}"
      style="display:block;width:100%;max-width:100%;height:auto;border:none;border-radius:4px;-ms-interpolation-mode:bicubic;"
      alt="Banner"
    />
  </td>
</tr>`
      : "";

  /* ---------- DISCLAIMER ---------- */
  const disclaimerHTML = disclaimerField
    ? `
<tr>
  <td style="padding-top:8px;">
    <p style="
      margin:0;
      font-size:11px;
      line-height:1.45;
      color:#777;
      font-family:Arial,sans-serif;">
      ${disclaimerField.value.replace(/\n+/g, " ")}
    </p>
  </td>
</tr>`
    : "";

  /* ---------- FINAL HTML ---------- */
  return `
<table cellpadding="0" cellspacing="0" border="0"
  width="${CONTAINER_WIDTH}"
  style="width:${CONTAINER_WIDTH}px;font-family:Arial,sans-serif;">
  ${signatureImageHTML}
  ${topRowHTML}
  ${buttonRowsHTML}
  ${bannerHTML}
  ${disclaimerHTML}
</table>
`.trim();
}







