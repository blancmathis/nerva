import {
  PencilPointerTracker,
  applySceneOperation,
  createEraserElement,
  createHistory,
  createImageElement,
  createScene,
  createShapeElement,
  createStrokeElement,
  createTextElement,
  deserializeScene,
  historyReducer,
  pointerSamples,
  serializeScene,
  type BackgroundMode,
  type Scene,
  type SceneElement,
  type ScenePoint,
  type ShapeKind,
} from "@codex-pad/drawing";
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ChangeEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import {
  deleteDrawingDraft,
  loadDrawingDraft,
  saveDrawingDraft,
} from "../lib/draft-store";
import { createUuidV4 } from "../lib/uuid";
import {
  bindingMatchesDrawingDraft,
  createDrawingDeliveryIdentity,
  deletePendingDrawingDelivery,
  loadPendingDrawingDelivery,
  savePendingDrawingDelivery,
  type PendingDrawingDeliveryBinding,
} from "../lib/drawing-delivery-store";
import { PHOTO_IMPORT_ACCEPT } from "../lib/heic-image";
import {
  drawingDeliveryIsUnresolved,
  type DrawingDeliveryStatus,
} from "./drawing-delivery";
import { exportSceneToBoundedPng } from "./drawing-export";
import {
  createGestureAnchor,
  solvePinchView,
  type GestureAnchor,
} from "./drawing-gesture";
import {
  blobToBase64,
  fitImageInside,
  prepareImportedImage,
} from "./drawing-image";
import {
  renderDrawingCanvas,
  screenTransform,
  type CanvasView,
  type DrawingPreview,
} from "./drawing-renderer";
import {
  evaluateSendGuard,
  isExactDrawingTarget,
  sameDrawingTarget,
  type DrawingTarget,
} from "./drawing-target";

export type { DrawingTarget } from "./drawing-target";

export type DrawingSendStatus = "idle" | "sending" | "sent" | "error";

export interface DrawingSendPayload {
  commandId: string;
  expectedBridgeInstanceId: string;
  slotId: string;
  threadId: string;
  threadKey: string;
  snapshotSeq: number;
  expectedSnapshotSeq: number;
  instruction: string;
  png: Blob;
  pngBase64: string;
  scene: unknown;
  background: BackgroundMode;
}

export interface DrawingSendResult {
  ok: boolean;
  message?: string;
  /** True when the client timed out and must retry with the same command ID. */
  deliveryUnknown?: boolean;
  /** CommandAck compatibility: a failed pending result is also unresolved. */
  pending?: boolean;
}

export interface DrawingKeepPayload {
  sourceThreadId: string;
  sourceThreadTitle: string;
  instruction: string;
  pngBase64: string;
  sceneJson: string;
  background: BackgroundMode;
  width: number;
  height: number;
}

export interface SavedDrawingWorkingCopy {
  id: string;
  sceneJson: string;
  instruction: string;
}

export interface DrawingStudioProps {
  open: boolean;
  target: DrawingTarget | null;
  /** Opens the existing bounded image importer for the Session Photo action. */
  importOnOpen?: boolean;
  /** Opens a Mac-kept drawing as an independent local working copy. */
  initialSavedDrawing?: SavedDrawingWorkingCopy | null;
  connected?: boolean;
  readOnly?: boolean;
  sending?: boolean;
  sendStatus?: DrawingSendStatus;
  statusMessage?: string | null;
  onClose: () => void;
  onSend: (
    payload: DrawingSendPayload,
  ) => void | DrawingSendResult | Promise<void | DrawingSendResult>;
  onKeep?: (payload: DrawingKeepPayload) => Promise<DrawingSendResult>;
  onReconcileDelivery?: (
    commandId: string,
  ) => Promise<DrawingDeliveryStatus | null>;
}

export interface DrawingCanvasEditorProps {
  scene: Scene;
  onSceneChange: (scene: Scene) => void;
  pencilOnly?: boolean;
  className?: string;
  readOnly?: boolean;
}

type Tool = "pen" | "marker" | "eraser" | "arrow" | "rectangle" | "ellipse" | "text" | "pan";

interface DrawInteraction {
  pointerId: number;
  tool: Exclude<Tool, "text" | "pan">;
  start: ScenePoint;
  points: ScenePoint[];
}

interface TrackedCanvasPointer {
  x: number;
  y: number;
  type: string;
}

interface ExportPreview {
  commandId: string;
  targetSnapshotSeq: number;
  lockedInstruction: string | null;
  blob: Blob;
  pngBase64: string;
}

const CANVAS_WIDTH = 1_440;
const CANVAS_HEIGHT = 900;
const DARK_BACKGROUND = "#151b20";
const INITIAL_VIEW: CanvasView = { zoom: 1, panX: 0, panY: 0 };
const MIN_ZOOM = 0.55;
const MAX_ZOOM = 4;

const DIALOG_FOCUSABLE = [
  "button:not([disabled])",
  "a[href]",
  "input:not([disabled])",
  "textarea:not([disabled])",
  "select:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

interface ContainedDialogOptions {
  readonly active: boolean;
  readonly suspended?: boolean;
  readonly dialogRef: RefObject<HTMLElement | null>;
  readonly initialFocusRef?: RefObject<HTMLElement | null>;
  readonly restoreFallbackRef?: RefObject<HTMLElement | null>;
  readonly escapeAllowed?: boolean;
  readonly onEscape: () => void;
  readonly onEscapeBlocked?: () => void;
}

function useContainedDialog({
  active,
  suspended = false,
  dialogRef,
  initialFocusRef,
  restoreFallbackRef,
  escapeAllowed = true,
  onEscape,
  onEscapeBlocked,
}: ContainedDialogOptions) {
  const suspendedRef = useRef(suspended);
  const escapeAllowedRef = useRef(escapeAllowed);
  const onEscapeRef = useRef(onEscape);
  const onEscapeBlockedRef = useRef(onEscapeBlocked);
  suspendedRef.current = suspended;
  escapeAllowedRef.current = escapeAllowed;
  onEscapeRef.current = onEscape;
  onEscapeBlockedRef.current = onEscapeBlocked;

  useEffect(() => {
    if (!active) return;
    const previous = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const dialog = dialogRef.current;
    const initial = initialFocusRef?.current
      ?? dialog?.querySelector<HTMLElement>(DIALOG_FOCUSABLE)
      ?? dialog;
    initial?.focus();

    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      const currentDialog = dialogRef.current;
      if (!currentDialog || suspendedRef.current) return;
      if (event.key === "Escape") {
        event.preventDefault();
        if (escapeAllowedRef.current) onEscapeRef.current();
        else onEscapeBlockedRef.current?.();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(currentDialog.querySelectorAll<HTMLElement>(DIALOG_FOCUSABLE));
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) {
        event.preventDefault();
        currentDialog.focus();
        return;
      }
      const focused = document.activeElement;
      if (!currentDialog.contains(focused)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && (focused === first || focused === currentDialog)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (focused === last || focused === currentDialog)) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      const restore = () => {
        if (previous?.isConnected && !previous.matches(":disabled")) previous.focus();
        else restoreFallbackRef?.current?.focus();
      };
      // Building a nested preview can leave its trigger disabled for the
      // closing commit. Give React one frame to clear that transient state
      // before falling back to the canvas.
      if (previous?.isConnected && previous.matches(":disabled")) {
        window.requestAnimationFrame(restore);
      } else {
        restore();
      }
    };
  }, [active, dialogRef, initialFocusRef, restoreFallbackRef]);
}

const TOOLS: readonly { id: Tool; label: string; short: string }[] = [
  { id: "pen", label: "Pen", short: "Pen" },
  { id: "marker", label: "Highlighter", short: "Mark" },
  { id: "eraser", label: "Eraser", short: "Erase" },
  { id: "arrow", label: "Arrow", short: "Arrow" },
  { id: "rectangle", label: "Rectangle", short: "Rect" },
  { id: "ellipse", label: "Ellipse", short: "Oval" },
  { id: "text", label: "Text label", short: "Text" },
  { id: "pan", label: "Pan canvas", short: "Move" },
] as const;

const COLORS = [
  { name: "Graphite", value: "#172125" },
  { name: "Cobalt", value: "#2764f4" },
  { name: "Tide", value: "#087f78" },
  { name: "Amber", value: "#d78922" },
  { name: "Coral", value: "#dc574b" },
  { name: "Chalk", value: "#f5f1e8" },
] as const;

