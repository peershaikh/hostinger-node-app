// TypeScript declaration augmentation for Express Request interface
// Extends Express Request type with CSRF token functionality from csurf package

import { CsrfToken } from 'csurf';

declare global {
  namespace Express {
    interface Request {
      csrfToken(): string;
    }
  }
}
