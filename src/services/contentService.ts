import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';

let supabase: ReturnType<typeof createClient> | null = null;
if (SUPABASE_URL && SUPABASE_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
}

export class ContentService {
  // -------------------------------------------------------------
  // Private Helpers for Mapping/Serialization
  // -------------------------------------------------------------

  private mapBannerFromDb(row: any) {
    if (!row) return null;
    let subheadline = '';
    let badge_text = '';
    let badge_color = 'indigo';
    
    if (row.description) {
      try {
        const parsed = JSON.parse(row.description);
        if (parsed && typeof parsed === 'object') {
          subheadline = parsed.subheadline || '';
          badge_text = parsed.badge_text || '';
          badge_color = parsed.badge_color || 'indigo';
        } else {
          subheadline = row.description;
        }
      } catch {
        subheadline = row.description;
      }
    }

    return {
      id: row.id,
      type: row.banner_type || 'announcement',
      headline: row.title || '',
      subheadline,
      badge_text,
      badge_color,
      cta_text: row.cta_text,
      cta_link: row.cta_link,
      status: row.status,
      priority: row.priority || 0,
      created_at: row.created_at,
      updated_at: row.updated_at
    };
  }

  private mapCampaignFromDb(row: any) {
    if (!row) return null;
    let description = '';
    let cta_link = '';
    
    if (row.description) {
      try {
        const parsed = JSON.parse(row.description);
        if (parsed && typeof parsed === 'object') {
          description = parsed.description || '';
          cta_link = parsed.cta_link || '';
        } else {
          description = row.description;
        }
      } catch {
        description = row.description;
      }
    }

    return {
      id: row.id,
      module_type: row.module_type,
      title: row.title,
      description,
      cta_text: row.cta_text,
      cta_link,
      status: row.status,
      priority: row.priority || 0,
      created_at: row.created_at,
      updated_at: row.updated_at
    };
  }

  private mapReferralOfferFromDb(row: any) {
    if (!row) return null;
    return {
      id: row.id,
      required_invites: row.required_invites,
      reward_days: row.reward_days,
      reward_type: row.status || 'PRO_ACCESS',
      is_active: row.is_active,
      created_at: row.created_at,
      updated_at: row.updated_at
    };
  }

  // -------------------------------------------------------------
  // Public Read Endpoints
  // -------------------------------------------------------------

  public async getActiveBanners() {
    if (!supabase) return [];
    const { data, error } = await supabase
      .from('admin_banners')
      .select('*')
      .eq('status', 'active')
      .order('priority', { ascending: false });
    if (error) throw new Error(error.message);
    return (data || []).map((row: any) => this.mapBannerFromDb(row)).filter(Boolean);
  }

  public async getActiveCampaigns() {
    if (!supabase) return [];
    const { data, error } = await supabase
      .from('admin_campaigns')
      .select('*')
      .neq('status', 'disabled')
      .order('priority', { ascending: false });
    if (error) throw new Error(error.message);
    return (data || []).map((row: any) => this.mapCampaignFromDb(row)).filter(Boolean);
  }

  public async getActiveReferralOffers() {
    if (!supabase) return [];
    const { data, error } = await supabase
      .from('admin_referral_offers')
      .select('*')
      .eq('is_active', true);
    if (error) throw new Error(error.message);
    return (data || []).map((row: any) => this.mapReferralOfferFromDb(row)).filter(Boolean);
  }

  // -------------------------------------------------------------
  // Admin Endpoints
  // -------------------------------------------------------------

  // Banners
  public async getBanners() {
    if (!supabase) return [];
    const { data, error } = await supabase.from('admin_banners').select('*').order('created_at', { ascending: false });
    if (error) throw new Error(error.message);
    return (data || []).map((row: any) => this.mapBannerFromDb(row)).filter(Boolean);
  }

