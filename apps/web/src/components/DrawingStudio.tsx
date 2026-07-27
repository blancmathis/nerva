import {
  PencilPointerTracker,
  applySceneOperation,
  boundsContainPoint,
  createEraserElement,
  createHistory,
  createImageElement,
  createScene,
  createShapeElement,
  createStrokeElement,
  createTextElement,
  deserializeScene,
  elementsIntersectingBounds,
  expandSelectionForErasers,
  getElementBounds,
  getSceneBounds,
  historyReducer,
  pointerSamples,
  serializeScene,
  topmostElementAtPoint,
  transformElements,
  type BackgroundMode,
  type Bounds,
  type Scene,
  type SceneElement,
  type ScenePoint,
  type ShapeKind,
} from "@codex-pad/drawing";
import {
  DiagramDocumentSchema,
  type DiagramDocument,
  type DiagramNodeShape,
  type DiagramNodeTone,
  type DiagramUpdateRequest,
} from "@codex-pad/protocol";
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
  checkpointAndFinishDrawingBoard,
  deletePendingDrawingBoardExport,
  deleteDrawingDraft,
  listDrawingBoards,
  loadDrawingDraft,
  loadPendingDrawingBoardExport,
  resumeDrawingBoard,
  saveDrawingBoardCamera,
  saveDrawingDraft,
  savePendingDrawingBoardExport,
  type StoredDrawingBoard,
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
  describeDrawingBoardExport,
  exportDrawingBoard,
  type DrawingBoardExportManifest,
  type DrawingBoardExportPackage,
  type DrawingExportScope,
} from "./drawing-board-export";
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
  measureCanvas,
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
import {
  addDiagramEdge,
  addDiagramNode,
  autoLayoutDiagram,
  createDiagramHistory,
  diagramHistoryReducer,
  markDiagramRevisionSeen,
  mergeDiagramIntoScene,
  readSeenDiagramRevision,
  removeDiagramEdge,
  removeDiagramNode,
  updateDiagramNode,
} from "../lib/diagram-model";
import {
  DrawingIcon,
  type DrawingIconName,
} from "./DrawingIcon";

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
  boardId?: string;
  checkpointId?: string;
  scope?: DrawingExportScope;
  images?: DrawingBoardExportPackage["images"];
  manifest?: DrawingBoardExportManifest;
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
  composerAttachmentMaxImages?: 1 | 12;
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
  onListDiagrams?: (threadId: string) => Promise<readonly DiagramDocument[]>;
  onUpdateDiagram?: (
    diagramId: string,
    threadId: string,
    input: DiagramUpdateRequest,
  ) => Promise<DiagramDocument>;
}

export interface DrawingCanvasEditorProps {
  scene: Scene;
  onSceneChange: (scene: Scene) => void;
  pencilOnly?: boolean;
  className?: string;
  readOnly?: boolean;
}

type Tool = "select" | "pen" | "marker" | "eraser" | "arrow" | "rectangle" | "ellipse" | "text" | "pan";
type DiagramInspectorSection = "style" | "links" | "more";

type SelectionKey = `scene:${string}` | `diagram:${string}`;

interface SelectionPreview {
  readonly scene: Scene;
  readonly diagram: DiagramDocument | null;
}

interface SelectionGesture {
  readonly pointerId: number;
  readonly mode: "move" | "resize" | "lasso";
  readonly start: ScenePoint;
  readonly originalScene: Scene;
  readonly originalDiagram: DiagramDocument | null;
  readonly keys: ReadonlySet<SelectionKey>;
  bounds: Bounds | null;
  changed: boolean;
}

interface SelectionTransactionHistory {
  readonly past: readonly { readonly scene: boolean; readonly diagram: boolean }[];
  readonly future: readonly { readonly scene: boolean; readonly diagram: boolean }[];
}

interface DrawInteraction {
  pointerId: number;
  tool: Exclude<Tool, "select" | "text" | "pan">;
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
  boardId: string;
  checkpointId: string;
  package: DrawingBoardExportPackage;
}

const CANVAS_WIDTH = 1_440;
const CANVAS_HEIGHT = 900;
const DARK_BACKGROUND = "#151b20";
const INITIAL_VIEW: CanvasView = { zoom: 1, centerX: CANVAS_WIDTH / 2, centerY: CANVAS_HEIGHT / 2 };
const MIN_ZOOM = 0.08;
const MAX_ZOOM = 12;
const WORLD_LIMIT = 1_000_000;

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
  { id: "select", label: "Select and move board content", short: "Select" },
  { id: "pen", label: "Pen", short: "Pen" },
  { id: "marker", label: "Highlighter", short: "Mark" },
  { id: "eraser", label: "Eraser", short: "Erase" },
  { id: "arrow", label: "Arrow", short: "Arrow" },
  { id: "rectangle", label: "Rectangle", short: "Rect" },
  { id: "ellipse", label: "Ellipse", short: "Oval" },
  { id: "text", label: "Text label", short: "Text" },
  { id: "pan", label: "Pan canvas", short: "Hand" },
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

const DIAGRAM_TONES: readonly { id: DiagramNodeTone; label: string }[] = [
  { id: "neutral", label: "Neutral" },
  { id: "blue", label: "Blue" },
  { id: "green", label: "Green" },
  { id: "amber", label: "Amber" },
  { id: "red", label: "Red" },
  { id: "violet", label: "Violet" },
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

function sceneSelectionKey(id: string): SelectionKey {
  return `scene:${id}`;
}

function diagramSelectionKey(id: string): SelectionKey {
  return `diagram:${id}`;
}

function selectionId(key: SelectionKey): string {
  return key.slice(key.indexOf(":") + 1);
}

function boundsFromSelection(
  scene: Scene,
  diagram: DiagramDocument | null,
  keys: ReadonlySet<SelectionKey>,
): Bounds | null {
  const bounds: Bounds[] = [];
  for (const key of keys) {
    const id = selectionId(key);
    if (key.startsWith("scene:")) {
      const element = scene.elements.find((candidate) => candidate.id === id);
      if (element) bounds.push(getElementBounds(element));
    } else {
      const node = diagram?.nodes.find((candidate) => candidate.id === id);
      if (node) bounds.push({
        minX: node.x,
        minY: node.y,
        maxX: node.x + node.width,
        maxY: node.y + node.height,
        width: node.width,
        height: node.height,
      });
    }
  }
  if (bounds.length === 0) return null;
  const minX = Math.min(...bounds.map((item) => item.minX));
  const minY = Math.min(...bounds.map((item) => item.minY));
  const maxX = Math.max(...bounds.map((item) => item.maxX));
  const maxY = Math.max(...bounds.map((item) => item.maxY));
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

function pointerScenePoint(
  event: Pick<ReactPointerEvent<HTMLElement>, "clientX" | "clientY" | "pointerType" | "pressure" | "tiltX" | "tiltY" | "timeStamp">,
  canvas: HTMLCanvasElement,
  scene: Scene,
  view: CanvasView,
): ScenePoint {
  const transform = screenTransform(canvas, scene, view);
  return {
    x: (event.clientX - transform.panX) / transform.zoom,
    y: (event.clientY - transform.panY) / transform.zoom,
    pressure: event.pressure || 0.5,
    tiltX: event.tiltX || 0,
    tiltY: event.tiltY || 0,
    time: event.timeStamp,
    pointerType: event.pointerType === "pen" || event.pointerType === "touch" ? event.pointerType : "mouse",
  };
}

function lassoBounds(start: ScenePoint, end: ScenePoint): Bounds {
  const minX = Math.min(start.x, end.x);
  const minY = Math.min(start.y, end.y);
  const maxX = Math.max(start.x, end.x);
  const maxY = Math.max(start.y, end.y);
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

function diagramNodeIdFromRenderedElement(id: string, diagramId: string): string | null {
  const prefix = `diagram:${diagramId}:`;
  if (!id.startsWith(prefix)) return null;
  const remainder = id.slice(prefix.length);
  if (remainder.startsWith("node-label:")) return remainder.slice("node-label:".length);
  if (remainder.startsWith("node:")) return remainder.slice("node:".length);
  return null;
}

function worldBoundsStyle(
  canvas: HTMLCanvasElement | null,
  scene: Scene,
  view: CanvasView,
  bounds: Bounds | null,
): React.CSSProperties | undefined {
  if (!canvas || !bounds) return undefined;
  const metrics = measureCanvas(canvas, scene);
  const scale = metrics.fitScale * view.zoom;
  return {
    left: metrics.width / 2 + (bounds.minX - view.centerX) * scale,
    top: metrics.height / 2 + (bounds.minY - view.centerY) * scale,
    width: Math.max(2, bounds.width * scale),
    height: Math.max(2, bounds.height * scale),
  };
}

function fittedViewForScene(
  canvas: HTMLCanvasElement,
  scene: Scene,
  fallback: CanvasView,
): CanvasView {
  const bounds = getSceneBounds(scene);
  const metrics = measureCanvas(canvas, scene);
  if (metrics.width <= 0 || metrics.height <= 0) return fallback;
  const desiredScale = Math.min(
    (metrics.width * 0.84) / Math.max(1, bounds.width),
    (metrics.height * 0.84) / Math.max(1, bounds.height),
  );
  return {
    centerX: (bounds.minX + bounds.maxX) / 2,
    centerY: (bounds.minY + bounds.maxY) / 2,
    zoom: clamp(desiredScale / metrics.fitScale, MIN_ZOOM, MAX_ZOOM),
  };
}

function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
}

function toolIcon(tool: Tool): DrawingIconName {
  switch (tool) {
    case "select":
      return "select";
    case "pen":
      return "pen";
    case "marker":
      return "marker";
    case "eraser":
      return "eraser";
    case "arrow":
      return "arrow";
    case "rectangle":
      return "rectangle";
    case "ellipse":
      return "ellipse";
    case "text":
      return "text";
    case "pan":
      return "pan";
  }
}

function DrawingMinimap({
  contentBounds,
  viewportBounds,
  onRecenter,
}: {
  contentBounds: Bounds;
  viewportBounds: Bounds;
  onRecenter: (x: number, y: number) => void;
}) {
  const padding = Math.max(contentBounds.width, contentBounds.height, 200) * 0.08;
  const minX = Math.min(contentBounds.minX, viewportBounds.minX) - padding;
  const minY = Math.min(contentBounds.minY, viewportBounds.minY) - padding;
  const maxX = Math.max(contentBounds.maxX, viewportBounds.maxX) + padding;
  const maxY = Math.max(contentBounds.maxY, viewportBounds.maxY) + padding;
  const width = Math.max(1, maxX - minX);
  const height = Math.max(1, maxY - minY);
  const recenter = (event: ReactPointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    onRecenter(
      minX + ((event.clientX - rect.left) / rect.width) * width,
      minY + ((event.clientY - rect.top) / rect.height) * height,
    );
  };
  return (
    <div
      className="drawing-minimap"
      aria-label="Board minimap. Drag to recenter."
      role="application"
      onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); recenter(event); }}
      onPointerMove={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) recenter(event); }}
    >
      <span
        className="drawing-minimap__content"
        style={{
          left: `${((contentBounds.minX - minX) / width) * 100}%`,
          top: `${((contentBounds.minY - minY) / height) * 100}%`,
          width: `${Math.max(2, (contentBounds.width / width) * 100)}%`,
          height: `${Math.max(2, (contentBounds.height / height) * 100)}%`,
        }}
      />
      <span
        className="drawing-minimap__viewport"
        style={{
          left: `${((viewportBounds.minX - minX) / width) * 100}%`,
          top: `${((viewportBounds.minY - minY) / height) * 100}%`,
          width: `${Math.min(100, Math.max(5, (viewportBounds.width / width) * 100))}%`,
          height: `${Math.min(100, Math.max(5, (viewportBounds.height / height) * 100))}%`,
        }}
      />
    </div>
  );
}

