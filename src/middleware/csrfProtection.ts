/**
 * PHASE_4C759 — P1-SEC-003: CSRF Protection Middleware
 * 
 * Protects state-changing routes (POST/PUT/DELETE/PATCH) from CSRF attacks.
 * Uses csurf package with cookie-based token storage.
 * 
 * Flow:
 * 1. Client makes GET request to any route
 * 2. Server generates CSRF token and sends it in response header + cookie
 * 3. Client stores token and includes it in subsequent state-changing requests
 * 4. Server validates token before processing request
 */

import csrf from 'csurf';
import { Request, Response, NextFunction } from 'express';
import { winstonLogger } from './logger';

// Initialize CSRF protection with cookie-based storage
export const csrfProtection = csrf({
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production', // HTTPS only in production
    sameSite: 'strict',
    maxAge: 3600000 // 1 hour
  },
  // Ignore CSRF for safe methods (GET, HEAD, OPTIONS)
  ignoreMethods: ['GET', 'HEAD', 'OPTIONS']
});

/**
 * Middleware to attach CSRF token to response headers for client consumption
 */
export const attachCsrfToken = (req: Request, res: Response, next: NextFunction) => {
  try {
    // Generate CSRF token (only if csrfProtection middleware has run)
    if (req.csrfToken) {
      const token = req.csrfToken();
      
      // Attach token to response header for client to read
      res.setHeader('X-CSRF-Token', token);
      
      // Also expose it in response locals for views/templates if needed
      res.locals.csrfToken = token;
    }
    
    next();
  } catch (error: any) {
    winstonLogger.warn(`[CSRF] Failed to attach CSRF token: ${error.message}`);
    next(); // Don't block request if token attachment fails
  }
};

/**
 * Error handler specifically for CSRF validation failures
 */
export const csrfErrorHandler = (err: any, req: Request, res: Response, next: NextFunction) => {
  if (err.code === 'EBADCSRFTOKEN') {
    // Log the CSRF violation for security monitoring
    winstonLogger.warn(`[CSRF_VIOLATION] ${req.method} ${req.path} from IP ${req.ip} - Invalid or missing CSRF token`);
    
    return res.status(403).json({
      success: false,
      error: 'Invalid CSRF token. Please refresh the page and try again.',
      code: 'CSRF_INVALID'
    });
  }
  
  // Pass other errors to the next error handler
  next(err);
};

/**
 * Conditional CSRF middleware - only applies to authenticated routes
 * Public routes (guest access) can bypass CSRF for ease of integration
 */
export const conditionalCsrf = (req: Request, res: Response, next: NextFunction) => {
  // Skip CSRF for health checks and monitoring endpoints
  if (req.path === '/api/health' || req.path === '/') {
    return next();
  }
  
  // Skip CSRF for public auth routes (login, signup, etc.) which don't have a token yet
  const publicAuthRoutes = [
    '/api/auth/login',
    '/api/auth/signup',
    '/api/auth/refresh',
    '/api/auth/logout',
    '/api/auth/send-otp',
    '/api/auth/verify-otp',
    '/api/auth/forgot-password',
    '/api/auth/reset-password',
    '/api/auth/mobile/send-otp',
    '/api/auth/mobile/verify-otp',
    '/api/auth/app-open'
  ];
  if (publicAuthRoutes.includes(req.path)) {
    return next();
  }
  
  // Skip CSRF for webhook callbacks (e.g., payment gateways)
  if (req.path.startsWith('/api/webhooks/') || req.path.startsWith('/api/payments/webhook')) {
    return next();
  }

  // same-train-rescue is a read-only availability scan (no state-changing writes).
  // PHASE_4C804: exempt so cross-origin fetch from DirectTrainCard.tsx can reach the controller.
  if (req.path === '/api/trains/same-train-rescue') {
    return next();
  }

  // PHASE_4C839 NF-006: Mobile/API clients use Bearer JWT without CSRF cookies.
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return next();
  }

  // Apply CSRF protection
  csrfProtection(req, res, next);
};
