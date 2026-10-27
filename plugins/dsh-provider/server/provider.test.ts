import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  PROVIDER_CAPABILITIES,
  ProviderEventSchema,
  type ProviderConnection,
  type ProviderContent,
  type ProviderEvent,
  type ProviderInput,
  type ProviderLaunch,
  type ProviderPersistence,
  type ProviderTimelineItem,
} from "@getpaseo/plugin/server/provider";
import { createDshProvider } from "./provider.js";

const fake = fileURLToPath(new URL("../test/dsh.mjs", import.meta.url));
const provider = createDshProvider();
const temporary: string[] = [];
const connections: ProviderConnection[] = [];

/** Reads the file path that follows `--patch` in a recorded spawn argv. */
function patchPathFrom(argv: string[]): string {
  const index = argv.indexOf("--patch");
  if (index < 0) throw new Error("Expected --patch in argv");
  const value = argv[index + 1];
  if (value === undefined) throw new Error("Expected a value after --patch");
  return value;
}

afterEach(async () => {
  await Promise.all(connections.splice(0).map((connection) => connection.close()));
  await Promise.all(
    temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

interface HarnessOptions {
  env?: Record<string, string>;
  providerOptions?: Record<string, unknown>;
  systemPrompt?: string;
  model?: string;
  thinkingOption?: string;
}

async function harness(options: HarnessOptions = {}) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "dsh-test-"));
  temporary.push(cwd);
  const log = path.join(cwd, "argv.ndjson");
  const launch: ProviderLaunch = {
    command: process.execPath,
    args: [fake],
    env: { DSH_TEST_LOG: log, ...options.env },
  };
  const connection = await provider.connect({
    versions: [1],
    capabilities: PROVIDER_CAPABILITIES,
    launch,
  });
  connections.push(connection);
  const events: ProviderEvent[] = [];
  connection.onEvent((event) => {
    // Every event the provider emits must satisfy the wire contract.
    ProviderEventSchema.parse(event);
    events.push(event);
  });

  async function wait(predicate: (event: ProviderEvent) => boolean, timeout = 10_000) {
    await expect.poll(() => events.some(predicate), { timeout, interval: 10 }).toBe(true);
    const event = events.find(predicate);
    if (!event) throw new Error("Expected event missing");
    return event;
  }

  async function request(input: ProviderInput) {
    await connection.send(input);
    if ("requestId" in input)
      await wait(
        (event) =>
          "requestId" in event &&
          event.requestId === input.requestId &&
          (event.type === "request.completed" ||
            event.type === "request.failed" ||
            event.type === "session.ready" ||
            event.type === "catalog" ||
            event.type === "session.can_stop_runtime"),
      );
  }

  async function open(restored?: ProviderPersistence, sessionId = "s") {
    await request({
      type: "session.open",
      requestId: `open-${events.length}`,
      sessionId,
      persistence: restored,
      history: "replay",
      config: {
        cwd,
        env: {},
        settings: {},
        mcpServers: {},
        persist: true,
        ...(options.systemPrompt === undefined ? {} : { systemPrompt: options.systemPrompt }),
        ...(options.model === undefined ? {} : { model: options.model }),
        ...(options.thinkingOption === undefined ? {} : { thinkingOption: options.thinkingOption }),
        ...(options.providerOptions === undefined
          ? {}
          : { providerOptions: options.providerOptions }),
      },
    });
  }

  async function prompt(text: string, sessionId = "s") {
    const clientMessageId = `prompt-${events.length}`;
    await connection.send({
      type: "session.prompt",
      sessionId,
      prompt: {
        clientMessageId,
        delivery: "auto",
        input: { type: "message", content: [{ type: "text", text }] },
      },
    });
    await wait(
      (event) =>
        event.type === "session.prompt_result" && event.clientMessageId === clientMessageId,
    );
    return clientMessageId;
  }

  async function message(content: ProviderContent[], sessionId = "s") {
    const clientMessageId = `prompt-${events.length}`;
    await connection.send({
      type: "session.prompt",
      sessionId,
      prompt: {
        clientMessageId,
        delivery: "auto",
        input: { type: "message", content },
      },
    });
    await wait(
      (event) =>
        event.type === "session.prompt_result" && event.clientMessageId === clientMessageId,
    );
    return clientMessageId;
  }

  function promptResult(clientMessageId: string) {
    const result = events.find(
      (event) =>
        event.type === "session.prompt_result" && event.clientMessageId === clientMessageId,
    );
    if (!result || result.type !== "session.prompt_result") throw new Error("Prompt not admitted");
    return result;
  }

  async function settled(clientMessageId: string) {
    const result = promptResult(clientMessageId);
    if (result.result.type !== "turn") throw new Error("Prompt was not admitted as a turn");
    const turnId = result.result.turnId;
    return wait(
      (event) =>
        event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
    );
  }

  async function records() {
    const text = await readFile(log, "utf8").catch(() => "");
    return text
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { argv: string[]; cwd: string; stdin: string });
  }

  /** Spawns that ran a turn; discovery/status probes are filtered out. */
  async function turns() {
    return (await records()).filter(
      (record) => !record.argv.includes("--dump-config") && !record.argv.includes("--version"),
    );
  }

  /** Latest emission per timeline item id — the provider re-emits items as they update. */
  function timeline(type: ProviderTimelineItem["type"]) {
    const byId = new Map<string, ProviderTimelineItem>();
    for (const event of events) {
      if (event.type !== "timeline.item" || event.item.type !== type) continue;
      byId.set(event.item.id, event.item);
    }
    return [...byId.values()];
  }

  /** Latest persistence the provider published (the native id arrives with turn 1). */
  function persistence(): ProviderPersistence {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (!event) continue;
      if (event.type === "session.opened" && event.persistence) return event.persistence;
      if (event.type === "session.persistence") return event.persistence;
    }
    throw new Error("Missing persistence");
  }

  /** Narrows the persisted payload to the native DSH session id. */
  function nativeSessionId() {
    const { data } = persistence();
    if (typeof data !== "object" || data === null || !("sessionId" in data))
      throw new Error("Missing sessionId in persistence");
    const { sessionId } = data;
    if (typeof sessionId !== "string") throw new Error("persistence.sessionId is not a string");
    return sessionId;
  }

  return {
    connection,
    events,
    launch,
    cwd,
    wait,
    request,
    open,
    prompt,
    message,
    promptResult,
    settled,
    records,
    turns,
    timeline,
    persistence,
    nativeSessionId,
  };
}

