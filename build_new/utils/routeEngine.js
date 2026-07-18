"use strict";
// src/utils/routeEngine.ts
// Core geographic route validation engine for split journey filtering.
Object.defineProperty(exports, "__esModule", { value: true });
exports.isHardDetour = exports.getDetourRatio = exports.HARD_DETOUR_THRESHOLD = exports.sortViaByDetourScore = exports.sortViaByDistance = exports.getValidViaStations = exports.isValidDirectionalFlow = exports.isForwardStation = exports.getDistance = exports.STATIONS = void 0;
// 🔥 STATION COORDINATE DATA (major Indian rail hubs)
exports.STATIONS = {
    // Mumbai cluster
    CSMT: { code: 'CSMT', lat: 18.9398, lng: 72.8355 },
    BCT: { code: 'BCT', lat: 18.9693, lng: 72.8193 },
    LTT: { code: 'LTT', lat: 19.0708, lng: 72.9063 },
    KYN: { code: 'KYN', lat: 19.2437, lng: 73.1355 },
    DR: { code: 'DR', lat: 19.0178, lng: 72.8422 },
    DDR: { code: 'DDR', lat: 19.0180, lng: 72.8430 },
    MMCT: { code: 'MMCT', lat: 18.9696, lng: 72.8194 },
    BDTS: { code: 'BDTS', lat: 19.0619, lng: 72.8407 },
    // Pune
    PUNE: { code: 'PUNE', lat: 18.5204, lng: 73.8567 },
    // Gujarat corridor
    SURAT: { code: 'SURAT', lat: 21.1702, lng: 72.8311 },
    BRC: { code: 'BRC', lat: 22.3072, lng: 73.1812 },
    ADI: { code: 'ADI', lat: 23.0225, lng: 72.5714 },
    // Rajasthan
    RTM: { code: 'RTM', lat: 23.3315, lng: 75.0367 },
    KOTA: { code: 'KOTA', lat: 25.2138, lng: 75.8648 },
    JP: { code: 'JP', lat: 26.9124, lng: 75.7873 },
    // Delhi cluster
    NZM: { code: 'NZM', lat: 28.5880, lng: 77.2560 },
    NDLS: { code: 'NDLS', lat: 28.6430, lng: 77.2197 },
    DLI: { code: 'DLI', lat: 28.6619, lng: 77.2090 },
    // Central India
    BPL: { code: 'BPL', lat: 23.2599, lng: 77.4126 },
    ET: { code: 'ET', lat: 22.6152, lng: 77.7689 },
    JBP: { code: 'JBP', lat: 23.1815, lng: 79.9864 },
    NGP: { code: 'NGP', lat: 21.1458, lng: 79.0882 },
    BSL: { code: 'BSL', lat: 21.0443, lng: 75.7722 },
    // North India
    ALD: { code: 'ALD', lat: 25.4358, lng: 81.8463 },
    CNB: { code: 'CNB', lat: 26.4499, lng: 80.3319 },
    LKO: { code: 'LKO', lat: 26.8467, lng: 80.9462 },
    GWL: { code: 'GWL', lat: 26.2124, lng: 78.1772 },
    BSB: { code: 'BSB', lat: 25.3176, lng: 82.9739 },
    PRYJ: { code: 'PRYJ', lat: 25.4358, lng: 81.8463 }, // Prayagraj Jn (A-tier) — same city as ALD, distinct code
    DDU: { code: 'DDU', lat: 25.4295, lng: 83.0225 }, // Pt. Deen Dayal Upadhyaya Jn (Mughalsarai)
    PNBE: { code: 'PNBE', lat: 25.5941, lng: 85.1376 },
    // East / East-coast
    HWH: { code: 'HWH', lat: 22.5839, lng: 88.3424 },
    VSKP: { code: 'VSKP', lat: 17.6869, lng: 83.2185 }, // Visakhapatnam — AP coast hub
    // South
    SC: { code: 'SC', lat: 17.4399, lng: 78.4983 },
    HYB: { code: 'HYB', lat: 17.3850, lng: 78.4867 },
    BZA: { code: 'BZA', lat: 16.5151, lng: 80.6225 },
    MAS: { code: 'MAS', lat: 13.0827, lng: 80.2707 },
    SBC: { code: 'SBC', lat: 12.9784, lng: 77.5695 },
    BBS: { code: 'BBS', lat: 20.2961, lng: 85.8245 },
    KUR: { code: 'KUR', lat: 20.1690, lng: 85.6698 },
    PURI: { code: 'PURI', lat: 19.8133, lng: 85.8315 },
    // Phase 2 Payload Injections
    UBL: { code: 'UBL', lat: 15.3647, lng: 75.1240 },
    GDG: { code: 'GDG', lat: 15.4297, lng: 75.6297 }, // Gadag — North Karnataka hub
    DWR: { code: 'DWR', lat: 15.4589, lng: 75.0070 }, // Dharwad — Karnataka (between SUR and UBL)
    SUR: { code: 'SUR', lat: 17.6869, lng: 75.9064 },
    MRJ: { code: 'MRJ', lat: 16.9905, lng: 74.7874 },
    HVR: { code: 'HVR', lat: 14.7935, lng: 75.3970 },
    TVC: { code: 'TVC', lat: 8.5241, lng: 76.9366 },
    KPD: { code: 'KPD', lat: 12.9833, lng: 79.1333 },
    BWT: { code: 'BWT', lat: 12.9961, lng: 78.1884 },
    JTJ: { code: 'JTJ', lat: 12.5647, lng: 78.5630 },
    GAYA: { code: 'GAYA', lat: 24.7955, lng: 84.9994 },
    ASN: { code: 'ASN', lat: 23.6871, lng: 86.9746 },
    KGP: { code: 'KGP', lat: 22.3361, lng: 87.3195 },
    BLS: { code: 'BLS', lat: 21.4934, lng: 86.9333 },
    CTC: { code: 'CTC', lat: 20.4528, lng: 85.8906 },
    // Dynamic Junction Hub Expansion (50 approved hubs)
    BDC: { code: 'BDC', lat: 22.9237, lng: 88.3794 },
    BSAE: { code: 'BSAE', lat: 22.9573, lng: 88.3956 },
    TBAE: { code: 'TBAE', lat: 22.9904, lng: 88.3981 },
    KJU: { code: 'KJU', lat: 23.0168, lng: 88.4131 },
    DMLE: { code: 'DMLE', lat: 23.0401, lng: 88.4327 },
    KMAE: { code: 'KMAE', lat: 23.0542, lng: 88.4442 },
    JIT: { code: 'JIT', lat: 23.0983, lng: 88.4615 },
    BGAE: { code: 'BGAE', lat: 23.1215, lng: 88.4526 },
    SOAE: { code: 'SOAE', lat: 23.1392, lng: 88.4330 },
    BHLA: { code: 'BHLA', lat: 23.1820, lng: 88.4288 },
    GPAE: { code: 'GPAE', lat: 23.1974, lng: 88.4178 },
    ABKA: { code: 'ABKA', lat: 23.2114, lng: 88.3540 },
    BGRA: { code: 'BGRA', lat: 23.2421, lng: 88.3297 },
    DTAE: { code: 'DTAE', lat: 23.2778, lng: 88.3118 },
    SMAE: { code: 'SMAE', lat: 23.3358, lng: 88.3250 },
    NDAE: { code: 'NDAE', lat: 23.3966, lng: 88.3565 },
    BFZ: { code: 'BFZ', lat: 23.4332, lng: 88.3298 },
    PSAE: { code: 'PSAE', lat: 23.4533, lng: 88.3239 },
    LKX: { code: 'LKX', lat: 23.5025, lng: 88.3024 },
    BQY: { code: 'BQY', lat: 23.5193, lng: 88.2829 },
    PTAE: { code: 'PTAE', lat: 23.5476, lng: 88.2517 },
    AGAE: { code: 'AGAE', lat: 23.5810, lng: 88.2261 },
    DHAE: { code: 'DHAE', lat: 23.6019, lng: 88.1703 },
    KLNT: { code: 'KLNT', lat: 23.3659, lng: 88.3358 },
    BTI: { code: 'BTI', lat: 30.2095, lng: 74.9321 },
    VSPR: { code: 'VSPR', lat: 23.4132, lng: 88.3552 },
    MTFA: { code: 'MTFA', lat: 23.4797, lng: 88.3197 },
    SRP: { code: 'SRP', lat: 22.7540, lng: 88.3380 },
    SHE: { code: 'SHE', lat: 22.7747, lng: 88.3288 },
    CGR: { code: 'CGR', lat: 22.8675, lng: 88.3544 },
    CNS: { code: 'CNS', lat: 22.8902, lng: 88.3695 },
    SHBA: { code: 'SHBA', lat: 23.5916, lng: 88.2010 },
    SPRD: { code: 'SPRD', lat: 19.2587, lng: 83.4031 },
    RGDA: { code: 'RGDA', lat: 19.1756, lng: 83.4105 },
    STD: { code: 'STD', lat: 29.1089, lng: 75.8212 },
    HNS: { code: 'HNS', lat: 29.0883, lng: 75.9472 },
    AUN: { code: 'AUN', lat: 29.0439, lng: 75.9745 },
    JKZ: { code: 'JKZ', lat: 29.0118, lng: 75.9874 },
    BWK: { code: 'BWK', lat: 28.9395, lng: 76.0327 },
    BNW: { code: 'BNW', lat: 28.7984, lng: 76.1256 },
    MHU: { code: 'MHU', lat: 28.7012, lng: 76.2031 },
    CKD: { code: 'CKD', lat: 28.6008, lng: 76.2799 },
    JRL: { code: 'JRL', lat: 28.5065, lng: 76.3746 },
    SDRA: { code: 'SDRA', lat: 28.4537, lng: 76.4258 },
    KSI: { code: 'KSI', lat: 28.4119, lng: 76.4647 },
    NLQ: { code: 'NLQ', lat: 28.3645, lng: 76.4968 },
    JTS: { code: 'JTS', lat: 28.3314, lng: 76.5211 },
    KGBS: { code: 'KGBS', lat: 28.2628, lng: 76.5716 },
    LLH: { code: 'LLH', lat: 22.6215, lng: 88.3396 },
    BEQ: { code: 'BEQ', lat: 22.6359, lng: 88.3395 },
    // Gateway alignments
    ERS: { code: 'ERS', lat: 9.969542, lng: 76.290672 },
    GHY: { code: 'GHY', lat: 26.182635, lng: 91.751851 },
    MAO: { code: 'MAO', lat: 15.267911, lng: 73.970724 },
    MAJN: { code: 'MAJN', lat: 12.866193, lng: 74.88006 },
};
// 📏 Haversine distance between two stations (in km)
const getDistance = (a, b) => {
    const R = 6371;
    const dLat = (b.lat - a.lat) * (Math.PI / 180);
    const dLng = (b.lng - a.lng) * (Math.PI / 180);
    const lat1 = a.lat * (Math.PI / 180);
    const lat2 = b.lat * (Math.PI / 180);
    const x = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.sin(dLng / 2) * Math.sin(dLng / 2) * Math.cos(lat1) * Math.cos(lat2);
    return R * (2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x)));
};
exports.getDistance = getDistance;
// 🧠 Forward direction check — does the via station lie on a logical path?
// Allows up to 80% detour relative to the direct distance.
const isForwardStation = (source, destination, via, maxDetourRatio = 1.8) => {
    const src = exports.STATIONS[source];
    const dest = exports.STATIONS[destination];
    const mid = exports.STATIONS[via];
    if (!src || !dest || !mid)
        return true; // allow if coords not known
    const direct = (0, exports.getDistance)(src, dest);
    const split = (0, exports.getDistance)(src, mid) + (0, exports.getDistance)(mid, dest);
    return split <= direct * maxDetourRatio;
};
exports.isForwardStation = isForwardStation;
// 🧭 Strict Directional Flow Check — rejects backward movement.
// The hub must move us meaningfully closer to the destination (or at least not further away).
const isValidDirectionalFlow = (source, destination, via, marginKm = 50) => {
    const src = exports.STATIONS[source];
    const dest = exports.STATIONS[destination];
    const mid = exports.STATIONS[via];
    if (!src || !dest || !mid)
        return true; // allow if coords not known
    const directDist = (0, exports.getDistance)(src, dest);
    const hubToDestDist = (0, exports.getDistance)(mid, dest);
    // If the distance from hub to destination is greater than source to destination 
    // + a small margin, it means we traveled backward.
    return hubToDestDist <= directDist + marginKm;
};
exports.isValidDirectionalFlow = isValidDirectionalFlow;
// 🎯 Filter a list of station codes to only those in the forward corridor
const getValidViaStations = (source, destination, candidates) => {
    const pool = candidates ?? Object.keys(exports.STATIONS);
    return pool.filter((stn) => stn !== source && stn !== destination && (0, exports.isForwardStation)(source, destination, stn) && (0, exports.isValidDirectionalFlow)(source, destination, stn));
}; // 📊 Sort via stations by distance from source (closest first)
exports.getValidViaStations = getValidViaStations;
// Returns top N ranked candidates for multi-via exploration.
const sortViaByDistance = (source, viaStations, topN = 50) => {
    const src = exports.STATIONS[source];
    if (!src)
        return viaStations.slice(0, topN);
    return viaStations
        .map((code) => {
        const stn = exports.STATIONS[code];
        const dist = stn ? (0, exports.getDistance)(src, stn) : Infinity;
        return { code, dist };
    })
        .sort((a, b) => a.dist - b.dist)
        .slice(0, topN)
        .map((s) => s.code);
};
exports.sortViaByDistance = sortViaByDistance;
// 🧮 Sort via stations by a combination of distance and detour penalty (Issue 2 Fix)
const sortViaByDetourScore = (source, destination, viaStations, topN = 50) => {
    const src = exports.STATIONS[source];
    const dest = exports.STATIONS[destination];
    if (!src || !dest)
        return (0, exports.sortViaByDistance)(source, viaStations, topN);
    const directDist = (0, exports.getDistance)(src, dest);
    return viaStations
        .map((code) => {
        const mid = exports.STATIONS[code];
        if (!mid)
            return { code, score: Infinity };
        const srcToMid = (0, exports.getDistance)(src, mid);
        const midToDest = (0, exports.getDistance)(mid, dest);
        const splitDist = srcToMid + midToDest;
        const detourRatio = splitDist / directDist;
        let overshootPenalty = 0;
        if (midToDest > directDist) {
            overshootPenalty = (midToDest - directDist) * 15;
        }
        let detourPenalty = 0;
        if (detourRatio > 1.1) {
            detourPenalty = (detourRatio - 1.1) * 2000;
        }
        let backwardsPenalty = 0;
        if (srcToMid > directDist && midToDest > directDist) {
            backwardsPenalty = 3000;
        }
        const score = splitDist * detourRatio + overshootPenalty + detourPenalty + backwardsPenalty;
        return { code, score };
    })
        .sort((a, b) => a.score - b.score)
        .slice(0, topN)
        .map((s) => s.code);
};
exports.sortViaByDetourScore = sortViaByDetourScore;
// ─────────────────────────────────────────────────────────────────────────────
// 🚫 HARD DETOUR REJECTION
// If the split path (src→hub→dest) is more than 2.5× the direct distance
// the hub is rejected outright, regardless of score / penalty.
// ─────────────────────────────────────────────────────────────────────────────
exports.HARD_DETOUR_THRESHOLD = 2.5;
/**
 * Returns the detour ratio (splitDist / directDist) for a given src→hub→dest.
 * Returns null when coordinates are unavailable and logs [DETOUR_COORDS_MISSING].
 */