  public async createBanner(payload: any) {
    if (!supabase) throw new Error("Supabase not configured");
    
    const dbPayload: any = {
      banner_type: payload.type || 'announcement',
      title: payload.headline || '',
      cta_text: payload.cta_text || null,
      cta_link: payload.cta_link || null,
      status: payload.status || 'draft',
      priority: payload.priority || 0,
      description: JSON.stringify({
        subheadline: payload.subheadline || '',
        badge_text: payload.badge_text || '',
        badge_color: payload.badge_color || 'indigo'
      })
    };

    const { data, error } = await (supabase.from('admin_banners') as any).insert(dbPayload).select().single();
    if (error) throw new Error(error.message);
    return this.mapBannerFromDb(data);
  }

  public async updateBanner(id: string, payload: any) {
    if (!supabase) throw new Error("Supabase not configured");
    
    const dbPayload: any = {};
    if (payload.type !== undefined) dbPayload.banner_type = payload.type;
    if (payload.headline !== undefined) dbPayload.title = payload.headline;
    if (payload.cta_text !== undefined) dbPayload.cta_text = payload.cta_text;
    if (payload.cta_link !== undefined) dbPayload.cta_link = payload.cta_link;
    if (payload.status !== undefined) dbPayload.status = payload.status;
    if (payload.priority !== undefined) dbPayload.priority = payload.priority;
    
    if (payload.subheadline !== undefined || payload.badge_text !== undefined || payload.badge_color !== undefined) {
      const { data: existing, error: fetchErr } = await (supabase.from('admin_banners') as any).select('description').eq('id', id).single();
      let currentDesc: any = {};
      if (!fetchErr && existing && (existing as any).description) {
        try {
          const parsed = JSON.parse((existing as any).description);
          if (parsed && typeof parsed === 'object') {
            currentDesc = parsed;
          } else {
            currentDesc = { subheadline: (existing as any).description };
          }
        } catch {
          currentDesc = { subheadline: (existing as any).description };
        }
      }
      
      dbPayload.description = JSON.stringify({
        subheadline: payload.subheadline !== undefined ? payload.subheadline : (currentDesc.subheadline || ''),
        badge_text: payload.badge_text !== undefined ? payload.badge_text : (currentDesc.badge_text || ''),
        badge_color: payload.badge_color !== undefined ? payload.badge_color : (currentDesc.badge_color || 'indigo')
      });
    }

    dbPayload.updated_at = new Date().toISOString();
    const { data, error } = await (supabase.from('admin_banners') as any).update(dbPayload).eq('id', id).select().single();
    if (error) throw new Error(error.message);
    return this.mapBannerFromDb(data);
  }

  public async deleteBanner(id: string) {
    if (!supabase) throw new Error("Supabase not configured");
    const { error } = await supabase.from('admin_banners').delete().eq('id', id);
    if (error) throw new Error(error.message);
    return true;
  }

  // Campaigns
  public async getCampaigns() {
    if (!supabase) return [];
    const { data, error } = await supabase.from('admin_campaigns').select('*').order('created_at', { ascending: false });
    if (error) throw new Error(error.message);
    return (data || []).map((row: any) => this.mapCampaignFromDb(row)).filter(Boolean);
  }

  public async createCampaign(payload: any) {
    if (!supabase) throw new Error("Supabase not configured");
    
    const dbPayload: any = {
      module_type: payload.module_type || '',
      title: payload.title || '',
      cta_text: payload.cta_text || null,
      status: payload.status || 'coming_soon',
      priority: payload.priority || 0,
      description: JSON.stringify({
        description: payload.description || '',
        cta_link: payload.cta_link || ''
      })
    };

    const { data, error } = await (supabase.from('admin_campaigns') as any).insert(dbPayload).select().single();
    if (error) throw new Error(error.message);
    return this.mapCampaignFromDb(data);
  }

