import { createScene, type Scene } from "@codex-pad/drawing";
import {
  createAtomicSendManifest,
  createReviewDraft,
  REVIEW_LIMITS,
  reviewDraftReducer,
  type ReviewDraft,
  type ReviewDraftAction,
  type ReviewFrame,
  type ReviewImage,
} from "@codex-pad/review";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ReactNode,
} from "react";

import { DrawingCanvasEditor } from "./DrawingStudio";
import { LocalVisualDiff } from "./LocalVisualDiff";
import { REVIEW_STYLES } from "./review-styles";
import {
  canCompareFrame,
  frameIdentityKey,
  makeAfterComparison,
  makeBlankReviewFrame,
  makeIterationFrame,
  makePhotoReviewFrame,
  makeSiteReviewFrame,
  resolveAllowedSite,
  resolveRegisteredCaptureRoute,
  reviewId,
  type AllowedReviewSite,
  type ReviewFrameGeometry,
  type ReviewInputMode,
} from "./review-state";
import { formatReviewBytes, prepareReviewImage, reviewImageBlobRef, reviewImageDataUrl } from "../lib/review-media";
import { PHOTO_IMPORT_ACCEPT } from "../lib/heic-image";
import { buildAtomicReviewSend, type AtomicReviewSend } from "../lib/review-payload";
import { flattenReviewDrawings } from "../lib/review-render";
import { createUuidV4 } from "../lib/uuid";
import { publicCapturedSiteUrl } from "../lib/site-capture";
import { createSerialMutationQueue } from "../lib/serial-mutation-queue";
import {
  clearPendingReviewDelivery,
  deleteReviewDraftIfUnchanged,
  getReviewBlob,
  loadReviewDraft,
  loadPendingReviewDelivery,
  loadPendingReviewDeliveryIdentity,
  reviewDraftBlobRefs,
  reviewFrameBlobRefs,
  savePendingReviewDelivery,
  saveReviewDraft,
  saveReviewDraftAndDeleteBlobs,
  saveReviewDraftWithBlobChanges,
  sweepReviewOrphanBlobs,
  type ReviewBlobWrite,
} from "../lib/review-store";

export type { AllowedReviewSite } from "./review-state";
export type { AtomicReviewSend } from "../lib/review-payload";

export interface CapturedReviewImage {
  readonly image: ReviewImage;
  /** Required when image.source is a blobRef that is not already in the review database. */
  readonly blob?: Blob;
  readonly geometry?: ReviewFrameGeometry;
  /** Root-relative pathname + search after any bridge-observed same-origin redirect. */
  readonly finalPath: string;
  readonly title: string | null;
}

export interface CaptureReviewSiteInput {
  readonly url: string;
  readonly title: string | null;
  readonly viewport: ReviewFrame["viewport"];
  readonly scroll: ReviewFrame["scroll"];
}

export interface ReviewSendResult {
  readonly ok: boolean;
  /** True when delivery is still in flight or its final outcome is unknown. */
  readonly pending?: boolean;
  readonly message: string;
}

type CaptureViewportChoice = "current" | "ipad-landscape" | "ipad-portrait" | "mobile-portrait" | "desktop-wide";

const CAPTURE_VIEWPORTS: Readonly<Record<Exclude<CaptureViewportChoice, "current">, { width: number; height: number }>> = {
  "ipad-landscape": { width: 1_366, height: 1_024 },
  "ipad-portrait": { width: 1_024, height: 1_366 },
  "mobile-portrait": { width: 390, height: 844 },
  "desktop-wide": { width: 1_440, height: 900 },
};

export interface ReviewStudioProps {
  readonly bridgeInstanceId: string;
  readonly threadId: string;
  readonly threadKey: string;
  readonly threadTitle: string;
  readonly snapshotSeq: number;
  readonly readOnly?: boolean;
  /** Locks local editing. Bridge connectivity must use sendEnabled instead. */
  readonly sendEnabled?: boolean;
  /** Bounded atomic delivery capability; local decks may contain more images. */
  readonly reviewMaxImages?: 0 | 1 | 12;
  readonly agentUpdated?: boolean;
  readonly site?: AllowedReviewSite | null;
  readonly onClose?: () => void;
  readonly onSendReview: (payload: AtomicReviewSend) => Promise<ReviewSendResult>;
  readonly instructionSuffix?: string;
  readonly selectedSkillIds?: readonly string[];
  readonly onCaptureSite?: (input: CaptureReviewSiteInput) => Promise<CapturedReviewImage>;
}

function threadSuffix(threadId: string): string {
  return threadId.slice(-8);
}

function geometryForViewport(): ReviewFrameGeometry {
  const width = typeof window === "undefined" ? 1_024 : Math.max(320, Math.round(window.innerWidth));
  const height = typeof window === "undefined" ? 768 : Math.max(320, Math.round(window.innerHeight));
  return {
    viewport: {
      width,
      height,
      deviceScaleFactor: typeof window === "undefined" ? 2 : Math.min(3, Math.max(1, window.devicePixelRatio || 1)),
    },
    scroll: { x: 0, y: 0 },
  };
}

function geometryForCaptureChoice(choice: CaptureViewportChoice): ReviewFrameGeometry {
  if (choice === "current") return geometryForViewport();
  return {
    viewport: { ...CAPTURE_VIEWPORTS[choice], deviceScaleFactor: 1 },
    scroll: { x: 0, y: 0 },
  };
}

function geometryForImage(image: ReviewImage): ReviewFrameGeometry {
  const scale = Math.min(1, 16_384 / Math.max(image.metadata.pixelWidth, image.metadata.pixelHeight));
  return {
    viewport: {
      width: Math.max(1, Math.round(image.metadata.pixelWidth * scale)),
      height: Math.max(1, Math.round(image.metadata.pixelHeight * scale)),
      deviceScaleFactor: 1,
    },
    scroll: { x: 0, y: 0 },
  };
}

function imageAlt(frame: ReviewFrame): string {
  if (frame.kind === "photo") return frame.title ? `Photo: ${frame.title}` : "Imported review photo";
  return frame.title ? `Capture: ${frame.title}` : "Review frame capture";
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const query = matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener?.("change", update);
    return () => query.removeEventListener?.("change", update);
  }, []);
  return reduced;
}

