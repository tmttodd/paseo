import type {
  ProviderCatalog,
  ProviderMode,
  ProviderModel,
  ProviderThinkingOption,
} from "@getpaseo/plugin/server/provider";

/**
 * The host's own model catalog, as `session/modelCatalog` reports it
 * (wire contract §9): `{default, routableProviders, groups, failures}`.
 *
 * Paseo model ids are `provider/model`, matching the one-shot provider's
 * mapping so a user's saved selections keep working across the two providers.
 */

export interface CatalogValue {
  catalog: ProviderCatalog;
  /** `provider/model` ids that the host reports as routable. */
  routable: ReadonlySet<string>;
}

export const DEFAULT_MODE_ID = "default";
export const PLAN_MODE_ID = "plan";

/**
 * Build and Build/Plan modes. The app renders any mode whose `colorTier` is
 * `planning` (or whose id is `plan`) as the single Plan Mode toggle, so the
 * pair here is what makes `/plan` a first-class composer control.
 */
export function modesFor(planActive: boolean): { modes: ProviderMode[]; mode: string } {
  return {
    modes: [
      {
        id: DEFAULT_MODE_ID,
        label: "Build",
        description: "Implement changes",
        colorTier: "safe",
        icon: "Shield",
      },
      {
        id: PLAN_MODE_ID,
        label: "Plan",
        description: "Explore and design before implementing",
        colorTier: "planning",
        icon: "ShieldEllipsis",
      },
    ],
    mode: planActive ? PLAN_MODE_ID : DEFAULT_MODE_ID,
  };
}

export function catalogFromHost(raw: unknown): CatalogValue | null {
  if (!isRecord(raw)) return null;
  const groups = Array.isArray(raw.groups) ? raw.groups : [];
  const models: ProviderModel[] = [];
  const thinking: ProviderThinkingOption[] = [];
  const routable = new Set<string>();
  const seenThinking = new Set<string>();
  const defaultSelection = selectionOf(raw.default);
  for (const group of groups) {
    collectGroup({ group, defaultSelection, models, thinking, routable, seenThinking });
  }
  if (models.length === 0) return null;
  const defaultModel =
    defaultSelection?.id ?? models.find((model) => model.isDefault)?.id ?? models[0]?.id;
  if (defaultModel === undefined) return null;
  return {
    routable,
    catalog: {
      models,
      modes: [],
      thinkingOptions: thinking,
      defaultModel,
      ...(defaultSelection?.effort === undefined
        ? {}
        : { defaultThinkingOption: defaultSelection.effort }),
    },
  };
}

interface Collect {
  group: unknown;
  defaultSelection: { id: string; effort?: string } | undefined;
  models: ProviderModel[];
  thinking: ProviderThinkingOption[];
  routable: Set<string>;
  seenThinking: Set<string>;
}

function collectGroup({
  group,
  defaultSelection,
  models,
  thinking,
  routable,
  seenThinking,
}: Collect): void {
  if (!isRecord(group) || typeof group.id !== "string" || group.id === "") return;
  const provider = group.id;
  const list = Array.isArray(group.models) ? group.models : [];
  for (const model of list) {
    collectModel({ provider, model, defaultSelection, models, thinking, routable, seenThinking });
  }
}

interface ModelCollect {
  provider: string;
  model: unknown;
  defaultSelection: { id: string; effort?: string } | undefined;
  models: ProviderModel[];
  thinking: ProviderThinkingOption[];
  routable: Set<string>;
  seenThinking: Set<string>;
}

function collectModel(collect: ModelCollect): void {
  const { provider, model, defaultSelection, models, thinking, routable, seenThinking } = collect;
  if (!isRecord(model) || typeof model.id !== "string" || model.id === "") return;
  const id = `${provider}/${model.id}`;
  routable.add(id);
  const efforts = reasoningEfforts(model);
  for (const effort of efforts) {
    if (seenThinking.has(effort.id)) continue;
    seenThinking.add(effort.id);
    thinking.push(effort);
  }
  models.push({
    id,
    label: typeof model.name === "string" && model.name !== "" ? model.name : id,
    ...(typeof model.description === "string" ? { description: model.description } : {}),
    isDefault: defaultSelection !== undefined && defaultSelection.id === id,
    thinkingOptions: efforts.length > 0 ? efforts : undefined,
    metadata: { provider, model: model.id },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The host's default route, in the same `provider/model` form. */
export function selectionOf(raw: unknown): { id: string; effort?: string } | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const value = raw as { provider?: unknown; model?: unknown; reasoningEffort?: unknown };
  if (typeof value.provider !== "string" || typeof value.model !== "string") return undefined;
  return {
    id: `${value.provider}/${value.model}`,
    ...(typeof value.reasoningEffort === "string" ? { effort: value.reasoningEffort } : {}),
  };
}

/** Split a Paseo model id back into the host's provider and model. */
export function parseModelId(id: string): { provider: string; model: string } | undefined {
  const separator = id.indexOf("/");
  if (separator <= 0 || separator === id.length - 1) return undefined;
  return { provider: id.slice(0, separator), model: id.slice(separator + 1) };
}

function reasoningEfforts(model: Record<string, unknown>): ProviderThinkingOption[] {
  const reasoning = model.reasoning;
  if (!isRecord(reasoning)) return [];
  const efforts = Array.isArray(reasoning.efforts) ? reasoning.efforts : [];
  const defaultEffort =
    typeof reasoning.defaultEffort === "string" ? reasoning.defaultEffort : undefined;
  const options: ProviderThinkingOption[] = [];
  for (const effort of efforts) {
    if (typeof effort !== "object" || effort === null) continue;
    const value = effort as { id?: unknown; name?: unknown; description?: unknown };
    if (typeof value.id !== "string" || value.id === "") continue;
    options.push({
      id: value.id,
      label: typeof value.name === "string" && value.name !== "" ? value.name : value.id,
      ...(typeof value.description === "string" ? { description: value.description } : {}),
      isDefault: value.id === defaultEffort,
      metadata: { wire: value.id },
    });
  }
  return options;
}
