import {
  DEFAULT_DARK_BACKGROUND,
  SCENE_VERSION,
  type BackgroundMode,
  type CreateEraserOptions,
  type CreateImageOptions,
  type CreateSceneOptions,
  type CreateShapeOptions,
  type CreateStrokeOptions,
  type CreateTextOptions,
  type DrawingHistory,
  type EraserElement,
  type HistoryAction,
  type ImageElement,
  type ImportedImageMetadata,
  type ImportedImageSource,
  type PointerKind,
  type Scene,
  type SceneBackground,
  type SceneElement,
  type SceneOperation,
  type ScenePoint,
  type ShapeElement,
  type StrokeElement,
  type TextElement,
  type ViewTransform,
} from "./types.js";

export const HISTORY_LIMIT = 100;

const DEFAULT_WIDTH = 1_024;
const DEFAULT_HEIGHT = 768;
const MAX_COORDINATE = 1_000_000;
const MAX_IMAGE_BYTES = 50 * 1024 * 1024;

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertRecord(value: unknown, label: string): asserts value is UnknownRecord {
  if (!isRecord(value)) {
    throw new TypeError(`${label} must be an object`);
  }
}

function assertFinite(
  value: unknown,
  label: string,
  minimum = -MAX_COORDINATE,
  maximum = MAX_COORDINATE,
): asserts value is number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new TypeError(`${label} must be a finite number between ${minimum} and ${maximum}`);
  }
}

function assertString(value: unknown, label: string, maximum = 10_000): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw new TypeError(`${label} must be a non-empty string of at most ${maximum} characters`);
  }
}

function assertNullableString(
  value: unknown,
  label: string,
  maximum = 10_000,
): asserts value is string | null {
  if (value !== null) {
    assertString(value, label, maximum);
  }
}

function assertText(value: unknown, label: string, maximum: number): asserts value is string {
  if (typeof value !== "string" || value.length > maximum) {
    throw new TypeError(`${label} must be a string of at most ${maximum} characters`);
  }
}

function normalizeBackground(background: BackgroundMode | SceneBackground | undefined): SceneBackground {
  if (background === undefined) {
    return { mode: "transparent", color: DEFAULT_DARK_BACKGROUND };
  }

  if (typeof background === "string") {
    return { mode: background, color: DEFAULT_DARK_BACKGROUND };
  }

  return { mode: background.mode, color: background.color };
}

export function createScene(options: CreateSceneOptions = {}): Scene {
  const width = options.width ?? DEFAULT_WIDTH;
  const height = options.height ?? DEFAULT_HEIGHT;
  const view = options.view ?? { panX: 0, panY: 0, zoom: 1 };
  const scene: Scene = {
    version: SCENE_VERSION,
    viewport: { width, height },
    view: { ...view },
    background: normalizeBackground(options.background),
    elements: [],
  };
  assertScene(scene);
  return scene;
}

export function createStrokeElement(options: CreateStrokeOptions): StrokeElement {
  const element: StrokeElement = {
    kind: "stroke",
    id: options.id,
    tool: options.tool ?? "pen",
    color: options.color,
    size: options.size,
    opacity: options.opacity ?? (options.tool === "marker" ? 0.38 : 1),
    rotation: options.rotation ?? 0,
    points: options.points.map(clonePoint),
  };
  assertElement(element, "stroke");
  return element;
}

export function createEraserElement(options: CreateEraserOptions): EraserElement {
  const element: EraserElement = {
    kind: "eraser",
    tool: "eraser",
    id: options.id,
    size: options.size,
    opacity: 1,
    rotation: options.rotation ?? 0,
    points: options.points.map(clonePoint),
  };
  assertElement(element, "eraser");
  return element;
}

export function createShapeElement(options: CreateShapeOptions): ShapeElement {
  const element: ShapeElement = {
    kind: "shape",
    id: options.id,
    shape: options.shape,
    x: options.x,
    y: options.y,
    width: options.width,
    height: options.height,
    strokeColor: options.strokeColor,
    strokeWidth: options.strokeWidth,
    fillColor: options.fillColor ?? null,
    opacity: options.opacity ?? 1,
    rotation: options.rotation ?? 0,
  };
  assertElement(element, "shape");
  return element;
}

export function createTextElement(options: CreateTextOptions): TextElement {
  const element: TextElement = {
    kind: "text",
    id: options.id,
    x: options.x,
    y: options.y,
    text: options.text,
    color: options.color,
    fontFamily: options.fontFamily ?? "system-ui, sans-serif",
    fontSize: options.fontSize,
    fontWeight: options.fontWeight ?? "normal",
    lineHeight: options.lineHeight ?? 1.2,
    maxWidth: options.maxWidth ?? null,
    opacity: options.opacity ?? 1,
    rotation: options.rotation ?? 0,
  };
  assertElement(element, "text");
  return element;
}