function ReviewImagePreview({ image, alt, className = "" }: { image: ReviewImage; alt: string; className?: string }) {
  const immediate = reviewImageDataUrl(image);
  const [source, setSource] = useState<string | null>(immediate);

  useEffect(() => {
    if (immediate) {
      setSource(immediate);
      return;
    }
    const blobRef = reviewImageBlobRef(image);
    let objectUrl: string | null = null;
    let cancelled = false;
    if (blobRef) {
      setSource(null);
      void getReviewBlob(blobRef).then((blob) => {
        if (!blob || cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setSource(objectUrl);
      });
    }
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [image, immediate]);

  if (!source) return <div className={`review-image-missing ${className}`} role="img" aria-label={`${alt} unavailable`}>Media unavailable</div>;
  return <img className={className} src={source} alt={alt} draggable={false} />;
}

function ComparisonPanel({
  frame,
  readOnly,
  onMode,
  onStoreIteration,
}: {
  frame: ReviewFrame;
  readOnly: boolean;
  onMode: (mode: ReviewFrame["comparison"]["mode"]) => void;
  onStoreIteration: () => void;
}) {
  const reducedMotion = useReducedMotion();
  const [overlay, setOverlay] = useState(50);
  const [blinkAfter, setBlinkAfter] = useState(false);
  const { before, after, mode } = frame.comparison;

  useEffect(() => {
    if (mode !== "blink" || reducedMotion) return;
    const timer = window.setInterval(() => setBlinkAfter((value) => !value), 800);
    return () => window.clearInterval(timer);
  }, [mode, reducedMotion]);

  if (!before || !after) return null;
  let visual: ReactNode;
  if (mode === "side-by-side") {
    visual = (
      <div className="review-compare-side">
        <figure><ReviewImagePreview image={before.image} alt={before.label || "Before"} /><figcaption>{before.label || "Before"}</figcaption></figure>
        <figure><ReviewImagePreview image={after.image} alt={after.label || "After"} /><figcaption>{after.label || "After"}</figcaption></figure>
      </div>
    );
  } else if (mode === "overlay" || mode === "swipe") {
    visual = (
      <div className="review-compare-overlay">
        <ReviewImagePreview image={before.image} alt={before.label || "Before"} />
        <div className="review-compare-after" style={{ clipPath: `inset(0 ${100 - overlay}% 0 0)` }}>
          <ReviewImagePreview image={after.image} alt={after.label || "After"} />
        </div>
        <label><span>After reveal</span><input type="range" min="0" max="100" value={overlay} onChange={(event) => setOverlay(Number(event.target.value))} /></label>
      </div>
    );
  } else if (mode === "blink") {
    visual = (
      <div className="review-compare-blink">
        <ReviewImagePreview image={blinkAfter ? after.image : before.image} alt={blinkAfter ? after.label || "After" : before.label || "Before"} />
        <button type="button" onClick={() => setBlinkAfter((value) => !value)}>{blinkAfter ? "Show before" : "Show after"}</button>
        {reducedMotion && <span>Automatic blinking is disabled by Reduce Motion.</span>}
      </div>
    );
  } else if (mode === "diff") {
    visual = <LocalVisualDiff before={before.image} after={after.image} />;
  } else {
    visual = null;
  }

  return (
    <section className="review-comparison" aria-label="Before and after comparison">
      <header><span className="section-register">Iteration</span><h3>Before / after</h3></header>
      <div className="review-compare-modes" role="toolbar" aria-label="Comparison mode">
        {(["side-by-side", "overlay", "blink", "diff"] as const).map((candidate) => (
          <button key={candidate} type="button" aria-pressed={mode === candidate} className={mode === candidate ? "is-active" : ""} onClick={() => onMode(candidate)}>{candidate === "side-by-side" ? "Side by side" : candidate === "overlay" ? "Overlay" : candidate === "blink" ? "Blink" : "Diff"}</button>
        ))}
      </div>
      {visual}
      <button className="review-store-iteration" type="button" disabled={readOnly} onClick={onStoreIteration}>Store after as a new iteration</button>
    </section>
  );
}

function reviewDeliveryLimitReason(reviewMaxImages: number, imageCount: number): string | null {
  if (imageCount >= 1 && imageCount <= reviewMaxImages) return null;
  if (reviewMaxImages === 1 && imageCount > 1) {
    return `This Codex connection can send one image per review. This ${imageCount}-image deck remains saved locally; Nerva will not drop, flatten, or split its images.`;
  }
  return "This exact image manifest exceeds the currently verified Codex review capability. It remains saved locally and nothing will be sent.";
}

function SendSheet({
  payload,
  targetLabel,
  sendEnabled,
  reviewMaxImages,
  sending,
  clearing,
  result,
  onCancel,
  onConfirm,
  onClear,
}: {
  payload: AtomicReviewSend;
  targetLabel: string;
  sendEnabled: boolean;
  reviewMaxImages: 0 | 1 | 12;
  sending: boolean;
  clearing: boolean;
  result: ReviewSendResult | null;
  onCancel: () => void;
  onConfirm: () => void;
  onClear: () => void;
}) {
  const capabilityReason = reviewDeliveryLimitReason(reviewMaxImages, payload.manifest.images.length);
  const deliveryAllowed = sendEnabled && capabilityReason === null;
  const sent = result?.ok === true && result.pending !== true;
  const [confirmClear, setConfirmClear] = useState(false);
  const dialogRef = useRef<HTMLElement | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const cancelRef = useRef(onCancel);
  const sendingRef = useRef(sending);
  cancelRef.current = onCancel;
  sendingRef.current = sending;

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    confirmRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      const dialog = dialogRef.current;
      if (!dialog) return;
      if (event.key === "Escape" && !sendingRef.current) {
        event.preventDefault();
        cancelRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ));
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previous?.focus();
    };
  }, []);
  return (
    <div className="review-send-backdrop" role="presentation">
      <section ref={dialogRef} className="review-send-sheet" role="dialog" aria-modal="true" aria-labelledby="review-send-title">
        <header>
          <span className="section-register">Atomic send</span>
          <h2 id="review-send-title">Send one review to {targetLabel}</h2>
          <p>Exact thread <code>…{threadSuffix(payload.targetThreadId)}</code> · command <code>{payload.commandId.slice(-10)}</code></p>
        </header>
        <div className="review-send-summary">
          <div><strong>{payload.draft.frames.length}</strong><span>frames</span></div>
          <div><strong>{payload.manifest.images.length}</strong><span>ordered images</span></div>
        </div>
        <section>
          <h3>General instruction</h3>
          <p>{payload.draft.generalInstruction.trim() || "Review the supplied material and act on the observations."}</p>
        </section>
        <section>
          <h3>Ordered image list</h3>
          <ol className="review-send-files">
            {payload.manifest.images.map((image) => {
              const attachment = payload.attachments.find((candidate) => candidate.ref === (image.source.kind === "blobRef" ? image.source.blobRef : image.imageId));
              return <li key={`${image.imageId}-${image.order}`}><code>{image.label}</code><span>{image.mimeType}{attachment ? ` · ${formatReviewBytes(attachment.size)}` : ""}</span></li>;
            })}
          </ol>
        </section>
        <p className="review-atomic-note">Ordered images leave through one callback. A retry keeps the same command ID.</p>
        {!sendEnabled && <p className="review-delivery-unavailable" role="status">Bridge delivery is unavailable. This preview remains saved locally and nothing will be queued or replayed.</p>}
        {sendEnabled && capabilityReason && <p className="review-delivery-unavailable" role="status">{capabilityReason} Multi-image input has not been verified for this connection.</p>}
        {result && <p className={result.pending ? "review-result is-pending" : result.ok ? "review-result is-success" : "review-result is-error"} role="status">{result.message}</p>}
        {sent && confirmClear && (
          <div className="review-clear-confirm" role="alert">
            <p>This permanently removes this local review, its saved iterations, and unshared media. Keep it to use these frames as Before in the next cycle.</p>
            <button type="button" disabled={clearing} onClick={() => setConfirmClear(false)}>Keep local review</button>
            <button type="button" disabled={clearing} onClick={onClear}>{clearing ? "Clearing local review…" : "Delete local review"}</button>
          </div>
        )}
        <footer>
          <button type="button" disabled={sending || clearing} onClick={onCancel}>{sent ? "Keep for before / after" : "Back"}</button>
          {sent ? (
            <button ref={confirmRef} type="button" disabled={clearing || confirmClear} onClick={() => setConfirmClear(true)}>Clear local review</button>
          ) : (
            <button ref={confirmRef} className="review-send-confirm" type="button" disabled={!deliveryAllowed || sending || result?.ok === true} onClick={onConfirm}>{!sendEnabled ? "Send unavailable" : capabilityReason ? "Multi-image send unavailable" : sending ? "Sending one review…" : result && !result.ok ? "Retry same command" : "Send review"}</button>
          )}
        </footer>
      </section>
    </div>
  );
}

