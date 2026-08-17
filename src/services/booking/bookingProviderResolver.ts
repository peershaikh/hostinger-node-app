import { winstonLogger } from '../../middleware/logger';
import {
  BookingProvider,
  BookingContext,
  BookingUrlResult
} from './bookingProvider';
import { irctcBookingProvider } from './irctcBookingAdapter';

export class BookingProviderResolver {
  private providers = new Map<string, BookingProvider>();
  private defaultProviderId = 'IRCTC';

  constructor() {
    this.registerProvider(irctcBookingProvider);
  }

  public registerProvider(provider: BookingProvider): void {
    const key = provider.providerId.toUpperCase().trim();
    this.providers.set(key, provider);
    winstonLogger.info(`[BOOKING_REGISTRY] Registered booking provider: ${provider.providerId} (${provider.displayName})`);
  }

  public getProvider(providerId: string): BookingProvider | undefined {
    return this.providers.get(providerId.toUpperCase().trim());
  }

  public getAllProviders(): BookingProvider[] {
    return Array.from(this.providers.values());
  }

  /**
   * Resolves the primary active booking provider.
   */
  public resolveProvider(preferredId?: string): BookingProvider {
    if (preferredId) {
      const candidate = this.providers.get(preferredId.toUpperCase().trim());
      if (candidate && candidate.enabled) {
        return candidate;
      }
    }

    const defaultCandidate = this.providers.get(this.defaultProviderId);
    if (defaultCandidate && defaultCandidate.enabled) {
      return defaultCandidate;
    }

    // Safety fallback
    return irctcBookingProvider;
  }

  /**
   * Resolves and generates deep-link booking URL with partner/UTM attribution.
   */
  public async generateBookingUrl(
    context: BookingContext,
    preferredProviderId?: string
  ): Promise<BookingUrlResult> {
    const provider = this.resolveProvider(preferredProviderId);
    try {
      return await provider.generateBookingUrl(context);
    } catch (err: any) {
      winstonLogger.warn(`[BOOKING_GEN_FAIL] ${provider.providerId} URL generation failed: ${err.message}. Falling back to default IRCTC.`);
      return irctcBookingProvider.generateBookingUrl(context);
    }
  }
}

export const bookingProviderResolver = new BookingProviderResolver();