export function createImageElement(options: CreateImageOptions): ImageElement {
  const element: ImageElement = {
    kind: "image",
    id: options.id,
    x: options.x,
    y: options.y,
    width: options.width,
    height: options.height,
    source: cloneImageSource(options.source),
    isBackground: options.isBackground ?? false,
    opacity: options.opacity ?? 1,
    rotation: options.rotation ?? 0,
  };
  assertElement(element, "image");
  return element;
}

function clonePoint(point: ScenePoint): ScenePoint {
  return { ...point };
}

function cloneMetadata(metadata: ImportedImageMetadata): ImportedImageMetadata {
  return { ...metadata };
}

function cloneImageSource(source: ImportedImageSource): ImportedImageSource {
  return source.kind === "dataUrl"
    ? { kind: "dataUrl", dataUrl: source.dataUrl, metadata: cloneMetadata(source.metadata) }
    : { kind: "blobRef", blobId: source.blobId, metadata: cloneMetadata(source.metadata) };
}

export function cloneElement(element: SceneElement): SceneElement {
  switch (element.kind) {
    case "stroke":
      return { ...element, points: element.points.map(clonePoint) };
    case "eraser":
      return { ...element, points: element.points.map(clonePoint) };
    case "image":
      return { ...element, source: cloneImageSource(element.source) };
    case "shape":
    case "text":
      return { ...element };
  }
}

export function cloneScene(scene: Scene): Scene {
  return {
    version: SCENE_VERSION,
    viewport: { ...scene.viewport },
    view: { ...scene.view },
    background: { ...scene.background },
    elements: scene.elements.map(cloneElement),
  };
}

function assertPoint(value: unknown, label: string): asserts value is ScenePoint {
  assertRecord(value, label);
  assertFinite(value.x, `${label}.x`);
  assertFinite(value.y, `${label}.y`);
  assertFinite(value.pressure, `${label}.pressure`, 0, 1);
  assertFinite(value.tiltX, `${label}.tiltX`, -90, 90);
  assertFinite(value.tiltY, `${label}.tiltY`, -90, 90);
  assertFinite(value.time, `${label}.time`, 0, Number.MAX_SAFE_INTEGER);
  if (value.pointerType !== "pen" && value.pointerType !== "touch" && value.pointerType !== "mouse") {
    throw new TypeError(`${label}.pointerType must be pen, touch, or mouse`);
  }
}

function assertElementBase(value: UnknownRecord, label: string): void {
  assertString(value.id, `${label}.id`, 256);
  assertFinite(value.opacity, `${label}.opacity`, 0, 1);
  assertFinite(value.rotation, `${label}.rotation`, -Math.PI * 20, Math.PI * 20);
}

function assertPoints(value: unknown, label: string): asserts value is readonly ScenePoint[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100_000) {
    throw new TypeError(`${label} must contain between 1 and 100000 points`);
  }
  value.forEach((point, index) => assertPoint(point, `${label}[${index}]`));
}

function assertImageMetadata(value: unknown, label: string): asserts value is ImportedImageMetadata {
  assertRecord(value, label);
  if (value.mimeType !== "image/png" && value.mimeType !== "image/jpeg" && value.mimeType !== "image/webp") {
    throw new TypeError(`${label}.mimeType is unsupported`);
  }
  assertFinite(value.byteLength, `${label}.byteLength`, 0, MAX_IMAGE_BYTES);
  assertFinite(value.pixelWidth, `${label}.pixelWidth`, 1, 32_768);
  assertFinite(value.pixelHeight, `${label}.pixelHeight`, 1, 32_768);
  assertNullableString(value.name, `${label}.name`, 512);
  assertNullableString(value.sha256, `${label}.sha256`, 128);
}

function assertImageSource(value: unknown, label: string): asserts value is ImportedImageSource {
  assertRecord(value, label);
  assertImageMetadata(value.metadata, `${label}.metadata`);
  if (value.kind === "dataUrl") {
    assertString(value.dataUrl, `${label}.dataUrl`, 70 * 1024 * 1024);
    if (!value.dataUrl.startsWith(`data:${value.metadata.mimeType};base64,`)) {
      throw new TypeError(`${label}.dataUrl must match its declared image MIME type`);
    }
    return;
  }
  if (value.kind === "blobRef") {
    assertString(value.blobId, `${label}.blobId`, 256);
    return;
  }
  throw new TypeError(`${label}.kind is unsupported`);
}