export function ReviewStudio({
  bridgeInstanceId,
  threadId,
  threadKey,
  threadTitle,
  snapshotSeq,
  readOnly = false,
  sendEnabled = true,
  reviewMaxImages = 1,
  agentUpdated = false,
  site = null,
  onClose,
  instructionSuffix = "",
  selectedSkillIds = [],
  onSendReview,
  onCaptureSite,
}: ReviewStudioProps) {
  const [draft, setDraft] = useState<ReviewDraft | null>(null);
  const draftRef = useRef<ReviewDraft | null>(null);
  const [activeFrameId, setActiveFrameId] = useState<string | null>(null);
  const [inputMode, setInputMode] = useState<ReviewInputMode>(site ? "interact" : "smart");
  const [surface, setSurface] = useState<"live" | "frame">(site ? "live" : "frame");
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [sendPayload, setSendPayload] = useState<AtomicReviewSend | null>(null);
  const [sendPreparing, setSendPreparing] = useState(false);
  const [sending, setSending] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [sendResult, setSendResult] = useState<ReviewSendResult | null>(null);
  const mountedRef = useRef(true);
  const targetThreadRef = useRef(threadId);
  const reviewMutationQueueRef = useRef(createSerialMutationQueue());
  targetThreadRef.current = threadId;
  const allowedSiteUrl = useMemo(() => resolveAllowedSite(site), [site]);
  const [captureViewport, setCaptureViewport] = useState<CaptureViewportChoice>("current");

  const enqueueReviewMutation = useCallback(<T,>(mutation: () => Promise<T>): Promise<T> => {
    return reviewMutationQueueRef.current.enqueue(mutation);
  }, []);

  const persist = useCallback((next: ReviewDraft) => {
    draftRef.current = next;
    setDraft(next);
    void enqueueReviewMutation(() => saveReviewDraft(next)).catch(() => {
      if (mountedRef.current) setError("This draft could not be saved on the iPad.");
    });
  }, [enqueueReviewMutation]);

  const applyAction = useCallback((action: ReviewDraftAction): ReviewDraft | null => {
    const current = draftRef.current;
    if (!current) return null;
    try {
      const next = reviewDraftReducer(current, action, Math.max(Date.now(), current.updatedAt + 1));
      persist(next);
      return next;
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "The review could not be updated.");
      return null;
    }
  }, [persist]);

  const applyDeletion = useCallback((action: ReviewDraftAction, candidateRefs: readonly string[]): ReviewDraft | null => {
    const current = draftRef.current;
    if (!current) return null;
    try {
      const next = reviewDraftReducer(current, action, Math.max(Date.now(), current.updatedAt + 1));
      const retained = new Set(reviewDraftBlobRefs(next));
      const garbage = candidateRefs.filter((ref) => !retained.has(ref));
      draftRef.current = next;
      setDraft(next);
      void enqueueReviewMutation(() => saveReviewDraftAndDeleteBlobs(next, garbage)).catch(() => {
        if (mountedRef.current) setError("The review changed in memory, but its media cleanup could not be saved atomically.");
      });
      return next;
    } catch (deletionError) {
      setError(deletionError instanceof Error ? deletionError.message : "The review item could not be deleted.");
      return null;
    }
  }, [enqueueReviewMutation]);

  const commitPreparedMedia = useCallback(async (
    base: ReviewDraft,
    next: ReviewDraft,
    blobWrites: readonly ReviewBlobWrite[],
    raceMessage: string,
  ): Promise<ReviewDraft> => {
    if (next.targetThreadId !== base.targetThreadId) {
      throw new Error("A media commit cannot change its review thread.");
    }
    return enqueueReviewMutation(async () => {
      const beforeCommit = draftRef.current;
      if (targetThreadRef.current !== base.targetThreadId || beforeCommit !== base) {
        throw new Error(raceMessage);
      }
      await saveReviewDraftWithBlobChanges(next, blobWrites);
      const latest = draftRef.current;
      if (targetThreadRef.current !== base.targetThreadId || latest !== base) {
        const rollbackDraft = latest?.targetThreadId === base.targetThreadId ? latest : base;
        await saveReviewDraftWithBlobChanges(
          rollbackDraft,
          [],
          blobWrites.map((write) => write.id),
        );
        throw new Error(raceMessage);
      }
      draftRef.current = next;
      setDraft(next);
      return next;
    });
  }, [enqueueReviewMutation]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setSendPayload(null);
    setSendResult(null);
    void (async () => {
      try {
        const stored = await loadReviewDraft(threadId);
        if (cancelled) return;
        let next = stored ?? createReviewDraft({ id: reviewId("review"), targetThreadId: threadId });
        if (next.frames.length === 0) {
          next = reviewDraftReducer(next, { type: "addFrame", frame: makeBlankReviewFrame(geometryForViewport()) });
        }
        await enqueueReviewMutation(() => saveReviewDraft(next));
        if (cancelled) return;
        draftRef.current = next;
        setDraft(next);
        setActiveFrameId(next.frames[0]?.id ?? null);
        void sweepReviewOrphanBlobs().catch(() => undefined);
      } catch (loadError) {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : "The review draft could not be opened.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enqueueReviewMutation, threadId]);

  const activeFrame = draft?.frames.find((frame) => frame.id === activeFrameId) ?? draft?.frames[0] ?? null;

  const selectFrame = (frameId: string) => {
    setActiveFrameId(frameId);
    setSurface("frame");
    setInputMode("smart");
  };

  const addFrame = (frame: ReviewFrame) => {
    const next = applyAction({ type: "addFrame", frame });
    if (next) selectFrame(frame.id);
  };

  const importFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    const importTarget = threadId;
    const input = event.currentTarget;
    const files = Array.from(input.files ?? []);
    for (const file of files) {
      try {
        if ((draftRef.current?.frames.length ?? REVIEW_LIMITS.frames) >= REVIEW_LIMITS.frames) {
          throw new RangeError(`A review may contain at most ${REVIEW_LIMITS.frames} frames`);
        }
        const prepared = await prepareReviewImage(file);
        const current = draftRef.current;
        if (targetThreadRef.current !== importTarget || current?.targetThreadId !== importTarget) {
          throw new Error("The selected Codex thread changed while importing media.");
        }
        const blobRef = reviewImageBlobRef(prepared.image);
        if (!blobRef) throw new Error("The image has no local media reference.");
        const frame = makePhotoReviewFrame(prepared.image, geometryForImage(prepared.image));
        const next = reviewDraftReducer(
          current,
          { type: "addFrame", frame },
          Math.max(Date.now(), current.updatedAt + 1),
        );
        await commitPreparedMedia(
          current,
          next,
          [{ id: blobRef, blob: prepared.blob }],
          "The review changed while the imported image was being saved. Import it again.",
        );
        selectFrame(frame.id);
      } catch (imageError) {
        setError(imageError instanceof Error ? imageError.message : "An image could not be imported.");
        if ((draftRef.current?.frames.length ?? 0) >= REVIEW_LIMITS.frames) break;
      }
    }
    // Keep WebKit's selected-file backing store alive until every async decode
    // and IndexedDB write has completed, then reset so the same file may be
    // selected again.
    input.value = "";
  };

  const captureSite = async () => {
    if (!allowedSiteUrl || capturing) return;
    const captureTarget = threadId;
    if ((draftRef.current?.frames.length ?? REVIEW_LIMITS.frames) >= REVIEW_LIMITS.frames) {
      setError(`A review may contain at most ${REVIEW_LIMITS.frames} frames`);
      return;
    }
    const currentSiteUrl = resolveAllowedSite(site ? { ...site, url: allowedSiteUrl.href } : null);
    if (!currentSiteUrl) {
      setError("The requested site route is outside the approved HTTPS origin.");
      return;
    }
    setCapturing(true);
    setError(null);
    const geometry = geometryForCaptureChoice(captureViewport);
    try {
      if (!onCaptureSite) {
        if (targetThreadRef.current !== captureTarget || draftRef.current?.targetThreadId !== captureTarget) {
          throw new Error("The selected Codex thread changed before capture completed.");
        }
        addFrame(makeSiteReviewFrame({ url: currentSiteUrl.href, title: site?.title ?? null, geometry }));
        setInputMode("annotate");
        setNotice("Saved URL, viewport, and scroll metadata. Screenshot capture is unavailable in this bridge mode.");
        return;
      }
      const captured = await onCaptureSite({
        url: currentSiteUrl.href,
        title: site?.title ?? null,
        viewport: geometry.viewport,
        scroll: geometry.scroll,
      });
      if (targetThreadRef.current !== captureTarget || draftRef.current?.targetThreadId !== captureTarget) {
        throw new Error("The selected Codex thread changed while the Mac captured this route.");
      }
      if (!site) throw new Error("The approved public site association is unavailable.");
      const finalUrl = publicCapturedSiteUrl(captured.finalPath, site.allowedOrigin);
      const capturedTitle = captured.title?.trim().slice(0, 500) || null;
      const blobRef = reviewImageBlobRef(captured.image);
      if (blobRef && !captured.blob && !(await getReviewBlob(blobRef))) {
        throw new Error("The Mac returned an unresolved screenshot reference.");
      }
      const current = draftRef.current;
      if (targetThreadRef.current !== captureTarget || current?.targetThreadId !== captureTarget) {
        throw new Error("The selected Codex thread changed while the Mac captured this route.");
      }
      const frame = makeSiteReviewFrame({
        url: finalUrl,
        title: capturedTitle,
        capturedImage: captured.image,
        geometry: captured.geometry ?? geometry,
      });
      const next = reviewDraftReducer(
        current,
        { type: "addFrame", frame },
        Math.max(Date.now(), current.updatedAt + 1),
      );
      await commitPreparedMedia(
        current,
        next,
        blobRef && captured.blob ? [{ id: blobRef, blob: captured.blob }] : [],
        "The review changed while the captured route was being saved. Capture it again.",
      );
      selectFrame(frame.id);
      setInputMode("annotate");
      setNotice("Captured a new review frame. Repeating capture keeps a distinct state, even at the same URL.");
    } catch (captureError) {
      setError(captureError instanceof Error ? captureError.message : "The site could not be captured.");
    } finally {
      setCapturing(false);
    }
  };

  const updateScene = (scene: Scene) => {
    const currentFrame = draftRef.current?.frames.find((frame) => frame.id === activeFrameId);
    if (!currentFrame) return;
    const action: ReviewDraftAction = {
      type: "updateFrame",
      frameId: currentFrame.id,
      patch: { drawing: { kind: "scene", scene } },
    };
    const renderedImage = currentFrame.drawing?.renderedImage;
    const renderedRef = renderedImage ? reviewImageBlobRef(renderedImage) : null;
    if (renderedRef) applyDeletion(action, [renderedRef]);
    else applyAction(action);
  };

  const annotationScene = useMemo(() => {
    if (activeFrame?.drawing?.kind === "scene") return activeFrame.drawing.scene;
    return createScene({
      width: activeFrame?.viewport.width ?? 1_024,
      height: activeFrame?.viewport.height ?? 768,
      background: "transparent",
    });
  }, [activeFrame]);

  const importAfter = async (event: ChangeEvent<HTMLInputElement>) => {
    const importTarget = threadId;
    const frameTarget = activeFrame;
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file || !frameTarget?.capturedImage || canCompareFrame(frameTarget)) {
      input.value = "";
      return;
    }
    try {
      const prepared = await prepareReviewImage(file);
      const current = draftRef.current;
      const currentFrame = current?.frames.find((frame) => frame.id === frameTarget.id);
      if (
        targetThreadRef.current !== importTarget
        || current?.targetThreadId !== importTarget
        || !currentFrame?.capturedImage
        || currentFrame.capturedImage.id !== frameTarget.capturedImage.id
        || canCompareFrame(currentFrame)
      ) {
        throw new Error("The selected Codex thread changed while importing the comparison.");
      }
      const blobRef = reviewImageBlobRef(prepared.image);
      if (!blobRef) throw new Error("The comparison image has no local reference.");
      const next = reviewDraftReducer(current, {
        type: "updateFrame",
        frameId: currentFrame.id,
        patch: { comparison: makeAfterComparison(currentFrame, prepared.image) },
      }, Math.max(Date.now(), current.updatedAt + 1));
      await commitPreparedMedia(
        current,
        next,
        [{ id: blobRef, blob: prepared.blob }],
        "The before frame changed while the comparison image was being saved. Import it again.",
      );
    } catch (comparisonError) {
      setError(comparisonError instanceof Error ? comparisonError.message : "The after image could not be imported.");
    } finally {
      input.value = "";
    }
  };

  const captureRegisteredRouteAsAfter = async () => {
    const captureDraft = draftRef.current;
    const frame = captureDraft?.frames.find((candidate) => candidate.id === activeFrameId);
    const approvedRoute = frame ? resolveRegisteredCaptureRoute(frame, site) : null;
    if (
      capturing
      || !onCaptureSite
      || !site
      || !captureDraft
      || !frame
      || !approvedRoute
      || canCompareFrame(frame)
    ) return;
    const captureTarget = threadId;
    setCapturing(true);
    setError(null);
    try {
      const captured = await onCaptureSite({
        url: approvedRoute.href,
        title: frame.title,
        viewport: frame.viewport,
        scroll: frame.scroll,
      });
      if (targetThreadRef.current !== captureTarget || draftRef.current?.targetThreadId !== captureTarget) {
        throw new Error("The selected Codex thread changed while the Mac captured the comparison.");
      }
      publicCapturedSiteUrl(captured.finalPath, site.allowedOrigin);
      const blobRef = reviewImageBlobRef(captured.image);
      if (blobRef && !captured.blob && !(await getReviewBlob(blobRef))) {
        throw new Error("The Mac returned an unresolved comparison screenshot reference.");
      }
      const current = draftRef.current;
      const currentFrame = current?.frames.find((candidate) => candidate.id === frame.id);
      if (
        targetThreadRef.current !== captureTarget
        || current?.targetThreadId !== captureTarget
        || !currentFrame?.capturedImage
        || currentFrame.capturedImage.id !== frame.capturedImage?.id
        || canCompareFrame(currentFrame)
      ) {
        throw new Error("The selected before frame changed before the comparison could be saved.");
      }
      const next = reviewDraftReducer(current, {
        type: "updateFrame",
        frameId: frame.id,
        patch: { comparison: makeAfterComparison(currentFrame, captured.image) },
      }, Math.max(Date.now(), current.updatedAt + 1));
      await commitPreparedMedia(
        current,
        next,
        blobRef && captured.blob ? [{ id: blobRef, blob: captured.blob }] : [],
        "The selected before frame changed before the comparison could be saved.",
      );
      setNotice("Captured the registered route as After in a fresh Mac browser context. Review it or store it as a new iteration.");
    } catch (comparisonError) {
      setError(comparisonError instanceof Error ? comparisonError.message : "The latest route could not be captured for comparison.");
    } finally {
      setCapturing(false);
    }
  };

  const prepareSend = async () => {
    const current = draftRef.current;
    if (!current || sendPreparing) return;
    setSendPreparing(true);
    setSendResult(null);
    setError(null);
    try {
      const flattenPlan = await flattenReviewDrawings(current);
      const flattened = flattenPlan.draft;
      if (targetThreadRef.current !== threadId || draftRef.current !== current) {
        throw new Error("The review changed while media was being prepared. Preview it again.");
      }
      if (flattened !== current) {
        await commitPreparedMedia(
          current,
          flattened,
          flattenPlan.blobWrites,
          "The review changed while annotation media was being saved. Preview it again.",
        );
      }
      const retainedIdentity = sendPayload === null
        ? await loadPendingReviewDeliveryIdentity(threadId, flattened.updatedAt)
        : null;
      const legacyCommandId = retainedIdentity === null && sendPayload === null
        ? await loadPendingReviewDelivery(threadId, flattened.updatedAt)
        : null;
      // A legacy marker retained only the command ID and cannot reproduce the
      // bridge fingerprint after a reload. Rotate it before any attempt rather
      // than creating a permanent COMMAND_ID_COLLISION loop.
      const commandId = sendPayload?.commandId
        ?? retainedIdentity?.commandId
        ?? createUuidV4();
      if (legacyCommandId !== null) {
        setNotice("Updated an older local retry marker before preparing this review. Nothing was sent automatically.");
      }
      const payload = await buildAtomicReviewSend({
        commandId,
        expectedBridgeInstanceId: retainedIdentity?.expectedBridgeInstanceId ?? bridgeInstanceId,
        activeThreadId: threadId,
        targetThreadKey: retainedIdentity?.targetThreadKey ?? threadKey,
        snapshotSeq: retainedIdentity?.snapshotSeq ?? snapshotSeq,
        draft: flattened,
        loadBlob: getReviewBlob,
        instructionSuffix: retainedIdentity?.instructionSuffix ?? instructionSuffix,
        skillIds: retainedIdentity?.skillIds ?? selectedSkillIds,
      });
      await savePendingReviewDelivery(threadId, flattened.updatedAt, payload.commandId, {
        expectedBridgeInstanceId: payload.expectedBridgeInstanceId,
        targetThreadKey: payload.targetThreadKey,
        snapshotSeq: payload.snapshotSeq,
        instructionSuffix: payload.instructionSuffix,
        skillIds: payload.skillIds,
      });
      if (targetThreadRef.current !== threadId || draftRef.current !== flattened) {
        throw new Error("The selected review changed before its delivery identity was saved.");
      }
      setSendPayload(payload);
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : "The review could not be prepared.");
    } finally {
      setSendPreparing(false);
    }
  };

  const confirmSend = async () => {
    if (!sendPayload || sending || !sendEnabled) return;
    const capabilityReason = reviewDeliveryLimitReason(reviewMaxImages, sendPayload.manifest.images.length);
    if (capabilityReason) {
      setSendResult({ ok: false, message: capabilityReason });
      return;
    }
    setSending(true);
    setSendResult(null);
    try {
      const result = await onSendReview(sendPayload);
      setSendResult(result);
      if (result.ok && result.pending !== true) {
        try {
          await clearPendingReviewDelivery(
            sendPayload.targetThreadId,
            sendPayload.draft.updatedAt,
            sendPayload.commandId,
          );
        } catch {
          setNotice("Review sent. Its local retry marker could not be cleared, but the command ID remains idempotent.");
        }
      }
    } catch {
      setSendResult({ ok: false, message: "Delivery is uncertain. Retry uses the same command ID." });
    } finally {
      setSending(false);
    }
  };

  const clearLocalReview = async () => {
    if (!sendPayload || sendResult?.ok !== true || sendResult.pending === true || clearing) return;
    const clearTarget = sendPayload.targetThreadId;
    setClearing(true);
    setError(null);
    try {
      const deleted = await enqueueReviewMutation(() => deleteReviewDraftIfUnchanged({
        draft: sendPayload.draft,
        commandId: sendPayload.commandId,
      }));
      if (!deleted) {
        throw new Error("This local review changed in another tab. Its newer draft, media, and delivery marker were preserved.");
      }
      if (targetThreadRef.current !== clearTarget) return;
      setSendPayload(null);
      setSendResult(null);
      if (onClose) {
        draftRef.current = null;
        setDraft(null);
        onClose();
        return;
      }
      let next = createReviewDraft({ id: reviewId("review"), targetThreadId: clearTarget });
      next = reviewDraftReducer(next, { type: "addFrame", frame: makeBlankReviewFrame(geometryForViewport()) });
      await enqueueReviewMutation(() => saveReviewDraft(next));
      draftRef.current = next;
      setDraft(next);
      setActiveFrameId(next.frames[0]?.id ?? null);
      setNotice("The sent local review was cleared. A new empty review is ready.");
    } catch (clearError) {
      setError(clearError instanceof Error ? clearError.message : "The local review could not be cleared.");
    } finally {
      setClearing(false);
    }
  };

  if (loading) return <section className="review-studio is-loading" aria-busy="true"><p>Opening the local review draft…</p></section>;
  if (!draft) return <section className="review-studio is-error"><p role="alert">{error ?? "The review is unavailable."}</p>{onClose && <button type="button" onClick={onClose}>Close</button>}</section>;

  const manifestPreviewState = (() => {
    try {
      return { manifest: createAtomicSendManifest(draft), error: null };
    } catch (previewError) {
      return {
        manifest: null,
        error: previewError instanceof Error
          ? previewError.message
          : "This review does not fit the atomic transport limit.",
      };
    }
  })();
  const manifestPreview = manifestPreviewState.manifest;
  const manifestDeliveryReason = manifestPreview
    ? reviewDeliveryLimitReason(reviewMaxImages, manifestPreview.images.length)
    : null;
  const liveCaptureAvailable = site?.captureCapability === "available" && Boolean(onCaptureSite);
  const registeredAfterRoute = activeFrame && !canCompareFrame(activeFrame)
    ? resolveRegisteredCaptureRoute(activeFrame, site)
    : null;
  const canCaptureRegisteredAfter = Boolean(onCaptureSite && registeredAfterRoute);

  return (
    <section className="review-studio" aria-label={`Multimodal review for ${threadTitle}`}>
      <style>{REVIEW_STYLES}</style>
      <header className="review-studio-header">
        <div>
          <span className="section-register">Nerva · Review</span>
          <h1>{threadTitle}</h1>
          <p>Exact agent thread <code>…{threadSuffix(threadId)}</code></p>
        </div>
        <div className="review-header-actions">
          <span className="review-draft-state">{draft.frames.length} frame{draft.frames.length === 1 ? "" : "s"} · saved locally</span>
          {onClose && <button type="button" onClick={onClose}>Close review</button>}
        </div>
      </header>

      {(error || notice || agentUpdated) && (
        <div className="review-status-stack">
          {(error || notice) && <div className={error ? "review-banner is-error" : "review-banner"} role={error ? "alert" : "status"}><span>{error ?? notice}</span><button type="button" aria-label="Dismiss message" onClick={() => { setError(null); setNotice(null); }}>×</button></div>}
          {agentUpdated && (
            <div className="review-update-banner" role="status">
              <strong>Agent updated — capture or import an after state.</strong>
              <span>Nothing was captured automatically, and no visual diff has been generated.</span>
            </div>
          )}
        </div>
      )}

      <div className="review-main-layout">
        <aside className="review-filmstrip" aria-label="Review frames">
          <header><span>Filmstrip</span><strong>{String(draft.frames.length).padStart(2, "0")}</strong></header>
          <ol>
            {draft.frames.map((frame, index) => (
              <li key={frameIdentityKey(frame)} className={frame.id === activeFrame?.id ? "is-active" : ""}>
                <button type="button" className="review-frame-select" aria-current={frame.id === activeFrame?.id ? "true" : undefined} onClick={() => selectFrame(frame.id)}>
                  <span className="review-frame-index">{String(index + 1).padStart(2, "0")}</span>
                  {frame.capturedImage ? <ReviewImagePreview image={frame.capturedImage} alt="" className="review-frame-thumb" /> : <span className="review-frame-blank" aria-hidden="true">＋</span>}
                  <span><strong>{frame.title ?? "Untitled"}</strong><small>{frame.url ? new URL(frame.url).pathname : frame.kind.replace("-", " ")} · {frame.id.slice(-5)}</small></span>
                </button>
                <div className="review-frame-order">
                  <button type="button" aria-label={`Move frame ${index + 1} earlier`} disabled={readOnly || index === 0} onClick={() => applyAction({ type: "reorderFrame", frameId: frame.id, toIndex: index - 1 })}>↑</button>
                  <button type="button" aria-label={`Move frame ${index + 1} later`} disabled={readOnly || index === draft.frames.length - 1} onClick={() => applyAction({ type: "reorderFrame", frameId: frame.id, toIndex: index + 1 })}>↓</button>
                </div>
              </li>
            ))}
          </ol>
          <div className="review-add-menu">
            <button type="button" disabled={readOnly} onClick={() => addFrame(makeBlankReviewFrame(geometryForViewport()))}>Blank frame</button>
            <label><span>Photo / Files</span><input type="file" accept={PHOTO_IMPORT_ACCEPT} multiple disabled={readOnly} onChange={importFiles} /></label>
            <label><span>Camera</span><input type="file" accept={PHOTO_IMPORT_ACCEPT} capture="environment" disabled={readOnly} onChange={importFiles} /></label>
          </div>
        </aside>

        <main className="review-workbench">
          <div className="review-surface-controls">
            {allowedSiteUrl && (
              <div className="review-surface-switch" role="group" aria-label="Review surface">
                <button type="button" aria-pressed={surface === "live"} className={surface === "live" ? "is-active" : ""} onClick={() => { setSurface("live"); setInputMode("interact"); }}>Registered site</button>
                <button type="button" aria-pressed={surface === "frame"} className={surface === "frame" ? "is-active" : ""} onClick={() => { setSurface("frame"); setInputMode("smart"); }}>Saved frame</button>
              </div>
            )}
            {surface === "frame" && <div className="review-input-modes" role="group" aria-label="Pointer behavior">
              {(["smart", "interact", "annotate"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  aria-pressed={inputMode === mode}
                  className={inputMode === mode ? "is-active" : ""}
                  onClick={() => setInputMode(mode)}
                >
                  {mode === "smart" ? "Pencil draws · finger navigates" : mode === "interact" ? "Inspect saved image" : "Annotate lock"}
                </button>
              ))}
            </div>}
          </div>

          {!allowedSiteUrl && (
            <section className="review-site-setup" aria-label="Site review setup">
              <span aria-hidden="true">◎</span>
              <div>
                <strong>No site is linked to this task yet.</strong>
                <p>Import a screenshot with Photo / Files or Camera, then annotate, compare, and send it to this exact Codex task.</p>
              </div>
              <small>A registered Mac site will appear here after it has been explicitly linked. Nerva never guesses from a title, URL resemblance, or the foreground tab.</small>
            </section>
          )}

          {surface === "live" && allowedSiteUrl ? (
            <section className="review-live-site" aria-label="Registered site context">
              <div className="review-site-modes is-isolated">
                <div className="review-site-mode-heading">
                  <span>Registered site context</span>
                  <strong>{site?.title ?? allowedSiteUrl.hostname}</strong>
                </div>
                <p><strong>Live preview unavailable on shared host; import a screenshot/photo.</strong> Nerva does not embed this origin or open it in a new tab, preventing site cookies from interfering with the bridge.</p>
                <p className="review-site-route"><span>Registered route</span><code>{allowedSiteUrl.origin}{allowedSiteUrl.pathname}{allowedSiteUrl.search}</code></p>
              </div>
              <div className="review-capture-state is-degraded">
                <span>{liveCaptureAvailable ? "Fresh Mac route capture · no live iPad preview" : "Mac route capture unavailable"}</span>
                <p>{site?.captureDetail ?? (liveCaptureAvailable ? "Capture opens only the registered route in a fresh Mac browser context. No site document, storage, redirect, or interacted state is loaded into this iPad app." : "Use Photo / Files or Camera to import a screenshot, then annotate it locally. Nothing from the registered site is loaded or captured automatically.")}</p>
                {liveCaptureAvailable && (
                  <>
                    <label className="review-capture-viewport">
                      <span>Capture viewport</span>
                      <select value={captureViewport} onChange={(event) => setCaptureViewport(event.target.value as CaptureViewportChoice)}>
                        <option value="current">Current iPad</option>
                        <option value="ipad-landscape">iPad landscape</option>
                        <option value="ipad-portrait">iPad portrait</option>
                        <option value="mobile-portrait">Mobile portrait</option>
                        <option value="desktop-wide">Desktop wide</option>
                      </select>
                    </label>
                    <button type="button" disabled={readOnly || capturing} onClick={() => void captureSite()}>{capturing ? "Capturing…" : "Capture registered route"}</button>
                  </>
                )}
              </div>
              <p className="review-sandbox-note">The registered address is context only: there is no iframe, direct navigation, popup, or shared browser storage. Capture or import an image, then annotate the saved frame.</p>
            </section>
          ) : activeFrame ? (
            <section className="review-frame-editor" aria-label={`Editing frame ${activeFrame.title ?? activeFrame.id}`}>
              <div className="review-frame-stage">
                {activeFrame.capturedImage ? <ReviewImagePreview image={activeFrame.capturedImage} alt={imageAlt(activeFrame)} className="review-frame-background" /> : <div className="review-blank-paper"><span>Blank review canvas</span></div>}
                {inputMode !== "interact" && (
                  <DrawingCanvasEditor
                    className="review-drawing-layer"
                    scene={annotationScene}
                    pencilOnly={inputMode === "smart"}
                    readOnly={readOnly}
                    onSceneChange={updateScene}
                  />
                )}
                {inputMode === "interact" && <div className="review-static-interact-note">This is a saved image, not a live page. Switch to Annotate to draw.</div>}
              </div>
              <div className="review-frame-details">
                <label><span>Frame title</span><input value={activeFrame.title ?? ""} maxLength={500} disabled={readOnly} onChange={(event) => applyAction({ type: "updateFrame", frameId: activeFrame.id, patch: { title: event.target.value || null } })} /></label>
                <label><span>Captured URL</span><input type="url" value={activeFrame.url ?? ""} placeholder="No site URL" readOnly aria-readonly="true" /></label>
                <div className="review-frame-metadata"><span>{activeFrame.viewport.width} × {activeFrame.viewport.height} @ {activeFrame.viewport.deviceScaleFactor}×</span><span>scroll {Math.round(activeFrame.scroll.x)}, {Math.round(activeFrame.scroll.y)}</span><span>ID …{activeFrame.id.slice(-7)}</span></div>
                <label><span>Instruction for this frame · {activeFrame.instruction.length}/180</span><textarea value={activeFrame.instruction} maxLength={180} disabled={readOnly} placeholder="What should Codex notice or change here?" onChange={(event) => applyAction({ type: "updateFrame", frameId: activeFrame.id, patch: { instruction: event.target.value } })} /></label>
                <div className="review-frame-actions">
                  {activeFrame.capturedImage && !canCompareFrame(activeFrame) && <label className="review-after-import"><span>Import after image</span><input type="file" accept={PHOTO_IMPORT_ACCEPT} disabled={readOnly} onChange={importAfter} /></label>}
                  {canCaptureRegisteredAfter && <button type="button" disabled={readOnly || capturing} onClick={() => void captureRegisteredRouteAsAfter()}>{capturing ? "Capturing registered route…" : "Capture registered route as After"}</button>}
                  <button type="button" disabled={readOnly || draft.frames.length <= 1} onClick={() => {
                    applyDeletion({ type: "deleteFrame", frameId: activeFrame.id }, reviewFrameBlobRefs(activeFrame));
                    const fallback = draft.frames.find((frame) => frame.id !== activeFrame.id);
                    if (fallback) setActiveFrameId(fallback.id);
                  }}>Delete frame</button>
                </div>
              </div>
              {canCompareFrame(activeFrame) && <ComparisonPanel frame={activeFrame} readOnly={readOnly} onMode={(mode) => applyAction({ type: "updateFrame", frameId: activeFrame.id, patch: { comparison: { ...activeFrame.comparison, mode } } })} onStoreIteration={() => addFrame(makeIterationFrame(activeFrame))} />}
            </section>
          ) : <p>No frame selected.</p>}
        </main>

        <aside className="review-notes" aria-label="Review instruction">
          <section className="review-general-instruction">
            <label><span>General instruction · {draft.generalInstruction.length}/1400</span><textarea value={draft.generalInstruction} maxLength={1_400} disabled={readOnly} placeholder="Optional direction for the complete review" onChange={(event) => applyAction({ type: "setGeneralInstruction", instruction: event.target.value })} /></label>
          </section>

          <section className="review-send-dock">
            <div><strong>{manifestPreview?.images.length ?? "—"}</strong><span>images</span></div>
            <button type="button" disabled={readOnly || sendPreparing || manifestPreview === null} onClick={() => void prepareSend()}>{sendPreparing ? "Preparing media…" : "Preview atomic send"}</button>
            {manifestPreviewState.error && <small>{manifestPreviewState.error}</small>}
            {!sendEnabled && <small>Local editing and preview stay available; bridge delivery is currently disabled.</small>}
            {sendEnabled && manifestDeliveryReason && <small>{manifestDeliveryReason} Multi-image input has not been verified for this connection.</small>}
          </section>
        </aside>
      </div>

      {sendPayload && <SendSheet payload={sendPayload} targetLabel={threadTitle} sendEnabled={sendEnabled} reviewMaxImages={reviewMaxImages} sending={sending} clearing={clearing} result={sendResult} onCancel={() => { if (!sending && !clearing) { setSendPayload(null); setSendResult(null); } }} onConfirm={() => void confirmSend()} onClear={() => void clearLocalReview()} />}
    </section>
  );
}
