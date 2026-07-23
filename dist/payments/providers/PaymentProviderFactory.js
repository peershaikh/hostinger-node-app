"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PaymentProviderFactory = void 0;
const RazorpayProvider_1 = require("./RazorpayProvider");
const CashfreeProvider_1 = require("./CashfreeProvider");
class PaymentProviderFactory {
    static getProvider(providerName) {
        const name = providerName || process.env.PAYMENT_PROVIDER || 'razorpay';
        switch (name.toLowerCase()) {
            case 'cashfree':
                return new CashfreeProvider_1.CashfreeProvider();
            case 'razorpay':
            default:
                return new RazorpayProvider_1.RazorpayProvider();
        }
    }
}
exports.PaymentProviderFactory = PaymentProviderFactory;
