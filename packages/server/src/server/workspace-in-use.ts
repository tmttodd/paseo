import type { TerminalManager } from "../terminal/terminal-manager.js";
import type { AgentManager } from "./agent/agent-manager.js";
import type { WorkspaceScriptRuntimeStore } from "./workspace-script-runtime-store.js";

export interface WorkspaceInUseDependencies {
  agentManager: Pick<AgentManager, "listAgents">;
  terminalManager: Pick<TerminalManager, "listDirectories" | "getTerminals">;
  scriptRuntimeStore: Pick<WorkspaceScriptRuntimeStore, "listForWorkspace">;
  hasServicePortPlan: (workspaceId: string) => boolean;
}

/**
 * Answers whether anything still runs against a workspace.
 *
 * The automatic archive only writes the workspace record and drops its script
 * runtime and port plan. It never stops an agent or a terminal, so archiving a
 * workspace that still has one strands it. Callers check here first.
 *
 * Unreadable state counts as in use: a terminal directory that cannot be listed
 * is not evidence that the workspace is idle.
 */
export function createIsWorkspaceInUse(
  dependencies: WorkspaceInUseDependencies,
): (workspaceId: string) => Promise<boolean> {
  return async (workspaceId) => {
    const agents = dependencies.agentManager.listAgents({ includeInternal: true });
    if (agents.some((agent) => agent.workspaceId === workspaceId)) {
      return true;
    }

    const scripts = dependencies.scriptRuntimeStore.listForWorkspace(workspaceId);
    if (scripts.some((entry) => entry.lifecycle === "running")) {
      return true;
    }

    if (dependencies.hasServicePortPlan(workspaceId)) {
      return true;
    }

    for (const cwd of dependencies.terminalManager.listDirectories()) {
      let terminals: Awaited<ReturnType<TerminalManager["getTerminals"]>>;
      try {
        terminals = await dependencies.terminalManager.getTerminals(cwd, { workspaceId });
      } catch {
        return true;
      }
      if (terminals.some((terminal) => terminal.workspaceId === workspaceId)) {
        return true;
      }
    }

    return false;
  };
}