  public async updateCampaign(id: string, payload: any) {
    if (!supabase) throw new Error("Supabase not configured");
    
    const dbPayload: any = {};
    if (payload.module_type !== undefined) dbPayload.module_type = payload.module_type;
    if (payload.title !== undefined) dbPayload.title = payload.title;
    if (payload.cta_text !== undefined) dbPayload.cta_text = payload.cta_text;
    if (payload.status !== undefined) dbPayload.status = payload.status;
    if (payload.priority !== undefined) dbPayload.priority = payload.priority;
    
    if (payload.description !== undefined || payload.cta_link !== undefined) {
      const { data: existing, error: fetchErr } = await (supabase.from('admin_campaigns') as any).select('description').eq('id', id).single();
      let currentDesc: any = {};
      if (!fetchErr && existing && (existing as any).description) {
        try {
          const parsed = JSON.parse((existing as any).description);
          if (parsed && typeof parsed === 'object') {
            currentDesc = parsed;
          } else {
            currentDesc = { description: (existing as any).description };
          }
        } catch {
          currentDesc = { description: (existing as any).description };
        }
      }
      
      dbPayload.description = JSON.stringify({
        description: payload.description !== undefined ? payload.description : (currentDesc.description || ''),
        cta_link: payload.cta_link !== undefined ? payload.cta_link : (currentDesc.cta_link || '')
      });
    }

    dbPayload.updated_at = new Date().toISOString();
    const { data, error } = await (supabase.from('admin_campaigns') as any).update(dbPayload).eq('id', id).select().single();
    if (error) throw new Error(error.message);
    return this.mapCampaignFromDb(data);
  }

  public async deleteCampaign(id: string) {
    if (!supabase) throw new Error("Supabase not configured");
    const { error } = await supabase.from('admin_campaigns').delete().eq('id', id);
    if (error) throw new Error(error.message);
    return true;
  }

  // Referral Offers
  public async getReferralOffers() {
    if (!supabase) return [];
    const { data, error } = await supabase.from('admin_referral_offers').select('*').order('created_at', { ascending: false });
    if (error) throw new Error(error.message);
    return (data || []).map((row: any) => this.mapReferralOfferFromDb(row)).filter(Boolean);
  }

  public async createReferralOffer(payload: any) {
    if (!supabase) throw new Error("Supabase not configured");
    
    const dbPayload: any = {
      required_invites: payload.required_invites,
      reward_days: payload.reward_days,
      status: payload.reward_type || 'PRO_ACCESS',
      is_active: payload.is_active || false
    };

    if (payload.is_active) {
      await (supabase.from('admin_referral_offers') as any).update({ is_active: false }).neq('id', '00000000-0000-0000-0000-000000000000');
    }
    
    const { data, error } = await (supabase.from('admin_referral_offers') as any).insert(dbPayload).select().single();
    if (error) throw new Error(error.message);
    return this.mapReferralOfferFromDb(data);
  }

  public async updateReferralOffer(id: string, payload: any) {
    if (!supabase) throw new Error("Supabase not configured");
    
    const dbPayload: any = {};
    if (payload.required_invites !== undefined) dbPayload.required_invites = payload.required_invites;
    if (payload.reward_days !== undefined) dbPayload.reward_days = payload.reward_days;
    if (payload.reward_type !== undefined) dbPayload.status = payload.reward_type;
    if (payload.is_active !== undefined) dbPayload.is_active = payload.is_active;
    
    dbPayload.updated_at = new Date().toISOString();
    
    if (payload.is_active) {
      await (supabase.from('admin_referral_offers') as any).update({ is_active: false }).neq('id', id);
    }
    
    const { data, error } = await (supabase.from('admin_referral_offers') as any).update(dbPayload).eq('id', id).select().single();
    if (error) throw new Error(error.message);
    return this.mapReferralOfferFromDb(data);
  }

  public async deleteReferralOffer(id: string) {
    if (!supabase) throw new Error("Supabase not configured");
    const { error } = await supabase.from('admin_referral_offers').delete().eq('id', id);
    if (error) throw new Error(error.message);
    return true;
  }
}

export const contentService = new ContentService();
