/**
 * Cross-category CONTRADICT integration test
 *
 * Verifies the event→entity CONTRADICT exception works correctly
 * through the full smart-extractor pipeline (mock LLM + embedding).
 *
 * Three scenarios:
 * 1. event → entity CONTRADICT (core fix)
 * 2. event confirms entity value → CREATE (not CONTRADICT)
 * 3. cases → cases CREATE (cases cannot CONTRADICT)
 */
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import Module from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

import jitiFactory from "jiti";

process.env.NODE_PATH = [
  process.env.NODE_PATH,
  "/opt/homebrew/lib/node_modules/openclaw/node_modules",
  "/opt/homebrew/lib/node_modules",
].filter(Boolean).join(":");
Module._initPaths();

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const plugin = jiti("../index.ts");
const { MemoryStore } = jiti("../src/store.ts");
const { createEmbedder } = jiti("../src/embedder.ts");
const { buildSmartMetadata, stringifySmartMetadata, parseSmartMetadata, parseSupportInfo } = jiti("../src/smart-metadata.ts");
const { NoisePrototypeBank } = jiti("../src/noise-prototypes.ts");

const EMBEDDING_DIMENSIONS = 2560;

// Disable noise bank for deterministic testing
NoisePrototypeBank.prototype.isNoise = () => false;

function createDeterministicEmbedding(text, dimensions = EMBEDDING_DIMENSIONS) {
  void text;
  const value = 1 / Math.sqrt(dimensions);
  return new Array(dimensions).fill(value);
}

function createEmbeddingServer() {
  return http.createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/v1/embeddings") {
      res.writeHead(404);
      res.end();
      return;
    }

    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const inputs = Array.isArray(payload.input) ? payload.input : [payload.input];

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      object: "list",
      data: inputs.map((input, index) => ({
        object: "embedding",
        index,
        embedding: createDeterministicEmbedding(String(input)),
      })),
      model: payload.model || "mock-embedding-model",
      usage: { prompt_tokens: 0, total_tokens: 0 },
    }));
  });
}

function createMockApi(dbPath, embeddingBaseURL, llmBaseURL, logs) {
  return {
    pluginConfig: {
      dbPath,
      autoCapture: true,
      autoRecall: false,
      smartExtraction: true,
      extractMinMessages: 2,
      embedding: {
        apiKey: "dummy",
        model: "mock-embedding",
        baseURL: embeddingBaseURL,
        dimensions: EMBEDDING_DIMENSIONS,
      },
      llm: {
        apiKey: "dummy",
        model: "mock-memory-model",
        baseURL: llmBaseURL,
      },
      retrieval: {
        mode: "hybrid",
        minScore: 0.6,
        hardMinScore: 0.62,
        candidatePoolSize: 12,
        rerank: "cross-encoder",
        rerankProvider: "jina",
        rerankEndpoint: "http://127.0.0.1:8202/v1/rerank",
        rerankModel: "qwen3-reranker-4b",
      },
      scopes: {
        default: "global",
        definitions: {
          global: { description: "shared" },
          "agent:test": { description: "test agent" },
        },
        agentAccess: {
          test: ["global", "agent:test"],
        },
      },
    },
    hooks: {},
    toolFactories: {},
    services: [],
    logger: {
      info(...args) { logs.push(["info", args.join(" ")]); },
      warn(...args) { logs.push(["warn", args.join(" ")]); },
      error(...args) { logs.push(["error", args.join(" ")]); },
      debug(...args) { logs.push(["debug", args.join(" ")]); },
    },
    resolvePath(value) { return value; },
    registerTool(toolOrFactory, meta) {
      this.toolFactories[meta.name] =
        typeof toolOrFactory === "function" ? toolOrFactory : () => toolOrFactory;
    },
    registerCli() {},
    registerService(service) { this.services.push(service); },
    on(name, handler) { this.hooks[name] = handler; },
    registerHook(name, handler) { this.hooks[name] = handler; },
  };
}

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

