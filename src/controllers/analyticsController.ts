import { Request, Response } from 'express';
import { supabase } from '../config/supabase';
import { winstonLogger } from '../middleware/logger';

export class AnalyticsController {
  /**
   * GET /api/analytics
   * Returns enhanced dashboard metrics for Admin
   */
  async getDashboard(req: Request, res: Response) {
    try {
      // 1. Basic popularity metrics safely
      let topRoutes: any[] = [];
      try {
        const { data } = await supabase
          .from('search_popularity')
          .select('*')
          .order('search_count', { ascending: false })
          .limit(5);
        topRoutes = data || [];
      } catch (err: any) {
        winstonLogger.warn(`[ANALYTICS_DASHBOARD_ROUTES_FAIL] ${err.message}`);
      }
      
      // 2. High-level counts safely
      let totalPnrs = 0;
      let totalPro = 0;
      let totalComplaints = 0;
      try {
        const { count: pnrs } = await supabase.from('pnr_tracking').select('*', { count: 'exact', head: true }).eq('is_pro', true);
        const { count: pro } = await supabase.from('pnr_tracking').select('*', { count: 'exact', head: true }).eq('is_pro', true);
        totalPnrs = pnrs || 0;
        totalPro = pro || 0;
      } catch (err: any) { winstonLogger.warn(`[ANALYTICS_DASHBOARD_PNR_COUNT_FAIL] ${err.message}`); }

      try {
        const { count: complaints } = await supabase.from('social_complaints').select('*', { count: 'exact', head: true });
        totalComplaints = complaints || 0;
      } catch (err: any) { winstonLogger.warn(`[ANALYTICS_DASHBOARD_COMPLAINTS_COUNT_FAIL] ${err.message}`); }

      // 3. Feedback Accuracy Ratio safely
      let accuracyRate = 92;
      try {
        const { data: feedbackData } = await supabase.from('feedback').select('is_accurate');
        const accurateCount = feedbackData?.filter(f => f.is_accurate).length || 0;
        const totalFeedback = feedbackData?.length || 0;
        accuracyRate = totalFeedback > 0 ? (accurateCount / totalFeedback) * 100 : 92;
      } catch (err: any) {
        winstonLogger.warn(`[ANALYTICS_DASHBOARD_FEEDBACK_FAIL] ${err.message}`);
      }

      // 4. Daily Trends (Last 7 days) safely using created_at
      let eventHistory: any[] = [];
      try {
        const { data } = await supabase
          .from('analytics_events')
          .select('event_type, created_at')
          .gte('created_at', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString());
        
        eventHistory = (data || []).map((row: any) => ({
          event_type: row.event_type,
          timestamp: row.created_at || row.timestamp
        }));
      } catch (err: any) {
        winstonLogger.warn(`[ANALYTICS_DASHBOARD_EVENTS_FAIL] ${err.message}`);
      }

      // 5. AI Learning Engine Data safely
      let learningMetrics: any = {};
      try {
        const { learningService } = require('../services/learningService');
        learningMetrics = await learningService.getDashboardAnalytics();
      } catch (err: any) {
        winstonLogger.warn(`[ANALYTICS_DASHBOARD_AI_FAIL] ${err.message}`);
      }

      res.status(200).json({
        success: true,
        data: {
          metrics: {
            total_pnr_tracked: totalPnrs,
            total_pro_users: totalPro,
            total_complaints: totalComplaints,
            accuracy_rate: Math.round(accuracyRate)
          },
          ai_learning: learningMetrics,
          top_routes: topRoutes,
          event_history: eventHistory
        }
      });
    } catch (err: any) {
      winstonLogger.error(`[ANALYTICS] Fetch Error: ${err.message}`);
      res.status(500).json({ success: false, error: 'Failed to fetch analytics dashboard' });
    }
  }

  /**
   * POST /api/analytics/event
   */
  async trackEvent(req: Request, res: Response) {
    const { event_type, pnr, metadata } = req.body;
    try {
      const sessionId = (metadata?.session_id || metadata?.sessionId || metadata?.userId || metadata?.user_id || null) as string | null;

      const dbPayload = {
        event_type,
        session_id: sessionId,
        metadata: metadata || {},
        payload: {
          pnr: pnr || null,
          client_timestamp: new Date().toISOString()
        }
      };

      await supabase.from('analytics_events').insert([dbPayload]);
      res.status(200).json({ success: true });
    } catch (err: any) {
      winstonLogger.error(`[EVENT_TRACK] Error: ${err.message}`);
      res.status(500).json({ success: false });
    }
  }

  /**
   * POST /api/analytics/split-click
   */
  async logSplitClick(req: Request, res: Response) {
    const { id } = req.body;
    try {
      if (id) {
        const { learningService } = require('../services/learningService');
        await learningService.updateSplitInteraction(id, true, false);
      }
      res.status(200).json({ success: true });
    } catch (err: any) {
      winstonLogger.error(`[SPLIT_CLICK_LOG] Error: ${err.message}`);
      res.status(500).json({ success: false });
    }
  }

