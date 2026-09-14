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

export function pairingMacName(hostname: string): string {
  const host = hostname.trim().replace(/\.$/u, "").toLowerCase();
  // An IP address is not a machine name. Splitting it produced "Connect to 127"
  // for loopback previews, and similarly misleading names for private IPv4/IPv6.
  if (!host || host === "localhost" || host.endsWith(".localhost")
    || host.includes(":") || /^\d+(?:\.\d+){3}$/u.test(host)) return "your Mac";
  const firstLabel = host.split(".")[0]?.replace(/[-_]+/gu, " ").trim();
  return firstLabel ? firstLabel.replace(/\b\w/gu, (character) => character.toUpperCase()) : "your Mac";
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
  const [cameraPending, setCameraPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [standalone] = useState(isStandaloneWebApp);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const scannerGenerationRef = useRef(0);
  const cameraRequestRef = useRef(false);
  const scanTimerRef = useRef<number | null>(null);
  const installing = invitation?.source === "fragment" && !standalone;
  const displayMacName = useMemo(() => pairingMacName(window.location.hostname), []);

  const stopScanner = useCallback(() => {
    // Invalidate permission/playback/decode promises before releasing the stream.
    scannerGenerationRef.current += 1;
    cameraRequestRef.current = false;
    setCameraPending(false);
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

  const scanVideo = useCallback(async (generation: number) => {
    const video = videoRef.current;
    if (generation !== scannerGenerationRef.current || !streamRef.current) return;
    if (!video || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      scanTimerRef.current = window.setTimeout(() => void scanVideo(generation), 180);
      return;
    }
    try {
      const value = await qrFromImage(video, video.videoWidth, video.videoHeight);
      if (generation !== scannerGenerationRef.current || !streamRef.current) return;
      if (!value || !acceptScannedValue(value)) {
        scanTimerRef.current = window.setTimeout(() => void scanVideo(generation), 180);
      }
    } catch {
      if (generation !== scannerGenerationRef.current) return;
      stopScanner();
      setMessage("The camera preview could not be read. Use Camera or Photos below.");
    }
  }, [acceptScannedValue, stopScanner]);

  async function beginScanner() {
    if (cameraRequestRef.current || streamRef.current) return;
    setMessage(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      setMessage("Camera access is unavailable here. Use Camera or Photos below.");
      return;
    }
    const generation = ++scannerGenerationRef.current;
    cameraRequestRef.current = true;
    setCameraPending(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1_280 }, height: { ideal: 720 } },
      });
      if (generation !== scannerGenerationRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;
      cameraRequestRef.current = false;
      setCameraPending(false);
      setScanning(true);
      const video = videoRef.current;
      if (!video) { stopScanner(); return; }
      video.srcObject = stream;
      await video.play();
      if (generation !== scannerGenerationRef.current) return;
      void scanVideo(generation);
    } catch {
      if (generation !== scannerGenerationRef.current) return;
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
    } catch {
      setMessage("Could not connect to your Mac. Check the private connection and try again.");
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
            <p className="eyebrow">Private connection</p>
            <h1 id="pairing-title">Connect to {displayMacName}</h1>
            <p className="pairing-intro">Connect once to access your Codex tasks from this device. You can disconnect at any time in Settings.</p>
            {message && <p className="form-error" role="alert">{message}</p>}
            <button className="pair-button" type="button" disabled={pending} onClick={() => void connect()}>
              {pending ? "Connecting…" : "Connect"}
            </button>
            <p className="pairing-footnote">No separate account needed. Nerva remembers this Mac.</p>
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
              <button className="pair-button" type="button" disabled={scanning || cameraPending} onClick={() => void beginScanner()}>{cameraPending ? "Starting camera…" : scanning ? "Scanning…" : "Scan QR"}</button>
              {(scanning || cameraPending) && <button className="pairing-secondary" type="button" onClick={stopScanner}>Cancel</button>}
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
