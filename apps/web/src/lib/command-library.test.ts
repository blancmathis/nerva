import { describe, expect, it } from "vitest";
import {
  BUILT_IN_COMMAND_TEMPLATES,
  COMMAND_CATEGORIES,
  CommandLibraryValidationError,
  createCommandId,
  createCommandRunRequest,
  createDefaultCommandLibrary,
  parseCommandLibrary,
  projectScopeForSelection,
  serializeCommandLibrary,
  visibleCommands,
  type CommandLibraryConfig,
  type LibraryCommand,
} from "./command-library";

const THREAD_ID = "019f7ec2-68eb-7183-bb3a-0e67312a8ba1";

function libraryWith(commands: readonly LibraryCommand[]): CommandLibraryConfig {
  return parseCommandLibrary({ version: 1, libraryId: "library_test_v1", commands });
}

describe("command library validation", () => {
  it("ships one editable template for every requested category", () => {
    expect(new Set(BUILT_IN_COMMAND_TEMPLATES.map((command) => command.category))).toEqual(new Set(COMMAND_CATEGORIES));
    expect(BUILT_IN_COMMAND_TEMPLATES.every((command) => command.scope.kind === "global")).toBe(true);
  });

  it("round-trips only its versioned, known JSON shape", () => {
    const library = createDefaultCommandLibrary();
    expect(parseCommandLibrary(serializeCommandLibrary(library))).toEqual(library);
    expect(() => parseCommandLibrary({
      ...library,
      commands: [{ ...library.commands[0], shell: "rm -rf /" }],
    })).toThrow(CommandLibraryValidationError);
  });

  it("rejects duplicate ids and credential-like prompt values", () => {
    const command = BUILT_IN_COMMAND_TEMPLATES[0];
    expect(command).toBeDefined();
    expect(() => libraryWith([command!, command!])).toThrow(/duplicated/i);
    expect(() => libraryWith([{ ...command!, prompt: "api_key=abcdefghijklmnopqrstuvwxyz123456" }])).toThrow(/secret/i);
  });
});

describe("command scope and identity", () => {
  const globalCommand: LibraryCommand = { ...BUILT_IN_COMMAND_TEMPLATES[0]!, id: "command.global.v1" };
  const projectCommand: LibraryCommand = {
    ...BUILT_IN_COMMAND_TEMPLATES[1]!,
    id: "command.project.alpha.v1",
    scope: { kind: "project", projectId: "project:2s0Pz0PBpeLguK5w-d_3b0a_sA4KbOC5OyKV_pKml2I", projectLabel: "Alpha" },
  };
  const otherProjectCommand: LibraryCommand = {
    ...BUILT_IN_COMMAND_TEMPLATES[2]!,
    id: "command.project.beta.v1",
    scope: { kind: "project", projectId: "project:CTW3aFtA0PLAfVg9FMSzjZ6jsVRSm9_1ABm0ZZJxPdE", projectLabel: "Beta" },
  };
  const library = libraryWith([globalCommand, projectCommand, otherProjectCommand]);

  it("shows global commands plus only the active project's commands", () => {
    expect(visibleCommands(library, projectCommand.scope.kind === "project" ? projectCommand.scope.projectId : null).map((command) => command.id)).toEqual([
      "command.global.v1",
      "command.project.alpha.v1",
    ]);
    expect(visibleCommands(library, null).map((command) => command.id)).toEqual(["command.global.v1"]);
  });

  it("rejects path-like project identities and labels in imported libraries", () => {
    expect(() => libraryWith([{ ...projectCommand, scope: {
      kind: "project",
      projectId: "/workspace/private-project",
      projectLabel: "Alpha",
    } }])).toThrow(/opaque project identifier/i);
    expect(() => libraryWith([{ ...projectCommand, scope: {
      kind: "project",
      projectId: "project:2s0Pz0PBpeLguK5w-d_3b0a_sA4KbOC5OyKV_pKml2I",
      projectLabel: "/workspace/private-project",
    } }])).toThrow(/display label, not a path/i);
  });

  it("resolves an opaque project from the exact native selection or sanitized all-session selection", () => {
    const projectId = "project:2s0Pz0PBpeLguK5w-d_3b0a_sA4KbOC5OyKV_pKml2I";
    const sessions = [
      { threadId: THREAD_ID, selected: true, projectId, projectLabel: "Codex Pad" },
      { threadId: "019f7ec2-68eb-7183-bb3a-0e67312a8ba2", selected: false, projectId: null, projectLabel: null },
    ];
    expect(projectScopeForSelection(sessions, THREAD_ID)).toEqual({ id: projectId, label: "Codex Pad" });
    expect(projectScopeForSelection(sessions, null)).toEqual({ id: projectId, label: "Codex Pad" });
    expect(projectScopeForSelection(sessions, sessions[1]!.threadId)).toBeNull();
    expect(projectScopeForSelection([{ ...sessions[0]!, projectId: "/private/codex-pad" }], THREAD_ID)).toBeNull();
  });

  it("keeps library command ids stable and collision-safe", () => {
    const existing = new Set(["command.00000000-0000-4000-8000-000000000001"]);
    expect(createCommandId(existing, () => "00000000-0000-4000-8000-000000000001"))
      .toBe("command.00000000-0000-4000-8000-000000000001.2");
    expect(parseCommandLibrary(library).commands[1]?.id).toBe("command.project.alpha.v1");
  });

  it("creates an idempotent typed request with no executable field", () => {
    const command = library.commands[0]!;
    const fixedId = () => "11111111-1111-4111-8111-111111111111";
    const first = createCommandRunRequest(library, command, THREAD_ID, fixedId);
    const second = createCommandRunRequest(library, command, THREAD_ID, fixedId);
    expect(second).toEqual(first);
    expect(first).toEqual({
      commandId: "11111111-1111-4111-8111-111111111111",
      targetThreadId: THREAD_ID,
      libraryId: "library_test_v1",
      libraryCommandId: "command.global.v1",
      prompt: command.prompt,
    });
    expect(Object.keys(first)).not.toEqual(expect.arrayContaining(["shell", "url", "eval"]));
  });

  it("fails closed for an inexact target", () => {
    expect(() => createCommandRunRequest(library, library.commands[0]!, "thread-latest"))
      .toThrow(/exact Codex thread id/i);
  });
});
