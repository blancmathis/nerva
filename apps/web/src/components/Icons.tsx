import type { SVGProps } from "react";

export type IconProps = SVGProps<SVGSVGElement>;

const base = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

export function BoltIcon(props: IconProps) {
  return <svg {...base} {...props}><path d="M13.5 2.8 5.7 13h5l-.2 8.2 7.8-10.3h-5l.2-8.1Z" /></svg>;
}

export function CheckIcon(props: IconProps) {
  return <svg {...base} {...props}><path d="m4.5 12.5 4.7 4.7L19.7 6.8" /></svg>;
}

export function XIcon(props: IconProps) {
  return <svg {...base} {...props}><path d="m6 6 12 12M18 6 6 18" /></svg>;
}

export function ForkIcon(props: IconProps) {
  return <svg {...base} {...props}><circle cx="6" cy="5" r="2" /><circle cx="18" cy="5" r="2" /><circle cx="12" cy="19" r="2" /><path d="M6 7v2.4c0 2.1 1.7 3.8 3.8 3.8H12m6-6.2v2.4c0 2.1-1.7 3.8-3.8 3.8H12V17" /></svg>;
}

export function PlusIcon(props: IconProps) {
  return <svg {...base} {...props}><path d="M12 5v14M5 12h14" /></svg>;
}

export function PencilIcon(props: IconProps) {
  return <svg {...base} {...props}><path d="m15.8 4.3 3.9 3.9M5 19l3.4-.7L19 7.7a1.8 1.8 0 0 0 0-2.5l-.2-.2a1.8 1.8 0 0 0-2.5 0L5.7 15.6 5 19Z" /><path d="m13.8 6.5 3.8 3.8" /></svg>;
}

export function SparkIcon(props: IconProps) {
  return <svg {...base} {...props}><path d="M12 2.8 13.8 9l5.9 1.8-5.9 1.8-1.8 6.2-1.8-6.2-5.9-1.8L10.2 9 12 2.8Z" /></svg>;
}

export function ChevronIcon({ direction = "right", ...props }: IconProps & { direction?: "left" | "right" }) {
  return <svg {...base} {...props}><path d={direction === "left" ? "m14.5 6-6 6 6 6" : "m9.5 6 6 6-6 6"} /></svg>;
}

export function CloseIcon(props: IconProps) {
  return <svg {...base} {...props}><path d="M6 6l12 12M18 6 6 18" /></svg>;
}

export function LinkIcon(props: IconProps) {
  return <svg {...base} {...props}><path d="M10.2 13.8a4 4 0 0 0 5.7 0l2-2a4 4 0 1 0-5.7-5.7l-1.1 1.1" /><path d="M13.8 10.2a4 4 0 0 0-5.7 0l-2 2a4 4 0 1 0 5.7 5.7l1.1-1.1" /></svg>;
}

export function HomeIcon(props: IconProps) {
  return <svg {...base} {...props}><path d="m3.5 10 8.5-7 8.5 7" /><path d="M5.5 8.5V21h13V8.5M9.5 21v-7h5v7" /></svg>;
}

export function FolderIcon(props: IconProps) {
  return <svg {...base} {...props}><path d="M3 6.5h6l2 2h10v9.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6.5Z" /><path d="M3 10h18" /></svg>;
}

export function SlidersIcon(props: IconProps) {
  return <svg {...base} {...props}><path d="M4 6h10M18 6h2M4 12h3M11 12h9M4 18h8M16 18h4" /><circle cx="16" cy="6" r="2" /><circle cx="9" cy="12" r="2" /><circle cx="14" cy="18" r="2" /></svg>;
}

export function SearchIcon(props: IconProps) {
  return <svg {...base} {...props}><circle cx="10.5" cy="10.5" r="6.5" /><path d="m15.5 15.5 5 5" /></svg>;
}

export function PinIcon(props: IconProps) {
  return <svg {...base} {...props}><path d="m14.5 3 6.5 6.5-3 1.5-4.5 4.5-1 5.5-2-2-5.5-1 4.5-4.5L11 10 14.5 3Z" /><path d="m4 20 5.5-5.5" /></svg>;
}

