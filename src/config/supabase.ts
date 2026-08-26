import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { winstonLogger } from '../middleware/logger';
import fs from 'fs';
import path from 'path';

// ---------------------------------------------------------------------------
// PHASE 5B136 - LOCAL_E2E_NO_WRITE (safe local end-to-end no-write mode)
//
// Read BEFORE dotenv.config() on purpose: the flag can therefore only ever be
// supplied by the shell environment. No .env file - production or local - is
// able to switch this mode on. Snapshotted once at module load; there is no
// runtime setter, so the write boundary cannot drift mid-process.
//
// DEFAULT IS OFF. When OFF, every path below behaves exactly as it did before
// this phase.
// ---------------------------------------------------------------------------
const NO_WRITE_MODE: boolean = process.env.LOCAL_E2E_NO_WRITE === 'true';

dotenv.config({ path: path.join(__dirname, '../../.env') });

/** Token identifying a request rejected by the no-write boundary. */
export const NO_WRITE_ERROR_CODE = 'LOCAL_E2E_NO_WRITE_BLOCKED';

/** True only when the shell exported LOCAL_E2E_NO_WRITE=true. */
export const isNoWriteMode = (): boolean => NO_WRITE_MODE;

/**
 * Thrown by the Supabase transport guard for any mutating HTTP verb.
 *
 * The identifying token lives in `name` because postgrest-js converts a
 * rejected fetch into `{ error: { message: `${name}: ${message}` } }` and
 * hardcodes `error.code` to '' (postgrest-js/dist/index.cjs:294). Call sites
 * that inspect `error.message` therefore still see the token, while direct
 * catch sites can read `.code` off the thrown object.
 */
export class NoWriteBlockedError extends Error {
  public readonly code: string = NO_WRITE_ERROR_CODE;
  constructor(detail: string) {
    super(`${NO_WRITE_ERROR_CODE}: ${detail}`);
    this.name = NO_WRITE_ERROR_CODE;
  }
}

const NO_WRITE_SAFE_METHODS = new Set(['GET', 'HEAD']);

/**
 * Builds the `global.fetch` implementation handed to createClient in no-write
 * mode. One custom fetch covers PostgREST verbs, .rpc(), storage, edge
 * functions and auth-admin, because supabase-js threads the same function
 * into every sub-client it constructs.
 *
 * GET/HEAD are delegated untouched to the platform fetch - the very function
 * the library resolves to by default. Every other verb throws. No fake
 * successful response is ever fabricated.
 */
export function createNoWriteFetch(clientLabel: string) {
  return (input: any, init?: any): Promise<any> => {
    const method = String(
      (init && init.method) ||
      (input && typeof input === 'object' && input.method) ||
      'GET'
    ).toUpperCase();

    if (!NO_WRITE_SAFE_METHODS.has(method)) {
      // Log the path only - never origin, query string or headers - so no
      // project ref, key or token can leak into the log files.
      let target = 'unknown';
      try {
        const raw = typeof input === 'string'
          ? input
          : (input && (input.href || input.url)) || '';
        target = raw ? new URL(String(raw)).pathname : 'unknown';
      } catch {
        target = 'unparsable';
      }
      winstonLogger.warn(`[NO_WRITE] Blocked ${method} ${target} (client=${clientLabel})`);
      throw new NoWriteBlockedError(`${method} ${target} rejected on client "${clientLabel}"`);
    }

    const platformFetch: any = (globalThis as any).fetch;
    return platformFetch(input, init);
  };
}

/**
 * fs.writeFileSync wrapper for the test-side JSON stores. The Supabase
 * transport guard cannot see filesystem writes, so those call sites route
 * through here instead.
 *
 * In no-write mode the write is suppressed and `false` returned; nothing is
 * read, truncated or deleted, so existing JSON data is left untouched. When
 * OFF this is a straight pass-through to fs.writeFileSync.
 */
export function safeWriteFileSync(filePath: string, data: string, options?: any): boolean {
  if (NO_WRITE_MODE) {
    winstonLogger.debug(`[NO_WRITE] Suppressed filesystem write: ${path.basename(filePath)}`);
    return false;
  }
  fs.writeFileSync(filePath, data, options);
  return true;
}

/** Suppresses append-only local fallbacks while local E2E no-write mode is on. */
export function safeAppendFileSync(filePath: string, data: string, options?: any): boolean {
  if (NO_WRITE_MODE) {
    winstonLogger.debug(`[NO_WRITE] Suppressed filesystem append: ${path.basename(filePath)}`);
    return false;
  }
  fs.appendFileSync(filePath, data, options);
  return true;
}

/** Directory creation is a filesystem mutation and must obey no-write mode. */
export function safeMkdirSync(dirPath: string, options?: any): boolean {
  if (NO_WRITE_MODE) {
    winstonLogger.debug(`[NO_WRITE] Suppressed directory creation: ${path.basename(dirPath)}`);
    return false;
  }
  fs.mkdirSync(dirPath, options);
  return true;
}

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';

export const isSupabaseConfigured = () => {
  if (!supabaseUrl || !supabaseKey) return false;
  const urlLower = supabaseUrl.toLowerCase();
  return !(urlLower.includes('your-project-id') || urlLower.includes('your_project_id') || urlLower.includes('placeholder'));
};

const primarySupabaseUrl = isSupabaseConfigured() ? supabaseUrl : 'https://placeholder.supabase.co';
const primarySupabaseKey = isSupabaseConfigured() ? supabaseKey : 'placeholder-key';

// OFF mode keeps the original two-argument createClient call verbatim, so
// production client construction is unchanged.
export const supabase = NO_WRITE_MODE
  ? createClient(primarySupabaseUrl, primarySupabaseKey, {
      global: { fetch: createNoWriteFetch('config/supabase') }
    })
  : createClient(primarySupabaseUrl, primarySupabaseKey);

/**
 * Health Check - Database Connection + Critical Tables
 */
export async function validateConnection(): Promise<boolean> {
  if (!isSupabaseConfigured()) return false;

  try {
    // Basic connection test
    const { error: connError } = await supabase
      .from('station_registry')
      .select('station_code')
      .limit(1);

    if (connError) {
      winstonLogger.error(`[HEALTH] Supabase Connection Failed: ${connError.message}`);
      return false;
    }

    // Check important tables
    const tablesToCheck = ['station_registry', 'trains', 'pnr_tracking', 'user_usage'];

    for (const table of tablesToCheck) {
      const { error } = await supabase
        .from(table)
        .select('*', { head: true, count: 'exact' })
        .limit(1);

      if (error && error.code !== 'PGRST116') { // PGRST116 = no rows (ok)
        winstonLogger.warn(`[HEALTH] Table "${table}" has issues: ${error.message}`);
      }
    }

    winstonLogger.info(`[HEALTH] ✅ Supabase Connection Healthy | Core tables verified`);
    return true;

  } catch (err: any) {
    winstonLogger.error(`[HEALTH] Critical Error: ${err.message}`);
    return false;
  }
}
