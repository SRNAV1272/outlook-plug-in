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

// export function generateEmailSignatureHTML(dataURL, allFields = {}, freshLinkForBanner) {
//     const disclaimerField = allFields.find(f => f.key === "disclaimer" && f.show);
//     const bannerField = freshLinkForBanner;

//     const normalLinks = allFields
//         ?.filter(i => i?.key?.toLowerCase()?.startsWith("social"))
//         ?.filter(i => !["teams", "meet", "calendly", "pdf", "url"].includes(i?.name))
//         ?.filter(i => i?.show);

//     const buttonLinks = allFields
//         ?.filter(i => i?.key?.toLowerCase()?.startsWith("social"))
//         ?.filter(i => ["teams", "meet", "calendly", "pdf", "url"].includes(i?.name))
//         ?.filter(i => i?.show);

//     /* ---------- Signature Image ---------- */
//     const signatureImageHTML =
//         typeof dataURL === "string" && dataURL.trim()
//             ? `
//             <tr>
//             <td style="padding-bottom:10px;">
//                 <img
//                 src="${dataURL}"
//                 alt="Signature"
//                 style="
//                     display:block;
//                     max-width:400px;
//                     width:100%;
//                     height:auto;
//                     border:1px solid #ccc;
//                     border-radius:10px;
//                 "
//                 />
//             </td>
//             </tr>`
//             : "";

//     /* ---------- Social Icons ---------- */
//     const socialIconsHTML = normalLinks.length
//         ? `
// <tr>
//   <td style="padding-top:8px;">
//     ${normalLinks
//             .map(
//                 s => `
// <a href="${s?.link}" target="_blank" style="margin-right:6px;">
//   <img src="${s.value}" width="30" height="30" style="display:inline-block;border:0;" />
// </a>`
//             )
//             .join("")}
//   </td>
// </tr>`
//         : "";

//     /* ---------- Buttons ---------- */
//     const buttonHTML = buttonLinks.length
//         ? `
// <tr>
//   <td style="padding-top:12px;">
//     ${buttonLinks
//             .map(
//                 link => `
// <a
//   href="${link?.link}"
//   target="_blank"
//   style="
//     background:#fff;
//     padding:10px 20px;
//     border-radius:20px;
//     border:1px solid #000;
//     color:#000;
//     font-family:Arial, sans-serif;
//     font-size:14px;
//     font-weight:500;
//     text-decoration:none;
//     display:inline-block;
//     margin-right:10px;
//     margin-bottom:6px;
//   "
// >
//   ${link?.value
//                         ? `<img src="${link.value}" width="16" style="vertical-align:middle;margin-right:6px;" />`
//                         : ""
//                     }
//   ${link?.label || link?.name || "Click"}
// </a>`
//             )
//             .join("")}
//   </td>
// </tr>`
//         : "";

//     /* ---------- Banner ---------- */
//     const bannerHTML =
//         typeof bannerField === "string" && bannerField.trim()
//             ? `
//             <tr>
//                 <td align="left" style="padding-top:12px;">

//                     <!--[if mso]>
//                     <table role="presentation" width="400" cellpadding="0" cellspacing="0" border="0">
//                     <tr>
//                         <td>
//                     <![endif]-->

//                     <table
//                     role="presentation"
//                     cellpadding="0"
//                     cellspacing="0"
//                     border="0"
//                     width="100%"
//                     style="max-width:400px;"
//                     >
//                     <tr>
//                         <td align="left">
//                         <img
//                             src="${bannerField}"
//                             alt=""
//                             width="400"
//                             hieght="130"
//                             style="
//                             display:block;
//                             width:100%;
//                             max-width:400px;
//                             height:130px;
//                             border:0;
//                             outline:none;
//                             text-decoration:none;
//                             "
//                         />
//                         </td>
//                     </tr>
//                     </table>

//                     <!--[if mso]>
//                         </td>
//                     </tr>
//                     </table>
//                     <![endif]-->