const SIZES = [
  { label: "Fine", value: 3 },
  { label: "Regular", value: 7 },
  { label: "Bold", value: 14 },
  { label: "Wide", value: 28 },
] as const;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function freshHistory(background: BackgroundMode = "white") {
  return createHistory(
    createScene({
      width: CANVAS_WIDTH,
      height: CANVAS_HEIGHT,
      background: { mode: background, color: DARK_BACKGROUND },
    }),
  );
}

function gestureMetrics(points: readonly { x: number; y: number }[]): {
  centerX: number;
  centerY: number;
  distance: number;
} {
  const first = points[0] ?? { x: 0, y: 0 };
  const second = points[1] ?? first;
  return {
    centerX: (first.x + second.x) / 2,
    centerY: (first.y + second.y) / 2,
    distance: Math.max(1, Math.hypot(second.x - first.x, second.y - first.y)),
  };
}

function beginTwoFingerPencilNavigation(
  event: ReactPointerEvent<HTMLCanvasElement>,
  pointers: Map<number, TrackedCanvasPointer>,
  gesturePointers: Map<number, { x: number; y: number }>,
  resetGestureStart: () => void,
): void {
  event.preventDefault();
  const existingTouches = [...pointers.entries()].filter(([, pointer]) => pointer.type === "touch");
  // A third finger or palm must not perturb an established two-finger gesture.
  if (existingTouches.length >= 2) return;
  pointers.set(event.pointerId, {
    x: event.clientX,
    y: event.clientY,
    type: "touch",
  });
  const touches = [...pointers.entries()].filter(([, pointer]) => pointer.type === "touch");
  // One finger remains passive in Pencil mode. This is the palm-rejection
  // boundary: do not capture it, pan, draw, or cancel an active pen pointer.
  if (touches.length < 2) return;
  gesturePointers.clear();
  for (const [pointerId, pointer] of touches.slice(0, 2)) {
    try { event.currentTarget.setPointerCapture(pointerId); } catch { /* WebKit can reject a late capture. */ }
    gesturePointers.set(pointerId, { x: pointer.x, y: pointer.y });
  }
  resetGestureStart();
}

function clearTouchPointersForPen(
  event: ReactPointerEvent<HTMLCanvasElement>,
  pointers: Map<number, TrackedCanvasPointer>,
  gesturePointers: Map<number, { x: number; y: number }>,
): void {
  for (const [pointerId, pointer] of pointers) {
    if (pointer.type !== "touch") continue;
    try { event.currentTarget.releasePointerCapture(pointerId); } catch { /* Palm may already be cancelled. */ }
    pointers.delete(pointerId);
  }
  gesturePointers.clear();
}

function toolPreview(interaction: DrawInteraction, color: string, size: number): DrawingPreview {
  if (interaction.tool === "arrow" || interaction.tool === "rectangle" || interaction.tool === "ellipse") {
    const current = interaction.points.at(-1) ?? interaction.start;
    return {
      shape: interaction.tool,
      x: interaction.start.x,
      y: interaction.start.y,
      width: current.x - interaction.start.x,
      height: current.y - interaction.start.y,
      color,
      size,
    };
  }
  return {
    kind: interaction.tool === "eraser" ? "eraser" : "stroke",
    tool: interaction.tool,
    color,
    size: interaction.tool === "eraser" ? size * 2.6 : size,
    points: interaction.points,
  };
}

function elementFromInteraction(
  interaction: DrawInteraction,
  color: string,
  size: number,
): SceneElement | null {
  const points = interaction.points;
  if (points.length === 0) return null;
  if (interaction.tool === "pen" || interaction.tool === "marker") {
    return createStrokeElement({
      id: elementId(),
      tool: interaction.tool,
      color,
      size,
      points,
    });
  }
  if (interaction.tool === "eraser") {
    return createEraserElement({ id: elementId(), size: size * 2.6, points });
  }
  const end = points.at(-1) ?? interaction.start;
  if (Math.hypot(end.x - interaction.start.x, end.y - interaction.start.y) < 3) return null;
  return createShapeElement({
    id: elementId(),
    shape: interaction.tool as ShapeKind,
    x: interaction.start.x,
    y: interaction.start.y,
    width: end.x - interaction.start.x,
    height: end.y - interaction.start.y,
    strokeColor: color,
    strokeWidth: size,
  });
}

function elementId(): string {
  return createUuidV4();
}

function commandId(): string {
  return createUuidV4();
}

function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
}

function toolGlyph(tool: Tool): string {
  switch (tool) {
    case "pen":
      return "╱";
    case "marker":
      return "▰";
    case "eraser":
      return "◇";
    case "arrow":
      return "↗";
    case "rectangle":
      return "□";
    case "ellipse":
      return "○";
    case "text":
      return "T";
    case "pan":
      return "✥";
  }
}

