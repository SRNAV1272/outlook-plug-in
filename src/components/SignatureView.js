import { useEffect, useMemo, useRef, useState } from "react";
import { Stage, Layer, Text, Image as KonvaImage, Line, Rect, Circle, Group } from "react-konva";
import { Box, Button, Dialog, Grid, IconButton, Paper, Stack, Typography } from "@mui/material";
import useImage from "use-image";
import { toast } from "react-toastify";
import { QRCode } from "react-qrcode-logo";
import { createRoot } from "react-dom/client";
import defaultLogo from "./SignatureComponents/Assets/Images/default-logo.png"
import qr_code_default_logo from './SignatureComponents/Assets/Images/qr_code_default_logo.png'
import uploadbanner from './SignatureComponents/Assets/Images/uploadbanner.png'
import { KeyboardArrowDownOutlined } from "@mui/icons-material";
import GlobeSVG from "./SignatureComponents/Assets/SvgComponents/GlobeSVG"
import FaxxSVG from "./SignatureComponents/Assets/SvgComponents/FaxxSVG"
import EmailSVG from "./SignatureComponents/Assets/SvgComponents/EmailSVG";
import PhoneSVG from "./SignatureComponents/Assets/SvgComponents/PhoneSVG";
import MobileSVG from "./SignatureComponents/Assets/SvgComponents/MobileSVG";
import LocationSVG from "./SignatureComponents/Assets/SvgComponents/LocationSVG";
import { generateEmailSignatureHTML, IconAvatar } from "./SignatureComponents/IconAvatar";
import { card, form } from "../data";

