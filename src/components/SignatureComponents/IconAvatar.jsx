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
//   const disclaimerField = allFields.find(
//     f => f.key === "disclaimer" && f.show
//   );

//   const normalLinks = allFields
//     .filter(i => i?.key?.toLowerCase()?.startsWith("social"))
//     .filter(i => !["teams", "meet", "calendly", "pdf", "url"].includes(i?.name))
//     .filter(i => i?.show);

//   const buttonLinks = allFields
//     .filter(i => i?.key?.toLowerCase()?.startsWith("social"))
//     .filter(i => ["teams", "meet", "calendly", "pdf", "url"].includes(i?.name))
//     .filter(i => i?.show);

//   /* ---------- MAIN SIGNATURE CARD (400px) ---------- */
//   const signatureImageHTML =
//     typeof dataURL === "string" && dataURL.trim()
//       ? `
// <tr>
//   <td style="padding-bottom:8px;">
//     <img
//       src="${dataURL}"
//       alt="Signature"
//       width="400"
//       style="
//         display:block;
//         width:400px;
//         height:auto;
//         border:1px solid #ddd;
//         border-radius:8px;
//       "
//     />
//   </td>
// </tr>`
//       : "";

//   /* ---------- SOCIAL ICONS + CTA BUTTONS ---------- */
//   const combinedLinks = [...normalLinks, ...buttonLinks];
//   const BUTTON_TYPES = ["teams", "meet", "calendly", "pdf", "url"];

//   const sortedLinks = [...combinedLinks].sort((a, b) => {
//     const aIsButton = BUTTON_TYPES.includes(a?.name);
//     const bIsButton = BUTTON_TYPES.includes(b?.name);

//     const aLabelEmpty = !a?.label || !String(a.label).trim();
//     const bLabelEmpty = !b?.label || !String(b.label).trim();

//     // 1️⃣ Non-buttons first
//     if (!aIsButton && bIsButton) return -1;
//     if (aIsButton && !bIsButton) return 1;

//     // 2️⃣ Among buttons → empty label first
//     if (aIsButton && bIsButton) {
//       if (aLabelEmpty && !bLabelEmpty) return -1;
//       if (!aLabelEmpty && bLabelEmpty) return 1;
//     }

//     // 3️⃣ Keep original order
//     return 0;
//   });

//   const combinedLinksHTML = combinedLinks.length
//     ? `
//                 <tr>
//                   <td style="padding-top:8px;">
//                     ${sortedLinks
//       .map(link => {
//         const isButton = BUTTON_TYPES.includes(link?.name);

//         return `
//                         <table role="presentation" cellpadding="0" cellspacing="0" border="0"
//                           style="display:inline-table;margin-right:8px;margin-bottom:8px;">
//                           <tr>
//                             <td valign="middle">
//                               ${isButton
//             ? `
//                         <a href="${link?.link}" target="_blank"
//                           style="
//                             display:inline-block;
//                             padding:${!!link?.label ? "4px 8px" : "0px 0px"};
//                             border: ${!!link?.label ? "1px solid #0b2e79ff" : ""};
//                             border-radius:22px;
//                             font-size:10px;
//                             font-family:Arial, sans-serif;
//                             color:#000;
//                             text-decoration:none;
//                             white-space:nowrap;
//                           ">
//                           ${link?.label}
//                         </a>`
//             : `
//                         <a href="${link?.link}" target="_blank"
//                           style="
//                             display:inline-block;
//                             padding:0px 0px;
//                             border-radius:22px;
//                             font-size:13px;
//                             font-family:Arial, sans-serif;
//                             color:#000;
//                             text-decoration:none;
//                             white-space:nowrap;
//                           ">
//                           ${link?.value
//               ? `<img src="${link.value}" width="${20}" style="vertical-align:middle;margin-right:6px;" />`
//               : ""
//             }
//                         </a>`
//           }
//                             </td >
//                           </tr >
//                         </table > `;
//       })
//       .join("")}
//                           </td>
//                 </tr>
//               `
//     : "";

