/**
 * News Train Guide Service — Phase 1 Programmatic SEO Generator
 *
 * Automatically generates comprehensive, authoritative, AdSense-compliant
 * railway train & route guides (e.g. 22221 Rajdhani, 13128 Garib Rath, Vande Bharat, etc.)
 * using Trayago's multi-provider AI pipeline with an expert deterministic fallback engine.
 *
 * Adheres to:
 * - Google E-E-A-T Quality Guidelines (Rich timetables, structured data, verified factual attribution)
 * - Factual Train Profiling (Accurate coach classes — no Sleeper/General on Rajdhani/Vande Bharat)
 * - Real Corridor Knowledge (Push-pull WAP-7 Ghat heritage, local station delicacies, pilgrimage sights)
 * - Dynamic Topic Filtering (History only, Timetable only, Food only, or Complete 360° Mega-Guide)
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
import { newsInternetSearchService, LiveInternetData } from './newsInternetSearchService';

export interface TrainGuideOptions {
  trainNo: string;
  language?: 'en' | 'hi';
  focusAngle?: string;
  focusTopics?: string[];
  customKeywords?: string;
  enableWebSearch?: boolean;
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

export interface TrainTypeProfile {
  category: 'RAJDHANI' | 'VANDE_BHARAT' | 'SHATABDI' | 'GARIB_RATH' | 'TEJAS' | 'DURONTO' | 'HUMSAFAR' | 'EXPRESS';
  categoryLabelEn: string;
  categoryLabelHi: string;
  isAllAc: boolean;
  hasSleeper: boolean;
  hasGeneral: boolean;
  locoEn: string;
  locoHi: string;
  coachesEn: string[];
  coachesHi: string[];
  cateringEn: string;
  cateringHi: string;
  fareEn: string;
  fareHi: string;
  historyEn: string;
  historyHi: string;
  factsEn: string[];
  factsHi: string[];
}

export const STATION_KNOWLEDGE: Record<string, {
  name: string;
  sightEn: string;
  sightHi: string;
  foodEn: string;
  foodHi: string;
}> = {
  CSMT: {
    name: 'Mumbai CSMT',
    sightEn: 'Chhatrapati Shivaji Maharaj Terminus (UNESCO World Heritage Site), Marine Drive & Gateway of India',
    sightHi: 'छत्रपति शिवाजी महाराज टर्मिनस (यूनेस्को विश्व धरोहर), मरीन ड्राइव और गेटवे ऑफ इंडिया',
    foodEn: 'Authentic Mumbai Vada Pav, Pav Bhaji & Bun Maska',
    foodHi: 'मुंबई का प्रसिद्ध वड़ा पाव, पाव भाजी और बन मस्का'
  },
  KYN: {
    name: 'Kalyan',
    sightEn: 'Historic railway junction and gateway to Western Ghats & Haji Malang Hills',
    sightHi: 'मध्य रेल का ऐतिहासिक जंक्शन, पश्चिमी घाट और हाजी मलंग की पहाड़ियां',
    foodEn: 'Local Batata Vada & cutting chai',
    foodHi: 'कल्याण का बटाटा वड़ा और कड़क चाय'
  },
  KSRA: {
    name: 'Kasara',
    sightEn: 'Foot of the legendary Thull Ghat (Western Ghats) with cascading seasonal waterfalls',
    sightHi: 'थुल घाट (पश्चिमी घाट) की तलहटी, धुंध भरी हरी-भरी वादियां और झरने',
    foodEn: 'Hot Masala Chai & Poha',
    foodHi: 'गरमा-गरम मसाला चाय और पोहा'
  },
  IGP: {
    name: 'Igatpuri',
    sightEn: 'Scenic hill retreat, Bhavali Dam, and the global Vipassana Meditation Centre',
    sightHi: 'सुंदर हिल स्टेशन, भवाली डैम और अंतरराष्ट्रीय विपश्यना केंद्र',
    foodEn: 'Sweet Idli & fresh Ghat snacks',
    foodHi: 'ताजा इडली और स्थानीय घाट स्नैक्स'
  },
  NK: {
    name: 'Nasik Road',
    sightEn: 'Sacred Godavari riverbanks, Trimbakeshwar Jyotirlinga, Panchavati & Sula Vineyards',
    sightHi: 'पवित्र गोदावरी तट, त्र्यंबकेश्वर ज्योतिर्लिंग, पंचवटी और नासिक की अंगूर वाटिकाएं',
    foodEn: 'Famous Nasik Makhmalabad Chivda & spicy Misal Pav',
    foodHi: 'विश्वप्रसिद्ध नासिक का चिवड़ा और तीखी मिसल पाव'
  },
  JL: {
    name: 'Jalgaon',
    sightEn: 'The Gold City of Maharashtra and premier gateway to the UNESCO Ajanta Caves',
    sightHi: 'महाराष्ट्र की स्वर्ण नगरी और विश्व प्रसिद्ध यूनेस्को अजंता गुफाओं का मुख्य प्रवेश द्वार',
    foodEn: 'Khandeshi Shev Bhaji & Bharit',
    foodHi: 'खानदेशी शेव भाजी और बैंगन का भरीत'
  },
  BSL: {
    name: 'Bhusaval',
    sightEn: 'Crucial Central Railway locomotive division and India\'s greatest banana transport hub',
    sightHi: 'भारतीय रेल का विशाल लोकोमोटिव मंडल और भारत की सबसे बड़ी केला मंडी',
    foodEn: 'World-famous sweet Bhusaval Bananas & Khandeshi Dal Gandhori',
    foodHi: 'विश्वप्रसिद्ध मीठे भुसावल केले और दाल गंधोरी'
  },
  BPL: {
    name: 'Bhopal',
    sightEn: 'The City of Lakes (Upper & Lower Lake), Taj-ul-Masajid, and gateway to UNESCO Sanchi Stupa',
    sightHi: 'झीलों का शहर (बड़ा तालाब), ताज-उल-मसाजिद और यूनेस्को सांची स्तूप का प्रवेश द्वार',
    foodEn: 'Traditional Bhopal Poha Jalebi, rich Biryani & Sulemani Chai',
    foodHi: 'पारंपरिक भोपाली पोहा-जलेबी, बिरयानी और सुलेमानी चाय'
  },
  VGLJ: {
    name: 'Virangana Lakshmibai (Jhansi)',
    sightEn: 'The heroic 17th-century Jhansi Fort of Rani Laxmibai and gateway to medieval Orchha on Betwa river',
    sightHi: 'वीरांगना रानी लक्ष्मीबाई का अमर झांसी किला और बेतवा नदी तट पर ओरछा का प्राचीन महल समूह',
    foodEn: 'Traditional Bundelkhandi Kalakand & Bedmi Poori',
    foodHi: 'बुंदेलखंडी कलाकंद और खस्ता बेड़मी पूरी'
  },
  GWL: {
    name: 'Gwalior',
    sightEn: 'The majestic hilltop Gwalior Fort (\'Pearl of Indian Forts\'), Scindia Jai Vilas Palace & Tansen Tomb',
    sightHi: 'भव्य ग्वालियर किला (\'भारत के किलों का मोती\'), सिंधिया जय विलास पैलेस और तानसेन की समाधि',
    foodEn: 'Authentic Morena Gajak, crispy Gwalior Kachori & Bahadura ke Ladoo',
    foodHi: 'मशहूर मुरैना गजक, खस्ता ग्वालियर कचौड़ी और बहादुरा के लड्डू'
  },
  AGC: {
    name: 'Agra Cantt',
    sightEn: 'The iconic Taj Mahal (Seven Wonders of the World), Agra Fort & UNESCO Fatehpur Sikri',
    sightHi: 'दुनिया का अजूबा ताज महल, लाल बलुआ पत्थर का आगरा किला और फतेहपुर सीकरी',
    foodEn: 'World-famous authentic Agra Petha (Paan, Angoori, Kesar) & Bedai with Aloo Sabzi',
    foodHi: 'विश्वविख्यात आगरा का पेठा (पान, अंगूरी, केसर) और हींग-मसालेदार बेड़ई-आलू'
  },
  NZM: {
    name: 'Hazrat Nizamuddin',
    sightEn: 'The sacred 14th-century Hazrat Nizamuddin Auliya Dargah, Humayun\'s Tomb & India Gate',
    sightHi: '14वीं सदी की पवित्र हजरत निजामुद्दीन औलिया दरगाह, यूनेस्को हुमायूं का मकबरा और इंडिया गेट',
    foodEn: 'Legendary Old Delhi Mughlai Kebabs, Nihari, Biryani & Shahi Tukda',
    foodHi: 'पुरानी दिल्ली के ऐतिहासिक मुगलाई कबाब, निहारी और शाही टुकड़ा'
  },
  NDLS: {
    name: 'New Delhi',
    sightEn: 'Rashtrapati Bhavan, India Gate, Connaught Place & Red Fort',
    sightHi: 'राष्ट्रपति भवन, इंडिया गेट, कनॉट प्लेस और ऐतिहासिक लाल किला',
    foodEn: 'Delhi Chole Bhature, Parathas & Street Chaat',
    foodHi: 'दिल्ली के मशहूर छोले भटूरे और चांदनी चौक के पराठे'
  },
  CNB: {
    name: 'Kanpur Central',
    sightEn: 'Ganga Barrage, Allen Forest Zoo & historical industrial heritage',
    sightHi: 'गंगा बैराज, एलन फॉरेस्ट जू और ऐतिहासिक कपड़ा व औद्योगिक विरासत',
    foodEn: 'Famous Kanpur Thaggu ke Laddu & Badam Milk',
    foodHi: 'मशहूर ठग्गू के लड्डू और कड़ाही का बादाम दूध'
  },
  PRYJ: {
    name: 'Prayagraj',
    sightEn: 'Holy Triveni Sangam (confluence of Ganga, Yamuna & mythical Saraswati) & Anand Bhavan',
    sightHi: 'पवित्र त्रिवेणी संगम (गंगा, यमुना व सरस्वती का मिलन) और ऐतिहासिक आनंद भवन',
    foodEn: 'Prayagraj Dum Aloo, Loknath ki Lassi & Gujia',
    foodHi: 'इलाहाबादी दम आलू, लोकनाथ की मलाईदार लस्सी और गुजिया'
  },
  BSB: {
    name: 'Varanasi',
    sightEn: 'Kashi Vishwanath Jyotirlinga corridor, spiritual Ganga Aarti at Dashashwamedh Ghat & Sarnath',
    sightHi: 'भव्य श्री काशी विश्वनाथ ज्योतिर्लिंग धाम, दशाश्वमेध घाट की दिव्य गंगा आरती और सारनाथ',
    foodEn: 'Banarasi Kachori Jalebi, Banarasi Paan & Malaiyo',
    foodHi: 'बनारसी कचौड़ी-जलेबी, मशहूर बनारसी मीठा पान और मखमली मलइयो'
  },
  HWH: {
    name: 'Howrah',
    sightEn: 'Historic Howrah Bridge (Rabindra Setu) over Hooghly River & Belur Math',
    sightHi: 'हुगली नदी पर ऐतिहासिक हावड़ा ब्रिज (रवींद्र सेतु) और स्वामी विवेकानंद का बेलूर मठ',
    foodEn: 'Authentic Kolkata Mishti Doi, Rosogolla & Kolkata Kathi Roll',
    foodHi: 'कोलकाता की प्रसिद्ध मिष्टी दोई, रसगुल्ला और काठी रोल'
  },
  SBC: {
    name: 'Bengaluru',
    sightEn: 'Lalbagh Botanical Garden, Bangalore Palace & Silicon Valley tech parks',
    sightHi: 'लालबाग बॉटनिकल गार्डन, बैंगलोर पैलेस और भारत की सिलिकॉन वैली',
    foodEn: 'Crispy Benne Dosa, Filter Coffee & Idli Vada',
    foodHi: 'क्रिस्पी बेन्ने डोसा, फिल्टर कॉफी और गरम इडली वड़ा'
  },
  MAS: {
    name: 'Chennai',
    sightEn: 'Marina Beach, Kapaleeshwarar Temple & Fort St. George',
    sightHi: 'मरीना बीच, प्राचीन कपालीश्वर मंदिर और फोर्ट सेंट जॉर्ज',
    foodEn: 'Traditional Chennai Sambar Vada & Degree Filter Coffee',
    foodHi: 'पारंपरिक सांभर वड़ा और मद्रास डिग्री फिल्टर कॉफी'
  },
  JP: {
    name: 'Jaipur',
    sightEn: 'Hawa Mahal, Amber Fort, City Palace & Jantar Mantar (UNESCO)',
    sightHi: 'गुलाबी नगरी का हवा महल, आमेर किला, सिटी पैलेस और जंतर मंतर',
    foodEn: 'Crispy Pyaaz Kachori, Ghevar & Dal Baati Churma',
    foodHi: 'प्रसिद्ध प्याज कचौड़ी, घेवर और राजस्थानी दाल बाटी चूरमा'
  },
  ADI: {
    name: 'Ahmedabad',
    sightEn: 'Sabarmati Ashram of Mahatma Gandhi, Sabarmati Riverfront & UNESCO Walled City',
    sightHi: 'महात्मा गांधी का साबरमती आश्रम, रिवरफ्रंट और यूनेस्को हेरिटेज सिटी',
    foodEn: 'Authentic Gujarati Fafda-Jalebi, Khaman Dhokla & Thepla',
    foodHi: 'गुजराती फाफड़ा-जलेबी, खमण ढोकला और गरमा-गरम थेपला'
  }
};

export const SAFE_RAILWAY_COVER_FALLBACK = 'https://www.trayago.in/branding/og-image.png';

export const BANNED_IMAGE_PATTERNS = [
  /photo-1544620347/i, // Bus image incorrectly mapped to Vande Bharat
  /photo-1509749837/i, // Unverified generic dark passenger car interior
];

export function truncateToWordBoundary(text: string, maxLength: number = 155): string {
  if (!text || typeof text !== 'string') return '';
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= maxLength) {
    return clean.replace(/[,;&:\-\s(]+$/, '');
  }

  const candidate = clean.slice(0, maxLength);
  if (clean[maxLength] === ' ' || candidate.endsWith(' ')) {
    return candidate.trim().replace(/[,;&:\-\s(]+$/, '');
  }

  const lastSpace = candidate.lastIndexOf(' ');
  if (lastSpace > 0) {
    return candidate.slice(0, lastSpace).trim().replace(/[,;&:\-\s(]+$/, '');
  }

  return candidate.trim().replace(/[,;&:\-\s(]+$/, '');
}

export function cleanPromptLeaks(content: string): string {
  if (!content || typeof content !== 'string') return '';
  return content
    .replace(/^>\s*\*\*Target Keywords Analyzed:\*\*.*$/gim, '')
    .replace(/^>\s*\*\*विशेष विश्लेषण विषय:\*\*.*$/gim, '')
    .replace(/Target Keywords Analyzed:?[^\n]*\n?/gi, '')
    .trim();
}

export function isSpecialService(trainNo: string, trainName: string, metaType: string): boolean {
  const num = String(trainNo || '').trim();
  const name = (trainName || '').toLowerCase();
  const type = (metaType || '').toLowerCase();

  if (num.startsWith('0')) {
    return (
      name.includes('spl') ||
      name.includes('special') ||
      type.includes('special') ||
      type.includes('spl') ||
      name.includes('festival') ||
      name.includes('holiday')
    );
  }
  return false;
}

export class NewsTrainGuideService {
  /**
   * Resolves relevant contextual train imagery based on train name / category.
   * Strips known unverified/banned images and uses the safe branding fallback.
   */
  public resolveTrainCoverImage(trainName: string, customUrl?: string): string {
    if (customUrl && typeof customUrl === 'string' && customUrl.trim().startsWith('http')) {
      const cleanCustom = customUrl.trim();
      const isBanned = BANNED_IMAGE_PATTERNS.some(pat => pat.test(cleanCustom));
      if (!isBanned) {
        return cleanCustom;
      }
    }

    // Default verified safe neutral route illustration / branding fallback
    return SAFE_RAILWAY_COVER_FALLBACK;
  }

  /**
   * Classifies a train as a possible special service based on supported metadata
   * or explicit business rules (0-prefixed train with special/spl in name or type).
   */
  public isSpecialService(trainNo: string, trainName: string, metaType: string): boolean {
    return isSpecialService(trainNo, trainName, metaType);
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
      scheduleStations: scheduleStations.slice(0, 40)
    };
  }

  /**
   * Resolves target focus topics from array or legacy string focus angle.
   */
  public resolveFocusTopics(focusAngle?: string, focusTopics?: string[]): string[] {
    const validTopics = [
      'history',
      'timetable',
      'tourism',
      'coaches',
      'fare_tatkal',
      'cancellation_refund',
      'flight_vs_train',
      'food_pantry',
      'travel_tips',
      'split_journey'
    ];

    if (Array.isArray(focusTopics) && focusTopics.length > 0) {
      const filtered = focusTopics
        .map(t => String(t).trim().toLowerCase())
        .filter(t => validTopics.includes(t));
      if (filtered.length > 0) return filtered;
    }

    if (focusAngle && typeof focusAngle === 'string') {
      const angle = focusAngle.toLowerCase();
      if (angle.includes('cancellation') || angle.includes('refund') || angle.includes('रद्द') || angle.includes('रिफंड') || angle.includes('tdr') || angle.includes('cancel')) {
        return ['cancellation_refund'];
      }
      if (angle.includes('flight') || angle.includes('plane') || angle.includes('हवाई जहाज') || angle.includes('विमान') || angle.includes('बनाम') || angle.includes('airline')) {
        return ['flight_vs_train'];
      }
      if (angle.includes('history') || angle.includes('इतिहास') || angle.includes('fact')) {
        return ['history'];
      }
      if (angle.includes('tourist') || angle.includes('दर्शनीय') || angle.includes('heritage')) {
        return ['tourism'];
      }
      if (angle.includes('tatkal') || angle.includes('fare') || angle.includes('किराया')) {
        return ['fare_tatkal'];
      }
      if (angle.includes('food') || angle.includes('pantry') || angle.includes('catering') || angle.includes('खान-पान')) {
        return ['food_pantry'];
      }
      if (angle.includes('experience') || angle.includes('cleanliness') || angle.includes('speed') || angle.includes('अनुभव')) {
        return ['travel_tips'];
      }
      if (angle.includes('timetable') || angle.includes('route') || angle.includes('समय सारणी')) {
        return ['timetable'];
      }
    }

    // Default: Complete 360° Comprehensive coverage (All 10 topics)
    return validTopics;
  }

  /**
   * Analyzes train number, name, and route to build a verified factual train profile.
   * Completely eliminates hallucinated Sleeper / General coaches on Rajdhani and Vande Bharat.
   */
  public analyzeTrainProfile(
    trainNo: string,
    trainName: string,
    metaType: string,
    stops: any[]
  ): TrainTypeProfile {
    const name = (trainName || '').toLowerCase();
    const type = (metaType || '').toLowerCase();
    const num = String(trainNo).trim();

    // 1. Dedicated verified profile for 22221 / 22222 CSMT - NZM Rajdhani
    if (num === '22221' || num === '22222' || (name.includes('rajdhani') && (name.includes('csmt') || name.includes('c shivaji')))) {
      return {
        category: 'RAJDHANI',
        categoryLabelEn: 'High-Speed All-AC Central Railway Rajdhani Express (Tejas Smart Sleeper)',
        categoryLabelHi: 'हाई-स्पीड ऑल-एसी मध्य रेलवे राजधानी एक्सप्रेस (तेजस स्मार्ट स्लीपर)',
        isAllAc: true,
        hasSleeper: false,
        hasGeneral: false,
        locoEn: 'Twin Push-Pull WAP-7 3-Phase Electric Locomotives (6,350 HP each at front and rear). Specifically deployed without banker locomotives to scale the severe 1:37 gradient of Thull Ghat (Kasara to Igatpuri), eliminating a 40-minute halt and ensuring continuous 130 km/h cruising across Central Railway.',
        locoHi: 'ट्विन पुश-पुल WAP-7 3-फेज इलेक्ट्रिक लोकोमोटिव (आगे और पीछे 6,350 हॉर्सपावर इंजन)। थुल घाट (कसारा से इगतपुरी) के 1:37 के अत्यंत तीव्र ढलान पर बिना बैंकर इंजन जोड़े सीधे चढ़ने के लिए विशेष रूप से संचालित, जिससे 40 मिनट की समय बचत होती है और 130 किमी/घंटा की गति बनी रहती है।',
        coachesEn: [
          'AC First Class (1A): Premium lockable 4-berth cabins and 2-berth coupés with personalized attendant calling system, Reading LED lights, and plush carpeting.',
          'AC 2-Tier (2A): Spacious 2-tier curtained bays with broad cushioned berths, universal laptop/mobile charging ports, and reading lights.',
          'AC 3-Tier (3A): Modern 3-tier air-conditioned sleeper accommodation with fresh sanitized linen sets, individual curtains, and bio-vacuum toilets.',
          'Tejas Smart Rake Infrastructure: Automatic sensor-activated plug doors, touchless bio-vacuum washroom taps, CCTV surveillance, and real-time GPS passenger info displays.'
        ],
        coachesHi: [
          'एसी फर्स्ट क्लास (1A): व्यक्तिगत अटेंडेंट कॉलिंग सिस्टम, एलईडी रीडिंग लैंप और आलीशान कारपेट से सुसज्जित निजी 4-बर्थ केबिन और 2-बर्थ कूपे।',
          'एसी 2-टियर (2A): चौड़ी आरामदायक कुशन बर्थ, प्राइवेसी पर्दे, व्यक्तिगत चार्जिंग पोर्ट और रीडिंग लैंप के साथ विशाल 2-टियर बे।',
          'एसी 3-टियर (3A): स्वच्छ सैनिटाइज्ड लिनेन किट, चार्जिंग सॉकेट्स और बायो-वैक्यूम टॉयलेट्स से लैस वातानुकूलित 3-टियर स्लीपर कोच।',
          'तेजस स्मार्ट रैक की आधुनिक सुविधाएं: स्वचालित प्लग डोर्स, सेंसर-युक्त बायो-वैक्यूम नल, सीसीटीवी सुरक्षा और लाइव जीपीएस पैसेंजर इन्फो स्क्रीन।'
        ],
        cateringEn: 'Comprehensive IRCTC onboard pantry service with optional/included multi-course hot catering: welcome drinks, evening high tea snacks, delicious dinner (North Indian/Continental choices), early morning bed tea, and hot breakfast prior to arrival at destination.',
        cateringHi: 'आईआरसीटीसी की व्यापक ऑन-बोर्ड पेंट्री कैटरिंग (टिकट बुकिंग के समय वैकल्पिक/शामिल): वेलकम ड्रिंक, शाम की हाई-टी स्नैक्स, स्वादिष्ट गरमा-गरम डिनर (उत्तर भारतीय व कॉन्टिनेंटल विकल्प), सुबह की बेड-टी और आगमन से पूर्व पौष्टिक नाश्ता।',
        fareEn: 'Dynamic Pricing (Flexi-Fare) applies. As ticket demand surges and seat availability drops past 50%, fares incrementally scale by 10% per 10% booking slab up to 1.5x base fare. Tatkal quota tickets are subject to premium AC Tatkal charges.',
        fareHi: 'डायनामिक प्राइसिंग (फ्लेक्सी-फेयर) प्रणाली लागू है। जैसे-जैसे 50% से अधिक सीटें बुक होती हैं, प्रत्येक 10% स्लैब पर आधार किराए में 10% की क्रमिक वृद्धि (अधिकतम 1.5 गुना) होती है। तत्काल कोटा टिकटों पर प्रीमियम एसी तत्काल प्रभार लागू होते हैं।',
        historyEn: 'Train 22221 CSMT - Hazrat Nizamuddin Rajdhani Express was inaugurated on 19 January 2019 by Central Railway as the historic 3rd Rajdhani connecting the financial capital Mumbai with national capital Delhi. It is the FIRST and only Rajdhani operated by Central Railway via Kalyan, Nashik, Jalgaon, Bhusaval, Bhopal, Jhansi, and Agra. In October 2021, the train received a prestigious upgrade to ultra-modern Tejas-type Smart Sleeper LHB coaches, featuring intelligent sensor-driven passenger amenities and automatic doors.',
        historyHi: 'ट्रेन 22221 सीएसएमटी - हजरत निजामुद्दीन राजधानी एक्सप्रेस का उद्घाटन मध्य रेलवे द्वारा 19 जनवरी 2019 को किया गया था। यह देश की आर्थिक राजधानी मुंबई को राष्ट्रीय राजधानी दिल्ली से जोड़ने वाली तीसरी राजधानी और मध्य रेलवे द्वारा संचालित पहली व एकमात्र राजधानी एक्सप्रेस है, जो कल्याण, नासिक, जलगांव, भुसावल, भोपाल, झांसी और आगरा के ऐतिहासिक मार्ग से गुजरती है। अक्टूबर 2021 में, इसे आधुनिक तेजस-टाइप स्मार्ट स्लीपर एलएचबी कोचों में अपग्रेड किया गया।',
        factsEn: [
          'First Rajdhani to negotiate the formidable 1:37 Thull Ghat (Western Ghats) using Push-Pull twin WAP-7 locomotives without attaching banker locos, cutting transit time by 40 minutes.',
          'Upgraded to Tejas Smart Sleeper LHB rake in October 2021 with airplane-like automatic doors that remain sealed while moving.',
          'Covers a massive 1,543 km distance in approximately 17 hours 55 minutes, clocking an impressive top operational speed of 130 km/h.',
          'Connects two of India’s most iconic railway terminals: UNESCO World Heritage CSMT in Mumbai and Hazrat Nizamuddin in New Delhi.',
          'Features 100% all-air-conditioned passenger accommodation with zero non-AC coaches.'
        ],
        factsHi: [
          'पुश-पुल ट्विन WAP-7 इंजन तकनीक के साथ थुल घाट के 1:37 के कठिन ढलान को बिना बैंकर इंजन लगाए पार करने वाली पहली राजधानी, जिससे 40 मिनट की बचत हुई।',
          'अक्टूबर 2021 में अत्याधुनिक तेजस स्मार्ट स्लीपर रैक से लैस, जिसमें ट्रेन चलते समय दरवाजे पूरी तरह स्वचालित रूप से बंद रहते हैं।',
          '1,543 किमी की विशाल दूरी को लगभग 17 घंटे 55 मिनट में पूरा करती है, जिसकी अधिकतम अनुमेय गति 130 किमी/घंटा है।',
          'भारत के दो सबसे प्रतिष्ठित टर्मिनलों को जोड़ती है: मुंबई का यूनेस्को धरोहर सीएसएमटी और नई दिल्ली का हजरत निजामुद्दीन।',
          'शत-प्रतिशत ऑल-एसी वातानुकूलित कोच व्यवस्था, जिसमें कोई भी स्लीपर या अनारक्षित सामान्य कोच नहीं होता।'
        ]
      };
    }

    // 2. Vande Bharat Express Profile
    if (name.includes('vande bharat') || type.includes('vande bharat')) {
      return {
        category: 'VANDE_BHARAT',
        categoryLabelEn: 'Semi-High Speed Self-Propelled Trainset EMU (160 km/h)',
        categoryLabelHi: 'सेमी-हाई स्पीड सेल्फ-प्रोपेल्ड ट्रेनसेट ईएमयू (160 किमी/घंटा)',
        isAllAc: true,
        hasSleeper: false,
        hasGeneral: false,
        locoEn: 'Self-Propelled Distributed Traction EMU (No locomotive needed). Equipped with advanced KAVACH Train Collision Avoidance System and electro-pneumatic regenerative braking for rapid acceleration up to 160 km/h.',
        locoHi: 'सेल्फ-प्रोपेल्ड डिस्ट्रीब्यूटेड ट्रैक्शन ईएमयू (अलग से इंजन की आवश्यकता नहीं)। कवच (KAVACH) स्वचालित ट्रेन सुरक्षा प्रणाली और इलेक्ट्रो-न्यूमैटिक ब्रेकिंग से लैस, जो 160 किमी/घंटा की त्वरित गति प्रदान करती है।',
        coachesEn: [
          'Executive Chair Car (EC): Ultra-premium 2x2 seating with 180-degree revolving plush chairs, personalized reading lamps, and dedicated onboard attendant service.',
          'AC Chair Car (CC): Ergonomic 3x2 seating with wide panoramic windows, foldable meal trays, footrests, and diffused anti-glare LED lighting.',
          'Safety & Amenities: Automatic sliding plug doors with retractable footstep ramps, touchless bio-vacuum washrooms, CCTV in all coaches, and sealed soundproof gangways.'
        ],
        coachesHi: [
          'एग्जीक्यूटिव चेयर कार (EC): 180-डिग्री घूमने वाली आलीशान सीटें, व्यक्तिगत रीडिंग लाइट, शानदार लेगरूम और विशेष ऑन-बोर्ड सर्विस।',
          'एसी चेयर कार (CC): 3x2 एर्गोनॉमिक आरामदायक सीटें, पैनोरमिक बड़ी खिड़कियां, फोल्डेबल स्नैक टेबल और डिफ्यूज्ड एंटी-ग्लेयर एलईडी लाइटिंग।',
          'सुरक्षा व आधुनिक सुविधाएं: स्वचालित स्लाइडिंग दरवाजे, फुटस्टेप रैंप, सेंसर-युक्त बायो-वैक्यूम टॉयलेट्स, सीसीटीवी निगरानी और सीलबंद शांत वेस्टिब्यूल।'
        ],
        cateringEn: 'Curated gourmet catering service served directly to your seat. Includes regional breakfast, lunch, or evening snacks tailored to the route timing with vegetarian and non-vegetarian options.',
        cateringHi: 'विशिष्ट रीजनल कैटरिंग सुविधा, जो सीधे आपकी सीट पर परोसी जाती है। यात्रा के समय अनुसार ताजा नाश्ता, लंच या शाम का हाई-टी भोजन (शाकाहारी व मांसाहारी विकल्प उपलब्ध)।',
        fareEn: 'Point-to-point premium express fare structure. Executive Class and Chair Car fares include catering charges by default (passengers can opt out at the time of reservation on IRCTC).',
        fareHi: 'पॉइंट-टू-पॉइंट प्रीमियम एक्सप्रेस किराया संरचना। एग्जीक्यूटिव और चेयर कार में कैटरिंग शुल्क शामिल रहता है (आईआरसीटीसी पर बुकिंग के समय इसे हटाने का विकल्प भी उपलब्ध है)।',
        historyEn: `Train ${trainNo} ${trainName} is part of Indian Railways' flagship Make in India indigenous semi-high speed train initiative designed and manufactured at Integral Coach Factory (ICF) Chennai. It represents the pinnacle of modern Indian rail technology, offering world-class comfort, rapid acceleration, and drastically reduced travel times.`,
        historyHi: `ट्रेन ${trainNo} ${trainName} भारतीय रेल की महत्वाकांक्षी 'मेक इन इंडिया' स्वदेशी सेमी-हाई स्पीड परियोजना का गौरव है, जिसका निर्माण इंटीग्रल कोच फैक्ट्री (ICF) चेन्नई में किया गया है। यह विश्वस्तरीय गति, आराम और कम यात्रा समय का प्रतीक है।`,
        factsEn: [
          'Capable of reaching a top speed of 160 km/h with 0 to 100 km/h acceleration in just 52 seconds.',
          'Fully equipped with KAVACH automatic train protection anti-collision technology.',
          'Features 180-degree rotatable passenger seats in Executive Chair Car that can face the direction of train travel.',
          'Aerodynamically contoured nose cone engineered for minimized air drag and superior energy efficiency.',
          '100% all-AC chair car accommodation with zero non-AC coaches.'
        ],
        factsHi: [
          'मात्र 52 सेकंड में 0 से 100 किमी/घंटा की गति पकड़ने में सक्षम और 160 किमी/घंटा की शीर्ष परिचालन गति।',
          'कवच (KAVACH) स्वचालित ट्रेन टक्कर सुरक्षा प्रणाली से पूरी तरह सुसज्जित।',
          'एग्जीक्यूटिव चेयर कार में 180 डिग्री घूमने वाली सीटें, जिन्हें यात्रा की दिशा में घुमाया जा सकता है।',
          'एयरोडायनामिक डिजाइन वाला नोज कोन, जो हवा के अवरोध को कम करता है और ऊर्जा की बचत करता है।',
          'शत-प्रतिशत वातानुकूलित चेयर कार संरचना, जिसमें कोई भी स्लीपर या अनारक्षित डिब्बा नहीं होता।'
        ]
      };
    }

    // 3. General Rajdhani Profile
    if (name.includes('rajdhani') || type.includes('rajdhani')) {
      return {
        category: 'RAJDHANI',
        categoryLabelEn: 'Premier High-Speed All-AC Rajdhani Express',
        categoryLabelHi: 'प्रीमियर हाई-स्पीड ऑल-एसी राजधानी एक्सप्रेस',
        isAllAc: true,
        hasSleeper: false,
        hasGeneral: false,
        locoEn: 'High-speed electric passenger locomotive operating across electrified corridors (or twin WAP-7 push-pull configuration on select high-gradient routes).',
        locoHi: 'उच्च गति इलेक्ट्रिक पैसेंजर लोकोमोटिव (अथवा विशेष घाट सेक्शनों पर पुश-पुल WAP-7 इंजन)।',
        coachesEn: [
          'AC First Class (1A): Lockable private coupés and cabins with reading lights, attendant bells, and personalized kits.',
          'AC 2-Tier (2A): Curtained 2-tier berths with charging points, wide berths, and reading lamps.',
          'AC 3-Tier (3A / 3E): Air-conditioned 3-tier sleeper berths with fresh linen sets, charging sockets, and bio-toilets.',
          'Zero Sleeper (SL) & Zero General (GS): This premium train operates exclusively with air-conditioned passenger coaches.'
        ],
        coachesHi: [
          'एसी फर्स्ट क्लास (1A): लॉक होने वाले निजी कूपे और केबिन, अटेंडेंट कॉलिंग बेल और विशेष किट।',
          'एसी 2-टियर (2A): प्राइवेसी पर्दे, व्यक्तिगत चार्जिंग पोर्ट और चौड़ी आरामदायक बर्थ।',
          'एसी 3-टियर (3A / 3E): साफ सैनिटाइज्ड लिनेन, चार्जिंग सॉकेट्स और बायो-टॉयलेट्स युक्त वातानुकूलित स्लीपर कोच।',
          'शून्य स्लीपर व शून्य जनरल कोच: यह प्रीमियम ट्रेन विशेष रूप से शत-प्रतिशत वातानुकूलित कोचों के साथ चलती है।'
        ],
        cateringEn: 'Full IRCTC pantry catering with complimentary/opt-in multi-course hot meals, snacks, beverages, and breakfast.',
        cateringHi: 'आईआरसीटीसी की ऑन-बोर्ड पेंट्री कैटरिंग, जिसमें समय अनुसार चाय, नाश्ता, लंच और गरमा-गरम डिनर शामिल रहता है।',
        fareEn: 'Dynamic flexi-fare pricing applies. Fares increase up to 1.5x based on booking demand.',
        fareHi: 'डायनामिक फ्लेक्सी-फेयर किराया प्रणाली लागू है, जो सीटों की मांग के साथ बढ़ती है।',
        historyEn: `Train ${trainNo} ${trainName} is one of Indian Railways' dedicated Rajdhani services connecting state capitals and commercial centers to the national capital.`,
        historyHi: `ट्रेन ${trainNo} ${trainName} भारतीय रेल की राजधानी सेवा है, जो प्रमुख महानगरों को राष्ट्रीय राजधानी से जोड़ती है।`,
        factsEn: [
          'Enjoys top operational track priority across all railway zones and divisions.',
          'Operating speed up to 130 km/h across fully electrified corridors.',
          '100% all-air-conditioned LHB coaches with superior suspension and safety.',
          'Offers optional catering during IRCTC e-ticketing reservation.'
        ],
        factsHi: [
          'सभी रेलवे मंडलों में सर्वोच्च परिचालन प्राथमिकता (Top Track Priority) प्राप्त।',
          'पूर्ण विद्युतीकृत मार्गों पर 130 किमी/घंटा तक की शीर्ष गति।',
          'बेहतर सस्पेंशन और एंटी-क्लाइम्बिंग सुरक्षा वाले 100% एलएचबी एसी कोच।',
          'आईआरसीटीसी ई-टिकट बुकिंग के दौरान खान-पान चयन की सुविधा।'
        ]
      };
    }

    // 4. Shatabdi Express Profile
    if (name.includes('shatabdi') || type.includes('shatabdi')) {
      return {
        category: 'SHATABDI',
        categoryLabelEn: 'Intercity High-Speed All-AC Shatabdi Express',
        categoryLabelHi: 'इंटरसिटी हाई-स्पीड ऑल-एसी शताब्दी एक्सप्रेस',
        isAllAc: true,
        hasSleeper: false,
        hasGeneral: false,
        locoEn: 'High-speed electric passenger locomotive engineered for rapid daytime intercity transit.',
        locoHi: 'दिन की तेज इंटरसिटी यात्रा के लिए संचालित हाई-स्पीड इलेक्ट्रिक लोकोमोटिव।',
        coachesEn: [
          'Executive Chair Car (EC): Spacious 2x2 air-conditioned chair car seating with priority service and enhanced legroom.',
          'AC Chair Car (CC): Comfortable 3x2 seating with foldout snack tables and reading lights.',
          'Anubhuti Class (EA in select services): Ultra-luxury seating with LCD screens and premium hospitality.'
        ],
        coachesHi: [
          'एग्जीक्यूटिव चेयर कार (EC): विशाल 2x2 आरामदायक वातानुकूलित चेयर कार सीटें और विशेष लेगरूम।',
          'एसी चेयर कार (CC): 3x2 आरामदायक कुशन सीटें, स्नैक टेबल और रीडिंग लाइट्स।',
          'अनुभूति क्लास (EA चुनिंदा ट्रेनों में): व्यक्तिगत एलसीडी स्क्रीन और आलीशान आतिथ्य।'
        ],
        cateringEn: 'Comprehensive onboard meals included or optional on booking (morning tea, breakfast, lunch, or evening snacks).',
        cateringHi: 'ऑन-बोर्ड भोजन व्यवस्था (सुबह की चाय, नाश्ता, दोपहर का भोजन या शाम का नाश्ता)।',
        fareEn: 'Premium intercity fare with optional catering charges on IRCTC booking.',
        fareHi: 'प्रीमियम अंतर-शहरी किराया संरचना।',
        historyEn: `Train ${trainNo} ${trainName} was launched as a fast daytime intercity connection ensuring commuters and business travelers can complete round trips in comfort.`,
        historyHi: `ट्रेन ${trainNo} ${trainName} तेज अंतर-शहरी दिन की एक्सप्रेस के रूप में शुरू की गई थी।`,
        factsEn: [
          'Operates as a daytime fast intercity express with same-day turnaround.',
          '100% all-air-conditioned chair car rake with zero sleeper coaches.',
          'High punctuality score and priority right-of-way over standard passenger trains.'
        ],
        factsHi: [
          'दिन की तेज अंतर-शहरी यात्रा के लिए विशेष रूप से संचालित।',
          '100% वातानुकूलित चेयर कार कोच व्यवस्था, जिसमें कोई स्लीपर डिब्बा नहीं होता।',
          'उच्च समयबद्धता और उत्कृष्ट ट्रैक प्राथमिकता।'
        ]
      };
    }

    // 5. Garib Rath Profile
    if (name.includes('garib rath') || type.includes('garib rath')) {
      return {
        category: 'GARIB_RATH',
        categoryLabelEn: 'Subsidized Affordable All-AC Garib Rath Express',
        categoryLabelHi: 'सब्सिडी-युक्त किफायती ऑल-एसी गरीब रथ एक्सप्रेस',
        isAllAc: true,
        hasSleeper: false,
        hasGeneral: false,
        locoEn: 'Standard passenger electric locomotive operating across designated long-distance routes.',
        locoHi: 'लंबी दूरी के मार्गों पर संचालित मानक पैसेंजर इलेक्ट्रिक लोकोमोटिव।',
        coachesEn: [
          'AC 3-Tier (3A): High-density 3-tier air-conditioned berths with unique side-middle berth configuration for maximum affordability.',
          'AC Chair Car (CC): Ergonomic seating on select daytime Garib Rath legs.',
          'Bedroll Policy: Linen kits and blankets available onboard on nominal request (₹25 per set).'
        ],
        coachesHi: [
          'एसी 3-टियर (3A): किफायती वातानुकूलित 3-टियर बर्थ (साइड-मिडिल बर्थ सहित)।',
          'एसी चेयर कार (CC): चुनिंदा गरीब रथ ट्रेनों में वातानुकूलित चेयर कार।',
          'बेडरोल व्यवस्था: मात्र ₹25 के नाममात्र शुल्क पर चादर व कंबल उपलब्ध।'
        ],
        cateringEn: 'Onboard snacks and tea through pantry staff; IRCTC e-catering available at intermediate major junctions.',
        cateringHi: 'पेंट्री स्टाफ द्वारा चाय व स्नैक्स; प्रमुख स्टेशनों पर आईआरसीटीसी ई-कैटरिंग उपलब्ध।',
        fareEn: 'Deeply subsidized air-conditioned fares — nearly 40-50% lower than standard 3A fares on regular superfast trains.',
        fareHi: 'सामान्य ट्रेनों के 3A किराए से 40-50% तक कम और अत्यधिक किफायती किराया।',
        historyEn: `Train ${trainNo} ${trainName} was introduced under Indian Railways' Garib Rath scheme to make air-conditioned travel accessible to common citizens.`,
        historyHi: `ट्रेन ${trainNo} ${trainName} आम नागरिकों को किफायती एसी यात्रा का लाभ देने के लिए शुरू की गई थी।`,
        factsEn: [
          'Pioneered subsidized air-conditioned travel for middle-class and budget travelers.',
          '100% fully air-conditioned coaches with no general or unreserved sleeper coaches.',
          'Runs at Superfast priority speeds of 110–130 km/h.'
        ],
        factsHi: [
          'मध्यमवर्गीय परिवारों के लिए एसी यात्रा को पहली बार सुलभ बनाया।',
          'शत-प्रतिशत वातानुकूलित कोच, जिसमें कोई अनारक्षित जनरल डिब्बा नहीं होता।',
          '110 से 130 किमी/घंटा की सुपरफास्ट गति पर संचालित।'
        ]
      };
    }

    // 6. Special Service Profile (Corroborated 0-prefixed special trains)
    const isSpecial = this.isSpecialService(trainNo, trainName, metaType);
    if (isSpecial) {
      return {
        category: 'EXPRESS',
        categoryLabelEn: 'Special Fare / Festival Passenger Service (Subject to seasonal schedule notification)',
        categoryLabelHi: 'विशेष किराया / स्पेशल ट्रेन सेवा (मौसमी व अधिसूचित परिचालन)',
        isAllAc: false,
        hasSleeper: true,
        hasGeneral: true,
        locoEn: 'Operating traction allocated by the operating railway zone according to route electrification (Electric or Diesel traction).',
        locoHi: 'संबंधित रेलवे जोन द्वारा मार्ग के विद्युतीकरण के अनुसार निर्धारित लोकोमोटिव ट्रैक्शन (इलेक्ट्रिक अथवा डीजल)।',
        coachesEn: [
          'Reserved Accommodation: AC and Sleeper accommodation as notified by the operating railway zone in official circulars.',
          'Special Fare Slabs: Special service fares or dynamic festive pricing may apply as per railway notifications.',
          'Unreserved General: General coach availability is subject to the specific rake notification for this special service.'
        ],
        coachesHi: [
          'आरक्षित डिब्बे: संबंधित रेलवे जोन द्वारा अधिसूचना के अनुसार वातानुकूलित (एसी) व स्लीपर कोच।',
          'विशेष किराया: विशेष ट्रेन परिचालन के तहत विशेष किराया अथवा सीजनल किराया संरचना लागू।',
          'सामान्य अनारक्षित डिब्बे: सामान्य कोचों की व्यवस्था इस स्पेशल सेवा की विशिष्ट रैक अधिसूचना के अधीन।'
        ],
        cateringEn: 'Catering availability varies by route; IRCTC e-catering is available at designated station halts.',
        cateringHi: 'खान-पान व्यवस्था मार्ग पर निर्भर करती है; प्रमुख स्टेशनों पर आईआरसीटीसी ई-कैटरिंग डिलीवरी उपलब्ध।',
        fareEn: 'Special train fare structure as notified by Indian Railways for seasonal or festival services.',
        fareHi: 'त्योहारों व छुट्टियों के लिए रेलवे अधिसूचना द्वारा निर्धारित विशेष ट्रेन किराया संरचना।',
        historyEn: `Train ${trainNo} ${trainName} operates as a notified special service introduced to meet seasonal passenger rush and holiday travel demand along this corridor.`,
        historyHi: `ट्रेन ${trainNo} ${trainName} त्योहारों व छुट्टियों के दौरान अतिरिक्त यात्री मांग को पूरा करने हेतु रेलवे अधिसूचना द्वारा संचालित एक स्पेशल सेवा है।`,
        factsEn: [
          'Introduced as an operational special service to manage passenger peak travel demand.',
          'Operating schedule, halts, and frequency are regulated by railway divisional circulars.',
          'Passengers are advised to verify operational running dates prior to booking.'
        ],
        factsHi: [
          'व्यस्त यात्रा सीजन में यात्रियों की सुविधा और अतिरिक्त क्षमता प्रदान करने हेतु संचालित।',
          'समय सारणी, ठहराव और फेरे संबंधित क्षेत्रीय रेलवे द्वारा समय-समय पर अधिसूचित किए जाते हैं।',
          'बुकिंग से पूर्व परिचालन तिथियों की पुष्टि अवश्य करें।'
        ]
      };
    }

    // 7. Default Standard Mail / Express Profile
    return {
      category: 'EXPRESS',
      categoryLabelEn: 'Indian Railways Mail / Express Passenger Service',
      categoryLabelHi: 'भारतीय रेल मेल / एक्सप्रेस यात्री सेवा',
      isAllAc: false,
      hasSleeper: true,
      hasGeneral: true,
      locoEn: 'Operating traction allocated by the operating railway zone according to route electrification (Electric or Diesel traction).',
      locoHi: 'संबंधित रेलवे जोन द्वारा मार्ग के विद्युतीकरण के अनुसार निर्धारित लोकोमोटिव ट्रैक्शन (इलेक्ट्रिक अथवा डीजल)।',
      coachesEn: [
        'AC 2-Tier (2A): Spacious air-conditioned berths with clean curtains, charging sockets, and fresh linen kits (where configured).',
        'AC 3-Tier (3A / 3E): Standard air-conditioned sleeper accommodation for family travelers.',
        'Sleeper Class (SL): Non-AC reserved sleeping berths designed for budget-conscious passengers.',
        'General Unreserved (GS): Unreserved coaches for daily and short-distance commuters, bookable via the UTS mobile app or station counters.'
      ],
      coachesHi: [
        'एसी 2-टियर (2A): वातानुकूलित 2-टियर शयनयान (कोच संयोजन के अनुसार)।',
        'एसी 3-टियर (3A / 3E): लंबी दूरी और परिवारों के लिए किफायती वातानुकूलित स्लीपर कोच।',
        'स्लीपर क्लास (SL): किफायती गैर-वातानुकूलित आरक्षित शयनयान व्यवस्था।',
        'सामान्य अनारक्षित (GS): अनारक्षित डिब्बे, जिनके टिकट यूटीएस ऐप या स्टेशन काउंटर से लिए जा सकते हैं।'
      ],
      cateringEn: 'Onboard pantry car service or IRCTC station e-catering delivery available at designated junction halts along the route.',
      cateringHi: 'ऑन-बोर्ड पेंट्री कार अथवा प्रमुख जंक्शनों पर आईआरसीटीसी ई-कैटरिंग डिलीवरी सुविधा।',
      fareEn: 'Standard Indian Railways telescopic distance-based fare chart with Tatkal quota booking.',
      fareHi: 'भारतीय रेल की मानक दूरी-आधारित किराया तालिका व तत्काल आरक्षण सुविधा।',
      historyEn: `Train ${trainNo} ${trainName} provides scheduled passenger transit connecting cities, towns, and commercial centers along its designated route.`,
      historyHi: `ट्रेन ${trainNo} ${trainName} अपने निर्धारित मार्ग पर शहरों और व्यापारिक केंद्रों को जोड़ने वाली एक नियमित यात्री सेवा है।`,
      factsEn: [
        'Provides essential intercity and regional passenger connectivity.',
        'Accommodates diverse passenger budgets with AC, Sleeper, and General compartments.',
        'Operated according to standard Indian Railways zonal operating schedules.'
      ],
      factsHi: [
        'विभिन्न शहरों के मध्य सुगम और किफायती आवागमन का साधन।',
        'एसी, स्लीपर और सामान्य श्रेणियों के साथ सभी बजट के यात्रियों के लिए अनुकूल।',
        'भारतीय रेल के मानक परिचालन नियमों के अधीन संचालित।'
      ]
    };
  }

  /**
   * Enriches intermediate stops with local landmarks, pilgrimage points, and famous regional foods.
   */
  public resolveStationEnrichments(stops: any[], language: 'en' | 'hi') {
    const isHi = language === 'hi';
    const sights: string[] = [];
    const foods: string[] = [];

    const stationCodes = (stops || []).map(s => String(s.station_code || '').toUpperCase().trim());

    for (const code of stationCodes) {
      if (STATION_KNOWLEDGE[code]) {
        const info = STATION_KNOWLEDGE[code];
        sights.push(isHi ? `**${info.name}:** ${info.sightHi}` : `**${info.name}:** ${info.sightEn}`);
        foods.push(isHi ? `**${info.name}:** ${info.foodHi}` : `**${info.name}:** ${info.foodEn}`);
      }
    }

    return { sights, foods };
  }

  /**
   * Deterministic Editorial Template Synthesizer (Zero-Failure Fallback)
   * Dynamically formats title, summary, tables, and sections according to the chosen focus topics.
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
    focusAngle?: string,
    focusTopics?: string[],
    liveData?: LiveInternetData,
    customKeywords?: string
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
    const isHi = language === 'hi';
    const stops = meta.scheduleStations || [];
    const sourceDisplay = meta.source || (stops[0]?.station_name || 'Origin Terminal');
    const destDisplay = meta.destination || (stops[stops.length - 1]?.station_name || 'Destination Terminal');
    const sourceCode = stops[0]?.station_code || 'Origin';
    const destCode = stops[stops.length - 1]?.station_code || 'Destination';

    const activeTopics = this.resolveFocusTopics(focusAngle, focusTopics);
    const profile = this.analyzeTrainProfile(trainNo, meta.trainName, meta.trainType, stops);
    const { sights, foods } = this.resolveStationEnrichments(stops, language);
    const hasDetailedTimetable = stops.length >= 3;

    // Build verified schedule table
    let tableRows = '';
    if (stops.length > 0) {
      tableRows = stops.slice(0, 30).map((s, idx) => {
        const arr = s.arrival_time && s.arrival_time !== '--' ? s.arrival_time : (idx === 0 ? 'Source' : '--');
        const dep = s.departure_time && s.departure_time !== '--' ? s.departure_time : (idx === stops.length - 1 ? 'Terminus' : '--');
        const halt = s.halt && s.halt.trim() ? s.halt : (idx === 0 || idx === stops.length - 1 ? '--' : '2 min');
        const dist = s.distance ? `${s.distance} km` : '--';
        const pf = s.platform ? `PF ${s.platform}` : '--';
        return `| ${idx + 1} | **${s.station_name || s.station_code}** | \`${s.station_code}\` | ${arr} | ${dep} | ${halt} | Day ${s.day || '1'} | ${dist} | ${pf} |`;
      }).join('\n');
    } else {
      tableRows = `| 1 | **${sourceDisplay}** | \`${sourceCode}\` | Source | Scheduled | Dep | Day 1 | 0 km | -- |\n| 2 | **${destDisplay}** | \`${destCode}\` | Scheduled | Terminus | -- | Day 1 | -- | -- |`;
    }

    const isSingleFocus = activeTopics.length === 1;
    const isHistoryFocus = isSingleFocus && activeTopics[0] === 'history';
    const isTimetableFocus = isSingleFocus && activeTopics[0] === 'timetable';
    const isFoodFocus = isSingleFocus && activeTopics[0] === 'food_pantry';
    const isCancellationFocus = isSingleFocus && activeTopics[0] === 'cancellation_refund';
    const isFlightVsTrainFocus = isSingleFocus && activeTopics[0] === 'flight_vs_train';

    // ─── HINDI GENERATION ────────────────────────────────────────────────────────
    if (isHi) {
      let title = '';
      let seo_title = '';
      let meta_description = '';
      let summary = '';

      if (isHistoryFocus) {
        if (trainNo === '22221' || trainNo === '22222') {
          title = `${trainNo} ${meta.trainName}: सम्पूर्ण इतिहास, शुरुआत, लोकोमोटिव और रोचक तथ्य`;
          seo_title = truncateToWordBoundary(`${trainNo} ${meta.trainName} इतिहास व रोचक तथ्य`, 60);
          meta_description = truncateToWordBoundary(`${trainNo} ${meta.trainName} (${sourceDisplay} से ${destDisplay}) का संपूर्ण इतिहास, उद्घाटन तिथि, पुश-पुल इंजन तकनीक, तेजस रैक और रोचक तथ्य पढ़ें।`, 155);
          summary = `मध्य रेल की राजधानी **${trainNo} ${meta.trainName}** (${sourceDisplay} से ${destDisplay}) अपने परिचालन इतिहास और लोकोमोटिव इंजीनियरिंग में एक मील का पत्थर है।\n\nइस विशेष रिपोर्ट में ट्रेन ${trainNo} की शुरुआत, उद्घाटन वर्ष, पश्चिमी घाट के थुल घाट जैसे कठिन मार्गों पर पुश-पुल WAP-7 तकनीक, आधुनिक तेजस स्मार्ट एलएचबी रैक में बदलाव और रेल प्रशंसकों के बीच लोकप्रिय रोचक तथ्यों का प्रामाणिक विश्लेषण प्रस्तुत किया गया है।`;
        } else {
          title = `${trainNo} ${meta.trainName}: रूट पृष्ठभूमि, कोच संरचना व यात्रा गाइड`;
          seo_title = truncateToWordBoundary(`${trainNo} ${meta.trainName} रूट विवरण व गाइड`, 60);
          meta_description = truncateToWordBoundary(`${trainNo} ${meta.trainName} (${sourceDisplay} से ${destDisplay}) की रूट पृष्ठभूमि, कोच संरचना, लोकोमोटिव ट्रैक्शन और जरूरी यात्रा जानकारी पढ़ें।`, 155);
          summary = `ट्रेन **${trainNo} ${meta.trainName}** (${sourceDisplay} से ${destDisplay}) इस रेलमार्ग पर यात्रियों के लिए एक नियमित यात्री सेवा है।\n\nइस रिपोर्ट में ट्रेन ${trainNo} का परिचालन विवरण, लोकोमोटिव ट्रैक्शन (${profile.locoHi}), उपलब्ध कोच श्रेणियां और यात्रियों के लिए जरूरी यात्रा जानकारी प्रस्तुत की गई है।`;
        }
      } else if (isTimetableFocus) {
        if (hasDetailedTimetable) {
          title = `${trainNo} ${meta.trainName}: सत्यापित समय सारणी, ठहराव, रूट मैप और रनिंग शेड्यूल`;
          seo_title = truncateToWordBoundary(`${trainNo} ${meta.trainName} समय सारणी व ठहराव`, 60);
          meta_description = truncateToWordBoundary(`${trainNo} ${meta.trainName} (${sourceDisplay} से ${destDisplay}) का आधिकारिक रनिंग शेड्यूल, प्रमुख स्टेशनों के आगमन-प्रस्थान समय और प्लेटफार्म विवरण।`, 155);
          summary = `ट्रेन **${trainNo} ${meta.trainName}** ${sourceDisplay} और ${destDisplay} के मध्य दैनिक यात्रियों, पर्यटकों और व्यापारियों के लिए एक महत्वपूर्ण ट्रेन सेवा है।\n\nयह गाइड ट्रेन ${trainNo} के सभी महत्वपूर्ण ठहरावों, स्टेशन पर आगमन व प्रस्थान के समय, दूरी और प्लेटफार्म नंबरों की अद्यतन सूची प्रस्तुत करती है।`;
        } else {
          title = `${trainNo} ${meta.trainName}: रूट विवरण, टर्मिनल एवं यात्रा एडवाइजरी`;
          seo_title = truncateToWordBoundary(`${trainNo} ${meta.trainName} रूट विवरण व एडवाइजरी`, 60);
          meta_description = truncateToWordBoundary(`${trainNo} ${meta.trainName} (${sourceDisplay} से ${destDisplay}) का रूट विवरण, टर्मिनल स्टेशन और जरूरी यात्रा एडवाइजरी।`, 155);
          summary = `ट्रेन **${trainNo} ${meta.trainName}** ${sourceDisplay} और ${destDisplay} के मध्य संचालित होती है। मध्यवर्ती ठहरावों की विस्तृत समय सारणी का सत्यापन आधिकारिक रेलवे परिपत्रों से किया जा रहा है।\n\nयह रूट अवलोकन प्रमुख टर्मिनलों और यात्रियों के लिए आवश्यक यात्रा दिशा-निर्देश प्रस्तुत करता है।`;
        }
      } else if (isFoodFocus) {
        title = `${trainNo} ${meta.trainName}: खान-पान, पेंट्री मेनू, कैटरिंग व स्टेशन के प्रसिद्ध व्यंजन`;
        seo_title = truncateToWordBoundary(`${trainNo} ${meta.trainName} पेंट्री मेनू व कैटरिंग`, 60);
        meta_description = truncateToWordBoundary(`${trainNo} ${meta.trainName} में ऑन-बोर्ड पेंट्री भोजन, आईआरसीटीसी कैटरिंग मेनू, ई-कैटरिंग डिलीवरी और रास्ते के मशहूर स्टेशन व्यंजनों की पूरी जानकारी।`, 155);
        summary = `ट्रेन **${trainNo} ${meta.trainName}** में सफर के दौरान खान-पान का अनुभव कैसा रहता है? जानिए ऑन-बोर्ड पेंट्री कार की सुविधाएं, आईआरसीटीसी मील ऑप्शंस और रास्ते में पड़ने वाले जंक्शन स्टेशनों के प्रसिद्ध पारंपरिक व्यंजनों की पूरी लिस्ट।\n\nयात्री अपनी सीट पर गर्म और स्वच्छ भोजन ऑनलाइन ई-कैटरिंग के जरिए कैसे मंगवा सकते हैं, इसकी पूरी प्रक्रिया भी इस गाइड में समझाई गई है।`;
      } else if (isCancellationFocus) {
        title = `${trainNo} ${meta.trainName}: टिकट कैंसिलेशन नियम, क्लर्केज चार्ज व रिफंड कैलकुलेटर`;
        seo_title = truncateToWordBoundary(`${trainNo} ${meta.trainName} कैंसिलेशन व रिफंड गाइड`, 60);
        meta_description = truncateToWordBoundary(`${trainNo} ${meta.trainName} टिकट कैंसिलेशन चार्ज, 48h/12h/4h स्लैब, RAC/WL रिफंड, 100% स्वतः रिफंड और टीडीआर ऑनलाइन नियम।`, 155);
        summary = `यदि आप **${trainNo} ${meta.trainName}** (${sourceDisplay} से ${destDisplay}) में अपनी यात्रा रद्द करने का विचार कर रहे हैं, तो आईआरसीटीसी (IRCTC) और भारतीय रेल के आधिकारिक कैंसिलेशन नियमों को जानना अनिवार्य है।\n\nयह गाइड प्रस्थान से पूर्व विभिन्न समय सीमाओं (48 घंटे, 12 घंटे, 4 घंटे) में कटने वाले क्लर्केज शुल्क, आरएसी व वेटलिस्ट टिकटों पर मिलने वाले रिफंड, ट्रेन रद्द होने पर 100% स्वतः रिफंड और टीडीआर फाइलिंग की पूरी प्रक्रिया समझाती है।`;
      } else if (isFlightVsTrainFocus) {
        title = `${trainNo} ${meta.trainName} बनाम फ्लाइट: समय, किराया, सामान व सुविधा तुलना`;
        seo_title = truncateToWordBoundary(`${trainNo} ${meta.trainName} बनाम फ्लाइट तुलना`, 60);
        meta_description = truncateToWordBoundary(`${trainNo} ${meta.trainName} और हवाई जहाज (Flight) में कौन सा बेहतर है? कुल समय, 15 किलो बैगेज सीमा बनाम 40 किलो, स्लीपर आराम और किराये की तुलना।`, 155);
        summary = `${sourceDisplay} से ${destDisplay} कॉरिडोर पर सफर करने वाले यात्रियों के सामने अक्सर सवाल होता है कि फ्लाइट चुनें या ट्रेन **${trainNo} ${meta.trainName}**?\n\nयह तुलनात्मक रिपोर्ट एयरपोर्ट आने-जाने का कुल डोर-टू-डोर समय, 15 किलो बैगेज सीमा बनाम ट्रेन में 40-50 किलो मुफ्त सामान, संकरी इकोनॉमी सीट बनाम 6-फुट फ्लैट स्लीपर बर्थ और किराये की स्थिरता का वस्तुनिष्ठ विश्लेषण करती है।`;
      } else {
        // Complete 360° Comprehensive Mega-Guide (Multi-topic / All topics)
        if (hasDetailedTimetable) {
          title = `${trainNo} ${meta.trainName}: 360° सम्पूर्ण यात्रा गाइड — रूट, समय सारणी, कोच और जरूरी टिप्स`;
          seo_title = truncateToWordBoundary(`${trainNo} ${meta.trainName} सम्पूर्ण गाइड व समय सारणी`, 60);
          meta_description = truncateToWordBoundary(`${trainNo} ${meta.trainName} (${sourceDisplay} से ${destDisplay}) की अद्यतन समय सारणी, कोच श्रेणियां, किराया, खान-पान और कन्फर्म टिकट टिप्स।`, 155);
          summary = `${sourceDisplay} और ${destDisplay} के मध्य संचालित **${trainNo} ${meta.trainName}** इस रेलमार्ग पर यात्रियों के लिए एक नियमित सेवा है।\n\nयह विस्तृत 360° मास्टर गाइड ट्रेन ${trainNo} का रूट विवरण, आधिकारिक समय सारणी, कोच संरचना (${profile.categoryLabelHi}), टिकट किराया, सामान्य नियम और वेटलिस्ट होने पर Trayago Split Journey से कन्फर्म सीट पाने की पूरी जानकारी प्रदान करती है।`;
        } else {
          title = `${trainNo} ${meta.trainName}: 360° सम्पूर्ण यात्रा गाइड — रूट विवरण, कोच व यात्री एडवाइजरी`;
          seo_title = truncateToWordBoundary(`${trainNo} ${meta.trainName} सम्पूर्ण गाइड व रूट विवरण`, 60);
          meta_description = truncateToWordBoundary(`${trainNo} ${meta.trainName} (${sourceDisplay} से ${destDisplay}) का रूट विवरण, कोच श्रेणियां, किराया और जरूरी यात्री एडवाइजरी।`, 155);
          summary = `${sourceDisplay} और ${destDisplay} के मध्य संचालित **${trainNo} ${meta.trainName}** इस रेलमार्ग पर यात्रियों के लिए एक नियमित सेवा है।\n\nयह विस्तृत 360° मास्टर गाइड ट्रेन ${trainNo} का रूट विवरण, टर्मिनल समय, कोच संरचना (${profile.categoryLabelHi}), टिकट किराया, सामान्य नियम और वेटलिस्ट होने पर Trayago Split Journey से कन्फर्म सीट पाने की पूरी जानकारी प्रदान करती है।`;
        }
      }

      // Assemble Content Sections based on selected topics
      const sections: string[] = [];

      // Section 1: Overview
      sections.push(`
## 🚆 ${trainNo} ${meta.trainName} का परिचय एवं मुख्य विशेषताएं

भारतीय रेलवे द्वारा संचालित **${trainNo} ${meta.trainName}** (${sourceDisplay} से ${destDisplay}) इस रेलमार्ग पर यात्रियों के लिए एक नियमित सेवा प्रदान करती है।

- **ट्रेन श्रेणी:** ${profile.categoryLabelHi}
- **प्रारंभिक स्टेशन:** ${sourceDisplay} (\`${sourceCode}\`)
- **अंतिम गंतव्य:** ${destDisplay} (\`${destCode}\`)
- **लोकोमोटिव ट्रैक्शन:** ${profile.locoHi}
- **कोच व्यवस्था:** ${profile.isAllAc ? 'शत-प्रतिशत ऑल-एसी वातानुकूलित कोच (कोई स्लीपर या जनरल अनारक्षित कोच नहीं)' : 'वातानुकूलित, स्लीपर एवं अनारक्षित सामान्य कोच'}
      `.trim());

      // Live Web Search Grounding Section (if data present)
      if (liveData && (liveData.summary || (liveData.newsHeadlines && liveData.newsHeadlines.length > 0))) {
        const headlinesMarkdown = (liveData.newsHeadlines || [])
          .slice(0, 5)
          .map((h: any) => `- 📰 **${h.title}** (${h.source} — ${new Date(h.pubDate).toLocaleDateString('hi-IN')})`)
          .join('\n');

        sections.push(`
## 🌐 लाइव इंटरनेट रिसर्च एवं ताज़ा रेलवे समाचार अलर्ट (Real-Time Grounding)

भारतीय रेल एवं प्रमुख समाचार स्रोतों (Google News, Wikipedia, TOI, रेल मंत्रालय) से संकलित ताज़ा परिचालन स्थिति:

${liveData.summary ? `> **सत्यापित संदर्भ रिकॉर्ड:** ${liveData.summary}\n` : ''}
${headlinesMarkdown ? `### 📡 हालिया प्रमुख समाचार व एडवाइजरी:\n${headlinesMarkdown}` : ''}
        `.trim());
      }

      // Section 2: History (if selected)
      if (activeTopics.includes('history')) {
        sections.push(`
## 📜 ट्रेन ${trainNo} का इतिहास, शुरुआत और लोकोमोटिव इंजीनियरिंग

1. **ऐतिहासिक शुरुआत और उद्देश्य:** ${profile.historyHi}
2. **इंजन व लोकोमोटिव इंजीनियरिंग:** ${profile.locoHi}
3. **रोचक रेल तथ्य व खासियतें:**
${profile.factsHi.map(f => `   - ${f}`).join('\n')}
        `.trim());
      }

      // Section 3: Timetable & Schedule (if selected)
      if (activeTopics.includes('timetable')) {
        if (hasDetailedTimetable) {
          sections.push(`
## 🕒 आधिकारिक रूट, समय सारणी और प्रमुख स्टेशन ठहराव

ट्रेन ${trainNo} के प्रमुख स्टेशनों का समय, आगमन, प्रस्थान और वाणिज्यिक ठहराव विवरण निम्नलिखित है:

| # | स्टेशन का नाम | कोड | आगमन | प्रस्थान | ठहराव | दिन | दूरी | प्लेटफार्म |
|:---|:---|:---|:---|:---|:---|:---|:---|:---|
${tableRows}

> **यात्री सूचना:** स्टेशन रवाना होने से पहले ट्रेन का वास्तविक लाइव रनिंग स्टेटस और प्लेटफार्म नंबर की पुष्टि [Train ${trainNo} Live Status](/live/${trainNo}) पर अवश्य कर लें।
          `.trim());
        } else {
          sections.push(`
## 🕒 रूट अवलोकन एवं टर्मिनल स्टेशन विवरण

ट्रेन ${trainNo} के टर्मिनल स्टेशनों का विवरण नीचे दिया गया है। मध्यवर्ती ठहराव और समय रेलवे परिचालनिक परिपत्रों के अनुसार अद्यतन किए जा रहे हैं:

| # | स्टेशन का नाम | कोड | आगमन | प्रस्थान | ठहराव | दिन | दूरी | प्लेटफार्म |
|:---|:---|:---|:---|:---|:---|:---|:---|:---|
${tableRows}

> **सूचना:** मध्यवर्ती स्टेशनों की संपूर्ण समय सारणी का सत्यापन आधिकारिक रेलवे स्रोतों से किया जा रहा है। स्टेशन रवाना होने से पहले [Train ${trainNo} Live Status](/live/${trainNo}) पर वास्तविक लाइव स्थिति अवश्य जांच लें।
          `.trim());
        }
      }

      // Section 4: Tourism & Sights Along Route (if selected)
      if (activeTopics.includes('tourism')) {
        const sightsContent = sights.length > 0
          ? sights.map(s => `- ${s}`).join('\n')
          : `- **ऐतिहासिक धरोहर व किले:** मार्ग के प्रमुख जंक्शन शहर अपने प्राचीन किलों, स्मारकों और ऐतिहासिक विरासतों के लिए विख्यात हैं।\n- **धार्मिक केंद्र एवं तीर्थाटन:** इस रूट पर स्थित कई स्टेशन प्रसिद्ध शक्तिपीठों और प्राचीन मंदिरों के लिए मुख्य प्रवेश द्वार का कार्य करते हैं।`;

        sections.push(`
## 🌄 रास्ते के प्रमुख पर्यटन, धार्मिक और ऐतिहासिक स्थल

${sourceDisplay} से ${destDisplay} के बीच यह रेलमार्ग भारत की समृद्ध ऐतिहासिक, सांस्कृतिक और प्राकृतिक विविधता को जोड़ता है:

${sightsContent}
        `.trim());
      }

      // Section 5: Coach Composition (if selected)
      if (activeTopics.includes('coaches')) {
        sections.push(`
## 💺 उपलब्ध कोच श्रेणियां और यात्री सुविधाएं

ट्रेन ${trainNo} (${profile.categoryLabelHi}) में उपलब्ध वास्तविक कोच श्रेणियां और सुविधाएं:

${profile.coachesHi.map(c => `- ${c}`).join('\n')}
        `.trim());
      }

      // Section 6: Fare & Tatkal Rules (if selected)
      if (activeTopics.includes('fare_tatkal')) {
        sections.push(`
## 🎫 टिकट किराया, डायनामिक प्राइसिंग और तत्काल आरक्षण नियम

1. **किराया संरचना:** ${profile.fareHi}
2. **तत्काल बुकिंग टाइमिंग:** एसी क्लास (AC Classes) के लिए तत्काल बुकिंग यात्रा तिथि से 1 दिन पूर्व सुबह **10:00 बजे** ${profile.hasSleeper ? 'तथा स्लीपर क्लास के लिए सुबह **11:00 बजे**' : ''} शुरू होती है।
3. **100% स्वतः रिफंड नियम:** यदि ट्रेन किसी परिचालन अथवा तकनीकी कारणवश रेलवे द्वारा पूर्णतः निरस्त की जाती है, तो ई-टिकट धारकों को 100% पूरा रिफंड उनके मूल बैंक खाते में बिना टीडीआर दाखिल किए स्वतः वापस कर दिया जाता है।
        `.trim());
      }

      // Section 6A: Cancellation & Refund Calculator (if selected)
      if (activeTopics.includes('cancellation_refund')) {
        sections.push(`
## 📉 ट्रेन टिकट कैंसिलेशन नियम, क्लर्केज चार्ज व रिफंड कैलकुलेटर

आईआरसीटीसी (IRCTC) और भारतीय रेलवे के आधिकारिक नियमों के अनुसार यदि आप ट्रेन **${trainNo} ${meta.trainName}** में टिकट रद्द करते हैं, तो रिफंड का निर्धारण चार्ट बनने के समय और ट्रेन प्रस्थान समय के आधार पर किया जाता है:

### ⏱️ समय सीमा अनुसार रिफंड कटौती स्लैब (Refund Deduction Slabs)

| प्रस्थान से पूर्व का समय | कटौती दर (Deduction Rate) | न्यूनतम क्लर्केज चार्ज (प्रति यात्री) |
|:---|:---|:---|
| **48 घंटे से अधिक पूर्व** | फ्लैट क्लर्केज शुल्क | 1A/EC: ₹240 + GST<br>2A/FC: ₹200 + GST<br>3A/CC/3E: ₹180 + GST<br>Sleeper: ₹120<br>2S: ₹60 |
| **48 घंटे से 12 घंटे तक** | कुल मूल किराये का **25%** | न्यूनतम फ्लैट क्लर्केज चार्ज के अधीन |
| **12 घंटे से 4 घंटे तक** (या चार्ट बनने तक) | कुल मूल किराये का **50%** | न्यूनतम फ्लैट क्लर्केज चार्ज के अधीन |
| **4 घंटे से कम या चार्ट बनने के बाद** | **0% रिफंड** (कोई रिफंड नहीं) | कन्फर्म टिकट पर कोई रिफंड देय नहीं होता |

### 📋 आरएसी (RAC) व वेटलिस्ट (Waiting List) टिकट रिफंड नियम
- **चार्ट बनने के बाद व प्रस्थान से 30 मिनट पूर्व तक:** आरएसी या वेटलिस्ट टिकट रद्द कराने पर केवल न्यूनतम क्लर्केज चार्ज (₹60 प्रति यात्री) काटा जाता है और शेष पूरा किराया वापस खाते में क्रेडिट होता है।
- **ऑटोमैटिक 100% फुल रिफंड (ट्रेन रद्द होने पर):** यदि ट्रेन रेलवे द्वारा मौसम (कोहरा, बाढ़ आदि) या तकनीकी कारणों से रद्द की जाती है, तो ऑनलाइन ई-टिकट धारकों को बिना किसी टीडीआर (TDR) के **100% पूरा रिफंड स्वतः** उसी बैंक/यूपीआई खाते में वापस मिल जाता है।
- **ऑनलाइन टीडीआर फाइलिंग (TDR Filing):** यदि ट्रेन 3 घंटे से अधिक लेट हो और यात्री यात्रा न करना चाहे, अथवा एसी कोच में एसी काम न करने पर किराए का अंतर प्राप्त करने हेतु ऑनलाइन टीडीआर दाखिल किया जा सकता है।
        `.trim());
      }

      // Section 6B: Flight vs Train Comparison (if selected)
      if (activeTopics.includes('flight_vs_train')) {
        sections.push(`
## ✈️ फ्लाइट बनाम ट्रेन (${trainNo} ${meta.trainName}): समय, किराया, सामान व आराम की सीधी तुलना

क्या आपको इस मार्ग पर हवाई जहाज (Flight) से यात्रा करनी चाहिए या **${trainNo} ${meta.trainName}** चुननी चाहिए? आइए सभी व्यावहारिक पहलुओं की निष्पक्ष तुलना करें:

| तुलना का आधार (Parameter) | 🚆 ट्रेन (${trainNo} ${meta.trainName}) | ✈️ फ्लाइट (विमान यात्रा) |
|:---|:---|:---|
| **डोर-टू-डोर वास्तविक समय** | शहर के मुख्य स्टेशन से केंद्र तक रात भर में सुगम सफर; दिन का कीमती समय नहीं बिगड़ता | एयरपोर्ट की दूरी (1.5h) + चेक-इन/सुरक्षा जांच (2h) + उड़ान (2h) + बैगेज प्राप्ति (45m) = **लगभग 6.5 से 7 घंटे** |
| **मुफ्त सामान की सीमा (Luggage)** | **40 से 50 किग्रा** (1A में 70 किग्रा) बिना किसी अतिरिक्त वजन या पेनल्टी के | केवल **15 किग्रा** चेक-इन + 7 किग्रा केबिन बैग; अतिरिक्त वजन पर ₹500 से ₹600 प्रति किग्रा का भारी जुर्माना |
| **नींद और बैठने का आराम** | 6 फीट का सीधा फ्लैट स्लीपर बर्थ, साफ चादर, तकिया, कंबल और प्राइवेसी पर्दे | 29-30 इंच की संकरी इकोनॉमी सीट जिसमें रात भर सीधा बैठना थकावट भरा होता है |
| **किराया व आखिरी समय की कीमतें** | पारदर्शी व बजट-अनुकूल किराया संरचना (3A: ₹2,000-₹2,500; 2A: ₹3,000-₹3,500) | आखिरी समय में डायनामिक सर्ज के कारण किराया अक्सर ₹8,000 से ₹16,000+ तक पहुंच जाता है |
| **मौसम व कोहरे में विश्वसनीयता** | इलेक्ट्रिक इंजन में लगे फॉग-पास डिवाइस और कवच प्रणाली से खराब मौसम में भी निरंतर परिचालन | घने कोहरे या खराब दृश्यता में एयरपोर्ट पर फ्लाइट्स का घंटों लेट होना या रद्द होना आम है |

> **यात्री निष्कर्ष:** यदि आप परिवार के साथ हैं, अधिक सामान ले जा रहे हैं या दिनभर की भागदौड़ बचाकर रात में आराम से सोना चाहते हैं, तो ट्रेन ${trainNo} फ्लाइट की तुलना में कहीं अधिक किफायती और सुविधाजनक विकल्प है।
        `.trim());
      }

      // Section 7: Food & Pantry (if selected)
      if (activeTopics.includes('food_pantry')) {
        const foodsContent = foods.length > 0
          ? `\n### 🍲 मार्ग के प्रमुख स्टेशनों के प्रसिद्ध पारंपरिक व्यंजन\n\n${foods.map(f => `- ${f}`).join('\n')}`
          : '';

        sections.push(`
## 🍽️ खान-पान, ऑन-बोर्ड कैटरिंग एवं आईआरसीटीसी ई-कैटरिंग

${profile.cateringHi}

यात्री यात्रा के दौरान आईआरसीटीसी ई-कैटरिंग (IRCTC e-Catering) के माध्यम से भी अपनी सीट पर मनपसंद रेस्टोरेंट से ताजा खाना ऑर्डर कर सकते हैं।
${foodsContent}
        `.trim());
      }

      // Section 8: Travel Tips & Experience (if selected)
      if (activeTopics.includes('travel_tips')) {
        sections.push(`
## ⚡ यात्रा अनुभव, गति, सफाई और उपयोगी प्रो-टिप्स

1. **समयबद्धता व गति:** ट्रेन की शीर्ष अनुमेय गति 130 किमी/घंटा तक है और यह अपनी समयबद्धता के लिए जानी जाती है।
2. **स्वच्छता व्यवस्था:** ऑन-बोर्ड हाउसकीपिंग सर्विस (OBHS) ट्रेन में उपलब्ध रहती है। बायो-टॉयलेट्स और कोचों की नियमित सफाई की जाती है।
3. **चार्जिंग व सुरक्षा:** प्रत्येक बे में मोबाइल और लैपटॉप चार्जिंग सॉकेट उपलब्ध हैं। आपात स्थिति में रेल मदद हेल्पलाइन 139 पर संपर्क करें।
        `.trim());
      }

      // Section 9: Waitlist Solutions via Trayago Split Journey (if selected)
      if (activeTopics.includes('split_journey')) {
        sections.push(`
## 🔄 वेटलिस्ट टिकट का स्मार्ट समाधान: Trayago Split Journey

यदि ट्रेन ${trainNo} में सभी नियमित और तत्काल सीटें प्रतीक्षा सूची (Waiting List) में हैं, तो यात्री **Trayago Split Journey** का उपयोग कर सकते हैं। हमारा स्मार्ट AI इंजन यात्रा के बीच पड़ने वाले प्रमुख जंक्शनों के जरिए दो कनेक्टिंग ट्रेनों में कन्फर्म सीट ढूंढ निकालता है, जिससे बिना किसी अतिरिक्त परेशानी के आपकी यात्रा सुनिश्चित हो जाती है।
        `.trim());
      }

      // Section 10: Official Links
      sections.push(`
## 🔗 आधिकारिक रेलवे पोर्टल्स और जरूरी लिंक्स

- 🎫 **ऑनलाइन टिकट बुकिंग:** [IRCTC Official E-Ticketing](https://www.irctc.co.in)
- 📡 **ट्रेन लाइव रनिंग स्थिति:** [Track Train ${trainNo} Live](/live/${trainNo})
- 🔍 **पीएनआर स्टेटस कन्फर्मेशन:** [Check PNR Status](/pnr)
- 🛡️ **रेल मदद शिकायत निवारण:** [RailMadad 139](https://railmadad.indianrailways.gov.in)
- 🗺️ **इस रूट की अन्य सभी ट्रेनें खोजें:** [Search All Trains between ${sourceDisplay} and ${destDisplay}](/?from=${encodeURIComponent(sourceCode)}&to=${encodeURIComponent(destCode)})
      `.trim());

      const passenger_advice = isHistoryFocus
        ? `ट्रेन ${trainNo} के ऐतिहासिक महत्व और शानदार रूट का आनंद लेने के लिए यात्रा के दौरान थुल घाट और प्रमुख ऐतिहासिक जंक्शनों पर खिड़की से नजारों का अनुभव अवश्य लें।`
        : isCancellationFocus
        ? `कन्फर्म टिकट कैंसिल करते समय चार्टिंग समय (प्रस्थान से 4 घंटे पूर्व) का विशेष ध्यान रखें, क्योंकि चार्ट बनने के बाद कन्फर्म टिकट पर कोई रिफंड नहीं मिलता।`
        : `पीक सीजन में अपनी यात्रा का अग्रिम आरक्षण समय रहते कराएं। यदि सीधी सीटें प्रतीक्षारत हों, तो Trayago Split Journey के माध्यम से कनेक्टिंग कन्फर्म सीट की जांच करें।`;

      const key_takeaways = isHistoryFocus ? [
        `ट्रेन ${trainNo} ${meta.trainName} मध्य रेलवे की पहली और प्रतिष्ठित राजधानी एक्सप्रेस है।`,
        `ट्विन पुश-पुल WAP-7 तकनीक से थुल घाट पर बिना बैंकर इंजन के चलने वाली ऐतिहासिक ट्रेन।`,
        `अक्टूबर 2021 में आधुनिक तेजस स्मार्ट स्लीपर एलएचबी रैक में अपग्रेड की गई।`,
        `शत-प्रतिशत वातानुकूलित कोच संरचना, जिसमें कोई भी स्लीपर या जनरल कोच नहीं होता।`
      ] : isCancellationFocus ? [
        `प्रस्थान से 48 घंटे पूर्व कैंसिल करने पर सिर्फ फ्लैट क्लर्केज चार्ज कटता है।`,
        `48 से 12 घंटे के बीच 25% और 12 से 4 घंटे (चार्ट बनने) के बीच 50% किराया कटता है।`,
        `चार्ट बनने के बाद कन्फर्म टिकट पर 0% रिफंड मिलता है।`,
        `ट्रेन रेलवे द्वारा रद्द होने पर 100% पूरा रिफंड बिना टीडीआर स्वतः बैंक खाते में आ जाता है।`
      ] : [
        `ट्रेन ${trainNo} ${meta.trainName} ${sourceDisplay} से ${destDisplay} के बीच संचालित होती है।`,
        `कोच व्यवस्था: ${profile.isAllAc ? '100% ऑल-एसी वातानुकूलित' : 'एसी, स्लीपर व सामान्य श्रेणियां'}।`,
        `तत्काल टिकट बुकिंग एसी क्लास के लिए सुबह 10:00 बजे खुलती है।`,
        `सीटें फुल होने पर यात्री Trayago Split Journey की सहायता से वैकल्पिक कनेक्टिंग कन्फर्म सीटें प्राप्त कर सकते हैं।`
      ];

      const faqs = isHistoryFocus ? [
        {
          question: `ट्रेन ${trainNo} ${meta.trainName} की शुरुआत कब हुई थी?`,
          answer: `ट्रेन 22221 सीएसएमटी - हजरत निजामुद्दीन राजधानी एक्सप्रेस का उद्घाटन 19 जनवरी 2019 को मध्य रेलवे द्वारा किया गया था।`
        },
        {
          question: `क्या ट्रेन ${trainNo} में स्लीपर या जनरल कोच होते हैं?`,
          answer: `नहीं, यह पूर्णतः ऑल-एसी प्रीमियम राजधानी सेवा है। इसमें केवल एसी फर्स्ट क्लास (1A), एसी 2-टियर (2A) और एसी 3-टियर (3A) कोच होते हैं।`
        },
        {
          question: `ट्रेन ${trainNo} में पुश-पुल तकनीक का उपयोग क्यों किया जाता है?`,
          answer: `थुल घाट (कसारा से इगतपुरी) के 1:37 के अत्यंत तीव्र ढलान पर बिना अतिरिक्त बैंकर इंजन जोड़े सीधे चढ़ने के लिए आगे और पीछे WAP-7 इंजन लगाए जाते हैं, जिससे 40 मिनट की बचत होती है।`
        },
        {
          question: `क्या ट्रेन ${trainNo} में तेजस स्मार्ट कोच लगे हैं?`,
          answer: `हां, अक्टूबर 2021 में इस ट्रेन को आधुनिक तेजस स्मार्ट स्लीपर एलएचबी रैक में अपग्रेड किया गया है, जिसमें स्वचालित दरवाजे और बायो-वैक्यूम टॉयलेट्स हैं।`
        }
      ] : [
        {
          question: `ट्रेन ${trainNo} ${meta.trainName} का प्रारंभिक और अंतिम स्टेशन कौन सा है?`,
          answer: `यह ट्रेन ${sourceDisplay} से प्रस्थान करके ${destDisplay} तक अपनी निर्धारित यात्रा पूरी करती है।`
        },
        {
          question: `क्या ट्रेन ${trainNo} में तत्काल कोटा उपलब्ध रहता है?`,
          answer: `हां, तत्काल कोटा उपलब्ध रहता है। एसी क्लास के लिए बुकिंग सुबह 10:00 बजे खुलती है।`
        },
        {
          question: `क्या ट्रेन ${trainNo} में स्लीपर क्लास उपलब्ध है?`,
          answer: profile.hasSleeper
            ? `हां, इस ट्रेन में स्लीपर क्लास के आरक्षित कोच उपलब्ध हैं।`
            : `नहीं, ${trainNo} ${meta.trainName} एक ऑल-एसी प्रीमियम सेवा है। इसमें स्लीपर या अनारक्षित सामान्य कोच नहीं होते।`
        },
        {
          question: `सीधी टिकट वेटलिस्ट होने पर कन्फर्म सीट कैसे पाएं?`,
          answer: `यात्री Trayago Split Journey का उपयोग कर सकते हैं, जो मध्यवर्ती स्टेशनों के जरिए कन्फर्म कनेक्टिंग ट्रेनों की तुरंत खोज करता है।`
        }
      ];

      if (activeTopics.includes('cancellation_refund') || isCancellationFocus) {
        faqs.push(
          {
            question: `ट्रेन टिकट प्रस्थान से 48 घंटे पहले कैंसिल करने पर कितना चार्ज कटता है?`,
            answer: `48 घंटे से अधिक पहले कैंसिल करने पर केवल फ्लैट क्लर्केज चार्ज कटता है (1A/EC: ₹240, 2A: ₹200, 3A/CC: ₹180, SL: ₹120, 2S: ₹60 प्रति यात्री)।`
          },
          {
            question: `यदि ट्रेन रेलवे द्वारा रद्द (Cancel) कर दी जाए, तो रिफंड कैसे मिलता है?`,
            answer: `यदि ट्रेन रेलवे द्वारा पूरी तरह रद्द की जाती है, तो ई-टिकट धारकों को किसी टीडीआर फाइल करने की जरूरत नहीं होती। 100% पूरा रिफंड स्वतः उसी खाते में 3 से 7 दिनों में आ जाता है।`
          }
        );
      }

      if (activeTopics.includes('flight_vs_train') || isFlightVsTrainFocus) {
        faqs.push(
          {
            question: `क्या इस रूट पर ट्रेन से जाना फ्लाइट से बेहतर और सस्ता है?`,
            answer: `हां, ट्रेन में 40-50 किग्रा मुफ्त सामान, आरामदायक फ्लैट स्लीपर बर्थ और लगभग 1/3 से 1/4 किराया रहता है, जबकि फ्लाइट में 15 किग्रा की सीमा और आखिरी समय पर भारी सर्ज चार्ज लगता है।`
          }
        );
      }

      return {
        title,
        seo_title,
        meta_description,
        summary,
        content: sections.join('\n\n---\n\n').trim(),
        passenger_advice,
        key_takeaways,
        faqs,
        affected_stations: [sourceDisplay, destDisplay].filter(Boolean)
      };
    }

    // ─── ENGLISH GENERATION ──────────────────────────────────────────────────────
    let title = '';
    let seo_title = '';
    let meta_description = '';
    let summary = '';

    if (isHistoryFocus) {
      if (trainNo === '22221' || trainNo === '22222') {
        title = `${trainNo} ${meta.trainName}: Complete History, Inauguration, Rake & Push-Pull Engineering`;
        seo_title = truncateToWordBoundary(`${trainNo} ${meta.trainName} History, Rake & Facts Guide`, 60);
        meta_description = truncateToWordBoundary(`Discover the history, inaugural run, push-pull locomotive engineering, and facts of Train ${trainNo} ${meta.trainName} (${sourceDisplay} to ${destDisplay}).`, 155);
        summary = `Train ${trainNo} ${meta.trainName} (${sourceDisplay} to ${destDisplay}) is Central Railway's premier Rajdhani Express connecting Mumbai and Delhi.\n\nThis historical guide outlines the train's inaugural run in January 2019, its twin push-pull WAP-7 locomotive deployment through Thull Ghat, its upgrade to Tejas Smart Sleeper LHB coaches, and key operational milestones.`;
      } else {
        title = `${trainNo} ${meta.trainName}: Operational Background, Rake Details & Route Facts`;
        seo_title = truncateToWordBoundary(`${trainNo} ${meta.trainName} Rake, Route & Facts Guide`, 60);
        meta_description = truncateToWordBoundary(`Operational background, rake details, locomotive traction, and route milestones for Train ${trainNo} ${meta.trainName} (${sourceDisplay} to ${destDisplay}).`, 155);
        summary = `Train ${trainNo} ${meta.trainName} operates on the ${sourceDisplay} to ${destDisplay} route under Indian Railways.\n\nThis guide covers the train's operational characteristics, coach composition (${profile.categoryLabelEn}), standard motive power, and key transit milestones.`;
      }
    } else if (isTimetableFocus) {
      if (hasDetailedTimetable) {
        title = `${trainNo} ${meta.trainName}: Verified Timetable, Station Halts, Route Map & Schedule`;
        seo_title = truncateToWordBoundary(`${trainNo} ${meta.trainName} Timetable & Station Halts`, 60);
        meta_description = truncateToWordBoundary(`Official running timetable, arrival and departure timings, station halts, platforms, and route schedule for ${trainNo} ${meta.trainName} (${sourceDisplay} to ${destDisplay}).`, 155);
        summary = `Train ${trainNo} ${meta.trainName} connects ${sourceDisplay} and ${destDisplay}, providing essential rail transit across intermediate stations.\n\nThis station guide outlines scheduled arrival and departure timings, stoppage durations, distance markers, and platform numbers across commercial halts.`;
      } else {
        title = `${trainNo} ${meta.trainName}: Route Overview, Terminals & Travel Advisory`;
        seo_title = truncateToWordBoundary(`${trainNo} ${meta.trainName} Route Overview & Advisory`, 60);
        meta_description = truncateToWordBoundary(`Route overview, terminal stations, operational schedule, and travel advisory for ${trainNo} ${meta.trainName} (${sourceDisplay} to ${destDisplay}).`, 155);
        summary = `Train ${trainNo} ${meta.trainName} connects ${sourceDisplay} and ${destDisplay}.\n\nThis route overview provides terminal departure and destination details along with travel planning guidance while detailed intermediate stop times are being updated.`;
      }
    } else if (isFoodFocus) {
      title = `${trainNo} ${meta.trainName}: Onboard Pantry Menu, Catering & Famous Station Delicacies`;
      seo_title = truncateToWordBoundary(`${trainNo} ${meta.trainName} Pantry Menu & Catering`, 60);
      meta_description = truncateToWordBoundary(`Complete onboard pantry meal menu, catering charges, IRCTC e-catering options, and authentic regional station delicacies along ${trainNo} ${meta.trainName}.`, 155);
      summary = `Wondering what food is served aboard Train ${trainNo} ${meta.trainName}? This dedicated culinary guide covers onboard pantry service, multi-course dining options, IRCTC e-catering delivery right to your berth, and iconic station delicacies.\n\nFrom traditional local specialties at intermediate stops to hygienic boxed meals, discover how to enjoy the best food during your journey.`;
    } else if (isCancellationFocus) {
      title = `${trainNo} ${meta.trainName}: Ticket Cancellation Charges, Refund Rules & Slabs`;
      seo_title = truncateToWordBoundary(`${trainNo} ${meta.trainName} Cancellation & Refund Guide`, 60);
      meta_description = truncateToWordBoundary(`Official IRCTC cancellation charges, refund deduction slabs (48h, 12h, 4h), RAC/WL clerkage, 100% automatic refund, and TDR filing for ${trainNo} ${meta.trainName}.`, 155);
      summary = `Planning to cancel your reservation on Train **${trainNo} ${meta.trainName}** (${sourceDisplay} to ${destDisplay})? Understanding Indian Railways and IRCTC cancellation policies can save you from unnecessary financial deductions.\n\nThis definitive guide outlines exact time-based deduction slabs (before 48h, 48-12h, 12-4h, post-charting), RAC/WL clerkage fees, automatic 100% refunds when railways cancel trains, and online TDR filing criteria.`;
    } else if (isFlightVsTrainFocus) {
      title = `${trainNo} ${meta.trainName} vs Flight: Travel Time, Baggage, Comfort & Fare Comparison`;
      seo_title = truncateToWordBoundary(`${trainNo} ${meta.trainName} vs Flight Comparison`, 60);
      meta_description = truncateToWordBoundary(`Comparing Train ${trainNo} ${meta.trainName} vs domestic flights: door-to-door transit time, 15kg baggage limits vs 40kg, sleeping comfort & last-minute fares.`, 155);
      summary = `Traveling between ${sourceDisplay} and ${destDisplay}? Commuters frequently weigh the choice between booking a flight or reserving a berth aboard **${trainNo} ${meta.trainName}**.\n\nThis objective comparison analyzes door-to-door transit hours, strict airline 15kg baggage limits versus 40-50kg train allowances, sleeping berth comfort against cramped economy airline seats, and fare predictability.`;
    } else {
      // 360° Comprehensive Mega-Guide (Multi-topic / All topics)
      const guideDescriptor = hasDetailedTimetable ? 'Timetable, Coaches & Tips' : 'Route Overview, Coaches & Tips';
      title = `${trainNo} ${meta.trainName}: 360° Travel Guide — Route, ${guideDescriptor}`;
      seo_title = truncateToWordBoundary(`${trainNo} ${meta.trainName} Route & Travel Guide`, 60);
      meta_description = truncateToWordBoundary(`Running schedule, accurate coach composition, ticket fares, Tatkal timing, onboard pantry, and pro tips for ${trainNo} ${meta.trainName} (${sourceDisplay} to ${destDisplay}).`, 155);
      summary = `Operating between ${sourceDisplay} and ${destDisplay}, **${trainNo} ${meta.trainName}** provides scheduled rail connectivity on this route.\n\nThis comprehensive guide details the train's operating schedule, station halts, coach classes (${profile.categoryLabelEn}), ticket fare structures, dynamic pricing rules, onboard dining, and travel planning guidance.`;
    }

    // Assemble Content Sections based on selected topics
    const sections: string[] = [];

    // Section 1: Overview
    sections.push(`
## 🚆 Overview & Operational Profile of Train ${trainNo} ${meta.trainName}

Operated under the supervision of Indian Railways, **${trainNo} ${meta.trainName}** connects ${sourceDisplay} and ${destDisplay}. It serves as a vital transit corridor for commuters seeking reliable rail connectivity.

- **Train Category:** ${profile.categoryLabelEn}
- **Source Terminal:** ${sourceDisplay} (\`${sourceCode}\`)
- **Destination Terminal:** ${destDisplay} (\`${destCode}\`)
- **Motive Power:** ${profile.locoEn}
- **Accommodation Structure:** ${profile.isAllAc ? '100% All-Air-Conditioned (Zero Sleeper and Zero Unreserved General coaches)' : 'Air-Conditioned, Sleeper, and General Unreserved accommodation'}
    `.trim());

    // Live Web Search Grounding Section (if data present)
    if (liveData && (liveData.summary || (liveData.newsHeadlines && liveData.newsHeadlines.length > 0))) {
      const headlinesMarkdown = (liveData.newsHeadlines || [])
        .slice(0, 5)
        .map((h: any) => `- 📰 **${h.title}** (${h.source} — ${new Date(h.pubDate).toLocaleDateString('en-IN')})`)
        .join('\n');

      sections.push(`
## 🌐 Real-Time Railway News, Advisories & Web Grounding

Synthesized from verified media reports, official railway press releases, and real-time updates:

${liveData.summary ? `> **Verified Record:** ${liveData.summary}\n` : ''}
${headlinesMarkdown ? `### 📡 Recent News Headlines & Travel Advisories:\n${headlinesMarkdown}` : ''}
      `.trim());
    }

    // Section 2: History (if selected)
    if (activeTopics.includes('history')) {
      sections.push(`
## 📜 Operational Background & Motive Power Profile

1. **Route Background & Milestone:** ${profile.historyEn}
2. **Traction & Motive Power:** ${profile.locoEn}
3. **Operational Characteristics:**
${profile.factsEn.map(f => `   - ${f}`).join('\n')}
      `.trim());
    }

    // Section 3: Timetable & Schedule (if selected)
    if (activeTopics.includes('timetable')) {
      if (hasDetailedTimetable) {
        sections.push(`
## 🕒 Route, Verified Timetable & Station Halts Directory

The official schedule, arrival, departure, stoppage durations, and platform allocations for Train ${trainNo} are detailed below:

| # | Station Name | Code | Arr | Dep | Halt | Day | Distance | Platform |
|:---|:---|:---|:---|:---|:---|:---|:---|:---|
${tableRows}

> **Travel Advisory:** Check real-time live train running status and platform updates on [Train ${trainNo} Live Status](/live/${trainNo}) before arriving at the station.
        `.trim());
      } else {
        sections.push(`
## 🕒 Route Overview & Scheduled Terminals

The terminal departure and destination details for Train ${trainNo} are listed below. Detailed intermediate stops are undergoing official railway verification:

| # | Station Name | Code | Arr | Dep | Halt | Day | Distance | Platform |
|:---|:---|:---|:---|:---|:---|:---|:---|:---|
${tableRows}

> **Travel Advisory:** Intermediate halt timings are subject to railway operational circulars. Verify real-time status on [Train ${trainNo} Live Status](/live/${trainNo}) before embarking on your journey.
        `.trim());
      }
    }

    // Section 4: Tourism & Sights Along Route (if selected)
    if (activeTopics.includes('tourism')) {
      const sightsContent = sights.length > 0
        ? sights.map(s => `- ${s}`).join('\n')
        : `- **Architectural Monuments & Forts:** Intermediate junction stations connect directly to historic forts and UNESCO cultural zones.\n- **Spiritual Pilgrimage Destinations:** Key halts serve as gateways to revered temples and sacred river ghats.`;

      sections.push(`
## 🌄 Scenic Highlights, Heritage & Pilgrimage Spots Along the Route

The transit corridor between ${sourceDisplay} and ${destDisplay} traverses diverse cultural, historical, and geographic landscapes:

${sightsContent}
      `.trim());
    }

    // Section 5: Coach Composition (if selected)
    if (activeTopics.includes('coaches')) {
      sections.push(`
## 💺 Coach Composition & Passenger Classes

Train ${trainNo} (${profile.categoryLabelEn}) features passenger accommodations tailored for maximum comfort:

${profile.coachesEn.map(c => `- ${c}`).join('\n')}
      `.trim());
    }

    // Section 6: Fare & Tatkal Rules (if selected)
    if (activeTopics.includes('fare_tatkal')) {
      sections.push(`
## 🎫 Ticket Fare Structure, Dynamic Pricing & Tatkal Rules

1. **Fare Structure:** ${profile.fareEn}
2. **Tatkal Timings:** Tatkal booking opens 24 hours prior to train departure from origin: **10:00 AM** for AC classes ${profile.hasSleeper ? 'and **11:00 AM** for Non-AC Sleeper classes' : ''}.
3. **100% Automatic Refund:** In the event of full train cancellation by railway authorities, e-ticket passengers receive an automatic 100% full refund directly to their payment account without having to file an online TDR.
      `.trim());
    }

    // Section 6A: Cancellation Charges & Refund Calculator (if selected)
    if (activeTopics.includes('cancellation_refund')) {
      sections.push(`
## 📉 Ticket Cancellation Charges, Refund Calculator & Official Rules

Indian Railways and IRCTC calculate ticket cancellation refunds based on the exact interval between cancellation and the scheduled departure (or charting time):

### ⏱️ Time-Based Cancellation Deduction Slabs

| Cancellation Window | Deduction Percentage | Minimum Flat Clerkage Charge (Per Passenger) |
|:---|:---|:---|
| **More than 48 Hours before departure** | Flat Clerkage Fee | 1A / Executive Class: ₹240 + GST<br>2A / First Class: ₹200 + GST<br>3A / CC / 3E: ₹180 + GST<br>Sleeper (SL): ₹120<br>Second Sitting (2S): ₹60 |
| **Between 48 Hours and 12 Hours** | **25%** of base fare | Subject to minimum flat clerkage charge |
| **Between 12 Hours and 4 Hours** (or chart preparation) | **50%** of base fare | Subject to minimum flat clerkage charge |
| **Less than 4 Hours / After Charting** | **0% Refund** (Zero) | No refund admissible on confirmed tickets |

### 📋 RAC, Waiting List & Automatic Refund Safeguards
- **RAC / Waitlisted Tickets:** Can be cancelled online up to 30 minutes before scheduled train departure. Only a flat clerkage fee of ₹60 (+GST for AC) is deducted per passenger; the entire balance is 100% refunded.
- **100% Automatic Refund on Railway Cancellations:** If Indian Railways cancels the train due to fog, flooding, or technical maintenance, e-ticket passengers receive a **100% automated refund** directly into their original payment method without needing to file an online TDR.
- **When to File an Online TDR (Ticket Deposit Receipt):**
  1. Train delayed by more than 3 hours and passenger chooses not to travel.
  2. Air conditioning failure in AC coaches (difference of fare refunded).
  3. Route diversion where the passenger opts out of the journey.
      `.trim());
    }

    // Section 6B: Flight vs Train Comparison (if selected)
    if (activeTopics.includes('flight_vs_train')) {
      sections.push(`
## ✈️ Flight vs Train (${trainNo} ${meta.trainName}): Transit Time, Baggage, Comfort & Fare Comparison

Deciding whether to take a domestic flight or board Train **${trainNo} ${meta.trainName}** on this corridor? Here is an objective, head-to-head comparison:

| Evaluation Factor | 🚆 Train (${trainNo} ${meta.trainName}) | ✈️ Domestic Airplane / Flight |
|:---|:---|:---|
| **Door-to-Door Travel Time** | Downtown station to downtown station overnight; zero daytime productivity lost | Commute to airport (1.5h) + Security/Boarding (2h) + Flight (2h) + Baggage claim (45m) = **~6.5 to 7 Hours** |
| **Free Baggage Allowance** | **40 kg to 50 kg free** (up to 70 kg in First AC) with zero weighing scale anxiety | Strict **15 kg check-in** limit; excess baggage penalty of ₹500 to ₹600 per kg |
| **Sleeping Comfort & Space** | Full 6-foot horizontal sleeping berth, fresh linen, blankets, and freedom to walk | Cramped 29-30 inch economy pitch; sleeping upright in a narrow seat causes physical strain |
| **Fare Predictability** | Reasonable, transparent pricing (3A: ₹2,000–₹2,500; 2A: ₹3,000–₹3,500) | Last-minute surge pricing often skyrocketing between ₹8,000 and ₹16,000+ |
| **Weather & Fog Resilience** | Electric locomotives with FOG PASS navigation operate steadily through zero visibility | Heavy winter ground fogs frequently ground flights or cause multi-hour runway holds |

> **Bottom Line:** For travelers with family, business gear, or leisure baggage who value uninterrupted horizontal sleep and budget certainty, Train ${trainNo} remains the superior, hassle-free option.
      `.trim());
    }

    // Section 7: Food & Pantry (if selected)
    if (activeTopics.includes('food_pantry')) {
      const foodsContent = foods.length > 0
        ? `\n### 🍲 Regional Station Delicacies Along the Route\n\n${foods.map(f => `- ${f}`).join('\n')}`
        : '';

      sections.push(`
## 🍽️ Food, Onboard Pantry Menu & IRCTC E-Catering Services

${profile.cateringEn}

Passengers can also pre-order hygienic meals from authorized restaurant chains via IRCTC e-catering for berth-side delivery at major junction halts.
${foodsContent}
      `.trim());
    }

    // Section 8: Travel Tips & Experience (if selected)
    if (activeTopics.includes('travel_tips')) {
      sections.push(`
## ⚡ Travel Experience & Passenger Guidance

1. **Travel Comfort & Priority:** Running times and priority clearance vary by train category; passengers are advised to track running patterns.
2. **Onboard Cleanliness:** Maintained via On-Board Housekeeping Services (OBHS) on scheduled express services, with regular sanitization of bio-toilets.
3. **Device Charging & Assistance:** Standard charging sockets are available across berths. For immediate onboard grievances or security concerns, dial the 24x7 RailMadad passenger helpline at 139.
      `.trim());
    }

    // Section 9: Waitlist Alternatives via Trayago Split Journey (if selected)
    if (activeTopics.includes('split_journey')) {
      sections.push(`
## 🔄 Alternate Confirmed Seats via Trayago Split Journey

When berths on Train ${trainNo} are completely booked and waitlists are high, passengers can leverage **Trayago Split Journey Intelligence**. The smart routing engine automatically detects available seats across intermediate junction hubs, combining two connecting trains to guarantee you reach your destination comfortably.
      `.trim());
    }

    // Section 10: Official Links
    sections.push(`
## 🔗 Official Railway Resources & Inbound Commuter Resources

- 🎫 **Official E-Ticket Booking:** [IRCTC Official E-Ticketing System](https://www.irctc.co.in)
- 📡 **Live Running Status:** [Track Train ${trainNo} Live](/live/${trainNo})
- 🔍 **Check PNR Confirmation:** [Check PNR Status](/pnr)
- 🛡️ **RailMadad Passenger Helpline 139:** [RailMadad Grievance Portal](https://railmadad.indianrailways.gov.in)
- 🗺️ **Corridor Trains Directory:** [Search All Trains between ${sourceDisplay} and ${destDisplay}](/?from=${encodeURIComponent(sourceCode)}&to=${encodeURIComponent(destCode)})
    `.trim());

    const passenger_advice = isHistoryFocus
      ? (trainNo === '22221' || trainNo === '22222'
        ? `To fully experience the heritage of Train ${trainNo}, look out for scenic mountain viaducts through the Western Ghats (Thull Ghat) and observe the Push-Pull locomotive setup at origin and terminus.`
        : `Check scheduled departure times and verify platform assignments on live railway tracking tools prior to arrival.`)
      : isCancellationFocus
      ? `Pay close attention to the 4-hour chart preparation cutoff; once the chart is finalized, zero refund is granted on confirmed tickets.`
      : `Reserve berths early during holiday rush periods. If direct tickets are waitlisted, check Trayago Split Journey for guaranteed connecting seats.`;

    const key_takeaways = isHistoryFocus ? (
      (trainNo === '22221' || trainNo === '22222') ? [
        `Train ${trainNo} ${meta.trainName} is Central Railway's premier Rajdhani Express, inaugurated on 19 January 2019.`,
        `Powered by twin Push-Pull WAP-7 electric locomotives to conquer the steep 1:37 Thull Ghat without banker engines.`,
        `Upgraded to modern Tejas Smart Sleeper LHB coaches in October 2021 with automatic doors.`,
        `100% all-air-conditioned passenger accommodation with zero Sleeper or General coaches.`
      ] : [
        `Train ${trainNo} ${meta.trainName} operates between ${sourceDisplay} and ${destDisplay}.`,
        `Motive power and traction: ${profile.locoEn}.`,
        `Passenger accommodation: ${profile.isAllAc ? '100% All-AC' : 'AC, Sleeper, and General coaches'}.`,
        `Operated in accordance with Indian Railways scheduled timetables.`
      ]
    ) : isCancellationFocus ? [
      `Cancellations >48 hours prior incur only a flat clerkage fee (₹60 to ₹240 depending on class).`,
      `Cancellations between 48h and 12h incur a 25% penalty; 12h to 4h incur a 50% penalty.`,
      `Post-charting cancellations (<4h) on confirmed tickets receive zero (0%) refund.`,
      `Railway cancellations due to weather/ops trigger a 100% automatic refund without filing a TDR.`
    ] : [
      `Train ${trainNo} ${meta.trainName} operates between ${sourceDisplay} and ${destDisplay}.`,
      `Accommodation: ${profile.isAllAc ? '100% All-AC (No Sleeper/General)' : 'AC, Sleeper, and General coaches'}.`,
      `Tatkal booking opens at 10:00 AM for AC classes.`,
      `Passengers facing high waitlists can use Trayago Split Journey to find confirmed connecting options.`
    ];

    const faqs = isHistoryFocus ? (
      (trainNo === '22221' || trainNo === '22222') ? [
        {
          question: `When was Train ${trainNo} ${meta.trainName} inaugurated?`,
          answer: `Train 22221 CSMT - Hazrat Nizamuddin Rajdhani Express was officially flagged off on 19 January 2019 by Central Railway.`
        },
        {
          question: `Does Train ${trainNo} have Sleeper or General coaches?`,
          answer: `No. Train 22221 is an all-AC premier Rajdhani service with First AC (1A), 2-Tier AC (2A), and 3-Tier AC (3A) coaches only. It does not carry Sleeper or General coaches.`
        },
        {
          question: `Why does Train ${trainNo} use Push-Pull locomotives?`,
          answer: `Push-Pull twin WAP-7 locomotives (front and rear) allow the train to climb the steep 1:37 gradient of Thull Ghat (Kasara to Igatpuri) without attaching banker locomotives, saving 40 minutes of operational time.`
        },
        {
          question: `When was Train ${trainNo} upgraded to Tejas Smart coaches?`,
          answer: `In October 2021, the train was upgraded to Tejas Smart Sleeper LHB coaches featuring automatic plug doors and sensor-activated bio-vacuum toilets.`
        }
      ] : [
        {
          question: `What is the operational route of Train ${trainNo}?`,
          answer: `Train ${trainNo} ${meta.trainName} operates between ${sourceDisplay} and ${destDisplay}.`
        },
        {
          question: `What locomotive powers Train ${trainNo}?`,
          answer: profile.locoEn
        },
        {
          question: `Does Train ${trainNo} carry Sleeper or General coaches?`,
          answer: profile.hasSleeper
            ? `Yes, this train includes reserved non-AC Sleeper Class (SL) coaches.`
            : `No. Train ${trainNo} is an all-air-conditioned service without Sleeper (SL) coaches.`
        },
        {
          question: `How can I track the real-time status of Train ${trainNo}?`,
          answer: `Passengers can check live running status, delays, and platform numbers on Trayago Live Train Status.`
        }
      ]
    ) : [
      {
        question: `What are the source and destination terminals for Train ${trainNo}?`,
        answer: `Train ${trainNo} ${meta.trainName} departs from ${sourceDisplay} and completes its journey at ${destDisplay}.`
      },
      {
        question: `Does Train ${trainNo} have Sleeper Class coaches?`,
        answer: profile.hasSleeper
          ? `Yes, this train includes reserved non-AC Sleeper Class (SL) coaches.`
          : `No. Train ${trainNo} is an all-air-conditioned service. It does not carry Sleeper (SL) or Unreserved General (GS) coaches.`
      },
      {
        question: `When does Tatkal ticket booking open for Train ${trainNo}?`,
        answer: `Tatkal booking opens one day in advance of departure at 10:00 AM for AC classes.`
      },
      {
        question: `What should I do if tickets on Train ${trainNo} are waitlisted?`,
        answer: `Use Trayago Split Journey to discover verified connecting train seats through intermediate hubs when direct berths are full.`
      }
    ];

    if (activeTopics.includes('cancellation_refund') || isCancellationFocus) {
      faqs.push(
        {
          question: `How much cancellation fee is deducted if cancelled 48 hours before departure?`,
          answer: `Only flat clerkage charges apply: ₹240 for 1A/Executive, ₹200 for 2A, ₹180 for 3A/CC, ₹120 for Sleeper, and ₹60 for 2S (plus GST for AC).`
        },
        {
          question: `Will I get an automatic refund if Train ${trainNo} is cancelled by Indian Railways?`,
          answer: `Yes. For trains officially cancelled by railways, e-ticket holders receive a 100% full refund credited automatically to their bank/card without filing a TDR.`
        }
      );
    }

    if (activeTopics.includes('flight_vs_train') || isFlightVsTrainFocus) {
      faqs.push(
        {
          question: `Is traveling on Train ${trainNo} better than taking a domestic flight?`,
          answer: `Train ${trainNo} provides 40-50 kg free luggage allowance, horizontal sleeping berths, no airport security delays, and predictable fares, making it much more economical and relaxing than domestic flights.`
        }
      );
    }

    return {
      title,
      seo_title,
      meta_description,
      summary,
      content: sections.join('\n\n---\n\n').trim(),
      passenger_advice,
      key_takeaways,
      faqs,
      affected_stations: [sourceDisplay, destDisplay].filter(Boolean)
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
    const focusTopics = this.resolveFocusTopics(focusAngle, options.focusTopics);
    const autoPublish = Boolean(options.autoPublish);

    try {
      winstonLogger.info(
        `[TRAIN_GUIDE_GENERATE] Starting guide generation for Train ${rawTrainNo} (Lang: ${language}, Topics: ${focusTopics.join(',')})`
      );

      // 1. Fetch metadata
      const meta = await this.fetchTrainMetadata(rawTrainNo);
      const coverImage = this.resolveTrainCoverImage(meta.trainName, options.customImageUrl);
      const canonicalSlug = this.generateTrainSlug(rawTrainNo, meta.trainName, meta.source, meta.destination);
      const profile = this.analyzeTrainProfile(rawTrainNo, meta.trainName, meta.trainType, meta.scheduleStations || []);

      // 1B. Live Internet Search Grounding
      let liveData: LiveInternetData = {
        query: '',
        newsHeadlines: [],
        verifiedFacts: [],
        recentAdvisories: [],
        summary: '',
        sourceLinks: []
      };
      if (options.enableWebSearch !== false) {
        try {
          winstonLogger.info(`[TRAIN_GUIDE_SEARCH] Searching live internet data for Train ${rawTrainNo} (${meta.trainName})...`);
          liveData = await newsInternetSearchService.searchLiveInternetData(
            rawTrainNo,
            meta.trainName,
            options.customKeywords
          );
        } catch (searchErr: any) {
          winstonLogger.warn(`[TRAIN_GUIDE_SEARCH_WARN] Live internet search failed: ${searchErr.message}`);
        }
      }

      // 2. Build Halts Table summary context for prompt
      let haltsContext = '';
      if (meta.scheduleStations && meta.scheduleStations.length > 0) {
        haltsContext = meta.scheduleStations
          .slice(0, 25)
          .map((s, idx) => `${idx + 1}. ${s.station_name || s.station_code || 'Stop'} (${s.station_code || ''}) Arr: ${s.arrival_time || s.arrival || 'Source'} Dep: ${s.departure_time || s.departure || 'Dest'} Halt: ${s.halt || '2 min'}`)
          .join('\n');
      }

      // 3. Assemble Prompt for AI
      let webGroundingContext = '';
      if (liveData.summary) {
        webGroundingContext += `\n- Verified Web Facts (Wikipedia / Official): ${liveData.summary}`;
      }
      if (liveData.newsHeadlines && liveData.newsHeadlines.length > 0) {
        const headlinesStr = liveData.newsHeadlines
          .slice(0, 4)
          .map((h: any) => `"${h.title}" (${h.source})`)
          .join('; ');
        webGroundingContext += `\n- Recent Real-Time News & Operational Headlines: ${headlinesStr}`;
      }
      if (options.customKeywords && options.customKeywords.trim()) {
        webGroundingContext += `\n- Target Keywords to Naturally Weave Into Content & Headings: "${options.customKeywords.trim()}"`;
      }

      let specialTopicInstructions = '';
      if (focusTopics.includes('cancellation_refund')) {
        specialTopicInstructions += `\n- CANCELLATION & REFUND REQUIREMENTS: Provide an authoritative table detailing deduction slabs (>48h flat clerkage, 48-12h 25%, 12-4h 50%, <4h/charting 0% refund), RAC/WL rules, auto-refund on railway cancellations, and TDR conditions.`;
      }
      if (focusTopics.includes('flight_vs_train')) {
        specialTopicInstructions += `\n- FLIGHT VS TRAIN REQUIREMENTS: Provide a side-by-side comparison table between Train and Airplane covering door-to-door transit time, 15kg baggage limits vs 40kg, flat horizontal sleeping berths vs cramped economy chairs, and last-minute price surges.`;
      }

      const languageInstruction = language === 'hi'
        ? `IMPORTANT: Write the entire article, headlines, tables, tips, advice, and FAQs in high-quality, professional HINDI (Devanagari script). Ensure natural railway terms (जैसे समय सारणी, ठहराव, कोच संरचना, तत्काल बुकिंग, रिफंड नियम, स्प्लिट जर्नी विकल्प).`
        : `Write in authoritative, polished travel journalism English with clean structure, crisp tables, and practical passenger tips.`;

      const prompt = `
You are an expert Indian Railways travel journalist and technical analyst writing a comprehensive guide for Trayago.in.
Generate a complete, authoritative, and SEO-optimized guide for:
- Train Number: ${rawTrainNo}
- Train Name: ${meta.trainName}
- Train Category: ${profile.categoryLabelEn}
- Operating Route: ${meta.source || 'Origin'} to ${meta.destination || 'Destination'}
- Selected Focus Topics: ${focusTopics.join(', ')}
- Motive Power / Locomotive: ${profile.locoEn}
- Verified Coach Classes: ${profile.coachesEn.join('; ')} (CRITICAL: Do NOT mention Sleeper or General if not present in this list!)
- Catering Policy: ${profile.cateringEn}
- Fare Structure: ${profile.fareEn}
${webGroundingContext ? `- Real-Time Web Grounding & Keywords:${webGroundingContext}` : ''}
${specialTopicInstructions ? `- Special Topic Instructions:${specialTopicInstructions}` : ''}
${haltsContext ? `- Verified Key Stops:\n${haltsContext}` : ''}

${languageInstruction}

STRUCTURE AND CONTENT REQUIREMENTS:
1. Title: Catchy, high-search-intent headline directly matching the selected topics and keywords.
2. Summary: 2 concise paragraphs providing an executive overview of the train service.
3. Content: Markdown with clean ## headings, accurate coach classes, timetable table, pro travel tips, and requested comparison/refund tables.
4. Passenger Advice: Actionable commuter advice.
5. Key Takeaways: 4 bullet takeaways.
6. FAQs: 4 realistic passenger questions and clear answers.
7. SEO Title: Max 60 characters, keyword rich.
8. Meta Description: Max 155 characters.

CRITICAL FACTUAL AND SAFETY RESTRAINTS:
- Do NOT output prompt meta-commentary, prompt debugging notes, or headings/phrases like "Target Keywords Analyzed" or "विशेष विश्लेषण विषय" anywhere in the content or summary.
- Do NOT fabricate or speculate on specific locomotive classes (such as WAP-7 or EMD) or inaugural dates unless officially verified.
- If intermediate stop data has fewer than 3 stops, describe the timetable as a Route Overview with terminal stations, NOT a verified timetable.

Return ONLY a valid JSON object matching this exact schema:
{
  "title": "Headline string",
  "seo_title": "SEO title <= 60 chars",
  "meta_description": "Meta description <= 155 chars",
  "summary": "2 paragraph summary string",
  "content": "Full markdown content with ## subheadings and tables",
  "passenger_advice": "Actionable commuter advice string",
  "key_takeaways": ["Takeaway 1", "Takeaway 2", "Takeaway 3", "Takeaway 4"],
  "faqs": [{ "question": "Question text?", "answer": "Answer text." }],
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
              return await (provider as any).executeDeepSeekCall(prompt, true, 25000, 'TRAIN_GUIDE_GEN');
            }
            return await (provider as any).executeGeminiCall(prompt, true, 25000, 'TRAIN_GUIDE_GEN');
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

      // If AI did not return a valid result, use deterministic synthesis
      if (!generated || !generated.title || !generated.content) {
        winstonLogger.info(`[TRAIN_GUIDE_SYNTH] Using high-authority deterministic editorial synthesizer for Train ${rawTrainNo}`);
        generated = this.synthesizeDeterministicGuide(
          rawTrainNo,
          meta,
          language,
          focusAngle,
          focusTopics,
          liveData,
          options.customKeywords
        );
      }

      // 5. Inject deterministic internal links (Live Status, PNR, Split Journey)
      const linkedContent = newsAutoCuratorService.injectDeterministicInternalLinks(
        generated.content,
        [rawTrainNo]
      );
      const sanitizedContent = cleanPromptLeaks(linkedContent);

      // 6. Format Final Payload
      const now = new Date().toISOString();
      const status = autoPublish ? 'PUBLISHED' : 'AI_DRAFTED';

      const payload = {
        id: crypto.randomUUID(),
        title: generated.title.trim(),
        slug: canonicalSlug,
        seo_title: truncateToWordBoundary(generated.seo_title || generated.title, 60),
        meta_description: truncateToWordBoundary(generated.meta_description || generated.summary, 155),
        summary: generated.summary.trim(),
        content: sanitizedContent,
        passenger_advice: generated.passenger_advice?.trim() || null,
        key_takeaways: Array.isArray(generated.key_takeaways) ? generated.key_takeaways : [],
        faq: Array.isArray(generated.faqs) ? generated.faqs : [],
        category: 'Train Guide',
        status,
        published_at: now,
        updated_at: now,
        source_name: 'Indian Railways Timetable & Public Schedules',
        source_url: `https://www.trayago.in/live/${rawTrainNo}`,
        image_url: coverImage,
        affected_trains: [rawTrainNo],
        affected_stations: Array.isArray(generated.affected_stations) && generated.affected_stations.length > 0
          ? generated.affected_stations
          : [meta.source, meta.destination].filter(Boolean),
        relevance_score: 95
      };

      // 7. Insert or Update in Supabase
      if (isSupabaseConfigured()) {
        const { data: existing } = await supabase
          .from('railway_news')
          .select('id')
          .eq('slug', canonicalSlug)
          .maybeSingle();

        let inserted: any = null;
        let insertError: any = null;

        if (existing && existing.id) {
          const { data: updated, error: updErr } = await supabase
            .from('railway_news')
            .update({
              title: payload.title,
              seo_title: payload.seo_title,
              meta_description: payload.meta_description,
              summary: payload.summary,
              content: payload.content,
              passenger_advice: payload.passenger_advice,
              key_takeaways: payload.key_takeaways,
              faq: payload.faq,
              category: payload.category,
              status: payload.status,
              published_at: now,
              updated_at: now,
              image_url: payload.image_url,
              affected_trains: payload.affected_trains,
              affected_stations: payload.affected_stations,
              relevance_score: payload.relevance_score
            })
            .eq('id', existing.id)
            .select('id, slug, title, status')
            .single();

          inserted = updated;
          insertError = updErr;
        } else {
          const { data: ins, error: insErr } = await supabase
            .from('railway_news')
            .insert(payload)
            .select('id, slug, title, status')
            .single();

          inserted = ins;
          insertError = insErr;
        }

        if (insertError) {
          winstonLogger.error(`[TRAIN_GUIDE_DB_ERROR] ${insertError.message}`);
          return { success: false, error: `Database save failed: ${insertError.message}` };
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
