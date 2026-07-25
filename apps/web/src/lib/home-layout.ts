import type { SpatialLayout } from "./spatial-model";

export const HOME_LAYOUT_VERSION = 1 as const;
export const MAX_PINNED_SESSIONS = 12;
export const MAX_HOME_SECTIONS = 12;
export const MAX_CASES_PER_HOME = 48;

export const HOME_COLORS = [
  "amber",
  "cobalt",
  "coral",
  "sage",
  "violet",
  "slate",
] as const;

export const AUTOMATIC_STATUS_ORDER = [
  "needs-approval",
  "error",
  "working",
  "waiting",
  "completed",
  "idle",
] as const;

export type HomeColor = (typeof HOME_COLORS)[number];
export type AutomaticStatus = (typeof AUTOMATIC_STATUS_ORDER)[number];
export type HomeLayoutMode = "manual" | "automatic";

export interface HomeCase {
  readonly id: string;
  readonly name: string;
  readonly color: HomeColor;
  readonly threadIds: readonly string[];
}

export interface HomeSection {
  readonly id: string;
  readonly name: string;
  readonly color: HomeColor;
  readonly cases: readonly HomeCase[];
}

export interface ManualHomeLayout {
  readonly sections: readonly HomeSection[];
  readonly looseThreadIds: readonly string[];
}

export interface HomeLayout {
  readonly version: typeof HOME_LAYOUT_VERSION;
  readonly mode: HomeLayoutMode;
  readonly pinnedThreadIds: readonly string[];
  readonly manual: ManualHomeLayout;
  readonly automaticOrder: readonly AutomaticStatus[];
}

export type HomeLayoutAction =
  | { readonly type: "set-mode"; readonly mode: HomeLayoutMode }
  | { readonly type: "pin"; readonly threadId: string }
  | { readonly type: "replace-pin"; readonly unpinThreadId: string; readonly pinThreadId: string }
  | { readonly type: "unpin"; readonly threadId: string }
  | { readonly type: "create-section"; readonly section: Omit<HomeSection, "cases"> }
  | { readonly type: "rename-section"; readonly sectionId: string; readonly name: string }
  | { readonly type: "recolor-section"; readonly sectionId: string; readonly color: HomeColor }
  | { readonly type: "reorder-section"; readonly sectionId: string; readonly toIndex: number }
  | { readonly type: "delete-section"; readonly sectionId: string }
  | { readonly type: "create-case"; readonly sectionId: string; readonly homeCase: Omit<HomeCase, "threadIds"> }
  | { readonly type: "rename-case"; readonly caseId: string; readonly name: string }
  | { readonly type: "recolor-case"; readonly caseId: string; readonly color: HomeColor }
  | { readonly type: "move-case"; readonly caseId: string; readonly sectionId: string; readonly toIndex?: number }
  | { readonly type: "delete-case"; readonly caseId: string }
  | { readonly type: "move-session"; readonly threadId: string; readonly targetCaseId: string | null; readonly beforeThreadId?: string }
  | { readonly type: "set-automatic-order"; readonly order: readonly AutomaticStatus[] };

const EMPTY_LAYOUT: HomeLayout = {
  version: HOME_LAYOUT_VERSION,
  mode: "manual",
  pinnedThreadIds: [],
  manual: { sections: [], looseThreadIds: [] },
  automaticOrder: AUTOMATIC_STATUS_ORDER,
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function cleanId(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const cleaned = value.trim().replace(/[\u0000-\u001f\u007f]/gu, "").slice(0, 120);
  return cleaned || fallback;
}

function cleanName(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const cleaned = value.trim().replace(/\s+/gu, " ").slice(0, 80);
  return cleaned || fallback;
}

function cleanThreadId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.trim().slice(0, 256);
  return cleaned || null;
}

function isColor(value: unknown): value is HomeColor {
  return typeof value === "string" && (HOME_COLORS as readonly string[]).includes(value);
}

function uniqueThreadIds(value: unknown, maximum = MAX_PINNED_SESSIONS): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const candidate of value) {
    const id = cleanThreadId(candidate);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
    if (result.length >= maximum) break;
  }
  return result;
}

function automaticOrder(value: unknown): readonly AutomaticStatus[] {
  if (!Array.isArray(value)) return AUTOMATIC_STATUS_ORDER;
  const proposed = value.filter((candidate): candidate is AutomaticStatus => (
    typeof candidate === "string"
    && (AUTOMATIC_STATUS_ORDER as readonly string[]).includes(candidate)
  ));
  if (new Set(proposed).size !== AUTOMATIC_STATUS_ORDER.length) return AUTOMATIC_STATUS_ORDER;
  return proposed;
}

