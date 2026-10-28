import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execCommand } from "@getpaseo/plugin/server";
import {
  PROVIDER_CAPABILITIES,
  type ProviderConnection,
  type ProviderEvent,
  type ProviderInput,
} from "@getpaseo/plugin/server/provider";
import { createDshWebProvider } from "./provider.js";

/**
 * Live contract test: the provider spawns a REAL `dsh web` host and drives it.
 *
 *   DSH_WEB_LIVE=1 npx vitest run plugins/dsh-web-provider
 *
 * A scratch DSH_HOME keeps the user's own DSH state untouched; the host
 * materializes the shipped `web` template there. With no model credentials the
 * prompt turn ends in a credential error, which still proves the prompt reached
 * the adapter — the native `/plan` and `/goal` checks need no model at all.
 *
 *   DSH_WEB_LIVE_HOME=~/.dsh  run against a real, credentialed home
 */

const live = process.env.DSH_WEB_LIVE === "1" ? describe : describe.skip;
const TIMEOUT = 240_000;

/** A config event whose plan-mode toggle reads `value`. */
function planToggle(value: boolean) {
  return (event: ProviderEvent): boolean =>
    event.type === "session.config" &&
    event.config.settings.some((setting) => setting.id === "plan_mode" && setting.value === value);
}

async function dshBinary(): Promise<string> {
  const { stdout } = await execCommand("/usr/bin/which", ["dsh"]);
  return stdout.trim();
}

