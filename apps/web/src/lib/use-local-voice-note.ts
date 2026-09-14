import { useCallback, useEffect, useRef, useState } from "react";

export type VoiceNotePhase = "idle" | "requesting" | "recording" | "stopping";
interface Capture {
  stop: () => Promise<Blob | null>;
  discard: () => void;
}
const MAX_RECORDING_MS = 3 * 60 * 1_000;
const STOP_TIMEOUT_MS = 5_000;
const RECOVERY = "The voice note could not be recorded. Try again or type the explanation instead.";

/** Local-only microphone ownership, bounded to one visible checkpoint. No upload. */
export function useLocalVoiceNote({ active, scope }: { active: boolean; scope: string }) {
  const [phase, setPhase] = useState<VoiceNotePhase>("idle");
  const [blob, setBlob] = useState<Blob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const blobRef = useRef<Blob | null>(null);
  const captureRef = useRef<Capture | null>(null);
  const generationRef = useRef(0);
  const requestingRef = useRef(false);
  const contextRef = useRef({ active, scope });
  contextRef.current = { active, scope };

  const release = useCallback(() => {
    generationRef.current += 1;
    requestingRef.current = false;
    const capture = captureRef.current;
    captureRef.current = null;
    capture?.discard();
    setPhase("idle");
  }, []);
  const cancel = useCallback(() => {
    release();
    blobRef.current = null;
    setBlob(null);
    setError(null);
  }, [release]);
  const stop = useCallback(async (): Promise<Blob | null> => {
    // Cancel an unanswered permission request without destroying a previous note.
    if (requestingRef.current) { release(); return blobRef.current; }
    if (captureRef.current) return captureRef.current.stop();
    return blobRef.current;
  }, [release]);

  useEffect(() => {
    if (!active) cancel();
    return cancel;
  }, [active, scope, cancel]);
  useEffect(() => {
    const stopWhenHidden = () => { if (document.hidden) void stop(); };
    const stopOnPageHide = () => { void stop(); };
    document.addEventListener("visibilitychange", stopWhenHidden);
    window.addEventListener("pagehide", stopOnPageHide);
    return () => {
      document.removeEventListener("visibilitychange", stopWhenHidden);
      window.removeEventListener("pagehide", stopOnPageHide);
    };
  }, [stop]);

  const start = useCallback(async () => {
    if (!contextRef.current.active || requestingRef.current || captureRef.current) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setError("Microphone recording is unavailable here. Type the explanation instead.");
      return;
    }
    const context = contextRef.current;
    const generation = ++generationRef.current;
    const ownsContext = () => generation === generationRef.current
      && contextRef.current.active && contextRef.current.scope === context.scope;
    requestingRef.current = true;
    setPhase("requesting");
    setError(null);
    let stream: MediaStream | null = null;
    let tracksReleased = false;
    const releaseTracks = () => {
      if (tracksReleased) return;
      tracksReleased = true;
      stream?.getTracks().forEach((track) => track.stop());
    };
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!ownsContext()) { releaseTracks(); return; }
      const recorder = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      let settled = false;
      let stopping = false;
      let timer: number | null = null;
      let watchdog: number | null = null;
      let resolve!: (value: Blob | null) => void;
      const completion = new Promise<Blob | null>((accept) => { resolve = accept; });
      const finish = (keep: boolean, message?: string) => {
        if (settled) return;
        settled = true;
        if (timer !== null) window.clearTimeout(timer);
        if (watchdog !== null) window.clearTimeout(watchdog);
        recorder.removeEventListener("dataavailable", onData);
        recorder.removeEventListener("stop", onStop);
        recorder.removeEventListener("error", onError);
        try { if (recorder.state !== "inactive") recorder.stop(); } catch { /* Tracks still release below. */ }
        releaseTracks();
        const captured = keep && chunks.length > 0
          ? new Blob(chunks, { type: recorder.mimeType || "audio/mp4" }) : null;
        if (ownsContext()) {
          captureRef.current = null;
          requestingRef.current = false;
          setPhase("idle");
          if (captured) { blobRef.current = captured; setBlob(captured); }
          if (message) setError(message);
        }
        resolve(captured);
      };
      const onData = (event: BlobEvent) => { if (!settled && event.data.size > 0) chunks.push(event.data); };
      const onStop = () => finish(true, chunks.length === 0 ? RECOVERY : undefined);
      const onError = () => finish(false, RECOVERY);
      const capture: Capture = {
        stop: () => {
          if (stopping || settled) return completion;
          stopping = true;
          if (ownsContext()) setPhase("stopping");
          // MediaRecorder queues final dataavailable before stop. Release the
          // physical input immediately, but await that final chunk before Save.
          watchdog = window.setTimeout(() => finish(false, RECOVERY), STOP_TIMEOUT_MS);
          try { if (recorder.state !== "inactive") recorder.stop(); }
          catch { finish(false, RECOVERY); }
          releaseTracks();
          return completion;
        },
        discard: () => finish(false),
      };
      recorder.addEventListener("dataavailable", onData);
      recorder.addEventListener("stop", onStop);
      recorder.addEventListener("error", onError);
      captureRef.current = capture;
      recorder.start();
      if (captureRef.current !== capture) return;
      requestingRef.current = false;
      blobRef.current = null;
      setBlob(null);
      setPhase("recording");
      timer = window.setTimeout(() => { void capture.stop(); }, MAX_RECORDING_MS);
    } catch {
      if (ownsContext()) {
        captureRef.current?.discard();
        captureRef.current = null;
        requestingRef.current = false;
        setPhase("idle");
        setError("Microphone access was not granted or recording could not start. Type the explanation instead.");
      }
      releaseTracks();
    }
  }, []);

  return { phase, blob, error, start, stop, cancel };
}
