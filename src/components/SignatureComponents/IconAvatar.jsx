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
  const ICON_LABEL_LIMIT = 20;

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

  const totalButtons =
    topShortButtons.length + longButtons.length;

  // Case 1: exactly one labeled button
  if (totalButtons === 1 && longButtons.length === 1) {
    topShortButtons.push(longButtons.shift());
  }

  const topInlineCount =
    topIcons.length + topShortButtons.length;

  // Case 2: fill inline slots
  if (topInlineCount < 5 && longButtons.length > 1) {
    topShortButtons.push(longButtons.shift());
  }

  /* 🔥 IMPORTANT: create rows AFTER shifts */
  const chunkArray = (arr, size) => {
    const chunks = [];
    for (let i = 0; i < arr.length; i += size) {
      chunks.push(arr.slice(i, i + size));
    }
    return chunks;
  };

  const buttonRows = chunkArray(longButtons, 2);

  const renderVMLButton = link => `
<td valign="middle" style="padding-right:8px;padding-bottom:8px;">
  <table cellpadding="0" cellspacing="0" border="0">
    <tr>
      <td valign="middle" style="padding-right:6px;">
        <img src="${link.value}" width="32" height="32" style="display:block;border:0;" />
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
        <a href="${link.link}" target="_blank" style="color:#0b2e79ff;text-decoration:none;">
          ${link.label}
        </a>
      </td>
    </tr>
  </table>
</td>`;

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
            <img src="${link.value}" width="32" height="32" style="display:block;border:0;" />
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

  const buttonRowsHTML = buttonRows.length
    ? buttonRows
      .map(
        row => `
<tr>
  <td style="padding-top:6px;">
    <table cellpadding="0" cellspacing="0" border="0">
      <tr>
        ${row.map(renderVMLButton).join("")}
      </tr>
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
      ?
      `
<tr>
  <td style="padding-bottom:8px;" width=490 height=90>
    <img
      src="${freshLinkForBanner}"
      width="490"
      height="90"
      style="display:block;width:490px;height:90px;border:1px solid #ddd;border-radius:8px;"
      alt="Signature"
    />
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
    style="width:500px;font-family:Arial,sans-serif;">
    ${signatureImageHTML}
    ${combinedLinksHTML}
    ${bannerHTML}
    ${disclaimerHTML}
    </table>
`.trim();
}







