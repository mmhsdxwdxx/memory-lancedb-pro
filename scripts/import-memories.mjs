#!/usr/bin/env node
import fs from 'fs';
import { MemoryStore } from '../src/store.js';
import { Embedder } from '../src/embedder.js';

const JSONL_FILE = process.argv[2] || '/tmp/memory-import.jsonl';
const DATA_DIR = process.argv[3] || '../data';

if (!fs.existsSync(JSONL_FILE)) {
  console.error(`File not found: ${JSONL_FILE}`);
  process.exit(1);
}

const lines = fs.readFileSync(JSONL_FILE, 'utf8').split('\n').filter(Boolean);
const memories = lines.map(line => JSON.parse(line));

console.log(`Loading ${memories.length} memories...`);

const embedder = new Embedder();
const store = new MemoryStore({ dataDir: DATA_DIR });

await store.init();

let imported = 0;
for (const mem of memories) {
  const vector = await embedder.embedQuery(mem.text);
  await store.add({
    text: mem.text,
    category: mem.category,
    scope: mem.scope,
    importance: mem.importance,
    metadata: mem.metadata,
    vector
  });
  imported++;
  if (imported % 10 === 0) {
    console.log(`Imported ${imported}/${memories.length}...`);
  }
}

console.log(`✓ Imported ${imported} memories to ${DATA_DIR}`);
