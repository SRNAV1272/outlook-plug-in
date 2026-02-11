import { useEffect, useRef, useState } from "react";
import { Box, Button, Grid, Paper, Skeleton, Stack, Typography } from "@mui/material";
import { toast } from "react-toastify";
import DefaultTemplate from "./SignatureComponents/Assets/Images/DefaultTemplate.svg"
import usernotfound from "../components/SignatureComponents/Assets/Images/usernotfound.gif"
import signnotassigned from "../components/SignatureComponents/Assets/Images/signnotassigned.webp"

export default function SignatureView({ Office, user, apply }) {
    const [form, setForm] = useState(null)
    const [error, setError] = useState("")
    // Responsive scaling
    const [load, setLoad] = useState(false)
    const applyHTML = async () => {
        try {
            const settings = Office.context.roamingSettings;
            settings.saveAsync((result) => {
                if (result.status === Office.AsyncResultStatus.Succeeded) {
                    console.log("✅ Signature saved");
                } else {
                    console.error("❌ Failed to save", result.error);
                }
            });
            apply(form)

        } catch (error) {
            toast.error(error?.response?.data?.message || error.message || "Failed to save email signature, please try again later.")
            console.error("Error while saving email signature:", error);
        }
    }
    const AES_KEY = "fnItrY2YfozBqCC2B4XsfqHIvZku3kUOq3DFkbO64kk="
    const AES_IV = "3YapeNfJDung7TXxeKXn4g=="
    async function handleAesDecrypt(encryptedText, generatedKey) {
        try {
            if (!encryptedText) return "";

            // Check which key we're using
            const keyToUse = generatedKey || AES_KEY;
            // Decode and validate the key
            let keyBuffer;
            try {
                keyBuffer = base64ToArrayBuffer(keyToUse);
            } catch (e) {
                console.error("Failed to decode key as base64:", e);
                return encryptedText;
            }

            // Validate key length
            if (keyBuffer.byteLength !== 16 && keyBuffer.byteLength !== 32) {

                // If the generatedKey is invalid, try falling back to default
                if (generatedKey && generatedKey !== AES_KEY) {
                    return handleAesDecrypt(encryptedText, AES_KEY);
                }

                return encryptedText;
            }

            // Validate IV
            const ivBuffer = base64ToArrayBuffer(AES_IV);
            if (ivBuffer.byteLength !== 16) {
                return encryptedText;
            }

            const key = await crypto.subtle.importKey(
                "raw",
                keyBuffer,
                { name: "AES-CBC" },
                false,
                ["decrypt"]
            );

            // Decode encrypted text
            let encryptedBuffer;
            try {
                encryptedBuffer = base64ToArrayBuffer(encryptedText);
            } catch (e) {
                return encryptedText;
            }

            // Check if encrypted data length is valid for AES-CBC
            if (encryptedBuffer.byteLength % 16 !== 0) {
                console.error(`❌ Invalid encrypted data length: ${encryptedBuffer.byteLength} bytes (not multiple of 16)`);
                return encryptedText;
            }

            const decryptedBuffer = await crypto.subtle.decrypt(
                {
                    name: "AES-CBC",
                    iv: ivBuffer,
                },
                key,
                encryptedBuffer
            );

            const result = new TextDecoder().decode(decryptedBuffer);

            return result;
        } catch (err) {

            // If we have a generatedKey that failed, try with default key
            if (generatedKey && generatedKey !== AES_KEY && err.message.includes("key data")) {
                try {
                    return await handleAesDecrypt(encryptedText, AES_KEY);
                } catch (fallbackError) {
                    console.error("Fallback also failed:", fallbackError.message);
                }
            }

            return encryptedText; // Return original if decryption fails
        }
    }
    // Helper function
    function base64ToArrayBuffer(base64) {
        // Handle URL-safe base64 if needed
        let base64Data = base64.replace(/-/g, '+').replace(/_/g, '/');

        // Add padding if necessary
        const padding = base64Data.length % 4;
        if (padding) {
            base64Data += '='.repeat(4 - padding);
        }

        const binaryString = atob(base64Data);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }
        return bytes.buffer;
    }
    async function encryptEmail(email = "") {
        try {

            if (!email || email.trim() === "") {
                console.warn("Warning: Empty email provided");
                return "";
            }

            // Test key and IV decoding
            const keyBuffer = base64ToArrayBuffer(AES_KEY);
            const ivBuffer = base64ToArrayBuffer(AES_IV);

            if (keyBuffer.byteLength !== 16 && keyBuffer.byteLength !== 32) {
                console.error(`Invalid key length: ${keyBuffer.byteLength} bytes`);
                return "";
            }

            if (ivBuffer.byteLength !== 16) {
                console.error(`Invalid IV length: ${ivBuffer.byteLength} bytes`);
                return "";
            }

            // Import key
            const key = await crypto.subtle.importKey(
                "raw",
                keyBuffer,
                { name: "AES-CBC" },
                false,
                ["encrypt"]
            );

            // Prepare data
            const encoder = new TextEncoder();
            const data = encoder.encode(email);

            // Encrypt
            const encrypted = await crypto.subtle.encrypt(
                {
                    name: "AES-CBC",
                    iv: ivBuffer
                },
                key,
                data
            );

            // Convert to base64
            const encryptedBytes = new Uint8Array(encrypted);
            let binaryString = "";
            for (let i = 0; i < encryptedBytes.length; i++) {
                binaryString += String.fromCharCode(encryptedBytes[i]);
            }

            const base64Result = btoa(binaryString);

            // Verify it's valid base64
            try {
                atob(base64Result);
            } catch (e) {
                console.error("✗ Result is NOT valid base64:", e);
            }
            return base64Result;

        } catch (err) {
            return "";
        }
    }

    async function renderSignatureOnServer(user) {
        try {
            const encryptedMail = await encryptEmail(user)
            const res = await fetch("https://newqa-enterprise.cardbyte.ai/email-signature/html/outlook/get-active", {
                method: "GET",
                headers: {
                    "username": encryptedMail
                }
            });

            if (!res.ok) {
                throw new Error("Node renderer failed");
            }
            const data = await res?.text()
            const decryptedData = await handleAesDecrypt(data)
            return JSON.parse(decryptedData)?.html; // optional
        } catch (e) {
            console.error("error", e)
            return null;
        }
    }

    useEffect(() => {
        const encryptAndFetch = async () => {
            if (!user?.emailAddress) return;
            setLoad(true)
            try {
                const apiResponse = await renderSignatureOnServer(user?.emailAddress);
                setForm(prevForm => apiResponse ?? prevForm);
            } catch (e) {
                console.error(e)
                setError(e?.response?.data?.message)
            } finally {
                setLoad(false)
            }
        };

        encryptAndFetch();
    }, [user]);
    const cardbyte_logo = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAANwAAAA0CAYAAADhTVZuAAAACXBIWXMAAAsTAAALEwEAmpwYAAAGWGlUWHRYTUw6Y29tLmFkb2JlLnhtcAAAAAAAPD94cGFja2V0IGJlZ2luPSLvu78iIGlkPSJXNU0wTXBDZWhpSHpyZVN6TlRjemtjOWQiPz4gPHg6eG1wbWV0YSB4bWxuczp4PSJhZG9iZTpuczptZXRhLyIgeDp4bXB0az0iQWRvYmUgWE1QIENvcmUgNi4wLWMwMDIgNzkuMTY0NDg4LCAyMDIwLzA3LzEwLTIyOjA2OjUzICAgICAgICAiPiA8cmRmOlJERiB4bWxuczpyZGY9Imh0dHA6Ly93d3cudzMub3JnLzE5OTkvMDIvMjItcmRmLXN5bnRheC1ucyMiPiA8cmRmOkRlc2NyaXB0aW9uIHJkZjphYm91dD0iIiB4bWxuczp4bXA9Imh0dHA6Ly9ucy5hZG9iZS5jb20veGFwLzEuMC8iIHhtbG5zOnhtcE1NPSJodHRwOi8vbnMuYWRvYmUuY29tL3hhcC8xLjAvbW0vIiB4bWxuczpzdEV2dD0iaHR0cDovL25zLmFkb2JlLmNvbS94YXAvMS4wL3NUeXBlL1Jlc291cmNlRXZlbnQjIiB4bWxuczpwaG90b3Nob3A9Imh0dHA6Ly9ucy5hZG9iZS5jb20vcGhvdG9zaG9wLzEuMC8iIHhtbG5zOmRjPSJodHRwOi8vcHVybC5vcmcvZGMvZWxlbWVudHMvMS4xLyIgeG1wOkNyZWF0b3JUb29sPSJBZG9iZSBQaG90b3Nob3AgMjIuMCAoV2luZG93cykiIHhtcDpDcmVhdGVEYXRlPSIyMDIyLTAyLTI4VDE1OjEwOjUyKzA1OjMwIiB4bXA6TWV0YWRhdGFEYXRlPSIyMDIyLTAyLTI4VDE1OjEwOjUyKzA1OjMwIiB4bXA6TW9kaWZ5RGF0ZT0iMjAyMi0wMi0yOFQxNToxMDo1MiswNTozMCIgeG1wTU06SW5zdGFuY2VJRD0ieG1wLmlpZDo2M2NkMTQ1My1jNTA0LTQ5NDEtYWE2My1kNWYzOTRmZWUwODQiIHhtcE1NOkRvY3VtZW50SUQ9ImFkb2JlOmRvY2lkOnBob3Rvc2hvcDo0YTQ2NDE0NS1lYjJkLWZlNGQtOTg0MS02NGUwOGU0M2FiYTkiIHhtcE1NOk9yaWdpbmFsRG9jdW1lbnRJRD0ieG1wLmRpZDpmNTEyYmI2Ni05YjJjLThkNDQtYjQyZS1kNDdlMjA5ZDNlMzYiIHBob3Rvc2hvcDpDb2xvck1vZGU9IjMiIGRjOmZvcm1hdD0iaW1hZ2UvcG5nIj4gPHhtcE1NOkhpc3Rvcnk+IDxyZGY6U2VxPiA8cmRmOmxpIHN0RXZ0OmFjdGlvbj0iY3JlYXRlZCIgc3RFdnQ6aW5zdGFuY2VJRD0ieG1wLmlpZDo2M2NkMTQ1My1jNTA0LTQ5NDEtYWE2My1kNWYzOTRmZWUwODQiIHN0RXZ0OndoZW49IjIwMjItMDItMjhUMTU6MTA6NTIrMDU6MzAiIHN0RXZ0OnNvZnR3YXJlQWdlbnQ9IkFkb2JlIFBob3Rvc2hvcCAyMi4wIChXaW5kb3dzKSIvPiA8cmRmOmxpIHN0RXZ0OmFjdGlvbj0ic2F2ZWQiIHN0RXZ0Omluc3RhbmNlSUQ9InhtcC5paWQ6NjNjZDE0NTMtYzUwNC00OTQxLWFhNjMtZDVmMzk0ZmVlMDg0IiBzdEV2dDp3aGVuPSIyMDIyLTAyLTI4VDE1OjEwOjUyKzA1OjMwIiBzdEV2dDpzb2Z0d2FyZUFnZW50PSJBZG9iZSBQaG90b3Nob3AgMjIuMCAoV2luZG93cykiIHN0RXZ0OmNoYW5nZWQ9Ii8iLz4gPC9yZGY6U2VxPiA8L3htcE1NOkhpc3Rvcnk+IDxwaG90b3Nob3A6RG9jdW1lbnRBbmNlc3RvcnM+IDxyZGY6QmFnPiA8cmRmOmxpPnhtcC5kaWQ6MmJiNmVlZmUtYjkyNS1jZDRmLWIyYzctODc1M2I0ZDBjMTljPC9yZGY6bGk+IDwvcmRmOkJhZz4gPC9waG90b3Nob3A6RG9jdW1lbnRBbmNlc3RvcnM+IDwvcmRmOkRlc2NyaXB0aW9uPiA8L3JkZjpSREY+IDwveDp4bXBtZXRhPiA8P3hwYWNrZXQgZW5kPSJyIj8+TzjcNwAAE8hJREFUeNrtnQd8TVccx9OFlqLVodXSoXtXl+6B2qOlQ4cdJIQkhCRCpogROyFWErWJGKktS7ZMsWsVkYlGkCB+vb8jN17irby8IHn3//kcT+676713vuc/z7lmAE5LLV9pSjOxxn5vdrsb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";

    return (
        <Grid container justifyContent={'center'} rowGap={2}>
            <Grid
                size={{
                    xs: 11.5
                }}
            >
                <Box display={'flex'} alignItems={'center'} justifyContent={'start'}>
                    <Typography fontFamily="Raleway" color="#3b3535ff" fontSize={"12px"} fontWeight={'bold'}>
                        Welcome to
                    </Typography>
                    <img
                        src={cardbyte_logo}
                        width={150}
                        alt="cardbyte"
                    />
                </Box>
                <Typography fontFamily={'Plus Jakarta Sans'} color="#595959" fontSize={"12px"}>
                    This is the signature set up for you by your Organisation Administrator.
                    Click apply to add the signature to your mail.
                </Typography>
            </Grid>
            <Grid
                size={{
                    xs: 11,
                    lg: 4
                }}
            >
                {
                    load ?
                        <Paper
                            // elevation={5}
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
                            elevation={0}
                            sx={{
                                // p: 1,
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
                                form === null ?
                                    < Box
                                        display="flex"
                                        flexDirection="column"
                                        alignItems="center"
                                        justifyContent="center"
                                        mt={4}
                                    >
                                        <Box textAlign="center">
                                            <img src={!!error ? usernotfound : signnotassigned} alt="new" width={'100%'} />
                                            <Typography fontFamily={"Plus Jakarta Sans"} variant="h6" gutterBottom>
                                                {!!error ? error : "No Signature Assigned !"}
                                            </Typography>

                                            <Typography fontFamily={"Plus Jakarta Sans"} variant="body2" color="text.secondary">
                                                Please Contact Admin !
                                            </Typography>
                                        </Box>
                                    </Box>
                                    :
                                    <div
                                        style={{
                                            background: '#fff',
                                            border: '1px solid #e5e7eb',
                                            borderRadius: '8px',
                                            padding: '16px',
                                            display: 'inline-block',
                                            minWidth: '100%'
                                        }}
                                    >
                                        {/* Render simplified preview */}
                                        <div dangerouslySetInnerHTML={{ __html: form }} />

                                        <Stack
                                            mt={1}
                                            display={"flex"}
                                            direction="row" justifyContent={'center'} width={'100%'}
                                        >
                                            <Button
                                                onClick={() => applyHTML()}
                                                variant="outlined"
                                                size="small"
                                                sx={{
                                                    width: "180px",
                                                    height: "40px",
                                                    marginRight: "8px",
                                                    backgroundColor: "#0b2e79ff",
                                                    // border: "1.5px solid #0b2e79ff",
                                                    borderRadius: "13px",
                                                    fontSize: "13px",
                                                    fontFamily: "Plus Jakarta Sans",
                                                    textTransform: "capitalize",
                                                    color: "#fff",
                                                    "&:hover": {
                                                        color: "#fff",
                                                        borderColor: "#144CC9",
                                                        backgroundColor: "#506AA3",
                                                    },
                                                }}
                                            >
                                                Apply Signature
                                            </Button>
                                        </Stack>
                                    </div>
                            }
                        </Paper>
                }
            </Grid>
        </Grid>
    );
}