export function assertElement(value: unknown, label = "element"): asserts value is SceneElement {
  assertRecord(value, label);
  assertElementBase(value, label);
  switch (value.kind) {
    case "stroke":
      if (value.tool !== "pen" && value.tool !== "marker") {
        throw new TypeError(`${label}.tool must be pen or marker`);
      }
      assertString(value.color, `${label}.color`, 128);
      assertFinite(value.size, `${label}.size`, 0.1, 512);
      assertPoints(value.points, `${label}.points`);
      return;
    case "eraser":
      if (value.tool !== "eraser") {
        throw new TypeError(`${label}.tool must be eraser`);
      }
      assertFinite(value.size, `${label}.size`, 0.1, 512);
      assertPoints(value.points, `${label}.points`);
      return;
    case "shape":
      if (value.shape !== "arrow" && value.shape !== "rectangle" && value.shape !== "ellipse") {
        throw new TypeError(`${label}.shape is unsupported`);
      }
      assertFinite(value.x, `${label}.x`);
      assertFinite(value.y, `${label}.y`);
      assertFinite(value.width, `${label}.width`, -MAX_COORDINATE, MAX_COORDINATE);
      assertFinite(value.height, `${label}.height`, -MAX_COORDINATE, MAX_COORDINATE);
      assertString(value.strokeColor, `${label}.strokeColor`, 128);
      assertFinite(value.strokeWidth, `${label}.strokeWidth`, 0.1, 512);
      if (value.fillColor !== null) {
        assertString(value.fillColor, `${label}.fillColor`, 128);
      }
      return;
    case "text":
      assertFinite(value.x, `${label}.x`);
      assertFinite(value.y, `${label}.y`);
      assertText(value.text, `${label}.text`, 100_000);
      assertString(value.color, `${label}.color`, 128);
      assertString(value.fontFamily, `${label}.fontFamily`, 512);
      assertFinite(value.fontSize, `${label}.fontSize`, 1, 1_024);
      if (value.fontWeight !== "normal" && value.fontWeight !== "bold") {
        throw new TypeError(`${label}.fontWeight must be normal or bold`);
      }
      assertFinite(value.lineHeight, `${label}.lineHeight`, 0.5, 5);
      if (value.maxWidth !== null) {
        assertFinite(value.maxWidth, `${label}.maxWidth`, 1, MAX_COORDINATE);
      }
      return;
    case "image":
      assertFinite(value.x, `${label}.x`);
      assertFinite(value.y, `${label}.y`);
      assertFinite(value.width, `${label}.width`, 0.1, MAX_COORDINATE);
      assertFinite(value.height, `${label}.height`, 0.1, MAX_COORDINATE);
      assertImageSource(value.source, `${label}.source`);
      if (typeof value.isBackground !== "boolean") {
        throw new TypeError(`${label}.isBackground must be boolean`);
      }
      return;
    default:
      throw new TypeError(`${label}.kind is unsupported`);
  }
}

function assertView(value: unknown, label: string): asserts value is ViewTransform {
  assertRecord(value, label);
  assertFinite(value.panX, `${label}.panX`);
  assertFinite(value.panY, `${label}.panY`);
  assertFinite(value.zoom, `${label}.zoom`, 0.05, 64);
}

function assertBackground(value: unknown, label: string): asserts value is SceneBackground {
  assertRecord(value, label);
  if (value.mode !== "transparent" && value.mode !== "white" && value.mode !== "dark") {
    throw new TypeError(`${label}.mode is unsupported`);
  }
  assertString(value.color, `${label}.color`, 128);
}

export function assertScene(value: unknown): asserts value is Scene {
  assertRecord(value, "scene");
  if (value.version !== SCENE_VERSION) {
    throw new TypeError(`scene.version must be ${SCENE_VERSION}`);
  }
  assertRecord(value.viewport, "scene.viewport");
  assertFinite(value.viewport.width, "scene.viewport.width", 1, MAX_COORDINATE);
  assertFinite(value.viewport.height, "scene.viewport.height", 1, MAX_COORDINATE);
  assertView(value.view, "scene.view");
  assertBackground(value.background, "scene.background");
  if (!Array.isArray(value.elements) || value.elements.length > 100_000) {
    throw new TypeError("scene.elements must be an array of at most 100000 elements");
  }
  const ids = new Set<string>();
  value.elements.forEach((element, index) => {
    assertElement(element, `scene.elements[${index}]`);
    if (ids.has(element.id)) {
      throw new TypeError(`scene contains duplicate element id ${element.id}`);
    }
    ids.add(element.id);
  });
}

