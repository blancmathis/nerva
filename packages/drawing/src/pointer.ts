import type {
  PointerKind,
  ScenePoint,
  ViewTransform,
} from "./types.js";

/**
 * The subset of PointerEvent used by the drawing engine. Keeping this
 * structural makes the input pipeline testable without a browser DOM.
 */
export interface PointerEventLike {
  readonly pointerId: number;
  readonly pointerType?: string;
  readonly clientX: number;
  readonly clientY: number;
  readonly pressure?: number;
  readonly tiltX?: number;
  readonly tiltY?: number;
  readonly timeStamp?: number;
  getCoalescedEvents?: () => readonly PointerEventLike[];
  preventDefault?: () => void;
}

/** The pointer-capture subset implemented by Element. */
export interface PointerCaptureTargetLike {
  setPointerCapture?: (pointerId: number) => void;
  releasePointerCapture?: (pointerId: number) => void;
  hasPointerCapture?: (pointerId: number) => boolean;
}

export interface PointerTrackingResult {
  readonly accepted: boolean;
  readonly points: readonly ScenePoint[];
  readonly cancelledPointerIds: readonly number[];
}

export interface PencilPointerTrackerOptions {
  /** Called after an accepted touch is cancelled because Pencil input began. */
  readonly onPointerCancelled?: (pointerId: number) => void;
}

interface ActivePointer {
  readonly kind: PointerKind;
  readonly target: PointerCaptureTargetLike;
}

const EMPTY_POINTER_IDS: readonly number[] = Object.freeze([]);
const EMPTY_POINTS: readonly ScenePoint[] = Object.freeze([]);
const EMPTY_EVENTS: readonly PointerEventLike[] = Object.freeze([]);

export function pointerKindOf(event: Pick<PointerEventLike, "pointerType">): PointerKind {
  switch (event.pointerType?.toLowerCase()) {
    case "pen":
      return "pen";
    case "touch":
      return "touch";
    case "mouse":
    default:
      // Pointer Events permits an empty value for an unknown device. Treat it
      // as mouse-compatible input rather than accidentally applying palm rules.
      return "mouse";
  }
}

export function viewportToScenePoint(
  point: ScenePoint,
  transform: ViewTransform,
): ScenePoint {
  assertValidZoom(transform.zoom);

  return {
    ...point,
    x: (point.x - transform.panX) / transform.zoom,
    y: (point.y - transform.panY) / transform.zoom,
  };
}

export function sceneToViewportPoint(
  point: ScenePoint,
  transform: ViewTransform,
): ScenePoint {
  assertValidZoom(transform.zoom);

  return {
    ...point,
    x: point.x * transform.zoom + transform.panX,
    y: point.y * transform.zoom + transform.panY,
  };
}

/**
 * Returns coalesced samples followed by the dispatch event. Safari and other
 * browsers sometimes include the dispatch event in getCoalescedEvents(); it is
 * removed before the explicit final append so callers never draw it twice.
 */
export function pointerSamples(
  event: PointerEventLike,
  transform: ViewTransform,
  fallbackKind: PointerKind = pointerKindOf(event),
): readonly ScenePoint[] {
  const events: PointerEventLike[] = [];
  const coalesced = readCoalescedEvents(event);

  for (const sample of coalesced) {
    if (sample.pointerId !== event.pointerId || sameSample(sample, event)) {
      continue;
    }
    events.push(sample);
  }
  events.push(event);

  return events.map((sample) =>
    viewportToScenePoint(eventToPoint(sample, fallbackKind), transform),
  );
}

/**
 * Coordinates Pointer Events for a Pencil-first canvas. Accepted pointers are
 * captured until up/cancel. Touch is treated as palm input while any pen is
 * active; a newly arriving pen also cancels and releases accepted touches.
 */
export class PencilPointerTracker {
  readonly #active = new Map<number, ActivePointer>();
  readonly #onPointerCancelled: ((pointerId: number) => void) | undefined;

  public constructor(options: PencilPointerTrackerOptions = {}) {
    this.#onPointerCancelled = options.onPointerCancelled;
  }

  public pointerDown(
    event: PointerEventLike,
    target: PointerCaptureTargetLike,
    transform: ViewTransform,
  ): PointerTrackingResult {
    const kind = pointerKindOf(event);

    if (kind === "touch" && this.#hasActivePen()) {
      return rejectedResult();
    }

    const cancelledPointerIds = kind === "pen" ? this.#cancelActiveTouches() : [];
    const previous = this.#active.get(event.pointerId);
    if (previous !== undefined) {
      safeReleasePointer(previous.target, event.pointerId);
      this.#active.delete(event.pointerId);
    }

    this.#active.set(event.pointerId, { kind, target });
    safeCapturePointer(target, event.pointerId);
    safePreventDefault(event);

    return {
      accepted: true,
      points: pointerSamples(event, transform),
      cancelledPointerIds,
    };
  }

  public pointerMove(
    event: PointerEventLike,
    transform: ViewTransform,
  ): PointerTrackingResult {
    const active = this.#active.get(event.pointerId);
    if (active === undefined) {
      return rejectedResult();
    }

    safePreventDefault(event);
    return {
      accepted: true,
      points: pointerSamples(event, transform, active.kind),
      cancelledPointerIds: EMPTY_POINTER_IDS,
    };
  }

