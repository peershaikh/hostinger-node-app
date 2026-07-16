import { NextFunction, Request, Response } from 'express';
import { featureFlags } from '../config/featureFlags';
import { UniversalEventNames, UniversalEventName } from '../constants/eventTaxonomy';
import { universalEventEmitter } from '../services/universalEventEmitter';
import {
  createProviderCallId,
  createUniversalRequestContext,
  enrichResponseWithUniversalIds,
  ensureSearchId
} from '../utils/universalIds';

const routeKey = (req: Request) => `${req.method.toUpperCase()} ${req.path}`;

const classifyRequest = (req: Request): UniversalEventName | null => {
  const path = req.path;

  if (path.includes('/search')) return UniversalEventNames.SEARCH_STARTED;
  if (path.includes('/same-train-rescue')) return UniversalEventNames.RESCUE_EVALUATED;
  if (path.includes('/availability')) return UniversalEventNames.PROVIDER_CALL_STARTED;
  if (path.includes('/rescue-book')) return UniversalEventNames.BOOKING_PLACEHOLDER;
  if (path.includes('/pnr/')) return UniversalEventNames.PNR_CHECKED;
  if (path.includes('/live-train/') || path.includes('/live/')) return UniversalEventNames.LIVE_TRAIN_CHECKED;

  return null;
};

const completionEvents = (req: Request, res: Response, body: any): UniversalEventName[] => {
  const path = req.path;
  const failed = res.statusCode >= 400 || body?.success === false;

  if (path.includes('/search')) {
    const events: UniversalEventName[] = [
      failed ? UniversalEventNames.SEARCH_FAILED : UniversalEventNames.SEARCH_COMPLETED
    ];
    const splitCount = Array.isArray(body?.split) ? body.split.length : 0;
    if (path.includes('Advanced') || path.includes('advanced') || body?.split_recommended !== undefined) {
      events.push(UniversalEventNames.SPLIT_EVALUATED);
      events.push(splitCount > 0 ? UniversalEventNames.SPLIT_VALID : UniversalEventNames.SPLIT_REJECTED);
    }
    return events;
  }

  if (path.includes('/same-train-rescue')) {
    const rescueCount = Array.isArray(body?.rescueOptions) ? body.rescueOptions.length : 0;
    return [
      rescueCount > 0 ? UniversalEventNames.RESCUE_FOUND : UniversalEventNames.RESCUE_NOT_FOUND
    ];
  }

  if (path.includes('/availability')) {
    return [
      failed ? UniversalEventNames.PROVIDER_CALL_FAILED : UniversalEventNames.PROVIDER_CALL_COMPLETED
    ];
  }

  return [];
};

const getUserId = (req: Request): string | null => {
  const userId = req.headers['x-user-id'];
  return typeof userId === 'string' && userId.trim() ? userId.trim() : null;
};

const getRouteMetadata = (req: Request) => ({
  route: routeKey(req),
  source: (req.body?.source || req.query?.source || req.body?.from || req.query?.from || req.body?.fromStation || req.query?.fromStation || null) as string | null,
  destination: (req.body?.destination || req.query?.destination || req.body?.to || req.query?.to || req.body?.toStation || req.query?.toStation || null) as string | null,
  trainNo: (req.body?.trainNo || req.query?.trainNo || req.params?.trainNo || null) as string | null,
  pnr: (req.params?.pnr || req.body?.pnr || null) as string | null
});

export const universalInstrumentationMiddleware = (req: Request, res: Response, next: NextFunction) => {
  const reqAny = req as any;
  reqAny.universalIds = createUniversalRequestContext(req);

  const startedAt = Date.now();
  const initialEvent = classifyRequest(req);
  const shouldTreatAsSearch = req.path.includes('/search') || req.path.includes('/same-train-rescue');
  const shouldTreatAsProviderCall = req.path.includes('/availability');

  if (shouldTreatAsSearch) {
    ensureSearchId(req);
  }

  if (shouldTreatAsProviderCall) {
    reqAny.providerCallId = createProviderCallId();
  }

  if (featureFlags.eventStream && initialEvent) {
    const metadata = getRouteMetadata(req);
    universalEventEmitter.emit({
      eventName: initialEvent,
      requestId: reqAny.universalIds.requestId,
      searchId: reqAny.universalIds.searchId,
      providerCallId: reqAny.providerCallId,
      guestId: reqAny.universalIds.guestId,
      userId: getUserId(req),
      route: metadata.route,
      source: metadata.source || undefined,
      mode: 'rail',
      metadata
    });
  }

  const originalJson = res.json.bind(res);
  res.json = ((body?: any) => {
    const responseBody = featureFlags.universalIds
      ? enrichResponseWithUniversalIds(body, reqAny.universalIds!)
      : body;

    if (featureFlags.eventStream) {
      const metadata = getRouteMetadata(req);
      for (const eventName of completionEvents(req, res, body)) {
        universalEventEmitter.emit({
          eventName,
          requestId: reqAny.universalIds?.requestId,
          searchId: reqAny.universalIds?.searchId,
          providerCallId: reqAny.providerCallId,
          guestId: reqAny.universalIds?.guestId,
          userId: getUserId(req),
          route: metadata.route,
          source: metadata.source || undefined,
          mode: 'rail',
          status: String(res.statusCode),
          latencyMs: Date.now() - startedAt,
          metadata
        });
      }
    }

    return originalJson(responseBody);
  }) as Response['json'];

  next();
};

