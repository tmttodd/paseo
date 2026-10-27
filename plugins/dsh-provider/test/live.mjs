#!/usr/bin/env node
// Live contract test for the DSH provider: drives the REAL `dsh` binary and asserts
// the transport invariants the provider depends on.
//
//   node test/live.mjs            # skip (exit 0) when dsh is not installed
//   node test/live.mjs --require  # a missing dsh is a failure (CI)
//   node test/live.mjs --tool     # also assert tool_call/tool_result pairing
//
// Exit codes: 0 = pass (or skip without --require), 1 = contract failure or
// missing binary with --require, 2 = harness misuse.
//
// Machine-readable lines (`PASS check=<id> :: …`, `FAIL check=<id> :: …`) are the
// contract with test/loop.mjs, which distils them into attempt files.

import {
  DEFAULT_PROFILE,
  checkContract,
  launcherArgs,
  makeScratchDir,
  probeBinary,
  removeDir,
  resolveBinary,
  runDsh,
  writeOverlay,
} from "./dsh-runtime.mjs";

const SIMPLE_TASK = "Reply with exactly: dsh-live-ok";
const TOOL_TASK = "Run the shell command `echo dsh-live-tool` and report its exact output.";
// The interrupt check needs the turn to still be open when SIGTERM lands. A task the
// model can answer from memory finishes in ~2s, which turns the check into a race.
// A long shell call pins the turn open until the harness signals it.
const LONG_TASK = "Run the shell command `sleep 20` and then report its exact output.";

function parseArgs(argv) {
  const options = {
    profile: DEFAULT_PROFILE,
    requireBinary: false,
    tool: false,
    keep: false,
    timeoutMs: 240_000,
    interruptAfterMs: 3_500,
    overlays: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (value === undefined) {
        console.error(`live: ${arg} needs a value`);
        process.exit(2);
      }
      index += 1;
      return value;
    };
    switch (arg) {
      case "--profile":
        options.profile = next();
        break;
      case "--patch":
        options.overlays.push(next());
        break;
      case "--require":
        options.requireBinary = true;
        break;
      case "--tool":
        options.tool = true;
        break;
      case "--keep":
        options.keep = true;
        break;
      case "--timeout":
        options.timeoutMs = Number(next()) * 1000;
        break;
      case "--interrupt-after":
        options.interruptAfterMs = Number(next());
        break;
      case "--help":
      case "-h":
        console.log(
          [
            "Usage: node test/live.mjs [--profile <name>] [--patch <file>] [--require] [--tool]",
            "                          [--keep] [--timeout <seconds>] [--interrupt-after <ms>]",
            "",
            "  --require          treat a missing `dsh` as a failure instead of a skip",
            "  --tool             additionally assert tool_call/tool_result callId pairing",
            "  --keep             keep the scratch cwd and generated overlay for inspection",
            "  --timeout <s>      per-invocation timeout (default 240)",
            "  --interrupt-after  ms before SIGTERM on the interrupt check (default 3500)",
            "",
            "Env: DSH_BIN overrides the binary path (default `dsh`).",
          ].join("\n"),
        );
        process.exit(0);
        break;
      default:
        console.error(`live: unknown argument \`${arg}\``);
        process.exit(2);
    }
  }
  return options;
}

const results = [];
function record(status, id, detail) {
  results.push({ status, id, detail });
  const line = `${status} check=${id} :: ${detail}`;
  if (status === "FAIL") console.error(line);
  else console.log(line);
}
const pass = (id, detail) => record("PASS", id, detail);
const fail = (id, detail) => record("FAIL", id, detail);
const skip = (id, detail) => record("SKIP", id, detail);

const summarise = (events) => {
  const counts = new Map();
  for (const event of events) counts.set(event.type, (counts.get(event.type) || 0) + 1);
  return [...counts.entries()].map(([type, n]) => `${type}×${n}`).join(" ");
};

