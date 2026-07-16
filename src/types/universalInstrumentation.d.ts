declare global {
  namespace Express {
    interface Request {
      universalIds?: import('../utils/universalIds').UniversalRequestContext;
      providerCallId?: string;
    }
  }
}

export {};

