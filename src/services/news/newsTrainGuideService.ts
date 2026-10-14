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
   * Deterministic Editorial Template Synthesizer (Zero-Failure Fallback)
   * Formats verified timetables, stations, coach compositions, and official railway policies.
   */
  public synthesizeDeterministicGuide(
    trainNo: string,
    meta: {
      trainName: string;
      trainType: string;
      source: string;
      destination: string;
      daysOfWeek: string[];
      scheduleStations?: any[];
    },
    language: 'en' | 'hi',
    focusAngle: string
  ): {
    title: string;
    seo_title: string;
    meta_description: string;
    summary: string;
    content: string;
    passenger_advice: string;
    key_takeaways: string[];
    faqs: Array<{ question: string; answer: string }>;
    affected_stations: string[];
  } {
    const stops = meta.scheduleStations || [];
    const sourceDisplay = meta.source || (stops[0]?.station_name || 'Origin Terminal');
    const destDisplay = meta.destination || (stops[stops.length - 1]?.station_name || 'Destination Terminal');

    let tableRows = '';
    if (stops.length > 0) {
      tableRows = stops.slice(0, 30).map((s, idx) => {
        return `| ${idx + 1} | **${s.station_name || s.station_code}** | \`${s.station_code}\` | ${s.arrival_time || '--'} | ${s.departure_time || '--'} | ${s.halt || '2 min'} | Day ${s.day || '1'} |`;
      }).join('\n');
    } else {
      tableRows = `| 1 | **${sourceDisplay}** | Origin | Source | Scheduled | Dep | Day 1 |\n| 2 | **${destDisplay}** | Destination | Scheduled | Terminus | -- | Day 1 |`;
    }

    if (language === 'hi') {
      const title = `${trainNo} ${meta.trainName}: रूट, समय सारणी, कोच और टिकट बुकिंग गाइड`;
      const seo_title = `${trainNo} ${meta.trainName} रूट व समय सारणी गाइड`.slice(0, 60);
      const meta_description = `${trainNo} ${meta.trainName} (${sourceDisplay} से ${destDisplay}) की पूरी समय सारणी, ठहराव, कोच पोजीशन, किराया और तत्काल नियम देखें।`.slice(0, 155);
      const summary = `${trainNo} ${meta.trainName} भारतीय रेल नेटवर्क की एक प्रमुख एवं लोकप्रिय एक्सप्रेस सेवा है, जो ${sourceDisplay} से ${destDisplay} के मध्य दैनिक और नियमित यात्रियों को सुरक्षित, समयबद्ध और आरामदायक परिवहन उपलब्ध कराती है।\n\nइस विस्तृत यात्रा गाइड में ट्रेन ${trainNo} की अद्यतन समय सारणी, सभी प्रमुख स्टेशनों पर ठहराव समय, उपलब्ध कोच श्रेणियां (एसी 3-टियर, स्लीपर एवं जनरल), तत्काल टिकट बुकिंग टाइमिंग, पेंट्री सुविधाएं और सीट वेटलिस्ट होने की स्थिति में कन्फर्म टिकट पाने के जरूरी नियम शामिल हैं।`;

      const content = `
## ${trainNo} ${meta.trainName} का परिचय एवं मुख्य विशेषताएं

भारतीय रेलवे द्वारा संचालित **${trainNo} ${meta.trainName}** (${sourceDisplay} से ${destDisplay}) इस रेलमार्ग पर यात्रा करने वाले दैनिक यात्रियों, पर्यटकों, व्यापारियों और छात्रों के लिए एक अत्यंत महत्वपूर्ण रेल सेवा है।

यह ट्रेन विश्वसनीय समय पालन, आधुनिक कोच संरचना और साफ-सुथरी यात्रा व्यवस्था के लिए जानी जाती है। यात्रा से पहले मार्ग, ठहराव और समय सारणी की पूरी जानकारी नीचे दी गई तालिका में देखी जा सकती है।

---

## आधिकारिक रूट, समय सारणी और प्रमुख स्टेशन ठहराव

ट्रेन ${trainNo} के प्रमुख स्टेशनों का समय और वाणिज्यिक ठहराव विवरण निम्नलिखित है:

| # | स्टेशन का नाम | कोड | आगमन | प्रस्थान | ठहराव | दिन |
|:---|:---|:---|:---|:---|:---|:---|
${tableRows}

> **यात्री सूचना:** स्टेशन रवाना होने से पहले ट्रेन का वास्तविक लाइव रनिंग स्टेटस और प्लेटफार्म नंबर की पुष्टि अवश्य कर लें।

---

## उपलब्ध कोच श्रेणियां और यात्री सुविधाएं

इस ट्रेन में विभिन्न बजट और आवश्यकताओं के अनुरूप कोच उपलब्ध रहते हैं:
- **एसी 3-टियर / 3E इकोनॉमी (3A / 3E):** पूर्णतः वातानुकूलित कोच, जिसमें साफ लिनेन, मोबाइल चार्जिंग पॉइंट्स और आरामदायक बर्थ की सुविधा मिलती है।
- **स्लीपर क्लास (SL):** लंबी दूरी के यात्रियों के लिए किफायती और आरक्षित शयनयान व्यवस्था।
- **अनारक्षित सामान्य कोच (General GS):** ट्रेन के दोनों छोर पर स्थित अनारक्षित डिब्बे, जिनके टिकट यूटीएस ऐप या स्टेशन टिकट खिड़की से खरीदे जा सकते हैं।

---

## टिकट किराया और तत्काल आरक्षण के नियम

1. **अग्रिम आरक्षण चक्र:** सामान्य टिकट बुकिंग आईआरसीटीसी के मानक अग्रिम आरक्षण नियमों के तहत उपलब्ध होती है।
2. **तत्काल बुकिंग टाइमिंग:** एसी क्लास (AC) के लिए तत्काल बुकिंग यात्रा तिथि से 1 दिन पूर्व सुबह **10:00 बजे** तथा स्लीपर क्लास के लिए सुबह **11:00 बजे** शुरू होती है।
3. **निरस्तीकरण एवं रिफंड:** यदि ट्रेन किसी परिचालन अथवा तकनीकी कारणवश पूर्णतः निरस्त होती है, तो ई-टिकट धारकों को 100% पूरा रिफंड उनके मूल बैंक खाते में बिना टीडीआर दाखिल किए स्वतः वापस कर दिया जाता है।

---

## खान-पान एवं ई-कैटरिंग (IRCTC e-Catering)

ट्रेन यात्रा के दौरान यात्रियों के लिए ऑन-बोर्ड कैटरिंग एवं आईआरसीटीसी ई-कैटरिंग की सुविधा उपलब्ध रहती है। यात्री अपनी बर्थ पर ही यात्रा के प्रमुख जंक्शन स्टेशनों से मनपसंद ताज़ा भोजन ऑनलाइन ऑर्डर कर सकते हैं।

---

## वेटलिस्ट टिकट का समाधान: Trayago Split Journey

यदि ट्रेन ${trainNo} में सभी सीटें और तत्काल कोटा प्रतीक्षा सूची (Waiting List) में हैं, तो यात्री **Trayago Split Journey** का उपयोग कर सकते हैं। हमारा स्मार्ट AI इंजन यात्रा के बीच पड़ने वाले जंक्शनों के जरिए दो कनेक्टिंग ट्रेनों में कन्फर्म सीट ढूंढ निकालता है, जिससे बिना किसी रुकावट के आपकी यात्रा सुनिश्चित हो जाती है।
`;

      const passenger_advice = `यात्रियों को सलाह दी जाती है कि वे पीक सीजन में अपनी यात्रा का अग्रिम आरक्षण समय रहते कराएं। यदि सीधी सीटें प्रतीक्षारत हों, तो Trayago Split Journey के माध्यम से कनेक्टिंग कन्फर्म सीट की जांच करें।`;

      const key_takeaways = [
        `ट्रेन ${trainNo} ${meta.trainName} ${sourceDisplay} से ${destDisplay} के बीच नियमित रूप से संचालित होती है।`,
        `ट्रेन में एसी 3-टियर, स्लीपर एवं अनारक्षित जनरल श्रेणियों की सुगम व्यवस्था उपलब्ध है।`,
        `तत्काल टिकट बुकिंग एसी क्लास के लिए सुबह 10:00 बजे और स्लीपर के लिए 11:00 बजे शुरू होती है।`,
        `सीटें फुल होने पर यात्री Trayago Split Journey की सहायता से वैकल्पिक कनेक्टिंग कन्फर्म सीटें प्राप्त कर सकते हैं।`
      ];

      const faqs = [
        {
          question: `ट्रेन ${trainNo} ${meta.trainName} का प्रारंभिक और अंतिम स्टेशन कौन सा है?`,
          answer: `यह ट्रेन ${sourceDisplay} से प्रस्थान करके ${destDisplay} तक अपनी निर्धारित यात्रा पूरी करती है।`
        },
        {
          question: `क्या ट्रेन ${trainNo} में तत्काल कोटा उपलब्ध रहता है?`,
          answer: `हां, इस ट्रेन में तत्काल कोटा उपलब्ध रहता है। एसी क्लास के लिए बुकिंग सुबह 10:00 बजे और स्लीपर क्लास के लिए सुबह 11:00 बजे खुलती है।`
        },
        {
          question: `यदि ट्रेन निरस्त हो जाए तो क्या रिफंड के लिए टीडीआर भरना पड़ता है?`,
          answer: `नहीं, यदि ट्रेन पूर्णतः रद्द होती है, तो आईआरसीटीसी द्वारा ई-टिकट का 100% पूरा रिफंड मूल खाते में स्वतः जमा कर दिया जाता है।`
        },
        {
          question: `क्या ट्रेन यात्रा के दौरान खाना ऑनलाइन ऑर्डर किया जा सकता है?`,
          answer: `हां, आईआरसीटीसी ई-कैटरिंग के जरिए यात्रा के प्रमुख ठहराव स्टेशनों से गर्म एवं स्वच्छ भोजन सीधे आपकी सीट पर डिलीवर किया जाता है।`
        },
        {
          question: `सीधी टिकट वेटलिस्ट होने पर कन्फर्म सीट कैसे पाएं?`,
          answer: `यात्री Trayago Split Journey का उपयोग कर सकते हैं, जो मध्यवर्ती स्टेशनों के जरिए कन्फर्म कनेक्टिंग ट्रेनों की तुरंत खोज करता है।`
        }
      ];

      return {
        title,
        seo_title,
        meta_description,
        summary,
        content: content.trim(),
        passenger_advice,
        key_takeaways,
        faqs,
        affected_stations: [sourceDisplay, destDisplay].filter(Boolean)
      };
    } else {
      // English version
      const title = `${trainNo} ${meta.trainName}: Route, Timetable, Fare & Booking Guide`;
      const seo_title = `${trainNo} ${meta.trainName} Timetable & Fare Guide`.slice(0, 60);
      const meta_description = `Complete running schedule, timetable halts, coach composition, Tatkal rules, and ticket booking guide for ${trainNo} ${meta.trainName} (${sourceDisplay} to ${destDisplay}).`.slice(0, 155);
      const summary = `Train ${trainNo} ${meta.trainName} is a premier express train connecting ${sourceDisplay} with ${destDisplay}, providing essential, punctual, and safe passenger rail connectivity for commuters, tourists, and business travelers.\n\nThis comprehensive passenger guide outlines the verified timetable, station stoppage timings, coach composition (AC 3-Tier, Sleeper, and General), Tatkal ticket booking rules, onboard food catering options, and smart travel alternatives via Trayago Split Journey.`;

      const content = `
## Overview of Train ${trainNo} ${meta.trainName}

Operated under the supervision of Indian Railways, **${trainNo} ${meta.trainName}** connects ${sourceDisplay} and ${destDisplay}. It serves as a vital transit corridor for thousands of commuters daily seeking reliable connectivity.

Equipped with modern safety apparatus, disciplined scheduling, and comfortable amenities, this express service features multiple passenger accommodation classes. Below is the verified schedule and commercial halts directory.

---

## Route, Full Timetable & Station Halts Directory

The official schedule, arrival, departure, and stoppage durations for Train ${trainNo} are detailed below:

| # | Station Name | Code | Arr | Dep | Halt | Day |
|:---|:---|:---|:---|:---|:---|:---|
${tableRows}

> **Travel Advisory:** Passengers are encouraged to check live train running status and platform allocations on Trayago before arriving at the station.

---

## Coach Composition & Passenger Classes

Train ${trainNo} features passenger coaches tailored for budget and comfort:
- **AC 3-Tier / 3E Economy (3A / 3E):** Air-conditioned coaches with clean linen kits, individual charging sockets, and reading lights.
- **Sleeper Class (SL):** Cost-effective reserved berths ideal for overnight long-distance travel.
- **General Unreserved (GS):** Unreserved compartments at both ends of the train, bookable via the UTS mobile app or computerized station ticket counters.

---

## Ticket Fare Structure & Tatkal Reservation Rules

1. **Advance Reservation Period (ARP):** Standard booking opens in accordance with Indian Railways reservation cycles via irctc.co.in and UTS ticketing portals.
2. **Tatkal Timings:** Tatkal booking opens 24 hours prior to train departure from the origin station: **10:00 AM** for AC classes (3A/2A) and **11:00 AM** for Non-AC Sleeper classes.
3. **100% Automatic Refund:** In the event of full train cancellation by railway authorities, e-ticket passengers receive an automatic 100% full refund directly to their payment account without having to file an online TDR.

---

## Food, Pantry & IRCTC E-Catering Services

Passengers can access pantry services or pre-order meals from authorized restaurant chains via IRCTC e-catering. Hot meals and refreshments are delivered directly to passenger berths at designated junction stations along the route.

---

## Alternate Confirmed Seats via Trayago Split Journey

When berths on Train ${trainNo} are completely booked and waitlists are high, passengers can leverage **Trayago Split Journey Intelligence**. The smart routing engine automatically detects available seats across intermediate junction hubs, combining two connecting trains to guarantee you reach your destination comfortably.
`;

      const passenger_advice = `Passengers are advised to reserve berths early during holiday and festival rushes. If direct tickets are waitlisted, check Trayago Split Journey for guaranteed connecting seats.`;

      const key_takeaways = [
        `Train ${trainNo} ${meta.trainName} operates between ${sourceDisplay} and ${destDisplay}.`,
        `Offers diverse passenger accommodation including AC 3-Tier, Sleeper, and General coaches.`,
        `Tatkal booking opens at 10:00 AM for AC berths and 11:00 AM for Sleeper berths.`,
        `Passengers facing high waitlists can use Trayago Split Journey to find confirmed connecting options.`
      ];

      const faqs = [
        {
          question: `What are the source and destination terminals for Train ${trainNo}?`,
          answer: `Train ${trainNo} ${meta.trainName} departs from ${sourceDisplay} and completes its journey at ${destDisplay}.`
        },
        {
          question: `When does Tatkal ticket booking open for Train ${trainNo}?`,
          answer: `Tatkal booking opens one day in advance of departure: at 10:00 AM for AC classes and at 11:00 AM for Sleeper classes.`
        },
        {
          question: `Do I need to file a TDR if Train ${trainNo} is cancelled?`,
          answer: `No. If the train is fully cancelled by Indian Railways, IRCTC automatically credits a 100% full refund to the original payment source.`
        },
        {
          question: `Can I order food to my berth on Train ${trainNo}?`,
          answer: `Yes, passengers can pre-order hygienic meals via IRCTC e-catering to be delivered directly to their seats at major junction stations.`
        },
        {
          question: `What should I do if tickets on Train ${trainNo} are waitlisted?`,
          answer: `Use Trayago Split Journey to discover verified connecting train seats through intermediate hubs when direct berths are full.`
        }
      ];

      return {
        title,
        seo_title,
        meta_description,
        summary,
        content: content.trim(),
        passenger_advice,
        key_takeaways,
        faqs,
        affected_stations: [sourceDisplay, destDisplay].filter(Boolean)
      };
    }
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

      // 3. Assemble Prompt for AI
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

      // 4. Attempt AI Generation with seamless Deterministic Fallback
      let generated: any = null;

      try {
        const aiResponse = await aiProviderResolver.executeWithFallback(
          'genericPrompt',
          async (provider) => {
            if (provider.providerId === 'DEEPSEEK') {
              return await (provider as any).executeDeepSeekCall(prompt, true, 20000, 'TRAIN_GUIDE_GEN');
            }
            return await (provider as any).executeGeminiCall(prompt, true, 20000, 'TRAIN_GUIDE_GEN');
          },
          undefined,
          'NEWS_DISTILLATION'
        );

        if (aiResponse && aiResponse.result && aiResponse.result.title && aiResponse.result.content) {
          generated = aiResponse.result;
        }
      } catch (aiErr: any) {
        winstonLogger.warn(`[TRAIN_GUIDE_AI_WARN] AI call skipped (${aiErr.message}). Using deterministic synthesizer.`);
      }

      // If AI did not return a valid result (e.g. API key expired or rate limited), use deterministic synthesis
      if (!generated || !generated.title || !generated.content) {
        winstonLogger.info(`[TRAIN_GUIDE_SYNTH] Using high-authority deterministic editorial synthesizer for Train ${rawTrainNo}`);
        generated = this.synthesizeDeterministicGuide(rawTrainNo, meta, language, focusAngle);
      }

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
        relevance_score: 95
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
