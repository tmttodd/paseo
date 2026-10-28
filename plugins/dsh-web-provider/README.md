# DSH (native) provider

Paseo provider for [DeepSeek Harness](https://deepseek.com) that drives a real `dsh web` host
instead of the one-shot CLI. Provider ID `dsh-web`; plugin ID `dsh-web-provider`.

The one-shot `dsh-provider` cannot carry DSH's command plane: headless composes no command
adapter, so `/goal` and `/plan` reach the model as ordinary text. This provider starts the same
host the DSH browser client talks to and speaks its wire, so the host's own commands are the
commands you get:

- `commands/list` is advertised as Paseo's command list, so the composer offers `/goal`,
  `/plan`, `/compact`, `/feedback`, `/permission` with the host's own argument hints;
- a command submission runs `commands/execute` on the host — `/goal` creates and arms a
  persisted goal, `/plan` flips the host's plan mode, neither creates a model message;
- **images** travel as DSH image blocks (`prompt.image` is advertised, and the host's own
  `imageLimits` report governs size/count), so attaching a picture in the composer reaches the
  model through the same route the browser uses;
- the host's **agent presets** are Paseo's modes: `standard`, `ptc`, `cordis` (labelled
  **Creator**, as the DSH web UI does), `minimal`, and any custom preset the profile defines.
  Selecting one before the first turn switches the host's preset; DSH fixes the preset at the
  first turn, so a later switch fails with a clear message instead of silently doing nothing;
- plan mode is a Paseo **setting toggle** (`plan_mode`), mapped to `/plan` and `/plan off`, so
  it composes with any preset instead of competing with it;
- sessions are real DSH sessions, so the same conversation is visible to the DSH web UI (and
  anything else attached to that host).

## How it runs

One `dsh web` child per provider connection, on a free loopback port:

```
dsh --profile <profile> [--patch <overlay>] --no-open --host 127.0.0.1 --port <free>
```

The provider reads the single `dsh web: <url>?token=<token>` line, exchanges the launch token
for the signed cookie, and then uses the browser's wire: unary `POST /api/<endpoint>` carrying a
`client-request` envelope, and one `/api/remote.mux` WebSocket for every stream. The token never
leaves the process and the host never binds a non-loopback address.

Nothing is spawned until the daemon asks for a catalog or opens a session. Closing the provider
connection stops the host (SIGTERM, then SIGKILL after a grace period).

## Install

```bash
paseo plugin add /absolute/path/to/plugins/dsh-web-provider
paseo plugin ls dsh-web-provider          # status must read "running"
```

Then enable the provider for the daemon (Settings → Providers, or `~/.paseo/config.json`):

```json
{ "agents": { "providers": { "dsh-web": { "enabled": true } } } }
```

Create an agent with provider **DSH (native)**. The model list comes from the host's
`session/modelCatalog`, so it matches whatever the selected profile can actually route.

## Options

Pass these in `providerOptions` (per agent) — or under `agents.providers.dsh-web.options`:

| Option    | Type      | Default | Meaning                                                      |
| --------- | --------- | ------- | ------------------------------------------------------------ |
| `profile` | `string`  | `web`   | DSH profile to boot. `web` is the only shipped HTTP surface. |
| `patch`   | `string`  | —       | Extra patch-list overlay applied after the profile layer.    |
| `isolate` | `boolean` | `true`  | Disable outward-facing rows the profile mounts (see below).  |

The host is per connection, so the profile is fixed by the first request that needs it. A later
session asking for a different profile fails with `PROFILE_LOCKED` rather than silently sharing
the wrong host.

### Isolation

A Paseo-owned host is not one of the user's surfaces. With `isolate` on (the default), the
provider reads `$DSH_HOME/profiles/<profile>/cordis.patch.yml` and disables the outward-facing
rows it finds there — `bridle-plugin`, `remote-config`, `dsh-remote-config`, `plugin-market`,
`plugin-market-index` — by writing a temporary overlay and passing it with `--patch`. A patch
naming a row the profile does not have is an error in DSH, so only rows that are present are
listed. Set `isolate: false` to keep the profile exactly as composed, or `patch` to supply your
own overlay instead.

## Modes and plan

`session.config` carries two independent controls:

| Paseo control | DSH mechanism                                                                    | When it applies                 |
| ------------- | -------------------------------------------------------------------------------- | ------------------------------- |
| mode picker   | `agentPresets/list` → modes; `session.configure({mode})` → `agentPresets/select` | before the session's first turn |
| image attach  | `session/prompt` image content blocks (`prompt.image`)                           | any prompt                      |
| Plan toggle   | `settings[{id:"plan_mode"}]` → `/plan` / `/plan off`                             | any time                        |

Presets the host reports as broken are not offered. Shipped presets publish no display name, so
the provider maps the known ids the way the DSH web UI labels them (`cordis` → Creator) and uses
the host's `name` when a preset has one.

## What it does not do

- **No MCP injection.** Paseo tools are not mounted into DSH sessions; the host's own MCP rows
  own that.
- **No session import list.** `session.list` is not advertised, so the import picker stays empty;
  resume works through the persistence handle (`{version:1, data:{sessionId}}`).
- **No mid-conversation preset switch.** DSH records the preset on the first turn and keeps that
  composition; changing it needs a new agent (the provider refuses rather than no-oping).
- **No plan-review card.** `exit_plan_mode` needs a DSH client to answer its review; from Paseo
  the agent presents the plan in the conversation.
- **No live token deltas.** Assistant text is projected when the step commits, like the one-shot
  provider.

## Testing

```bash
npx vitest run plugins/dsh-web-provider                  # fake host, deterministic
DSH_WEB_LIVE=1 npx vitest run plugins/dsh-web-provider   # real `dsh web`, scratch DSH_HOME
```

The live suite spawns a real host in a throwaway `DSH_HOME` (the shipped `web` template
materializes there). With no model credentials the prompt turn ends at the adapter with a
credential error — the `/plan` and `/goal` checks need no model. Point it at a credentialed home
with `DSH_WEB_LIVE_HOME=~/.dsh`.

`server/live.test.ts` prints `PASS check=<id> :: …` lines; the fake host (`test/fake-host.mjs`)
speaks the real wire shape — handshake, unary envelope, mux frames — so the transport is
exercised, not mocked.
