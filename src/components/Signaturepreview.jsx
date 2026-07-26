import { useCallback, useEffect, useRef, useState } from "react";
import { Box, Button } from "@mui/material";
import { Maximize2, Minimize2 } from "lucide-react";

/**
 * Renders email-signature HTML scaled to fit its container.
 *
 * Why the transform instead of overflow scrolling:
 *   Signature markup is built for a ~600px desktop mail body. The Outlook
 *   taskpane is ~300–350px, so laying it out at natural size clips it.
 *   `inner` is absolutely positioned at `width: max-content`, so it always
 *   reports its true natural size (a CSS transform never changes the layout
 *   box). We read that size, compute scale = available / natural, and give the
 *   wrapper the *scaled* dimensions so nothing overflows the card.
 *
 * Props
 *   html            signature markup
 *   minScale        floor for auto-fit; below this we keep the scale and let
 *                   the user scroll or switch to actual size (default 0.3)
 *   allowActualSize show the "Actual size" toggle when the signature is scaled
 */
export default function SignaturePreview({
    html,
    minScale = 0.3,
    allowActualSize = true,
    borderColor = "#e2e8f0",
    trackColor = "#f1f5f9",
    thumbColor = "#1e293b",
}) {
    const outerRef = useRef(null);
    const innerRef = useRef(null);

    const [{ scale, naturalW, naturalH }, setMetrics] = useState({
        scale: 1,
        naturalW: 0,
        naturalH: 0,
    });
    const [actualSize, setActualSize] = useState(false);

    const measure = useCallback(() => {
        const outer = outerRef.current;
        const inner = innerRef.current;
        if (!outer || !inner) return;

        const cs = window.getComputedStyle(outer);
        const padX =
            (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
        const available = Math.max(outer.clientWidth - padX, 1);

        const w = Math.max(inner.scrollWidth, 1);
        const h = Math.max(inner.scrollHeight, 1);

        const next = actualSize
            ? 1
            : Math.min(1, Math.max(minScale, available / w));

        setMetrics((prev) =>
            prev.scale === next && prev.naturalW === w && prev.naturalH === h
                ? prev // no-op keeps ResizeObserver from looping
                : { scale: next, naturalW: w, naturalH: h }
        );
    }, [actualSize, minScale]);

    useEffect(() => {
        measure();

        const outer = outerRef.current;
        const inner = innerRef.current;

        let ro;
        if (typeof ResizeObserver !== "undefined") {
            ro = new ResizeObserver(() => measure());
            if (outer) ro.observe(outer);
            if (inner) ro.observe(inner);
        }
        window.addEventListener("resize", measure);

        // Logos and banner images change the natural width once they decode.
        const imgs = inner ? Array.from(inner.querySelectorAll("img")) : [];
        const pending = imgs.filter((img) => !img.complete);
        pending.forEach((img) => {
            img.addEventListener("load", measure);
            img.addEventListener("error", measure);
        });

        // Catch late web fonts / slow CDN images in the Outlook webview.
        const t = setTimeout(measure, 400);

        return () => {
            if (ro) ro.disconnect();
            window.removeEventListener("resize", measure);
            pending.forEach((img) => {
                img.removeEventListener("load", measure);
                img.removeEventListener("error", measure);
            });
            clearTimeout(t);
        };
    }, [measure, html]);

    const isScaled = naturalW > 0 && scale < 1;
    const showToggle = allowActualSize && (isScaled || actualSize);

    return (
        <Box>
            {showToggle && (
                <Box sx={{ display: "flex", justifyContent: "flex-end", mb: 0.5 }}>
                    <Button
                        size="small"
                        onClick={() => setActualSize((v) => !v)}
                        startIcon={
                            actualSize ? <Minimize2 size={11} /> : <Maximize2 size={11} />
                        }
                        sx={{
                            fontSize: "10px",
                            fontFamily: "Plus Jakarta Sans",
                            textTransform: "none",
                            color: "#94a3b8",
                            minWidth: 0,
                            py: 0.15,
                            px: 0.75,
                            "& .MuiButton-startIcon": { mr: 0.4 },
                            "&:hover": { color: thumbColor, background: "transparent" },
                        }}
                    >
                        {actualSize
                            ? "Fit to width"
                            : `Actual size · ${Math.round(scale * 100)}%`}
                    </Button>
                </Box>
            )}

            <Box
                ref={outerRef}
                sx={{
                    overflowX: actualSize ? "auto" : "hidden",
                    overflowY: "hidden",
                    WebkitOverflowScrolling: "touch",
                    background: "#fff",
                    borderRadius: "6px",
                    border: `1px solid ${borderColor}`,
                    p: 0.75,
                    "&::-webkit-scrollbar": { height: 5 },
                    "&::-webkit-scrollbar-track": {
                        background: trackColor,
                        borderRadius: 99,
                    },
                    "&::-webkit-scrollbar-thumb": {
                        background: thumbColor,
                        borderRadius: 99,
                    },
                }}
            >
                {/* Occupies the SCALED box, so the card never overflows */}
                <Box
                    sx={{
                        position: "relative",
                        width: naturalW ? naturalW * scale : "100%",
                        height: naturalH ? naturalH * scale : 60,
                        overflow: "hidden",
                    }}
                >
                    {/* Out of flow + max-content => always measures at natural size */}
                    <Box
                        ref={innerRef}
                        dangerouslySetInnerHTML={{ __html: html }}
                        sx={{
                            position: "absolute",
                            top: 0,
                            left: 0,
                            width: "max-content",
                            maxWidth: "none",
                            transform: `scale(${scale})`,
                            transformOrigin: "top left",
                            pointerEvents: "none", // links shouldn't navigate the taskpane
                            "& img": { maxWidth: "none" },
                            "& table": { borderCollapse: "collapse" },
                        }}
                    />
                </Box>
            </Box>
        </Box>
    );
}