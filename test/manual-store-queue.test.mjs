import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Module from "node:module";
import jitiFactory from "jiti";

process.env.NODE_PATH = [
  process.env.NODE_PATH,
  "/opt/homebrew/lib/node_modules/openclaw/node_modules",
  "/opt/homebrew/lib/node_modules",
].filter(Boolean).join(":");
Module._initPaths();

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { ManualMemoryStoreQueue } = jiti("../src/manual-store-queue.ts");

const workDir = mkdtempSync(path.join(tmpdir(), "memory-store-queue-"));
const queueFile = path.join(workDir, "queue.json");
const deadLetterFile = path.join(workDir, "dead-letter.jsonl");
const processed = [];

const queue = new ManualMemoryStoreQueue({
  queueFile,
  deadLetterFile,
  maxAttempts: 3,
  process: async (job) => {
    processed.push(job);
  },
});

try {
  await queue.start();
  const receipt = await queue.enqueue({
    text: "remember this",
    importance: 0.9,
    category: "fact",
    scope: "agent:main",
    agentId: "main",
  });

  assert.equal(typeof receipt.id, "string");
  assert.equal(typeof receipt.position, "number");
  assert.ok(receipt.position >= 0);

  const deadline = Date.now() + 1_000;
  while (processed.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  assert.equal(processed.length, 1, "queued job should be processed in background");

  const persisted = JSON.parse(readFileSync(queueFile, "utf8"));
  assert.deepEqual(persisted.jobs, [], "queue file should be empty after success");
} finally {
  await queue.stop();
  rmSync(workDir, { recursive: true, force: true });
}

console.log("OK: manual store queue background processing works");
