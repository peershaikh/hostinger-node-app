"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SplitDebugLogger = void 0;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const logger_1 = require("../middleware/logger");
// Create logs directory if it doesn't exist
const logsDir = path_1.default.join(__dirname, '../../logs');
if (!fs_1.default.existsSync(logsDir)) {
    fs_1.default.mkdirSync(logsDir, { recursive: true });
}
const debugLogPath = path_1.default.join(logsDir, 'split-debug.log');
class SplitDebugLogger {
    static log(data) {
        try {
            const logEntry = {
                ...data,
                timestamp: new Date().toISOString()
            };
            const logLine = JSON.stringify(logEntry) + '\n';
            fs_1.default.appendFileSync(debugLogPath, logLine, 'utf8');
            logger_1.winstonLogger.info(`[SPLIT_DEBUG] Logged debug data for ${data.source} → ${data.destination}`);
        }
        catch (error) {
            logger_1.winstonLogger.error(`[SPLIT_DEBUG] Failed to write debug log: ${error}`);
        }
    }
    static readLatestEntries(limit = 10) {
        try {
            if (!fs_1.default.existsSync(debugLogPath)) {
                return [];
            }
            const content = fs_1.default.readFileSync(debugLogPath, 'utf8');
            const lines = content.trim().split('\n').reverse();
            const entries = [];
            for (const line of lines) {
                if (entries.length >= limit)
                    break;
                try {
                    const entry = JSON.parse(line);
                    entries.push(entry);
                }
                catch (parseError) {
                    // Skip invalid lines
                }
            }
            return entries.reverse();
        }
        catch (error) {
            logger_1.winstonLogger.error(`[SPLIT_DEBUG] Failed to read debug log: ${error}`);
            return [];
        }
    }
}
exports.SplitDebugLogger = SplitDebugLogger;
