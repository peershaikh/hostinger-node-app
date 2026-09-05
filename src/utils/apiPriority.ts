import { winstonLogger } from '../middleware/logger';
import { metricsService } from '../services/metricsService';
import { railProviderResolver } from '../services/railProviderResolver';
import { ProviderCapabilities } from '../services/railProviderRegistry';

export interface PriorityOperations<T> {
  // Strict Naming (Recommended)
  irctc?: () => Promise<T | null>;
  railradar?: () => Promise<T | null>;
  railyatri?: () => Promise<T | null>;
  confirmtkt?: () => Promise<T | null>;
  rapid?: () => Promise<T | null>;
  db?: () => Promise<T | null>;

  // Alias support (backward compatible)
  primary?: () => Promise<T | null>;
  fallback1?: () => Promise<T | null>;
  fallback2?: () => Promise<T | null>;
  dbFallback?: () => Promise<T | null>;
}

const isMeaningfulResult = (result: any): boolean => {
  if (!result) return false;
  if (result.not_running || result.expected_no_data) return false;
  if (Array.isArray(result)) return result.length > 0;
  if (typeof result === 'object') return Object.keys(result).length > 0;
  return true;
};

export async function fetchWithPriority<T>(
  ops: PriorityOperations<T>,
  feature: keyof ProviderCapabilities = 'liveTracking'
): Promise<T | null> {
  // 1. Dynamically resolve providers based on Admin priority and capabilities for this feature
  let chain: string[] = [];
  try {
    const resolvedProviders = await railProviderResolver.resolveProviderChain(feature);
    chain = resolvedProviders.map(p => p.providerId.toUpperCase());
  } catch {
    chain = feature === 'pnr' ? ['IRCTC', 'RAILRADAR'] : ['IRCTC', 'RAILRADAR', 'CONFIRMTKT', 'RAILYATRI'];
  }

  // Ensure DB fallback is always at the end if not explicitly present
  if (!chain.includes('DATABASE')) {
    chain.push('DATABASE');
  }

  winstonLogger.info(`[API_PRIORITY_DYNAMIC] Priority Chain: ${chain.join(' → ')}`);

  const fnMap: Record<string, (() => Promise<T | null>) | undefined> = {
    IRCTC: ops.irctc || ops.primary,
    RAILRADAR: ops.railradar,
    RAILYATRI: ops.railyatri,
    CONFIRMTKT: ops.confirmtkt || ops.fallback1,
    RAPIDAPI: ops.rapid,
    DATABASE: ops.db || ops.dbFallback,
  };

  for (const providerId of chain) {
    const fn = fnMap[providerId];
    if (!fn) continue;

    const startTime = Date.now();
    try {
      winstonLogger.info(`[API_DYNAMIC_ACTIVE] Attempting ${providerId}`);
      const result = await fn();
      const duration = Date.now() - startTime;
      const isExpectedNoData = Boolean(result && ((result as any).not_running || (result as any).expected_no_data));
      const isOk = isMeaningfulResult(result);
      if (providerId !== 'DATABASE' && !isExpectedNoData) {
        metricsService.recordProviderRequest(providerId, duration, isOk);
      }
      if (isOk) {
        winstonLogger.info(`[API_DYNAMIC_SUCCESS] ${providerId} returned valid data`);
        return result;
      }
    } catch (err: any) {
      const duration = Date.now() - startTime;
      if (providerId !== 'DATABASE') {
        metricsService.recordProviderRequest(providerId, duration, false);
      }
      winstonLogger.warn(`[API_DYNAMIC_FAILED] ${providerId}: ${err.message}`);
    }
  }

  return null;
}