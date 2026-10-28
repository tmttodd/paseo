#!/usr/bin/env node
// A fake `dsh web` host for the provider suite. It speaks the real wire shape —
// the launch-token handshake, the `client-request` unary envelope, and the
// `/api/remote.mux` stream frames — so the provider is exercised through its
// real transport, not a mock.
//
//   node fake-host.mjs --profile web --no-open --host 127.0.0.1 --port 0
//
// Prints the one `dsh web:` line the provider waits for, then serves until
// killed. Every session it creates is `session-fake-1`.

import { createHash } from "node:crypto";
import { createServer } from "node:http";

const TOKEN = "fake-token";
const COOKIE = "dsh-auth-fake=1";
const eventStreams = new Set();

const argv = process.argv.slice(2);
const portFlag = argv.indexOf("--port");
const port = portFlag >= 0 ? Number(argv[portFlag + 1] ?? "0") : 0;

/** sessionId → { follows:Set<stream>, planActive, turn } */
const sessions = new Map();

function sessionOf(id) {
  let session = sessions.get(id);
  if (session === undefined) {
    session = {
      follows: new Set(),
      planActive: false,
      turn: 0,
      preset: "standard",
      permission: "workspace-write",
    };
    sessions.set(id, session);
  }
  return session;
}

function reply(res, rpcId, result) {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ type: "server-response", rpcId, result }));
}

function ok(res, rpcId, value) {
  reply(res, rpcId, value === undefined ? { ok: true } : { ok: true, value });
}

function fail(res, rpcId, code, message) {
  reply(res, rpcId, { ok: false, error: { code, message, details: {} } });
}

function send(stream, value) {
  if (stream.closed) return;
  stream.write({ type: "item", streamId: stream.id, value });
}

function sendEvent(stream, event) {
  send(stream, { type: "event", event: { ...event, seq: stream.nextSeq++, time: Date.now() } });
}

function broadcastWaterfall(session, eventId, request) {
  for (const stream of eventStreams) {
    send(stream, {
      type: "waterfall",
      event: "user-questions/request",
      eventId,
      agentId: session.id ?? "session-fake-1",
      request,
    });
  }
}

function broadcast(session, event) {
  for (const stream of session.follows) sendEvent(stream, event);
}

function projections(session) {
  return {
    asOfSeq: 0,
    values: {
      title: null,
      agentPreset: session.preset,
      sessionListMetadata: { blank: session.turn === 0, lastPromptAt: null },
      plan: { active: session.planActive, pending: false },
      permissions: { currentValue: session.permission },
      modelSelection: {
        lastUsed: { provider: "fake-provider", model: "fake-model" },
        next: { provider: "fake-provider", model: "fake-model" },
      },
      goal: null,
    },
  };
}

const COMMANDS = [
  {
    definitionId: "dsh-command-goal",
    name: "goal",
    description: "Set or view the goal",
    input: { hint: "[<objective>|clear|edit <objective>|pause|resume]", attachments: true },
  },
  {
    definitionId: "dsh-plan-mode",
    name: "plan",
    description: "Enter or leave plan mode",
    input: { hint: "[off|message]", attachments: true },
  },
  {
    definitionId: "dsh-command-compact",
    name: "compact",
    description: "Compact older conversation history",
  },
  {
    definitionId: "dsh-command-feedback",
    name: "feedback",
    description: "Record feedback about this session",
    input: { hint: "<text>" },
  },
  {
    definitionId: "dsh-session-log-export",
    name: "export",
    description: "Download this Session log as a ZIP archive",
  },
];

const PRESETS = [
  { id: "standard", isDefault: true },
  { id: "ptc" },
  { id: "cordis" },
  { id: "minimal" },
  { id: "dsh-ops", name: "Ops", description: "Custom ops preset" },
];

const MODEL_CATALOG = {
  default: { provider: "fake-provider", model: "fake-model", reasoningEffort: "high" },
  routableProviders: ["fake-provider"],
  groups: [
    {
      id: "fake-provider",
      name: "Fake Provider",
      models: [
        {
          id: "fake-model",
          name: "Fake Model",
          description: "The model this fake host serves",
          reasoning: {
            efforts: [
              { id: "low", name: "Low" },
              { id: "high", name: "High" },
            ],
            defaultEffort: "high",
          },
        },
        { id: "fake-model-fast", name: "Fake Model Fast" },
      ],
    },
  ],
  failures: [],
};

