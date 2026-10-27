#!/usr/bin/env node
// Capture real `dsh` output into test/fixtures/real/ with provenance.
//
//   node test/capture.mjs --scenario simple
//   node test/capture.mjs --scenario tool|resume|interrupt|error
//
// Every capture records the binary path, `dsh --version`, profile, UTC timestamp,
// exact argv per invocation, the overlay that made the turn survivable, exit codes,
// and event counts. `PROVENANCE.live.md` is regenerated from the `.provenance.json`
// sidecars, so adding a scenario never rewrites another scenario's provenance.
//
// This script fails loudly (exit 2) when `dsh` is absent: a capture that silently
// produced nothing would look like a passing fixture refresh.
//
// Note: `test/fixtures/PROVENANCE.md` is owned by the fixture suite. This script
// never writes it — live captures go to PROVENANCE.live.md.
//
// Capture files are prefixed `live-` so a refresh can never overwrite the verbatim
// probe copies the fixture suite ships (out2.ndjson, tool.ndjson, resume.ndjson, ...).

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_PROFILE,
  DISABLED_PLUGINS,
  checkContract,
  launcherArgs,
  makeScratchDir,
  probeBinary,
  removeDir,
  resolveBinary,
  runDsh,
  writeOverlay,
} from "./dsh-runtime.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..");
const DEFAULT_OUT = join(HERE, "fixtures", "real");
const SCENARIOS = new Set(["simple", "tool", "resume", "interrupt", "error"]);

const TASKS = {
  simple: "Reply with exactly: dsh-capture-simple",
  tool: "Run the shell command `echo dsh-capture-tool` and report its exact output.",
  resumeTurn1: "Reply with exactly: dsh-capture-resume",
  resumeTurn2: "In one short sentence, what did I ask you to reply with?",
  // A long shell call keeps the turn open so SIGTERM lands mid-turn deterministically.
  interrupt: "Run the shell command `sleep 20` and then report its exact output.",
  interruptResume: "Did you finish the task? Answer in one short sentence.",
  error: "say hi",
};

const BAD_MODEL = { provider: "nope-not-a-provider", model: "nope-not-a-model" };

function parseArgs(argv) {
  const options = {
    scenario: "simple",
    profile: DEFAULT_PROFILE,
    out: DEFAULT_OUT,
    interruptAfterMs: 3_500,
    timeoutMs: 240_000,
    keep: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (value === undefined) {
        console.error(`capture: ${arg} needs a value`);
        process.exit(2);
      }
      index += 1;
      return value;
    };
    switch (arg) {
      case "--scenario":
        options.scenario = next();
        break;
      case "--profile":
        options.profile = next();
        break;
      case "--out":
        options.out = next();
        break;
      case "--interrupt-after":
        options.interruptAfterMs = Number(next());
        break;
      case "--timeout":
        options.timeoutMs = Number(next()) * 1000;
        break;
      case "--keep":
        options.keep = true;
        break;
      case "--help":
      case "-h":
        console.log(
          [
            "Usage: node test/capture.mjs [--scenario <name>] [--profile <name>] [--out <dir>]",
            "                              [--interrupt-after <ms>] [--timeout <seconds>] [--keep]",
            "",
            `  --scenario  one of: ${[...SCENARIOS].join(", ")} (default simple)`,
            "  --profile   DSH profile to boot (default headless)",
            "  --out       fixture directory (default test/fixtures/real)",
            "  --keep      keep the scratch cwd instead of deleting it",
            "",
            "Env: DSH_BIN overrides the binary path (default `dsh`).",
          ].join("\n"),
        );
        process.exit(0);
        break;
      default:
        console.error(`capture: unknown argument \`${arg}\``);
        process.exit(2);
    }
  }
  if (!SCENARIOS.has(options.scenario)) {
    console.error(
      `capture: unknown scenario \`${options.scenario}\` (expected ${[...SCENARIOS].join(", ")})`,
    );
    process.exit(2);
  }
  return options;
}

function writeText(path, text) {
  writeFileSync(path, text.endsWith("\n") || text === "" ? text : `${text}\n`, "utf8");
}

