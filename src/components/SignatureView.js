import { useEffect, useRef, useState } from "react";
import { Box, Button, Grid, Paper, Skeleton, Stack, Typography } from "@mui/material";
import { toast } from "react-toastify";
import { IconAvatar } from "./SignatureComponents/IconAvatar";
import usernotfound from "../components/SignatureComponents/Assets/Images/usernotfound.gif";
import signnotassigned from "../components/SignatureComponents/Assets/Images/signnotassigned.webp";

export default function SignatureView({
    user,
    apply,                // ✅ expects CID payload
    showSocialMediaIcons = true
}) {
    const containerRef = useRef(null);

    const [payload, setPayload] = useState(null); // { html, attachments }
    const [form, setForm] = useState({ elements: [] });
    const [error, setError] = useState("");
    const [load, setLoad] = useState(false);

    /* ---------------------------------------------------------
       APPLY SIGNATURE (CID SAFE)
    --------------------------------------------------------- */
    const applySignature = async () => {
        if (!payload) {
            toast.error("Signature not ready");
            return;
        }
        try {
            apply(payload); // 🔥 pass server-rendered payload
            toast.success("Signature applied successfully");
        } catch (e) {
            toast.error("Failed to apply signature");
            console.error(e);
        }
    };

    /* ---------------------------------------------------------
       FETCH SIGNATURE (SERVER RENDERED)
    --------------------------------------------------------- */
    async function renderSignatureOnServer(user) {
        const res = await fetch("http://localhost:4000/render-signature-cid", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email: user.emailAddress })
        });

        if (!res.ok) throw new Error("Renderer failed");
        return res.json(); // { html, attachments, elements, emailSignatureUrl, bannerFileUrl }
    }

    useEffect(() => {
        if (!user?.emailAddress) return;

        const loadSignature = async () => {
            setLoad(true);
            setError("");

            try {
                const apiResponse = await renderSignatureOnServer(user);

                // 🔥 save full payload for Outlook insertion
                setPayload({
                    html: apiResponse.html,
                    attachments: apiResponse.attachments
                });

                // 🔍 keep form data ONLY for preview
                setForm({
                    elements: apiResponse.elements || [],
                    emailSignatureUrl: apiResponse.emailSignatureUrl,
                    bannerFileUrl: apiResponse.bannerFileUrl
                });

            } catch (e) {
                console.error(e);
                setError("No signature assigned");
            } finally {
                setLoad(false);
            }
        };

        loadSignature();
    }, [user]);

    /* ---------------------------------------------------------
       UI
    --------------------------------------------------------- */
    console.log("Rendering SignatureView", payload?.attachments?.find(a => a.cid === "cb-banner"))
    return (
        <Grid container justifyContent="center" rowGap={2}>
            <Grid
                size={{
                    xs: 11
                }}
            >
                <Typography fontSize="12px" fontWeight="bold" fontFamily={'Plus Jakarta Sans'}>
                    Welcome to CardByte
                </Typography>

                <Typography fontFamily={'Plus Jakarta Sans'}>
                    {user?.displayName}
                </Typography>
                <Typography fontFamily={'Plus Jakarta Sans'} color="#595959" fontSize={"12px"}>
                    This is the signature set up for you by your Organisation Administrator.
                    Click apply to add the signature to your mail.
                </Typography>
            </Grid>

            <Grid
                size={{
                    xs: 11
                }}
                display={'flex'}

            >
                {load ? (
                    <Paper elevation={5} sx={{ p: 2, borderRadius: 8 }}>
                        <Skeleton variant="rectangular" height={180} />
                    </Paper>
                ) : (
                    <Paper elevation={0} sx={{ borderRadius: 8 }}>
                        {form?.elements?.length === 0 ? (
                            <Box textAlign="center" mt={4}>
                                <img
                                    src={error ? usernotfound : signnotassigned}
                                    width="100%"
                                    alt="empty"
                                />
                                <Typography variant="h6">
                                    {error || "No Signature Assigned"}
                                </Typography>
                            </Box>
                        ) : (
                            <>
                                {/* ---------------- PREVIEW ---------------- */}
                                <Box ref={containerRef}>
                                    <img
                                        src={`data:image/png;base64,${payload?.attachments?.find(a => a.cid === "cb-signature")?.base64}`}
                                        alt="Signature Preview"
                                        style={{
                                            width: "100%",
                                            display: "block",
                                            borderRadius: 8
                                        }}
                                    />
                                </Box>

                                {/* ---------------- SOCIAL ICON PREVIEW ---------------- */}
                                {showSocialMediaIcons && (
                                    <Stack direction="row" flexWrap="wrap" gap={1} p={1}>
                                        {form.elements
                                            .filter(i => i.key?.toLowerCase().startsWith("social"))
                                            .filter(i => i.show)
                                            .map(i => (
                                                <a
                                                    key={i.key}
                                                    href={i.link}
                                                    target="_blank"
                                                    rel="noreferrer"
                                                >
                                                    <IconAvatar image={i.value} size={25} />
                                                </a>
                                            ))}
                                    </Stack>
                                )}

                                {/* ---------------- BANNER PREVIEW ---------------- */}
                                {payload?.attachments?.find(a => a.cid === "cb-banner")?.base64 && (
                                    <Box mt={1} id="banner-container">
                                        <img
                                            src={`data:image/png;base64,${payload?.attachments?.find(a => a.cid === "cb-banner")?.base64}`}
                                            style={{
                                                width: "100%",
                                                height: document?.getElementById("banner-container")?.offsetWidth * 0.2,
                                                borderRadius: 8
                                            }}
                                            alt="Banner"
                                        />
                                    </Box>
                                )}

                                {/* ---------------- APPLY BUTTON ---------------- */}
                                <Stack mt={2} alignItems="center">
                                    <Button
                                        onClick={applySignature}
                                        variant="contained"
                                        sx={{
                                            width: 180,
                                            height: 40,
                                            borderRadius: 2,
                                            textTransform: "capitalize"
                                        }}
                                    >
                                        Apply Signature
                                    </Button>
                                </Stack>
                            </>
                        )}
                    </Paper>
                )}
            </Grid>
        </Grid>
    );
}
