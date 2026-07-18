"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SupabaseLoggerTransport = void 0;
const winston_transport_1 = __importDefault(require("winston-transport"));
const supabase_1 = require("../config/supabase");
const os_1 = __importDefault(require("os"));
class SupabaseLoggerTransport extends winston_transport_1.default {
    constructor(opts) {
        super(opts);
    }
    log(info, callback) {
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
                const nodeId = process.env.NODE_ID || os_1.default.hostname() || 'unknown-node';
                // Asynchronous fire-and-forget insert
                Promise.resolve(supabase_1.supabase
                    .from('server_error_logs')
                    .insert([{
                        node_id: nodeId,
                        level: level.toUpperCase(),
                        message: info.message || '',
                        meta: info,
                        timestamp: new Date().toISOString()
                    }]))
                    .then(({ error }) => {
                    if (error) {
                        console.error(`[SUPABASE_LOGGER_ERROR] Failed to write log: ${error.message}`);
                    }
                })
                    .catch((err) => {
                    console.error(`[SUPABASE_LOGGER_EXCEPTION] ${err.message}`);
                });
            }
        }
        catch (err) {
            console.error(`[SUPABASE_LOGGER_OUTER_ERR] ${err.message}`);
        }
        callback();
    }
}
exports.SupabaseLoggerTransport = SupabaseLoggerTransport;
