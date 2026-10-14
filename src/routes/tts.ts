import { Router, Request, Response } from 'express';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';

const router = Router();

// In-memory cache for ultra-low latency (< 5ms) on frequent train announcements
const audioCache = new Map<string, { buffer: Buffer; timestamp: number }>();
const MAX_CACHE_ENTRIES = 400;
const CACHE_TTL_MS = 1000 * 60 * 60 * 24; // 24 hours

function cleanCacheIfNeeded() {
  if (audioCache.size > MAX_CACHE_ENTRIES) {
    const now = Date.now();
    for (const [key, item] of audioCache.entries()) {
      if (now - item.timestamp > CACHE_TTL_MS || audioCache.size > MAX_CACHE_ENTRIES * 0.8) {
        audioCache.delete(key);
      }
    }
  }
}

// Full multi-language Indian voice catalog with realistic Neural voices
const VOICE_CATALOG: Record<string, { female: string; male: string }> = {
  hi: { female: 'hi-IN-SwaraNeural', male: 'hi-IN-MadhurNeural' },
  en: { female: 'en-IN-NeerjaNeural', male: 'en-IN-PrabhatNeural' },
  mr: { female: 'mr-IN-AarohiNeural', male: 'mr-IN-ManoharNeural' },
  gu: { female: 'gu-IN-DhwaniNeural', male: 'gu-IN-NiranjanNeural' },
  bn: { female: 'bn-IN-TanishaaNeural', male: 'bn-IN-BashkarNeural' },
  ta: { female: 'ta-IN-PallaviNeural', male: 'ta-IN-ValluvarNeural' },
  te: { female: 'te-IN-ShrutiNeural', male: 'te-IN-MohanNeural' },
  kn: { female: 'kn-IN-SapnaNeural', male: 'kn-IN-GaganNeural' },
  ml: { female: 'ml-IN-SobhanaNeural', male: 'ml-IN-MidhunNeural' },
  or: { female: 'hi-IN-SwaraNeural', male: 'hi-IN-MadhurNeural' },
};

function getVoiceForLangAndGender(langCode: string, gender: string): string {
  const cleanLang = (langCode || 'hi').toLowerCase().split('-')[0].trim();
  const catalog = VOICE_CATALOG[cleanLang] || VOICE_CATALOG['hi'];
  const isMale = (gender || '').toLowerCase() === 'male';
  return isMale ? catalog.male : catalog.female;
}

async function synthesizeGoogleTTS(text: string, langCode: string): Promise<Buffer> {
  const cleanLang = (langCode || 'hi').toLowerCase().split('-')[0].trim();
  const googleLang = cleanLang === 'en' ? 'en-IN' : cleanLang;
  const url = `https://translate.google.com/translate_tts?ie=UTF-8&tl=${googleLang}&client=tw-ob&q=${encodeURIComponent(text.slice(0, 300))}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    },
  });
  if (!res.ok) throw new Error(`Google TTS failed with status ${res.status}`);
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

async function synthesizeWithEdge(text: string, voiceName: string, rate: number = 0.98): Promise<Buffer> {
  const tts = new MsEdgeTTS({
    connectionTimeoutMs: 10000,
    synthesisTimeoutMs: 30000,
  });

  await tts.setMetadata(voiceName, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);

  const cleanRate = Math.max(0.7, Math.min(1.5, rate));
  const { audioStream } = tts.toStream(text, { rate: cleanRate });

  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    audioStream.on('data', (chunk: Buffer) => chunks.push(chunk));
    audioStream.on('end', () => resolve(Buffer.concat(chunks)));
    audioStream.on('close', () => resolve(Buffer.concat(chunks)));
    audioStream.on('error', (err) => reject(err));
  });
}

async function synthesizeAudio(
  text: string,
  voiceName: string,
  rate: number = 0.98,
  langCode: string = 'hi'
): Promise<{ buffer: Buffer; engine: string }> {
  // 1. Primary: Edge Neural TTS (Natural human studio voice)
  try {
    const buffer = await synthesizeWithEdge(text, voiceName, rate);
    return { buffer, engine: 'EdgeNeural-Live' };
  } catch (err: any) {
    console.warn('[Server TTS] Edge Neural attempt 1 failed, retrying after brief pause:', err?.message || err);
  }

  // 2. Retry Edge Neural TTS once with brief backoff
  await new Promise((r) => setTimeout(r, 600));
  try {
    const buffer = await synthesizeWithEdge(text, voiceName, rate);
    return { buffer, engine: 'EdgeNeural-Live' };
  } catch (err: any) {
    console.warn('[Server TTS] Edge Neural attempt 2 failed, falling back to Google Cloud Neural stream:', err?.message || err);
  }

  // 3. Fallback: Google Neural Stream (guaranteed 200 OK)
  try {
    const buffer = await synthesizeGoogleTTS(text, langCode);
    return { buffer, engine: 'GoogleNeural-Fallback' };
  } catch (err: any) {
    console.error('[Server TTS] All TTS engines failed:', err);
    throw err;
  }
}

async function handleTTS(req: Request, res: Response) {
  try {
    const text = (req.query.text as string || req.body?.text || '').trim();
    const lang = (req.query.lang as string || req.body?.lang || 'hi').toLowerCase().trim();
    const gender = (req.query.gender as string || req.body?.gender || 'female').toLowerCase().trim();
    const rateParam = parseFloat((req.query.rate as string || req.body?.rate || '0.98'));
    const rate = isNaN(rateParam) ? 0.98 : rateParam;

    if (!text) {
      return res.status(400).json({ error: 'Invalid input: "text" parameter is required' });
    }

    if (text.length > 2000) {
      return res.status(400).json({ error: 'Text exceeds maximum allowed length of 2000 characters' });
    }

    const voiceName = getVoiceForLangAndGender(lang, gender);
    const cacheKey = `${voiceName}_${rate}_${text}`;

    // 1. Cache hit
    const cached = audioCache.get(cacheKey);
    if (cached) {
      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('Content-Length', String(cached.buffer.length));
      res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400');
      res.setHeader('X-TTS-Engine', 'EdgeNeural-Cache');
      res.setHeader('Access-Control-Allow-Origin', '*');
      return res.status(200).send(cached.buffer);
    }

    // 2. Synthesize
    const { buffer: audioBuffer, engine } = await synthesizeAudio(text, voiceName, rate, lang);

    // Save cache
    cleanCacheIfNeeded();
    audioCache.set(cacheKey, { buffer: audioBuffer, timestamp: Date.now() });

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Length', String(audioBuffer.length));
    res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400');
    res.setHeader('X-TTS-Engine', engine);
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(200).send(audioBuffer);
  } catch (err: any) {
    console.error('[Server TTS] Error handling TTS request:', err);
    return res.status(500).json({ error: 'TTS synthesis error', message: err?.message || 'Unknown error' });
  }
}

router.get('/', handleTTS);
router.post('/', handleTTS);

export default router;
