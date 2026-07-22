export interface OrderResult {
    success: boolean;
    orderId: string;
    amount?: number;
    currency?: string;
    payment_session_id?: string;
    razorpayKey?: string;
}

export interface WebhookResult {
    success: boolean;
    message: string;
    event?: string;
    orderId?: string;
    paymentId?: string;
    amount?: number;
}

export interface IPaymentProvider {
    providerName: string;
    createOrder(userId: string, plan: string, amount: number): Promise<OrderResult>;
    verifyPaymentSignature(orderId: string, paymentId: string, signature: string): boolean;
    verifyWebhookSignature(payload: string, signature: string, headers?: any): boolean;
    parseWebhook(payload: any): WebhookResult;
}
