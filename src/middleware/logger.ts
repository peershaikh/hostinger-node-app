import winston from 'winston';

function maskEmail(email: string): string {
  const parts = email.split('@');
  if (parts.length !== 2) return '********';
  const [username, domain] = parts;
  if (username.length <= 1) return email;
  return username[0] + '*'.repeat(username.length - 1) + '@' + domain;
}

function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 4) return '********';
  return digits.substring(0, 2) + '*'.repeat(digits.length - 4) + digits.substring(digits.length - 2);
}

function sanitizeString(str: string): string {
  let result = str;

  // 1. Mask Email
  result = result.replace(/([a-zA-Z0-9._%+-]+)(@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g, (match, username, domain) => {
    if (username.length <= 1) return match;
    return username[0] + '*'.repeat(username.length - 1) + domain;
  });

  // 2. Mask Authorization Bearer
  result = result.replace(/(bearer\s+)(\S+)/gi, '$1********');

  // 3. Mask Phone Numbers (10 digit format)
  result = result.replace(/(\+91|0)?\s*([6-9]\d{9})/g, (match, prefix, number) => {
    return (prefix || '') + number.substring(0, 2) + '*'.repeat(6) + number.substring(8, 10);
  });

  // 4. Mask URL Query Parameters
  result = result.replace(/(password|confirmpassword|token|accesstoken|refreshtoken|jwt|authorization|cookie|aadhaar|pan|pnr|otp)=([^&\s]+)/gi, '$1=********');

  return result;
}

function sanitizeValue(val: any, keyName?: string): any {
  if (val === null || val === undefined) return val;

  if (Array.isArray(val)) {
    return val.map(item => sanitizeValue(item, keyName));
  }

  if (val instanceof Date) return val;
  if (val instanceof RegExp) return val;

  if (typeof val === 'object') {
    const copy: any = {};
    for (const key of Object.keys(val)) {
      const cleanKey = key.toLowerCase().replace(/[-_]/g, '');
      const valType = typeof val[key];
      
      if (
        cleanKey === 'password' ||
        cleanKey === 'confirmpassword' ||
        cleanKey === 'token' ||
        cleanKey === 'accesstoken' ||
        cleanKey === 'refreshtoken' ||
        cleanKey === 'jwt' ||
        cleanKey === 'authorization' ||
        cleanKey === 'cookie' ||
        cleanKey === 'aadhaar' ||
        cleanKey === 'pan' ||
        cleanKey === 'pnr' ||
        cleanKey === 'passengername' ||
        cleanKey === 'otp'
      ) {
        if (valType === 'string') {
          if (cleanKey === 'authorization' && val[key].toLowerCase().includes('bearer')) {
            copy[key] = val[key].replace(/(bearer\s+)(\S+)/gi, '$1********');
          } else {
            copy[key] = '********';
          }
        } else {
          copy[key] = '********';
        }
      } else if (cleanKey === 'email') {
        if (valType === 'string') {
          copy[key] = maskEmail(val[key]);
        } else {
          copy[key] = '********';
        }
      } else if (cleanKey === 'phone' || cleanKey === 'mobilenumber') {
        if (valType === 'string') {
          copy[key] = maskPhone(val[key]);
        } else {
          copy[key] = '********';
        }
      } else {
        copy[key] = sanitizeValue(val[key], key);
      }
    }

    const symbols = Object.getOwnPropertySymbols(val);
    for (const sym of symbols) {
      if (typeof val[sym] === 'string') {
        copy[sym] = sanitizeString(val[sym]);
      } else {
        copy[sym] = val[sym];
      }
    }

    return copy;
  }

  if (typeof val === 'string') {
    return sanitizeString(val);
  }

  return val;
}

// Custom format for structured logging
const structuredFormat = winston.format((info: any) => {
  // Add component tags based on message content
  if ((info.message as string).includes('[SPLIT_ENGINE]')) {
    info.component = 'SPLIT_ENGINE';
  } else if ((info.message as string).includes('[DB]')) {
    info.component = 'DB';
  } else if ((info.message as string).includes('[CACHE]')) {
    info.component = 'CACHE';
  } else if ((info.message as string).includes('[API]')) {
    info.component = 'API';
  } else if ((info.message as string).includes('[LIVE_TRACK]')) {
    info.component = 'LIVE_TRACK';
  } else if ((info.message as string).includes('[PNR]')) {
    info.component = 'PNR';
  } else {
    info.component = 'SYSTEM';
  }

  return info;
});

const piiSanitizerFormat = winston.format((info: any) => {
  return sanitizeValue(info);
});

import DailyRotateFile from 'winston-daily-rotate-file';

export const winstonLogger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    structuredFormat(),
    piiSanitizerFormat(),
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console(),
    new DailyRotateFile({
      filename: 'logs/error-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      zippedArchive: true,
      maxSize: '20m',
      maxFiles: '14d',
      level: 'error'
    }),
    new DailyRotateFile({
      filename: 'logs/combined-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      zippedArchive: true,
      maxSize: '20m',
      maxFiles: '14d'
    })
  ],
});

