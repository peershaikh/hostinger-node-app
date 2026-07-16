"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.complaintService = exports.ComplaintService = void 0;
const supabase_1 = require("../config/supabase");
const logger_1 = require("../middleware/logger");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const COMPLAINTS_FILE = path_1.default.join(__dirname, '../../data/complaints.json');
class ComplaintService {
    constructor() {
        this.TABLE_NAME = 'complaints';
    }
    /**
     * Add a new complaint (real-time)
     */
    async addComplaint(data) {
        try {
            const payload = {
                ...data,
                timestamp: new Date().toISOString()
            };
            let insertedComplaint = payload;
            let dbSuccess = false;
            // Primary: Supabase insertion
            try {
                const { data: inserted, error } = await supabase_1.supabase
                    .from(this.TABLE_NAME)
                    .insert([payload])
                    .select()
                    .single();
                if (error) {
                    throw error;
                }
                else if (inserted) {
                    insertedComplaint = inserted;
                    dbSuccess = true;
                    logger_1.winstonLogger.info(`[COMPLAINT] Added to Supabase for train ${data.trainNo} | Type: ${data.issueType} | Priority: ${data.priority}`);
                }
            }
            catch (dbErr) {
                logger_1.winstonLogger.error(`[COMPLAINT_ADD] Supabase failed for train ${data.trainNo}: ${dbErr.message}. Falling back to JSON.`);
            }
            // Secondary: Local JSON Fallback
            try {
                let existing = [];
                if (fs_1.default.existsSync(COMPLAINTS_FILE)) {
                    existing = JSON.parse(fs_1.default.readFileSync(COMPLAINTS_FILE, 'utf-8'));
                }
                existing.push(insertedComplaint);
                if (!fs_1.default.existsSync(path_1.default.dirname(COMPLAINTS_FILE))) {
                    fs_1.default.mkdirSync(path_1.default.dirname(COMPLAINTS_FILE), { recursive: true });
                }
                fs_1.default.writeFileSync(COMPLAINTS_FILE, JSON.stringify(existing, null, 2), 'utf-8');
            }
            catch (fileErr) {
                logger_1.winstonLogger.warn(`[COMPLAINT] Local fallback write failed: ${fileErr.message}`);
            }
            return insertedComplaint;
        }
        catch (err) {
            logger_1.winstonLogger.error(`[COMPLAINT_ADD] Critical failure for train ${data.trainNo}: ${err.message}`);
            throw err;
        }
    }
    /**
     * Get all complaints for a specific train
     */
    async getComplaintsByTrain(trainNo) {
        try {
            const { data, error } = await supabase_1.supabase
                .from(this.TABLE_NAME)
                .select('*')
                .eq('trainNo', trainNo.toUpperCase())
                .order('timestamp', { ascending: false });
            if (error) {
                throw error;
            }
            return (data || []);
        }
        catch (err) {
            logger_1.winstonLogger.error(`[COMPLAINT_FETCH] Supabase fetch error for train ${trainNo}: ${err.message}. Falling back to JSON.`);
            try {
                if (fs_1.default.existsSync(COMPLAINTS_FILE)) {
                    const allComplaints = JSON.parse(fs_1.default.readFileSync(COMPLAINTS_FILE, 'utf-8'));
                    return allComplaints
                        .filter(c => c.trainNo.toUpperCase() === trainNo.toUpperCase())
                        .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
                }
            }
            catch (e) {
                logger_1.winstonLogger.error(`[COMPLAINT_FETCH] JSON fallback also failed.`);
            }
            return [];
        }
    }
    /**
     * Get complaint aggregation (used for risk dashboard / alerts)
     * - Last 24h count
     * - Risk level (auto-calculated)
     */
    async getComplaintAggregation(trainNo) {
        const complaints = await this.getComplaintsByTrain(trainNo);
        const now = new Date();
        const last24h = complaints.filter(c => {
            const cDate = new Date(c.timestamp);
            return (now.getTime() - cDate.getTime()) < 24 * 60 * 60 * 1000;
        });
        const count = last24h.length;
        let riskLevel = 'low';
        if (count >= 6)
            riskLevel = 'high';
        else if (count >= 3)
            riskLevel = 'medium';
        logger_1.winstonLogger.debug(`[COMPLAINT_AGG] Train ${trainNo} | Last 24h: ${count} | Risk: ${riskLevel}`);
        return {
            count,
            riskLevel,
            totalCount: complaints.length,
            recent: last24h.slice(0, 10) // limit recent payload
        };
    }
    /**
     * Optional: Get high-priority complaints across all trains (for admin dashboard)
     */
    async getHighPriorityComplaints(limit = 20) {
        try {
            const { data, error } = await supabase_1.supabase
                .from(this.TABLE_NAME)
                .select('*')
                .eq('priority', 'high')
                .order('timestamp', { ascending: false })
                .limit(limit);
            if (error)
                throw error;
            return (data || []);
        }
        catch (err) {
            logger_1.winstonLogger.error(`[COMPLAINT_HIGH] Failed to fetch high priority: ${err.message}`);
            return [];
        }
    }
}
exports.ComplaintService = ComplaintService;
exports.complaintService = new ComplaintService();
