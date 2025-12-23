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
//     if (!dataURL) return "";

//     // -------- 1️⃣ Extract useful fields -------- //
//     const disclaimerField = allFields.find(f => f.key === "disclaimer" && f.show);
//     const bannerField = freshLinkForBanner;
//     const normalLinks = allFields
//         ?.filter(i => i?.key.toLowerCase()?.startsWith("social"))
//         ?.filter(i => !["teams", "meet", "calendly", "pdf", "url"]?.includes(i?.name))
//         ?.filter(i => i?.show)

//     const buttonLinks = allFields
//         ?.filter(i => i?.key.toLowerCase()?.startsWith("social"))
//         ?.filter(i => ["teams", "meet", "calendly", "pdf", "url"]?.includes(i?.name))
//         ?.filter(i => i?.show)
//     // -------- 2️⃣ Collect Social Icons -------- //

//     const socialIconsHTML = normalLinks.length
//         ? `
//         <tr>
//             <td colspan="2" style="padding-top: 8px;">
//                 ${normalLinks
//             .map(
//                 s => `
//                         <a href="${s?.link}" target="_blank" style="margin-right: 6px; text-decoration: none;">
//                             <img src="${s.value}" width="30" height="30" style="display:inline-block; border:0;" />
//                         </a>
//                     `
//             )
//             .join("")}
//             </td>
//         </tr>`
//         : "";

//     // -------- 3️⃣ Optional Banner -------- //
//     // const bannerHTML = !!bannerField
//     //     ? `
//     //         <tr>
//     //             <td colspan="2" width="100%" style="padding-top:12px; text-align:center;">
//     //                 <div style="
//     //                     width:100%;
//     //                     max-width:400px;
//     //                     height:140px;        /* ✅ controls aspect ratio */
//     //                     margin:auto;
//     //                     overflow:hidden;
//     //                 ">
//     //                     <img 
//     //                         src="${bannerField}"
//     //                         alt=""
//     //                         style="
//     //                             width:100%;
//     //                             height:100%;
//     //                             object-fit:contain;
//     //                             display:block;
//     //                             margin:auto;
//     //                         "
//     //                     />
//     //                 </div>
//     //             </td>
//     //         </tr>
//     //     `
//     //     : "";
//     const bannerHTML =
//         typeof bannerField === "string" && bannerField.trim()
//             ? `
//             <tr>
//                 <td colspan="2" width="100%" style="padding-top:12px; text-align:center;">
//                     <div style="
//                         width:100%;
//                         max-width:400px;
//                         height:140px;        /* ✅ controls aspect ratio */
//                         margin:auto;
//                         overflow:hidden;
//                     ">
//                         <img 
//                             src="${bannerField}"
//                             alt=""
//                             style="
//                                 width:100%;
//                                 height:100%;
//                                 object-fit:contain;
//                                 display:block;
//                                 margin:auto;
//                             "
//                         />
//                     </div>
//                 </td>
//             </tr>
//         `
//             : "";


//     // -------- 3️⃣ Optional emailSchduler -------- //

//     const chunked = [];
//     for (let i = 0; i < buttonLinks.length; i += 2) {
//         chunked.push(buttonLinks.slice(i, i + 2));
//     }

//     const emailSchedulerC = chunked
//         .map(
//             row => `
//       <tr>
//         <td colspan="2" style="padding-top: 12px; white-space:nowrap;">
//           ${row
//                     .map(
//                         link => `
//                 <a 
//                   href="${link?.link}" 
//                   target="_blank"
//                   style="
//                     background:#fff;
//                     padding:10px 20px;
//                     border-radius:20px;
//                     border:1px solid #000;
//                     color:#000;
//                     font-family:Arial, sans-serif;
//                     font-size:14px;
//                     font-weight:500;
//                     text-decoration:none;
//                     display:inline-flex;
//                     align-items:center;
//                     justify-content:center;
//                     column-gap:6px;
//                     margin-right:10px;
//                   "
//                 >
//                   ${link?.value
//                                 ? `<img src="${link?.value}" width="16" style="vertical-align:middle; margin-right:6px;" />`
//                                 : ""
//                             }
//                   ${link?.label || link?.name || "Click"}
//                 </a>
//               `
//                     )
//                     .join("")}
//         </td>
//       </tr>
//     `
//         )
//         .join("");


//     // -------- 4️⃣ Optional Disclaimer -------- //
//     const disclaimerHTML = disclaimerField
//         ? `
//         <tr>
//         <td colspan="3" style="padding-top:12px;">
//             <div
//             style="
//                 font-size:11px;
//                 color:#666;
//                 line-height:1.45;
//                 font-family:'Plus Jakarta Display', Arial, sans-serif;
//                 white-space:normal;
//                 word-break:break-word;
//                 max-width: 100%;
//                 display:block;
//             "
//             >
//             ${disclaimerField.value.replace(/\n/g, "<br/>")}
//             </div>
//         </td>
//         </tr>`
//         : "";


