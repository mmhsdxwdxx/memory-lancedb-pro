import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { formatErrorMessage } from "./runtime-resilience.js";

export interface ManualMemoryStorePayload {
  text: string;
  importance: number;
  category: string;
  scope: string;
  agentId?: string;
}

export interface ManualMemoryStoreJob extends ManualMemoryStorePayload {
  id: string;
  queuedAt: number;
  updatedAt: number;
  attempts: number;
  nextAttemptAt: number;
  lastError?: string;
}

interface ManualMemoryStoreQueueState {
  version: 1;
  jobs: ManualMemoryStoreJob[];
}

type Logger = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
  debug?: (message: string) => void;
};

interface ManualMemoryStoreQueueOptions {
  queueFile: string;
  deadLetterFile: string;
  logger?: Logger;
  process: (job: ManualMemoryStoreJob) => Promise<void>;
  maxAttempts?: number;
  maxJobs?: number;
  baseRetryMs?: number;
  maxRetryMs?: number;
}

const DEFAULT_MAX_ATTEMPTS = 6;
const DEFAULT_MAX_JOBS = 256;
const DEFAULT_BASE_RETRY_MS = 15_000;
const DEFAULT_MAX_RETRY_MS = 10 * 60_000;

function createInitialState(): ManualMemoryStoreQueueState {
  return { version: 1, jobs: [] };
}

export class ManualMemoryStoreQueue {
  private readonly queueFile: string;
  private readonly deadLetterFile: string;
  private readonly logger?: Logger;
  private readonly processJob: (job: ManualMemoryStoreJob) => Promise<void>;
  private readonly maxAttempts: number;
  private readonly maxJobs: number;
  private readonly baseRetryMs: number;
  private readonly maxRetryMs: number;

  private loaded = false;
  private started = false;
  private processing = false;
  private processingPromise: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private state: ManualMemoryStoreQueueState = createInitialState();

  constructor(options: ManualMemoryStoreQueueOptions) {
    this.queueFile = options.queueFile;
    this.deadLetterFile = options.deadLetterFile;
    this.logger = options.logger;
    this.processJob = options.process;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.maxJobs = options.maxJobs ?? DEFAULT_MAX_JOBS;
    this.baseRetryMs = options.baseRetryMs ?? DEFAULT_BASE_RETRY_MS;
    this.maxRetryMs = options.maxRetryMs ?? DEFAULT_MAX_RETRY_MS;
  }

  isActive(): boolean {
    return this.started;
  }

  async start(): Promise<void> {
    if (this.started) return;
    await this.ensureLoaded();
    this.started = true;
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.started = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.processingPromise?.catch(() => void 0);
    this.processingPromise = null;
  }

  async enqueue(payload: ManualMemoryStorePayload): Promise<{ id: string; queuedAt: number; position: number }> {
    await this.ensureLoaded();
    if (this.state.jobs.length >= this.maxJobs) {
      throw new Error(
        `manual memory store queue is full (${this.state.jobs.length}/${this.maxJobs})`,
      );
    }

    const now = Date.now();
    const job: ManualMemoryStoreJob = {
      ...payload,
      id: randomUUID(),
      queuedAt: now,
      updatedAt: now,
      attempts: 0,
      nextAttemptAt: now,
    };

    this.state.jobs.push(job);
    await this.persistState();
    this.schedule(10);

    return {
      id: job.id,
      queuedAt: job.queuedAt,
      position: this.state.jobs.length,
    };
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    await mkdir(dirname(this.queueFile), { recursive: true });
    try {
      const raw = await readFile(this.queueFile, "utf8");
      const parsed = JSON.parse(raw) as Partial<ManualMemoryStoreQueueState>;
      const jobs = Array.isArray(parsed.jobs)
        ? parsed.jobs.filter((job): job is ManualMemoryStoreJob => {
            return Boolean(
              job &&
                typeof job === "object" &&
                typeof job.id === "string" &&
                typeof job.text === "string" &&
                typeof job.scope === "string" &&
                typeof job.category === "string" &&
                typeof job.importance === "number" &&
                typeof job.queuedAt === "number" &&
                typeof job.updatedAt === "number" &&
                typeof job.attempts === "number" &&
                typeof job.nextAttemptAt === "number",
            );
          })
        : [];
      this.state = {
        version: 1,
        jobs,
      };
    } catch (error) {
      const message = formatErrorMessage(error);
      if (!/ENOENT/.test(message)) {
        const backup = `${this.queueFile}.corrupt.${Date.now()}`;
        try {
          await rename(this.queueFile, backup);
          this.logger?.warn?.(
            `memory-lancedb-pro: renamed corrupt manual store queue to ${backup}`,
          );
        } catch {
          this.logger?.warn?.(
            `memory-lancedb-pro: failed to read manual store queue, starting clean: ${message}`,
          );
        }
      }
      this.state = createInitialState();
    }
    this.loaded = true;
  }

  private async persistState(): Promise<void> {
    const tmpFile = `${this.queueFile}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
    const content = `${JSON.stringify(this.state, null, 2)}\n`;
    await writeFile(tmpFile, content, "utf8");
    await rename(tmpFile, this.queueFile);
  }

  private schedule(delayMs: number): void {
    if (!this.started) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.drain();
    }, Math.max(0, delayMs));
    this.timer.unref?.();
  }

  private async drain(): Promise<void> {
    if (!this.started || this.processing) return;
    this.processing = true;
    const runner = this.runDrainLoop();
    this.processingPromise = runner;
    try {
      await runner;
    } finally {
      this.processing = false;
      this.processingPromise = null;
    }
  }

  private async runDrainLoop(): Promise<void> {
    await this.ensureLoaded();

    while (this.started) {
      const now = Date.now();
      const nextIndex = this.state.jobs.findIndex((job) => job.nextAttemptAt <= now);

      if (nextIndex === -1) {
        if (this.state.jobs.length === 0) return;
        const nextWakeAt = Math.min(...this.state.jobs.map((job) => job.nextAttemptAt));
        this.schedule(Math.max(250, nextWakeAt - now));
        return;
      }

      const job = this.state.jobs[nextIndex];
      try {
        await this.processJob(job);
        this.state.jobs.splice(nextIndex, 1);
        await this.persistState();
      } catch (error) {
        job.attempts += 1;
        job.updatedAt = Date.now();
        job.lastError = formatErrorMessage(error);

        if (job.attempts >= this.maxAttempts) {
          await this.appendDeadLetter(job);
          this.state.jobs.splice(nextIndex, 1);
          this.logger?.error?.(
            `memory-lancedb-pro: dropped queued memory_store job ${job.id} after ${job.attempts} attempts: ${job.lastError}`,
          );
        } else {
          const retryDelay = Math.min(
            this.maxRetryMs,
            this.baseRetryMs * 2 ** Math.max(0, job.attempts - 1),
          );
          job.nextAttemptAt = Date.now() + retryDelay;
          this.logger?.warn?.(
            `memory-lancedb-pro: queued memory_store job ${job.id} retry ${job.attempts}/${this.maxAttempts} in ${retryDelay}ms: ${job.lastError}`,
          );
        }

        await this.persistState();
      }
    }
  }

  private async appendDeadLetter(job: ManualMemoryStoreJob): Promise<void> {
    const record = {
      ...job,
      failedAt: Date.now(),
    };
    await mkdir(dirname(this.deadLetterFile), { recursive: true });
    await appendFile(this.deadLetterFile, `${JSON.stringify(record)}\n`, "utf8");
  }
}
