import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { isCommandAvailable } from "../../executable-resolution/executable-resolution.js";
import { BuiltinPluginLoader } from "../plugins/builtin/index.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { DaemonClient } from "../test-utils/daemon-client.js";

/**
 * The user's `headless` profile loads a `dsh-tokenomics` plugin that buffers a
 * whole decompressed session log in one string and dies with
 * `RangeError: Invalid string length`, which kills every turn. The provider's
 * `disablePlugins` option exists for exactly this: it writes one patch overlay
 * that disables the named profile rows for this session only.
 */
const disableBrokenProfilePlugins = { disablePlugins: ["tokenomics"] };

test("DSH registers as a provider without a client settings bundle", async () => {
  const daemon = await createTestPaseoDaemon({
    builtinPlugins: new BuiltinPluginLoader(undefined, ["dsh-provider"]),
  });
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.10.0",
  });
  try {
    await client.connect();
    const plugin = (await client.getPluginCatalog()).find((entry) => entry.id === "dsh-provider");
    expect(plugin).toBeDefined();
    expect(plugin?.clientBundle).toBe("");
    const snapshot = await client.getProvidersSnapshot({ cwd: process.cwd() });
    const dsh = snapshot.entries.find((entry) => entry.provider === "dsh");
    expect(dsh).toBeDefined();
    expect(dsh?.enabled).not.toBe(false);
    // Discovery runs `dsh --dump-config`; the first snapshot can still be loading.
    await expect
      .poll(
        async () => {
          const next = await client.getProvidersSnapshot({ cwd: process.cwd() });
          return next.entries.find((entry) => entry.provider === "dsh")?.models?.length ?? 0;
        },
        { timeout: 60_000, interval: 500 },
      )
      .toBeGreaterThan(0);
  } finally {
    await client.close();
    await daemon.close();
  }
});

test("DSH creates an agent, streams a reply, runs a real tool, and resumes", async (context) => {
  if (!(await isCommandAvailable("dsh"))) {
    context.skip();
    return;
  }
  const cwd = await mkdtemp(path.join(os.tmpdir(), "paseo-dsh-e2e-"));
  await writeFile(path.join(cwd, "f"), "DSH_TOOL_E2E_OK\n");
  execFileSync("git", ["init", cwd], { stdio: "ignore" });
  const daemon = await createTestPaseoDaemon({
    builtinPlugins: new BuiltinPluginLoader(undefined, ["dsh-provider"]),
    providerOverrides: { dsh: { enabled: true } },
  });
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.10.0",
  });
  try {
    await client.connect();
    await client.fetchAgents({ subscribe: {} });
    const agent = await client.createAgent({
      provider: "dsh",
      cwd,
      providerOptions: disableBrokenProfilePlugins,
    });
    await client.sendMessage(agent.id, "Reply exactly DSH_TEXT_E2E_OK. Do not use tools.");
    expect((await client.waitForFinish(agent.id, 180000)).status).toBe("idle");
    const reply = await client.fetchAgentTimeline(agent.id, {
      direction: "tail",
      limit: 0,
      projection: "canonical",
    });
    expect(
      reply.entries.some(
        (entry) =>
          entry.item.type === "assistant_message" && entry.item.text.includes("DSH_TEXT_E2E_OK"),
      ),
    ).toBe(true);

    await client.sendMessage(
      agent.id,
      "Read the file f with your shell tool and report its contents.",
    );
    expect((await client.waitForFinish(agent.id, 180000)).status).toBe("idle");
    const tools = await client.fetchAgentTimeline(agent.id, {
      direction: "tail",
      limit: 0,
      projection: "canonical",
    });
    expect(
      tools.entries.some(
        (entry) => entry.item.type === "tool_call" && entry.item.status === "completed",
      ),
    ).toBe(true);
    expect(
      tools.entries.some(
        (entry) =>
          entry.item.type === "assistant_message" && entry.item.text.includes("DSH_TOOL_E2E_OK"),
      ),
    ).toBe(true);

    // The provider resumes one DSH session across turns, so turn 3 must still see turn 2.
    await client.sendMessage(agent.id, "Quote the exact file contents you just read. One line.");
    expect((await client.waitForFinish(agent.id, 180000)).status).toBe("idle");
    const resumed = await client.fetchAgentTimeline(agent.id, {
      direction: "tail",
      limit: 0,
      projection: "canonical",
    });
    const assistant = resumed.entries
      .filter((entry) => entry.item.type === "assistant_message")
      .map((entry) => (entry.item.type === "assistant_message" ? entry.item.text : ""));
    expect(assistant.at(-1) ?? "").toContain("DSH_TOOL_E2E_OK");
  } finally {
    await client.close();
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
}, 300000);
