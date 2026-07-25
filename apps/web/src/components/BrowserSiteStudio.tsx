import {
  SiteQaManifestSchema,
  type SiteQaRecordedAction,
} from "@codex-pad/protocol";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import type {
  BrowserTabControl,
  BrowserTabFrame,
  OpenBrowserTab,
  RecordedBrowserTabControlResult,
} from "../lib/bridge-client";
import {
  deleteSiteQaDraft,
  findSiteQaDraft,
  saveSiteQaDraft,
  type SiteQaDraftIssue,
  type SiteQaEvidenceFrame,
  type SiteQaRecordingDraft,
} from "../lib/site-qa-recorder-store";
import type { SiteQaManifestStep, SiteQaSendPayload, SiteQaSendResult } from "../lib/site-qa-types";
import type { SiteFavorite } from "../lib/storage";
import { createUuidV4 } from "../lib/uuid";
import { ChevronIcon, GlobeIcon, PencilIcon } from "./Icons";
import { normalizeSiteAddress } from "./SiteHubPage";

interface Point { readonly x: number; readonly y: number; readonly pressure: number }
interface Stroke { readonly color: string; readonly width: number; readonly points: readonly Point[] }
interface BrowseGesture { readonly pointerId: number; readonly startX: number; readonly startY: number; readonly x: number; readonly y: number }

interface BrowserSiteStudioProps {
  readonly tab: OpenBrowserTab;
  readonly threadId: string;
  readonly sendEnabled: boolean;
  readonly favorites: readonly SiteFavorite[];
  readonly fetchFrame: (threadId: string, tabId: string) => Promise<BrowserTabFrame>;
  readonly controlTab: (threadId: string, tabId: string, action: BrowserTabControl) => Promise<BrowserTabFrame>;
  readonly recordTabAction: (threadId: string, tabId: string, action: SiteQaRecordedAction) => Promise<RecordedBrowserTabControlResult>;
  readonly onSendAnnotation: (png: Blob) => Promise<{ readonly ok: boolean; readonly message?: string }>;
  readonly onSendRecording: (payload: SiteQaSendPayload) => Promise<SiteQaSendResult>;
  readonly onToggleFavorite: (url: string, title: string) => void;
  readonly onOpenSites: () => void;
}

const INK_COLORS = ["#ff5b45", "#ffb020", "#2f80ff", "#13b77a", "#f4f7fb"] as const;
const MAX_EVIDENCE_FRAMES = 24;

