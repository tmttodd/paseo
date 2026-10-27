#!/usr/bin/env node
// Fake `dsh` binary for the DSH provider tests.
//
// Invocation contract (fixed across the provider/harness slices):
//   node test/dsh.mjs <dsh args…>
// The provider spawns `process.execPath` with `[<this file>, ...launch.args]`, so the
// arguments this script receives are exactly the arguments the provider would have
// passed to the real `dsh` executable.
//
// Environment:
//   DSH_FAKE_SCENARIO  scenario name → replays test/fixtures/scenarios/<name>.ndjson
//                      (unset ⇒ "simple"; unknown ⇒ stderr diagnostic + exit 2)
//   DSH_FAKE_SCENARIO_SEQUENCE  comma-separated scenario names picked per turn
//                      (`interrupt,simple` ⇒ turn 1 interrupts, turn 2 is simple);
//                      probe invocations (--version/--dump-config) do not advance it
//   DSH_FAKE_EXIT      process exit code override (default 0)
//   DSH_TEST_LOG       path → append one JSON line per invocation: {"argv":[],"cwd":"","stdin":""}
//   DSH_FAKE_VERSION   value reported by `--version` (default "0.2.1-rc.3")
//   DSH_FAKE_DUMP_CONFIG  "fixture" (default) | "empty" (no stdout, exit 1) | "garbage"
//                      controls what `--dump-config` emits, for discovery-fallback tests
//   DSH_FAKE_READ_STDIN  "1" ⇒ read stdin to EOF before logging (harnesses that close
//                      stdin may use this; the provider never writes stdin, so the
//                      default records an honest empty string instead of blocking)
//
// Built-in sub-commands (checked before scenario replay, matching the real binary):
//   --version      prints the version
//   --dump-config  prints test/fixtures/dump-config.yml (profile composition output)
//
// Scenario file format (one directive per line):
//   {"type":…}            JSON event → stdout (exactly as written)
//   #stderr <text>        <text> → stderr (noise injection)
//   #sleep <ms>           pause before the next directive
//   #wait-signal          emit nothing more; wait for SIGTERM/SIGINT, then write
//                         {"type":"final","text":""} (real dsh behaviour on SIGTERM)
//                         and exit. Safety timeout: 30s.
//   #<anything else>      comment
//
// Token substitution inside JSON lines (raw text replacement, JSON-escaped):
//   $CWD          process.cwd()
//   $SESSION_ID   value of --session-id, else "session-fake-default"
//
// Recommended exit codes per scenario (the harness sets DSH_FAKE_EXIT):
//   simple/tool/noisy/resume/interrupt → 0
//   error/crash/empty-final            → 1
import { appendFileSync, existsSync, readFileSync, writeSync } from "node:fs";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const log = process.env.DSH_TEST_LOG;
// Probe invocations (--version/--dump-config) are not turns; they must not consume a
// sequence slot, so only prior turn invocations are counted.
const priorTurns = countPriorTurns();
const scenario = scenarioForInvocation();
const exitCode = process.env.DSH_FAKE_EXIT === undefined ? 0 : Number(process.env.DSH_FAKE_EXIT);
const fixture = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

function countPriorTurns() {
  if (!log || !existsSync(log)) return 0;
  let count = 0;
  for (const line of readFileSync(log, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      // A torn trailing line from a crashed invocation is not a turn.
      continue;
    }
    const argv = Array.isArray(entry?.argv) ? entry.argv : [];
    if (argv.includes("--dump-config") || argv.includes("--version")) continue;
    count += 1;
  }
  return count;
}

/** `DSH_FAKE_SCENARIO_SEQUENCE=a,b` picks the Nth scenario by prior (non-probe) turn. */
function scenarioForInvocation() {
  const sequence = process.env.DSH_FAKE_SCENARIO_SEQUENCE;
  if (!sequence) return process.env.DSH_FAKE_SCENARIO || "simple";
  const names = sequence
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  if (names.length === 0) return process.env.DSH_FAKE_SCENARIO || "simple";
  return names[Math.min(priorTurns, names.length - 1)] ?? "simple";
}

function out(text) {
  writeSync(1, text);
}

function err(text) {
  writeSync(2, text);
}

function flag(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function readStdin() {
  if (process.env.DSH_FAKE_READ_STDIN !== "1") return "";
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

const stdin = await readStdin();
if (log) appendFileSync(log, `${JSON.stringify({ argv: args, cwd: process.cwd(), stdin })}\n`);

const version = process.env.DSH_FAKE_VERSION || "0.2.1-rc.3";
if (args.includes("--version")) {
  out(`${version}\n`);
  process.exit(exitCode);
}

if (args.includes("--dump-config")) {
  const mode = process.env.DSH_FAKE_DUMP_CONFIG || "fixture";
  if (mode === "fixture") out(readFileSync(fixture("dump-config.yml"), "utf8"));
  else if (mode === "garbage") out("not: [valid\n  yaml at all\n");
  else if (mode !== "empty") {
    err(`dsh: unknown DSH_FAKE_DUMP_CONFIG "${mode}"\n`);
    process.exit(2);
  }
  // An unreadable profile must fail so the provider exercises its fallback catalog.
  if (mode === "empty") process.exit(exitCode === 0 ? 1 : exitCode);
  process.exit(exitCode);
}

const scenarioPath = fixture(`scenarios/${scenario}.ndjson`);
if (!existsSync(scenarioPath)) {
  err(`dsh: unknown fake scenario "${scenario}" (no ${scenarioPath})\n`);
  process.exit(2);
}

const sessionId = flag("--session-id") ?? "session-fake-default";
const substitutions = [
  ["$CWD", JSON.stringify(process.cwd()).slice(1, -1)],
  ["$SESSION_ID", JSON.stringify(sessionId).slice(1, -1)],
];

let finalEmitted = false;
let waiting = false;

function waitForSignal() {
  waiting = true;
  // Signal listeners alone do not keep the Node event loop alive, so hold it open
  // with a ref'd timer; without this the process exits before the signal arrives.
  const keepAlive = setInterval(() => {}, 1_000);
  const finish = (signal) => {
    clearInterval(keepAlive);
    if (!finalEmitted) out(`${JSON.stringify({ type: "final", text: "" })}\n`);
    finalEmitted = true;
    // Real dsh exits 0 after a SIGTERM-initiated wind-down.
    process.exit(signal ? 0 : exitCode);
  };
  process.once("SIGTERM", () => finish("SIGTERM"));
  process.once("SIGINT", () => finish("SIGINT"));
  setTimeout(() => {
    err("dsh: fake interrupt scenario timed out waiting for SIGTERM\n");
    finish(null);
  }, 30_000);
}

for (const raw of readFileSync(scenarioPath, "utf8").split("\n")) {
  const line = raw.trim();
  if (!line) continue;
  if (line.startsWith("#stderr")) {
    err(`${line.slice("#stderr".length).trimStart()}\n`);
    continue;
  }
  if (line.startsWith("#sleep")) {
    const ms = Number(line.slice("#sleep".length).trim());
    await new Promise((resolve) => setTimeout(resolve, Number.isFinite(ms) ? ms : 0));
    continue;
  }
  if (line.startsWith("#wait-signal")) {
    waitForSignal();
    continue;
  }
  if (line.startsWith("#")) continue;
  let payload = line;
  for (const [token, value] of substitutions) payload = payload.split(token).join(value);
  if (payload.includes('"type":"final"')) finalEmitted = true;
  out(`${payload}\n`);
}

// A `#wait-signal` directive keeps the process alive; anything else exits here.
if (!waiting) process.exit(exitCode);
