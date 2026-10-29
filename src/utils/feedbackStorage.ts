import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { isNoWriteMode } from '../config/supabase';
import { winstonLogger } from '../middleware/logger';

export const FEEDBACK_FILE = path.join(__dirname, '../../../data/feedback.json');
export const MAX_FALLBACK_CAPACITY = 5000;

export class StorageCapacityExceededError extends Error {
  constructor(message: string = `Fallback storage capacity reached (${MAX_FALLBACK_CAPACITY})`) {
    super(message);
    this.name = 'StorageCapacityExceededError';
  }
}

// Global promise queue for strict serialized writes across all producers
let fallbackWriteQueue: Promise<any> = Promise.resolve();

export function enqueueFeedbackTask<T>(task: () => Promise<T>): Promise<T> {
  const run = () => task();
  const nextPromise = fallbackWriteQueue.then(run, run);
  fallbackWriteQueue = nextPromise.then(() => {}, () => {});
  return nextPromise;
}

export function _resetQueueForTesting(): void {
  fallbackWriteQueue = Promise.resolve();
}

/**
 * Atomically writes data to a JSON file using a unique temp file and rename.
 * Cleans up temporary file if write or rename fails.
 */
export async function atomicWriteJsonFile(filePath: string, data: any): Promise<void> {
  if (isNoWriteMode()) {
    winstonLogger.debug(`[NO_WRITE] Suppressed atomic file write: ${path.basename(filePath)}`);
    return;
  }

  const dir = path.dirname(filePath);
  await fs.promises.mkdir(dir, { recursive: true });

  const tmpFile = `${filePath}.tmp.${Date.now()}.${crypto.randomBytes(4).toString('hex')}`;
  const serialized = JSON.stringify(data, null, 2);

  try {
    await fs.promises.writeFile(tmpFile, serialized, 'utf8');
    await fs.promises.rename(tmpFile, filePath);
  } catch (err) {
    try {
      await fs.promises.unlink(tmpFile);
    } catch {
      // Ignore if tmpFile was never created or already unlinked
    }
    throw err;
  }
}

/**
 * Reads feedback array from FEEDBACK_FILE safely.
 */
export async function readFeedbackRecords(): Promise<any[]> {
  try {
    const raw = await fs.promises.readFile(FEEDBACK_FILE, 'utf8');
    const trimmed = raw.trim();
    if (!trimmed) return [];
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err: any) {
    if (err.code !== 'ENOENT') {
      winstonLogger.warn(`[FEEDBACK_STORAGE] Read failed: ${err.message}`);
    }
    return [];
  }
}

/**
 * Resolves a unique tracking key for a feedback/contact record.
 */
export function getFeedbackRecordKey(record: any): string {
  if (record && typeof record.id === 'string' && record.id.trim()) {
    return `id:${record.id.trim()}`;
  }
  const pnr = record?.pnr || '';
  const email = record?.email || '';
  const ts = record?.timestamp || '';
  return `fallback:${pnr}:${email}:${ts}`;
}

/**
 * Enqueues a single feedback record into FEEDBACK_FILE under the shared serialized queue.
 * Rejects with StorageCapacityExceededError if capacity is >= MAX_FALLBACK_CAPACITY.
 * Appends using FIFO push order.
 */
export async function enqueueFeedbackRecord(record: any): Promise<void> {
  return enqueueFeedbackTask(async () => {
    const allFeedback = await readFeedbackRecords();

    if (allFeedback.length >= MAX_FALLBACK_CAPACITY) {
      winstonLogger.error(`[FEEDBACK_STORAGE_SATURATED] Queue capacity reached (${MAX_FALLBACK_CAPACITY}). Rejecting write.`);
      throw new StorageCapacityExceededError(`Fallback storage capacity reached (${MAX_FALLBACK_CAPACITY})`);
    }

    // FIFO ordering: append new record so sync worker drains in chronological order
    allFeedback.push(record);

    await atomicWriteJsonFile(FEEDBACK_FILE, allFeedback);
  });
}

/**
 * Removes successfully synchronized records matching syncedKeys under the shared serialized queue.
 * Guarantees incoming submissions appended during synchronization are preserved.
 */
export async function removeSyncedFeedbackRecords(syncedKeys: Set<string>): Promise<{ remainingCount: number }> {
  return enqueueFeedbackTask(async () => {
    const currentRecords = await readFeedbackRecords();
    if (currentRecords.length === 0) {
      return { remainingCount: 0 };
    }

    const remaining = currentRecords.filter(r => {
      const key = getFeedbackRecordKey(r);
      return !syncedKeys.has(key);
    });

    if (remaining.length !== currentRecords.length) {
      await atomicWriteJsonFile(FEEDBACK_FILE, remaining);
    }

    return { remainingCount: remaining.length };
  });
}

/**
 * Clears FEEDBACK_FILE safely to empty array under the shared serialized queue.
 */
export async function clearFeedbackFileSafely(): Promise<void> {
  return enqueueFeedbackTask(async () => {
    await atomicWriteJsonFile(FEEDBACK_FILE, []);
  });
}

