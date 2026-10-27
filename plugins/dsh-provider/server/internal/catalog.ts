import type {
  ProviderCatalog,
  ProviderLaunch,
  ProviderModel,
  ProviderStatus,
  ProviderThinkingOption,
} from "@getpaseo/plugin/server/provider";
import { probe } from "./process.js";
import { DshError } from "./wire.js";

export const DEFAULT_PROFILE = "headless";

/**
 * Model IDs are `<provider>/<model>` because DSH routes by the pair: the patch
 * row's `provider` is the `llm-pi-ai` provider key and `model` is the model id.
 * Both halves come back out of `resolveSelection`.
 */
export const FALLBACK_MODELS = [
  "homelab/deepseek-v4.1-flash",
  "homelab/nemotron-3.5-super-vl",
] as const;

const EFFORT_LABELS: Readonly<Record<string, string>> = {
  off: "Off",
  none: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

const FALLBACK_THINKING: Readonly<Record<string, readonly string[]>> = {
  "homelab/deepseek-v4.1-flash": ["off", "low", "high", "xhigh", "max"],
  "homelab/nemotron-3.5-super-vl": ["minimal", "low", "medium", "high", "xhigh", "max"],
};

/**
 * The profile a session runs under. Paseo passes it through `providerOptions`;
 * `headless` is DSH's non-interactive profile and the provider default.
 */
export function profileOf(config: { providerOptions?: Readonly<Record<string, unknown>> }): string {
  const configured = config.providerOptions?.profile;
  return typeof configured === "string" && configured.length > 0 ? configured : DEFAULT_PROFILE;
}

export async function getCatalog(
  launch: ProviderLaunch,
  options: { profile?: string; cwd?: string } = {},
): Promise<ProviderCatalog> {
  const profile = options.profile ?? DEFAULT_PROFILE;
  try {
    const output = await probe({
      launch,
      args: ["--profile", profile, "--dump-config"],
      cwd: options.cwd,
    });
    const discovered = catalogFromDump(output);
    if (discovered) return discovered;
  } catch (error) {
    // A missing or half-initialised profile must not take the provider offline.
    if (!(error instanceof DshError)) throw error;
  }
  return fallbackCatalog();
}

export async function getStatus(launch: ProviderLaunch): Promise<ProviderStatus> {
  try {
    const output = (await probe({ launch, args: ["--version"] })).trim();
    const version = output.split(/\s+/).at(-1) ?? "";
    if (!/^\d+\.\d+\.\d+/.test(version))
      return {
        available: false,
        diagnostic: `Could not read the DSH version from \`dsh --version\` (got "${output.slice(0, 80)}").`,
      };
    return { available: true };
  } catch (error) {
    if (!(error instanceof DshError)) throw error;
    return { available: false, diagnostic: error.message };
  }
}

export function validateSelection(
  config: { model?: string; mode?: string; thinkingOption?: string },
  catalog: ProviderCatalog,
): void {
  if (config.mode) throw new DshError("DSH has no modes", "INVALID_MODE");
  const model = config.model
    ? catalog.models.find((candidate) => candidate.id === config.model)
    : undefined;
  if (config.model && !model)
    throw new DshError(`Unknown DSH model: ${config.model}`, "INVALID_MODEL");
  if (!config.thinkingOption) return;
  const options = model ? (model.thinkingOptions ?? []) : (catalog.thinkingOptions ?? []);
  if (!options.some((option) => option.id === config.thinkingOption))
    throw new DshError(
      `DSH has no thinking option "${config.thinkingOption}"${model ? ` for ${model.id}` : ""}`,
      "INVALID_THINKING",
    );
}

export interface ModelSelection {
  provider: string;
  model: string;
  /** Wire value DSH accepts in `reasoningEffort`. */
  reasoningEffort?: string;
}

/**
 * Map a Paseo selection onto the DSH patch row. Returns null when the session
 * chose nothing, in which case DSH keeps its profile default and no patch file
 * is written.
 */
export function resolveSelection(
  config: { model?: string; thinkingOption?: string },
  catalog: ProviderCatalog,
): ModelSelection | null {
  if (config.model === undefined && config.thinkingOption === undefined) return null;
  const modelId = config.model ?? catalog.defaultModel;
  if (!modelId) return null;
  const model = catalog.models.find((candidate) => candidate.id === modelId);
  const halves = splitModelId(modelId, model);
  const effort = config.thinkingOption
    ? effortWireValue(config.thinkingOption, model, catalog)
    : undefined;
  return effort === undefined
    ? { provider: halves.provider, model: halves.model }
    : { provider: halves.provider, model: halves.model, reasoningEffort: effort };
}

/**
 * The `--patch` overlay DSH merges over the profile: the model row when a
 * selection exists, then one `disabled: true` row per caller-supplied plugin id.
 */
export function patchYaml(
  selection: ModelSelection | null,
  disabledPlugins: readonly string[] = [],
): string {
  const lines: string[] = [];
  if (selection) {
    lines.push(
      "- id: agent-default-model",
      "  config:",
      `    provider: ${yamlScalar(selection.provider)}`,
      `    model: ${yamlScalar(selection.model)}`,
    );
    if (selection.reasoningEffort !== undefined)
      lines.push(`    reasoningEffort: ${yamlScalar(selection.reasoningEffort)}`);
  }
  for (const id of disabledPlugins) lines.push(`- id: ${yamlScalar(id)}`, "  disabled: true");
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

/**
 * Profile plugin row ids the caller asked to disable, from
 * `providerOptions.disablePlugins`. Validated here because a bad value would
 * otherwise become a broken patch file that fails every turn.
 */
export function disabledPluginsOf(config: {
  providerOptions?: Readonly<Record<string, unknown>>;
}): string[] {
  const configured = config.providerOptions?.disablePlugins;
  if (configured === undefined) return [];
  if (!Array.isArray(configured) || configured.some((id) => typeof id !== "string" || !id))
    throw new DshError(
      "providerOptions.disablePlugins must be an array of non-empty plugin ids",
      "INVALID_OPTIONS",
    );
  return [...new Set(configured as string[])];
}

/** `providerOptions.patch`: an extra overlay the caller supplies, applied before ours. */
export function callerPatchOf(config: {
  providerOptions?: Readonly<Record<string, unknown>>;
}): string | null {
  const configured = config.providerOptions?.patch;
  if (configured === undefined) return null;
  if (typeof configured !== "string" || !configured)
    throw new DshError("providerOptions.patch must be a non-empty path", "INVALID_OPTIONS");
  return configured;
}

function splitModelId(
  modelId: string,
  model: ProviderModel | undefined,
): { provider: string; model: string } {
  const provider = model?.metadata?.provider;
  const name = model?.metadata?.model;
  if (typeof provider === "string" && typeof name === "string") return { provider, model: name };
  const separator = modelId.indexOf("/");
  if (separator <= 0 || separator === modelId.length - 1)
    throw new DshError(`DSH model "${modelId}" is not in <provider>/<model> form`, "INVALID_MODEL");
  return { provider: modelId.slice(0, separator), model: modelId.slice(separator + 1) };
}

function effortWireValue(
  optionId: string,
  model: ProviderModel | undefined,
  catalog: ProviderCatalog,
): string {
  const options = model?.thinkingOptions ?? catalog.thinkingOptions ?? [];
  const option = options.find((candidate) => candidate.id === optionId);
  const wire = option?.metadata?.wire;
  // `off` maps to the wire value `none`; anything without a wire value is literal.
  return typeof wire === "string" ? wire : optionId;
}

function yamlScalar(value: string): string {
  if (/^[A-Za-z0-9_.\-/]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "''")}'`;
}

// ---------------------------------------------------------------------------
// Catalog construction
// ---------------------------------------------------------------------------

interface DumpModel {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  efforts: Array<{ id: string; wire: string }>;
}

interface DumpProvider {
  name: string;
  models: Map<string, DumpModel>;
}

interface DumpRoute {
  provider: string;
  model: string;
  reasoningEffort?: string;
}

export interface DumpConfig {
  providers: DumpProvider[];
  route: DumpRoute | null;
}

export function catalogFromDump(source: string): ProviderCatalog | null {
  const dump = readDumpConfig(source);
  const models: ProviderModel[] = [];
  const thinking: ProviderThinkingOption[] = [];
  const seenThinking: Record<string, true> = {};
  const routeModelId = dump.route ? `${dump.route.provider}/${dump.route.model}` : undefined;
  for (const provider of dump.providers) {
    for (const model of provider.models.values()) {
      const id = `${provider.name}/${model.id}`;
      const options = model.efforts.map((effort) => ({
        id: effort.id,
        label: EFFORT_LABELS[effort.id] ?? effort.id,
        metadata: { wire: effort.wire },
      }));
      for (const option of options) {
        if (seenThinking[option.id]) continue;
        seenThinking[option.id] = true;
        thinking.push(option);
      }
      models.push({
        id,
        label: model.name ?? id,
        isDefault: id === routeModelId,
        contextWindowMaxTokens: model.contextWindow,
        thinkingOptions: options.length > 0 ? options : undefined,
        metadata: {
          provider: provider.name,
          model: model.id,
          ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
        },
      });
    }
  }
  if (models.length === 0) return null;
  const defaultModel = models.find((model) => model.isDefault)?.id ?? models[0].id;
  const defaultThinkingOption = dump.route?.reasoningEffort
    ? optionIdForWire(dump.route.reasoningEffort, defaultModel, models)
    : undefined;
  return {
    models,
    modes: [],
    thinkingOptions: thinking,
    defaultModel,
    ...(defaultThinkingOption === undefined ? {} : { defaultThinkingOption }),
  };
}

function optionIdForWire(
  wire: string,
  modelId: string,
  models: readonly ProviderModel[],
): string | undefined {
  const options = models.find((model) => model.id === modelId)?.thinkingOptions ?? [];
  const match = options.find((option) => option.metadata?.wire === wire);
  if (match) return match.id;
  return options.some((option) => option.id === wire) ? wire : undefined;
}

export function fallbackCatalog(): ProviderCatalog {
  const models: ProviderModel[] = FALLBACK_MODELS.map((id, index) => {
    const [provider, model] = id.split("/") as [string, string];
    const efforts = FALLBACK_THINKING[id] ?? [];
    return {
      id,
      label: model,
      isDefault: index === 0,
      thinkingOptions: efforts.map((effort) => ({
        id: effort,
        label: EFFORT_LABELS[effort] ?? effort,
        metadata: { wire: effort === "off" ? "none" : effort },
      })),
      metadata: { provider, model },
    };
  });
  const thinking: ProviderThinkingOption[] = [];
  const seen: Record<string, true> = {};
  for (const model of models)
    for (const option of model.thinkingOptions ?? []) {
      if (seen[option.id]) continue;
      seen[option.id] = true;
      thinking.push(option);
    }
  return {
    models,
    modes: [],
    thinkingOptions: thinking,
    defaultModel: FALLBACK_MODELS[0],
    defaultThinkingOption: "max",
  };
}

// ---------------------------------------------------------------------------
// Narrow YAML subset reader
//
// The plugin may not depend on a YAML library, and `--dump-config` output is a
// small, regular subset: indentation-nested mappings and sequences, single- and
// double-quoted scalars, `!!tag` prefixes, and block scalars. Anything outside
// that subset degrades to a string instead of failing the read.
// ---------------------------------------------------------------------------

type YamlValue = string | number | boolean | null | YamlValue[] | { [key: string]: YamlValue };

interface YamlLine {
  indent: number;
  text: string;
}

interface Cursor {
  index: number;
}

export function readDumpConfig(source: string): DumpConfig {
  const parsed = parseYamlSubset(source);
  const rows = asArray(parsed);
  const providers = new Map<string, DumpProvider>();
  let route: DumpRoute | null = null;
  for (const row of rows) {
    const record = asRecord(row);
    if (!record) continue;
    const id = asString(record.id);
    const config = asRecord(record.config);
    if (!config) continue;
    if (id === "llm-pi-ai") collectProviders(asRecord(config.providers), providers);
    if (id === "agent-default-model") {
      const provider = asString(config.provider);
      const model = asString(config.model);
      if (provider && model) {
        const effort = asString(config.reasoningEffort);
        route = effort ? { provider, model, reasoningEffort: effort } : { provider, model };
      }
    }
  }
  return { providers: [...providers.values()], route };
}

/** The `reasoningEfforts` map as option-id → wire-value pairs, in declaration order. */
function collectEfforts(
  raw: Record<string, YamlValue> | null,
): Array<{ id: string; wire: string }> {
  const efforts: Array<{ id: string; wire: string }> = [];
  for (const [optionId, wire] of Object.entries(raw ?? {})) {
    const wireValue = asString(wire);
    if (wireValue) efforts.push({ id: optionId, wire: wireValue });
  }
  return efforts;
}

function collectProviders(
  raw: Record<string, YamlValue> | null,
  into: Map<string, DumpProvider>,
): void {
  if (!raw) return;
  for (const [name, value] of Object.entries(raw)) {
    const record = asRecord(value);
    if (!record) continue;
    const provider = into.get(name) ?? { name, models: new Map<string, DumpModel>() };
    into.set(name, provider);
    for (const entry of asArray(record.models)) {
      const model = asRecord(entry);
      const id = model ? asString(model.id) : null;
      if (!model || !id) continue;
      const efforts = collectEfforts(asRecord(model.reasoningEfforts));
      provider.models.set(id, {
        id,
        name: asString(model.name) ?? undefined,
        contextWindow: typeof model.contextWindow === "number" ? model.contextWindow : undefined,
        maxTokens: typeof model.maxTokens === "number" ? model.maxTokens : undefined,
        efforts,
      });
    }
  }
}

export function parseYamlSubset(source: string): YamlValue {
  const lines: YamlLine[] = [];
  for (const raw of source.split(/\r?\n/)) {
    const trimmed = raw.trimEnd();
    const text = trimmed.trimStart();
    if (!text || text.startsWith("#")) continue;
    lines.push({ indent: trimmed.length - text.length, text });
  }
  if (lines.length === 0) return null;
  const cursor: Cursor = { index: 0 };
  return parseBlock(lines, cursor, lines[0].indent);
}

function parseBlock(lines: YamlLine[], cursor: Cursor, indent: number): YamlValue {
  const line = lines[cursor.index];
  if (!line) return null;
  if (isSequenceLine(line.text)) return parseSequence(lines, cursor, indent);
  return parseMapping(lines, cursor, indent);
}

function parseSequence(lines: YamlLine[], cursor: Cursor, indent: number): YamlValue[] {
  const items: YamlValue[] = [];
  while (true) {
    const line = lines[cursor.index];
    if (!line || line.indent !== indent || !isSequenceLine(line.text)) break;
    const remainder = line.text.slice(1).trim();
    if (remainder === "") {
      cursor.index += 1;
      const next = lines[cursor.index];
      items.push(next && next.indent > indent ? parseBlock(lines, cursor, next.indent) : null);
      continue;
    }
    if (splitEntry(remainder)) {
      // Re-anchor the inline first entry so it parses as an ordinary mapping.
      line.text = remainder;
      line.indent = indent + 2;
      items.push(parseMapping(lines, cursor, indent + 2));
      continue;
    }
    items.push(parseScalar(remainder));
    cursor.index += 1;
  }
  return items;
}

function parseMapping(
  lines: YamlLine[],
  cursor: Cursor,
  indent: number,
): Record<string, YamlValue> {
  const result: Record<string, YamlValue> = {};
  while (true) {
    const line = lines[cursor.index];
    if (!line || line.indent !== indent || isSequenceLine(line.text)) break;
    const entry = splitEntry(line.text);
    if (!entry) break;
    cursor.index += 1;
    if (entry.value === "") {
      const next = lines[cursor.index];
      result[entry.key] =
        next && next.indent > indent ? parseBlock(lines, cursor, next.indent) : null;
      continue;
    }
    if (isBlockScalar(entry.value)) {
      result[entry.key] = consumeBlockScalar(lines, cursor, indent, entry.value);
      continue;
    }
    result[entry.key] = parseScalar(entry.value);
  }
  return result;
}

function isSequenceLine(text: string): boolean {
  return text === "-" || text.startsWith("- ");
}

function splitEntry(text: string): { key: string; value: string } | null {
  if (text.startsWith("'") || text.startsWith('"')) {
    const quote = text[0];
    const close = text.indexOf(quote, 1);
    if (close < 0) return null;
    const rest = text.slice(close + 1).trimStart();
    if (!rest.startsWith(":")) return null;
    return { key: unquote(text.slice(0, close + 1)), value: rest.slice(1).trim() };
  }
  const colon = text.indexOf(":");
  if (colon <= 0) return null;
  const after = text.slice(colon + 1);
  if (after !== "" && !after.startsWith(" ")) return null;
  const key = text.slice(0, colon).trim();
  if (!key || /\s/.test(key)) return null;
  return { key: unquote(key), value: after.trim() };
}

function isBlockScalar(value: string): boolean {
  return /^(?:!!\S+\s+)?[|>][+-]?\d*$/.test(value);
}

function consumeBlockScalar(
  lines: YamlLine[],
  cursor: Cursor,
  indent: number,
  indicator: string,
): string {
  const folded = indicator.includes(">");
  const body: string[] = [];
  while (true) {
    const line = lines[cursor.index];
    if (!line || line.indent <= indent) break;
    body.push(line.text);
    cursor.index += 1;
  }
  return body.join(folded ? " " : "\n");
}

function parseScalar(raw: string): YamlValue {
  const text = stripTag(raw).trim();
  if (text === "" || text === "null" || text === "~") return null;
  if (text === "true") return true;
  if (text === "false") return false;
  if (text === "[]") return [];
  if (text === "{}") return {};
  if (text.startsWith("[") && text.endsWith("]"))
    return text
      .slice(1, -1)
      .split(",")
      .map((item) => parseScalar(item))
      .filter((item) => item !== null);
  if (text.startsWith("'") || text.startsWith('"')) return unquote(text);
  const withoutComment = stripInlineComment(text);
  if (/^-?\d+$/.test(withoutComment)) return Number.parseInt(withoutComment, 10);
  if (/^-?\d+\.\d+$/.test(withoutComment)) return Number.parseFloat(withoutComment);
  return withoutComment;
}

function stripTag(text: string): string {
  const match = /^!!\S+\s+(.*)$/.exec(text);
  return match ? match[1] : text;
}

function stripInlineComment(text: string): string {
  const marker = text.indexOf(" #");
  return marker < 0 ? text : text.slice(0, marker).trimEnd();
}

function unquote(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'"))
    return trimmed.slice(1, -1).replaceAll("''", "'");
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"'))
    return trimmed.slice(1, -1).replaceAll('\\"', '"');
  return trimmed;
}

function asRecord(value: YamlValue | undefined): Record<string, YamlValue> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value;
}

function asArray(value: YamlValue | undefined): YamlValue[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: YamlValue | undefined): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return null;
}