function AreaSelectionOverlay({
  canvasRef,
  scene,
  view,
  bounds,
  onChange,
}: {
  canvasRef: RefObject<HTMLCanvasElement | null>;
  scene: Scene;
  view: CanvasView;
  bounds: Bounds;
  onChange: (bounds: Bounds) => void;
}) {
  const canvas = canvasRef.current;
  if (!canvas) return null;
  const metrics = measureCanvas(canvas, scene);
  const scale = metrics.fitScale * view.zoom;
  const left = metrics.width / 2 + (bounds.minX - view.centerX) * scale;
  const top = metrics.height / 2 + (bounds.minY - view.centerY) * scale;
  const width = Math.max(44, bounds.width * scale);
  const height = Math.max(44, bounds.height * scale);
  const begin = (event: ReactPointerEvent<HTMLElement>, mode: "move" | "resize") => {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startY = event.clientY;
    const start = bounds;
    const move = (next: PointerEvent) => {
      const deltaX = (next.clientX - startX) / scale;
      const deltaY = (next.clientY - startY) / scale;
      if (mode === "move") {
        onChange({
          minX: start.minX + deltaX,
          minY: start.minY + deltaY,
          maxX: start.maxX + deltaX,
          maxY: start.maxY + deltaY,
          width: start.width,
          height: start.height,
        });
      } else {
        const nextWidth = Math.max(80 / scale, start.width + deltaX);
        const nextHeight = Math.max(80 / scale, start.height + deltaY);
        onChange({ ...start, maxX: start.minX + nextWidth, maxY: start.minY + nextHeight, width: nextWidth, height: nextHeight });
      }
    };
    const end = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end, { once: true });
    window.addEventListener("pointercancel", end, { once: true });
  };
  return (
    <div
      className="drawing-area-selection"
      style={{ left, top, width, height }}
      onPointerDown={(event) => begin(event, "move")}
      aria-label="Selected export area. Drag to move."
    >
      <span>Selected area</span>
      <button type="button" aria-label="Resize selected area" onPointerDown={(event) => begin(event, "resize")} />
    </div>
  );
}