export function serializeScene(scene: Scene): string {
  assertScene(scene);
  return JSON.stringify(scene);
}

function legacyPoint(value: unknown, index: number): ScenePoint {
  if (Array.isArray(value)) {
    const [x, y, pressure = 0.5] = value;
    assertFinite(x, `legacy point ${index}.x`);
    assertFinite(y, `legacy point ${index}.y`);
    assertFinite(pressure, `legacy point ${index}.pressure`, 0, 1);
    return {
      x,
      y,
      pressure,
      tiltX: 0,
      tiltY: 0,
      time: index,
      pointerType: "pen",
    };
  }
  assertRecord(value, `legacy point ${index}`);
  const x = value.x;
  const y = value.y;
  const pressure = value.pressure ?? 0.5;
  assertFinite(x, `legacy point ${index}.x`);
  assertFinite(y, `legacy point ${index}.y`);
  assertFinite(pressure, `legacy point ${index}.pressure`, 0, 1);
  const pointerType: PointerKind =
    value.pointerType === "touch" || value.pointerType === "mouse" ? value.pointerType : "pen";
  return {
    x,
    y,
    pressure,
    tiltX: typeof value.tiltX === "number" ? value.tiltX : 0,
    tiltY: typeof value.tiltY === "number" ? value.tiltY : 0,
    time: typeof value.time === "number" ? value.time : index,
    pointerType,
  };
}

function legacyPoints(value: unknown): readonly ScenePoint[] {
  if (!Array.isArray(value)) {
    throw new TypeError("legacy stroke points must be an array");
  }
  return value.map(legacyPoint);
}

function migrateLegacyFreehand(value: unknown, index: number, eraser: boolean): SceneElement {
  assertRecord(value, `legacy element ${index}`);
  const id = typeof value.id === "string" ? value.id : `migrated-${eraser ? "eraser" : "stroke"}-${index}`;
  const size = typeof value.size === "number" ? value.size : typeof value.width === "number" ? value.width : 4;
  const points = legacyPoints(value.points);
  if (eraser) {
    return createEraserElement({ id, size, points });
  }
  return createStrokeElement({
    id,
    tool: value.tool === "marker" ? "marker" : "pen",
    color: typeof value.color === "string" ? value.color : "#111111",
    size,
    points,
    opacity: typeof value.opacity === "number" ? value.opacity : 1,
  });
}

export function migrateScene(value: unknown): Scene {
  assertRecord(value, "scene");
  if (value.version === SCENE_VERSION) {
    assertScene(value);
    return cloneScene(value);
  }

  if (value.version === 1) {
    const migrated = {
      ...value,
      version: SCENE_VERSION,
      view: value.view ?? { panX: 0, panY: 0, zoom: 1 },
      background: value.background ?? { mode: "transparent", color: DEFAULT_DARK_BACKGROUND },
    };
    assertScene(migrated);
    return cloneScene(migrated);
  }

  if (value.version !== undefined && value.version !== 0) {
    throw new TypeError(`unsupported scene version ${String(value.version)}`);
  }

  const width = typeof value.width === "number" ? value.width : DEFAULT_WIDTH;
  const height = typeof value.height === "number" ? value.height : DEFAULT_HEIGHT;
  const strokes = Array.isArray(value.strokes) ? value.strokes : [];
  const erasers = Array.isArray(value.erasers) ? value.erasers : [];
  const background: BackgroundMode =
    value.background === "white" || value.background === "dark" ? value.background : "transparent";
  const scene: Scene = {
    ...createScene({ width, height, background }),
    elements: [
      ...strokes.map((stroke, index) => migrateLegacyFreehand(stroke, index, false)),
      ...erasers.map((eraser, index) => migrateLegacyFreehand(eraser, index, true)),
    ],
  };
  assertScene(scene);
  return scene;
}

export function deserializeScene(serialized: string): Scene {
  if (serialized.length > 80 * 1024 * 1024) {
    throw new TypeError("serialized scene exceeds the 80 MiB safety limit");
  }
  return migrateScene(JSON.parse(serialized) as unknown);
}

