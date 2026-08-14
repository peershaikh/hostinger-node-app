import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { supabase, isSupabaseConfigured } from '../config/supabase';
import { winstonLogger } from '../middleware/logger';

export interface BetaCode {
  code: string;
  description: string;
  maxRedemptions: number;
  currentRedemptions: number;
  expiresAt: string | null;
  unlimitedSearch: boolean;
  unlimitedPnr: boolean;
  unlimitedLiveTracking: boolean;
  unlimitedSplitSearch: boolean;
  isActive: boolean;
  createdAt?: string;
}

export interface BetaRedemption {
  id: string;
  userId: string;
  betaCode: string;
  redeemedAt: string;
  expiresAt: string | null;
}

const BETA_CODES_FILE = path.join(__dirname, '../../data/beta_codes.json');
const BETA_REDEMPTIONS_FILE = path.join(__dirname, '../../data/beta_redemptions.json');

export class BetaService {
  private codes: BetaCode[] = [];
  private redemptions: BetaRedemption[] = [];

  constructor() {
    this.init();
  }

  private async init() {
    await this.loadData();
    this.ensureDefaultCode();
  }

  private async loadData() {
    let loadedFromDb = false;
    if (isSupabaseConfigured()) {
      try {
        const { data: remoteCodes, error: codeErr } = await supabase.from('beta_codes').select('*');
        if (!codeErr && remoteCodes && remoteCodes.length > 0) {
          const remoteList = remoteCodes.map(c => ({
            code: c.code,
            description: c.description,
            maxRedemptions: c.max_redemptions,
            currentRedemptions: c.current_redemptions,
            expiresAt: c.expires_at,
            unlimitedSearch: c.unlimited_search,
            unlimitedPnr: c.unlimited_pnr,
            unlimitedLiveTracking: c.unlimited_live_tracking,
            unlimitedSplitSearch: c.unlimited_split_search,
            isActive: c.is_active,
            createdAt: c.created_at
          }));
          const existingCodes = new Set(this.codes.map(c => c.code.toUpperCase()));
          for (const c of remoteList) {
            if (!existingCodes.has(c.code.toUpperCase())) {
              this.codes.push(c);
              existingCodes.add(c.code.toUpperCase());
            }
          }
          loadedFromDb = true;
        }

        const { data: remoteRedemptions, error: redErr } = await supabase.from('beta_redemptions').select('*');
        if (!redErr && remoteRedemptions && remoteRedemptions.length > 0) {
          const remoteList = remoteRedemptions.map(r => ({
            id: r.id,
            userId: r.user_id,
            betaCode: r.beta_code,
            redeemedAt: r.redeemed_at,
            expiresAt: r.expires_at
          }));
          const existingIds = new Set(this.redemptions.map(r => r.id));
          for (const r of remoteList) {
            if (!existingIds.has(r.id)) {
              this.redemptions.push(r);
              existingIds.add(r.id);
            }
          }
          loadedFromDb = true;
        }
      } catch (e: any) {
        winstonLogger.warn(`[BETA_SERVICE] Failed to load Supabase data: ${e.message}`);
      }
    }

    if (!loadedFromDb) {
      try {
        if (fs.existsSync(BETA_CODES_FILE)) {
          this.codes = JSON.parse(fs.readFileSync(BETA_CODES_FILE, 'utf-8'));
        }
        if (fs.existsSync(BETA_REDEMPTIONS_FILE)) {
          this.redemptions = JSON.parse(fs.readFileSync(BETA_REDEMPTIONS_FILE, 'utf-8'));
        }
      } catch (e) {
        winstonLogger.warn('[BETA_SERVICE] Failed to load local JSON fallback data');
      }
    }
  }

  private saveData() {
    try {
      if (!fs.existsSync(path.dirname(BETA_CODES_FILE))) {
        fs.mkdirSync(path.dirname(BETA_CODES_FILE), { recursive: true });
      }
      fs.writeFileSync(BETA_CODES_FILE, JSON.stringify(this.codes, null, 2));
      fs.writeFileSync(BETA_REDEMPTIONS_FILE, JSON.stringify(this.redemptions, null, 2));
    } catch (e) {
      winstonLogger.warn('[BETA_SERVICE] Failed to save local data');
    }
  }

