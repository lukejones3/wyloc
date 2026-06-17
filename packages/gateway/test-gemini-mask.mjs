/**
 * Gemini API request-masking + round-trip integration test.
 * WYLOC_MASK_SQL + WYLOC_MASK_CODE on. No real API key.
 *
 * Proves /v1beta/models/{model}:streamGenerateContent is masked:
 *   - systemInstruction parts + contents[].parts[].text → masked
 *   - fenced SQL in a user part → SQL-masked
 *   - functionResponse.response (a read .ts file) → full file-read treatment
 *     (code identifier + secret), not just secrets
 *   - functionCall (name/args), functionDeclarations, inlineData → BYTE-INTACT
 *   - streamed response (mock split across SSE deltas) rehydrates to the secret
 */
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const UP = 9974, GW = 9975, SECRET = "AKIA5XQ2WJ8NPLR3MKVT";
let captured = null;

const FENCE = "```";
const req = {
  systemInstruction: { parts: [{ text: `You are helpful. Deploy key ${SECRET} keep it safe.` }] },
  contents: [
    { role: "user", parts: [{ text: `optimize:\n${FENCE}sql\nSELECT id FROM secret_ledger\n${FENCE}` }] },
    { role: "model", parts: [{ text: `earlier the key ${SECRET} appeared` }] },
    { role: "model", parts: [{ functionCall: { name: "read_file", args: { path: "/etc/app/.env" } } }] },
    { role: "user", parts: [{ functionResponse: { name: "read_file", response: { output: `export class LedgerStore {\n  key = "${SECRET}";\n}` } } }] },
    { role: "user", parts: [{ inlineData: { mimeType: "image/png", data: "iVBORw0KGgoAAAANSU" } }] },
  ],
  tools: [{ functionDeclarations: [{ name: "read_file", description: "Reads a file from disk", parameters: { type: "object", properties: { path: { type: "string" } } } }] }],
};

function startUpstream() {
  return new Promise((resolve) => {
    const s = createServer((rq, rs) => {
      const c = []; rq.on("data", (x) => c.push(x));
      rq.on("end", () => {
        captured = Buffer.concat(c).toString("utf8");
        // Echo the gateway-produced mock back, split across two SSE deltas, then
        // a terminal chunk with finishReason — exercises split-safe rehydration.
        const mock = (captured.match(/WYLOC_MOCK_[A-Z0-9_]+/) || ["WYLOC_MOCK_NONE"])[0];
        const chunk = (parts, finishReason = null) =>
          `data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts }, finishReason, index: 0 }] })}\r\n\r\n`;
        rs.writeHead(200, { "content-type": "text/event-stream" });
        rs.write(chunk([{ text: `The deploy key ${mock.slice(0, 11)}` }]));
        rs.write(chunk([{ text: `${mock.slice(11)} is set.` }]));
        rs.write(chunk([{ text: "" }], "STOP"));
        rs.end();
      });
    });
    s.listen(UP, "127.0.0.1", () => resolve(s));
  });
}
function startGateway() {
  return spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: fileURLToPath(new URL(".", import.meta.url)),
    env: { ...process.env, WYLOC_GATEWAY_PORT: String(GW), WYLOC_GEMINI_UPSTREAM_BASE_URL: `http://127.0.0.1:${UP}`, WYLOC_MASK_SQL: "true", WYLOC_MASK_CODE: "true", WYLOC_VERBOSE: "true" },
    stdio: ["ignore", "inherit", "inherit"],
  });
}
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, d = "") => { if (c) pass++; else { fail++; fails.push(`  ✗ ${n}${d ? " — " + d : ""}`); } };

async function main() {
  const up = await startUpstream();
  const gw = startGateway();
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`http://127.0.0.1:${GW}/healthz`)).ok) break; } catch {} await sleep(100); }
  await sleep(1500); // let the sqlglot worker warm up

  const resp = await fetch(`http://127.0.0.1:${GW}/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": "FAKE-KEY" },
    body: JSON.stringify(req),
  }).catch(() => null);
  const respBody = resp ? await resp.text() : "";
  await sleep(300);

  console.error("\n── Gemini request-masking assertions ──");
  ok("upstream received the request", captured !== null);
  const o = captured ? JSON.parse(captured) : {};

  // systemInstruction (system-equivalent) masked
  const sysText = o.systemInstruction?.parts?.[0]?.text ?? "";
  ok("systemInstruction secret masked", !sysText.includes(SECRET) && sysText.includes("WYLOC_MOCK_"), sysText);

  // user text part masked (SQL)
  const userText = o.contents?.[0]?.parts?.[0]?.text ?? "";
  ok("user part SQL table masked", !userText.includes("secret_ledger"), userText);

  // model text part masked (proves assistant history is walked)
  const modelText = o.contents?.[1]?.parts?.[0]?.text ?? "";
  ok("model part secret masked", !modelText.includes(SECRET) && modelText.includes("WYLOC_MOCK_"), modelText);

  // functionCall ENVELOPE byte-intact
  const fc = o.contents?.[2]?.parts?.[0]?.functionCall ?? {};
  ok("functionCall.name intact", fc.name === "read_file");
  ok("functionCall.args byte-intact", JSON.stringify(fc.args) === JSON.stringify({ path: "/etc/app/.env" }));

  // functionResponse gets full file-read treatment (code + secret); envelope intact
  const fr = o.contents?.[3]?.parts?.[0]?.functionResponse ?? {};
  ok("functionResponse.name (envelope) intact", fr.name === "read_file");
  const frOut = fr.response?.output ?? "";
  ok("functionResponse: secret swapped", typeof frOut === "string" && !frOut.includes(SECRET) && frOut.includes("WYLOC_MOCK_"), frOut);
  ok("functionResponse: code identifier masked (file-read code-mask)", typeof frOut === "string" && !/\bLedgerStore\b/.test(frOut), frOut);

  // inlineData (binary) byte-intact
  const inl = o.contents?.[4]?.parts?.[0]?.inlineData ?? {};
  ok("inlineData byte-intact", inl.mimeType === "image/png" && inl.data === "iVBORw0KGgoAAAANSU");

  // functionDeclarations byte-intact
  const fd = o.tools?.[0]?.functionDeclarations?.[0] ?? {};
  ok("functionDeclarations byte-intact", fd.name === "read_file" && fd.description === "Reads a file from disk");

  // ── round-trip: streamed response rehydrates back to the real secret ──
  ok("response stream rehydrated to real secret", respBody.includes(SECRET), respBody.slice(0, 200));
  ok("no mock token survives in the response", !respBody.includes("WYLOC_MOCK_"));

  gw.kill("SIGTERM"); up.close();
  console.error(`\n${fail === 0 ? "✓" : "✗"} ${pass} passed, ${fail} failed`);
  if (fails.length) { console.error(fails.join("\n")); process.exit(1); }
  console.error("✓ Gemini request-masking test PASSED");
}
main().catch((e) => { console.error("test error", e); process.exit(1); });
