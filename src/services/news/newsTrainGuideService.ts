/**
 * News Train Guide Service — Phase 1 Programmatic SEO Generator
 *
 * Automatically generates comprehensive, authoritative, AdSense-compliant
 * railway train & route guides (e.g. 13128 Garib Rath Express, Vande Bharat, etc.)
 * using Trayago's multi-provider AI pipeline (Gemini / DeepSeek).
 *
 * Adheres to:
 * - Google E-E-A-T Quality Guidelines (Rich timetables, structured data, verified source attribution)
 * - Deterministic Internal Linking ([trainNo] -> /live/[trainNo], PNR -> /pnr, Split Journey -> /split-journey)
 * - Full Dual-Language Support (English & Hindi)
 * - Safe Database Insertion into railway_news table with instant cache invalidation
 */

import crypto from 'crypto';
import { winstonLogger } from '../../middleware/logger';
import { supabase, isSupabaseConfigured } from '../../config/supabase';
import { aiProviderResolver } from '../ai/aiProviderResolver';
import { newsAutoCuratorService } from './newsAutoCuratorService';
import { invalidateNewsCache } from '../railwayNewsService';
import { newsAdminService } from './newsAdminService';
import { irctcService } from '../irctcService';

export interface TrainGuideOptions {
  trainNo: string;
  language?: 'en' | 'hi';
  focusAngle?: string;
  autoPublish?: boolean;
  adminId?: string;
  customImageUrl?: string;
}

export interface TrainGuideResult {
  success: boolean;
  articleId?: string;
  slug?: string;
  title?: string;
  status?: string;
  language?: 'en' | 'hi';
  preview?: {
    title: string;
    summary: string;
    content: string;
    passengerAdvice: string;
    faqs: Array<{ question: string; answer: string }>;
    keyTakeaways: string[];
    imageUrl: string;
    affectedTrains: string[];
    affectedStations: string[];
  };
  error?: string;
}

export class NewsTrainGuideService {
  /**
   * Resolves relevant contextual train imagery based on train name / category.
   */
  public resolveTrainCoverImage(trainName: string, customUrl?: string): string {
    if (customUrl && typeof customUrl === 'string' && customUrl.trim().startsWith('http')) {
      return customUrl.trim();
    }

    const name = trainName.toLowerCase();
    if (name.includes('vande bharat')) {
      return 'https://images.unsplash.com/photo-1544620347-c4fd4a3d5957?auto=format&fit=crop&w=1200&q=80';
    }
    if (name.includes('garib rath')) {
      return 'https://images.unsplash.com/photo-1532105956626-9569c03602f6?auto=format&fit=crop&w=1200&q=80';
    }
    if (name.includes('rajdhani') || name.includes('tejas')) {
      return 'https://images.unsplash.com/photo-1474487548417-781cb71495f3?auto=format&fit=crop&w=1200&q=80';
    }
    if (name.includes('shatabdi') || name.includes('duronto')) {
      return 'https://images.unsplash.com/photo-1515162816999-a0c47dc192f7?auto=format&fit=crop&w=1200&q=80';
    }

    // Default premium Indian Railways aesthetic cover
    return 'https://images.unsplash.com/photo-1509749837427-ac94a2553d0e?auto=format&fit=crop&w=1200&q=80';
  }

  /**
   * Generates a clean URL slug from train number and train name/route.
   */
  public generateTrainSlug(trainNo: string, trainName: string, source?: string, dest?: string): string {
    const rawString = `${trainName} ${trainNo} ${source || ''} to ${dest || ''}`
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .slice(0, 80);

    return rawString.endsWith('-') ? rawString.slice(0, -1) : rawString;
  }

