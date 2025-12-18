{backgroundImage && (
                                                            <KonvaImage
                                                                image={backgroundImage}
                                                                x={x}
                                                                y={y}
                                                                width={w}
                                                                height={h}
                                                                listening={false}
                                                            />
                                                        )
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
                                                                text={form?.elements?.find(f => f.key === "disclaimer")?.value}
                                                                fontSize={12} // adjust font size if needed
                                                                fontFamily="Plus Jakarta Sans"
                                                                fontStyle="normal"
                                                                fill="#555555"
                                                                width={baseWidth}
                                                                align="center"
                                                                listening={false}
                                                            />
                                                        )}