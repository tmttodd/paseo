import { describe, expect, test } from "vitest";
import { createIsWorkspaceInUse, type WorkspaceInUseDependencies } from "./workspace-in-use.js";

interface TerminalStub {
  cwd: string;
  workspaceId: string;
}

function createProbe(
  overrides: {
    agentWorkspaceIds?: string[];
    scripts?: Array<{ workspaceId: string; lifecycle: "running" | "stopped" }>;
    hasServicePortPlan?: (workspaceId: string) => boolean;
    terminals?: TerminalStub[];
    terminalReadFails?: boolean;
  } = {},
): (workspaceId: string) => Promise<boolean> {
  const terminals = overrides.terminals ?? [];
  const directories = [...new Set(terminals.map((terminal) => terminal.cwd))];
  const dependencies = {
    agentManager: {
      listAgents: () => (overrides.agentWorkspaceIds ?? []).map((workspaceId) => ({ workspaceId })),
    },
    scriptRuntimeStore: {
      listForWorkspace: (workspaceId: string) =>
        (overrides.scripts ?? []).filter((entry) => entry.workspaceId === workspaceId),
    },
    hasServicePortPlan: overrides.hasServicePortPlan ?? (() => false),
    terminalManager: {
      listDirectories: () => directories,
      getTerminals: async (cwd: string) => {
        if (overrides.terminalReadFails) throw new Error("terminal directory is unreadable");
        return terminals.filter((terminal) => terminal.cwd === cwd);
      },
    },
  } as unknown as WorkspaceInUseDependencies;
  return createIsWorkspaceInUse(dependencies);
}

describe("createIsWorkspaceInUse", () => {
  test("reports an idle workspace as free", async () => {
    await expect(createProbe()("w1")).resolves.toBe(false);
  });

  test("counts a live agent in the workspace", async () => {
    const probe = createProbe({ agentWorkspaceIds: ["w1"] });

    await expect(probe("w1")).resolves.toBe(true);
    await expect(probe("w2")).resolves.toBe(false);
  });

  test("counts a running workspace script but not a stopped one", async () => {
    await expect(
      createProbe({ scripts: [{ workspaceId: "w1", lifecycle: "running" }] })("w1"),
    ).resolves.toBe(true);
    await expect(
      createProbe({ scripts: [{ workspaceId: "w1", lifecycle: "stopped" }] })("w1"),
    ).resolves.toBe(false);
  });

  test("counts a reserved service port plan", async () => {
    const probe = createProbe({ hasServicePortPlan: (workspaceId) => workspaceId === "w1" });

    await expect(probe("w1")).resolves.toBe(true);
    await expect(probe("w2")).resolves.toBe(false);
  });

  test("counts a terminal owned by the workspace", async () => {
    const probe = createProbe({
      terminals: [
        { cwd: "/repo", workspaceId: "w1" },
        { cwd: "/repo", workspaceId: "w2" },
      ],
    });

    await expect(probe("w1")).resolves.toBe(true);
    await expect(probe("w3")).resolves.toBe(false);
  });

  test("treats an unreadable terminal directory as in use", async () => {
    // Archiving on a read failure would strand whatever the failure hides.
    const probe = createProbe({
      terminals: [{ cwd: "/repo", workspaceId: "w9" }],
      terminalReadFails: true,
    });
    await expect(probe("w1")).resolves.toBe(true);
  });
});
