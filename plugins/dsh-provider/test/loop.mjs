#!/usr/bin/env node
// test → fix → iterate loop for the DSH provider.
//
//   node test/loop.mjs                       # unit + live, up to 3 attempts, no fixer
//   node test/loop.mjs --no-fix --max 1      # single red run, write the evidence, stop
//   node test/loop.mjs --fix-cmd 'omp run "Fix the DSH provider failures in $DSH_LOOP_FAILURES"'
//   node test/loop.mjs --suite live --require-live
//
// Behaviour:
//   1. Run the selected suite(s). Unit = `npx vitest run plugins/dsh-provider` from the
//      repo root; live = `node test/live.mjs` from the plugin directory.
//   2. Green → write summary.md + evidence.md under test/loop-runs/<UTC-stamp>/ and exit 0.
//   3. Red → write attempt-<n>.md (command, exit code, distilled failures, output tail),
//      then run the fixer with DSH_LOOP_FAILURES/DSH_LOOP_ATTEMPT/DSH_LOOP_MAX set.
//      With no fixer configured, print the attempt path and stop with exit 1.
//   4. Re-run, bounded by --max. Still red at the end → exit 1 naming the failures.
//
// Run directories are append-only: nothing already written under test/loop-runs is ever
// deleted or rewritten, so the history of a debugging session survives the fix.
//
// Exit codes: 0 green, 1 still red, 2 usage error, 3 environment not ready.
// Exit 3 exists so a missing `@getpaseo/plugin` dist or a missing test file never gets
// reported as a test failure — sending a fixer after a phantom bug wastes the loop.

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = resolve(HERE, "..");
const REPO_ROOT = resolve(HERE, "..", "..", "..");
const RUNS_DIR = join(HERE, "loop-runs");
const BUILD_COMMAND = "npm run build:protocol && npm run build:client && npm run build:plugin";
const PROVIDER_TEST_GLOB = "plugins/dsh-provider";

const EXIT_GREEN = 0;
const EXIT_RED = 1;
const EXIT_USAGE = 2;
const EXIT_ENVIRONMENT = 3;

function parseArgs(argv) {
  const options = {
    max: 3,
    suite: "all",
    fixCmd: null,
    requireLive: false,
    allowBuild: true,
    unitCmd: null,
    liveCmd: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (value === undefined) {
        console.error(`loop: ${arg} needs a value`);
        process.exit(EXIT_USAGE);
      }
      index += 1;
      return value;
    };
    switch (arg) {
      case "--max":
        options.max = Number(next());
        if (!Number.isInteger(options.max) || options.max < 1) {
          console.error("loop: --max must be a positive integer");
          process.exit(EXIT_USAGE);
        }
        break;
      case "--suite": {
        const value = next();
        if (!["unit", "live", "all"].includes(value)) {
          console.error("loop: --suite must be unit, live, or all");
          process.exit(EXIT_USAGE);
        }
        options.suite = value;
        break;
      }
      case "--fix-cmd":
        options.fixCmd = next();
        break;
      case "--no-fix":
        options.fixCmd = null;
        break;
      case "--require-live":
        options.requireLive = true;
        break;
      case "--no-build":
        options.allowBuild = false;
        break;
      case "--unit-cmd":
        options.unitCmd = next();
        break;
      case "--live-cmd":
        options.liveCmd = next();
        break;
      case "--help":
      case "-h":
        console.log(
          [
            "Usage: node test/loop.mjs [options]",
            "",
            "  --max <n>          maximum attempts (default 3)",
            "  --suite <name>     unit | live | all (default all)",
            "  --fix-cmd <cmd>    shell command run after a red attempt; receives",
            "                     DSH_LOOP_FAILURES, DSH_LOOP_ATTEMPT, DSH_LOOP_MAX",
            "  --no-fix           never run a fixer; stop after the first red attempt",
            "  --require-live     pass --require to live.mjs (missing dsh is a failure)",
            "  --no-build         do not build missing @getpaseo dist packages; fail instead",
            "  --unit-cmd <cmd>   override the unit command (run from the repo root)",
            "  --live-cmd <cmd>   override the live command (run from the plugin dir)",
            "",
            `Artifacts: ${relative(process.cwd(), RUNS_DIR) || "test/loop-runs"}/<UTC-stamp>/`,
            "Exit: 0 green, 1 still red, 2 usage, 3 environment not ready.",
          ].join("\n"),
        );
        process.exit(0);
        break;
      default:
        console.error(`loop: unknown argument \`${arg}\``);
        process.exit(EXIT_USAGE);
    }
  }
  return options;
}