async function seedEntity(dbPath, text, abstract, overview, content) {
  const store = new MemoryStore({ dbPath, vectorDim: EMBEDDING_DIMENSIONS });
  const embedder = createEmbedder({
    provider: "openai-compatible",
    apiKey: "dummy",
    model: "mock-embedding",
    baseURL: process.env.TEST_EMBEDDING_BASE_URL,
    dimensions: EMBEDDING_DIMENSIONS,
  });

  const vector = await embedder.embedPassage(text);
  await store.store({
    text,
    vector,
    category: "entity",
    scope: "global",
    importance: 0.8,
    metadata: stringifySmartMetadata(
      buildSmartMetadata(
        { text, category: "entity", importance: 0.8 },
        {
          l0_abstract: abstract,
          l1_overview: overview,
          l2_content: content,
          memory_category: "entities",
          tier: "working",
          confidence: 0.8,
        },
      ),
    ),
  });
}

async function seedCase(dbPath, text, abstract, overview, content) {
  const store = new MemoryStore({ dbPath, vectorDim: EMBEDDING_DIMENSIONS });
  const embedder = createEmbedder({
    provider: "openai-compatible",
    apiKey: "dummy",
    model: "mock-embedding",
    baseURL: process.env.TEST_EMBEDDING_BASE_URL,
    dimensions: EMBEDDING_DIMENSIONS,
  });

  const vector = await embedder.embedPassage(text);
  // "cases" maps to store category "fact" via mapToStoreCategory
  await store.store({
    text,
    vector,
    category: "fact",
    scope: "global",
    importance: 0.8,
    metadata: stringifySmartMetadata(
      buildSmartMetadata(
        { text, category: "fact", importance: 0.8 },
        {
          l0_abstract: abstract,
          l1_overview: overview,
          l2_content: content,
          memory_category: "cases",
          tier: "working",
          confidence: 0.8,
        },
      ),
    ),
  });
}

// ---------------------------------------------------------------------------
// Scenario runner
// ---------------------------------------------------------------------------

/**
 * @param {object} opts
 * @param {'contradict'|'create'|'case-create'} opts.mode
 * @param {string} opts.seedFn - seed function name
 * @param {object} opts.seedArgs
 * @param {object} opts.extractionResponse
 * @param {object} opts.dedupResponse
 * @param {string[]} opts.messages
 * @param {(result: object) => void} opts.assertFn
 */
async function runScenario(opts) {
  const workDir = mkdtempSync(path.join(tmpdir(), `memory-crosscat-${opts.mode}-`));
  const dbPath = path.join(workDir, "db");
  const logs = [];
  let llmCalls = 0;

  const embeddingServer = createEmbeddingServer();

  const server = http.createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/chat/completions") {
      res.writeHead(404);
      res.end();
      return;
    }

    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const prompt = payload.messages?.[1]?.content || "";
    llmCalls += 1;

    let content;
    if (prompt.includes("Analyze the following session context")) {
      content = JSON.stringify(opts.extractionResponse);
    } else if (prompt.includes("Determine how to handle this candidate memory")) {
      content = JSON.stringify(opts.dedupResponse);
    } else if (prompt.includes("Merge the following memory into a single coherent record")) {
      content = JSON.stringify({
        abstract: "merged",
        overview: "## merged",
        content: "merged content",
      });
    } else {
      content = JSON.stringify({ memories: [] });
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      id: "chatcmpl-test",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: "mock-memory-model",
      choices: [{
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      }],
    }));
  });

  await new Promise((resolve) => embeddingServer.listen(0, "127.0.0.1", resolve));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const embeddingPort = embeddingServer.address().port;
  const port = server.address().port;
  process.env.TEST_EMBEDDING_BASE_URL = `http://127.0.0.1:${embeddingPort}/v1`;

  try {
    const api = createMockApi(
      dbPath,
      `http://127.0.0.1:${embeddingPort}/v1`,
      `http://127.0.0.1:${port}`,
      logs,
    );
    plugin.register(api);

    // Seed existing memory
    await opts.seedFn(dbPath, ...opts.seedArgs);

    // Trigger smart extraction
    await api.hooks.agent_end(
      {
        success: true,
        sessionKey: "agent:test:crosscat",
        messages: opts.messages,
      },
      { agentId: "test", sessionKey: "agent:test:crosscat" },
    );

    // Read final store state
    const freshStore = new MemoryStore({ dbPath, vectorDim: EMBEDDING_DIMENSIONS });
    const entries = await freshStore.list(["global", "agent:test"], undefined, 10, 0);

    const result = { entries, llmCalls, logs };
    opts.assertFn(result);
  } finally {
    delete process.env.TEST_EMBEDDING_BASE_URL;
    await new Promise((resolve) => embeddingServer.close(resolve));
    await new Promise((resolve) => server.close(resolve));
    rmSync(workDir, { recursive: true, force: true });
  }
}

