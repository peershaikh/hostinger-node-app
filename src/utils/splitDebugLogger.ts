import fs from 'fs';
import path from 'path';
import { winstonLogger } from '../middleware/logger';

// Create logs directory if it doesn't exist
const logsDir = path.join(__dirname, '../../logs');
if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
}

const debugLogPath = path.join(logsDir, 'split-debug.log');

export interface SplitDebugData {
    timestamp: string;
    source: string;
    destination: string;
    date: string;
    directTrainCount: number;
    candidateHubs: string[];
    rejectedHubs: Array<{ hub: string; reason: string }>;
    rejectionReasons: string[];
    fallbackAttempts: Array<{ hub: string; success: boolean }>;
    fallbackStrategy?: 'validated' | 'validated-relaxed' | 'corridor' | 'major-corridor' | 'safety-net' | 'raw-safety-net' | 'forced-major-hub' | 'none';
    deterministicSortApplied?: boolean;
    finalSplitCount: number;
    totalDurationFilter: { before: number; after: number; reason: string };
    waitTimeFilter: { before: number; after: number; reason: string };
    directionalFilter: { before: number; after: number; reason: string };
    distanceFilter: { before: number; after: number; reason: string };
}

export class SplitDebugLogger {
    static log(data: SplitDebugData) {
        try {
            const logEntry = {
                ...data,
                timestamp: new Date().toISOString()
            };

            const logLine = JSON.stringify(logEntry) + '\n';
            fs.appendFileSync(debugLogPath, logLine, 'utf8');
            winstonLogger.info(`[SPLIT_DEBUG] Logged debug data for ${data.source} → ${data.destination}`);
        } catch (error) {
            winstonLogger.error(`[SPLIT_DEBUG] Failed to write debug log: ${error}`);
        }
    }

    static readLatestEntries(limit: number = 10): SplitDebugData[] {
        try {
            if (!fs.existsSync(debugLogPath)) {
                return [];
            }

            const content = fs.readFileSync(debugLogPath, 'utf8');
            const lines = content.trim().split('\n').reverse();
            const entries: SplitDebugData[] = [];

            for (const line of lines) {
                if (entries.length >= limit) break;
                try {
                    const entry = JSON.parse(line);
                    entries.push(entry);
                } catch (parseError) {
                    // Skip invalid lines
                }
            }

            return entries.reverse();
        } catch (error) {
            winstonLogger.error(`[SPLIT_DEBUG] Failed to read debug log: ${error}`);
            return [];
        }
    }
}