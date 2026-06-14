/**
 * Phase 2 swap test (no real Anthropic key needed).
 *
 * Sends a Messages request through the gateway carrying a real-shaped AWS
 * key in: (a) the system string, (b) a user text block, and (c) inside a
 * tool_result block (a file the agent read). A fake upstream captures exactly
 * what the gateway forwarded.
 *
 * Asserts:
 *   • the secret in system + user text is replaced with WYLOC_MOCK_
 *   • the secret in the tool_result (file content) is ALSO swapped — to the
 *     SAME deterministic mock — now that file-read masking is on by default
 *   • the upstream body does NOT contain the real secret anywhere
 *   • tool_use.input is byte-IDENTICAL and the tool_result ENVELOPE
 *     (type, tool_use_id) is preserved — only the file text payload changed
 *   • message structure (roles, block order, ids) is preserved
 */

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const UPSTREAM_PORT = 9921;
const GATEWAY_PORT = 9922;

// AKIA + 16 base32 chars — matches the detector's aws-access-key pattern.
const SECRET = "AKIA5XQ2WJ8NPLR3MKVT";

const requestObj = {
  model: "claude-opus-4-8",
  max_tokens: 64,
  system: `You are a helpful assistant. The deploy key is ${SECRET} keep it safe.`,
  messages: [
    {
      role: "user",
      content: [
        { type: "text", text: `Please rotate my AWS key ${SECRET} in the config.` },
      ],
    },
    {
      role: "assistant",
      content: [
        { type: "tool_use", id: "toolu_42", name: "read_file", input: { path: "/etc/app/.env" } },
      ],
    },
    {
      role: "user",
      content: [
        // The same secret lives here in a tool_result (file content). It is now
        // swapped to the same mock by the file-read masking pass, while the
        // tool_result envelope (type, tool_use_id) stays intact.
        { type: "tool_result", tool_use_id: "toolu_42", content: `AWS_KEY=${SECRET}` },
      ],
    },
  ],
  stream: true,
};

let captured = null;

function startUpstream() {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        captured = Buffer.concat(chunks).toString("utf8");
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end("event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n");
      });
    });
    server.listen(UPSTREAM_PORT, "127.0.0.1", () => resolve(server));
  });
}

function startGateway() {
  return spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: new URL(".", import.meta.url).pathname,
    env: {
      ...process.env,
      WYLOC_GATEWAY_PORT: String(GATEWAY_PORT),
      WYLOC_UPSTREAM_BASE_URL: `http://127.0.0.1:${UPSTREAM_PORT}`,
      WYLOC_VERBOSE: "true",
    },
    stdio: ["ignore", "inherit", "inherit"],
  });
}

function assert(cond, msg) {
  if (!cond) {
    console.error(`  ✗ FAIL: ${msg}`);
    process.exitCode = 1;
  } else {
    console.error(`  ✓ ${msg}`);
  }
}

async function main() {
  const upstream = await startUpstream();
  const gateway = startGateway();

  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${GATEWAY_PORT}/healthz`)).ok) break;
    } catch {}
    await sleep(100);
  }

  await fetch(`http://127.0.0.1:${GATEWAY_PORT}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": "sk-ant-FAKE",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(requestObj),
  });

  console.error("\n── Phase 2 swap assertions ─────────────────────────");
  assert(captured !== null, "upstream received the (rewritten) request");

  const upstreamObj = JSON.parse(captured);

  // The secret must be gone from the positions we rewrite, replaced by a mock.
  assert(
    !upstreamObj.system.includes(SECRET),
    "real secret removed from system field",
  );
  assert(upstreamObj.system.includes("WYLOC_MOCK_"), "system field now carries a mock");

  const userText = upstreamObj.messages[0].content[0].text;
  assert(!userText.includes(SECRET), "real secret removed from user text block");
  assert(userText.includes("WYLOC_MOCK_"), "user text block now carries a mock");

  // The SAME secret yields the SAME mock (deterministic) in both places.
  const mockInSystem = upstreamObj.system.match(/WYLOC_MOCK_\S+/)[0].replace(/\W+$/, "");
  const mockInText = userText.match(/WYLOC_MOCK_\S+/)[0].replace(/\W+$/, "");
  assert(
    mockInSystem === mockInText,
    `same secret → same mock in both places (${mockInText})`,
  );

  // tool_use and tool_result must be byte-intact.
  const toolUse = upstreamObj.messages[1].content[0];
  assert(toolUse.type === "tool_use" && toolUse.id === "toolu_42", "tool_use id preserved");
  assert(
    JSON.stringify(toolUse.input) === JSON.stringify({ path: "/etc/app/.env" }),
    "tool_use.input untouched",
  );

  const toolResult = upstreamObj.messages[2].content[0];
  // Envelope intact; file text payload masked.
  assert(
    toolResult.type === "tool_result" && toolResult.tool_use_id === "toolu_42",
    "tool_result envelope (type, tool_use_id) preserved",
  );
  assert(!toolResult.content.includes(SECRET), "secret swapped out of tool_result (file) content");
  assert(
    toolResult.content.startsWith("AWS_KEY=") && toolResult.content.includes("WYLOC_MOCK_"),
    "tool_result content shape preserved, value replaced by a mock",
  );
  const mockInFile = toolResult.content.match(/WYLOC_MOCK_\S+/)[0].replace(/\W+$/, "");
  assert(
    mockInFile === mockInText,
    "same secret in file → same mock as the typed text (deterministic)",
  );

  // Structure preserved.
  assert(
    upstreamObj.messages.map((m) => m.role).join(",") === "user,assistant,user",
    "message roles + order preserved",
  );
  assert(upstreamObj.model === "claude-opus-4-8" && upstreamObj.stream === true, "other fields preserved");

  upstream.close();
  gateway.kill("SIGTERM");

  console.error(
    process.exitCode
      ? "\n✗ Phase 2 swap test FAILED\n"
      : "\n✓ Phase 2 swap test PASSED\n",
  );
}

main().catch((err) => {
  console.error("test error", err);
  process.exit(1);
});
