"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.supabase = exports.isSupabaseConfigured = void 0;
exports.validateConnection = validateConnection;
const supabase_js_1 = require("@supabase/supabase-js");
const dotenv_1 = __importDefault(require("dotenv"));
const logger_1 = require("../middleware/logger");
const path_1 = __importDefault(require("path"));
dotenv_1.default.config({ path: path_1.default.join(__dirname, '../../.env') });
const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';
const isSupabaseConfigured = () => {
    if (!supabaseUrl || !supabaseKey)
        return false;
    const urlLower = supabaseUrl.toLowerCase();
    return !(urlLower.includes('your-project-id') || urlLower.includes('your_project_id') || urlLower.includes('placeholder'));
};
exports.isSupabaseConfigured = isSupabaseConfigured;
exports.supabase = (0, supabase_js_1.createClient)((0, exports.isSupabaseConfigured)() ? supabaseUrl : 'https://placeholder.supabase.co', (0, exports.isSupabaseConfigured)() ? supabaseKey : 'placeholder-key');
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
            .select('Station_Code')
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