const ImagesUsedPreview = ({ data, handleImageClick, noQRCodeLogo = null, DefaultQrCodeLogo = null, shortLink }) => {
    const [image, setImage] = useState(null);

    // Resolve actual image URL
    const imageSrc = (() => {
        if (data.type === "qrcode") return null;
        if (data.key === "logo") return data?.value ?? defaultLogo;
        return data.value;
    })();

    const [loadedImage] = useImage(imageSrc, "anonymous");

    const convertImageToBase64 = async (url) => {
        try {
            const response = await fetch(url, { mode: 'cors' });
            const blob = await response.blob();

            return await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onloadend = () => resolve(reader.result);
                reader.onerror = reject;
                reader.readAsDataURL(blob);
            });
        } catch (e) {
            toast.error(`${e} qr-code-logo ! `)
        }
    };
    async function EmbedLogoOnQrCode() {
        const tempDiv = document.createElement("div");
        const root = createRoot(tempDiv);
        let base64Logo;
        if (DefaultQrCodeLogo?.logo && !noQRCodeLogo) {
            const imageSrc = DefaultQrCodeLogo.logo;

            const img = new Image();
            img.onload = async () => {
                const isSquare = img.naturalHeight === img.naturalWidth;
                const isTall = img.naturalHeight > img.naturalWidth;
                const maxLogoWidth = isSquare ? 40 : isTall ? 20 : 60;
                const aspectRatio = img.naturalHeight / img.naturalWidth;
                const height = maxLogoWidth * aspectRatio;

                if (DefaultQrCodeLogo?.logo) {
                    base64Logo = await convertImageToBase64(DefaultQrCodeLogo?.logo);
                    // setLogoImage(base64Logo);
                } else {
                    base64Logo = await convertImageToBase64(qr_code_default_logo);
                    // setLogoImage(base64Logo);
                }
                // Render the QRCode component into the div
                root.render(
                    <QRCode
                        value={shortLink || ""}
                        logoImage={noQRCodeLogo ? "" : base64Logo}
                        logoWidth={maxLogoWidth || 40}
                        logoHeight={height}
                        qrStyle="dots"
                        eyeRadius={6}
                        size={data.qrSize || 200}
                        quietZone={0}
                        fgColor="#000000"
                        bgColor="transparent"
                    />
                );

                setTimeout(() => {
                    const qrCanvas = tempDiv.querySelector("canvas");
                    if (qrCanvas) {
                        const img = new window.Image();
                        img.src = qrCanvas.toDataURL("image/png");
                        img.onload = () => setImage(img);
                    }
                    root.unmount();
                    tempDiv.remove();
                }, 100);
                // setLogoSize({ width: maxLogoWidth, height });
            };
            img.src = imageSrc;
        }
        else if (!DefaultQrCodeLogo?.logo && !noQRCodeLogo) {
            const imageSrc = qr_code_default_logo;
            const img = new Image();
            img.onload = async () => {
                const isSquare = img.naturalHeight === img.naturalWidth;
                const isTall = img.naturalHeight > img.naturalWidth;
                const maxLogoWidth = isSquare ? 30 : isTall ? 30 : 70;
                const aspectRatio = img.naturalHeight / img.naturalWidth;
                const height = maxLogoWidth * aspectRatio;

                if (DefaultQrCodeLogo?.logo) {
                    base64Logo = await convertImageToBase64(DefaultQrCodeLogo?.logo);
                    // setLogoImage(base64Logo);
                } else {
                    base64Logo = await convertImageToBase64(qr_code_default_logo);
                    // setLogoImage(base64Logo);
                }
                // Render the QRCode component into the div
                root.render(
                    <QRCode
                        value={shortLink || ""}
                        logoImage={noQRCodeLogo ? "" : base64Logo}
                        logoWidth={maxLogoWidth || 40}
                        logoHeight={height}
                        qrStyle="dots"
                        eyeRadius={6}
                        size={data.qrSize || 200}
                        quietZone={0}
                        fgColor="#000000"
                        bgColor="transparent"
                    />
                );

                setTimeout(() => {
                    const qrCanvas = tempDiv.querySelector("canvas");
                    if (qrCanvas) {
                        const img = new window.Image();
                        img.src = qrCanvas.toDataURL("image/png");
                        img.onload = () => setImage(img);
                    }
                    root.unmount();
                    tempDiv.remove();
                }, 100);
                // setLogoSize({ width: maxLogoWidth, height });
            };
            img.src = imageSrc;
        }
    }
    useEffect(() => {
        if (data.key === "qrCode") {
            EmbedLogoOnQrCode()
        } else if (loadedImage) {
            setImage(loadedImage);
        }
    }, [data, loadedImage]);

    if (!image) return null;

    return (
        <KonvaImage
            image={image}
            x={data.position.x}
            y={data.position.y}
            width={data.width}
            height={data.height}
            draggable={false}
            cornerRadius={
                data?.key === "profilePhoto" && 100
            }
            listening={false}
            onClick={() => handleImageClick(data)}
            onMouseEnter={(e) => {
                const container = e.target.getStage().container();
                container.style.cursor = "pointer"; // change cursor on hover
            }}
            onMouseLeave={(e) => {
                const container = e.target.getStage().container();
                container.style.cursor = "default"; // revert cursor
            }}
        />
    );
};