async function dispatch(method, args, res, rpcId) {
  // Session endpoints take `{request: {...}}` (or `{_request: {...}}`); the
  // command endpoints take flat named fields.
  const request = args?.request ?? args?._request ?? args ?? {};
  if (method === "commands/list" || method === "commands/execute") {
    dispatchCommand(method, request, res, rpcId);
    return;
  }
  dispatchSession(method, request, res, rpcId);
}

function dispatchCommand(method, request, res, rpcId) {
  if (method === "commands/list") {
    ok(res, rpcId, COMMANDS);
    return;
  }
  const session = sessionOf(request.agentId);
  const line = String(request.line ?? "");
  const name = line.slice(1).split(" ")[0] ?? "";
  const rest = line.slice(1 + name.length).trim();
  if (name === "plan") {
    runPlan(session, rest, res, rpcId);
    return;
  }
  if (name === "permission") {
    session.permission = rest === "" ? session.permission : rest;
    for (const follow of session.follows) {
      send(follow, {
        type: "projection",
        sessionId: request.agentId,
        key: "permissions",
        value: { currentValue: session.permission },
        seq: 0,
      });
    }
    ok(res, rpcId, { commandId: "permission", result: undefined });
    return;
  }
  if (name === "goal") {
    runGoal(session, rest, res, rpcId);
    return;
  }
  ok(res, rpcId, undefined);
}

function runPlan(session, rest, res, rpcId) {
  const off = rest === "off";
  session.planActive = !off;
  const text = off ? "Plan mode off." : "Plan mode on. Use /plan off to leave.";
  const commandId = `cmd-${String(session.turn + 1)}`;
  ok(res, rpcId, { commandId, result: { kind: "success", text } });
  broadcast(session, {
    type: "command/run",
    data: { commandId, name: "plan", source: { kind: "user" } },
  });
  broadcast(session, { type: "plan/mode", data: { active: !off } });
  broadcast(session, { type: "command/done", data: { commandId, kind: "success", text } });
}

function runGoal(session, objective, res, rpcId) {
  ok(res, rpcId, { commandId: "cmd-goal", result: { kind: "success", text: "Goal created." } });
  broadcast(session, {
    type: "goal/change",
    data: {
      goal: { id: "goal-fake", revision: 1, objective, phase: "active", maxGoalRounds: 256 },
      roundsStarted: 0,
    },
  });
  broadcast(session, {
    type: "command/done",
    data: { commandId: "cmd-goal", kind: "success", text: "Goal created." },
  });
}

function dispatchSession(method, request, res, rpcId) {
  switch (method) {
    case "session/create": {
      const sessionId = request.sessionId ?? "session-fake-1";
      const session = sessionOf(sessionId);
      if (typeof request.agentPreset === "string") session.preset = request.agentPreset;
      ok(res, rpcId, { sessionId, agentPreset: session.preset });
      return;
    }
    case "permissionPresets/catalog":
      ok(res, rpcId, {
        options: [
          { value: "read-only", name: "Read Only" },
          { value: "workspace-write", name: "Workspace Write" },
          { value: "danger-full-access", name: "Full access" },
        ],
        defaultOptions: [],
        defaultPreset: "danger-full-access",
      });
      return;
    case "$events/result":
      acceptWaterfallAnswer(request, res, rpcId);
      return;
    case "agentPresets/list":
      ok(res, rpcId, { presets: PRESETS });
      return;
    case "agentPresets/select": {
      const session = sessionOf(request.agentId);
      session.preset = request.agentPreset;
      ok(res, rpcId, request.agentPreset);
      return;
    }
    case "session/modelCatalog":
      ok(res, rpcId, MODEL_CATALOG);
      return;
    case "session/projections": {
      const session = sessions.get(request.sessionId);
      ok(res, rpcId, session === undefined ? null : projections(session));
      return;
    }
    case "session/prompt":
      acceptPrompt(request, res, rpcId);
      return;
    case "session/cancel": {
      const session = sessions.get(request.sessionId);
      ok(res, rpcId, { accepted: true });
      if (session !== undefined) {
        broadcast(session, {
          type: "turn/end",
          data: { turn: session.turn, reason: { kind: "aborted" } },
        });
      }
      return;
    }
    case "session/selectModel": {
      ok(res, rpcId, {
        selected: {
          provider: request.provider,
          model: request.model,
          ...(request.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: request.reasoningEffort }),
        },
      });
      return;
    }
    default:
      fail(res, rpcId, "gateway/unknown", `no endpoint ${method}`);
  }
}

