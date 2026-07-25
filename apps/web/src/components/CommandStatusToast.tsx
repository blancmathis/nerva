import type { CommandAck } from "../lib/model";
import { CloseIcon } from "./Icons";

interface CommandStatusToastProps {
  readonly ack: CommandAck;
  readonly onDismiss: () => void;
}

export function CommandStatusToast({ ack, onDismiss }: CommandStatusToastProps) {
  const title = ack.pending
    ? "Command in progress"
    : ack.ok
      ? "Command acknowledged"
      : "Command not accepted";

  return (
    <div className={`ack-toast${ack.ok ? "" : " is-error"}`} role="status">
      <span className="ack-mark" aria-hidden="true" />
      <span><strong>{title}</strong><small>{ack.message}</small></span>
      <button type="button" onClick={onDismiss} aria-label="Dismiss command status"><CloseIcon /></button>
    </div>
  );
}
