import { useEffect, useMemo, useRef, useState } from "react";
import { Stage, Layer, Image as KonvaImage, } from "react-konva";
import { Box, Button, Grid, Paper, Skeleton, Stack, Typography } from "@mui/material";
import useImage from "use-image";
import { toast } from "react-toastify";
import DefaultTemplate from "./SignatureComponents/Assets/Images/DefaultTemplate.svg"
import uploadbanner from './SignatureComponents/Assets/Images/uploadbanner.png'
import { generateEmailSignatureHTML, IconAvatar } from "./SignatureComponents/IconAvatar";
import { card } from "../data";
import { handleAesDecrypt, handleAesEncrypt } from "../util";
import { emailsigOutlook } from "../services/apiClient";

export default function SignatureView({ user, apply, showSocialMediaIcons = true }) {
    const containerRef = useRef(null);
    const stageRef = useRef(null);

    const [form, setForm] = useState({
        elements: []
    })
    const baseWidth = 336;
    const baseHeight = 192;

    // Responsive scaling
    const [stageSize, setStageSize] = useState({ width: baseWidth, height: baseHeight });
    const [scale, setScale] = useState({ x: 1, y: 1 });
    const [allFields, setAllFields] = useState(
        Array.isArray(form?.elements) ? [...form.elements] : []
    );
    const [load, setLoad] = useState(false)
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

    useEffect(() => {
        if (!containerRef.current) return;

        const resizeObserver = new ResizeObserver(entries => {
            const width = entries[0].contentRect.width;
            if (!width) return;

            const stageWidth = Math.min(width, 800);
            const scaleRatio = stageWidth / baseWidth;

            setStageSize({
                width: stageWidth,
                height: baseHeight * scaleRatio
            });

            setScale({
                x: scaleRatio,
                y: scaleRatio
            });
        });

        resizeObserver.observe(containerRef.current);
        return () => resizeObserver.disconnect();
    }, [baseWidth, baseHeight, load, allFields]);

    const [backgroundImage] = useImage(form?.emailSignatureUrl);


    const applyHTML = async () => {
        // if (!stageRef.current) return;

        const data = updateFieldsFromCard(card)(allFields);

        // ------ 6️⃣ COPY HTML AS EMAIL SIGNATURE (MIME CLIPBOARD) ------

        try {
            const freshLink = `${form?.emailSignatureUrl}?v=${Date.now()}`

            const freshLinkForBanner = `${form?.bannerFileUrl}?v=${Date.now()}`

            const html = generateEmailSignatureHTML(
                freshLink,
                data,
                freshLinkForBanner
            );
            // const type = "text/html";
            // const blob = new Blob([html], { type });
            // eslint-disable-next-line no-undef
            // const clipboardItem = new ClipboardItem({
            //     [type]: blob,
            //     "text/plain": new Blob([html], { type: "text/plain" })
            // });
            console.log(html)
            apply(html)
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
    useEffect(() => {
        const encryptAndFetch = async () => {
            if (!user?.emailAddress) return;
            setLoad(true)
            const encryptedUsername = await handleAesEncrypt(user?.emailAddress);
            localStorage.setItem("encryptedEmail", encryptedUsername)
            try {
                const response = await emailsigOutlook();
                if (response?.data) {
                    const decryptedData = await handleAesDecrypt(response?.data)
                    setForm(JSON.parse(decryptedData))
                }
            } catch (e) {
                console.error(e)
            } finally {
                setLoad(false)
            }
        };

        encryptAndFetch();
    }, [user?.emailAddress]);

    return (
        <Grid container justifyContent={'center'} rowGap={2}>
            <Grid
                size={{
                    xs: 11
                }}
            >
                <Typography fontFamily="Plus Jakarta Sans">
                    Welcome to Cardbyte Signatures {" "}
                    <span
                        style={{
                            color: "#0070C0",
                            fontWeight: "bold",
                            textDecoration: "underline",
                        }}
                    >
                        {user?.displayName}
                    </span>

                    <br />

                    <span
                        style={{
                            color: "#5f5858ff",
                            // fontWeight: "bold",
                            textDecoration: "underline",
                        }}
                    >
                        {/* sairajesh.korla1272@yopmail.com */}
                        {user?.emailAddress}
                    </span>
                </Typography>
            </Grid>
            <Grid
                size={{
                    xs: 11
                }}
            >
                {
                    load ?
                        <Paper
                            elevation={5}
                            sx={{
                                p: 1,
                                borderRadius: 8,
                                width: "100%",
                                maxWidth: "800px",
                                margin: "0 auto",
                                display: "flex",
                                flexDirection: "column",
                                alignItems: "center",
                            }}
                        >

                            <Box
                                display="flex"
                                flexDirection="column"
                                alignItems="center"
                                justifyContent="center"
                                mt={4}
                            >
                                <img src={DefaultTemplate} alt="new" width={'100%'} />
                                {/* Title Skeleton */}
                                <Box mt={3} width="80%">
                                    <Skeleton
                                        variant="text"
                                        width="60%"
                                        height={28}
                                        sx={{ mx: "auto", borderRadius: 1 }}
                                        animation="wave"
                                    />

                                    {/* Subtitle Skeleton */}
                                    <Skeleton
                                        variant="text"
                                        width="80%"
                                        height={20}
                                        sx={{ mx: "auto", mt: 1, borderRadius: 1 }}
                                        animation="wave"
                                    />
                                </Box>
                            </Box>
                        </Paper>
                        :
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
                                // rowGap: 2,
                                alignItems: "center",
                            }}
                        >
                            {
                                allFields?.length === 0 ?
                                    < Box
                                        display="flex"
                                        flexDirection="column"
                                        alignItems="center"
                                        justifyContent="center"
                                        mt={4}
                                    >
                                        <Box mt={4} textAlign="center">
                                            <img src={DefaultTemplate} alt="new" width={'100%'} />
                                            <Typography fontFamily={"Plus Jakarta Sans"} variant="h6" gutterBottom>
                                                No Signature Available !
                                            </Typography>

                                            <Typography fontFamily={"Plus Jakarta Sans"} variant="body2" color="text.secondary">
                                                Please Contact Admin !
                                            </Typography>
                                        </Box>
                                    </Box>
                                    :
                                    <>
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
                                                    backgroundColor:
                                                        backgroundImage ? "tansparent" :
                                                            allFields.find(f => f.key === "backgroundColor")?.value || "#ffffff"
                                                    ,
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
                                                        <KonvaImage
                                                            image={backgroundImage}
                                                            x={0}
                                                            y={0}
                                                            width={stageSize.width / (stageSize.width / baseWidth)}
                                                            height={stageSize.height / (stageSize.height / baseHeight)}
                                                            listening={false}
                                                        />
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
                                                </Box>
                                                <Box display={'flex'} justifyContent={'space-between'} alignItems={'center'} p={1}>
                                                    <Stack direction={'row'} flexWrap={'wrap'} columnGap={1} rowGap={1}>
                                                        {allFields
                                                            ?.filter(i => i?.key.toLowerCase()?.startsWith("social"))
                                                            ?.filter(i => ["teams", "meet", "calendly", "pdf", "url"]?.includes(i?.name))
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
                                                !!form?.bannerFileUrl &&
                                                <Box
                                                    width={stageSize.width}
                                                    height={stageSize?.width * 0.30}
                                                    overflow="hidden"
                                                >
                                                    <img
                                                        src={!!form?.bannerFileUrl ? form?.bannerFileUrl : uploadbanner}
                                                        style={{
                                                            width: "100%",
                                                            height: "100%",
                                                            // objectFit: "contain",   // ✅ preserves aspect ratio
                                                            display: "block"
                                                        }}
                                                    />
                                                </Box>
                                            }
                                            {
                                                !!allFields.find(f => f.key === "disclaimer")?.value &&
                                                <Box display={'flex'} width={stageSize.width} pt={1}>
                                                    <Typography
                                                        variant="body2"
                                                        fontFamily="Plus Jakarta Sans"
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
                                            mt={1}
                                            display={"flex"}
                                            direction="row" justifyContent={'end'} width={'100%'}
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
                                                    fontFamily: "Plus Jakarta Sans",
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
                                    </>
                            }
                        </Paper>
                }
            </Grid>
        </Grid >
    );
}