export function applySceneOperation(scene: Scene, operation: SceneOperation): Scene {
  switch (operation.type) {
    case "add": {
      if (scene.elements.some((element) => element.id === operation.element.id)) {
        throw new TypeError(`element id ${operation.element.id} already exists`);
      }
      assertElement(operation.element);
      const element = cloneElement(operation.element);
      if (operation.index !== undefined) {
        const elements = [...scene.elements];
        elements.splice(Math.max(0, Math.min(elements.length, operation.index)), 0, element);
        return { ...scene, elements };
      }
      if (element.kind === "image" && element.isBackground) {
        const firstForeground = scene.elements.findIndex(
          (candidate) => candidate.kind !== "image" || !candidate.isBackground,
        );
        const insertionIndex = firstForeground < 0 ? scene.elements.length : firstForeground;
        const elements = [...scene.elements];
        elements.splice(insertionIndex, 0, element);
        return { ...scene, elements };
      }
      return { ...scene, elements: [...scene.elements, element] };
    }
    case "remove": {
      const elements = scene.elements.filter((element) => element.id !== operation.elementId);
      return elements.length === scene.elements.length ? scene : { ...scene, elements };
    }
    case "replaceElement": {
      assertElement(operation.element);
      const index = scene.elements.findIndex((element) => element.id === operation.element.id);
      if (index < 0) {
        return scene;
      }
      const elements = [...scene.elements];
      elements[index] = cloneElement(operation.element);
      return { ...scene, elements };
    }
    case "clear":
      return scene.elements.length === 0 ? scene : { ...scene, elements: [] };
    case "restoreElements":
      return operation.elements.length === 0
        ? scene
        : { ...scene, elements: operation.elements.map(cloneElement) };
    case "setView":
      assertView(operation.view, "view");
      return { ...scene, view: { ...operation.view } };
    case "setBackground":
      assertBackground(operation.background, "background");
      return { ...scene, background: { ...operation.background } };
  }
}

export function createHistory(scene: Scene): DrawingHistory {
  assertScene(scene);
  return { past: [], present: cloneScene(scene), future: [] };
}

function inverseOperation(scene: Scene, operation: SceneOperation): SceneOperation | null {
  switch (operation.type) {
    case "add":
      return { type: "remove", elementId: operation.element.id };
    case "remove": {
      const index = scene.elements.findIndex((element) => element.id === operation.elementId);
      const element = scene.elements[index];
      return element ? { type: "add", element, index } : null;
    }
    case "replaceElement": {
      const element = scene.elements.find((candidate) => candidate.id === operation.element.id);
      return element ? { type: "replaceElement", element } : null;
    }
    case "clear":
      return scene.elements.length > 0 ? { type: "restoreElements", elements: scene.elements } : null;
    case "restoreElements":
      return { type: "clear" };
    case "setView":
      return { type: "setView", view: scene.view };
    case "setBackground":
      return { type: "setBackground", background: scene.background };
  }
}

function commitHistory(
  history: DrawingHistory,
  next: Scene,
  entry: DrawingHistory["past"][number],
): DrawingHistory {
  if (next === history.present) {
    return history;
  }
  const past = [...history.past, entry].slice(-HISTORY_LIMIT);
  return { past, present: next, future: [] };
}

export function historyReducer(history: DrawingHistory, action: HistoryAction): DrawingHistory {
  switch (action.type) {
    case "commit":
    {
      const undo = inverseOperation(history.present, action.operation);
      if (!undo) return history;
      return commitHistory(
        history,
        applySceneOperation(history.present, action.operation),
        { undo, redo: action.operation },
      );
    }
    case "replace":
      assertScene(action.scene);
      return commitHistory(
        history,
        cloneScene(action.scene),
        {
          undo: { type: "restoreElements", elements: history.present.elements },
          redo: { type: "restoreElements", elements: action.scene.elements },
        },
      );
    case "undo": {
      const entry = history.past.at(-1);
      if (entry === undefined) {
        return history;
      }
      return {
        past: history.past.slice(0, -1),
        present: applySceneOperation(history.present, entry.undo),
        future: [entry, ...history.future].slice(0, HISTORY_LIMIT),
      };
    }
    case "redo": {
      const entry = history.future[0];
      if (entry === undefined) {
        return history;
      }
      return {
        past: [...history.past, entry].slice(-HISTORY_LIMIT),
        present: applySceneOperation(history.present, entry.redo),
        future: history.future.slice(1),
      };
    }
    case "reset":
      assertScene(action.scene);
      return createHistory(action.scene);
  }
}

export function sceneStrokes(scene: Scene): readonly StrokeElement[] {
  return scene.elements.filter((element): element is StrokeElement => element.kind === "stroke");
}

export function sceneEraserOperations(scene: Scene): readonly EraserElement[] {
  return scene.elements.filter((element): element is EraserElement => element.kind === "eraser");
}