// oxlint-disable-next-line complexity -- a linear CLI checklist: each step reports PASS/FAIL and must stay readable in order.
async function main() {
  const options = parseArgs(process.argv.slice(2));
  const binary = probeBinary(resolveBinary());

  console.log("dsh live contract test");
  console.log(`  binary:  ${binary.bin}`);
  console.log(`  version: ${binary.available ? binary.version : "unavailable"}`);
  console.log(`  profile: ${options.profile}`);
  console.log("");

  if (!binary.available) {
    const detail = `${binary.reason}; live contract not exercised`;
    if (options.requireBinary) {
      fail("binary.available", detail);
      console.error("\nSUMMARY passed=0 failed=1 skipped=0");
      process.exit(1);
    }
    skip("binary.available", detail);
    console.log("\nSUMMARY passed=0 failed=0 skipped=1");
    process.exit(0);
  }
  pass("binary.available", `\`${binary.bin} --version\` → ${binary.version}`);

  const scratch = makeScratchDir("dsh-live-");
  const overlay = writeOverlay(scratch);
  const overlays = [overlay.path, ...options.overlays];
  console.log(`  overlay: ${overlay.path} (sha256 ${overlay.sha256.slice(0, 12)})`);
  console.log(`  cwd:     ${scratch}`);
  console.log("");

  const run = (appArgs, extra = {}) =>
    runDsh({
      bin: binary.bin,
      args: launcherArgs({ profile: options.profile, overlays, appArgs }),
      cwd: scratch,
      timeoutMs: options.timeoutMs,
      ...extra,
    });

  try {
    // ---- 1. Simple completed turn -------------------------------------------------
    const simple = await run(["--json", SIMPLE_TASK]);
    const simpleCheck = checkContract(simple, { expect: "completed", label: "simple turn" });
    if (simpleCheck.failures.length === 0) {
      const sessionId = simple.events[0].sessionId;
      pass(
        "simple.contract",
        `exit ${simple.exitCode}, ${simple.events.length} events (${summarise(simple.events)}), ` +
          `session ${sessionId}`,
      );
    } else {
      fail("simple.contract", simpleCheck.failures.join(" | "));
    }
    for (const warning of simpleCheck.warnings)
      console.log(`WARN check=simple.contract :: ${warning}`);

    const sessionId = simple.events.find((event) => event.type === "session")?.sessionId;
    if (!sessionId) {
      // Nothing downstream can run without a session id.
      console.error(
        "\nSUMMARY passed=" +
          results.filter((r) => r.status === "PASS").length +
          " failed=" +
          results.filter((r) => r.status === "FAIL").length +
          " skipped=" +
          results.filter((r) => r.status === "SKIP").length,
      );
      process.exit(1);
    }

    // ---- 2. Resume keeps the native session ---------------------------------------
    const resume = await run([
      "--json",
      "--session-id",
      sessionId,
      "In one short sentence, what did I ask you to reply with?",
    ]);
    const resumeCheck = checkContract(resume, { expect: "completed", label: "resume turn" });
    const resumedId = resume.events.find((event) => event.type === "session")?.sessionId;
    const turnNumbers = resume.events
      .filter((event) => event.type === "status" && event.phase === "turn_start")
      .map((event) => event.turn);
    if (resumeCheck.failures.length > 0) {
      fail("resume.contract", resumeCheck.failures.join(" | "));
    } else if (resumedId !== sessionId) {
      fail(
        "resume.identity",
        `session id changed across --session-id: ${sessionId} → ${resumedId}`,
      );
    } else if (!turnNumbers.includes(2)) {
      fail(
        "resume.identity",
        `expected turn 2 on the resumed session, saw turn_start(s) ${JSON.stringify(turnNumbers)}`,
      );
    } else {
      pass(
        "resume.identity",
        `session ${sessionId} resumed as turn ${turnNumbers.join(",")} with exit ${resume.exitCode}`,
      );
    }
    for (const warning of resumeCheck.warnings)
      console.log(`WARN check=resume.identity :: ${warning}`);

    // ---- 3. SIGTERM mid-turn ------------------------------------------------------
    // Verified shape: exit 0, `final` with empty text, NO `turn_end`. The provider
    // must not read exit 0 as "turn completed".
    const interrupted = await run(["--json", "--session-id", sessionId, LONG_TASK], {
      interruptAfterMs: options.interruptAfterMs,
    });
    const interruptCheck = checkContract(interrupted, { expect: "interrupt", label: "interrupt" });
    const interruptedId = interrupted.events.find((event) => event.type === "session")?.sessionId;
    const sawTurnEnd = interrupted.events.some(
      (event) => event.type === "status" && event.phase === "turn_end",
    );
    if (sawTurnEnd) {
      interruptCheck.failures.push(
        `interrupt: the turn finished before SIGTERM landed (${options.interruptAfterMs}ms); ` +
          "raise --interrupt-after so the signal arrives mid-turn",
      );
    }
    if (interruptCheck.failures.length > 0) {
      fail("interrupt.shape", interruptCheck.failures.join(" | "));
    } else if (interruptedId !== sessionId) {
      fail("interrupt.shape", `interrupt ran on ${interruptedId}, expected ${sessionId}`);
    } else {
      const finalEvent = interrupted.events.find((event) => event.type === "final");
      const phases = interrupted.events
        .filter((event) => event.type === "status")
        .map((event) => event.phase)
        .join(">");
      const tail = finalEvent
        ? `final ${JSON.stringify((finalEvent.text || "").slice(0, 20))}`
        : `no final (stream ended at ${interrupted.events.at(-1).type})`;
      pass(
        "interrupt.shape",
        `SIGTERM after ${options.interruptAfterMs}ms → exit ${interrupted.exitCode}, ` +
          `phases ${phases || "none"}, ${tail}`,
      );
    }
    for (const warning of interruptCheck.warnings) {
      console.log(`WARN check=interrupt.shape :: ${warning}`);
    }

    // ---- 4. The interrupted session is still resumable ----------------------------
    const recovered = await run([
      "--json",
      "--session-id",
      sessionId,
      "Did you finish the essay? Answer in one short sentence.",
    ]);
    const recoveredCheck = checkContract(recovered, {
      expect: "completed",
      label: "recovery turn",
    });
    const recoveredId = recovered.events.find((event) => event.type === "session")?.sessionId;
    const recoveredTurns = recovered.events
      .filter((event) => event.type === "status" && event.phase === "turn_start")
      .map((event) => event.turn);
    if (recoveredCheck.failures.length > 0) {
      fail("interrupt.resumable", recoveredCheck.failures.join(" | "));
    } else if (recoveredId !== sessionId) {
      fail(
        "interrupt.resumable",
        `recovery ran on ${recoveredId}, expected the interrupted session ${sessionId}`,
      );
    } else {
      pass(
        "interrupt.resumable",
        `interrupted session resumed as turn ${recoveredTurns.join(",")} and completed ` +
          `(${(recovered.events.at(-1).text || "").length} chars)`,
      );
    }

    // ---- 5. Tool pairing (opt-in) -------------------------------------------------
    if (options.tool) {
      const toolRun = await run(["--json", TOOL_TASK]);
      const toolCheck = checkContract(toolRun, { expect: "completed", label: "tool turn" });
      const calls = toolRun.events.filter((event) => event.type === "tool_call");
      const results_ = toolRun.events.filter((event) => event.type === "tool_result");
      const paired = calls.filter((call) =>
        results_.some((result) => result.callId === call.callId),
      );
      if (toolCheck.failures.length > 0) {
        fail("tool.pairing", toolCheck.failures.join(" | "));
      } else if (calls.length === 0) {
        fail(
          "tool.pairing",
          "the model completed the task without a tool_call; cannot verify callId pairing",
        );
      } else if (paired.length !== calls.length) {
        fail(
          "tool.pairing",
          `${calls.length} tool_call(s) but only ${paired.length} matched tool_result callId(s)`,
        );
      } else {
        pass(
          "tool.pairing",
          `${calls.length} tool_call(s) paired: ${calls.map((c) => c.tool).join(", ")}`,
        );
      }
      for (const warning of toolCheck.warnings)
        console.log(`WARN check=tool.pairing :: ${warning}`);
    } else {
      skip("tool.pairing", "not requested (pass --tool)");
    }
  } finally {
    if (options.keep) {
      console.log(`\nkept scratch dir: ${scratch}`);
    } else {
      removeDir(scratch);
    }
  }

  const passed = results.filter((result) => result.status === "PASS").length;
  const failed = results.filter((result) => result.status === "FAIL").length;
  const skipped = results.filter((result) => result.status === "SKIP").length;
  console.log(`\nSUMMARY passed=${passed} failed=${failed} skipped=${skipped}`);
  if (failed > 0) {
    console.error("\nUnresolved live contract failures:");
    for (const result of results.filter((r) => r.status === "FAIL")) {
      console.error(`  - ${result.id}: ${result.detail}`);
    }
  }
  process.exit(failed > 0 ? 1 : 0);
}

await main();