//                 </td>
//             </tr>
//             `
//             : "";

//     /* ---------- Disclaimer ---------- */
//     const disclaimerHTML = disclaimerField
//         ? `
// <tr>
//   <td style="padding-top:12px;">
//     <p style="
//       font-size:11px;
//       color:#666;
//       line-height:1.45;
//       margin:0;
//       font-family:Arial, sans-serif;
//     ">
//       ${disclaimerField.value.replace(/\n+/g, " ")}
//     </p>
//   </td>
// </tr>`
//         : "";

//     /* ---------- Combined Links (Icons + Buttons) ---------- */
//     const combinedLinks = [...normalLinks, ...buttonLinks];

//     const combinedLinksHTML = combinedLinks.length
//         ? `
// <tr>
//   <td style="padding-top:10px;">
//     ${combinedLinks.map(link => {
//             const isButton = ["teams", "meet", "calendly", "pdf", "url"].includes(link?.name);

//             return `
// <table
//   role="presentation"
//   cellpadding="0"
//   cellspacing="0"
//   border="0"
//   style="
//     display:inline-table;
//     vertical-align:middle;
//     margin-right:10px;
//     margin-bottom:8px;
//   "
// >
//   <tr>
//   <td
//     valign="${isButton ? "middle" : "top"}"
//     style="${isButton ? "" : "padding-top:2px;"}"
//   >
//     ${isButton
//                     ? `
// <a
//   href="${link?.link}"
//   target="_blank"
//   style="
//     display:inline-block;
//     background:#fff;
//     padding:10px 20px;
//     border-radius:20px;
//     border:1px solid #000;
//     color:#000;
//     font-family:Arial, sans-serif;
//     font-size:14px;
//     font-weight:500;
//     text-decoration:none;
//     white-space:nowrap;
//   "
// >
//   ${link?.value
//                         ? `<img src="${link.value}" width="16" style="vertical-align:middle;margin-right:6px;" />`
//                         : ""
//                     }
//   ${link?.label || link?.name || "Click"}
// </a>`
//                     : `
// <a href="${link?.link}" target="_blank">
//   <img
//     src="${link.value}"
//     width="30"
//     height="30"
//     style="display:block;border:0;"
//   />
// </a>`
//                 }
//   </td>
// </tr>
// </table>`;
//         }).join("")}
//   </td>
// </tr>`
//         : "";


