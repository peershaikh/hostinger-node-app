/**
 * PHASE_5.1 — Mobile Phone Normalizer & Sanitizer
 * 
 * Provides strict E.164 normalization (+91XXXXXXXXXX) for Indian mobile numbers,
 * PII masking for operational logging, and validation helpers.
 */

/**
 * Normalizes an Indian mobile phone number to canonical E.164 format (+91XXXXXXXXXX).
 * 
 * Accepted valid formats:
 * - 10 digits starting with 6, 7, 8, or 9: "9876543210" -> "+919876543210"
 * - 11 digits starting with 0: "09876543210" -> "+919876543210"
 * - 12 digits starting with 91: "919876543210" -> "+919876543210"
 * - 13 chars with leading +91: "+919876543210" -> "+919876543210"
 * - Formatted strings with spaces, hyphens, brackets: "+91 98765-43210" -> "+919876543210"
 * 
 * Returns null if the phone number is invalid.
 */
export function normalizeIndianPhoneNumber(phone: string | null | undefined): string | null {
  if (!phone || typeof phone !== 'string') {
    return null;
  }

  // Strip all non-digit and non-plus characters
  const clean = phone.replace(/[\s\-\(\)\.]/g, '').trim();

  // Pattern matches:
  // - Optional leading '+'
  // - Optional '91' country code or trunk '0'
  // - Exactly 10 digits starting with 6, 7, 8, or 9
  const match = clean.match(/^(?:\+?91|0)?([6-9]\d{9})$/);
  if (!match) {
    return null;
  }

  return `+91${match[1]}`;
}

/**
 * Validates whether a given phone number can be normalized to a valid Indian mobile number.
 */
export function isValidIndianPhoneNumber(phone: string | null | undefined): boolean {
  return normalizeIndianPhoneNumber(phone) !== null;
}

/**
 * Masks a phone number for secure operational logging without exposing full PII.
 * Example: "+919876543210" -> "+9198****3210"
 */
export function maskPhoneNumber(phone: string | null | undefined): string {
  if (!phone || typeof phone !== 'string') return '[REDACTED]';
  const normalized = normalizeIndianPhoneNumber(phone) || phone.trim();
  if (normalized.length >= 10) {
    const prefix = normalized.slice(0, 5); // "+9198"
    const suffix = normalized.slice(-4);  // "3210"
    return `${prefix}****${suffix}`;
  }
  return '[REDACTED]';
}
