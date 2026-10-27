# DSH provider

Paseo provider for [DSH](https://deepseek.com) — the DeepSeek Harness CLI (`dsh`).
Provider ID `dsh`; plugin ID `dsh-provider`.

It ships as a bundled built-in, so a Paseo built from this repository has it with no setup.
A **packaged** Paseo (`/Applications/Paseo.app`) carries its own copy of the built-ins and
cannot see a checkout, so install the directory instead:

```bash
paseo plugin add /path/to/paseo/plugins/dsh-provider
paseo plugin ls dsh-provider          # status must read "running"
paseo run --provider dsh "Reply with exactly: ok"
```

The plugin declares no dependencies: it imports only `@getpaseo/plugin/*`, `zod`, and Node
built-ins, which the daemon provides. Re-point the install at a permanent checkout before
deleting the one you installed from.

## How it runs a session

DSH's non-interactive surface is one turn per process, so one Paseo session is a chain of
child processes:

```
dsh --profile <profile> [--patch <overlay> …] --json [--session-id <native-id>] <prompt>
```

- The first `{"type":"session","sessionId":"session-…"}` event gives the native id; every
  later turn resumes it with `--session-id`, which is what makes the chain a conversation.
- Paseo's persistence value is `{ version: 1, data: { sessionId } }`.
- Launcher flags (`--profile`, `--patch`) must come **before** `--json`; `dsh` stops parsing
  its own options at the first argument it does not recognise.
- Interrupt sends `SIGTERM`. DSH finalizes and exits, and the session stays resumable — a
  stopped turn is not a lost conversation.

## Options

Pass these in `providerOptions` (per agent) or under `agents.providers.dsh.options` (defaults):

| Option           | Type       | Default    | Meaning                                                              |
| ---------------- | ---------- | ---------- | -------------------------------------------------------------------- |
| `profile`        | `string`   | `headless` | DSH profile to boot.                                                 |
| `patch`          | `string`   | —          | Extra patch-list overlay, applied before the provider's own overlay. |
| `disablePlugins` | `string[]` | `[]`       | Profile plugin row ids to disable for this session.                  |

`disablePlugins` exists because a profile plugin that throws takes the whole boot down
before the model is called. A plugin that is already broken at boot cannot be fixed by the
provider, so this is the escape hatch: `{"disablePlugins": ["some-plugin"]}` writes one
overlay row per id for that session only.

It was used in anger on 2026-10-26 for `dsh-tokenomics`, which buffered a whole
decompressed session log in one string and died with `RangeError: Invalid string length`.
That plugin has since been removed from the profiles, so nothing needs disabling today.

Model and thinking effort are written into the provider's own overlay as an
`agent-default-model` row, so a model change applies from the next turn.

## What it does not do

- **No MCP.** `dsh`'s headless CLI has no MCP flags, so Paseo tools are not injected.
- **No modes or settings.** The catalog returns an empty mode list; the only per-session
  controls are model and thinking effort.
- **No history replay.** `history: "replay"` opens without replaying old rows; the daemon's
  own timeline is the record.

## Testing

`HARNESS.md` documents the three entry points — `test/capture.mjs` (real captures with
provenance), `test/live.mjs` (live contract checks), and `test/loop.mjs` (the
test → fix → iterate loop) — plus the verified DSH hazards they encode.

```bash
npx vitest run plugins/dsh-provider     # deterministic suite against a fake dsh
node plugins/dsh-provider/test/live.mjs # live contract checks against the real binary
```
