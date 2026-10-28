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
      await wait((event) => event.type === "session.config" && event.config.mode === "plan");
      console.log("PASS check=plan-on :: mode=plan");

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
      await wait((event) => event.type === "session.config" && event.config.mode === "default");
      console.log("PASS check=plan-off :: mode=default");
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
});