//   /* ---------- BANNER (400px LOCKED) ---------- */
//   const bannerHTML =
//     typeof freshLinkForBanner === "string" &&
//       freshLinkForBanner.trim() &&
//       showBanner
//       ? `
// <tr>
//   <td style="padding-top:8px;">
//     <!--[if mso]>
//     <table width="400" cellpadding="0" cellspacing="0" border="0"><tr><td>
//     <![endif]-->

//     <img
//       src="${freshLinkForBanner}"
//       alt=""
//       width="400"
//       height="110"
//       style="
//         display:block;
//         width:400px;
//         height:110px;
//         border:0;
//       "
//     />

//     <!--[if mso]></td></tr></table><![endif]-->
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
//       font-family:Arial, sans-serif;">
//       ${disclaimerField.value.replace(/\n+/g, " ")}
//     </p>
//   </td>
// </tr>`
//     : "";

//   /* ---------- FINAL WRAPPER (HARD WIDTH) ---------- */
//   return `
// <table
//   cellpadding="0"
//   cellspacing="0"
//   border="0"
//   width="400"
//   style="
//     width:400px;
//     font-family:Arial, sans-serif;
//   "
// >
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

  /* ---------- MAIN SIGNATURE IMAGE ---------- */
  const signatureImageHTML =
    typeof dataURL === "string" && dataURL.trim()
      ? `
<tr>
  <td style="padding-bottom:8px;">
    <img
      src="${dataURL}"
      width="350"
      style="display:block;width:350px;height:auto;border:1px solid #ddd;border-radius:8px;"
      alt="Signature"
    />
  </td>
</tr>`
      : "";

  /* ---------- SOCIAL LINKS ---------- */
  const BUTTON_TYPES = ["teams", "meet", "calendly", "pdf", "url"];
  const combinedLinks = [...normalLinks, ...buttonLinks];
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

  const ICON_LABEL_LIMIT = 10;

  const topIcons = [];
  const topShortButtons = [];
  const longButtons = [];

  sortedLinks.forEach(link => {
    const hasLabel = link?.label && String(link.label).trim();

    if (!hasLabel) {
      topIcons.push(link);
    } else if (link.label.length <= ICON_LABEL_LIMIT) {
      topShortButtons.push(link);
    } else {
      longButtons.push(link);
    }
  });

  const chunkArray = (arr, size) => {
    const chunks = [];
    for (let i = 0; i < arr.length; i += size) {
      chunks.push(arr.slice(i, i + size));
    }
    return chunks;
  };

  const buttonRows = chunkArray(longButtons, 2);
  const totalButtons =
    topShortButtons.length + longButtons.length;

  // If there is exactly ONE labeled button overall,
  // push it inline (no matter its length)
  if (totalButtons === 1 && longButtons.length === 1) {
    topShortButtons.push(longButtons.shift());
  }
  const topInlineCount = topIcons.length + topShortButtons.length;

  if (topInlineCount < 4 && longButtons.length > 0) {
    topShortButtons.push(longButtons.shift());
  }


  const renderVMLButton = link => `
<td valign="middle" style="padding-right:8px;padding-bottom:8px;">
  <!-- BUTTON -->

  <!--[if mso]>
  <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml"
    href="${link.link}"
    style="height:38px;width:140px;v-text-anchor:middle;"
    arcsize="60%"
    strokecolor="#0b2e79ff"
    fillcolor="none">
    <v:textbox>
      <table cellpadding="0" cellspacing="0" border="0" align="center">
          <tr height="24">
            <td style="padding-right:6px;font-size:0;line-height:0;">
              <img src="${link.value}" width="22" height="22" style="display:block;border:0;" />
            </td>
            <td
              style="font-family:Arial,sans-serif;font-size:10px;line-height:14px;
                    color:#0b2e79ff;white-space:nowrap;mso-line-height-rule:exactly;">
              ${link.label}
            </td>
          </tr>
      </table>
    </v:textbox>
  </v:roundrect>
  <![endif]-->

  <!--[if !mso]><!-- -->
  <table cellpadding="0" cellspacing="0" border="0"
    style="border:1px solid #0b2e79ff;border-radius:22px;border-collapse:separate;">
    <tr>
      <td style="padding:6px 14px;">
        <table cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td style="padding-right:8px;">
              <img src="${link.value}" width="22" height="22" style="display:block;border:0;" />
            </td>
            <td
              style="font-family:Arial,sans-serif;font-size:12px;line-height:14px;
                     color:#0b2e79ff;white-space:nowrap;">
              <a href="${link.link}" target="_blank"
                 style="color:#0b2e79ff;text-decoration:none;">
                ${link.label}
              </a>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
  <!--<![endif]-->
</td>
`;
  const topInlineHTML =
    topIcons.length || topShortButtons.length
      ? `
<tr>
  <td style="padding-top:8px;padding-bottom:6px;">
    <table cellpadding="0" cellspacing="0" border="0">
      <tr>

        ${topIcons
        .map(
          link => `
