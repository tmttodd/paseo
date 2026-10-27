# DSH provider

Bundled Paseo provider for [DSH](https://deepseek.com) — the DeepSeek Harness CLI (`dsh`).
Provider ID `dsh`; plugin ID `dsh-provider`.

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

`disablePlugins` exists because a broken profile plugin otherwise fails every turn. On this
machine `tokenomics` dies with `RangeError: Invalid string length` while decompressing a
large session log, so `{"disablePlugins": ["tokenomics"]}` is the documented workaround until
that plugin streams instead of buffering.

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
