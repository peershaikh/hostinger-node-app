import crypto from 'crypto';
import { Request } from 'express';

export interface UniversalRequestContext {
  requestId: string;
  searchId?: string;
  guestId?: string;
}

const scopedId = (prefix: string) => `${prefix}_${crypto.randomUUID()}`;

const hashGuestSource = (value: string) =>
  crypto.createHash('sha256').update(value).digest('hex').slice(0, 32);

export const createEventId = () => scopedId('evt');
export const createRequestId = () => scopedId('req');
export const createSearchId = () => scopedId('srch');
export const createOptionId = () => scopedId('opt');
export const createSegmentId = () => scopedId('seg');
export const createProviderCallId = () => scopedId('prov');

export const resolveGuestId = (req: Request): string | undefined => {
  const userId = req.headers['x-user-id'];
  if (typeof userId === 'string' && userId.trim()) return undefined;

  const existingGuestId = req.headers['x-guest-id'];
  if (typeof existingGuestId === 'string' && existingGuestId.trim()) {
    return existingGuestId.trim();
  }

  const deviceId = req.headers['x-device-id'];
  const sessionId = req.headers['x-session-id'];
  const userAgent = req.headers['user-agent'] || '';
  const ip = req.ip || req.socket.remoteAddress || '';
  const seed = [deviceId, sessionId, ip, userAgent].filter(Boolean).join('|');

  if (!seed) return scopedId('guest');
  return `guest_${hashGuestSource(seed)}`;
};

export const createUniversalRequestContext = (req: Request): UniversalRequestContext => ({
  requestId: createRequestId(),
  guestId: resolveGuestId(req)
});

export const ensureSearchId = (req: Request): string => {
  const reqAny = req as any;
  if (!reqAny.universalIds) {
    reqAny.universalIds = createUniversalRequestContext(req);
  }
  if (!reqAny.universalIds.searchId) {
    reqAny.universalIds.searchId = createSearchId();
  }
  return reqAny.universalIds.searchId;
};

const enrichSegment = (segment: any) => {
  if (!segment || typeof segment !== 'object' || Array.isArray(segment)) return segment;
  return {
    ...segment,
    universalIds: {
      ...(segment.universalIds || {}),
      segmentId: segment.universalIds?.segmentId || createSegmentId()
    }
  };
};

const enrichOption = (option: any) => {
  if (!option || typeof option !== 'object' || Array.isArray(option)) return option;

  const enriched = {
    ...option,
    universalIds: {
      ...(option.universalIds || {}),
      optionId: option.universalIds?.optionId || createOptionId()
    }
  };

  if (Array.isArray(option.legs)) {
    enriched.legs = option.legs.map(enrichSegment);
  }
  if (option.leg1) {
    enriched.leg1 = enrichSegment(option.leg1);
  }
  if (option.leg2) {
    enriched.leg2 = enrichSegment(option.leg2);
  }

  return enriched;
};

const OPTION_ARRAY_KEYS = [
  'all',
  'best',
  'direct',
  'split',
  'smart_routes',
  'rescueOptions',
  'partialRescueOptions'
];

export const enrichResponseWithUniversalIds = (
  payload: any,
  context: UniversalRequestContext
) => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;

  const enriched: Record<string, any> = {
    ...payload,
    universalIds: {
      ...(payload.universalIds || {}),
      requestId: context.requestId,
      ...(context.searchId ? { searchId: context.searchId } : {}),
      ...(context.guestId ? { guestId: context.guestId } : {})
    }
  };

  for (const key of OPTION_ARRAY_KEYS) {
    if (Array.isArray(payload[key])) {
      enriched[key] = payload[key].map(enrichOption);
    }
  }

  return enriched;
};

