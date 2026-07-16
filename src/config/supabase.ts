import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { winstonLogger } from '../middleware/logger';
import path from 'path';

dotenv.config({ path: path.join(__dirname, '../../.env') });

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';

export const isSupabaseConfigured = () => {
  if (!supabaseUrl || !supabaseKey) return false;
  const urlLower = supabaseUrl.toLowerCase();
  return !(urlLower.includes('your-project-id') || urlLower.includes('your_project_id') || urlLower.includes('placeholder'));
};

export const supabase = createClient(
  isSupabaseConfigured() ? supabaseUrl : 'https://placeholder.supabase.co',
  isSupabaseConfigured() ? supabaseKey : 'placeholder-key'
);

/**
 * Health Check - Database Connection + Critical Tables
 */
export async function validateConnection(): Promise<boolean> {
  if (!isSupabaseConfigured()) return false;

  try {
    // Basic connection test
    const { error: connError } = await supabase
      .from('station_registry')
      .select('Station_Code')
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