// Add structured logging methods to the winstonLogger instance
(winstonLogger as any).requestStart = (reqId: string, endpoint: string, params: any) => {
  winstonLogger.info({
    message: `[REQUEST_START] ${endpoint}`,
    component: 'SYSTEM',
    reqId,
    params
  });
};

(winstonLogger as any).requestEnd = (reqId: string, endpoint: string, duration: number, status: number) => {
  winstonLogger.info({
    message: `[REQUEST_END] ${endpoint}`,
    component: 'SYSTEM',
    reqId,
    duration,
    status
  });
};

(winstonLogger as any).apiTiming = (endpoint: string, duration: number, source: string) => {
  winstonLogger.info({
    message: `[API_TIMING] ${endpoint}`,
    component: 'API',
    duration,
    source
  });
};

(winstonLogger as any).cacheHit = (key: string) => {
  winstonLogger.info({
    message: `[CACHE_HIT] ${key}`,
    component: 'CACHE'
  });
};

(winstonLogger as any).cacheMiss = (key: string) => {
  winstonLogger.info({
    message: `[CACHE_MISS] ${key}`,
    component: 'CACHE'
  });
};

(winstonLogger as any).dbWrite = (table: string, operation: string, success: boolean, error?: string) => {
  winstonLogger.info({
    message: `[DB_WRITE] ${table} ${operation}`,
    component: 'DB',
    success,
    error
  });
};

(winstonLogger as any).splitGeneration = (count: number, source: string, destination: string) => {
  winstonLogger.info({
    message: `[SPLIT_GENERATION] Generated ${count} splits`,
    component: 'SPLIT_ENGINE',
    source,
    destination
  });
};

(winstonLogger as any).rejectedRoute = (source: string, destination: string, reason: string) => {
  winstonLogger.info({
    message: `[REJECTED_ROUTE] ${source} → ${destination}`,
    component: 'SPLIT_ENGINE',
    reason
  });
};

(winstonLogger as any).retryTrigger = (operation: string, attempt: number, error: string) => {
  winstonLogger.info({
    message: `[RETRY_TRIGGER] ${operation} attempt ${attempt}`,
    component: 'SYSTEM',
    error
  });
};

(winstonLogger as any).frontendRender = (component: string, duration: number) => {
  winstonLogger.info({
    message: `[FRONTEND_RENDER] ${component}`,
    component: 'SYSTEM',
    duration
  });
};

// Centralized DB Diagnostics Logging Integration
import { SupabaseLoggerTransport } from '../utils/supabaseTransport';

if (process.env.ENABLE_DB_DIAGNOSTICS === 'true') {
  winstonLogger.add(new SupabaseLoggerTransport());
}