// ===========================================================================
// Test 1: event → entity CONTRADICT (core fix)
// ===========================================================================
console.log("\n=== Test 1: event → entity CONTRADICT ===");

await runScenario({
  mode: "contradict",
  seedFn: seedEntity,
  seedArgs: [
    "OpenClaw gateway 端口 18789",
    "OpenClaw 基础设施: gateway 端口 18789",
    "## 基础设施\n- Gateway: 端口 18789",
    "OpenClaw gateway 运行在端口 18789。",
  ],
  extractionResponse: {
    memories: [{
      category: "events",
      abstract: "gateway 端口从 18789 改为 19000",
      overview: "## 事件\n- 变更: 端口 18789 → 19000",
      content: "将 gateway 端口从 18789 迁移到 19000。",
    }],
  },
  dedupResponse: {
    decision: "contradict",
    match_index: 1,
    reason: "Event directly invalidates entity fact: gateway port changed from 18789 to 19000",
  },
  messages: [
    { role: "user", content: "我把 gateway 端口改了。" },
    { role: "user", content: "从 18789 改成了 19000。" },
    { role: "user", content: "请记住这个变更。" },
  ],
  assertFn(result) {
    // Should have 2 entries: original entity + new contradicting event
    assert.equal(result.entries.length, 2, `Expected 2 entries, got ${result.entries.length}`);

    // Verify log shows contradict
    const hasContradictLog = result.logs.some(
      (entry) => entry[1].includes("contradict"),
    );
    assert.ok(hasContradictLog, "Expected contradict log entry");

    // Verify the new entry has contradicts relation
    const newEntry = result.entries.find(
      (e) => e.text.includes("19000"),
    );
    assert.ok(newEntry, "Expected new entry with port 19000");

    const meta = parseSmartMetadata(newEntry.metadata, newEntry);
    assert.ok(
      meta.relations?.some((r) => r.type === "contradicts"),
      "New entry should have contradicts relation",
    );

    // Verify the old entry has contradict in support_info
    const oldEntry = result.entries.find(
      (e) => e.text.includes("18789") && !e.text.includes("19000"),
    );
    assert.ok(oldEntry, "Expected old entry with port 18789");

    const oldMeta = parseSmartMetadata(oldEntry.metadata, oldEntry);
    const supportInfo = parseSupportInfo(oldMeta.support_info);
    const hasContradictStat = supportInfo.slices?.some(
      (s) => s.contradictions > 0,
    );
    assert.ok(hasContradictStat, "Old entry should have contradict in support_info");

    // Verify correct LLM call count (extraction + dedup = 2)
    assert.equal(result.llmCalls, 2, `Expected 2 LLM calls, got ${result.llmCalls}`);

    console.log("  ✅ CONTRADICT pipeline works correctly");
    console.log(`     - ${result.entries.length} entries in store`);
    console.log(`     - New entry has contradicts relation`);
    console.log(`     - Old entry has contradict in support_info`);
  },
});

// ===========================================================================
// Test 2: event confirms entity value → CREATE (not CONTRADICT)
// ===========================================================================
console.log("\n=== Test 2: event confirms entity → CREATE ===");