export function DrawingStudio({
  open,
  target,
  importOnOpen = false,
  initialSavedDrawing = null,
  connected = true,
  composerAttachmentMaxImages = 1,
  readOnly = false,
  sending = false,
  sendStatus = "idle",
  statusMessage = null,
  onClose,
  onSend,
  onKeep,
  onReconcileDelivery,
  onListDiagrams,
  onUpdateDiagram,
}: DrawingStudioProps) {
  const [displayedTarget, setDisplayedTarget] = useState<DrawingTarget | null>(null);
  const [history, dispatchHistory] = useReducer(historyReducer, undefined, () => freshHistory());
  const [diagramHistory, dispatchDiagramHistory] = useReducer(
    diagramHistoryReducer,
    undefined,
    () => createDiagramHistory(),
  );
  const [tool, setTool] = useState<Tool>("pen");
  const [color, setColor] = useState<string>(COLORS[0].value);
  const [size, setSize] = useState<number>(SIZES[1].value);
  const [instruction, setInstruction] = useState("");
  const [textValue, setTextValue] = useState("Label");
  const [pencilOnly, setPencilOnly] = useState(true);
  const [view, setView] = useState<CanvasView>(INITIAL_VIEW);
  const [drawingPreview, setDrawingPreview] = useState<DrawingPreview>(null);
  const [selection, setSelection] = useState<ReadonlySet<SelectionKey>>(() => new Set());
  const [selectionPreview, setSelectionPreview] = useState<SelectionPreview | null>(null);
  const [activeLasso, setActiveLasso] = useState<Bounds | null>(null);
  const [selectionTransactions, setSelectionTransactions] = useState<SelectionTransactionHistory>({
    past: [],
    future: [],
  });
  const [canvasRevision, setCanvasRevision] = useState(0);
  const [draftReady, setDraftReady] = useState(false);
  const [draftMessage, setDraftMessage] = useState<string | null>(null);
  const [keepMessage, setKeepMessage] = useState<string | null>(null);
  const [localSending, setLocalSending] = useState(false);
  const [localKeeping, setLocalKeeping] = useState(false);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [sendAfterBuild, setSendAfterBuild] = useState(false);
  const [exportPreview, setExportPreview] = useState<ExportPreview | null>(null);
  const [sendSheetOpen, setSendSheetOpen] = useState(false);
  const [exportScope, setExportScope] = useState<DrawingExportScope>("board");
  const [selectedExportBounds, setSelectedExportBounds] = useState<Bounds | null>(null);
  const [boardId, setBoardId] = useState(() => createUuidV4());
  const [savedBoards, setSavedBoards] = useState<readonly StoredDrawingBoard[]>([]);
  const [boardsOpen, setBoardsOpen] = useState(false);
  const [minimapVisible, setMinimapVisible] = useState(false);
  const minimapTimerRef = useRef<number | null>(null);
  const [clearPending, setClearPending] = useState(false);
  const [importSourceOpen, setImportSourceOpen] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [pendingDelivery, setPendingDelivery] =
    useState<PendingDrawingDeliveryBinding | null>(null);
  const [pendingDeliveryMatchesDraft, setPendingDeliveryMatchesDraft] = useState(false);
  const [reconcilingDelivery, setReconcilingDelivery] = useState(false);
  const [availableDiagrams, setAvailableDiagrams] = useState<readonly DiagramDocument[]>([]);
  const [incomingDiagram, setIncomingDiagram] = useState<DiagramDocument | null>(null);
  const [diagramDirty, setDiagramDirty] = useState(false);
  const [diagramSyncing, setDiagramSyncing] = useState(false);
  const [diagramMessage, setDiagramMessage] = useState<string | null>(null);
  const [diagramPickerOpen, setDiagramPickerOpen] = useState(false);
  const [selectedDiagramNodeId, setSelectedDiagramNodeId] = useState<string | null>(null);
  const [connectTargetNodeId, setConnectTargetNodeId] = useState("");
  const [diagramInspectorOpen, setDiagramInspectorOpen] = useState(false);
  const [diagramInspectorSection, setDiagramInspectorSection] =
    useState<DiagramInspectorSection>("style");

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
  const selectionGestureRef = useRef<SelectionGesture | null>(null);
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
  const onListDiagramsRef = useRef(onListDiagrams);
  const onUpdateDiagramRef = useRef(onUpdateDiagram);
  onCloseRef.current = onClose;
  onReconcileDeliveryRef.current = onReconcileDelivery;
  onListDiagramsRef.current = onListDiagrams;
  onUpdateDiagramRef.current = onUpdateDiagram;

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
  const diagram = diagramHistory.present;
  const displayedScene = selectionPreview?.scene ?? scene;
  const displayedDiagram = selectionPreview?.diagram ?? diagram;
  const renderedScene = useMemo(
    () => mergeDiagramIntoScene(displayedScene, displayedDiagram),
    [displayedDiagram, displayedScene],
  );
  const exportDescription = useMemo(() => sendSheetOpen
    ? describeDrawingBoardExport(
        renderedScene,
        exportScope,
        selectedExportBounds,
        composerAttachmentMaxImages,
        diagram,
      )
    : null, [
      composerAttachmentMaxImages,
      diagram,
      exportScope,
      renderedScene,
      selectedExportBounds,
      sendSheetOpen,
    ]);
  const sceneRef = useRef(scene);
  const diagramRef = useRef(diagram);
  const viewRef = useRef(view);
  viewRef.current = view;
  const unmountDraftRef = useRef({
    displayedTarget,
    draftReady,
    instruction,
    pencilOnly,
    scene,
    color,
    size,
    diagram,
    view,
    boardId,
  });
  unmountDraftRef.current = {
    displayedTarget,
    draftReady,
    instruction,
    pencilOnly,
    scene,
    color,
    size,
    diagram,
    view,
    boardId,
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
        diagramJson: latest.diagram ? JSON.stringify(latest.diagram) : null,
        camera: latest.view,
        boardId: latest.boardId,
      });
    });
  }, [enqueueDraftMutation]);

  useEffect(() => {
    setKeepMessage(null);
  }, [scene]);
  sceneRef.current = scene;
  diagramRef.current = diagram;
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
  const hasContent = scene.elements.length > 0 || diagram !== null;
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
    selectionGestureRef.current = null;
    gesturePointersRef.current.clear();
    allPointersRef.current.clear();
    gestureStartRef.current = null;
    penActiveRef.current = false;
    setDrawingPreview(null);
    setSelectionPreview(null);
    setActiveLasso(null);
  }, []);

  const clearDeliveryBinding = useCallback((threadId: string) => {
    const current = loadPendingDrawingDelivery(threadId);
    deletePendingDrawingDelivery(threadId);
    void deletePendingDrawingBoardExport(threadId, current?.commandId);
    setPendingDelivery((current) => current?.threadId === threadId ? null : current);
    setPendingDeliveryMatchesDraft(false);
  }, []);

  const discardDeliveredDraft = useCallback(async (
    threadId: string,
    checkpoint?: { checkpointId: string; scope: DrawingExportScope; imageNames: readonly string[] },
  ) => {
    draftPersistenceBlockedRef.current = true;
    setDraftReady(false);
    resetPointerState();
    await enqueueDraftMutation(async () => {
      const retained = checkpoint ? null : await loadPendingDrawingBoardExport(threadId);
      const resolvedCheckpoint = checkpoint ?? (retained ? {
        checkpointId: retained.checkpointId,
        scope: retained.scope,
        imageNames: retained.images.map((image) => image.fileName),
      } : null);
      await (resolvedCheckpoint
        ? checkpointAndFinishDrawingBoard(threadId, {
          checkpointId: resolvedCheckpoint.checkpointId,
          createdAt: new Date().toISOString(),
          status: "sent",
          scope: resolvedCheckpoint.scope,
          imageNames: resolvedCheckpoint.imageNames,
        })
        : deleteDrawingDraft(threadId));
    });
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
      dispatchDiagramHistory({ type: "reset", diagram: null });
      setInstruction("");
      setDraftReady(false);
      setView(INITIAL_VIEW);
      setBoardId(createUuidV4());
      setSavedBoards([]);
      setBoardsOpen(false);
      setSendSheetOpen(false);
      setExportScope("board");
      setSelectedExportBounds(null);
      setDisplayedTarget(target ? { ...target } : null);
      setAvailableDiagrams([]);
      setIncomingDiagram(null);
      setDiagramDirty(false);
      setDiagramSyncing(false);
      setDiagramMessage(null);
      setDiagramPickerOpen(false);
      setSelectedDiagramNodeId(null);
      setConnectTargetNodeId("");
      setDiagramInspectorOpen(false);
      setDiagramInspectorSection("style");
      setSelection(new Set());
      setSelectionTransactions({ past: [], future: [] });
    } else if (!open && wasOpenRef.current) {
      studioGenerationRef.current += 1;
      resetPointerState();
      dispatchHistory({ type: "reset", scene: freshHistory().present });
      dispatchDiagramHistory({ type: "reset", diagram: null });
      setSelection(new Set());
      setSelectionTransactions({ past: [], future: [] });
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
      setAvailableDiagrams([]);
      setIncomingDiagram(null);
      setDiagramDirty(false);
      setDiagramSyncing(false);
      setDiagramMessage(null);
      setDiagramPickerOpen(false);
      setSelectedDiagramNodeId(null);
      setConnectTargetNodeId("");
      setDiagramInspectorOpen(false);
      setDiagramInspectorSection("style");
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
          diagramJson: null,
          savedWorkingCopy: true,
        })
      : loadDrawingDraft(displayedTarget.threadId).then((draft) => draft ? { ...draft, savedWorkingCopy: false } : null);
    const publishedDiagramsSource = onListDiagramsRef.current
      ? onListDiagramsRef.current(displayedTarget.threadId).catch(() => [])
      : Promise.resolve([]);
    void Promise.all([drawingSource, publishedDiagramsSource])
      .then(async ([draft, publishedDiagrams]) => {
        if (!isCurrentGeneration()) return;
        let restoredScene: Scene;
        let restoredInstruction: string;
        let restoredDiagram: DiagramDocument | null = null;
        setAvailableDiagrams(publishedDiagrams);
        if (draft) {
          restoredScene = deserializeScene(draft.scene);
          restoredInstruction = draft.instruction;
          if (draft.diagramJson) {
            try {
              const parsed = DiagramDocumentSchema.safeParse(JSON.parse(draft.diagramJson) as unknown);
              restoredDiagram = parsed.success ? parsed.data : null;
            } catch {
              restoredDiagram = null;
            }
          }
          dispatchHistory({ type: "reset", scene: restoredScene });
          setInstruction(restoredInstruction);
          setPencilOnly(draft.pencilOnly);
          if ("boardId" in draft && typeof draft.boardId === "string") setBoardId(draft.boardId);
          if ("camera" in draft && draft.camera) setView(draft.camera);
          setDraftMessage(draft.savedWorkingCopy
            ? "Saved Drawing opened as an independent local working copy"
            : "Draft restored on this iPad");
        } else {
          restoredScene = freshHistory().present;
          restoredInstruction = "";
          dispatchHistory({ type: "reset", scene: restoredScene });
          setInstruction(restoredInstruction);
          setPencilOnly(true);
          setBoardId(createUuidV4());
          setDraftMessage("New page");
        }

        const latestPublished = publishedDiagrams[0] ?? null;
        const seen = readSeenDiagramRevision(displayedTarget.threadId);
        const latestIsUnseen = latestPublished !== null && (
          seen === null
          || seen.diagramId !== latestPublished.diagramId
          || seen.revision < latestPublished.revision
        );
        const canAutoLoadPublished = !initialSavedDrawing
          && restoredDiagram === null
          && restoredScene.elements.length === 0;
        if (restoredDiagram) {
          dispatchDiagramHistory({ type: "reset", diagram: restoredDiagram });
          markDiagramRevisionSeen(restoredDiagram);
          setTool("select");
          setSelectedDiagramNodeId(restoredDiagram.nodes[0]?.id ?? null);
          setSelection(restoredDiagram.nodes[0]
            ? new Set([diagramSelectionKey(restoredDiagram.nodes[0].id)])
            : new Set());
          setSelectionTransactions({ past: [], future: [] });
          setDiagramInspectorOpen(false);
          const canvas = canvasRef.current;
          if (canvas) {
            setView((current) => fittedViewForScene(
              canvas,
              mergeDiagramIntoScene(restoredScene, restoredDiagram),
              current,
            ));
          }
          setDraftMessage(draft?.savedWorkingCopy
            ? "Saved Drawing opened as an independent local working copy"
            : "Collaborative diagram draft restored on this iPad");
        } else if (latestPublished && latestIsUnseen && canAutoLoadPublished) {
          restoredDiagram = latestPublished;
          dispatchDiagramHistory({ type: "reset", diagram: latestPublished });
          markDiagramRevisionSeen(latestPublished);
          setTool("select");
          setSelectedDiagramNodeId(latestPublished.nodes[0]?.id ?? null);
          setSelection(latestPublished.nodes[0]
            ? new Set([diagramSelectionKey(latestPublished.nodes[0].id)])
            : new Set());
          setSelectionTransactions({ past: [], future: [] });
          setDiagramInspectorOpen(false);
          const canvas = canvasRef.current;
          if (canvas) {
            setView((current) => fittedViewForScene(
              canvas,
              mergeDiagramIntoScene(restoredScene, latestPublished),
              current,
            ));
          }
          setDraftMessage(`Diagram from Codex ready · revision ${latestPublished.revision}`);
        } else {
          dispatchDiagramHistory({ type: "reset", diagram: null });
          setSelection(new Set());
          setSelectionTransactions({ past: [], future: [] });
          if (latestPublished && latestIsUnseen) setIncomingDiagram(latestPublished);
        }
        setDiagramDirty(false);

        const binding = storedDelivery;
        if (!binding || !isCurrentGeneration()) return;
        const identity = await createDrawingDeliveryIdentity(
          serializeScene(mergeDiagramIntoScene(restoredScene, restoredDiagram)),
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
        if (isCurrentGeneration() && !draftPersistenceBlockedRef.current) {
          setDraftReady(true);
          void listDrawingBoards(displayedTarget.threadId).then((boards) => {
            if (isCurrentGeneration()) setSavedBoards(boards);
          });
        }
      });
    return () => {
      active = false;
    };
  }, [displayedTarget?.threadId, initialSavedDrawing?.id, open, reconcileDelivery]);

  const openPublishedDiagram = useCallback((next: DiagramDocument) => {
    dispatchDiagramHistory({ type: "reset", diagram: next });
    diagramRef.current = next;
    markDiagramRevisionSeen(next);
    setDiagramDirty(false);
    setDiagramMessage(`Revision ${next.revision} from ${next.lastEditedBy === "codex" ? "Codex" : "this iPad"} loaded`);
    setIncomingDiagram(null);
    setDiagramPickerOpen(false);
    setSelectedDiagramNodeId(next.nodes[0]?.id ?? null);
    setConnectTargetNodeId("");
    setDiagramInspectorOpen(false);
    setDiagramInspectorSection("style");
    setTool("select");
    setSelection(next.nodes[0] ? new Set([diagramSelectionKey(next.nodes[0].id)]) : new Set());
    const canvas = canvasRef.current;
    if (canvas) {
      setView((current) => fittedViewForScene(
        canvas,
        mergeDiagramIntoScene(sceneRef.current, next),
        current,
      ));
    }
    setExportPreview(null);
    setLocalError(null);
  }, []);

  useEffect(() => {
    if (!open || !draftReady || !displayedTarget || !onListDiagramsRef.current) return;
    let active = true;
    const refresh = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const records = await onListDiagramsRef.current?.(displayedTarget.threadId) ?? [];
        if (!active) return;
        setAvailableDiagrams(records);
        const latest = records[0];
        if (!latest) return;
        const current = diagramRef.current;
        if (current?.diagramId === latest.diagramId && latest.revision > current.revision) {
          if (!diagramDirty) openPublishedDiagram(latest);
          else setIncomingDiagram(latest);
          return;
        }
        if (current === null) {
          const seen = readSeenDiagramRevision(displayedTarget.threadId);
          const unseen = seen === null
            || seen.diagramId !== latest.diagramId
            || seen.revision < latest.revision;
          if (!unseen) return;
          if (!diagramDirty && sceneRef.current.elements.length === 0) openPublishedDiagram(latest);
          else setIncomingDiagram(latest);
        }
      } catch {
        // Polling is opportunistic. The local draft remains authoritative.
      }
    };
    const interval = window.setInterval(() => void refresh(), 2_500);
    const onVisibility = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      active = false;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [diagramDirty, displayedTarget, draftReady, open, openPublishedDiagram]);

  const commitDiagramChange = useCallback((next: DiagramDocument) => {
    diagramRef.current = next;
    dispatchDiagramHistory({ type: "commit", diagram: next });
    setDiagramDirty(true);
    setDiagramMessage("Changes saved on this iPad · sync when ready");
    setExportPreview(null);
    setLocalError(null);
    setSelectionTransactions({ past: [], future: [] });
  }, []);

  const undoSelectionTransaction = useCallback(() => {
    const transaction = selectionTransactions.past.at(-1);
    if (!transaction) return false;
    if (transaction.scene) dispatchHistory({ type: "undo" });
    if (transaction.diagram) {
      dispatchDiagramHistory({ type: "undo" });
      setDiagramDirty(true);
      setDiagramMessage("Changes saved on this iPad · sync when ready");
    }
    setSelectionTransactions((current) => ({
      past: current.past.slice(0, -1),
      future: [transaction, ...current.future].slice(0, 100),
    }));
    setExportPreview(null);
    return true;
  }, [selectionTransactions.past]);

  const redoSelectionTransaction = useCallback(() => {
    const transaction = selectionTransactions.future[0];
    if (!transaction) return false;
    if (transaction.scene) dispatchHistory({ type: "redo" });
    if (transaction.diagram) {
      dispatchDiagramHistory({ type: "redo" });
      setDiagramDirty(true);
      setDiagramMessage("Changes saved on this iPad · sync when ready");
    }
    setSelectionTransactions((current) => ({
      past: [...current.past.slice(-99), transaction],
      future: current.future.slice(1),
    }));
    setExportPreview(null);
    return true;
  }, [selectionTransactions.future]);

  const syncDiagram = useCallback(async (): Promise<DiagramDocument | null> => {
    const current = diagramRef.current;
    if (!current) return null;
    if (!diagramDirty) return current;
    if (
      !displayedTarget
      || current.threadId !== displayedTarget.threadId
      || !onUpdateDiagramRef.current
    ) {
      setLocalError("Reconnect to the Mac before syncing this diagram revision.");
      return null;
    }
    const generation = studioGenerationRef.current;
    setDiagramSyncing(true);
    setLocalError(null);
    try {
      const saved = await onUpdateDiagramRef.current(
        current.diagramId,
        current.threadId,
        {
          expectedRevision: current.revision,
          title: current.title,
          nodes: current.nodes,
          edges: current.edges,
        },
      );
      if (generation !== studioGenerationRef.current) return null;
      diagramRef.current = saved;
      dispatchDiagramHistory({ type: "reset", diagram: saved });
      setAvailableDiagrams((records) => [
        saved,
        ...records.filter((record) => record.diagramId !== saved.diagramId),
      ]);
      setDiagramDirty(false);
      setIncomingDiagram(null);
      markDiagramRevisionSeen(saved);
      setDiagramMessage(`Revision ${saved.revision} synced to the Mac`);
      return saved;
    } catch (error) {
      if (generation === studioGenerationRef.current) {
        setLocalError(error instanceof Error
          ? error.message
          : "Diagram changes could not be synced to the Mac.");
        try {
          const latest = (await onListDiagramsRef.current?.(current.threadId))?.find(
            (record) => record.diagramId === current.diagramId,
          );
          if (latest && latest.revision > current.revision) setIncomingDiagram(latest);
        } catch {
          // The original sync error remains the useful status.
        }
      }
      return null;
    } finally {
      if (generation === studioGenerationRef.current) setDiagramSyncing(false);
    }
  }, [diagramDirty, displayedTarget]);

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
            diagramJson: diagram ? JSON.stringify(diagram) : null,
            camera: viewRef.current,
            boardId,
          });
        });
        if (announce) setDraftMessage("Saved on this iPad");
      } catch {
        if (announce) setDraftMessage("Draft could not be saved");
      }
    },
    [boardId, diagram, displayedTarget, draftReady, enqueueDraftMutation, instruction, pencilOnly],
  );

  useEffect(() => {
    if (!draftReady) return;
    // Autosave is background durability, not a new user-facing event. Keeping
    // it silent prevents it from erasing useful confirmations such as an image
    // import, a restored draft, or a completed attachment.
    const timer = window.setTimeout(() => void persistDraft(false), 550);
    return () => window.clearTimeout(timer);
  }, [diagram, draftReady, persistDraft, scene]);

  useEffect(() => {
    if (!draftReady || !displayedTarget || !isExactDrawingTarget(displayedTarget)) return;
    const timer = window.setTimeout(() => {
      void enqueueDraftMutation(() => saveDrawingBoardCamera(displayedTarget.threadId, view));
    }, 240);
    return () => window.clearTimeout(timer);
  }, [displayedTarget, draftReady, enqueueDraftMutation, view]);

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
    renderDrawingCanvas(canvas, renderedScene, view, drawingPreview, requestCanvasRedraw);
  }, [canvasRevision, drawingPreview, open, renderedScene, requestCanvasRedraw, view]);

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
        if (tool === "select" && (event.shiftKey ? redoSelectionTransaction() : undoSelectionTransaction())) {
          return;
        }
        if (tool === "select" && diagram && selection.size > 0 && [...selection].some((key) => key.startsWith("diagram:"))) {
          dispatchDiagramHistory({ type: event.shiftKey ? "redo" : "undo" });
          setDiagramDirty(true);
        } else dispatchHistory({ type: event.shiftKey ? "redo" : "undo" });
        setExportPreview(null);
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "y") {
        event.preventDefault();
        if (tool === "select" && redoSelectionTransaction()) return;
        if (tool === "select" && diagram && selection.size > 0 && [...selection].some((key) => key.startsWith("diagram:"))) {
          dispatchDiagramHistory({ type: "redo" });
          setDiagramDirty(true);
        } else {
          dispatchHistory({ type: "redo" });
        }
        setExportPreview(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [clearPending, diagram, editorLocked, exportPreview, open, redoSelectionTransaction, selection, tool, undoSelectionTransaction]);

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
        centerX: start.cameraCenterX - (next.centerX - start.gestureCenterX) / (start.fitScale * start.zoom),
        centerY: start.cameraCenterY - (next.centerY - start.gestureCenterY) / (start.fitScale * start.zoom),
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
      setSelectionTransactions({ past: [], future: [] });
      setExportPreview(null);
      setLocalError(null);
    },
    [color, size],
  );

  const previewSelectionGesture = useCallback((gesture: SelectionGesture, point: ScenePoint) => {
    if (gesture.mode === "lasso") {
      const nextBounds = lassoBounds(gesture.start, point);
      gesture.bounds = nextBounds;
      setActiveLasso(nextBounds);
      gesture.changed = Math.hypot(point.x - gesture.start.x, point.y - gesture.start.y) > 4;
      return;
    }
    const bounds = gesture.bounds;
    if (!bounds) return;
    let deltaX = point.x - gesture.start.x;
    let deltaY = point.y - gesture.start.y;
    let scaleX = 1;
    let scaleY = 1;
    if (gesture.mode === "resize") {
      const width = Math.max(1, bounds.width);
      const height = Math.max(1, bounds.height);
      const requestedScale = Math.max(0.05, Math.max(
        (point.x - bounds.minX) / width,
        (point.y - bounds.minY) / height,
      ));
      const selectedDiagramNodes = gesture.originalDiagram?.nodes.filter(
        (node) => gesture.keys.has(diagramSelectionKey(node.id)),
      ) ?? [];
      const minimumScale = selectedDiagramNodes.reduce(
        (minimum, node) => Math.max(minimum, 120 / node.width, 64 / node.height),
        0.05,
      );
      const maximumScale = selectedDiagramNodes.reduce(
        (maximum, node) => Math.min(maximum, 520 / node.width, 260 / node.height),
        Number.POSITIVE_INFINITY,
      );
      const scale = clamp(requestedScale, minimumScale, maximumScale);
      scaleX = scale;
      scaleY = scale;
      deltaX = 0;
      deltaY = 0;
    }
    const sceneIds = new Set(
      [...gesture.keys]
        .filter((key) => key.startsWith("scene:"))
        .map(selectionId),
    );
    const replacements = transformElements(gesture.originalScene, sceneIds, {
      origin: { x: bounds.minX, y: bounds.minY },
      scaleX,
      scaleY,
      deltaX,
      deltaY,
    });
    const nextScene = replacements.length > 0
      ? applySceneOperation(gesture.originalScene, { type: "replaceElements", elements: replacements })
      : gesture.originalScene;
    const nextDiagram = gesture.originalDiagram === null
      ? null
      : gesture.originalDiagram.nodes.reduce((current, node) => {
          if (!gesture.keys.has(diagramSelectionKey(node.id))) return current;
          return updateDiagramNode(current, node.id, {
            x: bounds.minX + (node.x - bounds.minX) * scaleX + deltaX,
            y: bounds.minY + (node.y - bounds.minY) * scaleY + deltaY,
            width: node.width * scaleX,
            height: node.height * scaleY,
          });
        }, gesture.originalDiagram);
    gesture.changed = Math.abs(deltaX) > 0.01
      || Math.abs(deltaY) > 0.01
      || Math.abs(scaleX - 1) > 0.001;
    setSelectionPreview({ scene: nextScene, diagram: nextDiagram });
  }, []);

  const finishSelectionGesture = useCallback((cancelled: boolean) => {
    const gesture = selectionGestureRef.current;
    if (!gesture) return;
    selectionGestureRef.current = null;
    if (gesture.mode === "lasso") {
      const bounds = gesture.bounds;
      setActiveLasso(null);
      if (cancelled || !bounds || !gesture.changed) {
        setSelection(new Set());
        return;
      }
      const directSceneIds = new Set(
        elementsIntersectingBounds(gesture.originalScene, bounds).map((element) => element.id),
      );
      const sceneIds = expandSelectionForErasers(gesture.originalScene, directSceneIds);
      const keys = new Set<SelectionKey>([...sceneIds].map(sceneSelectionKey));
      for (const node of gesture.originalDiagram?.nodes ?? []) {
        const nodeBounds: Bounds = {
          minX: node.x,
          minY: node.y,
          maxX: node.x + node.width,
          maxY: node.y + node.height,
          width: node.width,
          height: node.height,
        };
        if (
          nodeBounds.maxX >= bounds.minX
          && nodeBounds.minX <= bounds.maxX
          && nodeBounds.maxY >= bounds.minY
          && nodeBounds.minY <= bounds.maxY
        ) keys.add(diagramSelectionKey(node.id));
      }
      setSelection(keys);
      const selectedDiagramKey = [...keys].find((key) => key.startsWith("diagram:"));
      setSelectedDiagramNodeId(selectedDiagramKey ? selectionId(selectedDiagramKey) : null);
      setDiagramInspectorOpen(false);
      return;
    }
    const preview = selectionPreview;
    setSelectionPreview(null);
    if (cancelled) return;
    if (!gesture.changed) {
      if ([...gesture.keys].some((key) => key.startsWith("diagram:"))) {
        setDiagramInspectorOpen(true);
      }
      return;
    }
    if (!preview) return;
    const sceneIds = new Set(
      [...gesture.keys].filter((key) => key.startsWith("scene:")).map(selectionId),
    );
    const replacements = preview.scene.elements.filter((element) => sceneIds.has(element.id));
    const changedScene = replacements.length > 0;
    const changedDiagram = Boolean(
      preview.diagram && gesture.originalDiagram && preview.diagram !== gesture.originalDiagram,
    );
    if (changedScene) {
      sceneRef.current = applySceneOperation(sceneRef.current, {
        type: "replaceElements",
        elements: replacements,
      });
      dispatchHistory({ type: "commit", operation: { type: "replaceElements", elements: replacements } });
    }
    if (preview.diagram && changedDiagram) {
      diagramRef.current = preview.diagram;
      dispatchDiagramHistory({ type: "commit", diagram: preview.diagram });
      setDiagramDirty(true);
      setDiagramMessage("Changes saved on this iPad · sync when ready");
    }
    if (changedScene || changedDiagram) {
      setSelectionTransactions((current) => ({
        past: [...current.past.slice(-99), { scene: changedScene, diagram: changedDiagram }],
        future: [],
      }));
    }
    setExportPreview(null);
    setLocalError(null);
  }, [selectionPreview]);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      // Draft restoration is asynchronous. Never accept a stroke that a late
      // restore can overwrite; the canvas exposes aria-busy so touch clients
      // and deterministic tests can wait for the same observable boundary.
      if (!draftReady || editorLocked || event.button > 0) return;
      event.preventDefault();
      if (event.pointerType === "pen") {
        penActiveRef.current = true;
        clearTouchPointersForPen(event, allPointersRef.current, gesturePointersRef.current);
        gestureStartRef.current = null;
      }
      if (pencilOnly && event.pointerType === "touch" && tool !== "select") {
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
      if (pencilOnly && event.pointerType !== "pen" && tool !== "select") {
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
        selectionGestureRef.current = null;
        setSelectionPreview(null);
        setActiveLasso(null);
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
      if (tool === "select") {
        try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* WebKit can reject palm capture. */ }
        const start = pointerScenePoint(event, canvas, renderedScene, view);
        const hit = topmostElementAtPoint(renderedScene, start, 10 / Math.max(transform.zoom, 0.001));
        const diagramNodeId = hit && diagram
          ? diagramNodeIdFromRenderedElement(hit.id, diagram.diagramId)
          : null;
        let key: SelectionKey | null = null;
        if (diagramNodeId) {
          key = diagramSelectionKey(diagramNodeId);
          setSelectedDiagramNodeId(diagramNodeId);
          setConnectTargetNodeId("");
          setDiagramInspectorSection("style");
        } else if (hit && scene.elements.some((element) => element.id === hit.id)) {
          key = sceneSelectionKey(hit.id);
          setSelectedDiagramNodeId(null);
          setDiagramInspectorOpen(false);
        }
        const currentSelectionBounds = boundsFromSelection(scene, diagram, selection);
        const moveExistingSelection = key === null
          && selection.size > 0
          && currentSelectionBounds !== null
          && boundsContainPoint(currentSelectionBounds, start, 4 / Math.max(transform.zoom, 0.001));
        let keys = selection;
        if (key && !selection.has(key)) {
          if (key.startsWith("scene:")) {
            const expanded = expandSelectionForErasers(scene, new Set([selectionId(key)]));
            keys = new Set([...expanded].map(sceneSelectionKey));
          } else {
            keys = new Set([key]);
          }
          setSelection(keys);
        }
        const bounds = key || moveExistingSelection
          ? boundsFromSelection(scene, diagram, keys)
          : null;
        selectionGestureRef.current = {
          pointerId: event.pointerId,
          mode: key || moveExistingSelection ? "move" : "lasso",
          start,
          originalScene: scene,
          originalDiagram: diagram,
          keys: key || moveExistingSelection ? keys : new Set(),
          bounds,
          changed: false,
        };
        if (!key && !moveExistingSelection) {
          setSelection(new Set());
          setSelectedDiagramNodeId(null);
          setDiagramInspectorOpen(false);
          setActiveLasso(lassoBounds(start, start));
        }
        return;
      }
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
    [beginGesture, color, diagram, draftReady, editorLocked, pencilOnly, renderedScene, resetGestureStart, scene, selection, size, textValue, tool, view],
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
      const selectionGesture = selectionGestureRef.current;
      if (selectionGesture?.pointerId === event.pointerId) {
        const canvas = canvasRef.current;
        if (!canvas) return;
        event.preventDefault();
        previewSelectionGesture(selectionGesture, pointerScenePoint(event, canvas, renderedScene, view));
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
    [color, previewSelectionGesture, renderedScene, scene, size, updateGesture, view],
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
      if (selectionGestureRef.current?.pointerId === event.pointerId) {
        finishSelectionGesture(cancelled);
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
    [commitInteraction, finishSelectionGesture, pencilOnly, resetGestureStart, scene, view],
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
        const canvas = canvasRef.current;
        const currentView = viewRef.current;
        const metrics = canvas ? measureCanvas(canvas, currentScene) : null;
        const worldWidth = metrics
          ? metrics.width / Math.max(0.0001, metrics.fitScale * currentView.zoom)
          : currentScene.viewport.width;
        const worldHeight = metrics
          ? metrics.height / Math.max(0.0001, metrics.fitScale * currentView.zoom)
          : currentScene.viewport.height;
        const visibleFrame = fitImageInside(prepared, { width: worldWidth, height: worldHeight }, 0.72);
        const frame = {
          ...visibleFrame,
          x: currentView.centerX - worldWidth / 2 + visibleFrame.x,
          y: currentView.centerY - worldHeight / 2 + visibleFrame.y,
        };
        const imageId = elementId();
        const image = createImageElement({
          id: imageId,
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
        setSelection(new Set([sceneSelectionKey(imageId)]));
        setSelectionTransactions({ past: [], future: [] });
        setTool("select");
        setDraftMessage(`${file.name || "Image"} added · drag to place it`);
      } catch (error) {
        setLocalError(error instanceof Error ? error.message : "The image could not be imported.");
      }
    },
    [],
  );

  const confirmClear = useCallback(() => {
    if (diagramRef.current) markDiagramRevisionSeen(diagramRef.current);
    diagramRef.current = null;
    dispatchDiagramHistory({ type: "reset", diagram: null });
    setDiagramDirty(false);
    setDiagramMessage(null);
    setSelectedDiagramNodeId(null);
    setConnectTargetNodeId("");
    setDiagramInspectorOpen(false);
    setDiagramInspectorSection("style");
    setTool("pen");
    setSelection(new Set());
    setSelectionPreview(null);
    setSelectionTransactions({ past: [], future: [] });
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
      const retained = pendingDelivery
        ? await loadPendingDrawingBoardExport(displayedTarget?.threadId ?? "")
        : null;
      if (pendingDelivery && retained?.commandId !== pendingDelivery.commandId) {
        throw new Error("The exact retained image batch is unavailable; its unresolved transfer cannot be rebuilt or replayed.");
      }
      let exportDiagram = diagramRef.current;
      if (!retained && exportDiagram && diagramDirty) {
        const synced = await syncDiagram();
        if (!synced) return;
        exportDiagram = synced;
      }
      const checkpointId = retained?.checkpointId ?? createUuidV4();
      const exported = retained ? {
        scope: retained.scope,
        images: retained.images,
        manifest: retained.manifest,
      } satisfies DrawingBoardExportPackage : await exportDrawingBoard({
        scene: mergeDiagramIntoScene(sceneRef.current, exportDiagram),
        scope: exportScope,
        selectedBounds: selectedExportBounds,
        composerAttachmentMaxImages,
        boardId,
        checkpointId,
        diagram: exportDiagram,
      });
      const next: ExportPreview = {
        commandId: pendingDelivery?.commandId ?? commandId(),
        targetSnapshotSeq: pendingDelivery?.expectedSnapshotSeq
          ?? (sameDrawingTarget(displayedTarget, target)
            ? (target?.snapshotSeq ?? displayedTarget?.snapshotSeq ?? 0)
            : (displayedTarget?.snapshotSeq ?? 0)),
        lockedInstruction: pendingDelivery ? instruction : null,
        boardId: retained?.boardId ?? boardId,
        checkpointId,
        package: exported,
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
    boardId,
    composerAttachmentMaxImages,
    diagramDirty,
    exportScope,
    hasContent,
    instruction,
    pendingDelivery,
    pendingDeliveryRetryable,
    previewBusy,
    selectedExportBounds,
    syncDiagram,
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
      if (diagramRef.current && diagramDirty) {
        setLocalError("The diagram changed after this package was prepared. Prepare the linked images again before sending.");
        setExportPreview(null);
        return;
      }
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

      const serializedScene = serializeScene(
        mergeDiagramIntoScene(scene, diagramRef.current),
      );
      const identity = await createDrawingDeliveryIdentity(serializedScene, deliveryInstruction);
      if (binding && !bindingMatchesDrawingDraft(binding, identity)) {
        setLocalError("The exact pending draft changed. A fresh transfer ID is blocked until its outcome is known.");
        return;
      }

      if (!binding) {
        await saveDrawingDraft(displayedTarget.threadId, {
          scene: serializeScene(scene),
          instruction: deliveryInstruction,
          background: scene.background.mode,
          pencilOnly,
          diagramJson: diagramRef.current ? JSON.stringify(diagramRef.current) : null,
          camera: view,
          boardId: exportPreview.boardId,
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
        await savePendingDrawingBoardExport({
          commandId: binding.commandId,
          threadId: binding.threadId,
          boardId: exportPreview.boardId,
          checkpointId: exportPreview.checkpointId,
          targetSnapshotSeq: exportPreview.targetSnapshotSeq,
          scope: exportPreview.package.scope,
          images: exportPreview.package.images,
          manifest: exportPreview.package.manifest,
          createdAt: new Date().toISOString(),
        });
        if (!savePendingDrawingDelivery(binding)) {
          await deletePendingDrawingBoardExport(binding.threadId, binding.commandId);
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
        png: exportPreview.package.images[0]!.blob,
        pngBase64: await blobToBase64(exportPreview.package.images[0]!.blob),
        boardId: exportPreview.boardId,
        checkpointId: exportPreview.checkpointId,
        scope: exportPreview.package.scope,
        images: exportPreview.package.images,
        manifest: exportPreview.package.manifest,
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
        await deletePendingDrawingBoardExport(binding.threadId, binding.commandId);
        clearDeliveryBinding(binding.threadId);
        setLocalError(result.message ?? "The bridge rejected this sketch.");
        setExportPreview((current) => current
          ? { ...current, commandId: commandId(), lockedInstruction: null }
          : current);
        return;
      }
      await discardDeliveredDraft(binding.threadId, {
        checkpointId: exportPreview.checkpointId,
        scope: exportPreview.package.scope,
        imageNames: exportPreview.package.images.map((image) => image.fileName),
      });
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
          : `${String(error)} Retry keeps the same transfer ID.`,
      );
    } finally {
      setLocalSending(false);
    }
  }, [
    clearDeliveryBinding,
    discardDeliveredDraft,
    displayedTarget,
    diagramDirty,
    exportPreview,
    instruction,
    onSend,
    pencilOnly,
    pendingDelivery,
    pendingDeliveryMatchesTarget,
    reconcileDelivery,
    scene,
    sendGuard.allowed,
    view,
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

  const currentViewportBounds = useCallback((): Bounds => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return { minX: 0, minY: 0, maxX: CANVAS_WIDTH, maxY: CANVAS_HEIGHT, width: CANVAS_WIDTH, height: CANVAS_HEIGHT };
    }
    const rect = canvas.getBoundingClientRect();
    const transform = screenTransform(canvas, sceneRef.current, view);
    const minX = (rect.left - transform.panX) / transform.zoom;
    const minY = (rect.top - transform.panY) / transform.zoom;
    const maxX = (rect.right - transform.panX) / transform.zoom;
    const maxY = (rect.bottom - transform.panY) / transform.zoom;
    return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
  }, [view]);

  const openSendSheet = useCallback(() => {
    if (pendingDeliveryRetryable) {
      requestSend();
      return;
    }
    setExportPreview(null);
    setExportScope("board");
    setSelectedExportBounds(currentViewportBounds());
    setSendSheetOpen(true);
  }, [currentViewportBounds, pendingDeliveryRetryable, requestSend]);

  const confirmSendSheet = useCallback(() => {
    setSendSheetOpen(false);
    setSendAfterBuild(true);
    void buildPreview();
  }, [buildPreview]);

  const keepDrawing = useCallback(async () => {
    if (!onKeep || !displayedTarget || !hasContent || localKeeping) return;
    const generation = studioGenerationRef.current;
    setLocalKeeping(true);
    setLocalError(null);
    setKeepMessage(null);
    try {
      if (diagramRef.current && diagramDirty) {
        const synced = await syncDiagram();
        if (!synced) return;
      }
      const sceneToKeep = mergeDiagramIntoScene(scene, diagramRef.current);
      const { blob, geometry } = await exportSceneToBoundedPng(sceneToKeep, {
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
        sceneJson: serializeScene(sceneToKeep),
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
  }, [diagramDirty, displayedTarget, hasContent, instruction, localKeeping, onKeep, scene, syncDiagram]);

  const openSavedBoard = useCallback(async (savedBoard: StoredDrawingBoard) => {
    if (!displayedTarget || editorLocked) return;
    setLocalError(null);
    try {
      await persistDraft(false);
      await resumeDrawingBoard(displayedTarget.threadId, savedBoard.boardId);
      const restored = await loadDrawingDraft(displayedTarget.threadId);
      if (!restored) throw new Error("The selected board could not be restored.");
      const restoredScene = deserializeScene(restored.scene);
      dispatchHistory({ type: "reset", scene: restoredScene });
      sceneRef.current = restoredScene;
      setBoardId(savedBoard.boardId);
      setView(restored.camera ?? INITIAL_VIEW);
      setInstruction(restored.instruction);
      setPencilOnly(restored.pencilOnly);
      setSelection(new Set());
      setSelectionPreview(null);
      if (restored.diagramJson) {
        const parsed = DiagramDocumentSchema.safeParse(JSON.parse(restored.diagramJson));
        dispatchDiagramHistory({ type: "reset", diagram: parsed.success ? parsed.data : null });
      } else {
        dispatchDiagramHistory({ type: "reset", diagram: null });
      }
      setBoardsOpen(false);
      setDraftMessage("Sent board reopened for a new revision");
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : "The board could not be opened.");
    }
  }, [displayedTarget, editorLocked, persistDraft]);

  const zoomBy = useCallback((factor: number) => {
    setView((current) => ({ ...current, zoom: clamp(current.zoom * factor, MIN_ZOOM, MAX_ZOOM) }));
  }, []);

  useEffect(() => {
    if (!open || !draftReady) return;
    setMinimapVisible(true);
    if (minimapTimerRef.current !== null) window.clearTimeout(minimapTimerRef.current);
    minimapTimerRef.current = window.setTimeout(() => setMinimapVisible(false), 1_500);
    return () => {
      if (minimapTimerRef.current !== null) window.clearTimeout(minimapTimerRef.current);
    };
  }, [draftReady, open, view]);

  useEffect(() => {
    const centerX = clamp(view.centerX, -WORLD_LIMIT, WORLD_LIMIT);
    const centerY = clamp(view.centerY, -WORLD_LIMIT, WORLD_LIMIT);
    if (centerX !== view.centerX || centerY !== view.centerY) {
      setView((current) => ({ ...current, centerX, centerY }));
    }
  }, [view.centerX, view.centerY]);

  const fitBoard = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const bounds = getSceneBounds(renderedScene);
    const metrics = measureCanvas(canvas, renderedScene);
    const desiredScale = Math.min(
      (metrics.width * 0.84) / Math.max(1, bounds.width),
      (metrics.height * 0.84) / Math.max(1, bounds.height),
    );
    setView({
      centerX: (bounds.minX + bounds.maxX) / 2,
      centerY: (bounds.minY + bounds.maxY) / 2,
      zoom: clamp(desiredScale / metrics.fitScale, MIN_ZOOM, MAX_ZOOM),
    });
  }, [renderedScene]);

  const selectedBoardBounds = boundsFromSelection(displayedScene, displayedDiagram, selection);
  const selectedBoardStyle = worldBoundsStyle(
    canvasRef.current,
    renderedScene,
    view,
    selectedBoardBounds,
  );
  const lassoStyle = worldBoundsStyle(canvasRef.current, renderedScene, view, activeLasso);

  if (!open) return null;

  const targetChanged = Boolean(displayedTarget && !sameDrawingTarget(displayedTarget, target));
  const selectedDiagramNode = diagram?.nodes.find(
    (node) => node.id === selectedDiagramNodeId,
  ) ?? null;
  const selectedDiagramNodeIndex = selectedDiagramNode && diagram
    ? diagram.nodes.findIndex((node) => node.id === selectedDiagramNode.id)
    : -1;
  const connectedDiagramEdges = diagram?.edges.filter(
    (edge) => edge.from === selectedDiagramNodeId || edge.to === selectedDiagramNodeId,
  ) ?? [];
  const boardBounds = getSceneBounds(renderedScene);
  const visibleWorldBounds = currentViewportBounds();
  const statusText = localError
    ?? (reconcilingDelivery ? "Checking the previous attachment with the Mac bridge…" : null)
    ?? keepMessage
    ?? statusMessage
    ?? diagramMessage
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
          <DrawingIcon name="close" />
        </button>
      </header>

      {targetChanged && (
        <div className="drawing-studio__warning" role="alert">
          Dashboard selection changed. This page is still pinned to {displayedTarget?.title || "its original task"}.
          Close and reopen to confirm a different destination.
        </div>
      )}

      <div
        className={[
          "drawing-studio__workspace",
          diagramInspectorOpen ? "has-diagram-inspector" : "",
        ].filter(Boolean).join(" ")}
      >
        <aside className="drawing-tools" aria-label="Drawing tools">
          <div className="drawing-tools__rack" role="toolbar" aria-label="Ink and shape tools">
            {TOOLS.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`drawing-tool${tool === item.id ? " is-active" : ""}`}
                aria-pressed={tool === item.id}
                aria-label={item.label}
                onClick={() => {
                  setTool(item.id);
                  if (item.id !== "select") setSelection(new Set());
                }}
                disabled={editorLocked}
              >
                <span className="drawing-tool__glyph" aria-hidden="true">
                  <DrawingIcon name={toolIcon(item.id)} />
                </span>
                <span className="drawing-tool__label">{item.short}</span>
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
              onClick={() => {
                if (tool === "select" && undoSelectionTransaction()) return;
                if (tool === "select" && diagram && selection.size > 0 && [...selection].some((key) => key.startsWith("diagram:"))) {
                  dispatchDiagramHistory({ type: "undo" });
                  setDiagramDirty(true);
                } else {
                  dispatchHistory({ type: "undo" });
                }
                setExportPreview(null);
              }}
              disabled={(
                selectionTransactions.past.length === 0
                && (tool === "select" && diagram && selection.size > 0 && [...selection].some((key) => key.startsWith("diagram:"))
                  ? diagramHistory.past.length === 0
                  : history.past.length === 0)
              ) || editorLocked}
              aria-label="Undo"
            ><DrawingIcon name="undo" /><span>Undo</span></button>
            <button
              type="button"
              onClick={() => {
                if (tool === "select" && redoSelectionTransaction()) return;
                if (tool === "select" && diagram && selection.size > 0 && [...selection].some((key) => key.startsWith("diagram:"))) {
                  dispatchDiagramHistory({ type: "redo" });
                  setDiagramDirty(true);
                } else {
                  dispatchHistory({ type: "redo" });
                }
                setExportPreview(null);
              }}
              disabled={(
                selectionTransactions.future.length === 0
                && (tool === "select" && diagram && selection.size > 0 && [...selection].some((key) => key.startsWith("diagram:"))
                  ? diagramHistory.future.length === 0
                  : history.future.length === 0)
              ) || editorLocked}
              aria-label="Redo"
            ><DrawingIcon name="redo" /><span>Redo</span></button>
          </div>

          <button
            className={`drawing-diagram-library${incomingDiagram ? " has-update" : ""}`}
            type="button"
            onClick={() => setDiagramPickerOpen(true)}
            disabled={editorLocked || availableDiagrams.length === 0}
          >
            <span aria-hidden="true"><DrawingIcon name="diagram" /></span>
            <span>
              <strong>Agent diagrams</strong>
              <small>
                {availableDiagrams.length === 0
                  ? "None for this task"
                  : `${availableDiagrams.length} available${incomingDiagram ? " · new revision" : ""}`}
              </small>
            </span>
          </button>

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
            <DrawingIcon name="image-add" />
            <span>Photo / File</span>
          </button>
          <button
            className="drawing-clear"
            type="button"
            onClick={() => setClearPending(true)}
            disabled={!hasContent || editorLocked}
          ><DrawingIcon name="trash" /><span>Clear page…</span></button>
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
            <button
              className="drawing-boards-button"
              type="button"
              onClick={() => setBoardsOpen(true)}
              disabled={savedBoards.length === 0 || editorLocked}
            >Boards{savedBoards.length > 0 ? ` ${savedBoards.length}` : ""}</button>
            <div className="drawing-zoom" aria-label="Canvas zoom">
              <button type="button" onClick={() => zoomBy(1 / 1.2)} aria-label="Zoom out">
                <DrawingIcon name="zoom-out" />
              </button>
              <button type="button" onClick={fitBoard} aria-label="Fit board">
                {Math.round(view.zoom * 100)}%
              </button>
              <button type="button" onClick={() => zoomBy(1.2)} aria-label="Zoom in">
                <DrawingIcon name="zoom-in" />
              </button>
            </div>
          </div>

          <div
            className={[
              "drawing-canvas-frame",
              `background-${scene.background.mode}`,
              diagramInspectorOpen ? "has-diagram-inspector" : "",
            ].filter(Boolean).join(" ")}
          >
            <canvas
              ref={canvasRef}
              className={`drawing-canvas tool-${tool}`}
              style={{ touchAction: "none" }}
              role="img"
              aria-label="Sketch canvas. Use Apple Pencil to draw; use two fingers to pan and pinch to zoom."
              aria-busy={!draftReady}
              tabIndex={0}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={(event) => endPointer(event, false)}
              onPointerCancel={(event) => endPointer(event, true)}
              onLostPointerCapture={(event) => endPointer(event, false)}
              onContextMenu={(event) => event.preventDefault()}
            />
            {tool === "select" && selectedBoardBounds && (
              <div
                className="drawing-selection"
                style={selectedBoardStyle ?? { left: 0, top: 0, width: 44, height: 44 }}
                aria-label={`${selection.size} selected board ${selection.size === 1 ? "item" : "items"}`}
              >
                <span className="drawing-selection__label">
                  {selection.size === 1 ? "Selected" : `${selection.size} selected`}
                </span>
                <button
                  type="button"
                  className="drawing-selection__resize"
                  aria-label="Resize selected board content"
                  onPointerDown={(event) => {
                    if (editorLocked || !selectedBoardBounds) return;
                    event.preventDefault();
                    event.stopPropagation();
                    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* WebKit can reject capture. */ }
                    const canvas = canvasRef.current;
                    if (!canvas) return;
                    selectionGestureRef.current = {
                      pointerId: event.pointerId,
                      mode: "resize",
                      start: pointerScenePoint(event, canvas, renderedScene, view),
                      originalScene: scene,
                      originalDiagram: diagram,
                      keys: selection,
                      bounds: selectedBoardBounds,
                      changed: false,
                    };
                  }}
                  onPointerMove={(event) => {
                    const gesture = selectionGestureRef.current;
                    const canvas = canvasRef.current;
                    if (!gesture || gesture.pointerId !== event.pointerId || !canvas) return;
                    previewSelectionGesture(gesture, pointerScenePoint(event, canvas, renderedScene, view));
                  }}
                  onPointerUp={() => finishSelectionGesture(false)}
                  onPointerCancel={() => finishSelectionGesture(true)}
                  onLostPointerCapture={() => finishSelectionGesture(false)}
                />
              </div>
            )}
            {tool === "select" && activeLasso && (
              <div className="drawing-lasso" style={lassoStyle ?? { left: 0, top: 0, width: 1, height: 1 }} aria-hidden="true" />
            )}
            {minimapVisible && (
              <DrawingMinimap
                contentBounds={boardBounds}
                viewportBounds={visibleWorldBounds}
                onRecenter={(centerX, centerY) => setView((current) => ({ ...current, centerX, centerY }))}
              />
            )}
            {sendSheetOpen && exportScope === "area" && selectedExportBounds && (
              <AreaSelectionOverlay
                canvasRef={canvasRef}
                scene={renderedScene}
                view={view}
                bounds={selectedExportBounds}
                onChange={setSelectedExportBounds}
              />
            )}
            {incomingDiagram && (
              <button
                className="drawing-diagram-update"
                type="button"
                onClick={() => openPublishedDiagram(incomingDiagram)}
              >
                <span aria-hidden="true"><DrawingIcon name="refresh" /></span>
                <span>
                  <strong>New Codex revision</strong>
                  <small>Open revision {incomingDiagram.revision}</small>
                </span>
              </button>
            )}
            {diagram && (
              <>
                <section
                  className={`drawing-graph-chip${diagramInspectorOpen ? " has-inspector" : ""}`}
                  aria-label="Graph controls"
                >
                  <button
                    type="button"
                    className="drawing-graph-chip__identity"
                    onClick={() => setDiagramPickerOpen(true)}
                    aria-label={`Open graphs. Current graph ${diagram.title}`}
                  >
                    <span aria-hidden="true"><DrawingIcon name="diagram" /></span>
                    <span>
                      <strong>{diagram.title}</strong>
                      <small>
                        {diagram.nodes.length} {diagram.nodes.length === 1 ? "block" : "blocks"}
                        {" · "}r{diagram.revision}
                      </small>
                    </span>
                  </button>
                  <div className="drawing-graph-chip__actions">
                    <button
                      type="button"
                      aria-label="Add diagram block"
                      disabled={diagram.nodes.length >= 256 || editorLocked}
                      onClick={() => {
                        const nodeId = `node_${createUuidV4().replaceAll("-", "").slice(0, 12)}`;
                        const next = addDiagramNode(diagram, nodeId, {
                          centerX: view.centerX,
                          centerY: view.centerY,
                        });
                        commitDiagramChange(next);
                        setSelectedDiagramNodeId(nodeId);
                        setSelection(new Set([diagramSelectionKey(nodeId)]));
                        setTool("select");
                        setDiagramInspectorSection("style");
                        setDiagramInspectorOpen(true);
                      }}
                    ><DrawingIcon name="add-block" /><span>Block</span></button>
                    <button
                      type="button"
                      aria-label="Edit selected diagram block"
                      aria-pressed={diagramInspectorOpen}
                      className={diagramInspectorOpen ? "is-active" : ""}
                      disabled={!selectedDiagramNode || editorLocked}
                      onClick={() => setDiagramInspectorOpen((current) => !current)}
                    ><DrawingIcon name="edit" /><span>Edit</span></button>
                    {diagramDirty ? (
                      <button
                        type="button"
                        className="is-primary"
                        disabled={diagramSyncing || editorLocked}
                        onClick={() => void syncDiagram()}
                      ><DrawingIcon name="sync" /><span>{diagramSyncing ? "Syncing…" : "Sync revision"}</span></button>
                    ) : (
                      <span
                        className="drawing-graph-chip__synced"
                        role="status"
                        aria-label="Diagram synced"
                      >
                        <i aria-hidden="true" /> Synced
                      </span>
                    )}
                  </div>
                </section>

                {diagramInspectorOpen && (
                  <section className="drawing-diagram-panel" aria-label="Diagram controls">
                    <header>
                      <span>
                        <small>
                          {selectedDiagramNodeIndex >= 0
                            ? `BLOCK ${selectedDiagramNodeIndex + 1} OF ${diagram.nodes.length}`
                            : "DIAGRAM"}
                        </small>
                        <strong>{selectedDiagramNode?.label ?? "Choose a block"}</strong>
                      </span>
                      <div>
                        <button
                          type="button"
                          aria-label="Close inspector and draw"
                          onClick={() => {
                            setDiagramInspectorOpen(false);
                            setTool("pen");
                            setSelection(new Set());
                          }}
                        >
                          <DrawingIcon name="pen" />
                        </button>
                        <button
                          type="button"
                          aria-label="Close diagram inspector"
                          onClick={() => setDiagramInspectorOpen(false)}
                        >
                          <DrawingIcon name="close" />
                        </button>
                      </div>
                    </header>

                    {selectedDiagramNode ? (
                      <>
                        <label className="drawing-diagram-node-name">
                          <span>Block label</span>
                          <input
                            key={`${diagram.diagramId}:${selectedDiagramNode.id}:${selectedDiagramNode.label}`}
                            defaultValue={selectedDiagramNode.label}
                            aria-label="Selected block"
                            maxLength={240}
                            onBlur={(event) => {
                              const label = event.currentTarget.value.trim();
                              if (!label) {
                                event.currentTarget.value = selectedDiagramNode.label;
                              } else if (label !== selectedDiagramNode.label) {
                                commitDiagramChange(updateDiagramNode(diagram, selectedDiagramNode.id, { label }));
                              }
                            }}
                          />
                        </label>

                        <div className="drawing-diagram-tabs" role="tablist" aria-label="Diagram block options">
                          {([
                            ["style", "Style"],
                            ["links", "Links"],
                            ["more", "More"],
                          ] as const).map(([section, label]) => (
                            <button
                              key={section}
                              type="button"
                              role="tab"
                              aria-selected={diagramInspectorSection === section}
                              className={diagramInspectorSection === section ? "is-active" : ""}
                              onClick={() => setDiagramInspectorSection(section)}
                            >{label}</button>
                          ))}
                        </div>

                        <div className="drawing-diagram-panel__content">
                          {diagramInspectorSection === "style" && (
                            <div className="drawing-diagram-style" role="tabpanel" aria-label="Block style">
                              <div className="drawing-diagram-segment" role="group" aria-label="Block shape">
                                {(["rectangle", "ellipse"] as readonly DiagramNodeShape[]).map((shape) => (
                                  <button
                                    key={shape}
                                    type="button"
                                    aria-pressed={selectedDiagramNode.shape === shape}
                                    className={selectedDiagramNode.shape === shape ? "is-active" : ""}
                                    onClick={() => commitDiagramChange(
                                      updateDiagramNode(diagram, selectedDiagramNode.id, { shape }),
                                    )}
                                    disabled={editorLocked}
                                  >{shape === "rectangle" ? "Card" : "Capsule"}</button>
                                ))}
                              </div>
                              <div className="drawing-diagram-tones" role="group" aria-label="Block color">
                                {DIAGRAM_TONES.map((tone) => (
                                  <button
                                    key={tone.id}
                                    type="button"
                                    className={`tone-${tone.id}${selectedDiagramNode.tone === tone.id ? " is-active" : ""}`}
                                    aria-label={tone.label}
                                    aria-pressed={selectedDiagramNode.tone === tone.id}
                                    onClick={() => commitDiagramChange(
                                      updateDiagramNode(diagram, selectedDiagramNode.id, { tone: tone.id }),
                                    )}
                                    disabled={editorLocked}
                                  />
                                ))}
                              </div>
                            </div>
                          )}

                          {diagramInspectorSection === "links" && (
                            <div className="drawing-diagram-links-panel" role="tabpanel" aria-label="Block links">
                              {diagram.nodes.length > 1 && (
                                <div className="drawing-diagram-connect">
                                  <select
                                    value={connectTargetNodeId}
                                    onChange={(event) => setConnectTargetNodeId(event.target.value)}
                                    aria-label="Connect selected block to"
                                  >
                                    <option value="">Connect to…</option>
                                    {diagram.nodes
                                      .filter((node) => node.id !== selectedDiagramNode.id)
                                      .map((node) => (
                                        <option key={node.id} value={node.id}>{node.label}</option>
                                      ))}
                                  </select>
                                  <button
                                    type="button"
                                    disabled={!connectTargetNodeId || editorLocked}
                                    onClick={() => {
                                      if (!connectTargetNodeId) return;
                                      commitDiagramChange(addDiagramEdge(
                                        diagram,
                                        `edge_${createUuidV4().replaceAll("-", "").slice(0, 12)}`,
                                        selectedDiagramNode.id,
                                        connectTargetNodeId,
                                      ));
                                      setConnectTargetNodeId("");
                                    }}
                                  >Connect</button>
                                </div>
                              )}
                              {connectedDiagramEdges.length > 0 ? (
                                <div className="drawing-diagram-links" aria-label="Connected arrows">
                                  {connectedDiagramEdges.map((edge) => {
                                    const otherId = edge.from === selectedDiagramNode.id ? edge.to : edge.from;
                                    const other = diagram.nodes.find((node) => node.id === otherId);
                                    return (
                                      <span key={edge.id}>
                                        <small>{edge.from === selectedDiagramNode.id ? "To" : "From"} {other?.label ?? otherId}</small>
                                        <button
                                          type="button"
                                          aria-label={`Remove connection with ${other?.label ?? otherId}`}
                                          onClick={() => commitDiagramChange(removeDiagramEdge(diagram, edge.id))}
                                          disabled={editorLocked}
                                        ><DrawingIcon name="close" /></button>
                                      </span>
                                    );
                                  })}
                                </div>
                              ) : (
                                <p className="drawing-diagram-panel__hint">No links for this block yet.</p>
                              )}
                            </div>
                          )}

                          {diagramInspectorSection === "more" && (
                            <div className="drawing-diagram-more" role="tabpanel" aria-label="More diagram options">
                              <label>
                                <span>Diagram title</span>
                                <input
                                  key={`${diagram.diagramId}:${diagram.revision}:${diagram.title}`}
                                  defaultValue={diagram.title}
                                  aria-label="Diagram title"
                                  maxLength={120}
                                  onBlur={(event) => {
                                    const title = event.currentTarget.value.trim();
                                    if (!title) {
                                      event.currentTarget.value = diagram.title;
                                    } else if (title !== diagram.title) {
                                      commitDiagramChange(DiagramDocumentSchema.parse({ ...diagram, title }));
                                    }
                                  }}
                                />
                              </label>
                              <button
                                type="button"
                                disabled={diagram.nodes.length === 0 || editorLocked}
                                onClick={() => commitDiagramChange(autoLayoutDiagram(diagram))}
                              ><span>Arrange diagram</span><small>Balance blocks and arrows</small></button>
                              <button
                                className="drawing-diagram-delete"
                                type="button"
                                onClick={() => {
                                  commitDiagramChange(removeDiagramNode(diagram, selectedDiagramNode.id));
                                  setSelectedDiagramNodeId(null);
                                  setDiagramInspectorOpen(false);
                                }}
                                disabled={editorLocked}
                              >Delete block</button>
                            </div>
                          )}
                        </div>
                      </>
                    ) : (
                      <p className="drawing-diagram-panel__hint">Tap a block to edit it.</p>
                    )}
                  </section>
                )}
              </>
            )}
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
                onClick={pendingDeliveryRetryable ? requestSend : openSendSheet}
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

      {sendSheetOpen && (
        <section className="drawing-send-sheet" role="dialog" aria-modal="false" aria-labelledby="drawing-send-title">
          <header>
            <span>
              <small>BOARD EXPORT</small>
              <strong id="drawing-send-title">What should Codex see?</strong>
            </span>
            <button type="button" onClick={() => setSendSheetOpen(false)} aria-label="Close send options"><DrawingIcon name="close" /></button>
          </header>
          <div className="drawing-send-sheet__choices" role="radiogroup" aria-label="Export scope">
            <button
              type="button"
              role="radio"
              aria-checked={exportScope === "board"}
              className={exportScope === "board" ? "is-active" : ""}
              onClick={() => setExportScope("board")}
            ><strong>Whole board</strong><small>Overview plus readable details when needed</small></button>
            <button
              type="button"
              role="radio"
              aria-checked={exportScope === "area"}
              className={exportScope === "area" ? "is-active" : ""}
              onClick={() => {
                setExportScope("area");
                setSelectedExportBounds((current) => current ?? currentViewportBounds());
              }}
            ><strong>Select area</strong><small>Drag and resize the frame on the board</small></button>
          </div>
          <div className="drawing-send-sheet__footer">
            <div className="drawing-send-sheet__package">
              <span>{exportDescription?.summary
                ?? (composerAttachmentMaxImages === 12 ? "Up to 12 ordered images" : "Compatible single atlas when tiling is needed")}</span>
              {exportDescription && exportDescription.detailCount > 0 && (
                <details>
                  <summary>Inspect package</summary>
                  <div className="drawing-send-sheet__regions">
                    {exportDescription.hasStructureIndex && <strong>Structure index included</strong>}
                    {exportDescription.regions.map((region) => (
                      <span key={region.regionId}>
                        <b>{region.regionId}</b>
                        <small>{region.neighbors.join(" · ") || "Complete region"}</small>
                        {region.alignmentMarkers.length > 0 && (
                          <small>Align {region.alignmentMarkers.join(" · ")}</small>
                        )}
                        {region.continuations.length > 0 && (
                          <small>{region.continuations.join(" · ")}</small>
                        )}
                      </span>
                    ))}
                  </div>
                </details>
              )}
            </div>
            <button type="button" onClick={confirmSendSheet} disabled={exportScope === "area" && !selectedExportBounds}>Prepare &amp; Send</button>
          </div>
        </section>
      )}

      {boardsOpen && (
        <div className="drawing-overlay" role="presentation">
          <section className="drawing-boards-sheet" role="dialog" aria-modal="true" aria-labelledby="drawing-boards-title">
            <header>
              <span><small>COLLABORATIVE HISTORY</small><h3 id="drawing-boards-title">Boards</h3></span>
              <button type="button" onClick={() => setBoardsOpen(false)} aria-label="Close boards"><DrawingIcon name="close" /></button>
            </header>
            <p>Sent boards stay available here. Reopen one to continue from its latest checkpoint.</p>
            <div className="drawing-boards-sheet__list">
              {savedBoards.map((savedBoard) => (
                <button key={savedBoard.boardId} type="button" onClick={() => void openSavedBoard(savedBoard)}>
                  <span><strong>{savedBoard.title}</strong><small>{savedBoard.checkpoints.length} sent checkpoint{savedBoard.checkpoints.length === 1 ? "" : "s"}</small></span>
                  <time>{new Date(savedBoard.updatedAt).toLocaleDateString()}</time>
                </button>
              ))}
            </div>
          </section>
        </div>
      )}

      {clearPending && (
        <div className="drawing-overlay" role="presentation">
          <section ref={clearDialogRef} className="drawing-confirm" role="alertdialog" aria-modal="true" aria-labelledby="clear-title" tabIndex={-1}>
            <span className="drawing-confirm__mark" aria-hidden="true"><DrawingIcon name="trash" /></span>
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
            <span className="drawing-confirm__mark is-import" aria-hidden="true"><DrawingIcon name="image-add" /></span>
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

      {diagramPickerOpen && (
        <div className="drawing-overlay" role="presentation">
          <section className="drawing-diagram-picker" role="dialog" aria-modal="true" aria-labelledby="diagram-picker-title">
            <header>
              <span>
                <small>EXACT TASK · {displayedTarget?.threadId.slice(-8) ?? "UNBOUND"}</small>
                <h3 id="diagram-picker-title">Agent diagrams</h3>
              </span>
              <button type="button" onClick={() => setDiagramPickerOpen(false)} aria-label="Close agent diagrams">
                <DrawingIcon name="close" />
              </button>
            </header>
            <p>
              Codex publishes structured diagrams here. Open one to move its blocks, edit its relationships,
              and draw over it with Apple Pencil.
            </p>
            {diagramDirty && (
              <div className="drawing-diagram-picker__warning" role="status">
                Sync the current revision before opening a different diagram.
              </div>
            )}
            <div className="drawing-diagram-picker__list">
              {availableDiagrams.length === 0 ? (
                <div className="drawing-diagram-picker__empty">
                  <strong>No diagram has been published for this task.</strong>
                  <small>Ask Codex to create a diagram and send it to Nerva.</small>
                </div>
              ) : availableDiagrams.map((candidate) => {
                const current = diagram?.diagramId === candidate.diagramId
                  && diagram.revision === candidate.revision;
                return (
                  <button
                    key={`${candidate.diagramId}:${candidate.revision}`}
                    type="button"
                    className={current ? "is-current" : ""}
                    disabled={diagramDirty && !current}
                    onClick={() => current
                      ? setDiagramPickerOpen(false)
                      : openPublishedDiagram(candidate)}
                  >
                    <span className={`tone-${candidate.nodes[0]?.tone ?? "neutral"}`} aria-hidden="true">
                      <DrawingIcon name="diagram" />
                    </span>
                    <span>
                      <strong>{candidate.title}</strong>
                      <small>
                        Revision {candidate.revision} · {candidate.nodes.length} blocks · edited by {candidate.lastEditedBy === "codex" ? "Codex" : "this iPad"}
                      </small>
                    </span>
                    <em>{current ? "Open" : "Load"}</em>
                  </button>
                );
              })}
            </div>
            <footer>
              <button type="button" onClick={() => setDiagramPickerOpen(false)}>Done</button>
            </footer>
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
        centerX: start.cameraCenterX - (metrics.centerX - start.gestureCenterX) / (start.fitScale * start.zoom),
        centerY: start.cameraCenterY - (metrics.centerY - start.gestureCenterY) / (start.fitScale * start.zoom),
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
            <DrawingIcon name={toolIcon(item)} />
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
