import jsQR from "jsqr";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PairResult } from "../lib/model";
import { CameraIcon, CheckIcon, LinkIcon } from "./Icons";

interface PairingScreenProps {
  readonly onPair: (nonce: string, deviceName: string) => Promise<PairResult>;
}

interface PairingInvitation {
  readonly nonce: string;
  readonly source: "fragment" | "legacy-query";
}

function isStandaloneWebApp(): boolean {
  const navigatorWithStandalone = navigator as Navigator & { readonly standalone?: boolean };
  return navigatorWithStandalone.standalone === true
    || (typeof window.matchMedia === "function" && window.matchMedia("(display-mode: standalone)").matches);
}

function automaticDeviceName(): string {
  return /iPad/u.test(navigator.userAgent) ? "iPad — Nerva" : "Nerva — Touch device";
}

function macName(): string {
  const firstLabel = window.location.hostname.split(".")[0]?.replace(/[-_]+/gu, " ").trim();
  if (!firstLabel || ["localhost", "127 0 0 1"].includes(firstLabel.toLowerCase())) return "your Mac";
  return firstLabel.replace(/\b\w/gu, (character) => character.toUpperCase());
}

export function pairingInvitationFromUrl(value: string): PairingInvitation | null {
  try {
    const url = new URL(value, window.location.href);
    if (url.origin !== window.location.origin) return null;
    const fragment = new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);
    const fragmentNonce = fragment.get("pair");
    if (fragmentNonce && fragment.size === 1) return { nonce: fragmentNonce, source: "fragment" };
    const legacyNonce = url.searchParams.get("nonce");
    return legacyNonce ? { nonce: legacyNonce, source: "legacy-query" } : null;
  } catch {
    return null;
  }
}

