"use client";

import { useEffect, useRef, useState } from "react";

export default function SignaturePad({ onChange }: { onChange: (file: File | null) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const [hasInk, setHasInk] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const ratio = window.devicePixelRatio || 1;
      canvas.width = Math.round(rect.width * ratio);
      canvas.height = Math.round(rect.height * ratio);
      const context = canvas.getContext("2d");
      if (context) {
        context.scale(ratio, ratio);
        context.lineWidth = 4;
        context.lineCap = "round";
        context.strokeStyle = "#101512";
      }
    };
    resize();
  }, []);

  function point(event: React.PointerEvent<HTMLCanvasElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }
  function start(event: React.PointerEvent<HTMLCanvasElement>) {
    drawing.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
    const context = event.currentTarget.getContext("2d");
    const current = point(event);
    context?.beginPath();
    context?.moveTo(current.x, current.y);
  }
  function move(event: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return;
    const current = point(event);
    const context = event.currentTarget.getContext("2d");
    context?.lineTo(current.x, current.y);
    context?.stroke();
    setHasInk(true);
  }
  function finish() {
    drawing.current = false;
    const canvas = canvasRef.current;
    if (!canvas || !hasInk) return;
    canvas.toBlob((blob) => onChange(blob ? new File([blob], "signature.png", { type: "image/png" }) : null), "image/png");
  }
  function clear() {
    const canvas = canvasRef.current;
    if (canvas) canvas.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
    setHasInk(false);
    onChange(null);
  }
  return <div className="signature-wrap">
    <canvas ref={canvasRef} onPointerDown={start} onPointerMove={move} onPointerUp={finish} onPointerCancel={finish} aria-label="Participant signature pad"/>
    <button type="button" onClick={clear}>Clear signature</button>
  </div>;
}
