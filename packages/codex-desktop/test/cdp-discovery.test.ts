import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  discoverCodexCdpTarget,
  discoverCodexCdpTargets,
  defaultDevToolsActivePortFiles,
  isLoopbackUrl,
  parseLoopbackProcessArgument,
  selectCodexRendererTarget,
  type CdpTarget
} from "../src/index.js";

const DESKTOP_IDENTITY = {
  pid: 4242,
  startedAt: "Sun Jul 20 12:34:56 2026",
  appPath: "/Applications/ChatGPT.app",
  executablePath: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
  bundleId: "com.openai.chatgpt",
} as const;
const DESKTOP_COMMAND = `${DESKTOP_IDENTITY.executablePath} --remote-debugging-address=127.0.0.1 --remote-debugging-port=43123`;
const DESKTOP_PROCESS_ROW = `${DESKTOP_IDENTITY.pid} ${DESKTOP_IDENTITY.startedAt} ${DESKTOP_COMMAND}`;
const DESKTOP_GENERATION = `${DESKTOP_IDENTITY.pid} 1 ${DESKTOP_IDENTITY.startedAt} ${DESKTOP_IDENTITY.executablePath}`;
const HELPER_PID = 4343;
const HELPER_STARTED_AT = "Sun Jul 20 12:35:01 2026";
const HELPER_EXECUTABLE = "/Applications/ChatGPT.app/Contents/Frameworks/ChatGPT Helper.app/Contents/MacOS/ChatGPT Helper";
const HELPER_GENERATION = `${HELPER_PID} ${DESKTOP_IDENTITY.pid} ${HELPER_STARTED_AT} ${HELPER_EXECUTABLE}`;

function listenerOutput(pid: number, port: number): string {
  return `p${pid}\nf17\nn127.0.0.1:${port}\n`;
}

function createAttestedExec(options: {
  readonly command?: string;
  readonly listenerPids?: readonly number[];
  readonly generations?: Readonly<Record<number, string>>;
} = {}) {
  const calls: Array<{ file: string; args: readonly string[] }> = [];
  let listenerRead = 0;
  const listenerPids = options.listenerPids ?? [DESKTOP_IDENTITY.pid];
  const generations = options.generations ?? { [DESKTOP_IDENTITY.pid]: DESKTOP_GENERATION };
  return {
    calls,
    execFile: async (file: string, args: readonly string[]): Promise<string> => {
      calls.push({ file, args: [...args] });
      if (file === "/bin/ps" && args[3] === "pid=,lstart=,command=") {
        return options.command ?? DESKTOP_PROCESS_ROW;
      }
      if (file === "/usr/sbin/lsof") {
        const port = Number(args[2]?.replace("-iTCP:", ""));
        const pid = listenerPids[Math.min(listenerRead, listenerPids.length - 1)];
        listenerRead += 1;
        if (pid === undefined) throw new Error("No listener fixture");
        return listenerOutput(pid, port);
      }
      if (file === "/bin/ps" && args[3] === "pid=,ppid=,lstart=,comm=") {
        const pid = Number(args[1]);
        const generation = generations[pid];
        if (generation === undefined) throw new Error(`No generation fixture for ${pid}`);
        return generation;
      }
      throw new Error(`Unexpected command: ${file} ${args.join(" ")}`);
    },
  };
}

async function targets(): Promise<CdpTarget[]> {
  return JSON.parse(await readFile(new URL("./fixtures/targets.json", import.meta.url), "utf8")) as CdpTarget[];
}