export function MacIcon(props: IconProps) {
  return <svg {...base} {...props}><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M8 21h8M12 17v4" /></svg>;
}

export function CameraIcon(props: IconProps) {
  return <svg {...base} {...props}><path d="M4 7.5h3l1.5-2h7l1.5 2h3a1.5 1.5 0 0 1 1.5 1.5v9.5A1.5 1.5 0 0 1 20 20H4a1.5 1.5 0 0 1-1.5-1.5V9A1.5 1.5 0 0 1 4 7.5Z" /><circle cx="12" cy="13.5" r="4" /></svg>;
}

export function MicIcon(props: IconProps) {
  return <svg {...base} {...props}><rect x="8" y="3" width="8" height="12" rx="4" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6" /></svg>;
}

export function GlobeIcon(props: IconProps) {
  return <svg {...base} {...props}><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></svg>;
}

export function LayersIcon(props: IconProps) {
  return <svg {...base} {...props}><path d="m12 3 9 5-9 5-9-5 9-5Z" /><path d="m3 12 9 5 9-5M3 16l9 5 9-5" /></svg>;
}

export function MoreIcon(props: IconProps) {
  return <svg {...base} {...props}><circle cx="5" cy="12" r="1" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" /><circle cx="19" cy="12" r="1" fill="currentColor" stroke="none" /></svg>;
}

export function ArrowUpIcon(props: IconProps) {
  return <svg {...base} {...props}><path d="m6 10 6-6 6 6M12 4v16" /></svg>;
}

export function ArrowDownIcon(props: IconProps) {
  return <svg {...base} {...props}><path d="m6 14 6 6 6-6M12 20V4" /></svg>;
}

export function RefreshIcon(props: IconProps) {
  return <svg {...base} {...props}><path d="M20 7v5h-5" /><path d="M18.2 16.8A8 8 0 1 1 19.7 9L20 12" /></svg>;
}

export function MissionControlIcon(props: IconProps) {
  return <svg {...base} {...props}><circle cx="12" cy="12" r="3" /><circle cx="5" cy="6" r="2" /><circle cx="19" cy="6" r="2" /><circle cx="5" cy="18" r="2" /><circle cx="19" cy="18" r="2" /><path d="m7 7.4 2.5 2.5M17 7.4l-2.5 2.5M7 16.6l2.5-2.5M17 16.6l-2.5-2.5" /></svg>;
}

export function InboxIcon(props: IconProps) {
  return <svg {...base} {...props}><path d="M4.5 4.5h15l2 9v5a2 2 0 0 1-2 2h-15a2 2 0 0 1-2-2v-5l2-9Z" /><path d="M3 13.5h5l1.6 2.5h4.8l1.6-2.5h5" /></svg>;
}

export function DocumentIcon(props: IconProps) {
  return <svg {...base} {...props}><path d="M6 2.8h8l4 4V21H6a2 2 0 0 1-2-2V4.8a2 2 0 0 1 2-2Z" /><path d="M14 2.8v4h4M8 12h6M8 16h7" /></svg>;
}

export function NoteIcon(props: IconProps) {
  return <svg {...base} {...props}><path d="M5 3h14v13l-5 5H5V3Z" /><path d="M14 21v-5h5M8 8h8M8 12h6" /></svg>;
}

export function TrashIcon(props: IconProps) {
  return <svg {...base} {...props}><path d="M4 7h16M9 3h6l1 4H8l1-4ZM7 7l1 14h8l1-14M10 11v6M14 11v6" /></svg>;
}

export function RouteIcon(props: IconProps) {
  return <svg {...base} {...props}><circle cx="6" cy="18" r="2.5" /><circle cx="18" cy="6" r="2.5" /><path d="M8 18h2.5a3 3 0 0 0 3-3V9a3 3 0 0 1 3-3" /></svg>;
}

export function StopIcon(props: IconProps) {
  return <svg {...base} {...props}><rect x="6" y="6" width="12" height="12" rx="2" /></svg>;
}