live("dsh-web live", () => {
  let connection: ProviderConnection;
  let home: string;
  let cwd: string;
  const events: ProviderEvent[] = [];

  beforeAll(async () => {
    home =
      process.env.DSH_WEB_LIVE_HOME ?? (await mkdtemp(path.join(os.tmpdir(), "dsh-web-live-")));
    cwd = await mkdtemp(path.join(os.tmpdir(), "dsh-web-cwd-"));
    connection = await createDshWebProvider().connect({
      versions: [1],
      capabilities: PROVIDER_CAPABILITIES,
      launch: {
        command: await dshBinary(),
        args: [],
        env: { ...process.env, DSH_HOME: home } as Record<string, string>,
      },
    });
    connection.onEvent((event) => {
      events.push(event);
    });
  }, TIMEOUT);

  afterAll(async () => {
    await connection?.close();
    if (process.env.DSH_WEB_LIVE_HOME === undefined) {
      await rm(home, { recursive: true, force: true });
    }
    await rm(cwd, { recursive: true, force: true });
  });

  async function wait(predicate: (event: ProviderEvent) => boolean, timeout = TIMEOUT) {
    const started = Date.now();
    for (;;) {
      const found = events.find(predicate);
      if (found !== undefined) return found;
      if (Date.now() - started > timeout) {
        throw new Error(
          `Expected event missing; saw: ${[...new Set(events.map((event) => event.type))].join(", ")}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  async function send(input: ProviderInput) {
    await connection.send(input);
  }

  it(
    "boots a host, opens a session and lists the host's commands",
    async () => {
      await send({ type: "catalog", requestId: "catalog" });
      const catalog = await wait((event) => event.type === "catalog");
      if (catalog.type !== "catalog") throw new Error("catalog missing");
      // A scratch home has no credentials, so the host reports no routable models;
      // a real home lists them. Either way the catalog call must answer.
      console.log(`PASS check=catalog :: ${String(catalog.catalog.models.length)} models`);

      await send({
        type: "session.open",
        requestId: "open",
        sessionId: "live-1",
        history: "skip",
        config: { cwd, env: {}, settings: {}, mcpServers: {}, persist: true },
      });
      await wait((event) => event.type === "session.ready" && event.requestId === "open");
      const opened = await wait((event) => event.type === "session.opened");
      if (opened.type !== "session.opened") throw new Error("opened missing");
      expect(opened.persistence?.data).toMatchObject({
        sessionId: expect.stringMatching(/^session-/),
      });

      const commands = await wait((event) => event.type === "session.commands");
      if (commands.type !== "session.commands") throw new Error("commands missing");
      const names = commands.commands.map((command) => command.name);
      expect(names).toContain("goal");
      expect(names).toContain("plan");
      console.log(`PASS check=commands :: ${names.join(", ")}`);
      const hostCommands = new Set(["goal", "plan", "compact", "feedback", "permission", "export"]);
      const skills = names.filter((name) => !hostCommands.has(name));
      console.log(
        `PASS check=skills :: ${String(skills.length)} (${skills.slice(0, 6).join(", ")})`,
      );

      const config = await wait((event) => event.type === "session.config");
      if (config.type !== "session.config") throw new Error("config missing");
      const modes = config.config.modes;
      expect(modes.length).toBeGreaterThan(0);
      expect(modes.map((mode) => mode.id)).toContain("standard");
      expect(config.config.settings.some((setting) => setting.id === "plan_mode")).toBe(true);
      const permission = config.config.settings.find(
        (setting) => setting.id === "permission_preset",
      );
      expect(permission?.type).toBe("select");
      if (permission?.type === "select") {
        expect(permission.options.map((option) => option.value)).toEqual(
          expect.arrayContaining(["read-only", "workspace-write", "danger-full-access"]),
        );
        console.log(`PASS check=permission-preset :: ${permission.value ?? "unset"}`);
      }
      const creator = modes.find((mode) => mode.id === "cordis");
      if (creator !== undefined) expect(creator.label).toBe("Creator");
      console.log(
        `PASS check=presets :: ${modes.map((mode) => `${mode.id}=${mode.label}`).join(", ")}`,
      );
    },
    TIMEOUT,
  );

  it(
    "selects an agent preset before the first turn",
    async () => {
      const config = await wait((event) => event.type === "session.config");
      if (config.type !== "session.config") throw new Error("config missing");
      const target = config.config.modes.find((mode) => mode.id !== config.config.mode);
      if (target === undefined) throw new Error("the host offers only one preset");
      await send({
        type: "session.configure",
        requestId: "preset-switch",
        sessionId: "live-1",
        changes: { mode: target.id },
      });
      await wait((event) => event.type === "session.config" && event.config.mode === target.id);
      console.log(`PASS check=preset-switch :: ${target.id}`);
    },
    TIMEOUT,
  );

  it(
    "runs /plan as the host's own command",
    async () => {
      const clientMessageId = "plan-on";
      await send({
        type: "session.prompt",
        sessionId: "live-1",
        prompt: {
          clientMessageId,
          delivery: "auto",
          input: { type: "command", name: "plan", arguments: "" },
        },
      });
      await wait(
        (event) =>
          event.type === "session.prompt_result" &&
          event.clientMessageId === clientMessageId &&
          event.result.type === "completed",
      );
      await wait(planToggle(true));
      console.log("PASS check=plan-on :: plan_mode=true");

      const offMessageId = "plan-off";
      await send({
        type: "session.prompt",
        sessionId: "live-1",
        prompt: {
          clientMessageId: offMessageId,
          delivery: "auto",
          input: { type: "command", name: "plan", arguments: "off" },
        },
      });
      await wait(planToggle(false));
      console.log("PASS check=plan-off :: plan_mode=false");
    },
    TIMEOUT,
  );

  it(
    "creates a real goal through /goal",
    async () => {
      await send({
        type: "session.prompt",
        sessionId: "live-1",
        prompt: {
          clientMessageId: "goal-create",
          delivery: "auto",
          input: { type: "command", name: "goal", arguments: "live contract objective" },
        },
      });
      const notice = await wait(
        (event) => event.type === "session.notice" && event.notice.title === "Goal (active)",
      );
      if (notice.type !== "session.notice") throw new Error("goal notice missing");
      expect(notice.notice.description).toBe("live contract objective");
      console.log("PASS check=goal :: goal (active) created");
    },
    TIMEOUT,
  );

  it(
    "submits a prompt and settles the turn (reply or a credential error)",
    async () => {
      await send({
        type: "session.prompt",
        sessionId: "live-1",
        prompt: {
          clientMessageId: "prompt-1",
          delivery: "auto",
          input: { type: "message", content: [{ type: "text", text: "Reply with exactly: ok" }] },
        },
      });
      const terminal = await wait(
        (event) =>
          event.type === "session.turn" &&
          (event.state === "completed" || event.state === "failed" || event.state === "canceled"),
      );
      if (terminal.type !== "session.turn") throw new Error("turn terminal missing");
      if (terminal.state === "completed") {
        const assistant = events.find(
          (event) => event.type === "timeline.item" && event.item.type === "assistant_message",
        );
        expect(assistant).toBeDefined();
        console.log("PASS check=prompt :: model turn completed");
      } else {
        // A credential-free scratch home reaches the adapter and fails there.
        expect(terminal.error?.message ?? "").toMatch(/credential|API key|no API key/i);
        console.log(
          `PASS check=prompt :: turn failed at the adapter (${terminal.error?.message ?? "no message"})`,
        );
      }
    },
    TIMEOUT,
  );

  it(
    "admits a prompt carrying an image",
    async () => {
      // 1x1 red PNG: the host validates the bytes against the declared media type.
      const image =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
      await send({
        type: "session.prompt",
        sessionId: "live-1",
        prompt: {
          clientMessageId: "image-1",
          delivery: "auto",
          input: {
            type: "message",
            content: [
              { type: "text", text: "What colour is this image?" },
              { type: "image", data: image, mimeType: "image/png" },
            ],
          },
        },
      });
      const admitted = await wait(
        (event) => event.type === "session.prompt_result" && event.clientMessageId === "image-1",
      );
      if (admitted.type !== "session.prompt_result") throw new Error("prompt result missing");
      expect(admitted.result.type).not.toBe("failed");
      console.log("PASS check=image :: image prompt admitted");
    },
    TIMEOUT,
  );

  it(
    "refuses a preset switch after the first turn",
    async () => {
      const config = await wait((event) => event.type === "session.config");
      if (config.type !== "session.config") throw new Error("config missing");
      const target = config.config.modes.find((mode) => mode.id !== config.config.mode);
      if (target === undefined) return;
      await send({
        type: "session.configure",
        requestId: "preset-late",
        sessionId: "live-1",
        changes: { mode: target.id },
      });
      const failed = await wait(
        (event) => event.type === "request.failed" && event.requestId === "preset-late",
      );
      if (failed.type !== "request.failed") throw new Error("expected a failed configure");
      expect(failed.error.code).toBe("PRESET_LOCKED");
      console.log(`PASS check=preset-locked :: ${failed.error.message}`);
    },
    TIMEOUT,
  );
});
