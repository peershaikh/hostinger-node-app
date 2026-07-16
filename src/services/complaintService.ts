import { supabase } from '../config/supabase';
import { winstonLogger } from '../middleware/logger';
import fs from 'fs';
import path from 'path';

export interface Complaint {
  id?: string;
  trainNo: string;
  date: string;
  coach: string;
  seat?: string;
  issueType: 'dirty_toilet' | 'no_water' | 'ac_failure' | 'unauthorized_passenger' | 'medical_emergency';
  priority: 'low' | 'medium' | 'high';
  timestamp: string;
  reported_by?: string; // optional session_id or user reference
}

const COMPLAINTS_FILE = path.join(__dirname, '../../data/complaints.json');

export class ComplaintService {
  private readonly TABLE_NAME = 'complaints';

  /**
   * Add a new complaint (real-time)
   */
  async addComplaint(data: Omit<Complaint, 'id' | 'timestamp'>): Promise<Complaint> {
    try {
      const payload: Complaint = {
        ...data,
        timestamp: new Date().toISOString()
      };

      let insertedComplaint = payload;
      let dbSuccess = false;

      // Primary: Supabase insertion
      try {
        const { data: inserted, error } = await supabase
          .from(this.TABLE_NAME)
          .insert([payload])
          .select()
          .single();

        if (error) {
          throw error;
        } else if (inserted) {
          insertedComplaint = inserted as Complaint;
          dbSuccess = true;
          winstonLogger.info(`[COMPLAINT] Added to Supabase for train ${data.trainNo} | Type: ${data.issueType} | Priority: ${data.priority}`);
        }
      } catch (dbErr: any) {
        winstonLogger.error(`[COMPLAINT_ADD] Supabase failed for train ${data.trainNo}: ${dbErr.message}. Falling back to JSON.`);
      }

      // Secondary: Local JSON Fallback
      try {
        let existing: any[] = [];
        if (fs.existsSync(COMPLAINTS_FILE)) {
          existing = JSON.parse(fs.readFileSync(COMPLAINTS_FILE, 'utf-8'));
        }
        existing.push(insertedComplaint);
        if (!fs.existsSync(path.dirname(COMPLAINTS_FILE))) {
          fs.mkdirSync(path.dirname(COMPLAINTS_FILE), { recursive: true });
        }
        fs.writeFileSync(COMPLAINTS_FILE, JSON.stringify(existing, null, 2), 'utf-8');
      } catch (fileErr: any) {
        winstonLogger.warn(`[COMPLAINT] Local fallback write failed: ${fileErr.message}`);
      }

      return insertedComplaint;
    } catch (err: any) {
      winstonLogger.error(`[COMPLAINT_ADD] Critical failure for train ${data.trainNo}: ${err.message}`);
      throw err;
    }
  }

  /**
   * Get all complaints for a specific train
   */
  async getComplaintsByTrain(trainNo: string): Promise<Complaint[]> {
    try {
      const { data, error } = await supabase
        .from(this.TABLE_NAME)
        .select('*')
        .eq('trainNo', trainNo.toUpperCase())
        .order('timestamp', { ascending: false });

      if (error) {
        throw error;
      }
      return (data || []) as Complaint[];
    } catch (err: any) {
      winstonLogger.error(`[COMPLAINT_FETCH] Supabase fetch error for train ${trainNo}: ${err.message}. Falling back to JSON.`);
      try {
        if (fs.existsSync(COMPLAINTS_FILE)) {
          const allComplaints: Complaint[] = JSON.parse(fs.readFileSync(COMPLAINTS_FILE, 'utf-8'));
          return allComplaints
            .filter(c => c.trainNo.toUpperCase() === trainNo.toUpperCase())
            .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
        }
      } catch (e) {
        winstonLogger.error(`[COMPLAINT_FETCH] JSON fallback also failed.`);
      }
      return [];
    }
  }

  /**
   * Get complaint aggregation (used for risk dashboard / alerts)
   * - Last 24h count
   * - Risk level (auto-calculated)
   */
  async getComplaintAggregation(trainNo: string) {
    const complaints = await this.getComplaintsByTrain(trainNo);
    const now = new Date();

    const last24h = complaints.filter(c => {
      const cDate = new Date(c.timestamp);
      return (now.getTime() - cDate.getTime()) < 24 * 60 * 60 * 1000;
    });

    const count = last24h.length;
    let riskLevel: 'low' | 'medium' | 'high' = 'low';
    if (count >= 6) riskLevel = 'high';
    else if (count >= 3) riskLevel = 'medium';

    winstonLogger.debug(`[COMPLAINT_AGG] Train ${trainNo} | Last 24h: ${count} | Risk: ${riskLevel}`);

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
  async getHighPriorityComplaints(limit = 20): Promise<Complaint[]> {
    try {
      const { data, error } = await supabase
        .from(this.TABLE_NAME)
        .select('*')
        .eq('priority', 'high')
        .order('timestamp', { ascending: false })
        .limit(limit);

      if (error) throw error;
      return (data || []) as Complaint[];
    } catch (err: any) {
      winstonLogger.error(`[COMPLAINT_HIGH] Failed to fetch high priority: ${err.message}`);
      return [];
    }
  }
}

export const complaintService = new ComplaintService();