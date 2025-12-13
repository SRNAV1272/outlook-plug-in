import React from "react";
// import { getHeight, getWidth } from "./validations";

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