// Generated artifacts are committed, so they must match the repo's formatter or
// `npm run format:check` goes red on files nobody hand-edited. Best-effort: a machine
// without oxfmt still gets correct captures, just unformatted ones.
function formatGenerated(paths) {
  const local = join(REPO_ROOT, "node_modules", ".bin", "oxfmt");
  const bin = existsSync(local) ? local : "npx";
  const args = existsSync(local) ? paths : ["oxfmt", ...paths];
  const result = spawnSync(bin, args, { cwd: REPO_ROOT, encoding: "utf8", timeout: 60_000 });
  if (result.error || result.status !== 0) {
    console.log(
      `capture: note — could not run oxfmt on generated files (${result.error?.message || `exit ${result.status}`})`,
    );
  }
}

/** One invocation: run, persist stdout/stderr, describe it. */
async function captureTurn({
  bin,
  profile,
  overlays,
  cwd,
  appArgs,
  outDir,
  baseName,
  timeoutMs,
  interruptAfterMs = null,
}) {
  const run = await runDsh({
    bin,
    args: launcherArgs({ profile, overlays, appArgs }),
    cwd,
    timeoutMs,
    interruptAfterMs,
  });
  const stdoutFile = `${baseName}.ndjson`;
  const stderrFile = `${baseName}.stderr.txt`;
  writeText(join(outDir, stdoutFile), run.stdout);
  writeText(join(outDir, stderrFile), run.stderr);
  const sessionEvent = run.events.find((event) => event.type === "session");
  return {
    run,
    record: {
      argv: run.argv,
      exitCode: run.exitCode,
      signal: run.signal,
      interrupted: run.interrupted,
      durationMs: run.durationMs,
      eventCount: run.events.length,
      eventTypes: [...new Set(run.events.map((event) => event.type))],
      sessionId: sessionEvent ? sessionEvent.sessionId : null,
      stdoutFile,
      stderrFile,
      malformedLines: run.malformed.length,
    },
  };
}

function regenerateProvenance(outDir, dshInfo) {
  const sidecars = readdirSync(outDir)
    .filter((name) => name.endsWith(".provenance.json"))
    .sort();
  const entries = sidecars.map((name) => ({
    name,
    data: JSON.parse(readFileSync(join(outDir, name), "utf8")),
  }));

  const lines = [
    "# Live DSH captures — provenance",
    "",
    "Generated by `node test/capture.mjs`. Do not hand-edit; re-run the capture.",
    "The sibling `PROVENANCE.md` describes the fixture suite; this file covers only",
    "captures taken from the real binary.",
    "",
    `Binary: \`${dshInfo.bin}\` — \`dsh --version\` → \`${dshInfo.version}\``,
    "",
    "| Scenario | Captured (UTC) | Profile | Invocations | Exit codes | Events | Files |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const { data } of entries) {
    const exits = data.invocations.map((invocation) => invocation.exitCode).join(", ");
    const events = data.invocations.reduce((sum, invocation) => sum + invocation.eventCount, 0);
    const files = data.invocations.map((invocation) => `\`${invocation.stdoutFile}\``).join("<br>");
    lines.push(
      `| ${data.scenario} | ${data.capturedAt} | ${data.profile} | ${data.invocations.length} | ` +
        `${exits} | ${events} | ${files} |`,
    );
  }
  lines.push("");

  for (const { data } of entries) {
    lines.push(`## ${data.scenario}`, "");
    lines.push(`- Captured: ${data.capturedAt}`);
    lines.push(`- Binary: \`${data.dsh.bin}\` (${data.dsh.version})`);
    lines.push(`- Profile: \`${data.profile}\``);
    lines.push(`- Working directory: \`${data.cwd}\``);
    lines.push(
      `- Overlay: \`${data.overlay.fileName}\` sha256 \`${data.overlay.sha256}\`` +
        (data.overlay.modelOverride
          ? ` (model override ${data.overlay.modelOverride.provider}/${data.overlay.modelOverride.model})`
          : ` (disables ${data.overlay.disabledPlugins.join(", ")})`),
    );
    lines.push("");
    lines.push("Overlay contents:");
    lines.push("");
    lines.push("```yaml");
    lines.push(data.overlay.text.trimEnd());
    lines.push("```");
    lines.push("");
    for (const [index, invocation] of data.invocations.entries()) {
      lines.push(`### Invocation ${index + 1}`, "");
      lines.push("```");
      lines.push(invocation.argv.map((arg) => JSON.stringify(arg)).join(" "));
      lines.push("```");
      lines.push("");
      lines.push(
        `- Exit: ${invocation.exitCode}` +
          (invocation.signal ? ` (signal ${invocation.signal})` : "") +
          `, ${invocation.durationMs}ms, ${invocation.eventCount} events` +
          ` (${invocation.eventTypes.join(", ")})`,
      );
      lines.push(`- Session: \`${invocation.sessionId}\``);
      lines.push(`- stdout: \`${invocation.stdoutFile}\`, stderr: \`${invocation.stderrFile}\``);
      if (invocation.notes?.length) {
        for (const note of invocation.notes) lines.push(`- ${note}`);
      }
      lines.push("");
    }
    if (data.notes?.length) {
      lines.push("Notes:");
      lines.push("");
      for (const note of data.notes) lines.push(`- ${note}`);
      lines.push("");
    }
  }

  writeText(join(outDir, "PROVENANCE.live.md"), lines.join("\n"));
  return sidecars.length;
}

