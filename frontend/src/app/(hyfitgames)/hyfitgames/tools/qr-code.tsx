"use client";

import { useCallback, useRef } from "react";
import { QRCodeCanvas, QRCodeSVG } from "qrcode.react";

export type EcLevel = "L" | "M" | "Q" | "H";

// Byte-mode capacity of a version-40 symbol at each error-correction level.
// The encoder picks the smallest version that fits, so these are the ceilings
// past which nothing can be encoded at all — over them, qrcode.react throws
// mid-render, which in a client component takes the whole page down. Every
// caller checks `fitsInQr` before mounting a code for that reason.
//
// Conservative by design: a purely numeric or uppercase-alphanumeric payload
// gets a denser mode and would fit more than this. Payloads here are JSON and
// URLs, which are neither.
export const QR_BYTE_CAPACITY: Record<EcLevel, number> = {
    L: 2953,
    M: 2331,
    Q: 1663,
    H: 1273,
};

export const EC_LABELS: Record<EcLevel, string> = {
    L: "L — 7% recovery, densest",
    M: "M — 15% recovery",
    Q: "Q — 25% recovery",
    H: "H — 30% recovery, most robust",
};

export const byteLength = (value: string) => new TextEncoder().encode(value).length;

export const fitsInQr = (value: string, level: EcLevel) =>
    byteLength(value) <= QR_BYTE_CAPACITY[level];

/* A QR code, plus the off-screen canvas that backs the PNG download.
 *
 * Painted black-on-white in both themes and always sitting on its own white
 * plate. A QR inverted for dark mode is technically still decodable, but phone
 * scanners are tuned for dark-on-light and a lot of them simply give up — not
 * worth the aesthetic on a screen someone is trying to scan across a room.
 *
 * `marginSize` is the 4 modules ISO/IEC 18004 requires as the quiet zone, not a
 * smaller number that frames more tidily. The white plate around it is not a
 * substitute — a scanner measures the quiet zone in modules, and the plate is
 * padding in CSS pixels that shrinks in module terms as the payload grows.
 *
 * The SVG is what renders; the canvas exists only so `toDataURL` has something
 * to read. Drawing both is cheaper than mounting a canvas on demand and waiting
 * a frame for it to paint before the download can start. */
export function QrCode({
    value,
    level = "M",
    size = 256,
    downloadName,
    caption,
}: {
    value: string;
    level?: EcLevel;
    size?: number;
    /** Filename for the PNG download. Omit to hide the download button. */
    downloadName?: string;
    caption?: string;
}) {
    const canvasWrap = useRef<HTMLDivElement>(null);

    const download = useCallback(() => {
        const canvas = canvasWrap.current?.querySelector("canvas");
        if (!canvas || !downloadName) return;
        const a = document.createElement("a");
        a.href = canvas.toDataURL("image/png");
        a.download = downloadName.endsWith(".png") ? downloadName : `${downloadName}.png`;
        a.click();
    }, [downloadName]);

    return (
        <div className="flex flex-col items-center gap-3">
            <div className="rounded-2xl bg-white p-4 shadow-sm">
                <QRCodeSVG
                    value={value}
                    size={size}
                    level={level}
                    marginSize={4}
                    bgColor="#ffffff"
                    fgColor="#000000"
                />
            </div>
            {caption && <p className="max-w-xs text-center text-xs text-fog">{caption}</p>}
            {downloadName && (
                <>
                    {/* Rendered at 4x for a print-usable PNG, and kept out of
                        the layout — `hidden` would stop it painting, and an
                        unpainted canvas exports blank. */}
                    <div ref={canvasWrap} aria-hidden className="pointer-events-none absolute -left-[9999px] top-0">
                        <QRCodeCanvas
                            value={value}
                            size={size * 4}
                            level={level}
                            marginSize={4}
                            bgColor="#ffffff"
                            fgColor="#000000"
                        />
                    </div>
                    <button
                        type="button"
                        onClick={download}
                        className="rounded-lg border border-smoke px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-fog transition-colors hover:text-chalk"
                    >
                        Download PNG
                    </button>
                </>
            )}
        </div>
    );
}