  /**
   * POST /api/analytics/feedback
   */
  async submitFeedback(req: Request, res: Response) {
    const { pnr, is_accurate, comments, prediction_percent, confidence_label, current_status } = req.body;
    try {
      // 1. Try legacy feedback table
      try {
        await supabase.from('feedback').insert([{ 
          pnr, 
          is_accurate, 
          comments, 
          timestamp: new Date().toISOString() 
        }]);
      } catch (legacyErr) {
        // Ignore legacy table errors
      }

      // 2. Insert into new public.pnr_prediction_feedback table
      const payload = { 
        pnr, 
        prediction_percent: prediction_percent !== undefined ? parseInt(String(prediction_percent), 10) : 50,
        confidence_label: confidence_label || 'Moderate Chance',
        current_status: current_status || 'Unknown',
        user_feedback: !!is_accurate, 
        comment: comments || null
      };

      const { error } = await supabase.from('pnr_prediction_feedback').insert([payload]);

      if (error) {
        if (error.code === 'PGRST205' || error.code === '42P01') {
          // Local fallback
          const fs = require('fs');
          const path = require('path');
          const DATA_DIR = path.join(__dirname, '../../data');
          if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
          const filePath = path.join(DATA_DIR, 'pnr_prediction_feedback_fallback.jsonl');
          const line = JSON.stringify({ ...payload, created_at: new Date().toISOString() }) + '\n';
          fs.appendFileSync(filePath, line, 'utf8');
          winstonLogger.info(`[FEEDBACK] Saved to local fallback: ${pnr}`);
        } else {
          throw error;
        }
      }
      res.status(200).json({ success: true });
    } catch (err: any) {
      winstonLogger.error(`[FEEDBACK] Error: ${err.message}`);
      res.status(500).json({ success: false });
    }
  }

  /**
   * POST /api/analytics/complaint
   */
  async logComplaint(req: Request, res: Response) {
    const { pnr, train_no, issue_type, tweet_content } = req.body;
    const payload = { 
      pnr, 
      train_no, 
      issue_type, 
      tweet_content, 
      timestamp: new Date().toISOString() 
    };
    try {
      const { error } = await supabase.from('social_complaints').insert([payload]);
      if (error) {
        throw error;
      }
      res.status(200).json({ success: true });
    } catch (err: any) {
      winstonLogger.error(`[COMPLAINT_LOG] Error: ${err.message || err}. Saving to local fallback.`);
      try {
        const fs = require('fs');
        const path = require('path');
        const DATA_DIR = path.join(__dirname, '../../data');
        if (!fs.existsSync(DATA_DIR)) {
          fs.mkdirSync(DATA_DIR, { recursive: true });
        }
        const filePath = path.join(DATA_DIR, 'social_complaints_fallback.jsonl');
        const line = JSON.stringify(payload) + '\n';
        fs.appendFileSync(filePath, line, 'utf8');
        winstonLogger.info(`[COMPLAINT_LOG] Saved to local fallback: ${pnr}`);
        res.status(200).json({ success: true, fallback: true });
      } catch (fallbackErr: any) {
        winstonLogger.error(`[COMPLAINT_LOG] Fallback write failed: ${fallbackErr.message}`);
        res.status(500).json({ success: false, error: err.message || 'Failed to log complaint' });
      }
    }
  }

  /**
   * GET /api/analytics/trending
   */
  async getTrending(req: Request, res: Response) {
    try {
      const { data, error } = await supabase
        .from('search_popularity')
        .select('source, destination, search_count')
        .order('search_count', { ascending: false })
        .limit(4);

      if (error && error.code !== '42P01') throw error;
      
      res.status(200).json({
        success: true,
        data: data || []
      });
    } catch (err: any) {
      winstonLogger.error(`[TRENDING] Fetch Error: ${err.message}`);
      res.status(500).json({ success: false, error: 'Failed to fetch trending routes' });
    }
  }

  /**
   * GET /api/analytics/referrals/:sessionId?
   */
  async getReferralStats(req: Request, res: Response) {
    const { sessionId } = req.params;
    
    // Fallback for missing sessionId (e.g., first load)
    const activeSid = sessionId || 'anonymous_guest';
    
    try {
      let { data: user, error } = await supabase
        .from('user_usage')
        .select('referral_code, session_id')
        .eq('session_id', activeSid)
        .single();
      
      if (!user && (error?.code === 'PGRST116' || !error)) {
        // Create usage record if missing
        const newCode = `RAIL-${Math.random().toString(36).substring(2, 7).toUpperCase()}`;
        const { data: newUser, error: createError } = await supabase
          .from('user_usage')
          .insert([{ session_id: activeSid, referral_code: newCode }])
          .select('referral_code, session_id')
          .single();
        if (createError) throw createError;
        user = newUser;
      }

      // Dynamically count referrals from referrals table
      let referralCount = 0;
      if (user) {
        const { count, error: countError } = await supabase
          .from('referrals')
          .select('id', { count: 'exact', head: true })
          .eq('inviter_id', activeSid);
        if (!countError && count !== null) {
          referralCount = count;
        }
      }

      res.status(200).json({
        success: true,
        data: {
          referral_code: user?.referral_code || 'RAIL-XXXX',
          referral_count: referralCount
        }
      });
    } catch (err: any) {
      winstonLogger.error(`[REFERRAL_STATS] Error: ${err.message}`);
      res.status(200).json({
        success: true,
        data: { referral_code: 'RAIL-SAVE', referral_count: 0 } // Safe fallback
      });
    }
  }

  /**
   * POST /api/analytics/referrals/claim
   */
  async claimReferral(req: Request, res: Response) {
    const { session_id, ref_code } = req.body;
    try {
      const { userUsageService } = require('../services/userUsageService');
      
      // Handle referral logging & inviter reward
      const result = await userUsageService.claimReferral(session_id, ref_code);
      if (!result.success) {
        return res.status(400).json({ success: false, error: result.message });
      }

      // Reward the claimant (granting free check)
      await userUsageService.addBonusCheck(session_id);

      res.status(200).json({ success: true, message: 'Referral claimed successfully!' });
    } catch (err: any) {
      winstonLogger.error(`[CLAIM_REFERRAL] Error: ${err.message}`);
      res.status(500).json({ success: false, error: 'Failed to claim referral' });
    }
  }
}

export const analyticsController = new AnalyticsController();
