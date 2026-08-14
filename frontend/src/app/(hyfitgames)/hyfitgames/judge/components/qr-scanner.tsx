"use client";

import { BrowserQRCodeReader, type IScannerControls } from "@zxing/browser";
import { useEffect, useRef, useState } from "react";

type QrScannerProps = {
  onClose: () => void;
  onScan: (value: string) => string | null | Promise<string | null>;
};

function cameraErrorMessage(error: unknown) {
  const name = error instanceof DOMException ? error.name : "";
  const policy = document as Document & {
    permissionsPolicy?: { allowsFeature: (feature: string) => boolean };
    featurePolicy?: { allowsFeature: (feature: string) => boolean };
  };
  const cameraAllowedByPolicy =
    policy.permissionsPolicy?.allowsFeature("camera") ??
    policy.featurePolicy?.allowsFeature("camera") ??
    true;

  if (!cameraAllowedByPolicy) return "Camera access is blocked by this site’s security policy. Reload the page, then try again.";
  if (name === "NotAllowedError" || name === "SecurityError") return "Camera permission is blocked. Allow camera access for this site in browser settings, reload the page, then try again.";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "No usable camera was found on this device.";
  if (name === "NotReadableError" || name === "AbortError") return "The camera is already in use or could not be started. Close other camera apps and browser tabs, then try again.";
  if (!window.isSecureContext) return "Camera scanning requires HTTPS or localhost. Use manual BIB search on this connection.";
  return "The camera could not start. Close this window and try again, or search by BIB manually.";
}

export default function QrScanner({ onClose, onScan }: QrScannerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const controlsRef = useRef<IScannerControls | null>(null);
  const scanLockedRef = useRef(false);
  const retryTimerRef = useRef<number | null>(null);
  const [message, setMessage] = useState("Point the camera at the numeric BIB QR code.");
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    const reader = new BrowserQRCodeReader(undefined, { delayBetweenScanAttempts: 250 });

    async function start() {
      if (!window.isSecureContext) {
        setFailed(true);
        setMessage("Camera scanning requires HTTPS or localhost. Search by BIB manually on this connection.");
        return;
      }
      if (!navigator.mediaDevices?.getUserMedia) {
        setFailed(true);
        setMessage("This browser cannot access a camera. Search by BIB manually.");
        return;
      }

      try {
        const onResult = (result: Parameters<Parameters<typeof reader.decodeFromConstraints>[2]>[0]) => {
          if (!active || !result || scanLockedRef.current) return;
          scanLockedRef.current = true;
          void Promise.resolve(onScan(result.getText())).then((scanError) => {
            if (!active) return;
            if (!scanError) {
              controlsRef.current?.stop();
              return;
            }
            setFailed(true);
            setMessage(scanError);
            retryTimerRef.current = window.setTimeout(() => {
              scanLockedRef.current = false;
              setFailed(false);
              setMessage("Ready to scan again.");
            }, 1600);
          });
        };
        let controls: IScannerControls;
        try {
          controls = await reader.decodeFromConstraints(
            { video: { facingMode: { ideal: "environment" } }, audio: false },
            videoRef.current ?? undefined,
            onResult,
          );
        } catch (preferredCameraError) {
          const name = preferredCameraError instanceof DOMException ? preferredCameraError.name : "";
          if (!active || !["NotFoundError", "OverconstrainedError"].includes(name)) throw preferredCameraError;
          controls = await reader.decodeFromConstraints(
            { video: true, audio: false },
            videoRef.current ?? undefined,
            onResult,
          );
        }
        if (!active) {
          controls.stop();
          return;
        }
        controlsRef.current = controls;
      } catch (error) {
        if (!active) return;
        setFailed(true);
        setMessage(cameraErrorMessage(error));
      }
    }

    void start();
    return () => {
      active = false;
      controlsRef.current?.stop();
      BrowserQRCodeReader.releaseAllStreams();
      if (retryTimerRef.current !== null) window.clearTimeout(retryTimerRef.current);
    };
  }, [onScan]);

  return (
    <div className="modal-backdrop qr-backdrop" onClick={onClose}>
      <section className="qr-modal" role="dialog" aria-modal="true" aria-labelledby="qr-title" onClick={(event) => event.stopPropagation()}>
        <button className="modal-close" aria-label="Close QR scanner" onClick={onClose}>×</button>
        <div className="qr-heading">
          <span className="qr-icon" aria-hidden="true">▦</span>
          <div><div className="eyebrow">WRISTBAND SCANNER</div><h3 id="qr-title">Scan athlete BIB</h3></div>
        </div>
        <div className="qr-camera">
          <video ref={videoRef} autoPlay muted playsInline aria-label="Camera preview" />
          <div className="qr-frame" aria-hidden="true"><i/><i/><i/><i/></div>
        </div>
        <p className={`qr-message ${failed ? "error" : ""}`} aria-live="polite">{message}</p>
        <button className="qr-manual" onClick={onClose}>Close scanner &amp; enter BIB manually</button>
        <small>Only numeric QR codes are accepted. Camera video stays on this device.</small>
      </section>
    </div>
  );
}
