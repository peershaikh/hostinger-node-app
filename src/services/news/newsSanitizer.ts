/**
 * News Content & Image Sanitization Helpers
 *
 * Centralized utility for whole-word boundary truncation, prompt instruction leak removal,
 * and banned transit image prevention across Trayago news ingestion, generation, curation, and rendering.
 */

export const SAFE_RAILWAY_COVER_FALLBACK = 'https://www.trayago.in/og-image.png';

export const BANNED_IMAGE_PATTERNS: RegExp[] = [
  /photo-1544620347/i, // Unsplash bus image incorrectly mapped to train articles
  /photo-1509749837/i, // Unverified generic dark passenger car interior
];

/**
 * Checks whether an image URL matches known unverified, misleading, or banned stock photos.
 */
export function isBannedImageUrl(url?: string | null): boolean {
  if (!url || typeof url !== 'string') return false;
  const clean = url.trim();
  return BANNED_IMAGE_PATTERNS.some(pat => pat.test(clean));
}

/**
 * Checks whether an image URL is a valid, secure HTTP/HTTPS URL.
 */
export function isValidImageUrl(url?: string | null): boolean {
  if (!url || typeof url !== 'string') return false;
  const clean = url.trim();
  if (!clean.startsWith('http://') && !clean.startsWith('https://')) return false;
  if (isBannedImageUrl(clean)) return false;
  try {
    const parsed = new URL(clean);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Checks whether an image URL is a generic branding fallback or app icon.
 */
export function isFallbackImageUrl(url?: string | null): boolean {
  if (!url || typeof url !== 'string') return true;
  const clean = url.trim().toLowerCase();
  return (
    clean.includes('branding/og-image.png') ||
    clean.includes('og-image.png') ||
    clean.includes('og-image.jpg')
  );
}

/**
 * Resolves a safe image URL, substituting the verified 1200x630 branded railway fallback
 * if the URL is missing, banned, or an unsuitable square app icon.
 */
export function resolveSafeRailwayImage(url?: string | null): string {
  if (!url || typeof url !== 'string' || !url.trim().startsWith('http')) {
    return SAFE_RAILWAY_COVER_FALLBACK;
  }
  const clean = url.trim();
  if (isBannedImageUrl(clean) || clean.includes('branding/og-image.png')) {
    return SAFE_RAILWAY_COVER_FALLBACK;
  }
  return clean;
}

/**
 * Truncates text cleanly at a whole-word boundary without exceeding maxLength,
 * stripping trailing dangling punctuation (commas, colons, hyphens, semicolons, brackets).
 */
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

/**
 * Strips internal AI prompt instructions, debugging tags, and prompt leakage
 * from generated titles, summaries, and Markdown content.
 */
export function cleanPromptLeaks(content: string): string {
  if (!content || typeof content !== 'string') return '';
  return content
    .replace(/^>\s*\*\*Target Keywords Analyzed:\*\*.*$/gim, '')
    .replace(/^>\s*\*\*विशेष विश्लेषण विषय:\*\*.*$/gim, '')
    .replace(/Target Keywords Analyzed:?[^\n]*\n?/gi, '')
    .replace(/विशेष विश्लेषण विषय:?[^\n]*\n?/gi, '')
    .replace(/^>\s*\*\*Key Search Intent.*$/gim, '')
    .replace(/Prompt debugging notes?:?[^\n]*\n?/gi, '')
    .trim();
}