function frameSource(frame: BrowserTabFrame): string { return `data:${frame.mimeType};base64,${frame.imageBase64}`; }
function displayHost(url: string): string {
  try { const parsed = new URL(url); return `${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}${parsed.pathname === "/" ? "" : parsed.pathname}`; }
  catch { return url; }
}
function drawStroke(context: CanvasRenderingContext2D, stroke: Stroke): void {
  if (stroke.points.length === 0) return;
  context.save(); context.lineCap = "round"; context.lineJoin = "round"; context.strokeStyle = stroke.color; context.lineWidth = stroke.width;
  context.beginPath(); const first = stroke.points[0]!; context.moveTo(first.x, first.y);
  for (const point of stroke.points.slice(1)) context.lineTo(point.x, point.y);
  if (stroke.points.length === 1) context.lineTo(first.x + .01, first.y + .01);
  context.stroke(); context.restore();
}
async function imageForFrame(frame: BrowserTabFrame): Promise<HTMLImageElement> {
  const image = new Image(); image.decoding = "async"; image.src = frameSource(frame); await image.decode(); return image;
}
function rawBase64Blob(base64: string, mediaType: string): Blob {
  const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
  return new Blob([bytes], { type: mediaType });
}
async function blobBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer()); let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}
function elapsedLabel(milliseconds: number): string {
  const total = Math.max(0, Math.floor(milliseconds / 1_000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export function BrowserSiteStudio({
  tab, threadId, sendEnabled, favorites, fetchFrame, controlTab, recordTabAction,
  onSendAnnotation, onSendRecording, onToggleFavorite, onOpenSites,
}: BrowserSiteStudioProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const baseImageRef = useRef<HTMLImageElement | null>(null);
  const requestActiveRef = useRef(false);
  const annotatingRef = useRef(false);
  const browseGestureRef = useRef<BrowseGesture | null>(null);
  const activeStrokeRef = useRef<{ readonly pointerId: number; stroke: Stroke } | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const voiceChunksRef = useRef<Blob[]>([]);
  const voiceTimerRef = useRef<number | null>(null);
  const [frame, setFrame] = useState<BrowserTabFrame | null>(null);
  const [strokes, setStrokes] = useState<readonly Stroke[]>([]);
  const [annotationKind, setAnnotationKind] = useState<"none" | "simple" | "issue">("none");
  const [touchDraws, setTouchDraws] = useState(false);
  const [inkColor, setInkColor] = useState<string>(INK_COLORS[0]);
  const [inkWidth, setInkWidth] = useState(7);
  const [busy, setBusy] = useState(false);
  const [typing, setTyping] = useState(false);
  const [typedText, setTypedText] = useState("");
  const [address, setAddress] = useState(tab.url);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [draft, setDraft] = useState<SiteQaRecordingDraft | null>(null);
  const [resumableDraft, setResumableDraft] = useState<SiteQaRecordingDraft | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [issueExpected, setIssueExpected] = useState("");
  const [issueActual, setIssueActual] = useState("");
  const [issueExplanation, setIssueExplanation] = useState("");
  const [voiceBlob, setVoiceBlob] = useState<Blob | null>(null);
  const [recordingVoice, setRecordingVoice] = useState(false);
  const [clock, setClock] = useState(Date.now());

  const annotating = annotationKind !== "none";
  const recording = draft?.status === "recording" && !reviewing;
  const favorite = favorites.some((candidate) => candidate.url === (frame?.url ?? tab.url));

  const paint = useCallback((nextFrame: BrowserTabFrame | null, nextStrokes: readonly Stroke[]) => {
    const canvas = canvasRef.current; if (!canvas || !nextFrame) return;
    const width = Math.max(1, Math.round(nextFrame.width * nextFrame.deviceScaleFactor));
    const height = Math.max(1, Math.round(nextFrame.height * nextFrame.deviceScaleFactor));
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    const context = canvas.getContext("2d"); if (!context) return;
    context.clearRect(0, 0, canvas.width, canvas.height); for (const stroke of nextStrokes) drawStroke(context, stroke);
  }, []);

  const applyFrame = useCallback(async (next: BrowserTabFrame) => {
    const image = await imageForFrame(next);
    if (annotatingRef.current && baseImageRef.current !== null) return;
    baseImageRef.current = image; setFrame(next); setAddress(next.url); setStrokes([]); activeStrokeRef.current = null;
    requestAnimationFrame(() => paint(next, []));
  }, [paint]);

  const refresh = useCallback(async (quiet = false) => {
    if (requestActiveRef.current || annotatingRef.current || reviewing) return;
    requestActiveRef.current = true; if (!quiet) setBusy(true); setError(null);
    try { await applyFrame(await fetchFrame(threadId, tab.id)); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "The browser page could not be loaded."); }
    finally { requestActiveRef.current = false; if (!quiet) setBusy(false); }
  }, [applyFrame, fetchFrame, reviewing, tab.id, threadId]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { void findSiteQaDraft(threadId, tab.id).then((candidate) => { if (candidate) setResumableDraft(candidate); }); }, [tab.id, threadId]);
  useEffect(() => {
    if (annotating || recording || reviewing) return;
    const timer = window.setInterval(() => { void refresh(true); }, 2_500);
    return () => window.clearInterval(timer);
  }, [annotating, recording, refresh, reviewing]);
  useEffect(() => { paint(frame, strokes); }, [frame, paint, strokes]);
  useEffect(() => {
    if (!recording) return;
    const timer = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [recording]);
  useEffect(() => () => {
    if (voiceTimerRef.current !== null) window.clearTimeout(voiceTimerRef.current);
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
  }, []);

  async function commitDraft(next: SiteQaRecordingDraft) {
    setDraft(next); setResumableDraft(null); await saveSiteQaDraft(next);
  }

  const control = useCallback(async (action: BrowserTabControl) => {
    if (requestActiveRef.current || annotating || reviewing) return;
    requestActiveRef.current = true; setBusy(true); setError(null); setNotice(null);
    try {
      if (draft?.status === "recording") {
        if (draft.steps.length >= 100) throw new Error("This recording reached the 100-step limit. Review it before continuing.");
        if (Date.now() - draft.startedAt >= 10 * 60 * 1_000) throw new Error("This recording reached the 10-minute limit. Review it before continuing.");
        const result = await recordTabAction(threadId, tab.id, action as SiteQaRecordedAction);
        await applyFrame(result.frame);
        const frameEvidence: SiteQaEvidenceFrame = { id: createUuidV4(), role: "step", frame: result.frame };
        const evidenceFrameId = draft.frames.length < MAX_EVIDENCE_FRAMES ? frameEvidence.id : draft.frames.at(-1)?.id;
        if (!evidenceFrameId) throw new Error("The recording has no evidence frame.");
        const step: SiteQaManifestStep = {
          stepId: createUuidV4(), index: draft.steps.length,
          relativeAtMs: Math.min(10 * 60 * 1_000, Math.max(0, result.receipt.recordedAt - draft.startedAt)),
          action: result.receipt.action, target: result.receipt.target, input: result.receipt.input,
          beforeUrl: result.receipt.beforeUrl, afterUrl: result.receipt.afterUrl,
          confidence: result.receipt.confidence, evidenceFrameId,
        };
        await commitDraft({ ...draft, updatedAt: Date.now(), steps: [...draft.steps, step], frames: draft.frames.length < MAX_EVIDENCE_FRAMES ? [...draft.frames, frameEvidence] : draft.frames });
      } else {
        await applyFrame(await controlTab(threadId, tab.id, action));
      }
    } catch (caught) {
      if (draft?.status === "recording") {
        const paused = { ...draft, status: "paused" as const, updatedAt: Date.now() };
        setDraft(paused); void saveSiteQaDraft(paused);
      }
      setError(caught instanceof Error ? caught.message : "The browser page did not accept that action.");
    } finally { requestActiveRef.current = false; setBusy(false); }
  }, [annotating, applyFrame, controlTab, draft, recordTabAction, reviewing, tab.id, threadId]);

  function canvasPoint(event: ReactPointerEvent<HTMLCanvasElement>): Point {
    const canvas = event.currentTarget; const rect = canvas.getBoundingClientRect();
    return { x: (event.clientX - rect.left) * (canvas.width / Math.max(1, rect.width)), y: (event.clientY - rect.top) * (canvas.height / Math.max(1, rect.height)), pressure: event.pressure > 0 ? event.pressure : .5 };
  }
  function beginAnnotation(event: ReactPointerEvent<HTMLCanvasElement>) {
    const point = canvasPoint(event); const stroke: Stroke = { color: inkColor, width: inkWidth * Math.max(1, frame?.deviceScaleFactor ?? 1), points: [point] };
    activeStrokeRef.current = { pointerId: event.pointerId, stroke }; setStrokes((current) => [...current, stroke]);
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* WebKit may reject capture. */ }
    event.preventDefault();
  }
  function enterAnnotation(kind: "simple" | "issue") {
    annotatingRef.current = true; setAnnotationKind(kind); setStrokes([]); setNotice(null);
    if (kind === "issue") { setIssueExpected(""); setIssueActual(""); setIssueExplanation(""); setVoiceBlob(null); }
  }
  function leaveAnnotation() { annotatingRef.current = false; setAnnotationKind("none"); setStrokes([]); setNotice(null); }
  function pointerDown(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (!frame) return;
    const startsAnnotation = !annotating && (event.pointerType === "pen" || (event.pointerType === "touch" && touchDraws));
    if (startsAnnotation) { enterAnnotation(recording ? "issue" : "simple"); beginAnnotation(event); return; }
    if (busy && !annotating) return;
    const shouldDraw = annotating && (event.pointerType === "pen" || touchDraws || event.pointerType === "mouse");
    if (shouldDraw) { beginAnnotation(event); return; }
    if (annotating) { event.preventDefault(); return; }
    browseGestureRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY };
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* Browser retains in-bounds delivery. */ }
  }
  function pointerMove(event: ReactPointerEvent<HTMLCanvasElement>) {
    const active = activeStrokeRef.current;
    if (active?.pointerId === event.pointerId) {
      const stroke = { ...active.stroke, points: [...active.stroke.points, canvasPoint(event)] };
      activeStrokeRef.current = { ...active, stroke }; setStrokes((current) => [...current.slice(0, -1), stroke]); event.preventDefault(); return;
    }
    const browse = browseGestureRef.current;
    if (browse?.pointerId === event.pointerId) { browseGestureRef.current = { ...browse, x: event.clientX, y: event.clientY }; event.preventDefault(); }
  }
  function pointerEnd(event: ReactPointerEvent<HTMLCanvasElement>) {
    const active = activeStrokeRef.current; if (active?.pointerId === event.pointerId) { activeStrokeRef.current = null; return; }
    const browse = browseGestureRef.current; if (!browse || browse.pointerId !== event.pointerId || !frame) return;
    browseGestureRef.current = null; const rect = event.currentTarget.getBoundingClientRect(); const dx = browse.x - browse.startX; const dy = browse.y - browse.startY;
    const x = Math.max(0, Math.min(frame.width, (browse.x - rect.left) * (frame.width / Math.max(1, rect.width))));
    const y = Math.max(0, Math.min(frame.height, (browse.y - rect.top) * (frame.height / Math.max(1, rect.height))));
    if (Math.hypot(dx, dy) < 14) void control({ type: "tap", x, y });
    else void control({ type: "scroll", x, y, deltaX: Math.max(-4_000, Math.min(4_000, -dx * (frame.width / Math.max(1, rect.width)) * 1.4)), deltaY: Math.max(-4_000, Math.min(4_000, -dy * (frame.height / Math.max(1, rect.height)) * 1.4)) });
  }

  async function compositeAnnotation(): Promise<Blob> {
    const canvas = canvasRef.current; const image = baseImageRef.current;
    if (!canvas || !image) throw new Error("The annotated frame is unavailable.");
    const output = document.createElement("canvas"); output.width = canvas.width; output.height = canvas.height;
    const context = output.getContext("2d"); if (!context) throw new Error("The annotation could not be exported.");
    context.drawImage(image, 0, 0, output.width, output.height); context.drawImage(canvas, 0, 0);
    return new Promise<Blob>((resolve, reject) => output.toBlob((value) => value ? resolve(value) : reject(new Error("The annotation could not be exported.")), "image/png"));
  }
  async function sendAnnotation() {
    if (strokes.length === 0 || busy) return;
    setBusy(true); setError(null); setNotice("Attaching the annotated page to the Mac composer…");
    try { const result = await onSendAnnotation(await compositeAnnotation()); if (!result.ok) throw new Error(result.message ?? "The annotated page was not attached."); setNotice(result.message ?? "Annotated page attached to the Mac composer."); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "The annotated page was not attached."); }
    finally { setBusy(false); }
  }

  async function startRecording() {
    if (!frame || busy) return;
    const frameEvidence: SiteQaEvidenceFrame = { id: createUuidV4(), role: "start", frame };
    const next: SiteQaRecordingDraft = { version: 1, id: createUuidV4(), threadId, tabId: tab.id, tabTitle: frame.title || tab.title, status: "recording", intent: "both", startedAt: Date.now(), updatedAt: Date.now(), steps: [], frames: [frameEvidence], issues: [] };
    try { await commitDraft(next); setClock(Date.now()); setNotice("Recording started. Your actions now affect the live Mac page."); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Recording could not start."); }
  }
  async function resumeRecording(candidate: SiteQaRecordingDraft) {
    const next = { ...candidate, status: "recording" as const, updatedAt: Date.now() };
    try { await commitDraft(next); setReviewing(false); setNotice("Recording resumed on the exact saved page."); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Recording could not resume."); }
  }
  async function pauseRecording() {
    if (!draft) return;
    const next = { ...draft, status: "paused" as const, updatedAt: Date.now() };
    await commitDraft(next); setNotice("Recording paused. The live page remains usable, but actions are not being added to the timeline.");
  }
  async function finishRecording() {
    if (!draft || !frame) return;
    const finalEvidence: SiteQaEvidenceFrame = { id: createUuidV4(), role: "final", frame };
    const next = { ...draft, status: "review" as const, updatedAt: Date.now(), frames: draft.frames.length < MAX_EVIDENCE_FRAMES ? [...draft.frames, finalEvidence] : draft.frames };
    await commitDraft(next); setReviewing(true); leaveAnnotation();
  }
  async function discardRecording() {
    const current = draft ?? resumableDraft; if (!current) return;
    await deleteSiteQaDraft(current.id); setDraft(null); setResumableDraft(null); setReviewing(false); setNotice("Local recording deleted.");
  }
  async function toggleVoice() {
    if (recordingVoice) { recorderRef.current?.stop(); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream); voiceChunksRef.current = [];
      recorder.addEventListener("dataavailable", (event) => { if (event.data.size > 0) voiceChunksRef.current.push(event.data); });
      recorder.addEventListener("stop", () => {
        if (voiceTimerRef.current !== null) window.clearTimeout(voiceTimerRef.current);
        voiceTimerRef.current = null;
        setVoiceBlob(new Blob(voiceChunksRef.current, { type: recorder.mimeType || "audio/mp4" }));
        setRecordingVoice(false);
        for (const track of stream.getTracks()) track.stop();
      }, { once: true });
      recorderRef.current = recorder; recorder.start(); setRecordingVoice(true);
      voiceTimerRef.current = window.setTimeout(() => recorder.stop(), 3 * 60 * 1_000);
    } catch { setError("Microphone access was not granted. Type the explanation instead."); }
  }
  async function saveIssue(finish: boolean) {
    if (!draft || !frame || strokes.length === 0) { setError("Circle, underline, or redact the issue before saving it."); return; }
    setBusy(true); setError(null);
    try {
      if (recordingVoice) recorderRef.current?.stop();
      const evidence: SiteQaEvidenceFrame = { id: createUuidV4(), role: "issue", frame };
      const voiceBytes = voiceBlob ? await voiceBlob.arrayBuffer() : null;
      const issue: SiteQaDraftIssue = {
        issueId: createUuidV4(), frameId: evidence.id, expected: issueExpected.trim(), actual: issueActual.trim(), explanation: issueExplanation.trim(),
        annotationPngBase64: await blobBase64(await compositeAnnotation()), voiceMimeType: voiceBlob?.type ?? null, voiceBytes,
      };
      const next = { ...draft, updatedAt: Date.now(), frames: [...draft.frames, evidence].slice(-MAX_EVIDENCE_FRAMES), issues: [...draft.issues, issue] };
      await commitDraft(next); leaveAnnotation();
      if (finish) await finishRecordingWith(next, frame);
      else setNotice("Issue marked. Continue reproducing the flow.");
    } catch (caught) { setError(caught instanceof Error ? caught.message : "The issue could not be saved."); }
    finally { setBusy(false); }
  }
  async function finishRecordingWith(current: SiteQaRecordingDraft, currentFrame: BrowserTabFrame) {
    const finalEvidence: SiteQaEvidenceFrame = { id: createUuidV4(), role: "final", frame: currentFrame };
    const next = { ...current, status: "review" as const, updatedAt: Date.now(), frames: current.frames.length < MAX_EVIDENCE_FRAMES ? [...current.frames, finalEvidence] : current.frames };
    await commitDraft(next); setReviewing(true); leaveAnnotation();
  }

  const reviewFrames = useMemo(() => {
    if (!draft) return [];
    const wanted = [draft.frames.find((value) => value.role === "start"), ...draft.issues.map((issue) => draft.frames.find((value) => value.id === issue.frameId)), [...draft.frames].reverse().find((value) => value.role === "final")].filter((value): value is SiteQaEvidenceFrame => Boolean(value));
    return wanted.filter((value, index) => wanted.findIndex((candidate) => candidate.id === value.id) === index).slice(0, 12);
  }, [draft]);

  async function sendRecording() {
    if (!draft || draft.issues.length === 0 || reviewFrames.length === 0) { setError("Mark at least one issue before sending this recording."); return; }
    setBusy(true); setError(null); setNotice("Sending one atomic QA report to the exact Codex task…");
    try {
      const first = draft.frames[0]!.frame;
      const manifest = SiteQaManifestSchema.parse({
        version: 1, recordingId: draft.id, sourceThreadId: draft.threadId, startedAt: draft.startedAt,
        durationMs: Math.min(10 * 60 * 1_000, Math.max(0, draft.updatedAt - draft.startedAt)), intent: draft.intent,
        environment: { viewport: { width: first.width, height: first.height }, deviceScaleFactor: first.deviceScaleFactor, controllerOrientation: first.width >= first.height ? "landscape" : "portrait" },
        steps: draft.steps,
        issues: draft.issues.map((issue) => ({ issueId: issue.issueId, frameId: issue.frameId, expected: issue.expected, actual: issue.actual, explanation: issue.explanation, hasLocalVoiceNote: issue.voiceBytes !== null })),
      });
      const payload: SiteQaSendPayload = {
        manifest,
        frames: reviewFrames.map((evidence) => {
          const issue = draft.issues.find((candidate) => candidate.frameId === evidence.id);
          const blob = issue?.annotationPngBase64 ? rawBase64Blob(issue.annotationPngBase64, "image/png") : rawBase64Blob(evidence.frame.imageBase64, evidence.frame.mimeType);
          return { id: evidence.id, title: issue ? `Marked issue · ${evidence.frame.title}` : `${evidence.role} · ${evidence.frame.title}`, url: evidence.frame.url, blob, width: evidence.frame.width, height: evidence.frame.height, deviceScaleFactor: evidence.frame.deviceScaleFactor, scrollX: evidence.frame.scrollX, scrollY: evidence.frame.scrollY };
        }),
      };
      const result = await onSendRecording(payload);
      if (!result.ok) throw new Error(result.message);
      setNotice(result.pending ? "The report is still being accepted by Codex. It remains saved locally." : result.message);
      if (!result.pending) { await deleteSiteQaDraft(draft.id); setDraft(null); setReviewing(false); }
    } catch (caught) { setError(caught instanceof Error ? caught.message : "The recording was not sent. It remains saved locally."); }
    finally { setBusy(false); }
  }

  if (reviewing && draft) {
    return (
      <section className="cp-site-recording-review" aria-labelledby="recording-review-title">
        <header><button type="button" onClick={() => setReviewing(false)}><ChevronIcon direction="left" />Live page</button><div><p className="cp-overline">Site QA Recorder</p><h1 id="recording-review-title">Review recording</h1></div><span>{draft.steps.length} steps · {draft.issues.length} issue{draft.issues.length === 1 ? "" : "s"}</span></header>
        <div className="cp-site-recording-review__body">
          <section className="cp-site-recording-review__evidence"><div className="cp-site-recording-review__strip">{reviewFrames.map((evidence) => { const issue = draft.issues.find((candidate) => candidate.frameId === evidence.id); return <img key={evidence.id} src={issue?.annotationPngBase64 ? `data:image/png;base64,${issue.annotationPngBase64}` : frameSource(evidence.frame)} alt={evidence.role} />; })}</div><div className="cp-site-recording-review__privacy"><strong>Privacy check</strong><p>{draft.steps.filter((step) => step.input.mode === "placeholder").length} typed value(s) were replaced with placeholders. Screenshots can still contain visible private content; use the black Redact ink before saving an issue.</p><p>{draft.issues.some((issue) => issue.voiceBytes) ? "Voice notes remain local to this iPad. Their written explanation is what the agent receives." : "No microphone data is included."}</p></div></section>
          <section className="cp-site-recording-review__timeline"><div className="cp-site-recording-review__intent"><span>Ask the agent to</span>{([ ["both", "Fix + test"], ["diagnose-and-fix", "Diagnose + fix"], ["regression-test", "Add test"] ] as const).map(([value, label]) => <button key={value} type="button" aria-pressed={draft.intent === value} onClick={() => void commitDraft({ ...draft, intent: value, updatedAt: Date.now() })}>{label}</button>)}</div><ol>{draft.steps.map((step) => <li key={step.stepId}><span>{step.index + 1}</span><div><strong>{step.action.type === "insertText" ? "Type protected value" : step.action.type}</strong><small>{step.target?.accessibleName ?? step.target?.label ?? displayHost(step.afterUrl)} · {step.confidence}</small></div><button type="button" aria-label={`Remove step ${step.index + 1}`} onClick={() => { const steps = draft.steps.filter((candidate) => candidate.stepId !== step.stepId).map((candidate, index) => ({ ...candidate, index })); void commitDraft({ ...draft, steps, updatedAt: Date.now() }); }}>Remove</button></li>)}</ol>{draft.issues.map((issue, index) => <article key={issue.issueId} className="cp-site-recording-review__issue"><strong>Issue {index + 1}</strong><p>{issue.explanation || issue.actual || "Annotated on the evidence frame."}</p>{issue.expected && <small>Expected: {issue.expected}</small>}{issue.actual && <small>Actual: {issue.actual}</small>}</article>)}</section>
        </div>
        <footer><button type="button" className="is-danger" onClick={() => void discardRecording()}>Delete recording</button><button type="button" onClick={() => { void commitDraft({ ...draft, status: "recording", updatedAt: Date.now() }); setReviewing(false); }}>Continue recording</button><button type="button" className="is-primary" disabled={!sendEnabled || busy || draft.issues.length === 0} onClick={() => void sendRecording()}>{busy ? "Sending…" : "Send to agent"}</button></footer>
        {(notice || error) && <p className={`cp-browser-site__message${error ? " is-error" : ""}`} role="status">{error ?? notice}</p>}
      </section>
    );
  }

  return (
    <section className={`cp-browser-site${annotating ? " is-annotating" : " is-browsing"}`} aria-label="Live site workspace">
      <header className="cp-browser-site__topbar">
        <button type="button" className="cp-browser-site__back" onClick={onOpenSites}><ChevronIcon direction="left" />Sites</button>
        <form className="cp-browser-site__address" onSubmit={(event) => { event.preventDefault(); try { void control({ type: "navigate", url: normalizeSiteAddress(address) }); } catch (caught) { setError(caught instanceof Error ? caught.message : "Invalid address."); } }}><GlobeIcon /><input aria-label="Current site address" inputMode="url" autoCapitalize="none" autoCorrect="off" value={address} onChange={(event) => setAddress(event.target.value)} disabled={annotating} /><button type="submit" disabled={busy || annotating}>Go</button><button type="button" className="cp-browser-site__favorite" aria-label={favorite ? "Remove current page from favorites" : "Add current page to favorites"} aria-pressed={favorite} onClick={() => onToggleFavorite(frame?.url ?? tab.url, frame?.title ?? tab.title)}>{favorite ? "★" : "☆"}</button></form>
        <div className="cp-browser-site__navigation" aria-label="Browser navigation"><button type="button" disabled={busy || annotating} onClick={() => void control({ type: "back" })}>←</button><button type="button" disabled={busy || annotating} onClick={() => void control({ type: "forward" })}>→</button><button type="button" disabled={busy || annotating} onClick={() => void control({ type: "reload" })}>↻</button></div>
      </header>

      {resumableDraft && !draft && <div className="cp-browser-site__resume"><span><strong>Saved QA recording</strong><small>{resumableDraft.steps.length} steps · {resumableDraft.issues.length} issues</small></span><button type="button" onClick={() => void resumeRecording(resumableDraft)}>Resume</button><button type="button" onClick={() => { setDraft(resumableDraft); setReviewing(true); }}>Review</button><button type="button" onClick={() => void discardRecording()}>Delete</button></div>}
      {recording && <div className="cp-browser-site__recording"><i /><strong>Recording</strong><span>{elapsedLabel(clock - draft.startedAt)}</span><small>{draft.steps.length} steps</small></div>}

      <div className="cp-browser-site__stage">
        {!frame && !error && <div className="cp-browser-site__loading"><span /><strong>Opening the Mac page…</strong></div>}
        {error && !frame && <div className="cp-browser-site__loading is-error"><strong>{error}</strong><button type="button" onClick={() => void refresh()}>Try again</button></div>}
        {frame && <img className="cp-browser-site__frame" src={frameSource(frame)} width={Math.max(1, Math.round(frame.width * frame.deviceScaleFactor))} height={Math.max(1, Math.round(frame.height * frame.deviceScaleFactor))} alt="" aria-hidden="true" draggable={false} />}
        <canvas ref={canvasRef} className="cp-browser-site__canvas" aria-label={annotating ? "Annotate current site frame" : "Browse current Mac site"} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerEnd} onPointerCancel={() => { browseGestureRef.current = null; activeStrokeRef.current = null; }} />
        {busy && frame && <span className="cp-browser-site__busy" aria-label="Updating site" />}
      </div>

      <footer className="cp-browser-site__dock">
        {!annotating ? <>
          <button type="button" disabled={busy} onClick={() => setTyping((current) => !current)}><span>⌨</span>Type</button>
          <button type="button" disabled={!frame} onClick={() => enterAnnotation("simple")}><PencilIcon />Annotate</button>
          {!recording ? draft?.status === "paused"
            ? <button type="button" className="is-primary" disabled={!frame || busy} onClick={() => void resumeRecording(draft)}>Resume recording</button>
            : <button type="button" className="is-primary" disabled={!frame || busy} onClick={() => void startRecording()}><span className="cp-record-dot" />Record flow</button>
            : <><button type="button" className="is-primary" disabled={busy} onClick={() => enterAnnotation("issue")}>Mark issue</button><button type="button" disabled={busy} onClick={() => void pauseRecording()}>Pause</button><button type="button" disabled={busy} onClick={() => void finishRecording()}>Stop & review</button></>}
          <button type="button" aria-pressed={touchDraws} onClick={() => setTouchDraws((current) => !current)}>{touchDraws ? "Touch + Pencil" : "Pencil only"}</button>
        </> : <>
          <button type="button" disabled={busy || strokes.length === 0} onClick={() => setStrokes((current) => current.slice(0, -1))}>Undo</button><button type="button" disabled={busy || strokes.length === 0} onClick={() => setStrokes([])}>Clear</button>
          <div className="cp-browser-site__inks" aria-label="Ink color">{INK_COLORS.map((color) => <button key={color} type="button" aria-label={`Use ${color} ink`} aria-pressed={inkColor === color && inkWidth < 20} style={{ "--ink": color } as CSSProperties} onClick={() => { setInkColor(color); setInkWidth(7); }} />)}<button type="button" className="is-redact" aria-label="Use redaction ink" aria-pressed={inkColor === "#0b0d10" && inkWidth === 28} onClick={() => { setInkColor("#0b0d10"); setInkWidth(28); }}>Redact</button></div>
          <label className="cp-browser-site__width"><span>Width</span><input type="range" min="3" max="28" value={inkWidth} onChange={(event) => setInkWidth(Number(event.target.value))} /></label>
          {annotationKind === "simple" ? <><button type="button" onClick={leaveAnnotation}>Browse</button><button type="button" className="is-primary" disabled={!sendEnabled || busy || strokes.length === 0} onClick={() => void sendAnnotation()}>{busy ? "Sending…" : "Send"}</button></> : null}
        </>}
      </footer>

      {typing && !annotating && <form className="cp-browser-site__typing" onSubmit={(event) => { event.preventDefault(); if (typedText !== "") void control({ type: "insertText", text: typedText }); setTypedText(""); setTyping(false); }}><input autoFocus value={typedText} placeholder="Type into the focused field" onChange={(event) => setTypedText(event.target.value)} /><button type="button" onClick={() => void control({ type: "key", key: "Backspace" })}>⌫</button><button type="submit" disabled={typedText === ""}>Type</button><button type="button" onClick={() => { void control({ type: "key", key: "Enter" }); setTyping(false); }}>Enter</button></form>}

      {annotationKind === "issue" && <section className="cp-site-issue-sheet" aria-labelledby="mark-issue-title"><div className="cp-site-issue-sheet__handle" /><header><div><p className="cp-overline">Checkpoint</p><h2 id="mark-issue-title">Mark what went wrong</h2></div><button type="button" onClick={leaveAnnotation}>Cancel</button></header><div className="cp-site-issue-sheet__fields"><label><span>What happened?</span><textarea value={issueExplanation} placeholder="Explain the visible problem" onChange={(event) => setIssueExplanation(event.target.value)} /></label><label><span>Expected</span><input value={issueExpected} placeholder="What should have happened?" onChange={(event) => setIssueExpected(event.target.value)} /></label><label><span>Actual</span><input value={issueActual} placeholder="What happened instead?" onChange={(event) => setIssueActual(event.target.value)} /></label></div><div className="cp-site-issue-sheet__voice"><button type="button" aria-pressed={recordingVoice} onClick={() => void toggleVoice()}>{recordingVoice ? "Stop voice note" : voiceBlob ? "Replace voice note" : "Explain with voice"}</button><small>{voiceBlob ? "Voice is saved locally with this checkpoint. Add a written summary for the agent." : "Microphone starts only after you tap."}</small></div><footer><button type="button" disabled={busy || strokes.length === 0} onClick={() => void saveIssue(false)}>Save & continue</button><button type="button" className="is-primary" disabled={busy || strokes.length === 0} onClick={() => void saveIssue(true)}>Save & review</button></footer></section>}
      {(notice || (error && frame)) && <p className={`cp-browser-site__message${error ? " is-error" : ""}`} role="status">{error ?? notice}</p>}
    </section>
  );
}
