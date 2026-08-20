export interface BookingCapabilities {
  directBooking: boolean;
  splitBooking: boolean;
  deepLinkGeneration: boolean;
  partnerAttribution: boolean;
}

export interface BookingContext {
  fromStation: string;
  toStation: string;
  trainNo?: string;
  journeyDate?: string;
  classType?: string;
  quota?: string;
  utmSource?: string;
  utmCampaign?: string;
  partnerId?: string;
  campaignId?: string;
  medium?: string;
  interactionId?: string;
  attributionId?: string;
  articleId?: string;
}

export interface BookingUrlResult {
  url: string;
  providerId: string;
  displayName: string;
  isOfficial: boolean;
  partnerId?: string;
  campaignId?: string;
  attributionId?: string;
}

export interface BookingProvider {
  readonly providerId: string;
  readonly displayName: string;
  readonly enabled: boolean;
  readonly capabilities: BookingCapabilities;

  generateBookingUrl(context: BookingContext): Promise<BookingUrlResult> | BookingUrlResult;
  healthCheck?(): Promise<{ status: 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY'; message: string }>;
}
