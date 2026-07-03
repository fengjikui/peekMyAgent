import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

// Smoke for translation fault tolerance. A mock OpenAI-compatible provider
// returns a PARTIAL set of marker blocks (drops one) to prove a single
// missed/empty block no longer sinks the whole batch, and a GARBAGE response to
// prove a total failure is still reported (exit 1) without crashing.

const cwd = process.cwd();
const H1 = "a1".repeat(32);
const H2 = "b2".repeat(32);
const H3 = "c3".repeat(32);

function mockServer(scenario) {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const prompt = body.messages[0].content;
      const hashes = [...prompt.matchAll(/@@PEEK_SOURCE ([a-f0-9]{64})/g)].map((m) => m[1]);
      let content;
      if (scenario === "partial") {
        // translate all but the last block -> one missing block per batch
        content = hashes.slice(0, -1).map((h) => `@@PEEK_TRANSLATION ${h}\n译文-${h.slice(0, 6)}\n@@PEEK_END_TRANSLATION`).join("\n\n");
      } else if (scenario === "empty") {
        // return a block for every hash but leave one empty
        content = hashes.map((h, i) => `@@PEEK_TRANSLATION ${h}\n${i === hashes.length - 1 ? "" : `译文-${h.slice(0, 6)}`}\n@@PEEK_END_TRANSLATION`).join("\n\n");
      } else {
        content = "this response has no marker blocks at all";
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  });
  return server;
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`)));
}

function runTranslate(baseUrl, { materialsPath, cachePath, retries }) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["scripts/translate-materials-zh.mjs", "--materials", materialsPath, "--cache", cachePath, "--agent", "Mock", "--retries", String(retries)],
      {
        cwd,
        env: {
          ...process.env,
          PEEKMYAGENT_TRANSLATION_PROTOCOL: "openai",
          PEEKMYAGENT_TRANSLATION_BASE_URL: baseUrl,
          PEEKMYAGENT_TRANSLATION_API_KEY: "mock-key",
          PEEKMYAGENT_TRANSLATION_MODEL: "mock-model",
        },
      },
    );
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("translate timed out"));
    }, 20_000);
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function writeMaterials(dir) {
  const materialsPath = path.join(dir, "materials.jsonl");
  const mk = (hash, text) => ({ hash, id: hash, kind: "system_block", source_language: "en", source_text: text, metadata: {} });
  const lines = [mk(H1, "Block one."), mk(H2, "Block two."), mk(H3, "Block three.")].map((m) => JSON.stringify(m));
  fs.writeFileSync(materialsPath, `${lines.join("\n")}\n`);
  return materialsPath;
}

let failed = false;
try {
  // --- Scenario 1: partial (one block missing) -> tolerate, exit 0 ---
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "translate-partial-"));
    const materialsPath = writeMaterials(dir);
    const cachePath = path.join(dir, "zh-CN.json");
    const server = mockServer("partial");
    const baseUrl = await listen(server);
    const result = await runTranslate(baseUrl, { materialsPath, cachePath, retries: 1 });
    server.close();

    assert.equal(result.code, 0, `partial scenario should exit 0\n${result.stderr}`);
    assert.match(result.stderr, /partial batch/, "logged the partial-batch downgrade");
    const out = JSON.parse(result.stdout);
    assert.equal(out.translated, 2, "two of three blocks cached");
    assert.equal(out.remaining, 1, "one block left untranslated");
    const cache = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    assert.ok(cache.entries[H1] && cache.entries[H2], "good blocks cached");
    assert.ok(!cache.entries[H3], "missing block not cached (falls back to source)");
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // --- Scenario 2: one empty block -> tolerate, others cached ---
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "translate-empty-"));
    const materialsPath = writeMaterials(dir);
    const cachePath = path.join(dir, "zh-CN.json");
    const server = mockServer("empty");
    const baseUrl = await listen(server);
    const result = await runTranslate(baseUrl, { materialsPath, cachePath, retries: 1 });
    server.close();

    assert.equal(result.code, 0, `empty scenario should exit 0\n${result.stderr}`);
    const out = JSON.parse(result.stdout);
    assert.equal(out.translated, 2, "empty block skipped, other two cached");
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // --- Scenario 3: garbage (no markers) -> total failure exits 1 ---
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "translate-garbage-"));
    const materialsPath = writeMaterials(dir);
    const cachePath = path.join(dir, "zh-CN.json");
    const server = mockServer("garbage");
    const baseUrl = await listen(server);
    const result = await runTranslate(baseUrl, { materialsPath, cachePath, retries: 0 });
    server.close();

    assert.equal(result.code, 1, "total failure exits 1");
    const out = JSON.parse(result.stdout);
    assert.equal(out.translated, 0, "nothing translated");
    assert.ok(out.failed_jobs >= 1, "failure reported");
    const cache = fs.existsSync(cachePath) ? JSON.parse(fs.readFileSync(cachePath, "utf8")) : { entries: {} };
    assert.equal(Object.keys(cache.entries || {}).length, 0, "no partial garbage cached");
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log("translation-tolerance smoke: OK (partial+empty tolerated & exit 0, garbage fails clean exit 1)");
} catch (error) {
  failed = true;
  console.error("translation-tolerance smoke FAILED:", error.message);
}
process.exitCode = failed ? 1 : 0;