export function DrawingStudio({
  open,
  target,
  importOnOpen = false,
  initialSavedDrawing = null,
  connected = true,
  readOnly = false,
  sending = false,
  sendStatus = "idle",
  statusMessage = null,
  onClose,
  onSend,
  onKeep,
  onReconcileDelivery,
}: DrawingStudioProps) {
  const [displayedTarget, setDisplayedTarget] = useState<DrawingTarget | null>(null);
  const [history, dispatchHistory] = useReducer(historyReducer, undefined, () => freshHistory());
  const [tool, setTool] = useState<Tool>("pen");
  const [color, setColor] = useState<string>(COLORS[0].value);
  const [size, setSize] = useState<number>(SIZES[1].value);
  const [instruction, setInstruction] = useState("");
  const [textValue, setTextValue] = useState("Label");
  const [pencilOnly, setPencilOnly] = useState(true);
  const [view, setView] = useState<CanvasView>(INITIAL_VIEW);
  const [drawingPreview, setDrawingPreview] = useState<DrawingPreview>(null);
  const [canvasRevision, setCanvasRevision] = useState(0);
  const [draftReady, setDraftReady] = useState(false);
  const [draftMessage, setDraftMessage] = useState<string | null>(null);
  const [keepMessage, setKeepMessage] = useState<string | null>(null);
  const [localSending, setLocalSending] = useState(false);
  const [localKeeping, setLocalKeeping] = useState(false);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [sendAfterBuild, setSendAfterBuild] = useState(false);
  const [exportPreview, setExportPreview] = useState<ExportPreview | null>(null);
  const [clearPending, setClearPending] = useState(false);
  const [importSourceOpen, setImportSourceOpen] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [pendingDelivery, setPendingDelivery] =
    useState<PendingDrawingDeliveryBinding | null>(null);
  const [pendingDeliveryMatchesDraft, setPendingDeliveryMatchesDraft] = useState(false);
  const [reconcilingDelivery, setReconcilingDelivery] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const cameraInputRef = useRef<HTMLInputElement | null>(null);
  const filesInputRef = useRef<HTMLInputElement | null>(null);
  const importRequestedRef = useRef(false);
  const studioDialogRef = useRef<HTMLElement | null>(null);
  const clearDialogRef = useRef<HTMLElement | null>(null);
  const importDialogRef = useRef<HTMLElement | null>(null);
  const clearCancelRef = useRef<HTMLButtonElement | null>(null);
  const importCancelRef = useRef<HTMLButtonElement | null>(null);
  const wasOpenRef = useRef(false);
  const drawInteractionRef = useRef<DrawInteraction | null>(null);
  const gesturePointersRef = useRef(new Map<number, { x: number; y: number }>());
  const allPointersRef = useRef(new Map<number, TrackedCanvasPointer>());
  const gestureStartRef = useRef<GestureAnchor | null>(null);
  const penActiveRef = useRef(false);
  const trackerRef = useRef<PencilPointerTracker | null>(null);
  const draftPersistenceBlockedRef = useRef(false);
  const draftMutationQueueRef = useRef<Promise<void>>(Promise.resolve());
  const studioGenerationRef = useRef(0);
  const onCloseRef = useRef(onClose);
  const onReconcileDeliveryRef = useRef(onReconcileDelivery);
  onCloseRef.current = onClose;
  onReconcileDeliveryRef.current = onReconcileDelivery;

  const enqueueDraftMutation = useCallback((mutation: () => Promise<void>): Promise<void> => {
    const next = draftMutationQueueRef.current
      .catch(() => undefined)
      .then(mutation);
    draftMutationQueueRef.current = next.catch(() => undefined);
    return next;
  }, []);

  useEffect(() => {
    if (!open) {
      importRequestedRef.current = false;
      return;
    }
    if (!importOnOpen || importRequestedRef.current) return;
    importRequestedRef.current = true;
    setImportSourceOpen(true);
  }, [importOnOpen, open]);

  if (!trackerRef.current) {
    trackerRef.current = new PencilPointerTracker({
      onPointerCancelled(pointerId) {
        if (drawInteractionRef.current?.pointerId === pointerId) {
          drawInteractionRef.current = null;
          setDrawingPreview(null);
        }
      },
    });
  }

  useContainedDialog({
    active: open,
    suspended: clearPending || importSourceOpen,
    dialogRef: studioDialogRef,
    initialFocusRef: canvasRef,
    escapeAllowed: pendingDelivery === null,
    onEscape: onClose,
    onEscapeBlocked: () => setLocalError(
      "Delivery is unresolved. Retry with the same delivery ID before leaving.",
    ),
  });
  useContainedDialog({
    active: importSourceOpen,
    dialogRef: importDialogRef,
    initialFocusRef: importCancelRef,
    restoreFallbackRef: canvasRef,
    escapeAllowed: true,
    onEscape: () => setImportSourceOpen(false),
  });
  useContainedDialog({
    active: clearPending,
    dialogRef: clearDialogRef,
    initialFocusRef: clearCancelRef,
    restoreFallbackRef: canvasRef,
    escapeAllowed: true,
    onEscape: () => setClearPending(false),
  });

  const scene = history.present;
  const sceneRef = useRef(scene);
  const unmountDraftRef = useRef({
    displayedTarget,
    draftReady,
    instruction,
    pencilOnly,
    scene,
    color,
    size,
  });
  unmountDraftRef.current = {
    displayedTarget,
    draftReady,
    instruction,
    pencilOnly,
    scene,
    color,
    size,
  };

  useEffect(() => () => {
    const latest = unmountDraftRef.current;
    if (
      draftPersistenceBlockedRef.current
      || !latest.draftReady
      || !latest.displayedTarget
      || !isExactDrawingTarget(latest.displayedTarget)
    ) return;
    const interaction = drawInteractionRef.current;
    const element = interaction
      ? elementFromInteraction(interaction, latest.color, latest.size)
      : null;
    const sceneToSave = element
      ? applySceneOperation(latest.scene, { type: "add", element })
      : latest.scene;
    void enqueueDraftMutation(async () => {
      if (draftPersistenceBlockedRef.current) return;
      await saveDrawingDraft(latest.displayedTarget!.threadId, {
        scene: serializeScene(sceneToSave),
        instruction: latest.instruction,
        background: sceneToSave.background.mode,
        pencilOnly: latest.pencilOnly,
      });
    });
  }, [enqueueDraftMutation]);

  useEffect(() => {
    setKeepMessage(null);
  }, [scene]);
  sceneRef.current = scene;
  const currentSending = sending || localSending;
  const editorLocked = readOnly || pendingDelivery !== null;
  const pendingDeliveryMatchesTarget = pendingDelivery === null || Boolean(
    displayedTarget
    && pendingDelivery.expectedBridgeInstanceId === displayedTarget.bridgeInstanceId
    && pendingDelivery.slotId === displayedTarget.slotId
    && pendingDelivery.threadId === displayedTarget.threadId.toLowerCase()
    && pendingDelivery.threadKey === (displayedTarget.threadKey ?? displayedTarget.threadId),
  );
  const pendingDeliveryRetryable = pendingDelivery !== null
    && pendingDeliveryMatchesDraft
    && pendingDeliveryMatchesTarget;
  const hasContent = scene.elements.length > 0;
  const sendGuard = useMemo(
    () =>
      evaluateSendGuard({
        connected,
        displayedTarget,
        currentTarget: target,
        instruction,
        hasContent,
        readOnly,
        sending: currentSending,
      }),
    [connected, currentSending, displayedTarget, hasContent, instruction, readOnly, target],
  );

  const resetPointerState = useCallback(() => {
    trackerRef.current?.releaseAll();
    drawInteractionRef.current = null;
    gesturePointersRef.current.clear();
    allPointersRef.current.clear();
    gestureStartRef.current = null;
    penActiveRef.current = false;
    setDrawingPreview(null);
  }, []);

  const clearDeliveryBinding = useCallback((threadId: string) => {
    deletePendingDrawingDelivery(threadId);
    setPendingDelivery((current) => current?.threadId === threadId ? null : current);
    setPendingDeliveryMatchesDraft(false);
  }, []);

  const discardDeliveredDraft = useCallback(async (threadId: string) => {
    draftPersistenceBlockedRef.current = true;
    setDraftReady(false);
    resetPointerState();
    await enqueueDraftMutation(() => deleteDrawingDraft(threadId));
  }, [enqueueDraftMutation, resetPointerState]);

  const reconcileDelivery = useCallback(async (
    binding: PendingDrawingDeliveryBinding,
  ): Promise<"unknown" | "pending" | "succeeded" | "failed"> => {
    const generation = studioGenerationRef.current;
    const reconcile = onReconcileDeliveryRef.current;
    if (!reconcile) return "unknown";
    setReconcilingDelivery(true);
    try {
      const result = await reconcile(binding.commandId);
      const isCurrentGeneration = generation === studioGenerationRef.current;
      if (!result || result.state === "unknown") {
        if (isCurrentGeneration) {
          setDraftMessage("Previous sketch outcome is unknown; retry will keep its delivery ID");
        }
        return "unknown";
      }
      if (result.state === "pending") {
        if (isCurrentGeneration) {
          setDraftMessage(result.message ?? "Previous sketch is still in flight and was not resent");
        }
        return "pending";
      }

      if (result.ok) {
        await discardDeliveredDraft(binding.threadId);
        clearDeliveryBinding(binding.threadId);
        if (generation === studioGenerationRef.current) {
          setDraftMessage(result.message ?? "Previous sketch delivery completed");
          setExportPreview(null);
          window.setTimeout(() => {
            if (generation === studioGenerationRef.current) onCloseRef.current();
          }, 360);
        }
        return "succeeded";
      }
      clearDeliveryBinding(binding.threadId);
      if (isCurrentGeneration) {
        setDraftMessage(result.message ?? "Previous sketch was definitively rejected; a new delivery is now allowed");
      }
      return "failed";
    } catch {
      if (generation === studioGenerationRef.current) {
        setDraftMessage("Previous sketch status is unavailable; retry will keep its delivery ID");
      }
      return "unknown";
    } finally {
      if (generation === studioGenerationRef.current) setReconcilingDelivery(false);
    }
  }, [clearDeliveryBinding, discardDeliveredDraft]);

  useEffect(() => {
    if (open && !wasOpenRef.current) {
      studioGenerationRef.current += 1;
      draftPersistenceBlockedRef.current = false;
      resetPointerState();
      dispatchHistory({ type: "reset", scene: freshHistory().present });
      setInstruction("");
      setDraftReady(false);
      setView(INITIAL_VIEW);
      setDisplayedTarget(target ? { ...target } : null);
    } else if (!open && wasOpenRef.current) {
      studioGenerationRef.current += 1;
      resetPointerState();
      dispatchHistory({ type: "reset", scene: freshHistory().present });
      setInstruction("");
      setDraftReady(false);
      setDisplayedTarget(null);
      setExportPreview(null);
      setSendAfterBuild(false);
      setClearPending(false);
      setImportSourceOpen(false);
      setLocalError(null);
      setPendingDelivery(null);
      setPendingDeliveryMatchesDraft(false);
      setReconcilingDelivery(false);
    }
    wasOpenRef.current = open;
  }, [open, resetPointerState, target]);

  useEffect(() => {
    if (!open || !displayedTarget || !isExactDrawingTarget(displayedTarget)) {
      setDraftReady(false);
      return;
    }
    const generation = studioGenerationRef.current;
    let active = true;
    const isCurrentGeneration = () => active && generation === studioGenerationRef.current;
    setDraftReady(false);
    setDraftMessage("Loading saved page…");
    setView(INITIAL_VIEW);
    setExportPreview(null);
    const storedDelivery = loadPendingDrawingDelivery(displayedTarget.threadId);
    setPendingDelivery(storedDelivery);
    setPendingDeliveryMatchesDraft(false);
    if (storedDelivery) {
      setDraftMessage("Checking the previous sketch delivery before any retry…");
    }
    const drawingSource = initialSavedDrawing
      ? Promise.resolve({
          scene: initialSavedDrawing.sceneJson,
          instruction: initialSavedDrawing.instruction,
          background: "white" as BackgroundMode,
          pencilOnly: true,
          savedWorkingCopy: true,
        })
      : loadDrawingDraft(displayedTarget.threadId).then((draft) => draft ? { ...draft, savedWorkingCopy: false } : null);
    void drawingSource
      .then(async (draft) => {
        if (!isCurrentGeneration()) return;
        let restoredScene: Scene;
        let restoredInstruction: string;
        if (draft) {
          restoredScene = deserializeScene(draft.scene);
          restoredInstruction = draft.instruction;
          dispatchHistory({ type: "reset", scene: restoredScene });
          setInstruction(restoredInstruction);
          setPencilOnly(draft.pencilOnly);
          setDraftMessage(draft.savedWorkingCopy
            ? "Saved Drawing opened as an independent local working copy"
            : "Draft restored on this iPad");
        } else {
          restoredScene = freshHistory().present;
          restoredInstruction = "";
          dispatchHistory({ type: "reset", scene: restoredScene });
          setInstruction(restoredInstruction);
          setPencilOnly(true);
          setDraftMessage("New page");
        }

        const binding = storedDelivery;
        if (!binding || !isCurrentGeneration()) return;
        const identity = await createDrawingDeliveryIdentity(
          serializeScene(restoredScene),
          restoredInstruction,
        );
        if (!isCurrentGeneration()) return;
        const matches = bindingMatchesDrawingDraft(binding, identity);
        setPendingDelivery(binding);
        setPendingDeliveryMatchesDraft(matches);
        if (!matches) {
          setDraftMessage("Previous sketch delivery is unresolved and its exact draft is unavailable");
        } else {
          setDraftMessage("Checking the previous sketch delivery before any retry…");
        }
        void reconcileDelivery(binding);
      })
      .catch(() => {
        if (!isCurrentGeneration()) return;
        dispatchHistory({ type: "reset", scene: freshHistory().present });
        setInstruction("");
        setDraftMessage(storedDelivery
          ? "Previous sketch delivery is unresolved and its exact draft is unavailable"
          : "Local draft unavailable");
        if (storedDelivery) void reconcileDelivery(storedDelivery);
      })
      .finally(() => {
        if (isCurrentGeneration() && !draftPersistenceBlockedRef.current) setDraftReady(true);
      });
    return () => {
      active = false;
    };
  }, [displayedTarget?.threadId, initialSavedDrawing?.id, open, reconcileDelivery]);

  const commitActiveInteractionForSuspension = useCallback((): Scene => {
    const interaction = drawInteractionRef.current;
    let sceneToPersist = sceneRef.current;
    if (interaction) {
      const element = elementFromInteraction(interaction, color, size);
      if (element) {
        const operation = { type: "add" as const, element };
        sceneToPersist = applySceneOperation(sceneToPersist, operation);
        sceneRef.current = sceneToPersist;
        dispatchHistory({ type: "commit", operation });
      }
    }
    resetPointerState();
    return sceneToPersist;
  }, [color, resetPointerState, size]);

  const persistDraft = useCallback(
    async (announce: boolean, sceneToSave: Scene = sceneRef.current) => {
      if (
        draftPersistenceBlockedRef.current
        || !draftReady
        || !displayedTarget
        || !isExactDrawingTarget(displayedTarget)
      ) return;
      try {
        await enqueueDraftMutation(async () => {
          if (draftPersistenceBlockedRef.current) return;
          await saveDrawingDraft(displayedTarget.threadId, {
            scene: serializeScene(sceneToSave),
            instruction,
            background: sceneToSave.background.mode,
            pencilOnly,
          });
        });
        if (announce) setDraftMessage("Saved on this iPad");
      } catch {
        if (announce) setDraftMessage("Draft could not be saved");
      }
    },
    [displayedTarget, draftReady, enqueueDraftMutation, instruction, pencilOnly],
  );

  useEffect(() => {
    if (!draftReady) return;
    const timer = window.setTimeout(() => void persistDraft(true), 550);
    return () => window.clearTimeout(timer);
  }, [draftReady, persistDraft, scene]);

  useEffect(() => {
    if (!open) return;
    const saveBeforeSuspension = () => {
      if (document.visibilityState === "hidden") {
        void persistDraft(false, commitActiveInteractionForSuspension());
      }
    };
    const saveBeforePageHide = () =>
      void persistDraft(false, commitActiveInteractionForSuspension());
    document.addEventListener("visibilitychange", saveBeforeSuspension);
    window.addEventListener("pagehide", saveBeforePageHide);
    return () => {
      document.removeEventListener("visibilitychange", saveBeforeSuspension);
      window.removeEventListener("pagehide", saveBeforePageHide);
    };
  }, [commitActiveInteractionForSuspension, open, persistDraft]);

  const requestCanvasRedraw = useCallback(() => setCanvasRevision((revision) => revision + 1), []);

  useEffect(() => {
    if (!open) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    renderDrawingCanvas(canvas, scene, view, drawingPreview, requestCanvasRedraw);
  }, [canvasRevision, drawingPreview, open, requestCanvasRedraw, scene, view]);

  useEffect(() => {
    if (!open || !canvasRef.current) return;
    const canvas = canvasRef.current;
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", requestCanvasRedraw);
      return () => window.removeEventListener("resize", requestCanvasRedraw);
    }
    const observer = new ResizeObserver(requestCanvasRedraw);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [open, requestCanvasRedraw]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (exportPreview || clearPending) return;
      if (isEditableTarget(event.target)) return;
      if (editorLocked) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        dispatchHistory({ type: event.shiftKey ? "redo" : "undo" });
        setExportPreview(null);
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "y") {
        event.preventDefault();
        dispatchHistory({ type: "redo" });
        setExportPreview(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [clearPending, editorLocked, exportPreview, open]);

  useEffect(() => () => trackerRef.current?.releaseAll(), []);

  useEffect(() => {
    if (!open) return;
    const studio = studioDialogRef.current;
    if (!studio) return;
    const preventStudioSelection = (event: Event) => {
      if (!isEditableTarget(event.target)) event.preventDefault();
    };
    studio.addEventListener("selectstart", preventStudioSelection);
    return () => studio.removeEventListener("selectstart", preventStudioSelection);
  }, [open]);

  const resetGestureStart = useCallback(() => {
    const points = [...gesturePointersRef.current.values()];
    const canvas = canvasRef.current;
    if (points.length === 0 || !canvas) {
      gestureStartRef.current = null;
      return;
    }
    const metrics = gestureMetrics(points);
    gestureStartRef.current = createGestureAnchor(
      metrics,
      view,
      screenTransform(canvas, scene, view),
    );
  }, [scene, view]);

  const updateGesture = useCallback(() => {
    const start = gestureStartRef.current;
    const points = [...gesturePointersRef.current.values()];
    if (!start || points.length === 0) return;
    const next = gestureMetrics(points);
    if (points.length === 1) {
      setView((current) => ({
        ...current,
        panX: start.panX + next.centerX - start.centerX,
        panY: start.panY + next.centerY - start.centerY,
      }));
      return;
    }
    setView(solvePinchView(start, next, MIN_ZOOM, MAX_ZOOM));
  }, []);

  const beginGesture = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      event.preventDefault();
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // Safari can cancel a palm before capture; no persistent state is created.
      }
      gesturePointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      resetGestureStart();
    },
    [resetGestureStart],
  );

  const commitInteraction = useCallback(
    (interaction: DrawInteraction) => {
      const element = elementFromInteraction(interaction, color, size);
      if (!element) return;
      const operation = { type: "add" as const, element };
      sceneRef.current = applySceneOperation(sceneRef.current, operation);
      dispatchHistory({ type: "commit", operation });
      setExportPreview(null);
      setLocalError(null);
    },
    [color, size],
  );

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      if (editorLocked || event.button > 0) return;
      event.preventDefault();
      if (event.pointerType === "pen") {
        penActiveRef.current = true;
        clearTouchPointersForPen(event, allPointersRef.current, gesturePointersRef.current);
        gestureStartRef.current = null;
      }
      if (pencilOnly && event.pointerType === "touch") {
        if (penActiveRef.current) return;
        beginTwoFingerPencilNavigation(
          event,
          allPointersRef.current,
          gesturePointersRef.current,
          resetGestureStart,
        );
        return;
      }
      if (event.pointerType === "touch" && penActiveRef.current) return;
      if (pencilOnly && event.pointerType !== "pen") {
        if (tool === "pan" && event.pointerType === "mouse") beginGesture(event);
        return;
      }
      allPointersRef.current.set(event.pointerId, {
        x: event.clientX,
        y: event.clientY,
        type: event.pointerType,
      });

      const existingTouches = [...allPointersRef.current.entries()].filter(
        ([pointerId, point]) => pointerId !== event.pointerId && point.type === "touch",
      );
      if (event.pointerType === "touch" && existingTouches.length > 0) {
        trackerRef.current?.releaseAll();
        drawInteractionRef.current = null;
        setDrawingPreview(null);
        for (const [pointerId, point] of existingTouches) {
          gesturePointersRef.current.set(pointerId, { x: point.x, y: point.y });
        }
        beginGesture(event);
        return;
      }

      if (tool === "pan") {
        beginGesture(event);
        return;
      }

      const canvas = canvasRef.current;
      if (!canvas) return;
      const transform = screenTransform(canvas, scene, view);
      if (tool === "text") {
        event.preventDefault();
        const point = pointerSamples(event.nativeEvent, transform)[0];
        if (!point || !textValue.trim()) {
          setLocalError("Enter a label, then tap where it belongs.");
          return;
        }
        dispatchHistory({
          type: "commit",
          operation: {
            type: "add",
            element: createTextElement({
              id: elementId(),
              x: point.x,
              y: point.y,
              text: textValue.trim(),
              color,
              fontSize: Math.max(22, size * 4),
              fontWeight: "bold",
              maxWidth: 520,
            }),
          },
        });
        setExportPreview(null);
        setLocalError(null);
        return;
      }

      const tracked = trackerRef.current?.pointerDown(event.nativeEvent, canvas, transform);
      const start = tracked?.points[0];
      if (!tracked?.accepted || !start) return;
      const interaction: DrawInteraction = {
        pointerId: event.pointerId,
        tool: tool as DrawInteraction["tool"],
        start,
        points: [...tracked.points],
      };
      drawInteractionRef.current = interaction;
      setDrawingPreview(toolPreview(interaction, color, size));
    },
    [beginGesture, color, editorLocked, pencilOnly, resetGestureStart, scene, size, textValue, tool, view],
  );

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      if (allPointersRef.current.has(event.pointerId)) {
        allPointersRef.current.set(event.pointerId, {
          x: event.clientX,
          y: event.clientY,
          type: event.pointerType,
        });
      }
      if (gesturePointersRef.current.has(event.pointerId)) {
        event.preventDefault();
        gesturePointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
        updateGesture();
        return;
      }
      const interaction = drawInteractionRef.current;
      const canvas = canvasRef.current;
      if (!interaction || interaction.pointerId !== event.pointerId || !canvas) return;
      const tracked = trackerRef.current?.pointerMove(
        event.nativeEvent,
        screenTransform(canvas, scene, view),
      );
      if (!tracked?.accepted) return;
      interaction.points.push(...tracked.points);
      setDrawingPreview(toolPreview(interaction, color, size));
    },
    [color, scene, size, updateGesture, view],
  );

  const endPointer = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>, cancelled: boolean) => {
      allPointersRef.current.delete(event.pointerId);
      if (event.pointerType === "pen") penActiveRef.current = false;
      if (gesturePointersRef.current.has(event.pointerId)) {
        if (pencilOnly && event.pointerType === "touch") {
          for (const pointerId of gesturePointersRef.current.keys()) {
            if (pointerId === event.pointerId) continue;
            try { event.currentTarget.releasePointerCapture(pointerId); } catch { /* Pointer may already be gone. */ }
          }
          gesturePointersRef.current.clear();
          gestureStartRef.current = null;
          return;
        }
        gesturePointersRef.current.delete(event.pointerId);
        resetGestureStart();
        return;
      }
      const interaction = drawInteractionRef.current;
      if (!interaction || interaction.pointerId !== event.pointerId) return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      if (cancelled) {
        trackerRef.current?.pointerCancel(event.nativeEvent);
        // iPadOS can cancel a valid Pencil pointer when palm classification
        // changes. Preserve the samples already rendered instead of erasing
        // the whole visible stroke.
        commitInteraction(interaction);
      } else {
        const tracked = trackerRef.current?.pointerUp(
          event.nativeEvent,
          screenTransform(canvas, scene, view),
        );
        if (tracked?.accepted) interaction.points.push(...tracked.points);
        commitInteraction(interaction);
      }
      drawInteractionRef.current = null;
      setDrawingPreview(null);
    },
    [commitInteraction, pencilOnly, resetGestureStart, scene, view],
  );

  const changeBackground = useCallback((background: BackgroundMode) => {
    dispatchHistory({
      type: "commit",
      operation: {
        type: "setBackground",
        background: { mode: background, color: DARK_BACKGROUND },
      },
    });
    setExportPreview(null);
  }, []);

  const importImage = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (!file) return;
      setLocalError(null);
      try {
        const prepared = await prepareImportedImage(file);
        // Image decoding can outlive several editor renders (notably after
        // Clear or while the iPad camera picker is open). Always compose the
        // photo with the latest scene instead of the render that opened the
        // picker, otherwise deleted marks can be restored from a stale closure.
        const currentScene = sceneRef.current;
        const frame = fitImageInside(prepared, currentScene.viewport);
        const image = createImageElement({
          id: elementId(),
          ...frame,
          source: prepared.source,
          isBackground: true,
        });
        const withoutPreviousBackground = {
          ...currentScene,
          elements: currentScene.elements.filter(
            (element) => element.kind !== "image" || !element.isBackground,
          ),
        };
        const nextScene = applySceneOperation(withoutPreviousBackground, {
          type: "add",
          element: image,
        });
        sceneRef.current = nextScene;
        dispatchHistory({
          type: "replace",
          scene: nextScene,
        });
        setExportPreview(null);
        setDraftMessage(`${file.name || "Image"} added behind your annotations`);
      } catch (error) {
        setLocalError(error instanceof Error ? error.message : "The image could not be imported.");
      }
    },
    [],
  );

  const confirmClear = useCallback(() => {
    sceneRef.current = applySceneOperation(sceneRef.current, { type: "clear" });
    dispatchHistory({ type: "commit", operation: { type: "clear" } });
    setInstruction("");
    setExportPreview(null);
    setClearPending(false);
    setDraftMessage("New page");
    if (displayedTarget) {
      const threadId = displayedTarget.threadId;
      void enqueueDraftMutation(() => deleteDrawingDraft(threadId));
    }
  }, [displayedTarget, enqueueDraftMutation]);

  const buildPreview = useCallback(async () => {
    if (!hasContent || previewBusy) return;
    setPreviewBusy(true);
    setLocalError(null);
    try {
      if (pendingDelivery && !pendingDeliveryRetryable) {
        setLocalError(
          "A previous attachment is unresolved and its exact draft or target binding is unavailable. Check its status before creating another transfer ID.",
        );
        return;
      }
      const options = {
        background: "scene" as const,
        padding: 36,
        maxWidth: 2_560,
        maxHeight: 2_560,
        pixelRatio: 2,
      };
      const { blob } = await exportSceneToBoundedPng(scene, options);
      const pngBase64 = await blobToBase64(blob);
      const next: ExportPreview = {
        commandId: pendingDelivery?.commandId ?? commandId(),
        targetSnapshotSeq: pendingDelivery?.expectedSnapshotSeq
          ?? (sameDrawingTarget(displayedTarget, target)
            ? (target?.snapshotSeq ?? displayedTarget?.snapshotSeq ?? 0)
            : (displayedTarget?.snapshotSeq ?? 0)),
        lockedInstruction: pendingDelivery ? instruction : null,
        blob,
        pngBase64,
      };
      setPreviewBusy(false);
      setExportPreview(next);
    } catch (error) {
      setSendAfterBuild(false);
      setLocalError(error instanceof Error ? error.message : "The PNG preview could not be created.");
    } finally {
      setPreviewBusy(false);
    }
  }, [
    displayedTarget,
    hasContent,
    instruction,
    pendingDelivery,
    pendingDeliveryRetryable,
    previewBusy,
    scene,
    target,
  ]);

  const sendPreview = useCallback(async () => {
    if (!exportPreview || !sendGuard.allowed || !displayedTarget) return;
    const deliveryInstruction = "";
    let mutationAttempted = false;
    setExportPreview((current) =>
      current ? { ...current, lockedInstruction: deliveryInstruction } : current,
    );
    setLocalSending(true);
    setLocalError(null);
    try {
      let binding = pendingDelivery;
      if (binding) {
        const reconciliation = await reconcileDelivery(binding);
        if (reconciliation === "pending") {
          setLocalError("This composer attachment is still in flight. Its image was not attached again.");
          return;
        }
        if (reconciliation === "succeeded") return;
        if (reconciliation === "failed") {
          setExportPreview((current) => current
            ? { ...current, commandId: commandId(), lockedInstruction: null }
            : current);
          setLocalError("The previous attachment failed definitively. Review once more before creating a new transfer ID.");
          return;
        }
        if (!pendingDeliveryMatchesTarget) {
          setLocalError("The pending attachment is bound to a different native slot or thread key and cannot be replayed.");
          return;
        }
      }

      const serializedScene = serializeScene(scene);
      const identity = await createDrawingDeliveryIdentity(serializedScene, deliveryInstruction);
      if (binding && !bindingMatchesDrawingDraft(binding, identity)) {
        setLocalError("The exact pending draft changed. A fresh transfer ID is blocked until its outcome is known.");
        return;
      }

      if (!binding) {
        await saveDrawingDraft(displayedTarget.threadId, {
          scene: serializedScene,
          instruction: deliveryInstruction,
          background: scene.background.mode,
          pencilOnly,
        });
        setInstruction(deliveryInstruction);
        binding = {
          commandId: exportPreview.commandId,
          expectedBridgeInstanceId: displayedTarget.bridgeInstanceId,
          slotId: displayedTarget.slotId,
          threadId: displayedTarget.threadId,
          threadKey: displayedTarget.threadKey ?? displayedTarget.threadId,
          expectedSnapshotSeq: exportPreview.targetSnapshotSeq,
          ...identity,
        };
        if (!savePendingDrawingDelivery(binding)) {
          setLocalError("The attachment identity could not be saved on this iPad, so nothing was added to the composer.");
          setExportPreview((current) => current ? { ...current, lockedInstruction: null } : current);
          return;
        }
        setPendingDelivery(binding);
        setPendingDeliveryMatchesDraft(true);
      }

      mutationAttempted = true;
      const result = await onSend({
        commandId: binding.commandId,
        expectedBridgeInstanceId: binding.expectedBridgeInstanceId,
        slotId: binding.slotId,
        threadId: binding.threadId,
        threadKey: binding.threadKey,
        snapshotSeq: binding.expectedSnapshotSeq,
        expectedSnapshotSeq: binding.expectedSnapshotSeq,
        instruction: deliveryInstruction,
        png: exportPreview.blob,
        pngBase64: exportPreview.pngBase64,
        scene: JSON.parse(serializedScene) as unknown,
        background: scene.background.mode,
      });
      if (result && drawingDeliveryIsUnresolved(result)) {
        if (result.ok) {
          setDraftMessage(result.message ?? "Sketch attachment is still in flight; its transfer ID remains locked");
        } else {
          setLocalError(result.message ?? "Attachment outcome is unknown. Retry keeps the same transfer ID.");
        }
        return;
      }
      if (result && !result.ok) {
        clearDeliveryBinding(binding.threadId);
        setLocalError(result.message ?? "The bridge rejected this sketch.");
        setExportPreview((current) => current
          ? { ...current, commandId: commandId(), lockedInstruction: null }
          : current);
        return;
      }
      await discardDeliveredDraft(binding.threadId);
      clearDeliveryBinding(binding.threadId);
      setDraftMessage("Sketch attached to the Mac composer");
      setExportPreview(null);
      setSendAfterBuild(false);
      const generation = studioGenerationRef.current;
      window.setTimeout(() => {
        if (generation === studioGenerationRef.current) onCloseRef.current();
      }, 360);
    } catch (error) {
      if (!mutationAttempted && !pendingDelivery) {
        setExportPreview((current) => current ? { ...current, lockedInstruction: null } : current);
      }
      setLocalError(
        error instanceof Error
          ? `${error.message} Retry keeps the same transfer ID.`
          : "Attachment outcome is unknown. Retry keeps the same transfer ID.",
      );
    } finally {
      setLocalSending(false);
    }
  }, [
    clearDeliveryBinding,
    discardDeliveredDraft,
    displayedTarget,
    exportPreview,
    instruction,
    onSend,
    pencilOnly,
    pendingDelivery,
    pendingDeliveryMatchesTarget,
    reconcileDelivery,
    scene,
    sendGuard.allowed,
  ]);

  useEffect(() => {
    if (!sendAfterBuild || exportPreview === null || previewBusy || currentSending) return;
    setSendAfterBuild(false);
    void sendPreview();
  }, [currentSending, exportPreview, previewBusy, sendAfterBuild, sendPreview]);

  const requestSend = useCallback(() => {
    if (exportPreview !== null) {
      void sendPreview();
      return;
    }
    setSendAfterBuild(true);
    void buildPreview();
  }, [buildPreview, exportPreview, sendPreview]);

  const keepDrawing = useCallback(async () => {
    if (!onKeep || !displayedTarget || !hasContent || localKeeping) return;
    const generation = studioGenerationRef.current;
    setLocalKeeping(true);
    setLocalError(null);
    setKeepMessage(null);
    try {
      const { blob, geometry } = await exportSceneToBoundedPng(scene, {
        background: "scene",
        padding: 36,
        maxWidth: 2_560,
        maxHeight: 2_560,
        pixelRatio: 2,
      });
      const result = await onKeep({
        sourceThreadId: displayedTarget.threadId,
        sourceThreadTitle: displayedTarget.title,
        instruction: instruction.trim(),
        pngBase64: await blobToBase64(blob),
        sceneJson: serializeScene(scene),
        background: scene.background.mode,
        width: geometry.width,
        height: geometry.height,
      });
      if (!result.ok) {
        if (generation === studioGenerationRef.current) {
          setLocalError(result.message ?? "Drawing could not be kept on the Mac.");
        }
        return;
      }
      if (generation === studioGenerationRef.current) {
        setKeepMessage(result.message ?? "Kept in Saved Drawings on the Mac");
      }
    } catch (error) {
      if (generation === studioGenerationRef.current) {
        setLocalError(error instanceof Error ? error.message : "Drawing could not be kept on the Mac.");
      }
    } finally {
      if (generation === studioGenerationRef.current) setLocalKeeping(false);
    }
  }, [displayedTarget, hasContent, instruction, localKeeping, onKeep, scene]);

  const zoomBy = useCallback((factor: number) => {
    setView((current) => ({ ...current, zoom: clamp(current.zoom * factor, MIN_ZOOM, MAX_ZOOM) }));
  }, []);

  if (!open) return null;

  const targetChanged = Boolean(displayedTarget && !sameDrawingTarget(displayedTarget, target));
  const statusText = localError
    ?? (reconcilingDelivery ? "Checking the previous attachment with the Mac bridge…" : null)
    ?? keepMessage
    ?? statusMessage
    ?? (!sendGuard.allowed ? sendGuard.message : draftMessage);

  return (
    <section
      ref={studioDialogRef}
      className="drawing-studio"
      role="dialog"
      aria-modal="true"
      aria-labelledby="drawing-studio-title"
      data-send-status={currentSending ? "sending" : sendStatus}
      tabIndex={-1}
    >
      <header className="drawing-studio__header">
        <div className="drawing-studio__title-block">
          <span className="drawing-studio__register" aria-hidden="true">SKETCH / PNG</span>
          <h2 id="drawing-studio-title">Draw for Codex</h2>
        </div>
        <div className={`drawing-target${targetChanged ? " is-stale" : ""}`} aria-live="polite">
          <span className="drawing-target__signal" aria-hidden="true" />
          {displayedTarget ? (
            <span>
              <small>Exact destination · {displayedTarget.slotId}</small>
              <strong>{displayedTarget.title || "Untitled task"}</strong>
              <code>{displayedTarget.threadId.slice(-8)}</code>
            </span>
          ) : (
            <span><small>No exact destination</small><strong>Select an agent first</strong></span>
          )}
        </div>
        <button className="drawing-studio__close" type="button" onClick={onClose} aria-label="Close drawing studio">
          <span aria-hidden="true">×</span>
        </button>
      </header>

      {targetChanged && (
        <div className="drawing-studio__warning" role="alert">
          Dashboard selection changed. This page is still pinned to {displayedTarget?.title || "its original task"}.
          Close and reopen to confirm a different destination.
        </div>
      )}

      <div className="drawing-studio__workspace">
        <aside className="drawing-tools" aria-label="Drawing tools">
          <div className="drawing-tools__rack" role="toolbar" aria-label="Ink and shape tools">
            {TOOLS.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`drawing-tool${tool === item.id ? " is-active" : ""}`}
                aria-pressed={tool === item.id}
                aria-label={item.label}
                onClick={() => setTool(item.id)}
                disabled={editorLocked}
              >
                <span className="drawing-tool__glyph" aria-hidden="true">{toolGlyph(item.id)}</span>
                <span>{item.short}</span>
              </button>
            ))}
          </div>

          {tool === "text" && (
            <label className="drawing-text-entry">
              <span>Label to place</span>
              <input
                value={textValue}
                onChange={(event) => setTextValue(event.target.value.slice(0, 120))}
                maxLength={120}
                placeholder="Button label"
                disabled={editorLocked}
              />
            </label>
          )}

          <fieldset className="drawing-colors">
            <legend>Ink color</legend>
            {COLORS.map((swatch) => (
              <button
                key={swatch.value}
                type="button"
                className={`drawing-swatch${color === swatch.value ? " is-active" : ""}`}
                style={{ "--swatch": swatch.value } as React.CSSProperties}
                aria-label={swatch.name}
                aria-pressed={color === swatch.value}
                onClick={() => setColor(swatch.value)}
                disabled={editorLocked}
              />
            ))}
          </fieldset>

          <label className="drawing-size">
            <span>Stroke</span>
            <select value={size} onChange={(event) => setSize(Number(event.target.value))} disabled={editorLocked}>
              {SIZES.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>

          <div className="drawing-tools__history" aria-label="Edit history">
            <button
              type="button"
              onClick={() => { dispatchHistory({ type: "undo" }); setExportPreview(null); }}
              disabled={history.past.length === 0 || editorLocked}
              aria-label="Undo"
            >↶ <span>Undo</span></button>
            <button
              type="button"
              onClick={() => { dispatchHistory({ type: "redo" }); setExportPreview(null); }}
              disabled={history.future.length === 0 || editorLocked}
              aria-label="Redo"
            >↷ <span>Redo</span></button>
          </div>

          <input
            ref={cameraInputRef}
            className="visually-hidden"
            type="file"
            aria-label="Capture drawing background with camera"
            accept="image/*"
            capture="environment"
            onChange={(event) => { setImportSourceOpen(false); void importImage(event); }}
            tabIndex={-1}
          />
          <input
            ref={fileInputRef}
            className="visually-hidden"
            type="file"
            aria-label="Choose drawing background from photos"
            accept={PHOTO_IMPORT_ACCEPT}
            onChange={(event) => { setImportSourceOpen(false); void importImage(event); }}
            tabIndex={-1}
          />
          <input
            ref={filesInputRef}
            className="visually-hidden"
            type="file"
            aria-label="Choose drawing background from files"
            accept={PHOTO_IMPORT_ACCEPT}
            onChange={(event) => { setImportSourceOpen(false); void importImage(event); }}
            tabIndex={-1}
          />
          <button
            className="drawing-import"
            type="button"
            onClick={() => setImportSourceOpen(true)}
            disabled={editorLocked}
          >
            <span aria-hidden="true">⊕</span> Photo / File
          </button>
          <button
            className="drawing-clear"
            type="button"
            onClick={() => setClearPending(true)}
            disabled={!hasContent || editorLocked}
          >Clear page…</button>
        </aside>

        <main className="drawing-board">
          <div className="drawing-board__chrome">
            <div className="drawing-background" role="group" aria-label="Canvas background">
              {(["white", "transparent", "dark"] as const).map((background) => (
                <button
                  key={background}
                  type="button"
                  className={scene.background.mode === background ? "is-active" : ""}
                  aria-pressed={scene.background.mode === background}
                  onClick={() => changeBackground(background)}
                  disabled={editorLocked}
                >{background[0]?.toUpperCase()}{background.slice(1)}</button>
              ))}
            </div>
            <label className="pencil-mode">
              <input
                type="checkbox"
                checked={pencilOnly}
                onChange={(event) => setPencilOnly(event.target.checked)}
                disabled={editorLocked}
              />
              <span>Pencil only</span>
            </label>
            <div className="drawing-zoom" aria-label="Canvas zoom">
              <button type="button" onClick={() => zoomBy(1 / 1.2)} aria-label="Zoom out">−</button>
              <button type="button" onClick={() => setView(INITIAL_VIEW)} aria-label="Fit drawing">
                {Math.round(view.zoom * 100)}%
              </button>
              <button type="button" onClick={() => zoomBy(1.2)} aria-label="Zoom in">+</button>
            </div>
          </div>

          <div className={`drawing-canvas-frame background-${scene.background.mode}`}>
            <canvas
              ref={canvasRef}
              className={`drawing-canvas tool-${tool}`}
              style={{ touchAction: "none" }}
              role="img"
              aria-label="Sketch canvas. Use Apple Pencil to draw; use two fingers to pan and pinch to zoom."
              tabIndex={0}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={(event) => endPointer(event, false)}
              onPointerCancel={(event) => endPointer(event, true)}
              onLostPointerCapture={(event) => endPointer(event, false)}
              onContextMenu={(event) => event.preventDefault()}
            />
            {!hasContent && draftReady && (
              <div className="drawing-canvas__empty" aria-hidden="true" style={{ pointerEvents: "none" }}>
                <span>Apple Pencil ready</span>
                <strong>Mark the change you want.</strong>
                <small>Two fingers pan · pinch zooms · Send only attaches the image</small>
              </div>
            )}
          </div>
        </main>
      </div>

      <footer className="drawing-studio__footer">
        <div className="drawing-send-panel">
          <p className={localError || targetChanged ? "is-error" : ""} aria-live="polite">
            {statusText ?? "Send attaches the image to the Mac composer without submitting it. Add instructions afterward with Dictation."}
          </p>
          {pendingDelivery !== null && !pendingDeliveryRetryable ? (
            <button
              className="drawing-review-button"
              type="button"
              onClick={() => void reconcileDelivery(pendingDelivery)}
              disabled={reconcilingDelivery}
            >
              {reconcilingDelivery ? "Checking attachment…" : "Check previous attachment"}
            </button>
          ) : (
            <div className="drawing-send-panel__actions">
              {onKeep && (
                <button
                  className="drawing-keep-button"
                  type="button"
                  onClick={() => void keepDrawing()}
                  disabled={!hasContent || localKeeping || readOnly}
                >
                  {localKeeping ? "Keeping…" : "Keep in Saved Drawings"}
                </button>
              )}
              <button
                className="drawing-review-button"
                type="button"
                onClick={requestSend}
                disabled={!sendGuard.allowed || previewBusy || currentSending || readOnly || reconcilingDelivery}
              >
                {currentSending
                  ? "Attaching…"
                  : previewBusy
                    ? "Preparing…"
                    : pendingDeliveryRetryable
                      ? "Retry Send"
                      : "Send"}
              </button>
            </div>
          )}
        </div>
      </footer>

      {clearPending && (
        <div className="drawing-overlay" role="presentation">
          <section ref={clearDialogRef} className="drawing-confirm" role="alertdialog" aria-modal="true" aria-labelledby="clear-title" tabIndex={-1}>
            <span className="drawing-confirm__mark" aria-hidden="true">×</span>
            <h3 id="clear-title">Clear this page?</h3>
            <p>This removes every mark and imported image from the draft. You can’t undo after closing the studio.</p>
            <div>
              <button ref={clearCancelRef} type="button" onClick={() => setClearPending(false)}>Keep drawing</button>
              <button type="button" className="is-destructive" onClick={confirmClear}>Clear page</button>
            </div>
          </section>
        </div>
      )}

      {importSourceOpen && (
        <div className="drawing-overlay" role="presentation">
          <section ref={importDialogRef} className="drawing-import-sheet" role="dialog" aria-modal="true" aria-labelledby="drawing-import-title" tabIndex={-1}>
            <span className="drawing-confirm__mark" aria-hidden="true">⊕</span>
            <h3 id="drawing-import-title">Add an image</h3>
            <p>Choose a source. The image stays on this iPad until you Keep or send the finished drawing.</p>
            <div>
              <button type="button" onClick={() => cameraInputRef.current?.click()}>Camera</button>
              <button type="button" onClick={() => fileInputRef.current?.click()}>Photo Library</button>
              <button type="button" onClick={() => filesInputRef.current?.click()}>Files</button>
              <button ref={importCancelRef} type="button" className="is-quiet" onClick={() => setImportSourceOpen(false)}>Cancel</button>
            </div>
          </section>
        </div>
      )}

    </section>
  );
}

