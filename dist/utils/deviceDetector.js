"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.detectDeviceAndGeo = detectDeviceAndGeo;
// Indian state region codes commonly returned by Cloudflare cf-region or IP headers
const INDIAN_STATE_MAP = {
    'AP': 'Andhra Pradesh',
    'AR': 'Arunachal Pradesh',
    'AS': 'Assam',
    'BR': 'Bihar',
    'CT': 'Chhattisgarh',
    'CG': 'Chhattisgarh',
    'GA': 'Goa',
    'GJ': 'Gujarat',
    'HR': 'Haryana',
    'HP': 'Himachal Pradesh',
    'JH': 'Jharkhand',
    'KA': 'Karnataka',
    'KL': 'Kerala',
    'MP': 'Madhya Pradesh',
    'MH': 'Maharashtra',
    'MN': 'Manipur',
    'ML': 'Meghalaya',
    'MZ': 'Mizoram',
    'NL': 'Nagaland',
    'OR': 'Odisha',
    'OD': 'Odisha',
    'PB': 'Punjab',
    'RJ': 'Rajasthan',
    'SK': 'Sikkim',
    'TN': 'Tamil Nadu',
    'TG': 'Telangana',
    'TS': 'Telangana',
    'TR': 'Tripura',
    'UP': 'Uttar Pradesh',
    'UT': 'Uttarakhand',
    'UK': 'Uttarakhand',
    'WB': 'West Bengal',
    'DL': 'Delhi',
    'JK': 'Jammu and Kashmir',
    'LA': 'Ladakh',
    'CH': 'Chandigarh',
    'PY': 'Puducherry'
};
function detectDeviceAndGeo(req) {
    const ua = (req.headers['user-agent'] || '').trim();
    const lowerUa = ua.toLowerCase();
    // 1. Device Type
    let deviceType = 'desktop';
    if (/ipad|tablet|(android(?!.*mobile))|kindle|playbook|silk/i.test(ua)) {
        deviceType = 'tablet';
    }
    else if (/mobile|iphone|ipod|android|blackberry|opera mini|iemobile|wpdesktop/i.test(ua)) {
        deviceType = 'mobile';
    }
    // 2. Platform / OS
    let platform = 'Unknown';
    if (/android/i.test(ua)) {
        platform = 'Android';
    }
    else if (/iphone|ipad|ipod/i.test(ua)) {
        platform = 'iOS';
    }
    else if (/windows/i.test(ua)) {
        platform = 'Windows';
    }
    else if (/mac os x|macintosh/i.test(ua)) {
        platform = 'macOS';
    }
    else if (/linux/i.test(ua)) {
        platform = 'Linux';
    }
    // 3. Browser
    let browser = 'Unknown';
    if (/edg/i.test(ua)) {
        browser = 'Edge';
    }
    else if (/opr|opera/i.test(ua)) {
        browser = 'Opera';
    }
    else if (/chrome|crios/i.test(ua)) {
        browser = 'Chrome';
    }
    else if (/firefox|fxios/i.test(ua)) {
        browser = 'Firefox';
    }
    else if (/safari/i.test(ua) && !/chrome|crios/i.test(ua)) {
        browser = 'Safari';
    }
    // 4. Client Type (Native App vs Mobile Web vs Desktop Web)
    let clientType = 'desktop_web';
    const isCapacitorApp = req.headers['x-requested-with'] === 'in.trayago.app' ||
        /in\.trayago\.app|capacitor|wv/i.test(ua);
    if (isCapacitorApp) {
        clientType = 'mobile_app';
    }
    else if (deviceType === 'mobile' || deviceType === 'tablet') {
        clientType = 'mobile_web';
    }
    else {
        clientType = 'desktop_web';
    }
    // 5. IP & Geolocation from Cloudflare / Proxy headers
    const cfCity = req.headers['cf-ipcity'];
    const cfRegion = req.headers['cf-region'];
    const cfCountry = req.headers['cf-ipcountry'];
    const forwardedFor = req.headers['x-forwarded-for']?.split(',')[0]?.trim();
    const realIp = req.headers['x-real-ip'] || forwardedFor || req.ip || '';
    let state = undefined;
    if (cfRegion) {
        const upperRegion = cfRegion.trim().toUpperCase();
        state = INDIAN_STATE_MAP[upperRegion] || cfRegion.trim();
    }
    return {
        deviceType,
        platform,
        browser,
        clientType,
        rawUserAgent: ua.slice(0, 255),
        ip: realIp,
        state,
        city: cfCity?.trim(),
        country: cfCountry?.trim() || (state ? 'India' : undefined)
    };
}
