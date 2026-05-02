// apps/worker/index.test.ts
//
// TDD test: the worker must call pgque.ticker(queue_name) once per poll cycle,
// BEFORE calling pgque.next_batch.  Without the ticker the pgque.tick table
// never advances and next_batch always returns NULL.
//
// This is a unit test — no real Postgres required.  We exercise the exported
// `processBatch` function by injecting a mock DB client.

import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { Client } from "pg";

// Re-import after we wire up the injectable db — we test the exported helper
// directly rather than the full main() to avoid port/connect side-effects.
import { processBatch } from "./src/index";

// ---------------------------------------------------------------------------
// Mock DB client factory
// ---------------------------------------------------------------------------

/**
 * Build a minimal mock pg.Client that records every query() call.
 * next_batch returns NULL (empty queue) — enough to prove ticker was called.
 */
function makeDbMock(): { db: Client; calls: Array<{ text: string; values: unknown[] }> } {
  const calls: Array<{ text: string; values: unknown[] }> = [];

  const db = {
    query: mock(async (text: string, values?: unknown[]) => {
      calls.push({ text, values: values ?? [] });

      // pgque.ticker — return a tick id (or NULL if no new events; both are fine)
      if (text.includes("pgque.ticker")) {
        return { rows: [{ ticker: 1n }], rowCount: 1 };
      }
      // pgque.next_batch — return NULL (empty queue)
      if (text.includes("pgque.next_batch")) {
        return { rows: [{ next_batch: null }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }),
  } as unknown as Client;

  return { db, calls };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("processBatch — self-tick requirement", () => {
  it("calls pgque.ticker before pgque.next_batch on each poll cycle", async () => {
    const { db, calls } = makeDbMock();

    await processBatch(db);

    // ticker must have been called
    const tickerCall = calls.find((c) => c.text.includes("pgque.ticker"));
    expect(tickerCall).toBeDefined();

    // next_batch must have been called
    const nextBatchCall = calls.find((c) => c.text.includes("pgque.next_batch"));
    expect(nextBatchCall).toBeDefined();

    // ticker must come BEFORE next_batch in call order
    const tickerIdx = calls.indexOf(tickerCall!);
    const nextBatchIdx = calls.indexOf(nextBatchCall!);
    expect(tickerIdx).toBeLessThan(nextBatchIdx);
  });

  it("calls pgque.ticker exactly once per processBatch invocation", async () => {
    const { db, calls } = makeDbMock();

    await processBatch(db);

    const tickerCalls = calls.filter((c) => c.text.includes("pgque.ticker"));
    expect(tickerCalls).toHaveLength(1);
  });

  it("passes QUEUE_NAME to pgque.ticker", async () => {
    const { db, calls } = makeDbMock();

    await processBatch(db);

    const tickerCall = calls.find((c) => c.text.includes("pgque.ticker"));
    // The queue name must appear in either the SQL text or the bound params
    const hasQueueName =
      tickerCall?.text.includes("google_push") ||
      tickerCall?.values.includes("google_push");
    expect(hasQueueName).toBe(true);
  });
});
