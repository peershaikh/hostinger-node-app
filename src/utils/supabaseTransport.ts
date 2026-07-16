import Transport from 'winston-transport';
import { supabase } from '../config/supabase';
import os from 'os';

export class SupabaseLoggerTransport extends Transport {
  constructor(opts?: Transport.TransportStreamOptions) {
    super(opts);
  }

  log(info: any, callback: () => void) {
    setImmediate(() => {
      this.emit('logged', info);
    });

    if (process.env.ENABLE_DB_DIAGNOSTICS !== 'true') {
      callback();
      return;
    }

    try {
      const level = info.level;
      if (level === 'error' || level === 'warn') {
        const nodeId = process.env.NODE_ID || os.hostname() || 'unknown-node';
        
        // Asynchronous fire-and-forget insert
        Promise.resolve(
          supabase
            .from('server_error_logs')
            .insert([{
              node_id: nodeId,
              level: level.toUpperCase(),
              message: info.message || '',
              meta: info,
              timestamp: new Date().toISOString()
            }])
        )
          .then(({ error }) => {
            if (error) {
              console.error(`[SUPABASE_LOGGER_ERROR] Failed to write log: ${error.message}`);
            }
          })
          .catch((err: any) => {
            console.error(`[SUPABASE_LOGGER_EXCEPTION] ${err.message}`);
          });
      }
    } catch (err: any) {
      console.error(`[SUPABASE_LOGGER_OUTER_ERR] ${err.message}`);
    }

    callback();
  }
}