function sanitizeManual(
  value: unknown,
  pinnedThreadIds: readonly string[],
): ManualHomeLayout {
  const source = record(value);
  const pinned = new Set(pinnedThreadIds);
  const placed = new Set<string>();
  const usedSectionIds = new Set<string>();
  const usedCaseIds = new Set<string>();
  let caseCount = 0;
  const sections: HomeSection[] = [];
  const rawSections = Array.isArray(source?.sections) ? source.sections : [];

  for (const [sectionIndex, rawSection] of rawSections.entries()) {
    if (sections.length >= MAX_HOME_SECTIONS) break;
    const sectionSource = record(rawSection);
    if (!sectionSource) continue;
    let sectionId = cleanId(sectionSource.id, `section-${sectionIndex + 1}`);
    while (usedSectionIds.has(sectionId)) sectionId = `${sectionId}-copy`;
    usedSectionIds.add(sectionId);
    const cases: HomeCase[] = [];
    const rawCases = Array.isArray(sectionSource.cases) ? sectionSource.cases : [];
    for (const [caseIndex, rawCase] of rawCases.entries()) {
      if (caseCount >= MAX_CASES_PER_HOME) break;
      const caseSource = record(rawCase);
      if (!caseSource) continue;
      let caseId = cleanId(caseSource.id, `${sectionId}-case-${caseIndex + 1}`);
      while (usedCaseIds.has(caseId)) caseId = `${caseId}-copy`;
      usedCaseIds.add(caseId);
      const threadIds = uniqueThreadIds(caseSource.threadIds).filter((threadId) => {
        if (!pinned.has(threadId) || placed.has(threadId)) return false;
        placed.add(threadId);
        return true;
      });
      cases.push({
        id: caseId,
        name: cleanName(caseSource.name, `Case ${caseIndex + 1}`),
        color: isColor(caseSource.color) ? caseSource.color : HOME_COLORS[caseIndex % HOME_COLORS.length]!,
        threadIds,
      });
      caseCount += 1;
    }
    sections.push({
      id: sectionId,
      name: cleanName(sectionSource.name, `Section ${sectionIndex + 1}`),
      color: isColor(sectionSource.color) ? sectionSource.color : HOME_COLORS[sectionIndex % HOME_COLORS.length]!,
      cases,
    });
  }

  const looseThreadIds = uniqueThreadIds(source?.looseThreadIds).filter((threadId) => {
    if (!pinned.has(threadId) || placed.has(threadId)) return false;
    placed.add(threadId);
    return true;
  });
  for (const threadId of pinnedThreadIds) {
    if (!placed.has(threadId)) looseThreadIds.push(threadId);
  }
  return { sections, looseThreadIds };
}

export function emptyHomeLayout(): HomeLayout {
  return EMPTY_LAYOUT;
}

export function createInitialHomeLayout(threadIds: readonly string[]): HomeLayout {
  const pinnedThreadIds = uniqueThreadIds(threadIds);
  return {
    ...EMPTY_LAYOUT,
    pinnedThreadIds,
    manual: { sections: [], looseThreadIds: pinnedThreadIds },
  };
}

export function migrateHomeLayout(value: unknown): HomeLayout {
  const source = record(value);
  if (!source) return emptyHomeLayout();
  const pinnedThreadIds = uniqueThreadIds(source.pinnedThreadIds);
  return {
    version: HOME_LAYOUT_VERSION,
    mode: source.mode === "automatic" ? "automatic" : "manual",
    pinnedThreadIds,
    manual: sanitizeManual(source.manual, pinnedThreadIds),
    automaticOrder: automaticOrder(source.automaticOrder),
  };
}

export function migrateLegacySpatialLayout(layout: SpatialLayout): HomeLayout {
  const pinnedThreadIds = uniqueThreadIds([
    ...layout.unassignedThreadIds,
    ...layout.boxes.flatMap((box) => box.threadIds),
  ]);
  const cases = layout.boxes.slice(0, MAX_CASES_PER_HOME).map((box, index): HomeCase => ({
    id: cleanId(box.id, `case-${index + 1}`),
    name: cleanName(box.name, `Case ${index + 1}`),
    color: isColor(box.color) ? box.color : HOME_COLORS[index % HOME_COLORS.length]!,
    threadIds: box.threadIds.filter((threadId) => pinnedThreadIds.includes(threadId)),
  }));
  const placed = new Set(cases.flatMap((homeCase) => homeCase.threadIds));
  return migrateHomeLayout({
    version: HOME_LAYOUT_VERSION,
    mode: "manual",
    pinnedThreadIds,
    manual: {
      sections: cases.length === 0 ? [] : [{ id: "imported-spatial", name: "Workspace", color: "slate", cases }],
      looseThreadIds: pinnedThreadIds.filter((threadId) => !placed.has(threadId)),
    },
    automaticOrder: AUTOMATIC_STATUS_ORDER,
  });
}

