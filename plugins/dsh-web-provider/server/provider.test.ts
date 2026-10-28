import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  PROVIDER_CAPABILITIES,
  ProviderEventSchema,
  type ProviderConnection,
  type ProviderEvent,
  type ProviderInput,
  type ProviderLaunch,
} from "@getpaseo/plugin/server/provider";
import { createDshWebProvider } from "./provider.js";
import { encodeContent } from "./internal/prompt.js";

const fake = fileURLToPath(new URL("../test/fake-host.mjs", import.meta.url));
const provider = createDshWebProvider();
const temporary: string[] = [];
const connections: ProviderConnection[] = [];

afterEach(async () => {
  await Promise.all(connections.splice(0).map((connection) => connection.close()));
  await Promise.all(
    temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function harness() {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "dsh-web-test-"));
  temporary.push(cwd);
  const launch: ProviderLaunch = {
    command: process.execPath,
    args: [fake],
    // A scratch DSH_HOME keeps the isolation probe away from the real profile.
    env: { DSH_HOME: cwd },
  };
  const connection = await provider.connect({
    versions: [1],
    capabilities: PROVIDER_CAPABILITIES,
    launch,
  });
  connections.push(connection);
  const events: ProviderEvent[] = [];
  connection.onEvent((event) => {
    // Every event must satisfy the provider wire contract; a bad one kills the
    // daemon's connection, not just the call.
    ProviderEventSchema.parse(event);
    events.push(event);
  });

  async function wait(predicate: (event: ProviderEvent) => boolean, timeout = 10_000) {
    const started = Date.now();
    for (;;) {
      const found = events.find(predicate);
      if (found !== undefined) return found;
      if (Date.now() - started > timeout) {
        throw new Error(
          `Expected event missing; saw: ${events.map((event) => event.type).join(", ")}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  async function send(input: ProviderInput) {
    await connection.send(input);
  }

  async function request(input: ProviderInput) {
    await send(input);
    if ("requestId" in input) {
      await wait(
        (event) =>
          "requestId" in event &&
          event.requestId === input.requestId &&
          (event.type === "request.completed" ||
            event.type === "request.failed" ||
            event.type === "session.ready" ||
            event.type === "catalog"),
      );
    }
  }

  async function open(sessionId = "s") {
    await request({
      type: "session.open",
      requestId: `open-${String(events.length)}`,
      sessionId,
      history: "skip",
      config: {
        cwd,
        env: {},
        settings: {},
        mcpServers: {},
        persist: true,
      },
    });
  }

  async function prompt(text: string, sessionId = "s") {
    const clientMessageId = `prompt-${String(events.length)}`;
    await send({
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

  async function command(name: string, argumentsText: string, sessionId = "s") {
    const clientMessageId = `command-${String(events.length)}`;
    await send({
      type: "session.prompt",
      sessionId,
      prompt: {
        clientMessageId,
        delivery: "auto",
        input: { type: "command", name, arguments: argumentsText },
      },
    });
    await wait(
      (event) =>
        event.type === "session.prompt_result" && event.clientMessageId === clientMessageId,
    );
    return clientMessageId;
  }

  return { connection, events, wait, send, request, open, prompt, command, cwd };
}

/** A config event whose plan-mode toggle reads `value`. */
function planToggle(value: boolean) {
  return (event: ProviderEvent): boolean =>
    event.type === "session.config" &&
    event.config.settings.some((setting) => setting.id === "plan_mode" && setting.value === value);
}

describe("dsh-web provider", () => {
  it("advertises image prompts and encodes them as DSH image blocks", async () => {
    const { connection } = await harness();
    expect(connection.capabilities).toContain("prompt.image");
    expect(
      encodeContent({
        clientMessageId: "image-1",
        delivery: "auto",
        input: {
          type: "message",
          content: [
            { type: "text", text: "what is in this image" },
            { type: "image", data: "AAAA", mimeType: "image/png" },
          ],
        },
      }),
    ).toEqual([
      { type: "text", text: "what is in this image" },
      { type: "image", mediaType: "image/png", data: "AAAA" },
    ]);
  });

  it("advertises the host's models and the Build/Plan modes", async () => {
    const { request, events } = await harness();
    await request({ type: "catalog", requestId: "catalog-1" });
    const catalog = events.find((event) => event.type === "catalog");
    if (catalog?.type !== "catalog") throw new Error("catalog missing");
    expect(catalog.catalog.models.map((model) => model.id)).toEqual([
      "fake-provider/fake-model",
      "fake-provider/fake-model-fast",
    ]);
    expect(catalog.catalog.defaultModel).toBe("fake-provider/fake-model");
    expect(catalog.catalog.thinkingOptions?.map((option) => option.id)).toEqual(["low", "high"]);
    // The create screen reads modes from the catalog, not only from a session.
    expect(catalog.catalog.modes.map((mode) => mode.id)).toEqual([
      "standard",
      "ptc",
      "cordis",
      "minimal",
      "dsh-ops",
    ]);
    expect(catalog.catalog.defaultMode).toBe("standard");
  });

  it("opens a session in the fixed event order with the host's command list", async () => {
    const { open, events } = await harness();
    await open();
    const order = events.map((event) => event.type);
    expect(order.indexOf("session.opened")).toBeLessThan(order.indexOf("session.config"));
    expect(order.indexOf("session.config")).toBeLessThan(order.indexOf("session.commands"));
    expect(order.indexOf("session.commands")).toBeLessThan(order.indexOf("session.ready"));
    const opened = events.find((event) => event.type === "session.opened");
    if (opened?.type !== "session.opened") throw new Error("opened missing");
    expect(opened.persistence).toEqual({ version: 1, data: { sessionId: "session-fake-1" } });
    const commands = events.find((event) => event.type === "session.commands");
    if (commands?.type !== "session.commands") throw new Error("commands missing");
    // The host lists `export`; Paseo cannot present a ZIP download, so it is hidden.
    expect(commands.commands.map((command) => command.name)).toEqual([
      "goal",
      "plan",
      "compact",
      "feedback",
    ]);
    const config = events.find((event) => event.type === "session.config");
    if (config?.type !== "session.config") throw new Error("config missing");
    // The host's presets are the modes; the shipped ones have no published name,
    // so the labels come from the DSH web UI's own mapping (cordis = Creator).
    expect(config.config.mode).toBe("standard");
    expect(config.config.modes.map((mode) => mode.id)).toEqual([
      "standard",
      "ptc",
      "cordis",
      "minimal",
      "dsh-ops",
    ]);
    expect(config.config.modes.map((mode) => mode.label)).toEqual([
      "Standard",
      "PTC",
      "Creator",
      "Minimal",
      "Ops",
    ]);
    // Plan is a toggle, not a mode, so both can coexist.
    expect(config.config.settings).toEqual([
      expect.objectContaining({ id: "plan_mode", type: "toggle", value: false }),
    ]);
  });

  it("projects a prompt turn into prompt_result, turn, messages and usage", async () => {
    const { open, prompt, events, wait } = await harness();
    await open();
    const clientMessageId = await prompt("hello there");
    await wait((event) => event.type === "session.turn" && event.state === "completed");
    const result = events.find(
      (event) =>
        event.type === "session.prompt_result" && event.clientMessageId === clientMessageId,
    );
    if (result?.type !== "session.prompt_result" || result.result.type !== "turn") {
      throw new Error("prompt_result was not a turn");
    }
    const user = events.find(
      (event) => event.type === "timeline.item" && event.item.type === "user_message",
    );
    if (user?.type !== "timeline.item" || user.item.type !== "user_message")
      throw new Error("user message missing");
    expect(user.item.text).toBe("hello there");
    expect(user.item.clientMessageId).toBe(clientMessageId);
    const assistant = events.find(
      (event) => event.type === "timeline.item" && event.item.type === "assistant_message",
    );
    if (assistant?.type !== "timeline.item" || assistant.item.type !== "assistant_message") {
      throw new Error("assistant message missing");
    }
    expect(assistant.item.text).toBe("fake reply to: hello there");
    const usage = events.find((event) => event.type === "session.usage");
    if (usage?.type !== "session.usage") throw new Error("usage missing");
    expect(usage.usage).toMatchObject({ inputTokens: 11, cachedInputTokens: 3, outputTokens: 7 });
    const started = events.find(
      (event) => event.type === "session.turn" && event.state === "started",
    );
    if (started?.type !== "session.turn") throw new Error("turn start missing");
    expect(started.turnId).toBe(result.result.turnId);
  });

  it("runs /plan as the host's own command and flips the plan toggle", async () => {
    const { open, command, events, wait } = await harness();
    await open();
    const clientMessageId = await command("plan", "");
    await wait(planToggle(true));
    const result = events.find(
      (event) =>
        event.type === "session.prompt_result" && event.clientMessageId === clientMessageId,
    );
    if (result?.type !== "session.prompt_result") throw new Error("result missing");
    // A command is handled without a model turn.
    expect(result.result).toEqual({ type: "completed" });
    const notice = events.find(
      (event) =>
        event.type === "session.notice" &&
        event.notice.description === "Plan mode on. Use /plan off to leave.",
    );
    expect(notice).toBeDefined();
    const configs = events.filter((event) => event.type === "session.config");
    const latest = configs.at(-1);
    if (latest?.type !== "session.config") throw new Error("config missing");
    // Plan is a toggle: the preset mode is untouched.
    expect(latest.config.mode).toBe("standard");
  });

  it("selects an agent preset before the first turn", async () => {
    const { open, events, request, wait } = await harness();
    await open();
    await request({
      type: "session.configure",
      requestId: "mode-1",
      sessionId: "s",
      changes: { mode: "ptc" },
    });
    await wait((event) => event.type === "session.config" && event.config.mode === "ptc");
    const latest = events.findLast((event) => event.type === "session.config");
    if (latest?.type !== "session.config") throw new Error("config missing");
    expect(latest.config.mode).toBe("ptc");
    // The preset switch is a pre-first-turn action, so it is not a model turn.
    expect(events.some((event) => event.type === "session.turn")).toBe(false);
  });

  it("refuses a preset switch after the first turn", async () => {
    const { open, prompt, request, events, wait } = await harness();
    await open();
    await prompt("hello");
    await wait((event) => event.type === "session.turn" && event.state === "completed");
    await request({
      type: "session.configure",
      requestId: "mode-2",
      sessionId: "s",
      changes: { mode: "ptc" },
    });
    const failed = events.find(
      (event) => event.type === "request.failed" && event.requestId === "mode-2",
    );
    if (failed?.type !== "request.failed") throw new Error("expected a failed configure");
    expect(failed.error.message).toMatch(/first turn/);
    expect(failed.error.code).toBe("PRESET_LOCKED");
  });

  it("honours a preset chosen when the session is created", async () => {
    const { request, events } = await harness();
    await request({
      type: "session.open",
      requestId: "open-preset",
      sessionId: "s2",
      history: "skip",
      config: {
        cwd: "/tmp",
        env: {},
        settings: {},
        mcpServers: {},
        persist: true,
        mode: "minimal",
      },
    });
    const config = events.find(
      (event) => event.type === "session.config" && event.sessionId === "s2",
    );
    if (config?.type !== "session.config") throw new Error("config missing");
    expect(config.config.mode).toBe("minimal");
  });

  it("runs /goal through the host and surfaces the goal", async () => {
    const { open, command, events, wait } = await harness();
    await open();
    await command("goal", "ship the native provider");
    await wait(
      (event) => event.type === "session.notice" && event.notice.title === "Goal (active)",
    );
    const notice = events.find(
      (event) => event.type === "session.notice" && event.notice.title === "Goal (active)",
    );
    if (notice?.type !== "session.notice") throw new Error("goal notice missing");
    expect(notice.notice.description).toBe("ship the native provider");
  });

  it("settles an interrupted turn as canceled", async () => {
    const { open, prompt, wait, request } = await harness();
    await open();
    await prompt("start something long");
    await wait((event) => event.type === "session.turn" && event.state === "started");
    await request({ type: "session.interrupt", requestId: "interrupt-1", sessionId: "s" });
    await wait((event) => event.type === "session.turn" && event.state === "canceled");
  });

  it("closes the session and stops the host", async () => {
    const { open, wait, request } = await harness();
    await open();
    await request({ type: "session.close", requestId: "close-1", sessionId: "s" });
    await wait((event) => event.type === "session.closed");
  });
});
