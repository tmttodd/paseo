# DSH provider test harness

Three entry points drive the DSH provider against the **real** `dsh` binary and one
loops on the result. Everything here was verified against `dsh` 0.2.1-rc.3 on
2026-10-26; the hazard list in [Known DSH profile hazards](#known-dsh-profile-hazards)
records what was observed, not what the docs claim.

```
plugins/dsh-provider/
  test/
    dsh.mjs              fake binary (fixture replay) — used by the unit suite
    dsh-runtime.mjs      shared spawn / parse / contract-invariant helpers
    capture.mjs          capture the real binary into test/fixtures/real/
    live.mjs             live contract test against the real binary
    loop.mjs             test → fix → iterate loop
    fixtures/
      scenarios/         fake-binary scenario scripts (unit suite)
      real/              captured real streams + provenance
    loop-runs/           loop artifacts, one directory per run (gitignored)
```

`DSH_BIN` overrides the binary path everywhere (`capture.mjs`, `live.mjs`, and
therefore `loop.mjs`). Default is `dsh` on `PATH`.

---

## `node test/capture.mjs`

Captures real output into `test/fixtures/real/` together with provenance.

```bash
node test/capture.mjs --scenario simple
node test/capture.mjs --scenario tool
node test/capture.mjs --scenario resume
node test/capture.mjs --scenario interrupt
node test/capture.mjs --scenario error
```

| Flag                | Meaning                                                                |
| ------------------- | ---------------------------------------------------------------------- |
| `--scenario`        | `simple`, `tool`, `resume`, `interrupt`, `error` (default `simple`)    |
| `--profile`         | DSH profile to boot (default `headless`)                               |
| `--out`             | fixture directory (default `test/fixtures/real`)                       |
| `--interrupt-after` | milliseconds before SIGTERM on the `interrupt` scenario (default 3500) |
| `--timeout`         | per-invocation timeout in seconds (default 240)                        |
| `--keep`            | keep the scratch cwd instead of deleting it                            |

Each capture writes `live-<scenario>.ndjson`, `live-<scenario>.stderr.txt`, and
`live-<scenario>.provenance.json`, then regenerates `PROVENANCE.live.md` from every
sidecar it finds. The sidecar records the binary path, `dsh --version`, profile, UTC
timestamp, per-invocation argv, exit code, duration, event count, and the full overlay
YAML with its sha256 — so a fixture can be explained a year later.

The `live-` prefix is load-bearing: the fixture suite ships verbatim probe copies
(`out2.ndjson`, `tool.ndjson`, `resume.ndjson`, …) and `PROVENANCE.md` describes them.
A capture refresh must never overwrite those, so it only writes `live-*` files and
only regenerates `PROVENANCE.live.md`.

Exit codes: `0` captured and matched the expected shape, `1` captured but the stream
deviated (files are still written so the deviation is inspectable), `2` the binary is
missing or the arguments are wrong. A missing binary is a loud failure on purpose — a
capture that silently produced nothing would look like a successful refresh.

## `node test/live.mjs`

The live contract test. Spawns the real binary and asserts the invariants the provider
depends on.

```bash
node test/live.mjs             # exit 0, printing SKIP, when dsh is not installed
node test/live.mjs --require   # a missing dsh is a failure (CI)
node test/live.mjs --tool      # additionally assert tool_call/tool_result pairing
```

| Flag                | Meaning                                                      |
| ------------------- | ------------------------------------------------------------ |
| `--profile`         | profile to boot (default `headless`)                         |
| `--patch`           | extra overlay applied after the harness overlay (repeatable) |
| `--require`         | treat a missing `dsh` as a failure instead of a skip         |
| `--tool`            | also run a tool-using turn and assert `callId` pairing       |
| `--interrupt-after` | ms before SIGTERM on the interrupt check (default 3500)      |
| `--timeout`         | per-invocation timeout in seconds (default 240)              |
| `--keep`            | keep the scratch cwd and generated overlay                   |

Checks, each printed as `PASS check=<id> :: …` / `FAIL check=<id> :: …`:

| Check                 | Asserts                                                                                                                |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `binary.available`    | `dsh --version` answers (else `SKIP`, or `FAIL` with `--require`)                                                      |
| `simple.contract`     | first event `session`, last event `final`, one `turn_end` with `reason.kind = completed`, exit 0, non-empty final text |
| `resume.identity`     | `--session-id` reuses the same native session and reports turn 2                                                       |
| `interrupt.shape`     | SIGTERM mid-turn: no `turn_end`; `final` is emitted only if the signal landed between steps                            |
| `interrupt.resumable` | the interrupted session resumes and completes on the next turn                                                         |
| `tool.pairing`        | (with `--tool`) every `tool_call` gets a `tool_result` with the same `callId`                                          |

The interrupt check runs a `sleep 20` shell task so the turn is still open when the
signal lands. Without that, a fast model finishes first and the check becomes a race —
if it ever does finish early, the check fails with "raise `--interrupt-after`" instead
of passing silently.

Exit: `0` pass or skip, `1` contract failure or missing binary with `--require`,
`2` bad arguments.

## `node test/loop.mjs`

The test → fix → iterate loop.

```bash
node test/loop.mjs                      # unit + live, up to 3 attempts, no fixer
node test/loop.mjs --no-fix --max 1     # single run, write the evidence, stop
node test/loop.mjs --suite live --require-live
node test/loop.mjs --max 4 --fix-cmd 'omp run --worktree . "Fix the DSH provider failures listed in $DSH_LOOP_FAILURES"'
```

| Flag               | Meaning                                                      |
| ------------------ | ------------------------------------------------------------ |
| `--max <n>`        | maximum attempts (default 3)                                 |
| `--suite <name>`   | `unit`, `live`, or `all` (default `all`)                     |
| `--fix-cmd <cmd>`  | shell command run after each red attempt                     |
| `--no-fix`         | never run a fixer; stop after the first red attempt          |
| `--require-live`   | pass `--require` through to `live.mjs`                       |
| `--no-build`       | do not build missing `@getpaseo` dist packages; fail instead |
| `--unit-cmd <cmd>` | override the unit command (runs from the repo root)          |
| `--live-cmd <cmd>` | override the live command (runs from the plugin directory)   |

**What it runs.** Unit is `npx vitest run plugins/dsh-provider` from the repo root;
live is `node test/live.mjs` from the plugin directory.

**Attempt cycle.**

1. Run the selected suites.
2. Green → write `summary.md` and `evidence.md` (full passing output), exit 0.
3. Red → write `attempt-<n>.md` with the exact command per suite, its cwd, exit code,
   duration, the distilled failure list (failing test names with the first assertion
   line each), and the last 80 lines of each suite's output. Then run the fixer.
4. Re-run, bounded by `--max`. Still red at the end → exit 1 and print the unresolved
   failures by name.

**Fixer contract.** The fixer runs as `sh -c "<fix-cmd>"` from the repo root with:

| Env var             | Value                                          |
| ------------------- | ---------------------------------------------- |
| `DSH_LOOP_FAILURES` | absolute path to the attempt file just written |
| `DSH_LOOP_ATTEMPT`  | 1-based attempt number                         |
| `DSH_LOOP_MAX`      | the `--max` bound                              |

Its stdout/stderr are teed to `attempt-<n>.fixer.log`. Pointing it at an agent CLI:

```bash
# omp (this repo's agent)
node test/loop.mjs --fix-cmd 'omp run "Fix the failures in $DSH_LOOP_FAILURES. Do not weaken tests."'

# Claude Code
node test/loop.mjs --fix-cmd 'claude -p "Read $DSH_LOOP_FAILURES and fix the provider. Re-run the failing test only."'

# Codex
node test/loop.mjs --fix-cmd 'codex exec "Read $DSH_LOOP_FAILURES and fix the provider."'

# DSH itself, with the overlay that keeps its headless boot alive
node test/loop.mjs --fix-cmd 'dsh --profile headless --patch /tmp/dsh-overlay.yml --json "Read $DSH_LOOP_FAILURES and fix the provider."'
```

The loop deliberately does not parse the fixer's output. A fixer that reports success
without changing anything costs one more red attempt, which the loop records.

**Artifacts.** `test/loop-runs/<UTC-stamp>/`:

```
attempt-1.md              command, exit code, distilled failures, output tail
attempt-1.fixer.log       fixer invocation + env + output (only when a fixer ran)
build.log                 dist build output (only when the preflight had to build)
summary.md                every attempt, notes, unresolved failures, final run
evidence.md               full passing output (green runs only)
```

Run directories are append-only. Nothing already written under `loop-runs/` is ever
deleted or rewritten, and a new run always gets a fresh directory (a same-second
collision gets a `-2` suffix), so the history of a debugging session survives the fix
that ends it. The directory is gitignored — it is local evidence, not a fixture.

Because it is local and untracked, a run directory may come from harness verification
rather than from a real defect: a synthetic `--unit-cmd` that prints a `FAIL` line and
exits 1 is how the red path gets exercised. Always read the command column in the
attempt file before treating a failure there as a finding.

**Exit codes.**

| Code | Meaning                                                   |
| ---- | --------------------------------------------------------- |
| 0    | green (immediately or after fixes)                        |
| 1    | still red after `--max`, or red with no fixer configured  |
| 2    | bad arguments                                             |
| 3    | environment not ready — no attempt was made, no fixer ran |

**Why exit 3 exists.** `@getpaseo/plugin/server/provider` resolves through built
`dist`, not source. Without `npm run build:protocol && npm run build:client &&
npm run build:plugin`, vitest fails with a module-resolution error that looks exactly
like a broken import in the provider — and a fixer pointed at it would chase a bug
that does not exist. So the loop resolves `@getpaseo/plugin/server/provider`,
`@getpaseo/protocol/agent-types`, and `@getpaseo/client` up front: if any is missing it
builds them (unless `--no-build`), and if they still do not resolve it exits 3 without
running a fixer. The same guard catches vitest's "No test files found", which is a
missing-spec problem rather than a failing test.

---

## Known DSH profile hazards

Every item below was observed on this machine with `dsh` 0.2.1-rc.3, not inferred.

### 1. Launcher flags must precede app flags

`dsh` parses its own launcher options (`--profile`, `--patch`, `--dump-config`) only
up to the first argument it does not recognise. Everything after that belongs to the
booted app.

```bash
# WRONG — --patch is handed to the headless app
dsh --profile headless --json --patch overlay.yml "task"
# → {"type":"error","message":"unknown option '--patch'"}, exit 1

# RIGHT
dsh --profile headless --patch overlay.yml --json "task"
```

`launcherArgs()` in `test/dsh-runtime.mjs` exists so no caller can get this wrong.

### 2. The `tokenomics` plugin kills the headless boot

Without disabling it, a headless turn dies before the model is called:

```
dsh: fatal uncaught exception: RangeError: Invalid string length
    at Socket.<anonymous> (…/dsh-tokenomics/index.js:472:53)
```

The stream stops after `session` / `turn_start` / `step_start` and a `final` with
empty text, exit 1. The harness overlay disables `tokenomics`,
`dsh-onepassword-tools`, `dsh-pr-claim-gate`, `ponytail`, and `guardrails`; `tokenomics`
is the one that matters. `live.mjs` and `capture.mjs` write that overlay into a temp
dir and pass it with `--patch`. If a future profile change makes the overlay
unnecessary, the harness still works — it only disables plugins.

Other profiles carry their own hazards; the harness always passes an explicit
`--profile` rather than relying on the user's default.

### 3. Exit 0 does not mean "turn completed"

A SIGTERM'd turn exits **0**. Do not treat the exit code as the outcome. The
authoritative signals are:

- `turn_end` with `reason.kind` present → the turn ended on its own (`completed` or
  `error`).
- No `turn_end` and the child exited → interrupted.

### 4. An interrupted turn may emit no `final` at all

Whether `final` arrives depends on where the signal lands:

| Signal lands       | Stream                                                       |
| ------------------ | ------------------------------------------------------------ |
| between steps      | `… final` with empty text, no `turn_end`                     |
| inside a tool call | stream stops at the `tool_call`; **no `final` ever arrives** |

Both were captured (`test/fixtures/real/live-interrupt.ndjson`,
`int.ndjson`). The provider must treat the child's exit as the end of an interrupted
turn, never the presence of `final`.

### 5. `final.text` on interrupt is not reliably empty

Empty when the signal lands before any text is produced; partial text when the model
had already streamed some. Only the absence of `turn_end` distinguishes an interrupt.

### 6. stderr is noisy and is not an error signal

A healthy turn writes ~30 lines of "N entries did not activate / pending (waiting for
service: agentPresets)" to stderr and still exits 0. Never gate on stderr being empty;
stdout is strictly newline-delimited JSON.