function acceptWaterfallAnswer(request, res, rpcId) {
  const args = request.args ?? {};
  const answers = args?.outcome?.value?.answers;
  const valid =
    args?.outcome?.kind === "result" &&
    Array.isArray(answers) &&
    answers.length > 0 &&
    typeof answers[0]?.id === "string" &&
    Array.isArray(answers[0]?.selected);
  if (!valid) {
    fail(res, rpcId, "BAD_ANSWER", "waterfall answer is malformed");
    return;
  }
  ok(res, rpcId, true);
}

function acceptPrompt(request, res, rpcId) {
  const session = sessionOf(request.sessionId);
  const text = (request.content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
  session.turn += 1;
  const turn = session.turn;
  // dsh may start the turn before the prompt call returns; emit the start first
  // so the suite pins the admission race.
  broadcast(session, { type: "turn/start", data: { turn } });
  ok(res, rpcId, { accepted: true });
  // The host asks the user a question mid-turn (ask_user_question / exit_plan_mode).
  console.error("[fake] prompt text:", JSON.stringify(text));
  if (text.includes("ask-question")) {
    broadcastWaterfall(session, "evt-question", {
      questions: [
        {
          id: "q1",
          question: "Which option?",
          header: "Choice",
          options: [{ label: "A" }, { label: "B" }],
        },
      ],
      wait: { callId: "call-1" },
    });
  }
  if (text.includes("exit-plan")) {
    broadcastWaterfall(session, "evt-plan", {
      questions: [
        {
          id: "plan-review",
          question: "Approve this plan?",
          detail: "# Plan\nDo the thing.",
          options: [{ label: "Approve" }, { label: "Keep planning" }],
        },
      ],
      // `exit_plan_mode` asks without a `wait`; the waterfall eventId is the identity.
    });
  }
  // A prompt mentioning "long" keeps its turn open so the suite can interrupt it.
  const slow = text.includes("long");
  setTimeout(() => {
    broadcast(session, {
      type: "user/message",
      data: {
        content: [{ type: "text", text }],
        source: { kind: "user", rpcId: request.requestId },
        role: "user",
      },
    });
    broadcast(session, {
      type: "assistant/message",
      data: {
        turn,
        step: 1,
        message: { role: "assistant", content: [{ type: "text", text: `fake reply to: ${text}` }] },
        usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18, cacheReadTokens: 3 },
      },
    });
    const finish = () =>
      broadcast(session, { type: "turn/end", data: { turn, reason: { kind: "completed" } } });
    if (slow) setTimeout(finish, 3_000);
    else finish();
  }, 5);
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (req.method === "GET" && url.pathname === "/") {
    if (url.searchParams.get("token") !== TOKEN) {
      res.writeHead(401, { "content-type": "text/plain" });
      res.end("dsh web authentication required; reopen the URL printed by dsh web.\n");
      return;
    }
    res.writeHead(303, {
      "set-cookie": `${COOKIE}; Max-Age=2592000; Path=/; HttpOnly; SameSite=Strict`,
      location: "./",
      "cache-control": "no-store",
    });
    res.end();
    return;
  }
  if (req.method === "POST" && url.pathname.startsWith("/api/")) {
    if (!(req.headers.cookie ?? "").includes("dsh-auth-")) {
      res.writeHead(401, { "content-type": "text/plain" });
      res.end("unauthorized\n");
      return;
    }
    const method = url.pathname.slice("/api/".length);
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      let envelope;
      try {
        envelope = JSON.parse(body);
      } catch {
        res.writeHead(400);
        res.end("body is not JSON");
        return;
      }
      if (envelope.method !== method) {
        reply(res, envelope.rpcId, {
          ok: false,
          error: { code: "gateway/bad-request", message: "method mismatch", details: {} },
        });
        return;
      }
      void dispatch(method, envelope.payload?.args ?? {}, res, envelope.rpcId).catch((error) => {
        fail(res, envelope.rpcId, "internal", String(error));
      });
    });
    return;
  }
  res.writeHead(404);
  res.end("not found");
});

