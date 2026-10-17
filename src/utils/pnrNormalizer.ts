import { winstonLogger } from '../middleware/logger';

export interface NormalizedPassenger {
  name: string;
  booking_status: string;
  current_status: string;
}

export interface NormalizedPnrResponse {
  pnr: string;
  train_no: string;
  train_name: string;
  journey_date: string;
  source_code: string;
  source_name: string;
  destination_code: string;
  destination_name: string;
  boarding_station: string;
  chart_status: string;
  class: string;
  quota: string;
  passengers: NormalizedPassenger[];
}

export const formatStatus = (type: any, num: any): string => {
  const cleanType = type !== undefined && type !== null ? String(type).toUpperCase().trim() : "";
  const cleanNum = num !== undefined && num !== null ? String(num).trim() : "";
  if (!cleanType) return "Unknown";
  if (!cleanNum || cleanNum === "0") return cleanType;
  if (cleanType === cleanNum) return cleanType;
  return `${cleanType}/${cleanNum}`;
};

export function normalizeRawPnr(rawStatus: any): NormalizedPnrResponse {
  if (!rawStatus) {
    throw new Error("Cannot normalize null or undefined PNR response");
  }

  // Handle wrappers
  const pData = rawStatus.data || rawStatus;

  // Extract train details
  const train_no = String(pData.trainNumber || pData.train?.number || pData.train_no || pData.trainNo || '00000').trim();
  const train_name = String(pData.trainName || pData.train?.name || pData.train_name || 'Unknown Train').trim();

  // Extract journey date
  const journey_date = String(pData.journey?.dateOfJourney || pData.boardingDay || pData.journey?.departure || pData.journey_date || pData.journeyDate || 'N/A').trim();

  // Extract stations
  const source_code = String(pData.journey?.source?.code || pData.from?.code || pData.journey?.from?.code || pData.source_code || '').trim();
  const source_name = String(pData.journey?.source?.name || pData.from?.name || pData.journey?.from?.name || pData.source_name || '').trim();

  const destination_code = String(pData.journey?.destination?.code || pData.to?.code || pData.journey?.to?.code || pData.destination_code || '').trim();
  const destination_name = String(pData.journey?.destination?.name || pData.to?.name || pData.journey?.to?.name || pData.destination_name || '').trim();

  const boarding_station = String(pData.journey?.boardingPoint?.name || pData.boardingStation?.name || pData.journey?.from?.name || '').trim();

  // Chart status
  const chart_status = String(pData.chart?.status || pData.chartStatus || pData.chart_status || 'Chart Not Prepared').trim();

  // Quota & Class
  const classVal = String(pData.journey?.class || pData.class || pData.journeyClass || pData.bookingClass || 'Unknown').trim();
  const quota = String(pData.journey?.quota || pData.quota || 'GN').trim();

  // Passengers
  const rawPassengers = Array.isArray(pData.passengers) ? pData.passengers : Array.isArray(pData.data?.passengers) ? pData.data.passengers : [];

  const passengers = rawPassengers.map((p: any, idx: number) => {
    // Enforce strict anonymous passenger labels to eliminate PII leakage on public endpoints
    const name = `Passenger ${idx + 1}`;
    
    // Booking status
    let booking_status = "Unknown";
    if (p.booking?.details) {
      booking_status = p.booking.details;
    } else {
      const type = p.bookingStatus || p.status || p.booking_status || p.booking?.status;
      const num = p.bookingNumber || p.bookingNo || p.seatNumber || p.booking?.berthNo;
      booking_status = formatStatus(type, num);
    }

    // Current status
    let current_status = "Unknown";
    if (p.current?.details) {
      current_status = p.current.details;
    } else {
      const type = p.currentStatus || p.currentNumber || p.seat || p.status || p.current?.status;
      const num = p.currentNumber || p.seat || p.seatNumber || p.current?.berthNo;
      current_status = formatStatus(type, num);
    }

    return {
      name,
      booking_status,
      current_status
    };
  });

  return {
    pnr: String(pData.pnr || pData.PNR || pData.pnrNo || pData.pnrNumber || '').trim(),
    train_no,
    train_name,
    journey_date,
    source_code,
    source_name,
    destination_code,
    destination_name,
    boarding_station,
    chart_status,
    class: classVal,
    quota,
    passengers
  };
}

/**
 * Sanitizes raw and parsed PNR payloads before logging.
 * Strips all passenger names, contact numbers, emails, addresses, and auth credentials.
 */
export function sanitizePnrPayloadForLogging(payload: any): any {
  if (!payload || typeof payload !== 'object') {
    return payload;
  }

  const SENSITIVE_KEY_REGEX = /name|passenger|phone|mobile|email|token|secret|password|apikey|auth|credential|address|dob/i;

  const sanitizeRecursive = (val: any, parentKey?: string): any => {
    if (val === null || val === undefined) return val;

    if (Array.isArray(val)) {
      const lowerParent = (parentKey || '').toLowerCase();
      if (lowerParent.includes('passenger')) {
        return val.map((item: any, idx: number) => {
          if (item && typeof item === 'object') {
            return {
              name: `Passenger ${idx + 1}`,
              booking_status: item.booking_status || item.bookingStatus || item.status || 'Unknown',
              current_status: item.current_status || item.currentStatus || item.status || 'Unknown'
            };
          }
          return `Passenger ${idx + 1}`;
        });
      }
      return val.map(item => sanitizeRecursive(item, parentKey));
    }

    if (typeof val === 'object') {
      const sanitizedObj: Record<string, any> = {};
      for (const [k, v] of Object.entries(val)) {
        const lowerK = k.toLowerCase();
        // Allow safe train metadata fields that contain the word "name"
        if (lowerK === 'trainname' || lowerK === 'train_name' || lowerK === 'sourcename' || lowerK === 'source_name' || lowerK === 'destinationname' || lowerK === 'destination_name' || lowerK === 'stationname' || lowerK === 'station_name') {
          sanitizedObj[k] = v;
          continue;
        }

        // Handle passengers array explicitly to preserve anonymous status while stripping PII
        if (lowerK === 'passengers') {
          sanitizedObj[k] = sanitizeRecursive(v, k);
          continue;
        }

        if (SENSITIVE_KEY_REGEX.test(k)) {
          sanitizedObj[k] = '[REDACTED]';
        } else {
          sanitizedObj[k] = sanitizeRecursive(v, k);
        }
      }
      return sanitizedObj;
    }

    return val;
  };

  return sanitizeRecursive(payload);
}