// oxlint-disable-next-line complexity -- one linear dispatch per capture scenario; splitting hides the sequence.
async function main() {
  const options = parseArgs(process.argv.slice(2));
  const binary = probeBinary(resolveBinary());
  if (!binary.available) {
    console.error(`capture: FAIL — ${binary.reason}`);
    console.error(
      "capture: real fixtures need the DSH binary; install `dsh` or set DSH_BIN. " +
        "No fixture was written.",
    );
    process.exit(2);
  }

  mkdirSync(options.out, { recursive: true });
  const scratch = makeScratchDir("dsh-capture-");
  const useBadModel = options.scenario === "error";
  const overlay = writeOverlay(scratch, { modelOverride: useBadModel ? BAD_MODEL : null });
  const overlays = [overlay.path];
  const notes = [];

  const capturedAt = new Date().toISOString();
  const provenance = {
    scenario: options.scenario,
    capturedAt,
    dsh: { bin: binary.bin, version: binary.version },
    profile: options.profile,
    cwd: scratch,
    overlay: {
      fileName: overlay.path.split("/").pop(),
      sha256: overlay.sha256,
      text: overlay.text,
      disabledPlugins: [...DISABLED_PLUGINS],
      modelOverride: useBadModel ? BAD_MODEL : null,
    },
    invocations: [],
    notes,
  };

  const base = {
    bin: binary.bin,
    profile: options.profile,
    overlays,
    cwd: scratch,
    outDir: options.out,
    timeoutMs: options.timeoutMs,
  };
  const problems = [];
  const check = (label, run, expect) => {
    const result = checkContract(run, { expect, label });
    problems.push(...result.failures);
    for (const warning of result.warnings) console.log(`  WARN ${label}: ${warning}`);
    return result;
  };

  try {
    if (options.scenario === "simple" || options.scenario === "tool") {
      const task = TASKS[options.scenario];
      const { run, record } = await captureTurn({
        ...base,
        appArgs: ["--json", task],
        baseName: `live-${options.scenario}`,
      });
      provenance.invocations.push(record);
      check(options.scenario, run, "completed");
      if (options.scenario === "tool" && !run.events.some((event) => event.type === "tool_call")) {
        problems.push(
          "tool: capture contains no tool_call; the model answered without using the shell",
        );
      }
    } else if (options.scenario === "resume") {
      const first = await captureTurn({
        ...base,
        appArgs: ["--json", TASKS.resumeTurn1],
        baseName: "live-resume-1",
      });
      provenance.invocations.push(first.record);
      check("resume turn 1", first.run, "completed");
      const sessionId = first.record.sessionId;
      if (!sessionId) {
        problems.push("resume: turn 1 emitted no session id, cannot resume");
      } else {
        const second = await captureTurn({
          ...base,
          appArgs: ["--json", "--session-id", sessionId, TASKS.resumeTurn2],
          baseName: "live-resume-2",
        });
        provenance.invocations.push(second.record);
        check("resume turn 2", second.run, "completed");
        if (second.record.sessionId !== sessionId) {
          problems.push(
            `resume: session id changed across --session-id (${sessionId} → ${second.record.sessionId})`,
          );
        }
        const turns = second.run.events
          .filter((event) => event.type === "status" && event.phase === "turn_start")
          .map((event) => event.turn);
        if (!turns.includes(2)) {
          problems.push(
            `resume: expected turn 2 on the resumed session, saw ${JSON.stringify(turns)}`,
          );
        }
        notes.push(`Turn 2 reuses the native session \`${sessionId}\` and reports turn number 2.`);
      }
    } else if (options.scenario === "interrupt") {
      const first = await captureTurn({
        ...base,
        appArgs: ["--json", TASKS.interrupt],
        baseName: "live-interrupt",
        interruptAfterMs: options.interruptAfterMs,
      });
      provenance.invocations.push(first.record);
      check("interrupt", first.run, "interrupt");
      if (first.run.events.some((event) => event.type === "status" && event.phase === "turn_end")) {
        problems.push(
          `interrupt: the turn completed before SIGTERM (${options.interruptAfterMs}ms); raise --interrupt-after`,
        );
      }
      const sessionId = first.record.sessionId;
      const finalEvent = first.run.events.find((event) => event.type === "final");
      notes.push(
        "SIGTERM mid-turn: the process exits 0 and emits no `turn_end`, so exit code alone must not be read as success.",
      );
      notes.push(
        finalEvent
          ? "The signal landed between steps, so `final` was emitted with " +
              (finalEvent.text === ""
                ? "empty text."
                : `partial text (${finalEvent.text.length} chars).`)
          : `The signal landed inside a tool call, so no \`final\` was emitted at all — the stream ` +
              `ends at the in-flight \`${first.run.events.at(-1).type}\`. The provider must treat child exit as the end of an interrupted turn.`,
      );
      if (!sessionId) {
        problems.push(
          "interrupt: no session id in the interrupted stream, cannot prove resumability",
        );
      } else {
        const second = await captureTurn({
          ...base,
          appArgs: ["--json", "--session-id", sessionId, TASKS.interruptResume],
          baseName: "live-interrupt-resume",
        });
        provenance.invocations.push(second.record);
        check("interrupt resume", second.run, "completed");
        if (second.record.sessionId !== sessionId) {
          problems.push(
            `interrupt resume: session id changed (${sessionId} → ${second.record.sessionId})`,
          );
        }
        notes.push(
          `The interrupted session \`${sessionId}\` resumes and completes on the next turn.`,
        );
      }
    } else if (options.scenario === "error") {
      const { run, record } = await captureTurn({
        ...base,
        appArgs: ["--json", TASKS.error],
        baseName: "live-error",
      });
      provenance.invocations.push(record);
      check("error", run, "error");
      const reason = run.events.find(
        (event) => event.type === "status" && event.phase === "turn_end",
      )?.reason;
      notes.push(
        `Deterministic failure: the overlay points agent-default-model at ` +
          `\`${BAD_MODEL.provider}/${BAD_MODEL.model}\`, so the turn ends with ` +
          `\`reason.kind = "${reason?.kind}"\`${reason?.error?.code ? ` and code \`${reason.error.code}\`` : ""}.`,
      );
    }

    writeText(
      join(options.out, `live-${options.scenario}.provenance.json`),
      JSON.stringify(provenance, null, 2),
    );
    const sidecarCount = regenerateProvenance(options.out, binary);
    formatGenerated([
      join(options.out, `live-${options.scenario}.provenance.json`),
      join(options.out, "PROVENANCE.live.md"),
    ]);

    console.log(
      `capture: scenario=${options.scenario} binary=${binary.bin} (${binary.version}) profile=${options.profile}`,
    );
    for (const invocation of provenance.invocations) {
      console.log(
        `  ${invocation.stdoutFile}: exit ${invocation.exitCode}, ${invocation.eventCount} events, ` +
          `session ${invocation.sessionId}`,
      );
    }
    console.log(
      `  provenance sidecars in ${relative(process.cwd(), options.out) || "."}: ${sidecarCount}`,
    );
    if (problems.length > 0) {
      console.error(`capture: FAIL — ${problems.length} contract problem(s):`);
      for (const problem of problems) console.error(`  - ${problem}`);
      console.error("capture: the raw files were still written so the deviation is inspectable.");
      process.exit(1);
    }
    console.log("capture: OK");
  } finally {
    if (options.keep) console.log(`capture: kept scratch dir ${scratch}`);
    else removeDir(scratch);
  }
}

await main();