  /**
   * Fetches baseline train data from internal DB or live provider SDK.
   */
  public async fetchTrainMetadata(trainNo: string): Promise<{
    trainName: string;
    trainType: string;
    source: string;
    destination: string;
    daysOfWeek: string[];
    scheduleStations?: any[];
  }> {
    let trainName = `Express ${trainNo}`;
    let trainType = 'EXPRESS';
    let source = '';
    let destination = '';
    let daysOfWeek: string[] = [];
    let scheduleStations: any[] = [];

    // 1. Try DB train_schedules or trains lookup
    if (isSupabaseConfigured()) {
      try {
        const { data: sched } = await supabase
          .from('train_schedules')
          .select('train_name, train_type, days_of_week, total_distance')
          .eq('train_number', trainNo)
          .maybeSingle();

        if (sched && sched.train_name) {
          trainName = sched.train_name;
          trainType = sched.train_type || 'EXPRESS';
          daysOfWeek = Array.isArray(sched.days_of_week) ? sched.days_of_week : [];
        }
      } catch (err: any) {
        winstonLogger.warn(`[TRAIN_GUIDE_DB_LOOKUP] Failed: ${err.message}`);
      }

      // Check train_schedule table for halts
      try {
        const { data: stops } = await supabase
          .from('train_schedule')
          .select('*')
          .eq('train_number', trainNo)
          .order('sn', { ascending: true });

        if (stops && stops.length > 0) {
          scheduleStations = stops;
          source = stops[0]?.station_code || stops[0]?.station_name || '';
          destination = stops[stops.length - 1]?.station_code || stops[stops.length - 1]?.station_name || '';
          if (!trainName || trainName.startsWith('Express')) {
            trainName = stops[0]?.train_name || trainName;
          }
        }
      } catch {
        // Non-fatal
      }
    }

    // 2. Fallback to IRCTC / RailKit info if schedule is still empty
    if (scheduleStations.length === 0) {
      try {
        const info = await irctcService.getTrainInfo(trainNo);
        if (info) {
          const tInfo = info.trainInfo || info;
          if (tInfo.train_name) trainName = tInfo.train_name;
          if (tInfo.type || tInfo.train_type) trainType = tInfo.type || tInfo.train_type;
          if (tInfo.from_stn_code || tInfo.from_stn_name) source = tInfo.from_stn_name || tInfo.from_stn_code;
          if (tInfo.to_stn_code || tInfo.to_stn_name) destination = tInfo.to_stn_name || tInfo.to_stn_code;

          const rawRoute = info.route || info.stations || [];
          if (Array.isArray(rawRoute) && rawRoute.length > 0) {
            scheduleStations = rawRoute.map((s: any) => ({
              station_code: s.stnCode || s.station_code || '',
              station_name: s.stnName || s.station_name || '',
              arrival_time: s.arrival || s.arrival_time || '',
              departure_time: s.departure || s.departure_time || '',
              halt: s.halt || '',
              distance: s.distance || '',
              day: s.day || '1',
              platform: s.platform || '',
            }));
            if (!source && scheduleStations[0]) source = scheduleStations[0].station_name || scheduleStations[0].station_code;
            if (!destination && scheduleStations[scheduleStations.length - 1]) {
              destination = scheduleStations[scheduleStations.length - 1].station_name || scheduleStations[scheduleStations.length - 1].station_code;
            }
          }
        }
      } catch (err: any) {
        winstonLogger.warn(`[TRAIN_GUIDE_IRCTC_LOOKUP] Failed: ${err.message}`);
      }
    }

    return {
      trainName,
      trainType,
      source,
      destination,
      daysOfWeek,
      scheduleStations: scheduleStations.slice(0, 40) // Keep prompt concise
    };
  }