export const PreviewText = ({
    field,
    getOptionTextForKonva,
    options,
    allFields,
    card
}) => {
    const textRef = useRef()
    // ICON MAPPING

    const [svgUrl, setSvgUrl] = useState(null);
    const icons = {
        mobileNumber: MobileSVG,
        landlineNumber: PhoneSVG,
        email: EmailSVG,
        addressLine1: LocationSVG,
        fax: FaxxSVG,
        website: GlobeSVG
    };
    function convertSvgComponentToImageUrl(Component, color) {
        return new Promise((resolve, reject) => {
            // Render SVG to string manually
            const div = document.createElement("div");
            div.style.display = "none";
            document.body.appendChild(div);

            import("react-dom").then(({ createRoot }) => {
                const root = createRoot(div);
                root.render(<Component color={color} size={1000} />);

                setTimeout(() => {
                    const svg = div.querySelector("svg");
                    if (!svg) return reject("No SVG Output");

                    // Serialize to string
                    const svgData = new XMLSerializer().serializeToString(svg);
                    const base64 = "data:image/svg+xml;base64," + btoa(svgData);

                    document.body.removeChild(div);

                    resolve(base64);
                }, 50);
            });
        });
    }

    useEffect(() => {
        const IconComponent = icons[field?.key];
        if (!IconComponent) {
            console.warn("Invalid icon key:", field?.key);
            setSvgUrl(null);
            return;
        }

        convertSvgComponentToImageUrl(IconComponent, field?.color)
            .then(setSvgUrl)
            .catch(console.error);

    }, [field?.key, field?.color]);

    const [iconImage] = useImage(svgUrl);

    const showIcon =
        field?.label &&
        field?.label === "ICON" &&
        iconImage;

    // ICON SIZE
    const { iconWidth, iconHeight } = useMemo(() => {
        if (!iconImage) return { iconWidth: 0, iconHeight: 0 };
        const ratio = iconImage.width / iconImage.height;
        const h = field?.fontSize * 2 || 40;
        return {
            iconWidth: h * ratio,
            iconHeight: h,
        };
    }, [iconImage, field?.fontSize]);

    // DISPLAY TEXT
    const safeText = (val) =>
        val === null || val === undefined ? "" : String(val);

    const displayText = options[field.key]
        ? getOptionTextForKonva(allFields, options, field.key, card)
        : field?.key?.startsWith("customText-") ? safeText(field?.value) : safeText(card?.[field.key])

    const labelPrefix =
        field?.label && field.label !== "ICON" && [...Object.keys(icons), "website"].includes(field?.key)
            && !!displayText ? `${field.label} : ` : "";

    return (
        <Group
            x={field.position.x}
            y={field.position.y}
        >

            {/* ICON */}
            {showIcon && !!displayText && (
                <KonvaImage
                    image={iconImage}
                    x={0}
                    y={-2}
                    width={iconWidth + 3}
                    height={iconHeight}
                />
            )}

            {/* TEXT */}
            <Text
                // ref={(node) => {
                //     if (node) textRef.current[field.key] = node;
                // }}
                x={showIcon ? iconWidth + 5 : 0}
                y={3}
                text={labelPrefix + displayText}
                width={field.width || 150}
                height={field.height || 20}
                fontSize={field.fontSize}
                fontFamily={field.fontFamily}
                fontStyle={`${field.fontWeight} ${field.fontStyle}`}
                textDecoration={field.fontDecorationLine}
                fill={field.color}
                align={field.align || "left"}
            />
        </Group>
    );
};