### 7. cwd comes back realpath'd

macOS reports `/private/var/…` for a cwd under `/var/…`, and `/private/tmp/…` for
`/tmp/…`. Compare cwd values after `realpath`, or not at all.

### 8. `--session-id` needs the native id

The id is `session-<uuid>`, taken from the first event of the previous turn
(`{"type":"session","sessionId":"session-…"}`). Resuming increments `turn`, and a
session that was interrupted still resumes.

### 9. Discovery uses `--dump-config`

`dsh --profile <name> --dump-config` prints the composed profile YAML; the row
`- id: llm-pi-ai` carries `config.providers.<name>.models[]` with `id`, `name`,
`contextWindow`, `maxTokens`, and `reasoningEfforts`. This is how the provider's
catalog is discovered — it is a launcher flag, so it must precede any app flag (see
hazard 1).

### 10. Errors are structured, so they can be tested

Pointing `agent-default-model` at an unknown provider is a deterministic failure:

```json
{
  "type": "status",
  "phase": "turn_end",
  "turn": 1,
  "reason": {
    "kind": "error",
    "error": {
      "message": "no adapter registered for provider \"nope-not-a-provider\"",
      "code": "NO_ADAPTER"
    }
  }
}
```

`capture.mjs --scenario error` uses exactly that overlay. Note the `step_end` on this
path carries no `usage` block, so usage handling must tolerate its absence.

---

## Coverage boundaries

- `live.mjs` covers the happy path, resume, interrupt, and (with `--tool`) tool
  pairing. It does not exercise the error path — that is deterministic but requires a
  broken model route, which `capture.mjs --scenario error` records instead.
- Model-dependent behaviour (exact wording, whether a tool is used at all) is never
  asserted. The `tool.pairing` check fails rather than skips when the model answers
  without a tool, because a silent skip would hide a real regression in tool mapping.
- The fake binary (`test/dsh.mjs`) owns deterministic scenario replay; these three
  entry points deliberately use the real binary so that a change in `dsh` itself
  surfaces here.
