export const SCENE_VERSION = 2 as const;

export const DEFAULT_DARK_BACKGROUND = "#11151c";

export type PointerKind = "pen" | "touch" | "mouse";

export interface Point2D {
  readonly x: number;
  readonly y: number;
}

export interface ScenePoint extends Point2D {
  readonly pressure: number;
  readonly tiltX: number;
  readonly tiltY: number;
  readonly time: number;
  readonly pointerType: PointerKind;
}

/** Rotation values are radians and element positions use scene/world coordinates. */
export interface ElementBase {
  readonly id: string;
  readonly opacity: number;
  readonly rotation: number;
}

export type InkTool = "pen" | "marker";

export interface StrokeElement extends ElementBase {
  readonly kind: "stroke";
  readonly tool: InkTool;
  readonly color: string;
  readonly size: number;
  readonly points: readonly ScenePoint[];
}

export interface EraserElement extends ElementBase {
  readonly kind: "eraser";
  readonly tool: "eraser";
  readonly size: number;
  readonly points: readonly ScenePoint[];
}

export type ShapeKind = "arrow" | "rectangle" | "ellipse";

export interface ShapeElement extends ElementBase {
  readonly kind: "shape";
  readonly shape: ShapeKind;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly strokeColor: string;
  readonly strokeWidth: number;
  readonly fillColor: string | null;
}

export interface TextElement extends ElementBase {
  readonly kind: "text";
  readonly x: number;
  readonly y: number;
  readonly text: string;
  readonly color: string;
  readonly fontFamily: string;
  readonly fontSize: number;
  readonly fontWeight: "normal" | "bold";
  readonly lineHeight: number;
  readonly maxWidth: number | null;
}

export interface ImportedImageMetadata {
  readonly mimeType: "image/png" | "image/jpeg" | "image/webp";
  readonly byteLength: number;
  readonly pixelWidth: number;
  readonly pixelHeight: number;
  readonly name: string | null;
  readonly sha256: string | null;
}

export interface DataUrlImageSource {
  readonly kind: "dataUrl";
  readonly dataUrl: string;
  readonly metadata: ImportedImageMetadata;
}

/**
 * A serializable pointer into an external browser store (normally IndexedDB).
 * Consumers provide an imageResolver when flattening a scene containing one.
 */
export interface BlobRefImageSource {
  readonly kind: "blobRef";
  readonly blobId: string;
  readonly metadata: ImportedImageMetadata;
}

export type ImportedImageSource = DataUrlImageSource | BlobRefImageSource;

export interface ImageElement extends ElementBase {
  readonly kind: "image";
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly source: ImportedImageSource;
  readonly isBackground: boolean;
}

export type SceneElement =
  | StrokeElement
  | EraserElement
  | ShapeElement
  | TextElement
  | ImageElement;

export type BackgroundMode = "transparent" | "white" | "dark";

export interface SceneBackground {
  readonly mode: BackgroundMode;
  /** Used only for dark mode. */
  readonly color: string;
}

export interface SceneViewport {
  readonly width: number;
  readonly height: number;
}

export interface ViewTransform {
  readonly panX: number;
  readonly panY: number;
  readonly zoom: number;
}

export interface Scene {
  readonly version: typeof SCENE_VERSION;
  readonly viewport: SceneViewport;
  readonly view: ViewTransform;
  readonly background: SceneBackground;
  /** Paint order, from back to front. Erasers are composited at their position. */
  readonly elements: readonly SceneElement[];
}

export interface Bounds {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
  readonly width: number;
  readonly height: number;
}

export type SceneOperation =
  | { readonly type: "add"; readonly element: SceneElement; readonly index?: number }
  | { readonly type: "remove"; readonly elementId: string }
  | { readonly type: "replaceElement"; readonly element: SceneElement }
  | { readonly type: "replaceElements"; readonly elements: readonly SceneElement[] }
  | { readonly type: "clear" }
  | { readonly type: "restoreElements"; readonly elements: readonly SceneElement[] }
  | { readonly type: "setView"; readonly view: ViewTransform }
  | { readonly type: "setBackground"; readonly background: SceneBackground };

export interface DrawingHistoryEntry {
  readonly undo: SceneOperation;
  readonly redo: SceneOperation;
}

export interface DrawingHistory {
  /** Bounded reversible operations. The scene itself is not copied per edit. */
  readonly past: readonly DrawingHistoryEntry[];
  readonly present: Scene;
  readonly future: readonly DrawingHistoryEntry[];
}

export type HistoryAction =
  | { readonly type: "commit"; readonly operation: SceneOperation }
  | { readonly type: "replace"; readonly scene: Scene }
  | { readonly type: "undo" }
  | { readonly type: "redo" }
  | { readonly type: "reset"; readonly scene: Scene };

export interface CreateSceneOptions {
  readonly width?: number;
  readonly height?: number;
  readonly background?: BackgroundMode | SceneBackground;
  readonly view?: ViewTransform;
}

export interface CreateStrokeOptions {
  readonly id: string;
  readonly tool?: InkTool;
  readonly color: string;
  readonly size: number;
  readonly points: readonly ScenePoint[];
  readonly opacity?: number;
  readonly rotation?: number;
}

export interface CreateEraserOptions {
  readonly id: string;
  readonly size: number;
  readonly points: readonly ScenePoint[];
  readonly rotation?: number;
}

export interface CreateShapeOptions {
  readonly id: string;
  readonly shape: ShapeKind;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly strokeColor: string;
  readonly strokeWidth: number;
  readonly fillColor?: string | null;
  readonly opacity?: number;
  readonly rotation?: number;
}

export interface CreateTextOptions {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly text: string;
  readonly color: string;
  readonly fontFamily?: string;
  readonly fontSize: number;
  readonly fontWeight?: "normal" | "bold";
  readonly lineHeight?: number;
  readonly maxWidth?: number | null;
  readonly opacity?: number;
  readonly rotation?: number;
}

export interface CreateImageOptions {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly source: ImportedImageSource;
  readonly isBackground?: boolean;
  readonly opacity?: number;
  readonly rotation?: number;
}
