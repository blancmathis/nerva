import { ProjectIdSchema, ProjectLabelSchema } from "@codex-pad/protocol";
import { createUuidV4 } from "./uuid";

export const COMMAND_LIBRARY_VERSION = 1 as const;

export const COMMAND_LIMITS = {
  commands: 64,
  label: 48,
  prompt: 4_000,
  projectId: 128,
  projectLabel: 120,
  libraryId: 64,
  commandId: 96,
  serializedBytes: 256_000,
} as const;

export const COMMAND_CATEGORIES = [
  "review",
  "capture",
  "responsive",
  "tests",
  "annotations",
  "browser-errors",
  "new-task",
  "reasoning",
] as const;

export type CommandCategory = (typeof COMMAND_CATEGORIES)[number];

export const COMMAND_CATEGORY_LABELS: Readonly<Record<CommandCategory, string>> = {
  review: "Open review",
  capture: "Capture",
  responsive: "Responsive",
  tests: "Tests",
  annotations: "Fix annotations",
  "browser-errors": "Browser errors",
  "new-task": "New task",
  reasoning: "Reasoning",
};

export const COMMAND_GLYPHS = ["⌗", "◉", "⌑", "✓", "✣", "⌁", "+", "∿", "◇", "↗", "◎", "≋"] as const;
export type CommandGlyph = (typeof COMMAND_GLYPHS)[number];

export type CommandScope =
  | { readonly kind: "global" }
  | {
      readonly kind: "project";
      readonly projectId: string;
      readonly projectLabel: string;
    };

export interface LibraryCommand {
  readonly id: string;
  readonly label: string;
  readonly glyph: CommandGlyph;
  readonly category: CommandCategory;
  readonly scope: CommandScope;
  readonly prompt: string;
}

export interface CommandLibraryConfig {
  readonly version: typeof COMMAND_LIBRARY_VERSION;
  readonly libraryId: string;
  readonly commands: readonly LibraryCommand[];
}

export interface ProjectScopeContext {
  readonly id: string;
  readonly label: string;
}

export interface ProjectSessionContext {
  readonly threadId: string;
  readonly selected: boolean;
  readonly projectId: string | null;
  readonly projectLabel: string | null;
}

export interface CommandTarget {
  readonly threadId: string;
  readonly title: string;
}

/**
 * The only executable output of the command library. It deliberately has no
 * URL, shell, script, or evaluation field. `commandId` is a one-shot transport
 * idempotency key; `libraryCommandId` is the stable editable template id.
 */
export interface CommandRunRequest {
  readonly commandId: string;
  readonly targetThreadId: string;
  readonly libraryId: string;
  readonly libraryCommandId: string;
  readonly prompt: string;
}

export class CommandLibraryValidationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(issues.join(" "));
    this.name = "CommandLibraryValidationError";
    this.issues = issues;
  }
}

const ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{2,95}$/i;
const LIBRARY_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{2,63}$/i;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

// These patterns reject values that look like credentials, not benign phrases
// such as "check the API key field". Prompts remain local but are not a vault.
const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\bsk-(?:proj-)?[a-z0-9_-]{20,}\b/i,
  /\b(?:ghp|gho|ghu|ghs|github_pat)_[a-z0-9_]{20,}\b/i,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b(?:api[_ -]?key|password|passwd|secret|access[_ -]?token)\s*[:=]\s*["']?[a-z0-9_./+=-]{12,}/i,
  /\bBearer\s+[a-z0-9._~+/=-]{20,}\b/i,
];

const CATEGORY_SET = new Set<string>(COMMAND_CATEGORIES);
const GLYPH_SET = new Set<string>(COMMAND_GLYPHS);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(record: Record<string, unknown>, allowed: readonly string[], path: string, issues: string[]): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(record)) {
    if (!allowedSet.has(key)) issues.push(`${path} contains unsupported field “${key}”.`);
  }
}