describe("fixtures", () => {
  const realDirectory = fileURLToPath(new URL("../test/fixtures/real/", import.meta.url));
  const scenarioDirectory = fileURLToPath(new URL("../test/fixtures/scenarios/", import.meta.url));
  const captures = ["out2", "tool", "resume", "model", "int", "int-resume"];
  // The verified `dsh --json` vocabulary; see test/fixtures/PROVENANCE.md.
  const vocabulary: Readonly<Record<string, true>> = {
    session: true,
    status: true,
    thinking: true,
    text: true,
    tool_call: true,
    tool_result: true,
    final: true,
  };

  it("keeps every real capture byte-identical to the provenance hash", async () => {
    const provenance = await readFile(
      fileURLToPath(new URL("../test/fixtures/PROVENANCE.md", import.meta.url)),
      "utf8",
    );
    const rows = [
      // oxfmt pads markdown table cells, so the columns are whitespace-delimited.
      ...provenance.matchAll(
        /^\|\s+`([^`]+\.ndjson)`\s+\|\s+`([0-9a-f]{64})`\s+\|\s+(\d+)\s+\|$/gm,
      ),
    ];
    expect(rows).toHaveLength(captures.length);
    for (const row of rows) {
      const [, file, expected, bytes] = row;
      if (!file || !expected || !bytes) throw new Error("Malformed provenance row");
      const data = await readFile(path.join(realDirectory, file));
      expect(createHash("sha256").update(data).digest("hex")).toBe(expected);
      expect(data.byteLength).toBe(Number(bytes));
    }
  });

  it("keeps every real capture inside the verified event vocabulary", async () => {
    for (const name of captures) {
      const text = await readFile(path.join(realDirectory, `${name}.ndjson`), "utf8");
      const lines = text.split("\n").filter(Boolean);
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        const parsed: unknown = JSON.parse(line);
        if (
          typeof parsed !== "object" ||
          parsed === null ||
          !("type" in parsed) ||
          typeof parsed.type !== "string"
        )
          throw new Error(`${name}.ndjson has a line without an event type`);
        expect(vocabulary[parsed.type]).toBe(true);
      }
      const first: unknown = JSON.parse(lines[0] ?? "{}");
      if (typeof first !== "object" || first === null || !("type" in first))
        throw new Error(`${name}.ndjson has no first event`);
      expect(first.type).toBe("session");
      const last: unknown = JSON.parse(lines.at(-1) ?? "{}");
      if (typeof last !== "object" || last === null || !("type" in last))
        throw new Error(`${name}.ndjson has no last event`);
      expect(last.type).toBe("final");
    }
  });

  it("ships every scenario the suite drives", async () => {
    for (const name of [
      "simple",
      "tool",
      "error",
      "crash",
      "noisy",
      "resume",
      "interrupt",
      "empty-final",
      "malformed",
      "error-event",
      "stale-session",
      "noisy-crash",
    ]) {
      const data = await readFile(path.join(scenarioDirectory, `${name}.ndjson`), "utf8");
      expect(data.trim().length).toBeGreaterThan(0);
    }
  });
});

describe("registration", () => {
  it("declares the dsh provider identity and default executable", () => {
    expect(provider.id).toBe("dsh");
    expect(provider.label).toBe("DSH");
    expect(provider.icon).toBe("icon.svg");
    expect(provider.command?.[0]).toBe("dsh");
    expect(provider.description?.length ?? 0).toBeGreaterThan(0);
  });

  it("reports unavailable without a launch and available against the binary", async () => {
    expect(await provider.status({})).toMatchObject({ available: false });
    const status = await provider.status({
      launch: { command: process.execPath, args: [fake], env: {} },
    });
    expect(status).toMatchObject({ available: true });
  });
});

describe("catalog", () => {
  it("discovers models and reasoning efforts from --dump-config", async () => {
    const h = await harness();
    await h.request({ type: "catalog", requestId: "catalog-1", cwd: h.cwd });
    const event = h.events.find((entry) => entry.type === "catalog");
    if (!event || event.type !== "catalog") throw new Error("Missing catalog");
    const ids = event.catalog.models.map((model) => model.id);
    // Model ids are `<provider>/<model>`: DSH routes by the pair, and the patch row needs both.
    expect(ids).toContain("homelab/deepseek-v4.1-flash");
    expect(ids).toContain("homelab/nemotron-3.5-super-vl");
    const flash = event.catalog.models.find((model) => model.id === "homelab/deepseek-v4.1-flash");
    expect(flash?.label).toBe("DeepSeek-V4.1-Flash 1017");
    expect(flash?.contextWindowMaxTokens).toBe(1048576);
    expect(flash?.thinkingOptions?.map((option) => option.id)).toEqual([
      "off",
      "low",
      "high",
      "xhigh",
      "max",
    ]);
    expect(event.catalog.defaultModel).toBe("homelab/deepseek-v4.1-flash");
    expect(event.catalog.defaultThinkingOption).toBe("max");
    const record = (await h.records())[0];
    expect(record?.argv).toEqual(["--profile", "headless", "--dump-config"]);
  });

  it("falls back to a built-in model list when --dump-config yields nothing", async () => {
    const h = await harness({ env: { DSH_FAKE_DUMP_CONFIG: "empty" } });
    await h.request({ type: "catalog", requestId: "catalog-2", cwd: h.cwd });
    const event = h.events.find((entry) => entry.type === "catalog");
    if (!event || event.type !== "catalog") throw new Error("Missing catalog");
    expect(event.catalog.models.length).toBeGreaterThan(0);
  });

  it("honours the profile provider option for turns", async () => {
    const h = await harness({ providerOptions: { profile: "experimental" } });
    await h.request({ type: "catalog", requestId: "catalog-3", cwd: h.cwd });
    // A catalog request carries no session config, so discovery uses the default profile.
    expect((await h.records())[0]?.argv).toEqual(["--profile", "headless", "--dump-config"]);
    await h.open();
    const clientMessageId = await h.prompt("ping");
    await h.settled(clientMessageId);
    expect((await h.turns()).at(-1)?.argv).toEqual(["--profile", "experimental", "--json", "ping"]);
  });
});

describe("session lifecycle", () => {
  it("opens, echoes the prompt, and settles one turn per clientMessageId", async () => {
    const h = await harness({ env: { DSH_FAKE_SCENARIO: "simple" } });
    await h.open();
    await h.wait((event) => event.type === "session.ready");

    const clientMessageId = await h.prompt("ping");
    const settled = await h.settled(clientMessageId);
    expect(settled).toMatchObject({ state: "completed" });
    expect(h.persistence()).toMatchObject({ version: 1, data: { sessionId: expect.any(String) } });

    const user = h.timeline("user_message")[0];
    if (!user || user.type !== "user_message") throw new Error("Missing user message");
    expect(user.text).toBe("ping");
    expect(user.clientMessageId).toBe(clientMessageId);
    expect(h.timeline("reasoning")[0]).toMatchObject({ text: expect.stringContaining("greeting") });
    expect(h.timeline("assistant_message")[0]).toMatchObject({ text: "Hello from DSH." });

    const usage = h.events.find((event) => event.type === "session.usage");
    if (!usage || usage.type !== "session.usage") throw new Error("Missing usage");
    expect(usage.usage).toMatchObject({ inputTokens: 13870, outputTokens: 30 });

    const results = h.events.filter(
      (event) =>
        event.type === "session.prompt_result" && event.clientMessageId === clientMessageId,
    );
    expect(results).toHaveLength(1);
    expect((await h.turns())[0]?.argv).toEqual(["--profile", "headless", "--json", "ping"]);
  });

  it("maps tool calls and results onto one completed timeline item", async () => {
    const h = await harness({ env: { DSH_FAKE_SCENARIO: "tool" } });
    await h.open();
    const clientMessageId = await h.prompt("run the probe");
    expect(await h.settled(clientMessageId)).toMatchObject({ state: "completed" });
    const calls = h.timeline("tool_call");
    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (!call || call.type !== "tool_call") throw new Error("Missing tool call");
    expect(call).toMatchObject({
      callId: "chatcmpl-tool-879e15f1bf3124ff",
      name: "bash",
      status: "completed",
      detail: { type: "shell", command: "echo dsh-harness-probe" },
    });
    expect(call.detail).toMatchObject({ output: expect.stringContaining("dsh-harness-probe") });
  });

  it("resumes the native session id on the next turn", async () => {
    const h = await harness({ env: { DSH_FAKE_SCENARIO_SEQUENCE: "simple,resume" } });
    await h.open();
    const first = await h.prompt("ping");
    await h.settled(first);
    const sessionId = h.nativeSessionId();
    expect(sessionId).toBe("session-fake-simple-0001");
    expect((await h.turns())[0]?.argv).toEqual(["--profile", "headless", "--json", "ping"]);

    const second = await h.prompt("what did you run?");
    expect(await h.settled(second)).toMatchObject({ state: "completed" });
    expect((await h.turns()).at(-1)?.argv).toEqual([
      "--profile",
      "headless",
      "--json",
      "--session-id",
      sessionId,
      "what did you run?",
    ]);
    // The fake's resume script echoes the id it was given, so persistence is stable.
    expect(h.nativeSessionId()).toBe(sessionId);
  });

  it("prefixes the system prompt once and keeps it out of later turns", async () => {
    const h = await harness({
      env: { DSH_FAKE_SCENARIO: "simple" },
      systemPrompt: "SYSTEM PREFIX",
    });
    await h.open();
    const first = await h.prompt("ping");
    await h.settled(first);
    const second = await h.prompt("again");
    await h.settled(second);
    const records = await h.turns();
    expect(records[0]?.argv.at(-1)).toContain("SYSTEM PREFIX");
    expect(records[0]?.argv.at(-1)).toContain("ping");
    expect(records[1]?.argv.at(-1)).toBe("again");
  });

  it("parses a noisy stderr stream without corrupting events", async () => {
    const h = await harness({ env: { DSH_FAKE_SCENARIO: "noisy" } });
    await h.open();
    const clientMessageId = await h.prompt("ping");
    expect(await h.settled(clientMessageId)).toMatchObject({ state: "completed" });
    expect(h.timeline("assistant_message")[0]).toMatchObject({
      text: "Parsed despite stderr noise.",
    });
    expect(h.events.some((event) => event.type === "session.runtime_failed")).toBe(false);
  });
});

describe("model selection", () => {
  it("writes a patch overlay only once a model is chosen", async () => {
    const h = await harness({ env: { DSH_FAKE_SCENARIO: "simple" } });
    await h.open();
    const first = await h.prompt("ping");
    await h.settled(first);
    expect((await h.turns())[0]?.argv).not.toContain("--patch");

    await h.request({
      type: "session.configure",
      requestId: "configure-1",
      sessionId: "s",
      changes: { model: "homelab/nemotron-3.5-super-vl", thinkingOption: "high" },
    });
    const second = await h.prompt("again");
    await h.settled(second);

    const argv = (await h.turns()).at(-1)?.argv ?? [];
    expect(argv).toEqual([
      "--profile",
      "headless",
      // `--patch` is a launcher flag: it must precede `--json`, or dsh hands it to the
      // headless app, which rejects it as `unknown option '--patch'`.
      "--patch",
      expect.any(String),
      "--json",
      "--session-id",
      expect.any(String),
      "again",
    ]);
    const patchPath = patchPathFrom(argv);
    const patch = await readFile(patchPath, "utf8");
    expect(patch).toContain("- id: agent-default-model");
    expect(patch).toContain("provider: homelab");
    expect(patch).toContain("model: nemotron-3.5-super-vl");
    expect(patch).toContain("reasoningEffort: high");
  });

  it("writes the patch when the session opens with a model", async () => {
    const h = await harness({
      env: { DSH_FAKE_SCENARIO: "simple" },
      model: "homelab/deepseek-v4.1-flash",
    });
    await h.open();
    const clientMessageId = await h.prompt("ping");
    await h.settled(clientMessageId);
    const argv = (await h.turns())[0]?.argv ?? [];
    expect(argv).toContain("--patch");
    const patch = await readFile(patchPathFrom(argv), "utf8");
    expect(patch).toContain("model: deepseek-v4.1-flash");
  });

  it("applies the caller overlay first and disables requested profile plugins", async () => {
    const h = await harness({
      env: { DSH_FAKE_SCENARIO: "simple" },
      model: "homelab/deepseek-v4.1-flash",
      providerOptions: { patch: "/tmp/caller-overlay.yml", disablePlugins: ["tokenomics"] },
    });
    await h.open();
    const clientMessageId = await h.prompt("ping");
    await h.settled(clientMessageId);
    const argv = (await h.turns())[0]?.argv ?? [];
    const patches = argv.flatMap((arg, index) => {
      if (arg !== "--patch") return [];
      const value = argv[index + 1];
      return value === undefined ? [] : [value];
    });
    // The caller's overlay is applied first, so the session's model row wins.
    expect(patches[0]).toBe("/tmp/caller-overlay.yml");
    expect(patches).toHaveLength(2);
    const sessionPatch = patches[1];
    if (sessionPatch === undefined) throw new Error("Missing session patch");
    const yaml = await readFile(sessionPatch, "utf8");
    expect(yaml).toContain("- id: tokenomics");
    expect(yaml).toContain("disabled: true");
    expect(yaml).toContain("- id: agent-default-model");
  });
});

describe("failure and interruption", () => {
  it("fails the turn with a diagnostic when DSH reports a turn error", async () => {
    const h = await harness({
      env: { DSH_FAKE_SCENARIO: "error", DSH_FAKE_EXIT: "1" },
    });
    await h.open();
    const clientMessageId = await h.prompt("ping");
    const settled = await h.settled(clientMessageId);
    if (settled.type !== "session.turn") throw new Error("Missing turn");
    expect(settled.state).toBe("failed");
    expect(settled.error?.message).toMatch(/503|upstream/i);
  });

  it("fails the turn when the process dies mid-stream without a turn_end", async () => {
    const h = await harness({
      env: { DSH_FAKE_SCENARIO: "crash", DSH_FAKE_EXIT: "1" },
    });
    await h.open();
    const clientMessageId = await h.prompt("ping");
    const settled = await h.settled(clientMessageId);
    if (settled.type !== "session.turn") throw new Error("Missing turn");
    expect(settled.state).toBe("failed");
    expect(settled.error?.message.length ?? 0).toBeGreaterThan(0);
  });

  it("fails the turn when the final event is empty and the exit code is non-zero", async () => {
    const h = await harness({
      env: { DSH_FAKE_SCENARIO: "empty-final", DSH_FAKE_EXIT: "1" },
    });
    await h.open();
    const clientMessageId = await h.prompt("ping");
    const settled = await h.settled(clientMessageId);
    if (settled.type !== "session.turn") throw new Error("Missing turn");
    expect(settled.state).toBe("failed");
    expect(settled.error?.message.length ?? 0).toBeGreaterThan(0);
  });

  it("fails the turn when a known event is malformed, even if turn_end says completed", async () => {
    const h = await harness({ env: { DSH_FAKE_SCENARIO: "malformed" } });
    await h.open();
    const clientMessageId = await h.prompt("ping");
    const settled = await h.settled(clientMessageId);
    if (settled.type !== "session.turn") throw new Error("Missing turn");
    expect(settled.state).toBe("failed");
    expect(settled.error?.message.length ?? 0).toBeGreaterThan(0);
  });

  it("cancels an interrupted turn and keeps the session usable", async () => {
    const h = await harness({ env: { DSH_FAKE_SCENARIO_SEQUENCE: "interrupt,resume" } });
    await h.open();
    const clientMessageId = await h.prompt("write the essay");
    await h.wait(
      (event) => event.type === "timeline.item" && event.item.type === "assistant_message",
    );
    await h.request({ type: "session.interrupt", requestId: "interrupt-1", sessionId: "s" });
    const settled = await h.settled(clientMessageId);
    if (settled.type !== "session.turn") throw new Error("Missing turn");
    expect(settled.state).toBe("canceled");
    const sessionId = h.nativeSessionId();
    expect(sessionId).toBe("session-fake-interrupt-0001");

    // The same Paseo session must accept another turn afterwards, on the same native id.
    const next = await h.prompt("continue");
    expect(await h.settled(next)).toMatchObject({ state: "completed" });
    const resumeArgv = (await h.turns()).at(-1)?.argv ?? [];
    expect(resumeArgv.slice(-3)).toEqual(["--session-id", sessionId, "continue"]);
  });

  it("surfaces DSH's own message when the invocation is rejected", async () => {
    const h = await harness({ env: { DSH_FAKE_SCENARIO: "error-event", DSH_FAKE_EXIT: "1" } });
    await h.open();
    const clientMessageId = await h.prompt("ping");
    const settled = await h.settled(clientMessageId);
    if (settled.type !== "session.turn") throw new Error("Missing turn");
    expect(settled.state).toBe("failed");
    expect(settled.error?.message).toContain("unknown option '--patch'");
  });

  it("keeps profile activation noise out of the failure message", async () => {
    const h = await harness({ env: { DSH_FAKE_SCENARIO: "noisy-crash", DSH_FAKE_EXIT: "1" } });
    await h.open();
    const clientMessageId = await h.prompt("ping");
    const settled = await h.settled(clientMessageId);
    if (settled.type !== "session.turn") throw new Error("Missing turn");
    expect(settled.state).toBe("failed");
    // The real cause survives; the ~4 KB of preset warnings does not become the message.
    expect(settled.error?.message).toContain("RangeError");
    expect(settled.error?.message).not.toContain("did not activate");
    expect(settled.error?.message).not.toContain("agentPresets");
  });

  it("recreates the session once when the persisted id no longer exists", async () => {
    const h = await harness({ env: { DSH_FAKE_SCENARIO_SEQUENCE: "stale-session,simple" } });
    await h.open({ version: 1, data: { sessionId: "session-expired" } });
    const clientMessageId = await h.prompt("ping");
    expect(await h.settled(clientMessageId)).toMatchObject({ state: "completed" });
    const spawns = (await h.turns()).map((record) => record.argv);
    expect(spawns).toHaveLength(2);
    expect(spawns[0]?.slice(-2)).toEqual(["session-expired", "ping"]);
    expect(spawns[1]).not.toContain("--session-id");
    expect(h.events.some((event) => event.type === "session.notice")).toBe(true);
    expect(h.nativeSessionId()).toBe("session-fake-simple-0001");
  });
});