//     /* ---------- Final HTML ---------- */
//     return `
// <table cellpadding="0" cellspacing="0" border="0"
//   style="font-family:Arial, sans-serif; max-width:600px; width:100%;">
//   ${signatureImageHTML}
//   ${combinedLinksHTML}
//   ${bannerHTML}
//   ${disclaimerHTML}
// </table>
// `.trim();
// }
export function generateEmailSignatureHTML(
  dataURL,
  allFields = [],
  freshLinkForBanner,
  showBanner
) {
  const disclaimerField = allFields.find(
    f => f.key === "disclaimer" && f.show
  );

  const normalLinks = allFields
    .filter(i => i?.key?.toLowerCase()?.startsWith("social"))
    .filter(i => !["teams", "meet", "calendly", "pdf", "url"].includes(i?.name))
    .filter(i => i?.show);

  const buttonLinks = allFields
    .filter(i => i?.key?.toLowerCase()?.startsWith("social"))
    .filter(i => ["teams", "meet", "calendly", "pdf", "url"].includes(i?.name))
    .filter(i => i?.show);

  /* ---------- MAIN SIGNATURE CARD (350px) ---------- */
  const signatureImageHTML =
    typeof dataURL === "string" && dataURL.trim()
      ? `
<tr>
  <td style="padding-bottom:8px;">
    <img
      src="${dataURL}"
      alt="Signature"
      width="350"
      style="
        display:block;
        width:350px;
        height:auto;
        border:1px solid #ddd;
        border-radius:8px;
      "
    />
  </td>
</tr>`
      : "";

  /* ---------- SOCIAL ICONS + CTA BUTTONS ---------- */
  const combinedLinks = [...normalLinks, ...buttonLinks];
  const BUTTON_TYPES = ["teams", "meet", "calendly", "pdf", "url"];

  const sortedLinks = [...combinedLinks].sort((a, b) => {
    const aIsButton = BUTTON_TYPES.includes(a?.name);
    const bIsButton = BUTTON_TYPES.includes(b?.name);

    const aLabelEmpty = !a?.label || !String(a.label).trim();
    const bLabelEmpty = !b?.label || !String(b.label).trim();

    // 1️⃣ Non-buttons first
    if (!aIsButton && bIsButton) return -1;
    if (aIsButton && !bIsButton) return 1;

    // 2️⃣ Among buttons → empty label first
    if (aIsButton && bIsButton) {
      if (aLabelEmpty && !bLabelEmpty) return -1;
      if (!aLabelEmpty && bLabelEmpty) return 1;
    }

    // 3️⃣ Keep original order
    return 0;
  });

  const combinedLinksHTML = combinedLinks.length
    ? `
<tr>
  <td style="padding-top:8px;">
    ${sortedLinks
      .map(link => {
        const isButton = BUTTON_TYPES.includes(link?.name);

        return `
<table role="presentation" cellpadding="0" cellspacing="0" border="0"
  style="display:inline-table;margin-right:8px;margin-bottom:8px;">
  <tr>
    <td valign="middle">
      ${isButton
            ? `
<a href="${link?.link}" target="_blank"
  style="
    display:inline-block;
    padding:${!!link?.label ? "8px 18px" : "8px 8px"};
    border: ${!!link?.label ? "1px solid #0b2e79ff" : ""};
    border-radius:22px;
    font-size:13px;
    font-family:Arial, sans-serif;
    color:#000;
    text-decoration:none;
    white-space:nowrap;
  ">
  ${link?.value
              ? `<img src="${link.value}" width="${!!link?.label ? 16 : 22}" style="vertical-align:middle;margin-right:6px;" />`
              : ""
            }
  ${link?.label}
</a>`
            : `
<a href="${link?.link}" target="_blank"
  style="
    display:inline-block;
    padding:8px 8px;
    border-radius:22px;
    font-size:13px;
    font-family:Arial, sans-serif;
    color:#000;
    text-decoration:none;
    white-space:nowrap;
  ">
  ${link?.value
              ? `<img src="${link.value}" width="${22}" style="vertical-align:middle;margin-right:6px;" />`
              : ""
            }
</a>`
          }
    </td >
  </tr >
</table > `;
      })
      .join("")}
  </td>
</tr>`
    : "";

  /* ---------- BANNER (350px LOCKED) ---------- */
  const bannerHTML =
    typeof freshLinkForBanner === "string" &&
      freshLinkForBanner.trim() &&
      showBanner
      ? `
<tr>
  <td style="padding-top:8px;">
    <!--[if mso]>
    <table width="350" cellpadding="0" cellspacing="0" border="0"><tr><td>
    <![endif]-->

    <img
      src="${freshLinkForBanner}"
      alt=""
      width="350"
      height="110"
      style="
        display:block;
        width:350px;
        height:110px;
        border:0;
      "
    />

    <!--[if mso]></td></tr></table><![endif]-->
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
      font-family:Arial, sans-serif;">
      ${disclaimerField.value.replace(/\n+/g, " ")}
    </p>
  </td>
</tr>`
    : "";

  /* ---------- FINAL WRAPPER (HARD WIDTH) ---------- */
  return `
<table
  cellpadding="0"
  cellspacing="0"
  border="0"
  width="350"
  style="
    width:350px;
    font-family:Arial, sans-serif;
  "
>
  ${signatureImageHTML}
  ${combinedLinksHTML}
  ${bannerHTML}
  ${disclaimerHTML}
</table>
`.trim();
}





