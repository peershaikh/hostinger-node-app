import {
  BookingProvider,
  BookingCapabilities,
  BookingContext,
  BookingUrlResult
} from './bookingProvider';

export class IRCTCBookingProvider implements BookingProvider {
  public readonly providerId = 'IRCTC';
  public readonly displayName = 'IRCTC Official Booking';
  public readonly enabled = true;

  public readonly capabilities: BookingCapabilities = {
    directBooking: true,
    splitBooking: true,
    deepLinkGeneration: true,
    partnerAttribution: true
  };

  private readonly BASE_URL = 'https://www.irctc.co.in/nget/train-search';

  public generateBookingUrl(context: BookingContext): BookingUrlResult {
    const fromStation = (context.fromStation || '').trim().toUpperCase();
    const toStation = (context.toStation || '').trim().toUpperCase();
    const trainNo = (context.trainNo || '').trim();
    const journeyDate = (context.journeyDate || '').trim();

    const params = new URLSearchParams();

    if (fromStation) params.set('fromStation', fromStation);
    if (toStation) params.set('toStation', toStation);
    if (trainNo && trainNo !== 'Not Available' && trainNo !== 'XXXXX') {
      params.set('trainNo', trainNo);
    }
    if (journeyDate) params.set('journeyDate', journeyDate);

    // Standard UTM attribution parameters
    params.set('utm_source', context.utmSource || 'trayago');
    params.set('utm_campaign', context.utmCampaign || 'ai_booking');

    // Partner attribution support if present
    if (context.partnerId) params.set('partner_id', context.partnerId);
    if (context.campaignId) params.set('campaign_id', context.campaignId);
    if (context.medium) params.set('utm_medium', context.medium);

    const url = `${this.BASE_URL}?${params.toString()}`;

    return {
      url,
      providerId: this.providerId,
      displayName: this.displayName,
      isOfficial: true,
      partnerId: context.partnerId,
      campaignId: context.campaignId || context.utmCampaign
    };
  }

  public async healthCheck(): Promise<{ status: 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY'; message: string }> {
    return {
      status: 'HEALTHY',
      message: 'IRCTC booking deep-link generator operational'
    };
  }
}

export const irctcBookingProvider = new IRCTCBookingProvider();
