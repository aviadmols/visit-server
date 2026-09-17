/**
 * One JSON line per record, in the file and on stdout.
 *
 * The file is emptied as soon as it holds LOG_MAX_RECORDS lines, so the log answers "what
 * happened just now" and never grows without a rotation tool behind it. Writes are queued,
 * so two requests finishing together cannot interleave halfway through a line.
 */

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { config } from "./config.ts";

const file = config.log.file;
const limit = Math.max(1, config.log.maxRecords);

/** -1 until the first write has counted what is already on disk. */
let records = -1;
let queue: Promise<void> = Promise.resolve();

async function countExisting(): Promise<void> {
  if (records >= 0) return;

  try {
    const text = await readFile(file, "utf8");
    records = text.trim() ? text.trim().split("\n").length : 0;
  } catch {
    records = 0;
  }
}

async function write(line: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await countExisting();
  await appendFile(file, line + "\n", "utf8");
  records += 1;

  if (records >= limit) {
    await writeFile(file, "", "utf8");
    records = 0;
  }
}

/**
 * Records one event. Never throws: a log that cannot be written must not fail a quote.
 */
export function log(event: string, data: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ at: new Date().toISOString(), event, ...data });
  console.log(line);

  queue = queue.then(() => write(line)).catch((error) => {
    console.error("log write failed", error);
  });
}

/** Waits for the queued writes, for tests and for a clean shutdown. */
export function flushLog(): Promise<void> {
  return queue;
}
