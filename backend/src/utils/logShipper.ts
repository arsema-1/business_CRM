import { hostname } from "os";
import { loggingConfig } from "../config/logging";

// ── Central log shipping (task 2.4) ──────────────────────────────────────────
// Every structured record the logger emits is also queued for the central
// collector (SIEM). The queue is deliberately tiny and bounded:
//   * a request never waits for the network — shipping is fire-and-forget;
//   * records are batched and flushed on a timer or when the batch is full;
//   * on failure the batch is put back and retried with backoff, and if the
//     collector stays unreachable the oldest records are dropped so a downed
//     SIEM can never exhaust memory or stall the API.
//
// This module intentionally does NOT import the logger: logging a shipping
// failure through the same path would recurse. Counters are exposed for the
// admin monitoring dashboard instead.

interface LogRecord {
  ts: string;
  level: string;
  event: string;
  [key: string]: unknown;
}

const cfg = loggingConfig.siem;

export interface LogShippingStatus {
  enabled: boolean;
  endpointHost: string | null;
  source: string;
  queued: number;
  shipped: number;
  failedBatches: number;
  dropped: number;
  retryDelayMs: number;
  lastShippedAt: string | null;
  lastError: string | null;
}

const stats = {
  shipped: 0,
  failedBatches: 0,
  dropped: 0,
  retryDelayMs: 0,
  lastShippedAt: null as string | null,
  lastError: null as string | null,
};

const queue: LogRecord[] = [];
let flushing = false;
let timer: NodeJS.Timeout | null = null;

function endpointHost(): string | null {
  if (!cfg.url) return null;
  try {
    return new URL(cfg.url).host;
  } catch {
    return "invalid-url";
  }
}

function schedule(delayMs?: number) {
  if (timer || !cfg.url || queue.length === 0) return;
  const delay = delayMs ?? cfg.flushSeconds * 1000;
  timer = setTimeout(() => {
    timer = null;
    void flush();
  }, delay);
  // A pending flush must not keep the process (or a test run) alive.
  timer.unref?.();
}

async function postBatch(batch: LogRecord[]): Promise<void> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cfg.authHeader) headers.Authorization = cfg.authHeader;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), cfg.timeoutMs);
  try {
    const res = await fetch(cfg.url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        source: cfg.source,
        environment: process.env.NODE_ENV ?? "development",
        host: hostname(),
        sentAt: new Date().toISOString(),
        events: batch,
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`collector responded ${res.status}`);
  } finally {
    clearTimeout(timeout);
  }
}

async function flush(): Promise<void> {
  if (flushing || !cfg.url || queue.length === 0) return;
  flushing = true;

  const batch = queue.splice(0, cfg.batchSize);
  try {
    await postBatch(batch);
    stats.shipped += batch.length;
    stats.lastShippedAt = new Date().toISOString();
    stats.lastError = null;
    stats.retryDelayMs = 0;
  } catch (err) {
    stats.failedBatches += 1;
    stats.lastError = (err as Error)?.message?.slice(0, 200) ?? "unknown error";

    // Put the batch back at the front, keeping only what still fits. Records
    // beyond the buffer are the oldest ones and are counted as dropped.
    const room = Math.max(cfg.maxBuffer - queue.length, 0);
    const keep = batch.slice(Math.max(batch.length - room, 0));
    stats.dropped += batch.length - keep.length;
    queue.unshift(...keep);

    // Exponential backoff, capped at 30s, so a long outage does not spin.
    stats.retryDelayMs = Math.min(Math.max(stats.retryDelayMs * 2, 1000), 30000);
  } finally {
    flushing = false;
    if (queue.length > 0) schedule(stats.retryDelayMs || undefined);
  }
}

/** Queue one structured log record for the central collector. Never throws. */
export function shipLog(record: LogRecord): void {
  if (!cfg.url) return;
  try {
    if (queue.length >= cfg.maxBuffer) {
      queue.shift();
      stats.dropped += 1;
    }
    queue.push(record);
    if (queue.length >= cfg.batchSize) {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      void flush();
    } else {
      schedule();
    }
  } catch {
    // Shipping must never affect the caller.
  }
}

/**
 * Drain the queue before shutdown. Resolves after the queue is empty or the
 * deadline passes; returns how many records are still unsent.
 */
export async function flushLogShipment(timeoutMs = 2000): Promise<number> {
  if (!cfg.url || queue.length === 0) return queue.length;
  const deadline = Date.now() + timeoutMs;
  while (queue.length > 0 && Date.now() < deadline) {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    await flush();
    if (queue.length > 0) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return queue.length;
}

export function getLogShippingStatus(): LogShippingStatus {
  return {
    enabled: Boolean(cfg.url),
    endpointHost: endpointHost(),
    source: cfg.source,
    queued: queue.length,
    shipped: stats.shipped,
    failedBatches: stats.failedBatches,
    dropped: stats.dropped,
    retryDelayMs: stats.retryDelayMs,
    lastShippedAt: stats.lastShippedAt,
    lastError: stats.lastError,
  };
}
