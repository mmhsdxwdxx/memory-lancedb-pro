import assert from "node:assert/strict";
import Module from "node:module";
import jitiFactory from "jiti";

process.env.NODE_PATH = [
  process.env.NODE_PATH,
  "/opt/homebrew/lib/node_modules/openclaw/node_modules",
  "/opt/homebrew/lib/node_modules",
].filter(Boolean).join(":");
Module._initPaths();

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { registerMemoryStoreTool } = jiti("../src/tools.ts");

const toolFactories = {};
const api = {
  registerTool(factory, meta) {
    toolFactories[meta.name] = factory;
  },
};

let enqueueCalled = 0;
let embedCalled = 0;

registerMemoryStoreTool(api, {
  retriever: {},
  store: {},
  scopeManager: {
    getDefaultScope() {
      return "agent:main";
    },
    isAccessible() {
      return true;
    },
  },
  embedder: {
    async embedPassage() {
      embedCalled += 1;
      return [0.1, 0.2];
    },
  },
  manualStoreQueue: {
    isActive() {
      return true;
    },
    async enqueue() {
      enqueueCalled += 1;
      return {
        id: "queued-job-1",
        queuedAt: Date.now(),
        position: 1,
      };
    },
  },
});

const tool = toolFactories.memory_store({
  agentId: "main",
});

const result = await tool.execute("tool-1", {
  text: "remember the async queue",
  category: "fact",
});

assert.equal(enqueueCalled, 1, "memory_store should enqueue when queue is active");
assert.equal(embedCalled, 0, "memory_store should not block on embeddings when queue is active");
assert.equal(result.details.action, "queued");
assert.equal(result.details.scope, "agent:main");

console.log("OK: memory_store fast-returns when background queue is active");