  private ensureDefaultCode() {
    // PHASE_4C839 NF-002: never auto-seed unlimited codes in production
    if (process.env.NODE_ENV === 'production') return;

    const defaultCode = 'TRAYAGO25';
    if (!this.codes.find(c => c.code === defaultCode)) {
      const expiry = new Date();
      expiry.setDate(expiry.getDate() + 30);
      const code: BetaCode = {
        code: defaultCode,
        description: 'Default 30-day unlimited beta code',
        maxRedemptions: 999999, // practically unlimited
        currentRedemptions: 0,
        expiresAt: expiry.toISOString(),
        unlimitedSearch: true,
        unlimitedPnr: true,
        unlimitedLiveTracking: true,
        unlimitedSplitSearch: true,
        isActive: true,
        createdAt: new Date().toISOString()
      };
      this.codes.push(code);
      this.saveData();

      if (isSupabaseConfigured()) {
        supabase.from('beta_codes').insert({
          code: code.code,
          description: code.description,
          max_redemptions: code.maxRedemptions,
          current_redemptions: code.currentRedemptions,
          expires_at: code.expiresAt,
          unlimited_search: code.unlimitedSearch,
          unlimited_pnr: code.unlimitedPnr,
          unlimited_live_tracking: code.unlimitedLiveTracking,
          unlimited_split_search: code.unlimitedSplitSearch,
          is_active: code.isActive
        }).then(({ error }) => {
           if (error && error.code !== '23505') { // Ignore unique violation
             winstonLogger.warn(`[BETA_SERVICE] Failed to seed default code to DB: ${error.message}`);
           }
        });
      }
    }

    const azadiCode = 'AZADI80';
    if (!this.codes.find(c => c.code === azadiCode)) {
      const code: BetaCode = {
        code: azadiCode,
        description: 'Independence Day Special: 30 Days Free AI Split Journeys & Premium Travel Tools',
        maxRedemptions: 1000000,
        currentRedemptions: 0,
        expiresAt: null,
        unlimitedSearch: true,
        unlimitedPnr: true,
        unlimitedLiveTracking: true,
        unlimitedSplitSearch: true,
        isActive: true,
        createdAt: new Date().toISOString()
      };
      this.codes.push(code);
      this.saveData();

      if (isSupabaseConfigured()) {
        supabase.from('beta_codes').insert({
          code: code.code,
          description: code.description,
          max_redemptions: code.maxRedemptions,
          current_redemptions: code.currentRedemptions,
          expires_at: code.expiresAt,
          unlimited_search: code.unlimitedSearch,
          unlimited_pnr: code.unlimitedPnr,
          unlimited_live_tracking: code.unlimitedLiveTracking,
          unlimited_split_search: code.unlimitedSplitSearch,
          is_active: code.isActive
        }).then(({ error }) => {
           if (error && error.code !== '23505') {
             winstonLogger.warn(`[BETA_SERVICE] Failed to seed AZADI80 code to DB: ${error.message}`);
           }
        });
      }
    }
  }

  private async syncWithSupabase() {
    // Deprecated in favor of primary Supabase operations and loadData DB fetching
  }

  public getCode(code: string): BetaCode | undefined {
    let found = this.codes.find(c => c.code.toUpperCase() === code.toUpperCase());
    if (!found && code.toUpperCase() === 'AZADI80') {
      found = {
        code: 'AZADI80',
        description: 'Independence Day Special: 30 Days Free AI Split Journeys & Premium Travel Tools',
        maxRedemptions: 1000000,
        currentRedemptions: 0,
        expiresAt: null,
        unlimitedSearch: true,
        unlimitedPnr: true,
        unlimitedLiveTracking: true,
        unlimitedSplitSearch: true,
        isActive: true,
        createdAt: new Date().toISOString()
      };
      this.codes.push(found);
      this.saveData();
    }
    return found;
  }

  public getAllCodes(): BetaCode[] {
    return [...this.codes];
  }

  public getAllRedemptions(): BetaRedemption[] {
    return [...this.redemptions];
  }

