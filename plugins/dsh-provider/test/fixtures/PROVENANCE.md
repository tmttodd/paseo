# Real DSH captures — provenance

Verbatim stdout captures from the real `dsh` binary, used as the reference for the
fake-binary scenarios and for event-shape assertions.

- Binary: `dsh` 0.2.1-rc.3 (`/usr/local/bin/dsh`, DeepSeek Harness.app bundle)
- Profile: `headless`
- Working directory: `/private/tmp/dsh-probe`
- Date: 2026-10-26
- Flags common to every capture: `--json` (newline-delimited JSON on stdout; diagnostics on stderr)
- `--profile headless` was passed on every invocation; no `--patch` except where noted.

Files are byte-for-byte copies (`shasum -a 256` recorded below) of the probe outputs.
Nothing was edited, reordered, or re-indented.

| File                | SHA-256                                                            | Bytes |
| ------------------- | ------------------------------------------------------------------ | ----- |
| `out2.ndjson`       | `eb8dfffe471157dcae8a8ff8db6e0df2b3980f303b7edb4f0eb19d82e9b02a0b` | 606   |
| `tool.ndjson`       | `ed5d02c3055b50e8b6460e3969e9f359f0858895a7b3bc9f06995a4bdad538d5` | 1558  |
| `resume.ndjson`     | `f161af66d6987370458795db21d2c4553ae5aeca9b87aad2740ff70e33314a4c` | 1059  |
| `model.ndjson`      | `151ecc9ab80fc4292f46ce9e699b19a00609a1b5bcbb594d7338bd01e82544f9` | 591   |
| `int.ndjson`        | `8210ee7d5cf51a34cdf8cad8d80a857a83f48924fab799ed85a72be8e760b516` | 241   |
| `int-resume.ndjson` | `afd5a38632120329f4ad66eabffd73e936c7c6845e57e731daafdb9496356d39` | 2524  |

## Per-file command

`<task>` is the final argv element; multi-word tasks are joined with spaces.

1. **`out2.ndjson`** — plain turn, thinking + text, exit 0.

   ```
   dsh --profile headless --json 'Reply with exactly: pong'
   ```

2. **`tool.ndjson`** — one `bash` tool call, two steps, exit 0.

   ```
   dsh --profile headless --json 'Run echo dsh-harness-probe and report the exact output'
   ```

3. **`resume.ndjson`** — turn 2 of the session created by #2, recalled from history, exit 0.

   ```
   dsh --profile headless --json --session-id session-0a3df067-0e37-4303-b4d5-7531a72089bc 'What exact shell command did you run in the previous turn, verbatim?'
   ```

4. **`model.ndjson`** — model-route overlay applied via `--patch`; upstream 503 surfaced as
   `turn_end` `reason.kind=error` with `code: "SERVER"`, `final.text` empty, exit 1.
   The patch file is `/tmp/dsh-probe/model.yml`, whose only routing row is:

   ```yaml
   - id: agent-default-model
     name: "@deepseek-ai/dsh-agent-default-model"
     config:
       provider: homelab
       model: nemotron-3.5-super-vl
       reasoningEffort: high
   ```

   ```
   dsh --profile headless --patch /tmp/dsh-probe/model.yml --json 'Reply with exactly: pong'
   ```

   `--patch` is a launcher flag and must precede `--json`; with `--json` first, dsh hands
   `--patch` to the headless app, which answers `unknown option '--patch'` and exits 1
   (verified against the same binary).

5. **`int.ndjson`** — 400-word essay turn, SIGTERM sent mid-turn. `final` with empty text is
   emitted, the process exits, and the native session survives.

   ```
   dsh --profile headless --json 'Write a 400-word essay about lighthouses.'
   # SIGTERM after the first streamed text event
   ```

6. **`int-resume.ndjson`** — turn 2 of the interrupted session #5 (proves the session stays
   resumable after SIGTERM), exit 0.
   ```
   dsh --profile headless --json --session-id session-93d2f382-4d61-4146-a162-1838d50fded6 'Did you finish the essay? Answer in one short sentence.'
   ```

## Notes on fidelity

- The probe harness did not persist its own argv. The task strings above are quoted verbatim
  from the model's own `thinking` events inside each capture, which restate the prompt; the
  flag order matches the verified transport contract.
- `out.ndjson` (not copied here) is an earlier, non-responsive capture: session + turn/step
  start + `final` with empty text, no text event. `out2.ndjson` supersedes it.
- Session IDs differ per invocation unless `--session-id` is passed: DSH mints
  `session-<uuid>` and reuses it on resume.