  public pointerUp(
    event: PointerEventLike,
    transform: ViewTransform,
  ): PointerTrackingResult {
    const active = this.#active.get(event.pointerId);
    if (active === undefined) {
      return rejectedResult();
    }

    const points = pointerSamples(event, transform, active.kind);
    safePreventDefault(event);
    safeReleasePointer(active.target, event.pointerId);
    this.#active.delete(event.pointerId);

    return {
      accepted: true,
      points,
      cancelledPointerIds: EMPTY_POINTER_IDS,
    };
  }

  public pointerCancel(
    event: Pick<PointerEventLike, "pointerId" | "preventDefault">,
  ): PointerTrackingResult {
    const active = this.#active.get(event.pointerId);
    if (active === undefined) {
      return rejectedResult();
    }

    safePreventDefault(event);
    safeReleasePointer(active.target, event.pointerId);
    this.#active.delete(event.pointerId);

    return {
      accepted: true,
      points: EMPTY_POINTS,
      cancelledPointerIds: EMPTY_POINTER_IDS,
    };
  }

  public isActive(pointerId: number): boolean {
    return this.#active.has(pointerId);
  }

  public activePointerIds(kind?: PointerKind): readonly number[] {
    const ids: number[] = [];
    for (const [pointerId, active] of this.#active) {
      if (kind === undefined || active.kind === kind) {
        ids.push(pointerId);
      }
    }
    return ids;
  }

  public releaseAll(): void {
    for (const [pointerId, active] of this.#active) {
      safeReleasePointer(active.target, pointerId);
    }
    this.#active.clear();
  }

  #hasActivePen(): boolean {
    for (const active of this.#active.values()) {
      if (active.kind === "pen") {
        return true;
      }
    }
    return false;
  }

  #cancelActiveTouches(): number[] {
    const cancelledPointerIds: number[] = [];

    for (const [pointerId, active] of this.#active) {
      if (active.kind !== "touch") {
        continue;
      }

      safeReleasePointer(active.target, pointerId);
      this.#active.delete(pointerId);
      cancelledPointerIds.push(pointerId);
      try {
        this.#onPointerCancelled?.(pointerId);
      } catch {
        // Input cleanup must not be interruptible by an application callback.
      }
    }

    return cancelledPointerIds;
  }
}

function readCoalescedEvents(event: PointerEventLike): readonly PointerEventLike[] {
  if (typeof event.getCoalescedEvents !== "function") {
    return EMPTY_EVENTS;
  }

  try {
    const samples = event.getCoalescedEvents.call(event);
    return Array.isArray(samples) ? samples : EMPTY_EVENTS;
  } catch {
    // getCoalescedEvents is absent in some WebKit versions and may throw in
    // synthetic events. The dispatch event remains the reliable fallback.
    return EMPTY_EVENTS;
  }
}

function eventToPoint(event: PointerEventLike, fallbackKind: PointerKind): ScenePoint {
  return {
    x: finiteOr(event.clientX, 0),
    y: finiteOr(event.clientY, 0),
    pressure: clamp(finiteOr(event.pressure, 0.5), 0, 1),
    tiltX: clamp(finiteOr(event.tiltX, 0), -90, 90),
    tiltY: clamp(finiteOr(event.tiltY, 0), -90, 90),
    time: finiteOr(event.timeStamp, 0),
    pointerType: event.pointerType ? pointerKindOf(event) : fallbackKind,
  };
}

function sameSample(left: PointerEventLike, right: PointerEventLike): boolean {
  return left === right || (
    left.pointerId === right.pointerId
    && left.clientX === right.clientX
    && left.clientY === right.clientY
    && left.pressure === right.pressure
    && left.tiltX === right.tiltX
    && left.tiltY === right.tiltY
    && left.timeStamp === right.timeStamp
  );
}

function safeCapturePointer(target: PointerCaptureTargetLike, pointerId: number): void {
  try {
    target.setPointerCapture?.(pointerId);
  } catch {
    // Capture can race with pointer cancellation. Tracking still remains local
    // and pointerup/pointercancel will clean it up when delivered.
  }
}

function safeReleasePointer(target: PointerCaptureTargetLike, pointerId: number): void {
  try {
    if (target.hasPointerCapture?.(pointerId) === false) {
      return;
    }
    target.releasePointerCapture?.(pointerId);
  } catch {
    // Releasing a pointer that the browser already cancelled is harmless.
  }
}

function safePreventDefault(event: Pick<PointerEventLike, "preventDefault">): void {
  try {
    event.preventDefault?.();
  } catch {
    // Synthetic and test events can expose a non-callable browser shim.
  }
}

function rejectedResult(): PointerTrackingResult {
  return {
    accepted: false,
    points: EMPTY_POINTS,
    cancelledPointerIds: EMPTY_POINTER_IDS,
  };
}

function assertValidZoom(zoom: number): void {
  if (!Number.isFinite(zoom) || zoom <= 0) {
    throw new RangeError("ViewTransform.zoom must be a finite number greater than zero");
  }
}

function finiteOr(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