//     // -------- 5️⃣ Build Final Signature HTML -------- //
//     const html = `
// <table cellpadding="0" cellspacing="0" border="0" style="font-family:Arial, sans-serif; max-width:600px;">

//     <!-- Signature Image -->
//     <tr>
//         <td colspan="2">
//             <img src="${dataURL}" alt="Signature" style="display:block; max-width:400px; height:auto; border:1px solid #ccc;border-radius:10px" />
//         </td>
//     </tr>

//     <!-- Social Icons -->
//     ${socialIconsHTML}

//     ${emailSchedulerC}
//     ${bannerHTML}
//     <!-- Disclaimer -->
//     ${disclaimerHTML}

//     <!-- Disclaimer -->
// </table>
// `.trim();

//     return html;
// }

export function generateEmailSignatureHTML(dataURL, allFields = {}, freshLinkForBanner) {
    const disclaimerField = allFields.find(f => f.key === "disclaimer" && f.show);
    const bannerField = freshLinkForBanner;

    const normalLinks = allFields
        ?.filter(i => i?.key?.toLowerCase()?.startsWith("social"))
        ?.filter(i => !["teams", "meet", "calendly", "pdf", "url"].includes(i?.name))
        ?.filter(i => i?.show);

    const buttonLinks = allFields
        ?.filter(i => i?.key?.toLowerCase()?.startsWith("social"))
        ?.filter(i => ["teams", "meet", "calendly", "pdf", "url"].includes(i?.name))
        ?.filter(i => i?.show);

    /* ---------- Signature Image ---------- */
    const signatureImageHTML =
        typeof dataURL === "string" && dataURL.trim()
            ? `
            <tr>
            <td style="padding-bottom:10px;">
                <img
                src="${dataURL}"
                alt="Signature"
                style="
                    display:block;
                    max-width:400px;
                    width:100%;
                    height:auto;
                    border:1px solid #ccc;
                    border-radius:10px;
                "
                />
            </td>
            </tr>`
            : "";

    /* ---------- Social Icons ---------- */
    const socialIconsHTML = normalLinks.length
        ? `
<tr>
  <td style="padding-top:8px;">
    ${normalLinks
            .map(
                s => `
<a href="${s?.link}" target="_blank" style="margin-right:6px;">
  <img src="${s.value}" width="30" height="30" style="display:inline-block;border:0;" />
</a>`
            )
            .join("")}
  </td>
</tr>`
        : "";

    /* ---------- Buttons ---------- */
    const buttonHTML = buttonLinks.length
        ? `
<tr>
  <td style="padding-top:12px;">
    ${buttonLinks
            .map(
                link => `
<a
  href="${link?.link}"
  target="_blank"
  style="
    background:#fff;
    padding:10px 20px;
    border-radius:20px;
    border:1px solid #000;
    color:#000;
    font-family:Arial, sans-serif;
    font-size:14px;
    font-weight:500;
    text-decoration:none;
    display:inline-block;
    margin-right:10px;
    margin-bottom:6px;
  "
>
  ${link?.value
                        ? `<img src="${link.value}" width="16" style="vertical-align:middle;margin-right:6px;" />`
                        : ""
                    }
  ${link?.label || link?.name || "Click"}
</a>`
            )
            .join("")}
  </td>
</tr>`
        : "";

    /* ---------- Banner ---------- */
    const bannerHTML =
        typeof bannerField === "string" && bannerField.trim()
            ? `
            <tr>
                <td align="left" style="padding-top:12px;">
                    
                    <!--[if mso]>
                    <table role="presentation" width="400" cellpadding="0" cellspacing="0" border="0">
                    <tr>
                        <td>
                    <![endif]-->

                    <table
                    role="presentation"
                    cellpadding="0"
                    cellspacing="0"
                    border="0"
                    width="100%"
                    style="max-width:400px;"
                    >
                    <tr>
                        <td align="left">
                        <img
                            src="${bannerField}"
                            alt=""
                            width="400"
                            hieght="130"
                            style="
                            display:block;
                            width:100%;
                            max-width:400px;
                            height:130px;
                            border:0;
                            outline:none;
                            text-decoration:none;
                            "
                        />
                        </td>
                    </tr>
                    </table>

                    <!--[if mso]>
                        </td>
                    </tr>
                    </table>
                    <![endif]-->

                </td>
            </tr>
            `
            : "";

    /* ---------- Disclaimer ---------- */
    const disclaimerHTML = disclaimerField
        ? `
<tr>
  <td style="padding-top:12px;">
    <p style="
      font-size:11px;
      color:#666;
      line-height:1.45;
      margin:0;
      font-family:Arial, sans-serif;
    ">
      ${disclaimerField.value.replace(/\n+/g, " ")}
    </p>
  </td>
</tr>`
        : "";

    /* ---------- Final HTML ---------- */
    return `
<table cellpadding="0" cellspacing="0" border="0"
  style="font-family:Arial, sans-serif; max-width:600px; width:100%;">
  ${signatureImageHTML}
  ${socialIconsHTML}
  ${buttonHTML}
  ${bannerHTML}
  ${disclaimerHTML}
</table>
`.trim();
}