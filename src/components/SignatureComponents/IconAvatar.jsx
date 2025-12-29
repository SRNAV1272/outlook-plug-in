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
    ?.filter(i => i?.key?.toLowerCase()?.startsWith("social"))
    ?.filter(i => !["teams", "meet", "calendly", "pdf", "url"].includes(i?.name))
    ?.filter(i => i?.show);

  const buttonLinks = allFields
    ?.filter(i => i?.key?.toLowerCase()?.startsWith("social"))
    ?.filter(i => ["teams", "meet", "calendly", "pdf", "url"].includes(i?.name))
    ?.filter(i => i?.show);

  /* ---------- Signature Image (100px) ---------- */
  const signatureImageHTML =
    typeof dataURL === "string" && dataURL.trim()
      ? `
<tr>
  <td style="padding-bottom:4px;">
    <img
      src="${dataURL}"
      alt="Signature"
      style="
        display:block;
        max-width:100px;
        width:100%;
        height:auto;
        border:1px solid #dcdcdc;
        border-radius:4px;
      "
    />
  </td>
</tr>`
      : "";

  /* ---------- Social Icons + Buttons ---------- */
  const combinedLinks = [...normalLinks, ...buttonLinks];

  const combinedLinksHTML = combinedLinks.length
    ? `
<tr>
  <td style="padding-top:4px;">
    ${combinedLinks
      .map(link => {
        const isButton = ["teams", "meet", "calendly", "pdf", "url"].includes(
          link?.name
        );

        return `
<table
  role="presentation"
  cellpadding="0"
  cellspacing="0"
  border="0"
  style="
    display:inline-table;
    vertical-align:middle;
    margin-right:4px;
    margin-bottom:4px;
  "
>
  <tr>
    <td valign="middle">
      ${isButton
            ? `
<a
  href="${link?.link}"
  target="_blank"
  style="
    display:inline-block;
    background:#fff;
    padding:3px 8px;
    border-radius:12px;
    border:1px solid #000;
    color:#000;
    font-family:Arial, sans-serif;
    font-size:10px;
    font-weight:500;
    text-decoration:none;
    white-space:nowrap;
  "
>
  ${link?.value
              ? `<img src="${link.value}" width="10" style="vertical-align:middle;margin-right:3px;" />`
              : ""
            }
  ${link?.label || link?.name || "Click"}
</a>`
            : `
<a href="${link?.link}" target="_blank">
  <img
    src="${link.value}"
    width="14"
    height="14"
    style="display:block;border:0;"
  />
</a>`
          }
    </td>
  </tr>
</table>`;
      })
      .join("")}
  </td>
</tr>`
    : "";

  /* ---------- Banner (100px) ---------- */
  const bannerHTML =
    typeof freshLinkForBanner === "string" &&
      freshLinkForBanner.trim() &&
      showBanner
      ? `
<tr>
  <td style="padding-top:4px;">
    <!--[if mso]>
    <table role="presentation" width="100" cellpadding="0" cellspacing="0" border="0">
      <tr><td>
    <![endif]-->

    <table
      role="presentation"
      cellpadding="0"
      cellspacing="0"
      border="0"
      width="100%"
      style="max-width:100px;"
    >
      <tr>
        <td>
          <img
            src="${freshLinkForBanner}"
            alt=""
            width="100"
            height="32"
            style="
              display:block;
              width:100%;
              max-width:100px;
              height:32px;
              border:0;
            "
          />
        </td>
      </tr>
    </table>

    <!--[if mso]></td></tr></table><![endif]-->
  </td>
</tr>`
      : "";

  /* ---------- Disclaimer ---------- */
  const disclaimerHTML = disclaimerField
    ? `
<tr>
  <td style="padding-top:4px;">
    <p
      style="
        font-size:9px;
        color:#777;
        line-height:1.3;
        margin:0;
        font-family:Arial, sans-serif;
      "
    >
      ${disclaimerField.value.replace(/\n+/g, " ")}
    </p>
  </td>
</tr>`
    : "";

  /* ---------- Final HTML ---------- */
  return `
<table
  cellpadding="0"
  cellspacing="0"
  border="0"
  style="
    font-family:Arial, sans-serif;
    max-width:280px;
    width:100%;
  "
>
  ${signatureImageHTML}
  ${combinedLinksHTML}
  ${bannerHTML}
  ${disclaimerHTML}
</table>
`.trim();
}

