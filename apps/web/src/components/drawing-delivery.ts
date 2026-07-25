export interface DrawingResultLike {
  ok: boolean;
  deliveryUnknown?: boolean;
  pending?: boolean;
}

export interface DrawingDeliveryStatus {
  readonly state: "pending" | "final" | "unknown";
  readonly ok: boolean;
  readonly message?: string;
}

/** Any pending/unknown outcome must keep the same idempotency key. */
export function drawingDeliveryIsUnresolved(result: DrawingResultLike): boolean {
  return result.deliveryUnknown === true || result.pending === true;
}