function readBoundedString(
  value: unknown,
  field: string,
  maxLength: number,
  issues: string[],
  options: { readonly allowNewlines?: boolean; readonly id?: boolean } = {},
): string {
  if (typeof value !== "string") {
    issues.push(`${field} must be text.`);
    return "";
  }
  const text = value.trim();
  if (text.length === 0) issues.push(`${field} cannot be empty.`);
  if (text.length > maxLength) issues.push(`${field} is limited to ${maxLength} characters.`);
  if (CONTROL_CHARACTER_PATTERN.test(text) || (!options.allowNewlines && /[\r\n]/.test(text))) {
    issues.push(`${field} contains unsupported control characters.`);
  }
  if (options.id && !ID_PATTERN.test(text)) issues.push(`${field} has an invalid identifier format.`);
  return text;
}

function parseScope(value: unknown, path: string, issues: string[]): CommandScope {
  if (!isRecord(value)) {
    issues.push(`${path} must be an object.`);
    return { kind: "global" };
  }
  if (value.kind === "global") {
    assertExactKeys(value, ["kind"], path, issues);
    return { kind: "global" };
  }
  if (value.kind === "project") {
    assertExactKeys(value, ["kind", "projectId", "projectLabel"], path, issues);
    const projectId = readBoundedString(value.projectId, `${path}.projectId`, COMMAND_LIMITS.projectId, issues);
    const projectLabel = readBoundedString(value.projectLabel, `${path}.projectLabel`, COMMAND_LIMITS.projectLabel, issues);
    if (!ProjectIdSchema.safeParse(projectId).success) {
      issues.push(`${path}.projectId must be a stable opaque project identifier.`);
    }
    if (!ProjectLabelSchema.safeParse(projectLabel).success) {
      issues.push(`${path}.projectLabel must be a display label, not a path.`);
    }
    return {
      kind: "project",
      projectId,
      projectLabel,
    };
  }
  issues.push(`${path}.kind must be “global” or “project”.`);
  return { kind: "global" };
}

function parseCommand(value: unknown, index: number, issues: string[]): LibraryCommand {
  const path = `commands[${index}]`;
  if (!isRecord(value)) {
    issues.push(`${path} must be an object.`);
    return {
      id: `invalid.${index}`,
      label: "Invalid command",
      glyph: "◇",
      category: "review",
      scope: { kind: "global" },
      prompt: "Invalid command",
    };
  }
  assertExactKeys(value, ["id", "label", "glyph", "category", "scope", "prompt"], path, issues);
  const id = readBoundedString(value.id, `${path}.id`, COMMAND_LIMITS.commandId, issues, { id: true });
  const label = readBoundedString(value.label, `${path}.label`, COMMAND_LIMITS.label, issues);
  const prompt = readBoundedString(value.prompt, `${path}.prompt`, COMMAND_LIMITS.prompt, issues, { allowNewlines: true });
  const category = typeof value.category === "string" && CATEGORY_SET.has(value.category)
    ? (value.category as CommandCategory)
    : "review";
  if (category === "review" && value.category !== "review") issues.push(`${path}.category is unsupported.`);
  const glyph = typeof value.glyph === "string" && GLYPH_SET.has(value.glyph)
    ? (value.glyph as CommandGlyph)
    : "◇";
  if (glyph === "◇" && value.glyph !== "◇") issues.push(`${path}.glyph is unsupported.`);
  if (SECRET_PATTERNS.some((pattern) => pattern.test(prompt))) {
    issues.push(`${path}.prompt looks like it contains a secret. Store instructions here, never credentials.`);
  }
  return { id, label, glyph, category, scope: parseScope(value.scope, `${path}.scope`, issues), prompt };
}

