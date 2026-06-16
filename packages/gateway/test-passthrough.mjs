/**
 * Phase 1 plumbing test (no real Anthropic key needed).
 *
 * 1. Starts a fake "upstream" that behaves like /v1/messages: it echoes
 *    back the headers + body it received, and streams an SSE response.
 * 2. Starts the gateway pointed at the fake upstream.
 * 3. Sends a request through the gateway and asserts:
 *      - auth + anthropic-version + anthropic-beta reached upstream intact
 *      - the request body arrived byte-identical
 *      - the SSE response framing came back unchanged
 */

import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const UPSTREAM_PORT = 9911;
const GATEWAY_PORT = 9912;

// A representative Messages request body with tool blocks but NO secret,
// to confirm pass-through forwards a clean body byte-identical (Phase 2's
// swap only rewrites bodies that contain a detected secret).
const REQUEST_BODY = JSON.stringify({
  model: "claude-opus-4-8",
  max_tokens: 64,
  system: "You are a helpful assistant.",
  messages: [
    { role: "user", content: "What is the weather in San Francisco?" },
    {
      role: "assistant",
      content: [
        { type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "SF" } },
      ],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "72F" }],
    },
  ],
  stream: true,
});

const SSE_RESPONSE = [
  'event: message_start',
  'data: {"type":"message_start","message":{"id":"msg_x","type":"message","role":"assistant","content":[],"model":"claude-opus-4-8","stop_reason":null,"usage":{"input_tokens":10,"output_tokens":1}}}',
  '',
  'event: content_block_start',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}',
  '',
  'event: content_block_stop',
  'data: {"type":"content_block_stop","index":0}',
  '',
  'event: message_stop',
  'data: {"type":"message_stop"}',
  '',
].join("\n");

let capturedUpstream = null;

function startUpstream() {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        capturedUpstream = {
          method: req.method,
          url: req.url,
          headers: req.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        };
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "anthropic-ratelimit-requests-remaining": "42",
        });
        // Write the SSE in two chunks to exercise streaming.
        const mid = Math.floor(SSE_RESPONSE.length / 2);
        res.write(SSE_RESPONSE.slice(0, mid));
        setTimeout(() => {
          res.write(SSE_RESPONSE.slice(mid));
          res.end();
        }, 10);
      });
    });
    server.listen(UPSTREAM_PORT, "127.0.0.1", () => resolve(server));
  });
}

function startGateway() {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "src/index.ts"],
    {
      cwd: fileURLToPath(new URL(".", import.meta.url)),
      env: {
        ...process.env,
        WYLOC_GATEWAY_PORT: String(GATEWAY_PORT),
        WYLOC_UPSTREAM_BASE_URL: `http://127.0.0.1:${UPSTREAM_PORT}`,
        WYLOC_VERBOSE: "true",
      },
      stdio: ["ignore", "inherit", "inherit"],
    },
  );
  return child;
}

function assert(cond, msg) {
  if (!cond) {
    console.error(`\n  ✗ FAIL: ${msg}`);
    process.exitCode = 1;
  } else {
    console.error(`  ✓ ${msg}`);
  }
}

async function main() {
  const upstream = await startUpstream();
  const gateway = startGateway();

  // Wait for the gateway to be listening.
  for (let i = 0; i < 50; i++) {
    try {
      const h = await fetch(`http://127.0.0.1:${GATEWAY_PORT}/healthz`);
      if (h.ok) break;
    } catch {}
    await sleep(100);
  }

  // Fire a request through the gateway with representative headers.
  const resp = await fetch(`http://127.0.0.1:${GATEWAY_PORT}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": "sk-ant-FAKE-TEST-KEY",
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "messages-2023-12-15",
    },
    body: REQUEST_BODY,
  });

  const text = await resp.text();

  console.error("\n── Phase 1 plumbing assertions ─────────────────────");
  assert(resp.status === 200, "gateway returned 200");
  assert(
    resp.headers.get("content-type") === "text/event-stream",
    "upstream content-type preserved (text/event-stream)",
  );
  assert(
    resp.headers.get("anthropic-ratelimit-requests-remaining") === "42",
    "upstream custom headers preserved",
  );

  assert(capturedUpstream !== null, "upstream received the request");
  assert(
    capturedUpstream?.headers["x-api-key"] === "sk-ant-FAKE-TEST-KEY",
    "x-api-key relayed to upstream unchanged",
  );
  assert(
    capturedUpstream?.headers["anthropic-version"] === "2023-06-01",
    "anthropic-version relayed to upstream",
  );
  assert(
    capturedUpstream?.headers["anthropic-beta"] === "messages-2023-12-15",
    "anthropic-beta relayed to upstream",
  );
  assert(
    capturedUpstream?.headers["host"] === `127.0.0.1:${UPSTREAM_PORT}`,
    "host header rewritten to upstream host",
  );
  assert(
    capturedUpstream?.body === REQUEST_BODY,
    "request body forwarded byte-identical (Phase 1: no swap yet)",
  );

  assert(
    text === SSE_RESPONSE,
    "SSE response streamed back byte-identical",
  );

  upstream.close();
  gateway.kill("SIGTERM");

  console.error(
    process.exitCode
      ? "\n✗ Phase 1 plumbing test FAILED\n"
      : "\n✓ Phase 1 plumbing test PASSED\n",
  );
}

main().catch((err) => {
  console.error("test error", err);
  process.exit(1);
});
