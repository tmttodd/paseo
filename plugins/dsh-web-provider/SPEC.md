# SPEC — dsh-web-provider: native DSH commands and sessions in Paseo

Status: BUILT + PROVEN END TO END 2026-10-28. Unit suite green (7 tests, fake host speaking
the real wire); live suite green against a real `dsh web` host; and from the operator's own
Paseo daemon (provider `dsh-web`, installed side by side with the headless provider):

- `paseo provider diagnostic dsh-web` → available, 6 models, ready (the daemon booted a real
  `dsh web` host with the operator's profile and read `session/modelCatalog`);
- `paseo run --provider dsh-web "/plan"` → agent idle, mode `plan`, no model turn;
  `paseo send "<id>" "/plan off"` → mode `default` — the host's command plane, not prose;
- `paseo run --provider dsh-web "/goal Reply with exactly: goal-ok, then mark this goal
  complete."` → the DSH session log records `goal/change create | phase active` with exactly
  that objective, then the goal round ran (10,203 input / 1,341 output tokens) and
  `goal/change complete | phase complete`.

Delivery: patch for the operator's Paseo fork; install is a directory plugin.
Goal: goal-6d730275-6f89-4d03-afb3-caa4891a9f55.
DDR: /tmp/dsh-ddr/2026-10-28-dsh-web-provider.ddr.yaml.

## Objective

Give Paseo a DSH provider that talks to a **native DSH host** instead of the one-shot
headless CLI, so the DSH command plane is real in Paseo: `/goal` creates and arms a
persisted goal, `/plan` flips the plan mode the host owns, and every command the host
advertises (`commands/list`) appears in Paseo's composer and executes natively
(`commands/execute`). Sessions are real DSH sessions, so they also appear in the DSH
web UI / Rowel.

Success is observable: from Paseo, `paseo run --provider dsh-web "/goal <objective>"`
creates a goal that `get_goal` reads back, and `/plan` puts the session in the host's
plan mode (the `plan` projection reads `active: true`).

## Current state (evidence, with instruments)

1. **Paseo's DSH integration is the one-shot headless CLI.**
   `plugins/dsh-provider/README.md`: one Paseo session is a chain of
   `dsh --profile headless --json [--session-id <id>] <prompt>` processes, one per turn.
2. **Headless has no command adapter.**
   `@deepseek-ai/dsh-commands/README.md` (asar): "Use it for direct human controls in the
   `dsh` CLI or Web client; UI-less demos and ACP automation do not provide this command
   surface." `@deepseek-ai/dsh-command-goal/README.md`: "Use this package in interactive
   deployments that mount a command adapter; headless and automation apps without one do
   not need it."
3. **A literal `/goal` line is prose, not a command.**
   `packages/app/src/composer/index.tsx:1711` `handleSubmit` falls through to
   `sendMessageWithContent` when no client/plugin command matches;
   `packages/server/src/server/agent/plugin-provider.ts:1701` `mapPromptInput` only builds
   `{type:"command"}` for names the provider advertised, otherwise `{type:"message"}`.
4. **The command plane exists behind the web host's API.**
   `@deepseek-ai/dsh-commands/lib/typert.remote-client.js` declares `commands/execute`
   `(sessionId, line, attachments)` and `commands/list` `(sessionId)`;
   `@deepseek-ai/dsh-client-ui-commands/lib/client.js` executes `/plan` and `/goal` through
   `ctx.remote.commands.execute(sessionId, line, attachments)`.
5. **A working third-party client of that API exists.**
   `~/.dsh/plugins/bridle-plugin/node_modules/@rowel/bridle/lib/dsh/{auth,client,remote-mux}.js`:
   `GET /?token=` → 303 + signed cookie; unary `POST /api/<endpoint>` with a
   `client-request` envelope; all streams on one `/api/remote.mux` WebSocket.
6. **Paseo already has the seam for provider-owned commands.**
   `packages/plugin/src/server/provider.ts:358` `ProviderCommand` + the
   `session.commands` event; `packages/server/src/server/agent/plugin-provider.ts:1701`
   routes a matching `/name args` to the provider as `{type:"command"}`.

## Hypotheses

- H1 (build on it): a Paseo plugin provider can spawn `dsh web --no-open --host 127.0.0.1
--port <free>`, exchange the launch token for the cookie, and drive sessions, prompts,
  events and commands over the same wire the browser uses.
  For: the bridle client does exactly this against a running host; the host prints the
  tokenized URL; the API is Typert-generated and stable within 0.2.x.
  Against: the host is a heavier dependency than a CLI spawn (profile boot, a long-lived
  child, a listening socket) and its profile may load plugins a Paseo-owned host should
  not run (bridle/relay). Mitigation: the provider owns a dedicated profile and disables
  outward rows by default.
- H2: Paseo's `session.commands` + `prompt.command` is enough to surface the real DSH
  commands with their real input hints, and `commands/execute` is enough to run them.
  For: `commands/list` returns name/description/input.hint per command; `mapPromptInput`
  already builds the command prompt shape.
  Against: Paseo may not render a command's _result_ (goal created, plan entered) as a
  card; the effect must be visible through the session stream (goal projection, plan
  projection). The provider must project those into timeline items.

## Design

New plugin `plugins/dsh-web-provider` (provider id `dsh-web`), side-by-side with the
existing headless `dsh-provider`. Nothing in the existing provider changes.

```
plugins/dsh-web-provider/
  paseo-plugin.json          id dsh-web-provider, requirements paseo >=0.10.0
  package.json
  index.server.ts            server.registerProvider(createDshWebProvider())
  server/
    provider.ts              registration, connection, dispatch
    host.ts                  spawn/own `dsh web`, token exchange, lifecycle, restart
    wire.ts                  unary POST /api/<endpoint> + /api/remote.mux streams
    session.ts               Paseo session <-> DSH session; event projection
    catalog.ts               models/commands discovery
  test/
    provider.test.ts         deterministic suite against a fake host
    live.mjs                 live contract harness against a real `dsh web`
```

Transport: HTTP unary + one WebSocket mux, implemented with Node built-ins (`fetch`,
`WebSocket` in Node 22+) so the plugin keeps the existing provider's "no dependencies"
property. Cookie is held per host base and dropped on a refusal.

Host: one `dsh web` child per provider connection. The provider:

- picks a free loopback port, spawns
  `dsh web --no-open --host 127.0.0.1 --port <port> --profile <profile> [--patch <overlay>]`,
- reads the `dsh web:` line from stdout (timeout), extracts the token, exchanges it,
- serves the connection; on `close()` sends SIGTERM and waits, then SIGKILL after a grace
  period.

Session: Paseo `session.open` → `session/create` (reuse a persisted DSH session id when
`persistence` carries one, otherwise create); `session/follow` opens the event stream.
`session.prompt` → `session/prompt`; `session.interrupt` → `session/cancel`;
`session.close` closes the stream and leaves the DSH session intact (history is the user's).

Commands: after open, `commands/list` → `session.commands`; `{type:"command"}` prompts →
`commands/execute` with `line = "/" + name + (arguments ? " " + arguments : "")`. The
effect arrives through `session/follow` (`command/run`/`command/done`, goal/plan
projections) and is projected to Paseo timeline items.

Modes: v1 exposes no ProviderMode. Plan mode is entered with `/plan`; the plan projection
is surfaced as a status/timeline item. (Deferred: a `plan`/`build` mode pair that maps to
`/plan` and `/plan off`.)

## Definition of Done (observable)

1. `npx vitest run plugins/dsh-web-provider` green, with a fake-host suite covering:
   token exchange, cookie refusal, unary envelope, stream framing, prompt→follow
   projection, command prompt → `commands/execute`, interrupt, host death → session error.
2. `DSH_WEB_LIVE=1 npx vitest run plugins/dsh-web-provider` against a real loopback `dsh web`
   (implemented as `server/live.test.ts`, scratch `DSH_HOME`):
   create session, prompt "Reply with exactly: ok", assert the assistant text arrives;
   `/goal <objective>` then `get_goal`-equivalent projection shows the goal;
   `/plan` shows the plan projection active; `/plan off` clears it; interrupt leaves the
   session resumable.
3. Side-by-side install: `paseo plugin add <path>` reports running; a Paseo agent on
   provider `dsh-web` shows the DSH command list in the composer, and typing `/goal` from
   Paseo creates a goal (verified by reading it back through the provider).
4. The existing `plugins/dsh-provider` suite stays green (no shared code changed).

## Out of scope

- Replacing the headless provider or migrating existing agents.
- MCP injection into DSH sessions (the host's own MCP rows own that).
- A Paseo-hosted plan-mode review card; DSH's `exit_plan_mode` review needs a DSH client.
- Any change to the Studio's live web host or the Rowel identity.

## Risks

- The host is a heavier child than the CLI: profile boot time (~seconds), one listening
  loopback socket, and plugins the profile mounts. Mitigated by a dedicated profile and
  documented `--patch` overlay to disable outward rows.
- Typert wire shapes can drift between DSH releases; the live harness is the guard.
- The web host shares `$DSH_HOME` state with the user's own DSH surfaces (sessions,
  settings). That is a feature (same history) but means a bad provider must never delete
  sessions — it only creates, prompts, cancels, and reads.