export function parseCommandLibrary(input: unknown): CommandLibraryConfig {
  const issues: string[] = [];
  let value = input;
  if (typeof input === "string") {
    if (new TextEncoder().encode(input).byteLength > COMMAND_LIMITS.serializedBytes) {
      throw new CommandLibraryValidationError([`Import is limited to ${COMMAND_LIMITS.serializedBytes} bytes.`]);
    }
    try {
      value = JSON.parse(input) as unknown;
    } catch {
      throw new CommandLibraryValidationError(["Import is not valid JSON."]);
    }
  }
  if (!isRecord(value)) throw new CommandLibraryValidationError(["Command library must be an object."]);
  assertExactKeys(value, ["version", "libraryId", "commands"], "library", issues);
  if (value.version !== COMMAND_LIBRARY_VERSION) {
    issues.push(`library.version must be ${COMMAND_LIBRARY_VERSION}.`);
  }
  const libraryId = readBoundedString(value.libraryId, "library.libraryId", COMMAND_LIMITS.libraryId, issues, { id: true });
  if (libraryId && !LIBRARY_ID_PATTERN.test(libraryId)) {
    issues.push("library.libraryId may contain only letters, numbers, underscore, and hyphen.");
  }
  if (!Array.isArray(value.commands)) {
    issues.push("library.commands must be an array.");
  }
  const sourceCommands = Array.isArray(value.commands) ? value.commands : [];
  if (sourceCommands.length > COMMAND_LIMITS.commands) {
    issues.push(`A library can contain at most ${COMMAND_LIMITS.commands} commands.`);
  }
  const commands = sourceCommands.slice(0, COMMAND_LIMITS.commands).map((command, index) => parseCommand(command, index, issues));
  const ids = new Set<string>();
  for (const command of commands) {
    if (ids.has(command.id)) issues.push(`Command id “${command.id}” is duplicated.`);
    ids.add(command.id);
  }
  if (issues.length > 0) throw new CommandLibraryValidationError(issues);
  return { version: COMMAND_LIBRARY_VERSION, libraryId, commands };
}

export function serializeCommandLibrary(library: CommandLibraryConfig): string {
  return JSON.stringify(parseCommandLibrary(library), null, 2);
}

const TEMPLATE_DEFINITIONS: readonly Omit<LibraryCommand, "scope">[] = [
  {
    id: "template.open-review.v1",
    label: "Open site review",
    glyph: "⌗",
    category: "review",
    prompt: "Open the site associated with this exact task for an interactive review. Identify the active local or preview URL, preserve the task context, and wait for my annotated review before changing code.",
  },
  {
    id: "template.capture-state.v1",
    label: "Capture current state",
    glyph: "◉",
    category: "capture",
    prompt: "Capture the current rendered state associated with this task, including the active viewport and enough context to compare it with the next iteration. Report what was actually captured.",
  },
  {
    id: "template.check-responsive.v1",
    label: "Check responsive",
    glyph: "⌑",
    category: "responsive",
    prompt: "Check the current user-facing surface at representative phone, tablet, and desktop widths. Reproduce concrete layout failures first, then make only the scoped fixes and verify the rendered result.",
  },
  {
    id: "template.run-tests.v1",
    label: "Run nearest tests",
    glyph: "✓",
    category: "tests",
    prompt: "Run the smallest reliable tests for the current task. Fix only failures caused by the scoped work, then report the exact checks and distinguish local proof from CI or live proof.",
  },
  {
    id: "template.fix-annotations.v1",
    label: "Apply annotations",
    glyph: "✣",
    category: "annotations",
    prompt: "Use the attached review frames and annotations as the visual specification. Resolve each marked issue, preserve unrelated behavior, and verify the affected views after the changes.",
  },
  {
    id: "template.browser-errors.v1",
    label: "Inspect browser errors",
    glyph: "⌁",
    category: "browser-errors",
    prompt: "Inspect the browser console and failed network activity for the surface associated with this task. Reproduce the relevant failure, identify the evidence-backed root cause, and report it before changing code.",
  },
  {
    id: "template.new-task.v1",
    label: "Create focused task",
    glyph: "+",
    category: "new-task",
    prompt: "Create a fresh, focused task from the current context. Carry over only the evidence and constraints needed for that task, state its completion bar, and do not broaden the original scope.",
  },
  {
    id: "template.reasoning.v1",
    label: "Reason more deeply",
    glyph: "∿",
    category: "reasoning",
    prompt: "Re-evaluate the current problem with deeper reasoning. List the key evidence, challenge the leading assumption, compare the safest viable approaches, and continue with the best-supported path.",
  },
];

export const BUILT_IN_COMMAND_TEMPLATES: readonly LibraryCommand[] = TEMPLATE_DEFINITIONS.map((command) => ({
  ...command,
  scope: { kind: "global" },
}));

export function createDefaultCommandLibrary(libraryId = "library_local_v1"): CommandLibraryConfig {
  return parseCommandLibrary({
    version: COMMAND_LIBRARY_VERSION,
    libraryId,
    commands: BUILT_IN_COMMAND_TEMPLATES,
  });
}