function utcStamp(date = new Date()) {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
}

/** Create a fresh, never-reused run directory. */
function createRunDir() {
  mkdirSync(RUNS_DIR, { recursive: true });
  const base = utcStamp();
  for (let suffix = 0; suffix < 100; suffix += 1) {
    const name = suffix === 0 ? base : `${base}-${suffix}`;
    const dir = join(RUNS_DIR, name);
    if (!existsSync(dir)) {
      mkdirSync(dir);
      return { dir, name };
    }
  }
  throw new Error(`loop: could not allocate a run directory under ${RUNS_DIR}`);
}

function writeText(path, text) {
  writeFileSync(path, text.endsWith("\n") ? text : `${text}\n`, "utf8");
}

// ---------------------------------------------------------------------------------------
// Suite execution
// ---------------------------------------------------------------------------------------

function runCommand({ label, command, args, cwd, env = {}, display }) {
  return new Promise((resolvePromise) => {
    const startedAt = Date.now();
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks = [];
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => chunks.push(chunk));
    child.on("error", (error) => {
      resolvePromise({
        label,
        display: display || [command, ...args].join(" "),
        cwd,
        output: `spawn failed: ${error.message}`,
        exitCode: 127,
        durationMs: Date.now() - startedAt,
      });
    });
    child.on("close", (exitCode) => {
      resolvePromise({
        label,
        display: display || [command, ...args].join(" "),
        cwd,
        output: Buffer.concat(chunks).toString("utf8"),
        exitCode,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}

function suiteCommands(options) {
  const suites = [];
  if (options.suite === "unit" || options.suite === "all") {
    suites.push({
      name: "unit",
      command: "npx",
      args: ["vitest", "run", PROVIDER_TEST_GLOB],
      cwd: REPO_ROOT,
      display: options.unitCmd || `npx vitest run ${PROVIDER_TEST_GLOB}`,
      shellOverride: options.unitCmd,
    });
  }
  if (options.suite === "live" || options.suite === "all") {
    const args = [join(HERE, "live.mjs")];
    if (options.requireLive) args.push("--require");
    suites.push({
      name: "live",
      command: process.execPath,
      args,
      cwd: PLUGIN_DIR,
      display: options.liveCmd || `node test/live.mjs${options.requireLive ? " --require" : ""}`,
      shellOverride: options.liveCmd,
    });
  }
  return suites;
}

async function runSuite(suite) {
  if (suite.shellOverride) {
    const result = await runCommand({
      label: suite.name,
      command: "sh",
      args: ["-c", suite.shellOverride],
      cwd: suite.cwd,
    });
    return { ...result, display: suite.shellOverride };
  }
  return runCommand({
    label: suite.name,
    command: suite.command,
    args: suite.args,
    cwd: suite.cwd,
  });
}

// ---------------------------------------------------------------------------------------
// Environment preflight
//
// `@getpaseo/plugin/server/provider` resolves through the built `dist`, not source. A
// missing build makes vitest fail with a module-resolution error that looks exactly
// like a broken import in the provider — the fixer would chase a bug that does not
// exist. Detect it up front and either build or refuse.
// ---------------------------------------------------------------------------------------

const REQUIRED_RESOLUTIONS = [
  "@getpaseo/plugin/server/provider",
  "@getpaseo/protocol/agent-types",
  "@getpaseo/client",
];

function missingResolutions() {
  const require = createRequire(join(PLUGIN_DIR, "package.json"));
  const missing = [];
  for (const id of REQUIRED_RESOLUTIONS) {
    try {
      require.resolve(id);
    } catch {
      missing.push(id);
    }
  }
  return missing;
}

async function preflightUnit({ runDir, allowBuild }) {
  const missing = missingResolutions();
  if (missing.length === 0) return { ok: true, note: "dist packages resolve" };

  const header =
    `unit preflight: cannot resolve ${missing.join(", ")} from ${relative(REPO_ROOT, PLUGIN_DIR)}.\n` +
    `The plugin SDK resolves through built dist, so the unit suite cannot run until\n` +
    `\`${BUILD_COMMAND}\` has been run in ${REPO_ROOT}.\n`;

  if (!allowBuild) {
    return { ok: false, reason: `${header}loop: --no-build was passed, refusing to build.` };
  }

  console.log(`loop: preflight — building missing dist packages\n  ${BUILD_COMMAND}`);
  const build = await runCommand({
    label: "build",
    command: "sh",
    args: ["-c", BUILD_COMMAND],
    cwd: REPO_ROOT,
  });
  writeText(
    join(runDir, "build.log"),
    `$ ${BUILD_COMMAND}\n(cwd ${REPO_ROOT})\nexit ${build.exitCode}\n\n${build.output}`,
  );

  const stillMissing = missingResolutions();
  if (stillMissing.length > 0) {
    return {
      ok: false,
      reason:
        `${header}The build exited ${build.exitCode} and ${stillMissing.join(", ")} still do not resolve.\n` +
        `See ${join(runDir, "build.log")}. This is an environment problem, not a provider bug.`,
    };
  }
  return { ok: true, note: `built missing dist packages (exit ${build.exitCode})` };
}

// ---------------------------------------------------------------------------------------
// Failure distillation
// ---------------------------------------------------------------------------------------

const ASSERTION_LINE =
  /^(AssertionError|TypeError|ReferenceError|RangeError|SyntaxError|Error:|Error \[|expect\(|expected\b)/;

/** `FAIL  <file> > <test name>` blocks (vitest) and `FAIL check=<id> :: <detail>` (live.mjs). */
function distill(output, suite) {
  const lines = output.split("\n");
  const failures = [];

  for (let index = 0; index < lines.length; index += 1) {
    const live = /^FAIL check=(\S+) ::\s*(.*)$/.exec(lines[index].trim());
    if (live) {
      failures.push({ suite, name: live[1], detail: live[2].trim() });
      continue;
    }
    const vitest = /^\s*FAIL\s+(.+?)\s*$/.exec(lines[index]);
    if (!vitest) continue;
    const name = vitest[1];
    let detail = "";
    for (let probe = index + 1; probe < Math.min(index + 14, lines.length); probe += 1) {
      const candidate = lines[probe].trim();
      if (!candidate) continue;
      if (ASSERTION_LINE.test(candidate)) {
        detail = candidate;
        break;
      }
      if (/^\s*❯\s/.test(lines[probe])) {
        detail = candidate;
        break;
      }
    }
    failures.push({ suite, name, detail });
  }

  // De-duplicate: vitest repeats each failure in the summary and the detail block.
  const seen = new Set();
  return failures.filter((failure) => {
    const key = `${failure.name}::${failure.detail}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function countSummary(output) {
  const match = /Tests\s+(.+)$/m.exec(output);
  return match ? match[1].trim() : "";
}

function tail(text, lineCount = 80) {
  const lines = text.split("\n");
  return lines.slice(Math.max(0, lines.length - lineCount)).join("\n");
}

function isEnvironmentFailure(result) {
  return (
    /No test files found/i.test(result.output) ||
    /Cannot find (package|module) '@getpaseo\//.test(result.output) ||
    /Failed to resolve entry for package "@getpaseo\//.test(result.output)
  );
}

// ---------------------------------------------------------------------------------------
// Artifacts
// ---------------------------------------------------------------------------------------

function attemptMarkdown({ attempt, max, suiteName, runDir, results }) {
  const lines = [
    `# Attempt ${attempt} of ${max}`,
    "",
    `- written: ${new Date().toISOString()}`,
    `- suite: ${suiteName}`,
    `- plugin: ${relative(REPO_ROOT, PLUGIN_DIR)}`,
    `- run dir: ${runDir}`,
    "",
    "## Commands",
    "",
    "| suite | command | cwd | exit | duration |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const result of results) {
    lines.push(
      `| ${result.label} | \`${result.display}\` | \`${relative(REPO_ROOT, result.cwd) || "."}\` | ` +
        `${result.exitCode} | ${result.durationMs}ms |`,
    );
  }
  lines.push("");

  const failures = results.flatMap((result) => distill(result.output, result.label));
  lines.push(`## Distilled failures (${failures.length})`, "");
  if (failures.length === 0) {
    const allGreen = results.every((result) => result.exitCode === 0);
    lines.push(
      allGreen
        ? "No failures — every suite exited 0."
        : "None parsed from the output — the suite failed without a recognisable failure line.",
      ...(allGreen ? [] : ["Read the output tail below."]),
      "",
    );
  } else {
    for (const [index, failure] of failures.entries()) {
      lines.push(`${index + 1}. [${failure.suite}] \`${failure.name}\``);
      lines.push(`   - ${failure.detail || "(no assertion line found)"}`);
    }
    lines.push("");
  }

  for (const result of results) {
    lines.push(`## ${result.label} output (tail 80 lines)`, "");
    lines.push("```");
    lines.push(tail(result.output).trimEnd());
    lines.push("```");
    lines.push("");
  }
  return lines.join("\n");
}

function summaryMarkdown({
  runName,
  suiteName,
  max,
  attempts,
  verdict,
  fixCmd,
  notes,
  unresolved,
  results,
}) {
  const lines = [
    `# DSH provider loop — ${verdict}`,
    "",
    `- run: \`test/loop-runs/${runName}\``,
    `- suite: ${suiteName}`,
    `- attempts used: ${attempts.length} of ${max}`,
    `- fixer: ${fixCmd ? `\`${fixCmd}\`` : "none (report only)"}`,
    "",
    "## Attempts",
    "",
    "| attempt | result | commands | distilled failures | file |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const attempt of attempts) {
    const failed = attempt.results.filter((result) => result.exitCode !== 0);
    const failureCount = attempt.results.reduce(
      (sum, result) => sum + distill(result.output).length,
      0,
    );
    lines.push(
      `| ${attempt.number} | ${failed.length === 0 ? "green" : "red"} | ` +
        `${attempt.results.map((result) => `${result.label}:${result.exitCode}`).join(" ")} | ` +
        `${failureCount} | \`attempt-${attempt.number}.md\` |`,
    );
  }
  lines.push("");

  if (notes.length > 0) {
    lines.push("## Notes", "");
    for (const note of notes) lines.push(`- ${note}`);
    lines.push("");
  }

  if (unresolved.length > 0) {
    lines.push(`## Unresolved failures (${unresolved.length})`, "");
    for (const failure of unresolved) {
      lines.push(
        `- [${failure.suite}] \`${failure.name}\` — ${failure.detail || "no assertion line"}`,
      );
    }
    lines.push("");
  }

  if (results) {
    lines.push("## Final run", "");
    lines.push("| suite | command | exit |", "| --- | --- | --- |");
    for (const result of results) {
      lines.push(`| ${result.label} | \`${result.display}\` | ${result.exitCode} |`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function evidenceMarkdown({ runName, results, startedAt }) {
  const lines = [
    "# DSH provider loop — green evidence",
    "",
    `- run: \`test/loop-runs/${runName}\``,
    `- finished: ${new Date().toISOString()}`,
    `- started: ${startedAt}`,
    "",
  ];
  for (const result of results) {
    const summary = countSummary(result.output);
    lines.push(`## ${result.label}`, "");
    lines.push(`- command: \`${result.display}\``);
    lines.push(`- cwd: \`${result.cwd}\``);
    lines.push(`- exit: ${result.exitCode}`);
    lines.push(`- duration: ${result.durationMs}ms`);
    if (summary) lines.push(`- summary: ${summary}`);
    lines.push("");
    lines.push("```");
    lines.push(result.output.trimEnd());
    lines.push("```");
    lines.push("");
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------------------

// oxlint-disable-next-line complexity -- one linear attempt/retry control flow; the order is the contract.
async function main() {
  const options = parseArgs(process.argv.slice(2));
  const startedAt = new Date().toISOString();
  const { dir: runDir, name: runName } = createRunDir();
  const notes = [];

  console.log(`loop: run dir ${runDir}`);
  console.log(`loop: suite ${options.suite}, max ${options.max} attempt(s)`);
  console.log(`loop: fixer ${options.fixCmd ? `\`${options.fixCmd}\`` : "none (report only)"}`);

  if (options.suite === "unit" || options.suite === "all") {
    const preflight = await preflightUnit({ runDir, allowBuild: options.allowBuild });
    if (!preflight.ok) {
      writeText(
        join(runDir, "summary.md"),
        summaryMarkdown({
          runName,
          suiteName: options.suite,
          max: options.max,
          attempts: [],
          verdict: "environment not ready",
          fixCmd: options.fixCmd,
          notes: [preflight.reason],
          unresolved: [],
          results: null,
        }),
      );
      console.error(
        `\nloop: ENVIRONMENT NOT READY — no attempt was made and no fixer was run.\n${preflight.reason}`,
      );
      process.exit(EXIT_ENVIRONMENT);
    }
    notes.push(`unit preflight: ${preflight.note}`);
    console.log(`loop: preflight ok — ${preflight.note}`);
  }

  const suites = suiteCommands(options);
  const attempts = [];
  let lastResults = [];

  for (let attemptNumber = 1; attemptNumber <= options.max; attemptNumber += 1) {
    console.log(`\n=== attempt ${attemptNumber}/${options.max} ===`);
    const results = [];
    for (const suite of suites) {
      process.stdout.write(`loop: running ${suite.name} (${suite.display}) ... `);
      const result = await runSuite(suite);
      console.log(`exit ${result.exitCode} (${result.durationMs}ms)`);
      results.push(result);
    }
    lastResults = results;

    const red = results.filter((result) => result.exitCode !== 0);
    const attemptPath = join(runDir, `attempt-${attemptNumber}.md`);
    // Attempt files are written once and never rewritten — the loop's history is the
    // debugging record.
    writeText(
      attemptPath,
      attemptMarkdown({
        attempt: attemptNumber,
        max: options.max,
        suiteName: options.suite,
        runDir,
        results,
      }),
    );
    attempts.push({ number: attemptNumber, results });

    if (red.length === 0) {
      // Only `SKIP check=binary.available` means the live contract was not exercised.
      // Other SKIP lines are opt-in checks (e.g. `tool.pairing` without --tool) and must
      // not be reported as "the suite passed without testing anything".
      const skipped = results.filter((result) =>
        /SKIP check=binary\.available/.test(result.output),
      );
      if (skipped.length > 0) {
        notes.push(
          `${skipped.map((result) => result.label).join(", ")} reported SKIP — the suite passed without exercising the live contract.`,
        );
      }
      writeText(
        join(runDir, "summary.md"),
        summaryMarkdown({
          runName,
          suiteName: options.suite,
          max: options.max,
          attempts,
          verdict:
            attemptNumber === 1
              ? "green on first attempt"
              : `green after ${attemptNumber} attempt(s)`,
          fixCmd: options.fixCmd,
          notes,
          unresolved: [],
          results,
        }),
      );
      writeText(join(runDir, "evidence.md"), evidenceMarkdown({ runName, results, startedAt }));
      console.log(`\nloop: GREEN after ${attemptNumber} attempt(s)`);
      console.log(`loop: attempt ${attemptNumber} → ${attemptPath}`);
      console.log(`loop: summary → ${join(runDir, "summary.md")}`);
      console.log(`loop: evidence → ${join(runDir, "evidence.md")}`);
      process.exit(EXIT_GREEN);
    }

    const failures = red.flatMap((result) => distill(result.output, result.label));
    const environment = red.filter(isEnvironmentFailure);
    console.log(`loop: RED — ${failures.length} distilled failure(s); attempt file ${attemptPath}`);
    for (const failure of failures) {
      console.log(
        `  - [${failure.suite}] ${failure.name}${failure.detail ? ` — ${failure.detail}` : ""}`,
      );
    }

    if (environment.length > 0) {
      const reason =
        `suite ${environment.map((result) => result.label).join(", ")} failed for an environment reason ` +
        `(no test files, or @getpaseo dist not built). Not feeding this to the fixer.\n` +
        `See ${attemptPath}. Run \`${BUILD_COMMAND}\` in ${REPO_ROOT} and retry.`;
      writeText(
        join(runDir, "summary.md"),
        summaryMarkdown({
          runName,
          suiteName: options.suite,
          max: options.max,
          attempts,
          verdict: "environment not ready",
          fixCmd: options.fixCmd,
          notes: [...notes, reason],
          unresolved: failures,
          results,
        }),
      );
      console.error(`\nloop: ENVIRONMENT NOT READY\n${reason}`);
      process.exit(EXIT_ENVIRONMENT);
    }

    if (!options.fixCmd) {
      writeText(
        join(runDir, "summary.md"),
        summaryMarkdown({
          runName,
          suiteName: options.suite,
          max: options.max,
          attempts,
          verdict: "red — no fixer configured",
          fixCmd: null,
          notes: [
            ...notes,
            "No --fix-cmd was supplied, so the loop stopped after the first red attempt. " +
              "Point --fix-cmd at an agent CLI to iterate automatically.",
          ],
          unresolved: failures,
          results,
        }),
      );
      console.log(`\nloop: RED and no fixer configured — stopping.`);
      console.log(`loop: attempt file → ${attemptPath}`);
      console.log(`loop: summary → ${join(runDir, "summary.md")}`);
      if (failures.length > 0) {
        console.error("loop: unresolved failures:");
        for (const failure of failures) {
          console.error(
            `  - [${failure.suite}] ${failure.name}${failure.detail ? ` — ${failure.detail}` : ""}`,
          );
        }
      }
      process.exit(EXIT_RED);
    }

    if (attemptNumber === options.max) break;

    const fixerLog = join(runDir, `attempt-${attemptNumber}.fixer.log`);
    console.log(`loop: running fixer → ${fixerLog}`);
    writeText(
      fixerLog,
      `$ ${options.fixCmd}\nDSH_LOOP_FAILURES=${attemptPath}\nDSH_LOOP_ATTEMPT=${attemptNumber}\nDSH_LOOP_MAX=${options.max}\n\n`,
    );
    const fixer = await runCommand({
      label: "fixer",
      command: "sh",
      args: ["-c", options.fixCmd],
      cwd: REPO_ROOT,
      env: {
        DSH_LOOP_FAILURES: attemptPath,
        DSH_LOOP_ATTEMPT: String(attemptNumber),
        DSH_LOOP_MAX: String(options.max),
      },
    });
    appendFileSync(fixerLog, `${fixer.output}\n\nexit ${fixer.exitCode}\n`, "utf8");
    process.stdout.write(fixer.output);
    console.log(`loop: fixer exited ${fixer.exitCode} (${fixer.durationMs}ms)`);
    notes.push(
      `attempt ${attemptNumber}: fixer exited ${fixer.exitCode} → \`attempt-${attemptNumber}.fixer.log\``,
    );
  }

  const unresolved = lastResults
    .filter((result) => result.exitCode !== 0)
    .flatMap((result) => distill(result.output, result.label));
  writeText(
    join(runDir, "summary.md"),
    summaryMarkdown({
      runName,
      suiteName: options.suite,
      max: options.max,
      attempts,
      verdict: `red after ${options.max} attempt(s)`,
      fixCmd: options.fixCmd,
      notes,
      unresolved,
      results: lastResults,
    }),
  );
  console.error(`\nloop: STILL RED after ${options.max} attempt(s).`);
  console.error(`loop: summary → ${join(runDir, "summary.md")}`);
  if (unresolved.length === 0) {
    console.error("loop: no failure lines could be distilled; inspect the attempt files.");
  } else {
    console.error("loop: unresolved failures:");
    for (const failure of unresolved) {
      console.error(
        `  - [${failure.suite}] ${failure.name}${failure.detail ? ` — ${failure.detail}` : ""}`,
      );
    }
  }
  process.exit(EXIT_RED);
}

await main();