async function qrFromImage(source: CanvasImageSource, width: number, height: number): Promise<string | null> {
  const maximum = 1_200;
  const scale = Math.min(1, maximum / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  const frame = context.getImageData(0, 0, canvas.width, canvas.height);
  return jsQR(frame.data, frame.width, frame.height, { inversionAttempts: "attemptBoth" })?.data ?? null;
}

export function PairingScreen({ onPair }: PairingScreenProps) {
  const [invitation, setInvitation] = useState<PairingInvitation | null>(() => pairingInvitationFromUrl(window.location.href));
  const [pending, setPending] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [standalone] = useState(isStandaloneWebApp);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const scanTimerRef = useRef<number | null>(null);
  const installing = invitation?.source === "fragment" && !standalone;
  const displayMacName = useMemo(macName, []);

  const stopScanner = useCallback(() => {
    if (scanTimerRef.current !== null) window.clearTimeout(scanTimerRef.current);
    scanTimerRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setScanning(false);
  }, []);

  useEffect(() => stopScanner, [stopScanner]);

  const acceptScannedValue = useCallback((value: string): boolean => {
    const parsed = pairingInvitationFromUrl(value);
    if (!parsed) {
      setMessage("This QR is not a Nerva invitation for this Mac.");
      return false;
    }
    setInvitation(parsed);
    setMessage(null);
    stopScanner();
    return true;
  }, [stopScanner]);

  const scanVideo = useCallback(async () => {
    const video = videoRef.current;
    if (!streamRef.current) return;
    if (!video || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      scanTimerRef.current = window.setTimeout(() => void scanVideo(), 180);
      return;
    }
    const value = await qrFromImage(video, video.videoWidth, video.videoHeight);
    if (!value || !acceptScannedValue(value)) {
      scanTimerRef.current = window.setTimeout(() => void scanVideo(), 180);
    }
  }, [acceptScannedValue]);

  async function beginScanner() {
    if (scanning) return;
    setMessage(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      setMessage("Camera access is unavailable here. Use Camera or Photos below.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1_280 }, height: { ideal: 720 } },
      });
      streamRef.current = stream;
      setScanning(true);
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      void scanVideo();
    } catch {
      stopScanner();
      setMessage("Camera access was not granted. Use Camera or Photos below.");
    }
  }

  async function decodeFile(file: File | undefined) {
    if (!file) return;
    setMessage(null);
    try {
      const bitmap = await createImageBitmap(file);
      try {
        const value = await qrFromImage(bitmap, bitmap.width, bitmap.height);
        if (!value) setMessage("No QR code was found in this image.");
        else acceptScannedValue(value);
      } finally {
        bitmap.close();
      }
    } catch {
      setMessage("This image could not be read.");
    }
  }

  async function connect() {
    if (!invitation || pending) return;
    setPending(true);
    setMessage(null);
    try {
      const result = await onPair(invitation.nonce, automaticDeviceName());
      if (!result.ok) setMessage(result.message.replace(/code/giu, "invitation"));
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="pairing-page">
      <section className="pairing-sheet" aria-labelledby="pairing-title">
        <div className="brand-lockup pairing-brand" aria-label="Nerva">
          <span className="brand-grid" aria-hidden="true">{Array.from({ length: 6 }, (_, index) => <i key={index} />)}</span>
          <span>Nerva</span>
        </div>

        {installing ? (
          <>
            <span className="pairing-icon" aria-hidden="true"><CheckIcon /></span>
            <p className="eyebrow">One quick install</p>
            <h1 id="pairing-title">Add Nerva to Home Screen</h1>
            <p className="pairing-intro">This keeps the private connection separate from Safari and makes Nerva feel like an iPad app.</p>
            <ol className="pairing-steps">
              <li><span>1</span><p>Tap Safari’s <strong>Share</strong> button.</p></li>
              <li><span>2</span><p>Choose <strong>Add to Home Screen</strong> and keep <strong>Open as Web App</strong> enabled.</p></li>
              <li><span>3</span><p>Open Nerva. If asked, scan the same QR once more inside the app.</p></li>
            </ol>
            <p className="pairing-footnote">The invitation remains one-time and private. Nothing is connected from this Safari page.</p>
          </>
        ) : invitation ? (
          <>
            <span className="pairing-icon" aria-hidden="true"><LinkIcon /></span>
            <p className="eyebrow">Private tailnet connection</p>
            <h1 id="pairing-title">Connect to {displayMacName}</h1>
            <p className="pairing-intro">Nerva will receive a revocable credential for this app only. The invitation disappears after it is used.</p>
            {message && <p className="form-error" role="alert">{message}</p>}
            <button className="pair-button" type="button" disabled={pending} onClick={() => void connect()}>
              {pending ? "Connecting…" : "Connect"}
            </button>
            <p className="pairing-footnote">No Nerva account, password, device name, or daily QR is required.</p>
          </>
        ) : (
          <>
            <span className="pairing-icon" aria-hidden="true"><CameraIcon /></span>
            <p className="eyebrow">Already installed</p>
            <h1 id="pairing-title">Scan the QR on your Mac</h1>
            <p className="pairing-intro">Run <code>npm run pair</code> in the Nerva repository, then point this iPad at the QR.</p>
            <div className={`pairing-scanner${scanning ? " is-active" : ""}`}>
              <video ref={videoRef} muted playsInline aria-label="Nerva QR scanner camera" />
              {scanning && <span aria-hidden="true" />}
            </div>
            {message && <p className="form-error" role="alert">{message}</p>}
            <div className="pairing-actions">
              <button className="pair-button" type="button" disabled={scanning} onClick={() => void beginScanner()}>{scanning ? "Scanning…" : "Scan QR"}</button>
              {scanning && <button className="pairing-secondary" type="button" onClick={stopScanner}>Cancel</button>}
              <label className="pairing-secondary pairing-file">
                <span>Use Camera or Photos</span>
                <input type="file" accept="image/*" capture="environment" onChange={(event) => void decodeFile(event.target.files?.[0])} />
              </label>
            </div>
            <p className="pairing-footnote">The QR expires after five minutes and works once. Nerva checks that it belongs to this exact Mac origin.</p>
          </>
        )}
      </section>
    </main>
  );
}
