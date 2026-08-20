import crypto from 'crypto';

const STOP_WORDS = new Set([
  'the', 'is', 'at', 'which', 'on', 'for', 'due', 'to', 'in', 'and', 'a', 'an', 'by', 'of', 'with', 'from', 'as', 'into', 'that', 'this'
]);

/**
 * 64-bit SimHash and Token-Shingle Algorithm for Near-Duplicate News Detection.
 *
 * Designed to detect syndicated articles, wire-service copies (PTI/ANI),
 * and minor editorial headline/summary variations across different RSS feeds.
 */
export class SimHash {
  /**
   * Tokenizes text into normalized word unigrams and bigrams, filtering stop words.
   */
  public static tokenize(text: string): string[] {
    if (!text) return [];

    const normalized = text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    const words = normalized.split(' ').filter(w => w.length > 1 && !STOP_WORDS.has(w));
    if (words.length === 0) return [];

    const tokens: string[] = [...words];
    for (let i = 0; i < words.length - 1; i++) {
      tokens.push(`${words[i]}_${words[i + 1]}`);
    }

    return tokens;
  }

  /**
   * Computes a 64-bit BigInt hash for a token using MD5.
   */
  private static hashToken(token: string): bigint {
    const md5 = crypto.createHash('md5').update(token).digest();
    return md5.readBigUInt64BE(0);
  }

  /**
   * Computes the 64-bit SimHash fingerprint for an input text.
   * Returns a 16-character hexadecimal string.
   */
  public static compute(text: string): string {
    const tokens = this.tokenize(text);
    if (tokens.length === 0) {
      return '0000000000000000';
    }

    const tokenWeights = new Map<string, number>();
    for (const t of tokens) {
      tokenWeights.set(t, (tokenWeights.get(t) || 0) + 1);
    }

    const vector = new Array<number>(64).fill(0);

    for (const [token, weight] of tokenWeights.entries()) {
      const hash = this.hashToken(token);

      for (let bit = 0; bit < 64; bit++) {
        const isOne = (hash & (1n << BigInt(bit))) !== 0n;
        if (isOne) {
          vector[bit] += weight;
        } else {
          vector[bit] -= weight;
        }
      }
    }

    let fingerprint = 0n;
    for (let bit = 0; bit < 64; bit++) {
      if (vector[bit] > 0) {
        fingerprint |= (1n << BigInt(bit));
      }
    }

    return fingerprint.toString(16).padStart(16, '0');
  }

  /**
   * Computes the Hamming distance (number of bit differences) between two 64-bit SimHash hex strings.
   */
  public static hammingDistance(hash1: string, hash2: string): number {
    if (!hash1 || !hash2) return 64;

    try {
      const b1 = BigInt(`0x${hash1}`);
      const b2 = BigInt(`0x${hash2}`);
      let xor = b1 ^ b2;

      let distance = 0;
      while (xor > 0n) {
        distance += Number(xor & 1n);
        xor >>= 1n;
      }

      return distance;
    } catch {
      return 64;
    }
  }

  /**
   * Calculates Jaccard token similarity between two texts (0.0 to 1.0).
   */
  public static jaccardSimilarity(text1: string, text2: string): number {
    const set1 = new Set(this.tokenize(text1));
    const set2 = new Set(this.tokenize(text2));
    if (set1.size === 0 || set2.size === 0) return 0;

    let intersection = 0;
    for (const item of set1) {
      if (set2.has(item)) intersection++;
    }
    const union = set1.size + set2.size - intersection;
    return union > 0 ? intersection / union : 0;
  }

  /**
   * Determines if two pieces of content are near-duplicates using SimHash distance (<= 12).
   */
  public static isNearDuplicate(hash1: string, hash2: string, thresholdBits: number = 12): boolean {
    return this.hammingDistance(hash1, hash2) <= thresholdBits;
  }
}