function withoutThread(layout: HomeLayout, threadId: string): HomeLayout {
  return {
    ...layout,
    manual: {
      sections: layout.manual.sections.map((section) => ({
        ...section,
        cases: section.cases.map((homeCase) => ({
          ...homeCase,
          threadIds: homeCase.threadIds.filter((candidate) => candidate !== threadId),
        })),
      })),
      looseThreadIds: layout.manual.looseThreadIds.filter((candidate) => candidate !== threadId),
    },
  };
}

function insertBefore(
  values: readonly string[],
  value: string,
  before: string | undefined,
): readonly string[] {
  if (!before) return [...values, value];
  const index = values.indexOf(before);
  return index < 0
    ? [...values, value]
    : [...values.slice(0, index), value, ...values.slice(index)];
}

function updateSections(
  layout: HomeLayout,
  update: (sections: readonly HomeSection[]) => readonly HomeSection[],
): HomeLayout {
  return { ...layout, manual: { ...layout.manual, sections: update(layout.manual.sections) } };
}

function findCase(layout: HomeLayout, caseId: string): HomeCase | null {
  for (const section of layout.manual.sections) {
    const found = section.cases.find((homeCase) => homeCase.id === caseId);
    if (found) return found;
  }
  return null;
}

export function homeLayoutReducer(layoutInput: HomeLayout, action: HomeLayoutAction): HomeLayout {
  const layout = migrateHomeLayout(layoutInput);
  switch (action.type) {
    case "set-mode":
      return action.mode === layout.mode ? layout : { ...layout, mode: action.mode };
    case "pin": {
      const threadId = cleanThreadId(action.threadId);
      if (!threadId || layout.pinnedThreadIds.includes(threadId) || layout.pinnedThreadIds.length >= MAX_PINNED_SESSIONS) return layout;
      return {
        ...layout,
        pinnedThreadIds: [...layout.pinnedThreadIds, threadId],
        manual: { ...layout.manual, looseThreadIds: [...layout.manual.looseThreadIds, threadId] },
      };
    }
    case "replace-pin": {
      const unpinThreadId = cleanThreadId(action.unpinThreadId);
      const pinThreadId = cleanThreadId(action.pinThreadId);
      if (
        !unpinThreadId
        || !pinThreadId
        || unpinThreadId === pinThreadId
        || !layout.pinnedThreadIds.includes(unpinThreadId)
        || layout.pinnedThreadIds.includes(pinThreadId)
      ) return layout;
      const withoutOld = withoutThread(layout, unpinThreadId);
      return {
        ...withoutOld,
        pinnedThreadIds: withoutOld.pinnedThreadIds.map((threadId) => threadId === unpinThreadId ? pinThreadId : threadId),
        manual: {
          ...withoutOld.manual,
          looseThreadIds: [...withoutOld.manual.looseThreadIds, pinThreadId],
        },
      };
    }
    case "unpin": {
      const threadId = cleanThreadId(action.threadId);
      if (!threadId || !layout.pinnedThreadIds.includes(threadId)) return layout;
      const next = withoutThread(layout, threadId);
      return { ...next, pinnedThreadIds: next.pinnedThreadIds.filter((candidate) => candidate !== threadId) };
    }
    case "create-section": {
      if (
        layout.manual.sections.length >= MAX_HOME_SECTIONS
        || layout.manual.sections.some((section) => section.id === action.section.id)
      ) return layout;
      const index = layout.manual.sections.length;
      const section: HomeSection = {
        id: cleanId(action.section.id, `section-${index + 1}`),
        name: cleanName(action.section.name, `Section ${index + 1}`),
        color: isColor(action.section.color) ? action.section.color : HOME_COLORS[index % HOME_COLORS.length]!,
        cases: [],
      };
      return updateSections(layout, (sections) => [...sections, section]);
    }
    case "rename-section":
      return updateSections(layout, (sections) => sections.map((section) => section.id === action.sectionId
        ? { ...section, name: cleanName(action.name, section.name) }
        : section));
    case "recolor-section":
      return isColor(action.color) ? updateSections(layout, (sections) => sections.map((section) => section.id === action.sectionId
        ? { ...section, color: action.color }
        : section)) : layout;
    case "reorder-section": {
      const fromIndex = layout.manual.sections.findIndex((section) => section.id === action.sectionId);
      if (fromIndex < 0) return layout;
      const toIndex = Math.max(0, Math.min(layout.manual.sections.length - 1, action.toIndex));
      if (toIndex === fromIndex) return layout;
      const sections = [...layout.manual.sections];
      const [moved] = sections.splice(fromIndex, 1);
      if (!moved) return layout;
      sections.splice(toIndex, 0, moved);
      return updateSections(layout, () => sections);
    }
    case "delete-section": {
      const section = layout.manual.sections.find((candidate) => candidate.id === action.sectionId);
      if (!section) return layout;
      const returned = section.cases.flatMap((homeCase) => homeCase.threadIds);
      return {
        ...layout,
        manual: {
          sections: layout.manual.sections.filter((candidate) => candidate.id !== action.sectionId),
          looseThreadIds: [...layout.manual.looseThreadIds, ...returned],
        },
      };
    }
    case "create-case": {
      const totalCases = layout.manual.sections.reduce((total, section) => total + section.cases.length, 0);
      if (totalCases >= MAX_CASES_PER_HOME || findCase(layout, action.homeCase.id)) return layout;
      return updateSections(layout, (sections) => sections.map((section) => section.id === action.sectionId
        ? {
            ...section,
            cases: [...section.cases, {
              id: cleanId(action.homeCase.id, `case-${totalCases + 1}`),
              name: cleanName(action.homeCase.name, `Case ${totalCases + 1}`),
              color: isColor(action.homeCase.color) ? action.homeCase.color : "amber",
              threadIds: [],
            }],
          }
        : section));
    }
    case "rename-case":
      return updateSections(layout, (sections) => sections.map((section) => ({
        ...section,
        cases: section.cases.map((homeCase) => homeCase.id === action.caseId
          ? { ...homeCase, name: cleanName(action.name, homeCase.name) }
          : homeCase),
      })));
    case "recolor-case":
      return isColor(action.color) ? updateSections(layout, (sections) => sections.map((section) => ({
        ...section,
        cases: section.cases.map((homeCase) => homeCase.id === action.caseId
          ? { ...homeCase, color: action.color }
          : homeCase),
      }))) : layout;
    case "move-case": {
      const moved = findCase(layout, action.caseId);
      if (!moved || !layout.manual.sections.some((section) => section.id === action.sectionId)) return layout;
      const removed = layout.manual.sections.map((section) => ({
        ...section,
        cases: section.cases.filter((homeCase) => homeCase.id !== action.caseId),
      }));
      return updateSections(layout, () => removed.map((section) => {
        if (section.id !== action.sectionId) return section;
        const index = Math.max(0, Math.min(section.cases.length, action.toIndex ?? section.cases.length));
        return { ...section, cases: [...section.cases.slice(0, index), moved, ...section.cases.slice(index)] };
      }));
    }
    case "delete-case": {
      const deleted = findCase(layout, action.caseId);
      if (!deleted) return layout;
      return {
        ...layout,
        manual: {
          sections: layout.manual.sections.map((section) => ({
            ...section,
            cases: section.cases.filter((homeCase) => homeCase.id !== action.caseId),
          })),
          looseThreadIds: [...layout.manual.looseThreadIds, ...deleted.threadIds],
        },
      };
    }
    case "move-session": {
      const threadId = cleanThreadId(action.threadId);
      if (!threadId || !layout.pinnedThreadIds.includes(threadId)) return layout;
      if (action.targetCaseId !== null && !findCase(layout, action.targetCaseId)) return layout;
      const next = withoutThread(layout, threadId);
      if (action.targetCaseId === null) {
        return {
          ...next,
          manual: {
            ...next.manual,
            looseThreadIds: insertBefore(next.manual.looseThreadIds, threadId, action.beforeThreadId),
          },
        };
      }
      return updateSections(next, (sections) => sections.map((section) => ({
        ...section,
        cases: section.cases.map((homeCase) => homeCase.id === action.targetCaseId
          ? { ...homeCase, threadIds: insertBefore(homeCase.threadIds, threadId, action.beforeThreadId) }
          : homeCase),
      })));
    }
    case "set-automatic-order":
      return { ...layout, automaticOrder: automaticOrder(action.order) };
  }
}

export function automaticStatusForSession(input: {
  readonly status: string;
  readonly nativeStatus?: string | null;
}): AutomaticStatus {
  const native = input.nativeStatus?.toLocaleLowerCase() ?? "";
  if (input.status === "awaiting-approval" || native.includes("approval")) return "needs-approval";
  if (input.status === "error") return "error";
  if (input.status === "working") return "working";
  if (input.status === "awaiting-response") return "waiting";
  if (input.status === "unread" || input.status === "completed") return "completed";
  return "idle";
}

export function automaticStatusLabel(status: AutomaticStatus): string {
  switch (status) {
    case "needs-approval": return "Needs approval";
    case "error": return "Error";
    case "working": return "Working";
    case "waiting": return "Waiting";
    case "completed": return "Completed";
    case "idle": return "Idle";
  }
}
