import type {
  ProviderCatalog,
  ProviderMode,
  ProviderModel,
  ProviderSetting,
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

/** The Paseo settings toggle that drives DSH's plan mode (the app checks this id first). */
export const PLAN_SETTING_ID = "plan_mode";

/**
 * DSH ships presets without a display name (`standard`, `ptc`, `cordis`,
 * `minimal`); the web UI labels them Standard, PTC, Creator and Minimal. A
 * preset that publishes a name wins over this map, and anything else falls
 * back to its id.
 */
const PRESET_LABELS: Readonly<Record<string, string>> = {
  standard: "Standard",
  ptc: "PTC",
  cordis: "Creator",
  minimal: "Minimal",
};

export interface PresetEntry {
  id: string;
  label: string;
  description?: string;
  isDefault: boolean;
}

/** Parse `agentPresets/list`: `{presets:[{id, isDefault, name?, description?, broken?}]}`. */
export function presetsFromHost(raw: unknown): PresetEntry[] {
  if (!isRecord(raw)) return [];
  const list = Array.isArray(raw.presets) ? raw.presets : [];
  const presets: PresetEntry[] = [];
  for (const entry of list) {
    if (!isRecord(entry) || typeof entry.id !== "string" || entry.id === "") continue;
    // A preset the host itself cannot compose is not offered: selecting it would
    // fail at the first turn.
    if (typeof entry.broken === "string" && entry.broken !== "") continue;
    presets.push({
      id: entry.id,
      label:
        typeof entry.name === "string" && entry.name !== ""
          ? entry.name
          : (PRESET_LABELS[entry.id] ?? entry.id),
      ...(typeof entry.description === "string" && entry.description !== ""
        ? { description: entry.description }
        : {}),
      isDefault: entry.isDefault === true,
    });
  }
  return presets;
}

/** Presets → Paseo modes, keeping the host's order and naming the current one. */
export function modesFromPresets(
  presets: readonly PresetEntry[],
  current: string | undefined,
): { modes: ProviderMode[]; mode: string | undefined } {
  const modes = presets.map((preset) => ({
    id: preset.id,
    label: preset.label,
    ...(preset.description === undefined ? {} : { description: preset.description }),
  }));
  const mode =
    current !== undefined && presets.some((preset) => preset.id === current)
      ? current
      : presets.find((preset) => preset.isDefault)?.id;
  return { modes, mode };
}

/** The plan-mode toggle: DSH's plan state is a switch, not a preset. */
export function planSetting(active: boolean): ProviderSetting {
  return {
    type: "toggle",
    id: PLAN_SETTING_ID,
    label: "Plan",
    description: "Explore and design before implementing",
    value: active,
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