const getDetourRatio = (source, hub, destination) => {
    const src = exports.STATIONS[source];
    const dest = exports.STATIONS[destination];
    const mid = exports.STATIONS[hub];
    if (!src || !dest || !mid) {
        // Log whichever station(s) are missing
        const missing = [!src ? source : null, !mid ? hub : null, !dest ? destination : null]
            .filter(Boolean)
            .join(', ');
        console.warn(`[DETOUR_COORDS_MISSING] for hub ${hub} (missing coords: ${missing})`);
        return null;
    }
    const directDist = (0, exports.getDistance)(src, dest);
    if (directDist === 0)
        return null;
    const splitDist = (0, exports.getDistance)(src, mid) + (0, exports.getDistance)(mid, dest);
    return splitDist / directDist;
};
exports.getDetourRatio = getDetourRatio;
/**
 * Hard rejection gate: returns true when the hub causes a detour > 2.5× direct.
 * If coordinates are missing the hub is NOT rejected (conservative / safe default).
 */
const isHardDetour = (source, hub, destination) => {
    const ratio = (0, exports.getDetourRatio)(source, hub, destination);
    if (ratio === null)
        return false; // coords missing → allow
    return ratio > exports.HARD_DETOUR_THRESHOLD;
};
exports.isHardDetour = isHardDetour;