await runScenario({
  mode: "create",
  seedFn: seedEntity,
  seedArgs: [
    "Matrix groupPolicy: allowlist",
    "Matrix 服务配置: groupPolicy allowlist",
    "## Matrix\n- groupPolicy: allowlist",
    "Matrix 当前 groupPolicy 为 allowlist。",
  ],
  extractionResponse: {
    memories: [{
      category: "events",
      abstract: "确认 Matrix groupPolicy 仍为 allowlist",
      overview: "## 事件\n- 操作: 检查 groupPolicy\n- 结果: 确认仍为 allowlist",
      content: "检查了 Matrix groupPolicy 配置，确认仍为 allowlist。",
    }],
  },
  dedupResponse: {
    decision: "create",
    reason: "Event confirms existing state, no contradiction — record as new event",
  },
  messages: [
    { role: "user", content: "我检查了 Matrix groupPolicy。" },
    { role: "user", content: "还是 allowlist，没变。" },
    { role: "user", content: "记一下。" },
  ],
  assertFn(result) {
    // Should have 2 entries: original entity + new event
    assert.equal(result.entries.length, 2, `Expected 2 entries, got ${result.entries.length}`);

    // Verify log shows created, NOT contradict
    const hasCreateLog = result.logs.some(
      (entry) => entry[1].includes("smart-extracted") && entry[1].includes("created"),
    );
    assert.ok(hasCreateLog, "Expected created log entry");

    const hasContradictLog = result.logs.some(
      (entry) => entry[1].includes("contradict"),
    );
    assert.ok(!hasContradictLog, "Should NOT have contradict log entry");

    // Old entry should NOT have contradict in support_info
    const oldEntry = result.entries.find(
      (e) => e.text.includes("groupPolicy") && !e.text.includes("确认"),
    );
    assert.ok(oldEntry, "Expected original entity entry");

    const oldMeta = parseSmartMetadata(oldEntry.metadata, oldEntry);
    if (oldMeta.support_info) {
      const supportInfo = parseSupportInfo(oldMeta.support_info);
      const hasContradictStat = supportInfo.slices?.some(
        (s) => s.contradictions > 0,
      );
      assert.ok(!hasContradictStat, "Old entry should NOT have contradict in support_info");
    }

    console.log("  ✅ CREATE pipeline works correctly (no false CONTRADICT)");
    console.log(`     - ${result.entries.length} entries in store`);
    console.log(`     - Old entity untouched`);
  },
});

// ===========================================================================
// Test 3: cases → cases CREATE (cases cannot CONTRADICT)
// ===========================================================================
console.log("\n=== Test 3: cases → cases CREATE ===");

await runScenario({
  mode: "case-create",
  seedFn: seedCase,
  seedArgs: [
    "LanceDB BigInt error → Number() coercion",
    "LanceDB BigInt error → Use Number() coercion before arithmetic",
    "## Problem\nLanceDB returns BigInt\n\n## Solution\nNumber() coercion",
    "LanceDB BigInt 运算报错，用 Number() 包裹。",
  ],
  extractionResponse: {
    memories: [{
      category: "cases",
      abstract: "LanceDB BigInt error → toString() + parseFloat()",
      overview: "## Problem\nBigInt precision loss with Number()\n\n## Solution\ntoString() + parseFloat()",
      content: "Number() 对超大 BigInt 会丢精度，改用 toString() + parseFloat()。",
    }],
  },
  dedupResponse: {
    decision: "create",
    reason: "Cases are independent records — different solution to related problem",
  },
  messages: [
    { role: "user", content: "我发现 Number() 转大数会丢精度。" },
    { role: "user", content: "改用 toString() 再 parseFloat() 解决了。" },
    { role: "user", content: "记一下这个方案。" },
  ],
  assertFn(result) {
    // Should have 2 entries: original case + new case
    assert.equal(result.entries.length, 2, `Expected 2 entries, got ${result.entries.length}`);

    // Verify no contradict log
    const hasContradictLog = result.logs.some(
      (entry) => entry[1].includes("contradict"),
    );
    assert.ok(!hasContradictLog, "Cases should NOT trigger CONTRADICT");

    // Both entries should exist (seed stored as "fact", new created as "fact")
    assert.equal(result.entries.length, 2, `Expected 2 entries, got ${result.entries.length}`);

    console.log("  ✅ Cases correctly use CREATE (no CONTRADICT)");
    console.log(`     - ${result.entries.length} entries in store`);
  },
});

// ===========================================================================
console.log("\n════════════════════════════════════════");
console.log("All cross-category CONTRADICT tests passed ✅");