server.on("upgrade", (req, socket) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname !== "/api/remote.mux" || !(req.headers.cookie ?? "").includes("dsh-auth-")) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }
  const accept = createHash("sha1")
    .update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
  socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "\r\n",
    ].join("\r\n"),
  );
  const streams = new Map();
  let buffer = Buffer.alloc(0);
  const write = (frame) => {
    if (socket.destroyed) return;
    socket.write(encodeText(JSON.stringify(frame)));
  };
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const decoded = decodeFrame(buffer);
      if (decoded === undefined) return;
      buffer = buffer.subarray(decoded.consumed);
      if (decoded.opcode === 0x8) {
        socket.destroy();
        return;
      }
      if (decoded.opcode !== 0x1) continue;
      let frame;
      try {
        frame = JSON.parse(decoded.payload.toString("utf8"));
      } catch {
        continue;
      }
      handleFrame(frame);
    }
  });
  socket.on("error", () => {});
  socket.on("close", () => {
    for (const stream of streams.values()) {
      stream.closed = true;
      sessions.get(stream.sessionId)?.follows.delete(stream);
      eventStreams.delete(stream);
    }
    streams.clear();
  });

  function handleFrame(frame) {
    if (frame.type === "open") {
      const stream = {
        id: frame.streamId,
        sessionId: frame.payload?.args?.request?.address?.sessionId,
        nextSeq: 0,
        closed: false,
        write: (value) => write(value),
      };
      streams.set(frame.streamId, stream);
      if (frame.endpoint === "$events") {
        eventStreams.add(stream);
        send(stream, { type: "ready", clientId: "fake-client", host: { home: "/tmp" } });
        return;
      }
      if (frame.endpoint === "session/follow") {
        const session = sessionOf(stream.sessionId);
        session.follows.add(stream);
        send(stream, {
          type: "snapshot",
          header: { version: 4, id: stream.sessionId, createdAt: Date.now(), isSeeded: false },
          cursor: 0,
          records: [],
          hasMore: false,
          projections: projections(session),
        });
        return;
      }
      write({
        type: "error",
        streamId: frame.streamId,
        error: { code: "gateway/unknown", message: `no stream ${frame.endpoint}`, details: {} },
      });
      return;
    }
    if (frame.type === "cancel") {
      const stream = streams.get(frame.streamId);
      if (stream !== undefined) {
        stream.closed = true;
        streams.delete(frame.streamId);
        sessions.get(stream.sessionId)?.follows.delete(stream);
      }
    }
  }
});

server.listen(port, "127.0.0.1", () => {
  const actual = server.address().port;
  process.stdout.write(`dsh web: http://127.0.0.1:${actual}/?token=${TOKEN}\n`);
});

process.on("SIGTERM", () => {
  server.close();
  process.exit(0);
});

function decodeFrame(buffer) {
  if (buffer.length < 2) return undefined;
  const first = buffer[0];
  const second = buffer[1];
  const fin = (first & 0x80) !== 0;
  const opcode = first & 0x0f;
  const masked = (second & 0x80) !== 0;
  let length = second & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < offset + 2) return undefined;
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buffer.length < offset + 8) return undefined;
    length = Number(buffer.readBigUInt64BE(offset));
    offset += 8;
  }
  let mask;
  if (masked) {
    if (buffer.length < offset + 4) return undefined;
    mask = buffer.subarray(offset, offset + 4);
    offset += 4;
  }
  if (buffer.length < offset + length) return undefined;
  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (mask !== undefined) {
    for (let index = 0; index < payload.length; index += 1) {
      payload[index] ^= mask[index % 4];
    }
  }
  return { fin, opcode, payload, consumed: offset + length };
}

function encodeText(text) {
  const payload = Buffer.from(text, "utf8");
  if (payload.length < 126) {
    return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  }
  const header = Buffer.alloc(4);
  header[0] = 0x81;
  header[1] = 126;
  header.writeUInt16BE(payload.length, 2);
  return Buffer.concat([header, payload]);
}
