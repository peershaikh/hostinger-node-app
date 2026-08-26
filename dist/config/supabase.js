"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.supabase = exports.isSupabaseConfigured = exports.NoWriteBlockedError = exports.isNoWriteMode = exports.NO_WRITE_ERROR_CODE = void 0;
exports.createNoWriteFetch = createNoWriteFetch;
exports.safeWriteFileSync = safeWriteFileSync;
exports.safeAppendFileSync = safeAppendFileSync;
exports.safeMkdirSync = safeMkdirSync;
exports.validateConnection = validateConnection;
const supabase_js_1 = require("@supabase/supabase-js");
const dotenv_1 = __importDefault(require("dotenv"));
const logger_1 = require("../middleware/logger");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
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
const NO_WRITE_MODE = process.env.LOCAL_E2E_NO_WRITE === 'true';
dotenv_1.default.config({ path: path_1.default.join(__dirname, '../../.env') });
/** Token identifying a request rejected by the no-write boundary. */
exports.NO_WRITE_ERROR_CODE = 'LOCAL_E2E_NO_WRITE_BLOCKED';
/** True only when the shell exported LOCAL_E2E_NO_WRITE=true. */
const isNoWriteMode = () => NO_WRITE_MODE;
exports.isNoWriteMode = isNoWriteMode;
/**
 * Thrown by the Supabase transport guard for any mutating HTTP verb.
 *
 * The identifying token lives in `name` because postgrest-js converts a
 * rejected fetch into `{ error: { message: `${name}: ${message}` } }` and
 * hardcodes `error.code` to '' (postgrest-js/dist/index.cjs:294). Call sites
 * that inspect `error.message` therefore still see the token, while direct
 * catch sites can read `.code` off the thrown object.
 */
class NoWriteBlockedError extends Error {
    constructor(detail) {
        super(`${exports.NO_WRITE_ERROR_CODE}: ${detail}`);
        this.code = exports.NO_WRITE_ERROR_CODE;
        this.name = exports.NO_WRITE_ERROR_CODE;
    }
}
exports.NoWriteBlockedError = NoWriteBlockedError;
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
function createNoWriteFetch(clientLabel) {
    return (input, init) => {
        const method = String((init && init.method) ||
            (input && typeof input === 'object' && input.method) ||
            'GET').toUpperCase();
        if (!NO_WRITE_SAFE_METHODS.has(method)) {
            // Log the path only - never origin, query string or headers - so no
            // project ref, key or token can leak into the log files.
            let target = 'unknown';
            try {
                const raw = typeof input === 'string'
                    ? input
                    : (input && (input.href || input.url)) || '';
                target = raw ? new URL(String(raw)).pathname : 'unknown';
            }
            catch {
                target = 'unparsable';
            }
            logger_1.winstonLogger.warn(`[NO_WRITE] Blocked ${method} ${target} (client=${clientLabel})`);
            throw new NoWriteBlockedError(`${method} ${target} rejected on client "${clientLabel}"`);
        }
        const platformFetch = globalThis.fetch;
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
function safeWriteFileSync(filePath, data, options) {
    if (NO_WRITE_MODE) {
        logger_1.winstonLogger.debug(`[NO_WRITE] Suppressed filesystem write: ${path_1.default.basename(filePath)}`);
        return false;
    }
    fs_1.default.writeFileSync(filePath, data, options);
    return true;
}
/** Suppresses append-only local fallbacks while local E2E no-write mode is on. */
function safeAppendFileSync(filePath, data, options) {
    if (NO_WRITE_MODE) {
        logger_1.winstonLogger.debug(`[NO_WRITE] Suppressed filesystem append: ${path_1.default.basename(filePath)}`);
        return false;
    }
    fs_1.default.appendFileSync(filePath, data, options);
    return true;
}
/** Directory creation is a filesystem mutation and must obey no-write mode. */
function safeMkdirSync(dirPath, options) {
    if (NO_WRITE_MODE) {
        logger_1.winstonLogger.debug(`[NO_WRITE] Suppressed directory creation: ${path_1.default.basename(dirPath)}`);
        return false;
    }
    fs_1.default.mkdirSync(dirPath, options);
    return true;
}
const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';
const isSupabaseConfigured = () => {
    if (!supabaseUrl || !supabaseKey)
        return false;
    const urlLower = supabaseUrl.toLowerCase();
    return !(urlLower.includes('your-project-id') || urlLower.includes('your_project_id') || urlLower.includes('placeholder'));
};
exports.isSupabaseConfigured = isSupabaseConfigured;
const primarySupabaseUrl = (0, exports.isSupabaseConfigured)() ? supabaseUrl : 'https://placeholder.supabase.co';
const primarySupabaseKey = (0, exports.isSupabaseConfigured)() ? supabaseKey : 'placeholder-key';
// OFF mode keeps the original two-argument createClient call verbatim, so
// production client construction is unchanged.
exports.supabase = NO_WRITE_MODE
    ? (0, supabase_js_1.createClient)(primarySupabaseUrl, primarySupabaseKey, {
        global: { fetch: createNoWriteFetch('config/supabase') }
    })
    : (0, supabase_js_1.createClient)(primarySupabaseUrl, primarySupabaseKey);
/**
 * Health Check - Database Connection + Critical Tables
 */
async function validateConnection() {
    if (!(0, exports.isSupabaseConfigured)())
        return false;
    try {
        // Basic connection test
        const { error: connError } = await exports.supabase
            .from('station_registry')
            .select('station_code')
            .limit(1);
        if (connError) {
            logger_1.winstonLogger.error(`[HEALTH] Supabase Connection Failed: ${connError.message}`);
            return false;
        }
        // Check important tables
        const tablesToCheck = ['station_registry', 'trains', 'pnr_tracking', 'user_usage'];
        for (const table of tablesToCheck) {
            const { error } = await exports.supabase
                .from(table)
                .select('*', { head: true, count: 'exact' })
                .limit(1);
            if (error && error.code !== 'PGRST116') { // PGRST116 = no rows (ok)
                logger_1.winstonLogger.warn(`[HEALTH] Table "${table}" has issues: ${error.message}`);
            }
        }
        logger_1.winstonLogger.info(`[HEALTH] ✅ Supabase Connection Healthy | Core tables verified`);
        return true;
    }
    catch (err) {
        logger_1.winstonLogger.error(`[HEALTH] Critical Error: ${err.message}`);
        return false;
    }
}
