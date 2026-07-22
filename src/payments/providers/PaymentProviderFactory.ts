import { IPaymentProvider } from './IPaymentProvider';
import { RazorpayProvider } from './RazorpayProvider';
import { CashfreeProvider } from './CashfreeProvider';

export class PaymentProviderFactory {
    public static getProvider(providerName?: string): IPaymentProvider {
        const name = providerName || process.env.PAYMENT_PROVIDER || 'razorpay';
        
        switch (name.toLowerCase()) {
            case 'cashfree':
                return new CashfreeProvider();
            case 'razorpay':
            default:
                return new RazorpayProvider();
        }
    }
}
