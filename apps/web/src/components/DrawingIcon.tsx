export type DrawingIconName =
  | "add-block"
  | "arrow"
  | "close"
  | "diagram"
  | "edit"
  | "ellipse"
  | "eraser"
  | "image-add"
  | "marker"
  | "pan"
  | "pen"
  | "rectangle"
  | "select"
  | "redo"
  | "refresh"
  | "sync"
  | "text"
  | "trash"
  | "undo"
  | "zoom-in"
  | "zoom-out";

interface DrawingIconProps {
  name: DrawingIconName;
  className?: string;
}

/**
 * One optical icon family for the tactile drawing surfaces.
 *
 * Every icon shares the same 24 × 24 coordinate system, rounded geometry and
 * stroke weight so a tool never shifts just because the system font changed.
 */
export function DrawingIcon({ name, className }: DrawingIconProps) {
  const shared = {
    className: ["drawing-icon", className].filter(Boolean).join(" "),
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    focusable: false,
    "aria-hidden": true,
  };

  switch (name) {
    case "select":
      return (
        <svg {...shared}>
          <path d="m5.25 3.75 12.8 8.1-6.1 1.35-3.2 5.3-3.5-14.75Z" />
          <path d="m12 13.2 4.1 5.1" />
        </svg>
      );
    case "diagram":
      return (
        <svg {...shared}>
          <rect x="3.25" y="4.25" width="6.5" height="5.5" rx="1.5" />
          <rect x="14.25" y="14.25" width="6.5" height="5.5" rx="1.5" />
          <path d="M9.75 7h3a4.5 4.5 0 0 1 4.5 4.5v2.75" />
          <path d="m14.75 12.25 2.5 2.25 2.5-2.25" />
        </svg>
      );
    case "pen":
      return (
        <svg {...shared}>
          <path d="m5 19 1.1-4.6L15.9 4.6a2.1 2.1 0 0 1 3 3l-9.8 9.8L5 19Z" />
          <path d="m13.9 6.6 3.5 3.5M6.1 14.4l3.5 3.5" />
        </svg>
      );
    case "marker":
      return (
        <svg {...shared}>
          <path d="m7.2 15.8 7.9-10.4a1.8 1.8 0 0 1 2.6-.3l1.2.9a1.8 1.8 0 0 1 .3 2.6L11.3 19l-4.1-3.2Z" />
          <path d="m5 19 2.2-3.2 4.1 3.2L7.2 20H5v-1Z" />
          <path d="M4 21h8" />
        </svg>
      );
    case "eraser":
      return (
        <svg {...shared}>
          <path d="m4.7 14.1 8.6-8.6a2 2 0 0 1 2.8 0l2.4 2.4a2 2 0 0 1 0 2.8l-8.1 8.1a2 2 0 0 1-2.8 0l-2.9-2.9a1.3 1.3 0 0 1 0-1.8Z" />
          <path d="m11.1 7.7 5.2 5.2M9.8 19.4h9.7" />
        </svg>
      );
    case "arrow":
      return (
        <svg {...shared}>
          <path d="M5 19 19 5M11 5h8v8" />
        </svg>
      );
    case "rectangle":
      return (
        <svg {...shared}>
          <rect x="4" y="5" width="16" height="14" rx="2.5" />
        </svg>
      );
    case "ellipse":
      return (
        <svg {...shared}>
          <ellipse cx="12" cy="12" rx="8" ry="6.5" />
        </svg>
      );
    case "text":
      return (
        <svg {...shared}>
          <path d="M5 6h14M12 6v13M8.5 19h7" />
        </svg>
      );
    case "pan":
      return (
        <svg {...shared}>
          <path d="M12 9V3M9.5 5.5 12 3l2.5 2.5M15 12h6M18.5 9.5 21 12l-2.5 2.5M12 15v6M14.5 18.5 12 21l-2.5-2.5M9 12H3M5.5 14.5 3 12l2.5-2.5" />
          <circle cx="12" cy="12" r="1.35" fill="currentColor" stroke="none" />
        </svg>
      );
    case "undo":
      return (
        <svg {...shared}>
          <path d="M8 8H4V4" />
          <path d="M4.5 8.2A8 8 0 1 1 5 17" />
        </svg>
      );
    case "redo":
      return (
        <svg {...shared}>
          <path d="M16 8h4V4" />
          <path d="M19.5 8.2A8 8 0 1 0 19 17" />
        </svg>
      );
    case "image-add":
      return (
        <svg {...shared}>
          <rect x="3.5" y="4" width="17" height="16" rx="3" />
          <circle cx="8.5" cy="9" r="1.5" />
          <path d="m5.5 17 4.2-4.2 2.8 2.8 2.1-2.1 3.9 3.9M17 5.5v5M14.5 8h5" />
        </svg>
      );
    case "add-block":
      return (
        <svg {...shared}>
          <rect x="3.5" y="3.5" width="17" height="17" rx="3.5" />
          <path d="M12 8v8M8 12h8" />
        </svg>
      );
    case "edit":
      return (
        <svg {...shared}>
          <rect x="3.5" y="4" width="17" height="16" rx="3" />
          <path d="M9 4v16M12.5 8h4M12.5 12h4M12.5 16h2.5" />
        </svg>
      );
    case "sync":
      return (
        <svg {...shared}>
          <path d="M12 16V4M7.5 8.5 12 4l4.5 4.5M5 20h14" />
        </svg>
      );
    case "refresh":
      return (
        <svg {...shared}>
          <path d="M19.5 7.5V3.8l-2 2A8 8 0 1 0 20 14" />
          <path d="M19.5 3.8h-3.7" />
        </svg>
      );
    case "close":
      return (
        <svg {...shared}>
          <path d="m6.5 6.5 11 11M17.5 6.5l-11 11" />
        </svg>
      );
    case "trash":
      return (
        <svg {...shared}>
          <path d="M4.5 7h15M9 3.5h6l1 3.5M7 7l.7 13h8.6L17 7M10 10.5v6M14 10.5v6" />
        </svg>
      );
    case "zoom-in":
      return (
        <svg {...shared}>
          <path d="M12 7v10M7 12h10" />
        </svg>
      );
    case "zoom-out":
      return (
        <svg {...shared}>
          <path d="M7 12h10" />
        </svg>
      );
  }
}