/**
 * Embeddable annotation surface used by review frames. It deliberately has no
 * transport or target fallback: the owner supplies one scene and receives the
 * edited scene. Sending remains the responsibility of the surrounding review.
 */
export function DrawingCanvasEditor({
  scene,
  onSceneChange,
  pencilOnly = true,
  className = "",
  readOnly = false,
}: DrawingCanvasEditorProps) {
  const [tool, setTool] = useState<"pen" | "marker" | "arrow" | "rectangle" | "ellipse" | "text" | "pan">("pen");
  const [color, setColor] = useState<string>(COLORS[1].value);
  const [size, setSize] = useState<number>(SIZES[1].value);
  const [textValue, setTextValue] = useState("Note");
  const [view, setView] = useState<CanvasView>(INITIAL_VIEW);
  const [preview, setPreview] = useState<DrawingPreview>(null);
  const [revision, setRevision] = useState(0);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const trackerRef = useRef(new PencilPointerTracker());
  const interactionRef = useRef<DrawInteraction | null>(null);
  const gesturePointersRef = useRef(new Map<number, { x: number; y: number }>());
  const allPointersRef = useRef(new Map<number, TrackedCanvasPointer>());
  const gestureStartRef = useRef<GestureAnchor | null>(null);
  const penActiveRef = useRef(false);

  const redraw = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    renderDrawingCanvas(canvas, scene, view, preview, redraw);
  }, [preview, redraw, revision, scene, view]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(redraw);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [redraw]);

  useEffect(
    () => () => {
      trackerRef.current.releaseAll();
      gesturePointersRef.current.clear();
      allPointersRef.current.clear();
      gestureStartRef.current = null;
      penActiveRef.current = false;
      interactionRef.current = null;
    },
    [],
  );

  const resetEditorGesture = useCallback(() => {
    const canvas = canvasRef.current;
    const points = [...gesturePointersRef.current.values()];
    if (!canvas || points.length === 0) {
      gestureStartRef.current = null;
      return;
    }
    gestureStartRef.current = createGestureAnchor(
      gestureMetrics(points),
      view,
      screenTransform(canvas, scene, view),
    );
  }, [scene, view]);

  const updateEditorGesture = useCallback(() => {
    const start = gestureStartRef.current;
    const points = [...gesturePointersRef.current.values()];
    if (!start || points.length === 0) return;
    const metrics = gestureMetrics(points);
    if (points.length === 1) {
      setView((current) => ({
        ...current,
        panX: start.panX + metrics.centerX - start.centerX,
        panY: start.panY + metrics.centerY - start.centerY,
      }));
    } else {
      setView(solvePinchView(start, metrics, MIN_ZOOM, MAX_ZOOM));
    }
  }, []);

  const commitEditorInteraction = useCallback((interaction: DrawInteraction) => {
    const element = elementFromInteraction(interaction, color, size);
    if (element) onSceneChange(applySceneOperation(scene, { type: "add", element }));
  }, [color, onSceneChange, scene, size]);

  const editorPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      if (readOnly || event.button > 0) return;
      event.preventDefault();
      if (event.pointerType === "pen") {
        penActiveRef.current = true;
        clearTouchPointersForPen(event, allPointersRef.current, gesturePointersRef.current);
        gestureStartRef.current = null;
      }
      if (pencilOnly && event.pointerType === "touch") {
        if (penActiveRef.current) return;
        beginTwoFingerPencilNavigation(
          event,
          allPointersRef.current,
          gesturePointersRef.current,
          resetEditorGesture,
        );
        return;
      }
      if (event.pointerType === "touch" && penActiveRef.current) return;
      if (pencilOnly && event.pointerType !== "pen") {
        if (tool !== "pan" || event.pointerType !== "mouse") return;
      }
      allPointersRef.current.set(event.pointerId, {
        x: event.clientX,
        y: event.clientY,
        type: event.pointerType,
      });
      if (tool === "pan") {
        try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* WebKit may cancel palms. */ }
        gesturePointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
        resetEditorGesture();
        return;
      }
      const canvas = canvasRef.current;
      if (!canvas) return;
      const transform = screenTransform(canvas, scene, view);
      if (tool === "text") {
        const point = pointerSamples(event.nativeEvent, transform)[0];
        if (!point || !textValue.trim()) return;
        onSceneChange(
          applySceneOperation(scene, {
            type: "add",
            element: createTextElement({
              id: elementId(),
              x: point.x,
              y: point.y,
              text: textValue.trim(),
              color,
              fontSize: Math.max(20, size * 3.5),
              fontWeight: "bold",
              maxWidth: 420,
            }),
          }),
        );
        return;
      }
      const tracked = trackerRef.current.pointerDown(event.nativeEvent, canvas, transform);
      const start = tracked.points[0];
      if (!tracked.accepted || !start) return;
      const interaction: DrawInteraction = {
        pointerId: event.pointerId,
        tool,
        start,
        points: [...tracked.points],
      };
      interactionRef.current = interaction;
      setPreview(toolPreview(interaction, color, size));
    },
    [color, onSceneChange, pencilOnly, readOnly, resetEditorGesture, scene, size, textValue, tool, view],
  );

  const editorPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      if (allPointersRef.current.has(event.pointerId)) {
        allPointersRef.current.set(event.pointerId, {
          x: event.clientX,
          y: event.clientY,
          type: event.pointerType,
        });
      }
      if (gesturePointersRef.current.has(event.pointerId)) {
        event.preventDefault();
        gesturePointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
        updateEditorGesture();
        return;
      }
      const interaction = interactionRef.current;
      const canvas = canvasRef.current;
      if (!canvas || !interaction || interaction.pointerId !== event.pointerId) return;
      const tracked = trackerRef.current.pointerMove(event.nativeEvent, screenTransform(canvas, scene, view));
      if (!tracked.accepted) return;
      interaction.points.push(...tracked.points);
      setPreview(toolPreview(interaction, color, size));
    },
    [color, scene, size, updateEditorGesture, view],
  );

  const editorPointerEnd = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>, cancelled: boolean) => {
      allPointersRef.current.delete(event.pointerId);
      if (event.pointerType === "pen") penActiveRef.current = false;
      if (gesturePointersRef.current.has(event.pointerId)) {
        if (pencilOnly && event.pointerType === "touch") {
          for (const pointerId of gesturePointersRef.current.keys()) {
            if (pointerId === event.pointerId) continue;
            try { event.currentTarget.releasePointerCapture(pointerId); } catch { /* Pointer may already be gone. */ }
          }
          gesturePointersRef.current.clear();
          gestureStartRef.current = null;
          return;
        }
        gesturePointersRef.current.delete(event.pointerId);
        resetEditorGesture();
        return;
      }
      const interaction = interactionRef.current;
      const canvas = canvasRef.current;
      if (!canvas || !interaction || interaction.pointerId !== event.pointerId) return;
      if (cancelled) {
        trackerRef.current.pointerCancel(event.nativeEvent);
        commitEditorInteraction(interaction);
      } else {
        const tracked = trackerRef.current.pointerUp(event.nativeEvent, screenTransform(canvas, scene, view));
        if (tracked.accepted) interaction.points.push(...tracked.points);
        commitEditorInteraction(interaction);
      }
      interactionRef.current = null;
      setPreview(null);
    },
    [commitEditorInteraction, pencilOnly, resetEditorGesture, scene, view],
  );

  return (
    <section className={`drawing-canvas-editor ${className}`.trim()}>
      <div className="drawing-canvas-editor__tools" role="toolbar" aria-label="Frame annotation tools">
        {(["pen", "marker", "arrow", "rectangle", "ellipse", "text", "pan"] as const).map((item) => (
          <button
            key={item}
            type="button"
            aria-label={TOOLS.find((candidate) => candidate.id === item)?.label ?? item}
            aria-pressed={tool === item}
            className={tool === item ? "is-active" : ""}
            onClick={() => setTool(item)}
            disabled={readOnly}
          >
            <span aria-hidden="true">{toolGlyph(item)}</span>
          </button>
        ))}
        <input
          className="drawing-canvas-editor__text"
          value={textValue}
          onChange={(event) => setTextValue(event.target.value.slice(0, 120))}
          aria-label="Annotation label"
          hidden={tool !== "text"}
        />
        <label className="drawing-canvas-editor__color">
          <span className="visually-hidden">Annotation color</span>
          <input type="color" value={color} onChange={(event) => setColor(event.target.value)} disabled={readOnly} />
        </label>
        <select value={size} onChange={(event) => setSize(Number(event.target.value))} aria-label="Annotation stroke size">
          {SIZES.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
        <button type="button" onClick={() => setView(INITIAL_VIEW)} aria-label="Fit annotation canvas">Fit</button>
      </div>
      <canvas
        ref={canvasRef}
        className="drawing-canvas-editor__canvas"
        style={{ touchAction: "none" }}
        role="img"
        aria-label="Frame annotation canvas. Use Apple Pencil to draw; use two fingers to pan and pinch to zoom."
        onPointerDown={editorPointerDown}
        onPointerMove={editorPointerMove}
        onPointerUp={(event) => editorPointerEnd(event, false)}
        onPointerCancel={(event) => editorPointerEnd(event, true)}
        onLostPointerCapture={(event) => editorPointerEnd(event, false)}
      />
    </section>
  );
}

export default DrawingStudio;