describe("loopback-only CDP discovery", () => {
  it("fails closed when no explicit candidate exists", async () => {
    await expect(discoverCodexCdpTarget({ processArgs: [], inspectMacProcesses: false })).rejects.toMatchObject({ code: "cdp-unavailable" });
  });

  it("accepts only Codex process arguments explicitly bound to loopback", () => {
    expect(parseLoopbackProcessArgument("/Applications/ChatGPT.app/Contents/MacOS/ChatGPT --remote-debugging-address=127.0.0.1 --remote-debugging-port=43123")).toBe(43123);
    expect(parseLoopbackProcessArgument("/Applications/ChatGPT.app/Contents/MacOS/ChatGPT --remote-debugging-address=0.0.0.0 --remote-debugging-port=43123")).toBeNull();
    expect(parseLoopbackProcessArgument("other --remote-debugging-address=127.0.0.1 --remote-debugging-port=43123")).toBeNull();
    expect(isLoopbackUrl("ws://192.168.1.5:43123/devtools/page/1", ["ws:"])).toBe(false);
  });

  it("chooses the main renderer deterministically and rejects remote websocket targets", async () => {
    const selected = selectCodexRendererTarget(await targets());
    expect(selected?.id).toBe("a-main");
    expect(selected?.webSocketDebuggerUrl).toMatch(/^ws:\/\/127\.0\.0\.1/);
  });

  it("rejects two equally best-ranked main renderers instead of choosing one by id", async () => {
    const main = (await targets()).find((target) => target.id === "a-main");
    expect(main).toBeDefined();
    expect(selectCodexRendererTarget([
      main!,
      { ...main!, id: "second-main", webSocketDebuggerUrl: "ws://127.0.0.1:43123/devtools/page/second-main" },
    ])).toBeUndefined();
  });

  it("rejects an unknown app-internal page when the documented main surface is absent", () => {
    expect(selectCodexRendererTarget([{
      id: "unknown-internal-page",
      type: "page",
      title: "Codex",
      url: "app://-/workspace-shell.html",
      webSocketDebuggerUrl: "ws://127.0.0.1:43123/devtools/page/unknown-internal-page",
    }])).toBeUndefined();
  });

  it("probes only the explicit loopback port", async () => {
    const requested: string[] = [];
    const found = await discoverCodexCdpTarget({
      explicitPort: 43123,
      processArgs: [],
      fetch: async (input) => {
        requested.push(String(input));
        return new Response(JSON.stringify(await targets()), { status: 200, headers: { "content-type": "application/json" } });
      }
    });
    expect(requested).toEqual(["http://127.0.0.1:43123/json/list"]);
    expect(found.target.id).toBe("a-main");
  });

  it("resolves an OS-assigned random port from the default current-user files", async () => {
    const readPaths: string[] = [];
    const randomPort = 54_321;
    const found = await discoverCodexCdpTarget({
      processArgs: [],
      readFile: async (path) => {
        readPaths.push(path);
        if (path.endsWith("/Codex/DevToolsActivePort")) return `${randomPort}\n/devtools/browser/test`;
        throw new Error("not present");
      },
      fetch: async (input) => {
        expect(String(input)).toBe(`http://127.0.0.1:${randomPort}/json/list`);
        return new Response(JSON.stringify((await targets()).map((target) => ({
          ...target,
          webSocketDebuggerUrl: target.webSocketDebuggerUrl?.replace(":43123/", `:${randomPort}/`),
        }))), { status: 200 });
      }
    });
    expect(found.candidate).toEqual({ port: randomPort, source: "devtools-active-port" });
    expect(readPaths).toEqual(defaultDevToolsActivePortFiles("darwin"));
  });

  it("rejects a random-port endpoint that advertises only a non-loopback renderer", async () => {
    await expect(discoverCodexCdpTarget({
      processArgs: [],
      readFile: async (path) => {
        if (path.endsWith("/Codex/DevToolsActivePort")) return "54322\n/devtools/browser/test";
        throw new Error("not present");
      },
      fetch: async () => new Response(JSON.stringify([{
        id: "remote-only",
        type: "page",
        title: "Codex",
        url: "app://-/index.html",
        webSocketDebuggerUrl: "ws://192.168.1.50:54322/devtools/page/remote"
      }]), { status: 200 })
    })).rejects.toMatchObject({ code: "target-not-found" });
  });

  it("ignores every alternate endpoint and binds discovery to the attested Desktop process", async () => {
    const requested: string[] = [];
    const readPaths: string[] = [];
    const process = createAttestedExec();
    const found = await discoverCodexCdpTarget({
      expectedDesktopIdentity: DESKTOP_IDENTITY,
      explicitPort: 43122,
      processArgs: [
        "/Applications/Codex.app/Contents/MacOS/Codex --remote-debugging-address=127.0.0.1 --remote-debugging-port=43122",
      ],
      devToolsActivePortFiles: ["/tmp/stale-other-app/DevToolsActivePort"],
      readFile: async (path) => {
        readPaths.push(path);
        return "43122\n/devtools/browser/stale";
      },
      execFile: process.execFile,
      fetch: async (input) => {
        requested.push(String(input));
        return new Response(JSON.stringify(await targets()), { status: 200 });
      },
    });
    expect(found.candidate).toEqual({ port: 43123, source: "attested-process" });
    expect(found.desktopIdentity).toEqual(DESKTOP_IDENTITY);
    expect(requested).toEqual(["http://127.0.0.1:43123/json/list"]);
    expect(readPaths).toEqual([]);
    expect(process.calls.filter(({ file }) => file === "/usr/sbin/lsof")).toHaveLength(2);
  });

  it("returns browser pages only from the same ownership-attested listener inventory", async () => {
    const process = createAttestedExec();
    const inventory = await discoverCodexCdpTargets({
      expectedDesktopIdentity: DESKTOP_IDENTITY,
      execFile: process.execFile,
      fetch: async () => new Response(JSON.stringify([
        ...(await targets()),
        {
          id: "browser-page",
          type: "page",
          title: "Local preview",
          url: "http://127.0.0.1:3000/dashboard?token=private",
          webSocketDebuggerUrl: "ws://127.0.0.1:43123/devtools/page/browser-page",
        },
        {
          id: "foreign-page",
          type: "page",
          title: "Foreign",
          url: "https://example.test",
          webSocketDebuggerUrl: "ws://127.0.0.1:43124/devtools/page/foreign-page",
        },
      ]), { status: 200 }),
    });
    expect(inventory.desktopIdentity).toEqual(DESKTOP_IDENTITY);
    expect(inventory.targets.map((target) => target.id)).toContain("browser-page");
    expect(inventory.targets.map((target) => target.id)).not.toContain("foreign-page");
    expect(process.calls.filter(({ file }) => file === "/usr/sbin/lsof")).toHaveLength(2);
  });

  it("rejects another Desktop generation occupying the attested process argv port", async () => {
    const otherPid = 5252;
    const process = createAttestedExec({
      listenerPids: [otherPid],
      generations: {
        [otherPid]: `${otherPid} 1 Sun Jul 20 12:36:01 2026 ${DESKTOP_IDENTITY.executablePath}`,
      },
    });
    const requested: string[] = [];
    await expect(discoverCodexCdpTarget({
      expectedDesktopIdentity: DESKTOP_IDENTITY,
      execFile: process.execFile,
      fetch: async (input) => {
        requested.push(String(input));
        return new Response(JSON.stringify(await targets()), { status: 200 });
      },
    })).rejects.toMatchObject({ code: "cdp-unavailable" });
    expect(requested).toEqual([]);
  });

  it("rejects a listener generation that changes during the renderer fetch", async () => {
    const process = createAttestedExec({
      listenerPids: [DESKTOP_IDENTITY.pid, HELPER_PID],
      generations: {
        [DESKTOP_IDENTITY.pid]: DESKTOP_GENERATION,
        [HELPER_PID]: HELPER_GENERATION,
      },
    });
    let requested = 0;
    await expect(discoverCodexCdpTarget({
      expectedDesktopIdentity: DESKTOP_IDENTITY,
      execFile: process.execFile,
      fetch: async () => {
        requested += 1;
        return new Response(JSON.stringify(await targets()), { status: 200 });
      },
    })).rejects.toMatchObject({ code: "target-not-found" });
    expect(requested).toBe(1);
  });

  it("accepts a stable listener descendant generation inside the attested app", async () => {
    const process = createAttestedExec({
      listenerPids: [HELPER_PID],
      generations: {
        [DESKTOP_IDENTITY.pid]: DESKTOP_GENERATION,
        [HELPER_PID]: HELPER_GENERATION,
      },
    });
    const found = await discoverCodexCdpTarget({
      expectedDesktopIdentity: DESKTOP_IDENTITY,
      execFile: process.execFile,
      fetch: async () => new Response(JSON.stringify(await targets()), { status: 200 }),
    });
    expect(found.desktopIdentity).toEqual(DESKTOP_IDENTITY);
    expect(process.calls.filter(({ file, args }) => (
      file === "/bin/ps" && args[1] === String(HELPER_PID)
    ))).toHaveLength(2);
  });

  it("fails closed for a stale attested PID generation without probing alternate candidates", async () => {
    const requested: string[] = [];
    await expect(discoverCodexCdpTarget({
      expectedDesktopIdentity: DESKTOP_IDENTITY,
      explicitPort: 43123,
      processArgs: [
        "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT --remote-debugging-address=127.0.0.1 --remote-debugging-port=43123",
      ],
      execFile: async () => (
        "4242 Sun Jul 20 12:35:57 2026 /Applications/ChatGPT.app/Contents/MacOS/ChatGPT --remote-debugging-address=127.0.0.1 --remote-debugging-port=43123"
      ),
      fetch: async (input) => {
        requested.push(String(input));
        return new Response(JSON.stringify(await targets()), { status: 200 });
      },
    })).rejects.toMatchObject({ code: "cdp-unavailable" });
    expect(requested).toEqual([]);
  });

  it("reads a random port only from the exact attested process profile", async () => {
    const readPaths: string[] = [];
    const process = createAttestedExec({
      command: "4242 Sun Jul 20 12:34:56 2026 /Applications/ChatGPT.app/Contents/MacOS/ChatGPT --remote-debugging-address=::1 --remote-debugging-port=0 --user-data-dir=/private/tmp/chatgpt-4242",
    });
    const found = await discoverCodexCdpTarget({
      expectedDesktopIdentity: DESKTOP_IDENTITY,
      execFile: process.execFile,
      readFile: async (path) => {
        readPaths.push(path);
        return "43123\n/devtools/browser/exact";
      },
      fetch: async () => new Response(JSON.stringify(await targets()), { status: 200 }),
    });
    expect(found.candidate.source).toBe("attested-process-profile");
    expect(readPaths).toEqual(["/private/tmp/chatgpt-4242/DevToolsActivePort"]);
  });

  it("rejects another Desktop generation occupying the attested profile port", async () => {
    const otherPid = 5252;
    const process = createAttestedExec({
      command: "4242 Sun Jul 20 12:34:56 2026 /Applications/ChatGPT.app/Contents/MacOS/ChatGPT --remote-debugging-address=127.0.0.1 --remote-debugging-port=0 --user-data-dir=/private/tmp/chatgpt-4242",
      listenerPids: [otherPid],
      generations: {
        [otherPid]: `${otherPid} 1 Sun Jul 20 12:36:01 2026 ${DESKTOP_IDENTITY.executablePath}`,
      },
    });
    let requested = 0;
    await expect(discoverCodexCdpTarget({
      expectedDesktopIdentity: DESKTOP_IDENTITY,
      execFile: process.execFile,
      readFile: async () => "43123\n/devtools/browser/exact",
      fetch: async () => {
        requested += 1;
        return new Response(JSON.stringify(await targets()), { status: 200 });
      },
    })).rejects.toMatchObject({ code: "cdp-unavailable" });
    expect(requested).toBe(0);
  });
});