export function isValidThreadTarget(threadId: string | null | undefined): threadId is string {
  return typeof threadId === "string" && UUID_PATTERN.test(threadId);
}

export function visibleCommands(
  library: CommandLibraryConfig,
  projectId: string | null | undefined,
  query = "",
  category: CommandCategory | "all" = "all",
): readonly LibraryCommand[] {
  const needle = query.trim().toLocaleLowerCase();
  return library.commands.filter((command) => {
    const inScope = command.scope.kind === "global" || command.scope.projectId === projectId;
    const inCategory = category === "all" || command.category === category;
    const matchesQuery = needle.length === 0
      || command.label.toLocaleLowerCase().includes(needle)
      || COMMAND_CATEGORY_LABELS[command.category].toLocaleLowerCase().includes(needle);
    return inScope && inCategory && matchesQuery;
  });
}

/**
 * Resolves display context from the exact native selection when available,
 * otherwise from the sanitized all-session selection. No cwd is accepted.
 */
export function projectScopeForSelection(
  sessions: readonly ProjectSessionContext[],
  selectedThreadId: string | null | undefined,
): ProjectScopeContext | null {
  const session = selectedThreadId
    ? sessions.find((candidate) => candidate.threadId === selectedThreadId)
    : sessions.find((candidate) => candidate.selected);
  if (!session?.projectId || !session.projectLabel) return null;
  const label = session.projectLabel.trim();
  if (
    !ProjectIdSchema.safeParse(session.projectId).success
    || !ProjectLabelSchema.safeParse(label).success
  ) return null;
  return { id: session.projectId, label };
}

export function createCommandId(
  existingIds: ReadonlySet<string>,
  randomUuid: () => string = createUuidV4,
): string {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const base = `command.${randomUuid().toLowerCase()}`;
    const candidate = attempt === 0 ? base : `${base}.${attempt + 1}`;
    if (!existingIds.has(candidate)) return candidate;
  }
  // A monotonic suffix makes a mocked or broken UUID source collision-safe.
  const base = `command.${randomUuid().toLowerCase()}`;
  let suffix = existingIds.size + 1;
  while (existingIds.has(`${base}.${suffix}`)) suffix += 1;
  return `${base}.${suffix}`;
}

export function upsertCommand(library: CommandLibraryConfig, command: LibraryCommand): CommandLibraryConfig {
  const index = library.commands.findIndex((candidate) => candidate.id === command.id);
  const next = [...library.commands];
  if (index >= 0) next[index] = command;
  else next.push(command);
  return parseCommandLibrary({ ...library, commands: next });
}

export function deleteCommand(library: CommandLibraryConfig, commandId: string): CommandLibraryConfig {
  return parseCommandLibrary({ ...library, commands: library.commands.filter((command) => command.id !== commandId) });
}

export function reorderCommand(library: CommandLibraryConfig, commandId: string, direction: -1 | 1): CommandLibraryConfig {
  const index = library.commands.findIndex((command) => command.id === commandId);
  const destination = index + direction;
  if (index < 0 || destination < 0 || destination >= library.commands.length) return library;
  const commands = [...library.commands];
  const moving = commands[index];
  const displaced = commands[destination];
  if (!moving || !displaced) return library;
  commands[index] = displaced;
  commands[destination] = moving;
  return parseCommandLibrary({ ...library, commands });
}

export function createCommandRunRequest(
  library: CommandLibraryConfig,
  command: LibraryCommand,
  targetThreadId: string,
  randomUuid: () => string = createUuidV4,
): CommandRunRequest {
  if (!isValidThreadTarget(targetThreadId)) {
    throw new CommandLibraryValidationError(["The selected target is not an exact Codex thread id."]);
  }
  const authoritative = library.commands.find((candidate) => candidate.id === command.id);
  if (!authoritative || authoritative.prompt !== command.prompt) {
    throw new CommandLibraryValidationError(["The selected command is no longer present in this library."]);
  }
  return {
    commandId: randomUuid(),
    targetThreadId,
    libraryId: library.libraryId,
    libraryCommandId: authoritative.id,
    prompt: authoritative.prompt,
  };
}