  /**
   * Main entrypoint: Generates a complete Train Route Guide.
   */
  public async generateTrainGuide(options: TrainGuideOptions): Promise<TrainGuideResult> {
    const rawTrainNo = String(options.trainNo || '').trim();
    if (!/^\d{5}$/.test(rawTrainNo)) {
      return { success: false, error: 'Invalid train number. Must be a 5-digit number (e.g. 13128).' };
    }

    const language = options.language === 'hi' ? 'hi' : 'en';
    const focusAngle = options.focusAngle || 'Standard Route, Timetable & Passenger Travel Guide';
    const autoPublish = Boolean(options.autoPublish);

    try {
      winstonLogger.info(`[TRAIN_GUIDE_GENERATE] Starting guide generation for Train ${rawTrainNo} (Lang: ${language})`);

      // 1. Fetch metadata
      const meta = await this.fetchTrainMetadata(rawTrainNo);
      const coverImage = this.resolveTrainCoverImage(meta.trainName, options.customImageUrl);
      const canonicalSlug = this.generateTrainSlug(rawTrainNo, meta.trainName, meta.source, meta.destination);

      // 2. Build Halts Table summary context for prompt
      let haltsContext = '';
      if (meta.scheduleStations && meta.scheduleStations.length > 0) {
        haltsContext = meta.scheduleStations
          .slice(0, 20)
          .map((s, idx) => `${idx + 1}. ${s.station_name || s.station_code || 'Stop'} (${s.station_code || ''}) Arr: ${s.arrival_time || s.arrival || 'Source'} Dep: ${s.departure_time || s.departure || 'Dest'}`)
          .join('\n');
      }

      // 3. Assemble Prompt
      const languageInstruction = language === 'hi'
        ? `IMPORTANT: Write the entire article, headlines, tables, tips, advice, and FAQs in high-quality, professional HINDI (Devanagari script). 
Ensure natural railway terms (जैसे समय सारणी, ठहराव, कोच संरचना, तत्काल बुकिंग, रिफंड नियम, स्प्लिट जर्नी विकल्प).`
        : `Write in authoritative, polished travel journalism English with clean structure, crisp tables, and practical passenger tips.`;

      const prompt = `
You are an expert Indian Railways travel journalist and technical analyst writing a comprehensive guide for Trayago.in.
Generate a complete, authoritative, and SEO-optimized guide for:
- Train Number: ${rawTrainNo}
- Train Name: ${meta.trainName}
- Train Category: ${meta.trainType}
- Operating Route: ${meta.source || 'Origin'} to ${meta.destination || 'Destination'}
- Focus Theme: ${focusAngle}
${haltsContext ? `- Verified Key Stops:\n${haltsContext}` : ''}

${languageInstruction}

STRUCTURE AND CONTENT REQUIREMENTS:
1. Title: Catchy, high-search-intent headline (e.g., "${rawTrainNo} ${meta.trainName}: Complete Route, Timetable, Fare & Travel Guide").
2. Summary: 2 concise paragraphs providing an executive overview of the train service, frequency, and suitability for commuters.
3. Content (Markdown, 500-800 words):
   - ## Overview & Train Profile (Background, speed, zonal railway, running days)
   - ## Route, Timetable & Important Station Halts (Include a clean Markdown table with columns: # | Station Name | Code | Arr | Dep | Halt | Day)
   - ## Coach Composition & Classes (Explain AC 3-Tier / 3E Economy / Sleeper / General coaches, cleanliness, charging points)
   - ## Ticket Fare Structure & Tatkal Booking Timing (Explain standard fare tiers, Tatkal quota timing at 10:00 AM AC / 11:00 AM Non-AC, ARP rules)
   - ## Food, Pantry & E-Catering Services (Onboard catering, IRCTC e-catering availability at major halts)
   - ## Passenger Advisories & Cancellation Refund Rules (100% automatic refund on cancelled trains, TDR rules for waitlist/diverted services)
   - ## Waitlist Alternatives via Trayago Split Journey (Explain how commuters can use Trayago Split Journey to find confirmed connecting berths when direct tickets are full)
4. Passenger Advice: 2 actionable sentences for commuters on booking strategies and alternative route planning.
5. Key Takeaways: Array of 4-5 key bullet takeaways.
6. FAQs: Array of 4-6 realistic passenger questions and clear answers.
7. SEO Title: Max 60 characters, keyword rich.
8. Meta Description: Max 155 characters.

Return ONLY a valid JSON object matching this exact schema:
{
  "title": "Headline string",
  "seo_title": "SEO title <= 60 chars",
  "meta_description": "Meta description <= 155 chars",
  "summary": "2 paragraph summary string",
  "content": "Full markdown content with ## subheadings and tables",
  "passenger_advice": "Actionable commuter advice string",
  "key_takeaways": [
    "Takeaway 1",
    "Takeaway 2",
    "Takeaway 3",
    "Takeaway 4"
  ],
  "faqs": [
    { "question": "Question text?", "answer": "Answer text." }
  ],
  "affected_stations": ["${meta.source || 'NDLS'}", "${meta.destination || 'HWH'}"]
}
`.trim();

      // 4. Call AI Provider Resolver
      const aiResponse = await aiProviderResolver.executeWithFallback(
        'genericPrompt',
        async (provider) => {
          return await (provider as any).executeGeminiCall(prompt, true, 20000, 'TRAIN_GUIDE_GEN');
        }
      );

      if (!aiResponse || !aiResponse.result || !aiResponse.result.title || !aiResponse.result.content) {
        throw new Error(aiResponse.error?.message || 'AI generation failed to produce valid article structure.');
      }

      const generated = aiResponse.result;

      // 5. Inject deterministic internal links (Live Status, PNR, Split Journey)
      const linkedContent = newsAutoCuratorService.injectDeterministicInternalLinks(
        generated.content,
        [rawTrainNo]
      );

      // 6. Format Final Payload
      const now = new Date().toISOString();
      const status = autoPublish ? 'PUBLISHED' : 'AI_DRAFTED';

      const payload = {
        id: crypto.randomUUID(),
        title: generated.title.trim(),
        slug: canonicalSlug,
        seo_title: (generated.seo_title || generated.title).slice(0, 60).trim(),
        meta_description: (generated.meta_description || generated.summary).slice(0, 155).trim(),
        summary: generated.summary.trim(),
        content: linkedContent,
        passenger_advice: generated.passenger_advice?.trim() || null,
        key_takeaways: Array.isArray(generated.key_takeaways) ? generated.key_takeaways : [],
        faq: Array.isArray(generated.faqs) ? generated.faqs : [],
        category: 'Train Guide',
        status,
        published_at: autoPublish ? now : null,
        updated_at: now,
        source_name: 'Indian Railways / Trayago Rail Ops',
        source_url: `https://www.trayago.in/live/${rawTrainNo}`,
        image_url: coverImage,
        affected_trains: [rawTrainNo],
        affected_stations: Array.isArray(generated.affected_stations) && generated.affected_stations.length > 0
          ? generated.affected_stations
          : [meta.source, meta.destination].filter(Boolean),
        relevance_score: 95,
        ai_confidence: 'HIGH'
      };

      // 7. Insert / Upsert into Supabase
      if (isSupabaseConfigured()) {
        const { data: inserted, error: insertError } = await supabase
          .from('railway_news')
          .insert(payload)
          .select('id, slug, title, status')
          .single();

        if (insertError) {
          winstonLogger.error(`[TRAIN_GUIDE_DB_ERROR] ${insertError.message}`);
          return { success: false, error: `Database insert failed: ${insertError.message}` };
        }

        invalidateNewsCache(inserted.slug, inserted.id);

        if (options.adminId) {
          await newsAdminService.writeAuditEntry(
            autoPublish ? 'PUBLISH' : 'EDIT',
            inserted.id,
            options.adminId,
            'DISCOVERED',
            status,
            `AI Programmatic Train Guide created for Train ${rawTrainNo} (${meta.trainName})`
          );
        }

        winstonLogger.info(`[TRAIN_GUIDE_SUCCESS] Successfully generated and saved guide: ${inserted.slug} (${status})`);

        return {
          success: true,
          articleId: inserted.id,
          slug: inserted.slug,
          title: inserted.title,
          status: inserted.status,
          language,
          preview: {
            title: payload.title,
            summary: payload.summary,
            content: payload.content,
            passengerAdvice: payload.passenger_advice || '',
            faqs: payload.faq,
            keyTakeaways: payload.key_takeaways,
            imageUrl: payload.image_url,
            affectedTrains: payload.affected_trains,
            affectedStations: payload.affected_stations
          }
        };
      } else {
        return {
          success: true,
          slug: canonicalSlug,
          title: payload.title,
          status: 'PREVIEW_ONLY_NO_DB',
          language,
          preview: {
            title: payload.title,
            summary: payload.summary,
            content: payload.content,
            passengerAdvice: payload.passenger_advice || '',
            faqs: payload.faq,
            keyTakeaways: payload.key_takeaways,
            imageUrl: payload.image_url,
            affectedTrains: payload.affected_trains,
            affectedStations: payload.affected_stations
          }
        };
      }
    } catch (err: any) {
      winstonLogger.error(`[TRAIN_GUIDE_ERROR] ${err.message}`);
      return { success: false, error: err.message || 'Train guide generation failed.' };
    }
  }
}

export const newsTrainGuideService = new NewsTrainGuideService();