  public async createCode(codeData: Omit<BetaCode, 'currentRedemptions' | 'createdAt'>): Promise<BetaCode> {
    const existing = this.getCode(codeData.code);
    if (existing) {
      throw new Error('Code already exists');
    }

    const newCode: BetaCode = {
      ...codeData,
      code: codeData.code.toUpperCase(),
      currentRedemptions: 0,
      createdAt: new Date().toISOString()
    };

    this.codes.push(newCode);
    this.saveData();

    if (isSupabaseConfigured()) {
      await supabase.from('beta_codes').insert({
        code: newCode.code,
        description: newCode.description,
        max_redemptions: newCode.maxRedemptions,
        current_redemptions: newCode.currentRedemptions,
        expires_at: newCode.expiresAt,
        unlimited_search: newCode.unlimitedSearch,
        unlimited_pnr: newCode.unlimitedPnr,
        unlimited_live_tracking: newCode.unlimitedLiveTracking,
        unlimited_split_search: newCode.unlimitedSplitSearch,
        is_active: newCode.isActive
      });
    }

    return newCode;
  }

  public async disableCode(code: string): Promise<boolean> {
    const existing = this.getCode(code);
    if (!existing) return false;

    existing.isActive = false;
    this.saveData();

    if (isSupabaseConfigured()) {
      await supabase.from('beta_codes').update({ is_active: false }).eq('code', existing.code);
    }
    return true;
  }

  public isValidCode(codeStr: string): boolean {
    const code = this.getCode(codeStr);
    if (!code || !code.isActive) return false;
    if (code.expiresAt && new Date() > new Date(code.expiresAt)) return false;
    if (code.currentRedemptions >= code.maxRedemptions) return false;
    return true;
  }

  public hasRedeemedCode(userId: string, codeStr: string): boolean {
    if (!userId || !codeStr) return false;
    return this.redemptions.some(
      r => r.userId === userId && r.betaCode.toUpperCase() === codeStr.toUpperCase()
    );
  }

  /** Any non-expired beta redemption for this user (header-independent). */
  public hasActiveRedemption(userId: string): boolean {
    if (!userId) return false;
    const now = Date.now();
    return this.redemptions.some(
      (r) =>
        r.userId === userId &&
        (!r.expiresAt || new Date(r.expiresAt).getTime() > now)
    );
  }

  public hasUnlimitedAccess(codeStr: string, feature: 'search' | 'pnr' | 'live' | 'split'): boolean {
    if (!this.isValidCode(codeStr)) return false;
    const code = this.getCode(codeStr);
    if (!code) return false;

    switch (feature) {
      case 'search': return code.unlimitedSearch;
      case 'pnr': return code.unlimitedPnr;
      case 'live': return code.unlimitedLiveTracking;
      case 'split': return code.unlimitedSplitSearch;
      default: return false;
    }
  }

  public async redeemCode(userId: string, codeStr: string): Promise<boolean> {
    if (!this.isValidCode(codeStr)) return false;

    // Check if already redeemed
    const alreadyRedeemed = this.redemptions.find(r => r.userId === userId && r.betaCode.toUpperCase() === codeStr.toUpperCase());
    if (alreadyRedeemed) return true;

    const code = this.getCode(codeStr);
    if (!code) return false;

    code.currentRedemptions += 1;

    let redemptionExpiresAt = code.expiresAt;
    if (!redemptionExpiresAt || code.code.toUpperCase() === 'AZADI80') {
      const exp = new Date();
      exp.setDate(exp.getDate() + 30);
      redemptionExpiresAt = exp.toISOString();
    }

    const redemption: BetaRedemption = {
      id: crypto.randomUUID(),
      userId,
      betaCode: code.code,
      redeemedAt: new Date().toISOString(),
      expiresAt: redemptionExpiresAt
    };

    this.redemptions.push(redemption);
    this.saveData();

    if (isSupabaseConfigured()) {
      await supabase.from('beta_codes').update({ current_redemptions: code.currentRedemptions }).eq('code', code.code);
      await supabase.from('beta_redemptions').insert({
        id: redemption.id,
        user_id: redemption.userId,
        beta_code: redemption.betaCode,
        redeemed_at: redemption.redeemedAt,
        expires_at: redemption.expiresAt
      });
    }

    return true;
  }

  public async deleteRedemptionsForUser(userId: string): Promise<void> {
    this.redemptions = this.redemptions.filter(r => r.userId !== userId);
    this.saveData();
    if (isSupabaseConfigured()) {
      const { error } = await supabase.from('beta_redemptions').delete().eq('user_id', userId);
      if (error) {
        winstonLogger.warn(`[BETA_SERVICE] Failed to delete beta redemptions for user ${userId}: ${error.message}`);
      }
    }
  }
}

export const betaService = new BetaService();