<td style="padding-right:8px;padding-bottom:8px;">
  <a href="${link.link}" target="_blank" style="text-decoration:none;">
    <img src="${link.value}" width="22" height="22" style="display:block;border:0;" />
  </a>
</td>`
        )
        .join("")}

        ${topShortButtons.map(renderVMLButton).join("")}

      </tr>
    </table>
  </td>
</tr>`
      : "";
  console.log("sdasd", buttonRows)
  const buttonRowsHTML = buttonRows.length
    ? buttonRows
      .map(
        row => `
<tr>
  <td style="padding-top:6px;">
  <a href="${row.link}" target="_blank"
      style="text-decoration:none;">
    <table cellpadding="0" cellspacing="0" border="0">
      <tr>
        ${row.map(renderVMLButton).join("")}
      </tr>
      </a>
    </table>
  </td>
</tr>`
      )
      .join("")
    : "";

  const combinedLinksHTML =
    topInlineHTML || buttonRowsHTML
      ? `
${topInlineHTML}
${buttonRowsHTML}
`
      : "";




  /* ---------- BANNER (VML LOCKED) ---------- */
  const bannerHTML =
    typeof freshLinkForBanner === "string" &&
      freshLinkForBanner.trim() &&
      showBanner
      ? `
<tr>
  <td style="padding-top:8px;">
    <!--[if mso]>
    <v:rect xmlns:v="urn:schemas-microsoft-com:vml"
      style="width:350px;height:110px"
      fill="true" stroke="false">
      <v:fill type="frame" src="${freshLinkForBanner}" />
      <v:textbox inset="0,0,0,0"></v:textbox>
    </v:rect>
    <![endif]-->

    <!--[if !mso]><!-- -->
    <img
      src="${freshLinkForBanner}"
      width="350"
      height="110"
      style="display:block;width:350px;height:110px;border:0;"
      alt=""
    />
    <!--<![endif]-->
  </td>
</tr>`
      : "";

  /* ---------- DISCLAIMER ---------- */
  const disclaimerHTML = disclaimerField
    ? `
<tr>
  <td style="padding-top:8px;">
    <p style="margin:0;font-size:11px;line-height:1.45;color:#777;font-family:Arial,sans-serif;">
      ${disclaimerField.value.replace(/\n+/g, " ")}
    </p>
  </td>
</tr>`
    : "";

  /* ---------- FINAL WRAPPER (VML + FALLBACK) ---------- */
  return `
    <table cellpadding="0" cellspacing="0" border="0" width="350"
    style="width:350px;font-family:Arial,sans-serif;">
    ${signatureImageHTML}
    ${combinedLinksHTML}
    ${bannerHTML}
    ${disclaimerHTML}
    </table>
`.trim();
}