export default function SignatureView({ showPreview, apply, showSocialMediaIcons = true, shortLink = "" }) {
    const containerRef = useRef(null);
    const stageRef = useRef(null);
    // const card = card;
    // const { qrcodeLogos, noQRCodeLogo } = useSelector((state) => state.Logos);
    const DefaultQrCodeLogo = {
        logo: defaultLogo,
        isDefault: true
    };
    const noQRCodeLogo = false
    const baseWidth = 336;
    const baseHeight = 192;
    const options = {
        fullName: ["prefix", "firstName", "lastName"],
        email: ["email", "email1", "email2"],
        mobileNumber: ["mobileNumber", "mobileNumber1", "mobileNumber2"],
        landlineNumber: ["landlineNumber", "landlineNumber1", "landlineNumber2"],
        fax: ["fax", "fax1"],
        addressLine1: [
            "address",
            "addressLine1",
            "addressLine2",
            "city",
            "state",
            "country",
            "pincode",
        ],
    };

    // 🖼 Banner support
    const bannerField = form?.elements?.find((f) => f.key === "banner" && f.show);
    const [bannerImage] = useImage(!!bannerField?.link ? bannerField?.link : bannerField?.value || "", "anonymous");
    const [bannerHeight, setBannerHeight] = useState(0);
    const disclaimerField = form?.elements?.find(f => f.key === "disclaimer" && f.show);
    // Responsive scaling
    const [stageSize, setStageSize] = useState({ width: baseWidth, height: baseHeight });
    const [scale, setScale] = useState({ x: 1, y: 1 });
    const [allFields, setAllFields] = useState([...form?.elements]);
    const [show, setShow] = useState(true)
    const [disclaimerHeight, setDisclaimerHeight] = useState(0)
    // Adjust stage height dynamically based on banner size

    const updateFieldsFromCard = (card) => (prevFields) => {
        if (!card) return prevFields;

        let youtubeIndex = 0; // for duplicate socials

        return prevFields.map((field) => {
            // ==========================
            // ✅ BASIC TEXT MAPPINGS
            // ==========================
            // ✅ FULL NAME = prefix + firstName + lastName
            if (field.key === "fullName") {
                const prefix = card.prefix ?? "";
                const firstName = card.firstName ?? "";
                const lastName = card.lastName ?? "";

                const fullName = [prefix, firstName, lastName]
                    .filter(Boolean)
                    .join(" ");

                return {
                    ...field,
                    value: fullName,
                    // show: Boolean(fullName)   // hide if empty
                };
            }
            if (field.key === "designation") return { ...field, value: card.designation ?? "" };
            if (field.key === "companyName") return { ...field, value: card.companyName ?? "" };
            if (field.key === "website") return { ...field, value: card.website ?? "" };

            // ==========================
            // ✅ PROFILE PHOTO
            // ==========================
            if (field.key === "profilePhoto") {
                return {
                    ...field,
                    value: card.profileImage
                        ? `${window.location.origin}/v2/getCardProfileImage/${card.profileImage}`
                        : "",
                    show: field.show,
                };
            }

            // ==========================
            // ✅ CUSTOM TEXT SAFETY
            // ==========================
            if (field?.key?.startsWith("customText-")) {
                return field; // DO NOT TOUCH
            }

            // ==========================
            // ✅ EMAIL MAPPING (MULTIPLE)
            // ==========================
            if (field.key?.startsWith("email")) {
                const index = Number(field.key.replace("email", "")) || 0;
                const value = card.email?.[index] ?? "";
                return {
                    ...field,
                    value,
                    // show: Boolean(value && !card.hiddenEmail?.[index])
                };
            }

            // ==========================
            // ✅ MOBILE MAPPING
            // ==========================
            if (field.key?.startsWith("mobileNumber")) {
                const index = Number(field.key.replace("mobileNumber", "")) || 0;
                const mobile = card.mobileNumber?.[index];

                const value = mobile
                    ? `${mobile.countryCode} ${mobile.number}`
                    : "";

                return {
                    ...field,
                    value,
                    // show: Boolean(value && !card.hiddenMobile?.[index])
                };
            }
            if (field.key?.startsWith("fax")) {
                const index = Number(field.key.replace("fax", "")) || 0;
                const value = card.fax?.[index] ?? "";

                return {
                    ...field,
                    value,
                    // show: Boolean(value && !card.hiddenFax?.[index])
                };
            }

            // ==========================
            // ✅ LANDLINE
            // ==========================
            if (field.key?.startsWith("landlineNumber")) {
                const index = Number(field.key.replace("landlineNumber", "")) || 0;
                const value = card.landlineNumber?.[index] ?? "";

                return {
                    ...field,
                    value,
                    // show: Boolean(value && !card.hiddenLandline?.[index])
                };
            }

            // ==========================
            // ✅ ADDRESS
            // ==========================
            if (field.key === "addressLine1") return { ...field, value: card.address?.addressLine1 ?? "" };
            if (field.key === "addressLine2") return { ...field, value: card.address?.addressLine2 ?? "" };
            if (field.key === "city") return { ...field, value: card.address?.city ?? "" };
            if (field.key === "state") return { ...field, value: card.address?.state ?? "" };
            if (field.key === "country") return { ...field, value: card.address?.country ?? "" };
            if (field.key === "pincode") return { ...field, value: card.address?.pinCode ?? "" };

            // ==========================
            // ✅ SOCIAL LINKS (MULTI YOUTUBE SAFE)
            // ==========================
            if (field?.name) {
                const entries = card.social?.filter(
                    soc => soc.socialMediaName === field.name
                );

                const social = entries?.[youtubeIndex] || entries?.[0];

                if (field.name === "youtube") youtubeIndex++;

                return social
                    ? { ...field, link: social.value }
                    : { ...field, link: "", show: false };
            }

            // ==========================
            // ✅ DEFAULT
            // ==========================
            return field;
        });
    };

    useEffect(() => {
        if (!card || !form?.elements?.length) return;
        const updated = updateFieldsFromCard(card)([...form?.elements]);
        setAllFields(updated);
    }, [card, form?.elements]);

    // useEffect(() => {
    //     if (!containerRef.current) return;

    //     const resizeObserver = new ResizeObserver(entries => {
    //         const width = entries[0].contentRect.width;
    //         if (!width) return;

    //         const stageWidth = Math.min(width, 800);
    //         const scaleRatio = stageWidth / baseWidth;

    //         setStageSize({
    //             width: stageWidth,
    //             height: baseHeight * scaleRatio
    //         });

    //         setScale({
    //             x: scaleRatio,
    //             y: scaleRatio
    //         });
    //     });

    //     resizeObserver.observe(containerRef.current);
    //     return () => resizeObserver.disconnect();
    // }, [baseWidth, baseHeight]);

    useEffect(() => {
        if (!containerRef.current) return;

        const resizeObserver = new ResizeObserver(entries => {
            const width = entries[0].contentRect.width;
            if (!width) return;

            const stageWidth = Math.min(width, 800);
            const scaleRatio = stageWidth / baseWidth;

            setStageSize({
                width: stageWidth,
                height: baseHeight // 🔑 DO NOT SCALE HEIGHT
            });

            setScale({
                x: scaleRatio,
                y: scaleRatio
            });
        });

        resizeObserver.observe(containerRef.current);
        return () => resizeObserver.disconnect();
    }, [baseWidth, baseHeight]);

    useEffect(() => {
        setShow(prev => !prev)
    }, [showPreview])

    // Utility to flatten nested objects and arrays (e.g., address + mobile[])

    const getOptionTextForKonva = (allFields, options, key) => {
        const childKeys = options?.[key];
        if (!Array.isArray(childKeys)) return "";

        // ✅ Check parent visibility
        const parentField = allFields.find((f) => f.key === key);
        if (!parentField?.show) return "";
        // ✅ FULL NAME uses direct computed value
        if (key === "fullName") {
            return parentField?.value || "";
        }

        // ✅ All other groups (mobile, email, fax, address, etc)
        return childKeys
            .map((childKey) => {
                const childField = allFields.find((f) => f.key === childKey);

                // ✅ Respect visibility
                if (!childField || !childField.show) return "";

                // ✅ Only visible fields contribute
                return childField.value || "";
            })
            .filter(Boolean)
            .join(`${parentField?.separator || ""} `);
    };

    const handleImageClick = (field) => {
        if (!field?.value) return;

        // Create an anchor element
        const link = document.createElement("a");
        link.href = field.link; // URL of the image
        // link.download = "image.png"; // Name for the downloaded file
        link.target = "_blank"; // Optional: open in new tab
        // document.body.appendChild(link);

        // Trigger click
        link.click();

        // Cleanup
        // document.body.removeChild(link);
    };

    const bgField = allFields.find(f => f.key === "backgroundImage");
    const bgImageURL = bgField?.link || bgField?.value || "";
    const [backgroundImage] = useImage(bgImageURL, "anonymous");

    // Compute scaled size (preserve aspect ratio)
    const getScaledSize = () => {
        if (!backgroundImage) return { w: baseWidth, h: baseHeight, x: 0, y: 0 };

        const imgW = backgroundImage.width;
        const imgH = backgroundImage.height;

        const scale = Math.min(baseWidth / imgW, baseHeight / imgH);

        const w = imgW * scale;
        const h = imgH * scale;

        // Center inside canvas
        const x = (baseWidth - w) / 2;
        const y = (baseHeight - h) / 2;

        return { w, h, x, y };
    };

    const { w, h, x, y } = getScaledSize();


    const applyHTML = async () => {
        if (!stageRef.current) return;

        const data = updateFieldsFromCard(card)(allFields);

        // ------ 6️⃣ COPY HTML AS EMAIL SIGNATURE (MIME CLIPBOARD) ------

        try {
            const freshLink = `${"https://cardbyteqasg.blob.core.windows.net/cardbyte-email-signature/5badb545-d26c-4c83-aee2-a49070be7792.png"}?v=${Date.now()}`

            const freshLinkForBanner = `https://cardbyteqasg.blob.core.windows.net/cardbyte-email-signature/Banner-CB-ORG-1106202526817349-93132?v=${Date.now()}`

            const html = generateEmailSignatureHTML(
                freshLink,
                data,
                freshLinkForBanner
            );
            // const type = "text/html";
            // const blob = new Blob([html], { type });
            // // eslint-disable-next-line no-undef
            // const clipboardItem = new ClipboardItem({
            //     [type]: blob,
            //     "text/plain": new Blob([html], { type: "text/plain" })
            // });
            // await navigator.clipboard.write([clipboardItem]);
            apply(html)
            console.log("sdjasdkjahsdkjhsa", html)
            toast?.success("Signature copied! Now paste directly into Gmail/Outlook.");

        } catch (error) {
            toast.error(error?.response?.data?.message || error.message || "Failed to save email signature, please try again later.")
            console.error("Error while saving email signature:", error);
        } finally {
            // setShow(false)
        }

        // ------ 6️⃣ DOWNLOAD ------
        // downloadHTMLFile(html);
    }

    return (
        <Grid container>
            <Grid
                size={{
                    xs: 12,
                    sm: 12,
                }}
            >
                <Paper
                    // elevation={12}
                    elevation={5}
                    sx={{
                        p: 1,
                        borderRadius: 8,
                        width: "100%",
                        maxWidth: "800px",
                        margin: "0 auto",
                        display: "flex",
                        flexDirection: "column",
                        rowGap: 2,
                        alignItems: "center",
                        // 🧠 Dynamically adapt Paper height to stage + extra padding
                        // minHeight: `${stageSize.height * scale.y + (show ? 80 : 40) + disclaimerHeight + bannerHeight}px`, // +40 for breathing room
                        justifyContent: "space-between",
                        // boxShadow: "0 2px 8px rgba(0,0,0,0.05)", // subtle shadow for card feel
                        // backgroundColor: "#fafafa"
                    }}
                >
                    {/* Konva Preview Stage */}
                    <Box width={'100%'}>
                        <Box
                            component={Paper}
                            ref={containerRef}
                            sx={{
                                width: "100%",
                                maxWidth: 800,
                                borderRadius: 5,
                                margin: "auto",

                                // 🚫 no scrollbars, just clip anything extra
                                overflow: "hidden",

                                // (optional extra safety – hide scrollbars in browsers that still show them)
                                "&::-webkit-scrollbar": {
                                    display: "none",
                                },
                                scrollbarWidth: "none",      // Firefox
                                msOverflowStyle: "none",     // IE/Edge
                            }}
                        >
                            <Stage
                                ref={stageRef}
                                width={stageSize.width}
                                height={stageSize.height}
                                scale={scale}
                            >
                                <Layer>
                                    {backgroundImage ? (
                                        <KonvaImage
                                            image={backgroundImage}
                                            x={x}
                                            y={y}
                                            width={w}
                                            height={h}
                                            listening={false}
                                        />
                                    )
                                        :
                                        <Rect
                                            x={0}
                                            y={0}
                                            width={baseWidth}
                                            height={stageSize.height}
                                            fill={allFields.find(f => f.key === "backgroundColor")?.value || "#ffffff"}
                                            listening={false}
                                            cornerRadius={[8, 8, 8, 8]} // only bottom corners rounded
                                        />
                                    }
                                    {/* ✅ SHAPES (BOTTOM LAYER) */}
                                    {allFields?.filter(item =>
                                        item?.type === "shape" &&
                                        item?.key !== "signatureName" &&
                                        item?.key !== "banner" &&
                                        item?.key !== "disclaimer" &&
                                        item?.key !== "backgroundColor" &&
                                        item?.key !== "backgroundImage"
                                    ).map((field) => {

                                        switch (field.shapeType) {

                                            case "line":
                                                return (
                                                    <Line
                                                        key={field.key}
                                                        points={field.points || []}
                                                        stroke={field.stroke || "#000"}
                                                        strokeWidth={field.strokeWidth || 2}
                                                        x={field.position?.x || 0}
                                                        y={field.position?.y || 0}
                                                        listening={false}
                                                    />
                                                );

                                            case "rect":
                                                return (
                                                    <Rect
                                                        key={field.key}
                                                        x={field.position?.x || 0}
                                                        y={field.position?.y || 0}
                                                        width={field.width || 100}
                                                        height={field.height || 50}
                                                        fill={field.fill || "#000"}
                                                        // stroke={field.stroke || "transparent"}
                                                        // strokeWidth={field.strokeWidth || 1}
                                                        // cornerRadius={field.radius || 0}
                                                        listening={false}
                                                    />
                                                );

                                            case "circle":
                                                return (
                                                    <Circle
                                                        key={field.key}
                                                        x={field.position?.x || 0}
                                                        y={field.position?.y || 0}
                                                        radius={field.radius || 20}
                                                        fill={field.fill || "#000"}
                                                        // stroke={field.stroke || "transparent"}
                                                        // strokeWidth={field.strokeWidth || 1}
                                                        listening={false}
                                                    />
                                                );

                                            default:
                                                return null;
                                        }
                                    })}


                                    {/* ✅ IMAGES (MIDDLE LAYER) */}
                                    {allFields?.filter(item =>
                                        ["profilePhoto", "logo", "qrCode"].includes(item.key) &&
                                        item?.value &&
                                        item?.show
                                    ).map((field) => (
                                        <>
                                            <ImagesUsedPreview
                                                key={field.key}
                                                id={field.key}
                                                data={field}
                                                draggable={false}
                                                handleImageClick={handleImageClick}
                                                DefaultQrCodeLogo={DefaultQrCodeLogo}
                                                noQRCodeLogo={noQRCodeLogo}
                                                shortLink={shortLink}
                                            />
                                        </>
                                    ))}

                                    {/* ✅ TEXT (TOP LAYER) */}
                                    {allFields?.filter(item =>
                                        item?.type !== "shape" &&
                                        !["profilePhoto", "logo", "qrCode"].includes(item.key) &&
                                        item?.key !== "signatureName" &&
                                        item?.key !== "banner" &&
                                        item?.key !== "disclaimer" &&
                                        item?.key !== "backgroundColor" &&
                                        item?.key !== "backgroundImage"
                                    ).map((field) => {

                                        const parentKeys = Object.keys(options);
                                        const childKeys = Object.values(options).flat();
                                        const isChildOnly = !parentKeys.includes(field.key) && childKeys.includes(field.key);

                                        if (!field.show || isChildOnly) return null;
                                        return (
                                            <PreviewText
                                                allFields={allFields}
                                                field={field}
                                                getOptionTextForKonva={getOptionTextForKonva}
                                                options={options}
                                                card={card}
                                            />
                                        );
                                    })}
                                    {/* 🏞 Banner always fixed at bottom, aspect ratio conserved */}
                                    {/* // Disclaimer */}
                                    {!form?.elements?.find(f => f.key === "disclaimer")?.value && (
                                        <Text
                                            x={0}
                                            y={baseHeight + bannerHeight} // below banner
                                            text={form?.elements?.find(f => f.key === "disclaimer").value}
                                            fontSize={12} // adjust font size if needed
                                            fontFamily="Plus Jakarta Sans"
                                            fontStyle="normal"
                                            fill="#555555"
                                            width={baseWidth}
                                            align="center"
                                            listening={false}
                                        />
                                    )}
                                </Layer>
                            </Stage>
                        </Box>
                        <Box
                            sx={{
                                // height: show ? "200px" : "10px",    // adjust height as needed
                                overflow: "hidden",
                                transition: "height 0.35s ease",
                                display: showSocialMediaIcons ? 'block' : 'none',
                                width: '100%'
                            }}
                        >
                            <Box display={'flex'} justifyContent={'space-between'} alignItems={'center'} p={1}>
                                <Stack direction={'row'} flexWrap={'wrap'} columnGap={1} rowGap={1}>
                                    {allFields
                                        ?.filter(i => i?.key.toLowerCase()?.startsWith("social"))
                                        ?.filter(i => !["teams", "meet", "calendly", "pdf", "url"]?.includes(i?.name))
                                        ?.filter(i => i?.show)
                                        ?.map(field => (
                                            <a href={`${field?.link}`} target="_blank">
                                                <IconAvatar
                                                    key={field.key}
                                                    image={field?.value}
                                                    size={25}
                                                />
                                            </a>
                                        ))}
                                </Stack>

                                <IconButton onClick={() => setShow(prev => !prev)}>
                                    <KeyboardArrowDownOutlined
                                        sx={{
                                            transform: show ? "rotate(180deg)" : "rotate(0deg)",
                                            transition: "transform 0.3s ease"
                                        }}
                                    />
                                </IconButton>
                            </Box>
                            <Box display={'flex'} justifyContent={'space-between'} alignItems={'center'} p={1}>
                                <Stack direction={'row'} flexWrap={'wrap'} columnGap={1} rowGap={1}>
                                    {allFields
                                        ?.filter(i => i?.key.toLowerCase()?.startsWith("social"))
                                        ?.filter(i => show ? ["teams", "meet", "calendly", "pdf", "url"]?.includes(i?.name) : ["teams"]?.includes(i?.name))
                                        ?.filter(i => i?.show)
                                        ?.map(field => (
                                            <a href={`${field?.link}`}
                                                target="_blank"
                                                style={{
                                                    background: "#fff",
                                                    padding: "5px 20px",
                                                    borderRadius: "20px",
                                                    border: "1px solid #000",
                                                    color: "#000",
                                                    fontFamily: "Arial, sans-serif",
                                                    fontSize: "14px",
                                                    fontWeight: 500,
                                                    textDecoration: "none",
                                                    display: "flex",
                                                    alignItems: 'center',
                                                    columnGap: 5
                                                }}
                                            >
                                                <img
                                                    src={field?.value}
                                                    width="16"
                                                />
                                                {field?.label}
                                            </a>
                                        ))}
                                </Stack>
                            </Box>
                        </Box>
                        {
                            show &&
                            <Box
                                width={stageSize.width}
                                height={stageSize?.width * 0.30}
                                overflow="hidden"
                            >
                                <img
                                    src={!!bannerField?.value ? bannerField?.value : uploadbanner}
                                    style={{
                                        width: "100%",
                                        height: "100%",
                                        objectFit: "contain",   // ✅ preserves aspect ratio
                                        display: "block"
                                    }}
                                />
                            </Box>
                        }
                        {
                            show &&
                            <Box display={'flex'} width={stageSize.width} pt={1}>
                                <Typography
                                    variant="body2"
                                    fontFamily="Plus Jakarta Display"
                                    fontSize={10}
                                    textAlign="start"
                                    textJustify="inter-word"
                                    sx={{
                                        width: "100%",
                                        display: "-webkit-box",
                                        overflow: "hidden",
                                        WebkitBoxOrient: "vertical",
                                        WebkitLineClamp: 3, // number of lines to show
                                    }}
                                >
                                    {allFields.find(f => f.key === "disclaimer")?.value}
                                </Typography>
                            </Box>
                        }
                    </Box>
                    <Stack
                        display={"flex"}
                        direction="row" spacing={1} justifyContent={'end'} width={'100%'}
                    >
                        <Button
                            onClick={() => applyHTML()}
                            variant="outlined"
                            size="small"
                            sx={{
                                width: "100px",
                                height: "47px",
                                marginRight: "8px",
                                backgroundColor: "#fff",
                                border: "1px solid #eeeeee",
                                borderRadius: "13px",
                                fontSize: "13px",
                                fontFamily: "Plus Jakarta Display",
                                textTransform: "capitalize",
                                // color: "#000",
                                color: "#4A5056",
                                "&:hover": {
                                    // backgroundColor: "#144CC9",
                                    color: "#4A5056",
                                    borderColor: "#ccc",
                                },
                            }}
                        >
                            Apply
                        </Button>
                    </Stack>
                </Paper>
            </Grid>
        </Grid>
    );
}