"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.splitJourneyEngine = exports.SplitJourneyEngine = exports.split_analytics = exports.SplitAnalyticsMonitor = void 0;
exports.calculateWaitlistVelocity = calculateWaitlistVelocity;
exports.exploreCrossClassMatrix = exploreCrossClassMatrix;
exports.applyPremiumGate = applyPremiumGate;
const dbTrains_json_1 = __importDefault(require("../data/dbTrains.json"));
const logger_1 = require("../middleware/logger");
const apiPriority_1 = require("../utils/apiPriority");
const dayUtils_1 = require("../utils/dayUtils");
const routeEngine_1 = require("../utils/routeEngine");
const splitDebugLogger_1 = require("../utils/splitDebugLogger");
const analyticsService_1 = require("./analyticsService");
const cacheService_1 = require("./cacheService");
const dbService_1 = require("./dbService");
const hubService_1 = require("./hubService");
const irctcService_1 = require("./irctcService");
const rankingService_1 = require("./rankingService");
const availabilityProvider_1 = require("./availabilityProvider");
const stationService_1 = require("./stationService");
const providerConfigService_1 = require("./providerConfigService");
const transferDistances_json_1 = __importDefault(require("../data/transferDistances.json"));
const availabilityCacheKeys_1 = require("../utils/availabilityCacheKeys");
/**
 * Bumped whenever gate semantics change. Cached split payloads carry this
 * marker; entries without the current marker are treated as cache misses so
 * pre-gate (poisoned) results can never be served once the gate is active.
 */
// PHASE_5B167 — bumped so every split result cached before service-date truth
// and generic cancellation validation existed is treated as a MISS and recomputed.
const TRUST_GATE_VERSION = '5B167.3';
function resolveTrustGateMode() {
    const raw = String(process.env.SPLIT_TRUST_GATE || '').toLowerCase().trim();
    if (raw === 'off' || raw === 'enforce' || raw === 'shadow')
        return raw;
    return 'shadow'; // default — observe and protect sinks, do not drop candidates
}
/**
 * Mirrors the waitlist classification already used by checkSplitRecommendation()
 * so the direct-redundancy rule can tell a bookable direct from a waitlisted one.
 * Duplicated deliberately: checkSplitRecommendation() feeds recommendation
 * scoring and is left untouched.
 */
const DIRECT_BOOKABLE_WL_PATTERNS = /^WL|^REGRET|^AVAILABLE ON WAITLIST|NO SEATS|FULLY SOLD/i;
function deriveProvenance(...sources) {
    if (sources.some(s => s === 'none' || s === undefined))
        return 'DB_UNVERIFIED';
    if (sources.some(s => s === 'irctc'))
        return 'LIVE_VERIFIED';
    return 'DB_VERIFIED';
}
/**
 * PHASE_5B109 — split-cache generation check.
 *
 * Cache entries carry the trust-gate revision that produced them. Anything
 * written before this gate existed, or by an older revision, is treated as a
 * cache MISS so it gets recomputed and re-validated instead of replayed.
 * Deliberately a payload marker rather than a change to
 * `cacheService.generateSplitKey()` — the key format is shared with other
 * consumers and that file is outside this change's scope. TTLs are untouched.
 */
/**
 * PHASE_5B169 — generic cancellation truth from structured fields only.
 *
 * Only consumes real structured cancellation/status fields from the IRCTC/live
 * response surface. The `trains` table has NO status/is_cancelled columns, so it
 * must never be treated as a cancellation source. A present, non-cancelled
 * status is an explicit ACTIVE signal; a missing status is UNKNOWN, never an
 * implicit ACTIVE, and never inferred from a train number or name.
 */
function classifyCancellationState(leg) {
    if (!leg || typeof leg !== 'object')
        return 'UNKNOWN';
    // Explicit structured cancellation boolean
    if (leg.is_cancelled === true || leg.isCancelled === true || leg.cancelled === true) {
        return 'CANCELLED';
    }
    const status = String(leg.train_status || leg.status || leg.trainStatus || '').trim().toLowerCase();
    if (status) {
        if (status.includes('cancel') || status.includes('suspend') || status.includes('permanently')) {
            return 'CANCELLED';
        }
        return 'ACTIVE';
    }
    // No authoritative cancellation field present.
    return 'UNKNOWN';
}
function isTrainCancelled(leg) {
    return classifyCancellationState(leg) === 'CANCELLED';
}
function isTrustGatedPayload(payload) {
    if (!payload || typeof payload !== 'object')
        return false;
    const splits = payload.split;
    // An empty split list carries no candidate that could have been poisoned.
    if (Array.isArray(splits) && splits.length === 0)
        return true;
    return payload._trustGateVersion === TRUST_GATE_VERSION;
}
/**
 * PHASE_5B122 — RESOLVED-SCHEDULE CACHE PROVENANCE.
 *
 * `train_schedule_resolved_${num}` is written by TWO paths with very different
 * authority: validateLegAndCorrectAsync (DB, live override, or plain live) and
 * isProvenReverseScheduleSegment (DB only). Neither recorded which one it was, and
 * filterProvenReverseTrains runs BEFORE validateLegAndCorrectAsync — so a DB-only
 * payload could sit in the shared key for the full 7200s TTL and then satisfy the
 * origin-critical read as if it were a live schedule.
 *
 * Provenance now travels inside the payload, mirroring the `_trustGateVersion`
 * pattern above: the cache KEY is unchanged (shared with other consumers, and
 * cacheService.ts is out of scope), TTLs are untouched, and pre-5B122 payloads
 * simply resolve to 'none'. Those old entries stay perfectly usable for the
 * reverse-SN comparison that never needed provenance — they just cannot confer
 * authoritative origin trust.
 */
const SCHEDULE_PROVENANCE_VERSION = '5B122.1';
function readCachedScheduleSource(payload) {
    if (!payload || typeof payload !== 'object')
        return 'none';
    const p = payload;
    if (p._scheduleProvenanceVersion !== SCHEDULE_PROVENANCE_VERSION)
        return 'none';
    return p.source === 'db' || p.source === 'irctc' ? p.source : 'none';
}
// ─────────────────────────────────────────────────────────────────────────────
// PHASE_4C970 — PREMIUM FEATURE HELPERS
// Algo code is NOT touched. These functions only annotate/transform output.
// ─────────────────────────────────────────────────────────────────────────────
/**
 * FEATURE 2: Dynamic Waitlist Velocity Index (WVI).
 * Maps historical daily-drop rates for known heavy-demand corridors in India.
 * Returns a metadata object injected into each route leg node.
 * Data is ALWAYS computed; for free users it is flagged isLocked=true.
 */
function calculateWaitlistVelocity(trainNo, routeCorridor, currentWL) {
    // Corridor key normalised: lowercase, trim, replace spaces/slashes with dash
    const corridorKey = routeCorridor.toLowerCase().trim().replace(/[\s\/]+/g, '-');
    // Historical median daily drop-rates per heavy sector (seats/day)
    const DROP_RATE_TABLE = {
        // UP / Bihar mega-demand
        'delhi-lucknow': 18, 'delhi-varanasi': 14, 'delhi-patna': 16,
        'delhi-gorakhpur': 15, 'delhi-guwahati': 10, 'delhi-kolkata': 12,
        'mumbai-patna': 12, 'mumbai-varanasi': 11, 'mumbai-gorakhpur': 13,
        // Gujarat
        'mumbai-ahmedabad': 20, 'delhi-ahmedabad': 17, 'mumbai-surat': 19,
        // South
        'delhi-bangalore': 9, 'mumbai-bangalore': 10, 'chennai-mumbai': 8,
        // Default moderate
        'default': 8,
    };
    const dailyDrop = DROP_RATE_TABLE[corridorKey] ?? DROP_RATE_TABLE['default'];
    const daysToConfirm = currentWL > 0 ? Math.ceil(currentWL / dailyDrop) : 0;
    // Rough probability: if WL/drop < 7 days → high, < 14 → medium, else low
    const confProbability = daysToConfirm <= 0 ? 95 :
        daysToConfirm <= 7 ? 82 :
            daysToConfirm <= 14 ? 58 : 28;
    const velocityLabel = confProbability >= 80 ? 'HIGH_VELOCITY' :
        confProbability >= 55 ? 'MEDIUM_VELOCITY' : 'LOW_VELOCITY';
    return { dailyDrop, velocityLabel, confProbability, daysToConfirm, isLocked: false };
}
/**
 * FEATURE 3: Cross-Class Automation Matrix (CCAM).
 * When a route segment is REGRET/high-WL in the requested class,
 * returns a mixed-class path configuration as a string array.
 * e.g. Leg1 daytime SL, Leg2 overnight 3A.
 * Returns null when not applicable.
 */
function exploreCrossClassMatrix(requestedClass, leg1Status, leg2Status, leg1DepartureHour, leg2DepartureHour) {
    const isRegret = (s) => /REGRET|NOT AVAILABLE|CLASS NOT AVAILABLE|WL\s*[5-9][0-9]|WL\s*[1-9][0-9]{2}/i.test(s);
    if (!isRegret(leg1Status) && !isRegret(leg2Status))
        return null;
    // Class fallback priority map
    const CLASS_FALLBACK = {
        '3A': ['SL', '2A'],
        '2A': ['3A', '1A'],
        'SL': ['3A', '2A'],
        '1A': ['2A'],
        'CC': ['EC', '2S'],
        '2S': ['SL'],
    };
    const fallbacks = CLASS_FALLBACK[requestedClass] ?? ['SL'];
    // Prefer SL for daytime legs (<= 21:00), 3A/2A for overnight legs (>= 21:00)
    const leg1Class = isRegret(leg1Status)
        ? (leg1DepartureHour < 21 ? (fallbacks.find(c => c === 'SL') ?? fallbacks[0]) : (fallbacks.find(c => c !== 'SL') ?? fallbacks[0]))
        : requestedClass;
    const leg2Class = isRegret(leg2Status)
        ? (leg2DepartureHour >= 21 ? (fallbacks.find(c => c !== 'SL') ?? fallbacks[0]) : (fallbacks.find(c => c === 'SL') ?? fallbacks[0]))
        : requestedClass;
    return {
        legClasses: [leg1Class, leg2Class],
        rationale: `${requestedClass} unavailable — AI suggests: Leg 1 ${leg1Class} (${leg1DepartureHour < 21 ? 'daytime' : 'overnight'}), Leg 2 ${leg2Class} (${leg2DepartureHour >= 21 ? 'overnight' : 'daytime'})`,
    };
}
/**
 * PHASE_4C970 — Apply premium gate to a split journey result array.
 * - Same-train splits  → `paywallType: 'SAME_TRAIN_REUSE'` + `isLocked: true` for FREE users
 * - WVI metadata       → injected into every result; `wvi.isLocked` for FREE users
 * - CCAM config        → injected when applicable; `ccam.isLocked` for FREE users
 * Original algorithm objects (legs, scores, hubs) are NEVER mutated.
 */
function applyPremiumGate(splits, isPremiumUser, requestedClass = 'SL', source = '', destination = '') {
    const corridorKey = `${source.toLowerCase()}-${destination.toLowerCase()}`;
    return splits.map(s => {
        const isSameTrain = !!(s.isSameTrain || s.rescueType === 'SAME_TRAIN_SEGMENT');
        const legs = s.legs || [];
        // ── FEATURE 1: Same-Train Reuse paywall flag ────────────────────────────
        const sameTrainPremiumFields = isSameTrain && !isPremiumUser
            ? { paywallType: 'SAME_TRAIN_REUSE', isLocked: true }
            : {};
        // ── FEATURE 2: WVI injection ────────────────────────────────────────────
        // Compute from the leg with highest WL count (or 0 if confirmed/unknown)
        let maxWL = 0;
        legs.forEach((leg) => {
            const wlRaw = leg?.availability?.wlCount ?? leg?.availability?.wl_count ?? 0;
            const wlNum = typeof wlRaw === 'number' ? wlRaw : parseInt(String(wlRaw), 10) || 0;
            if (wlNum > maxWL)
                maxWL = wlNum;
        });
        const wviRaw = calculateWaitlistVelocity(legs[0]?.trainNo || '', corridorKey, maxWL);
        const wvi = isPremiumUser
            ? wviRaw
            : { ...wviRaw, velocityLabel: 'LOCKED', confProbability: -1, dailyDrop: -1, daysToConfirm: -1, isLocked: true };
        // ── FEATURE 3: CCAM injection ───────────────────────────────────────────
        let ccam = null;
        if (legs.length >= 2) {
            const leg1Status = legs[0]?.availability?.status || '';
            const leg2Status = legs[1]?.availability?.status || '';
            const parseHour = (time) => {
                if (!time)
                    return 12;
                const [h] = time.split(':').map(Number);
                return isNaN(h) ? 12 : h;
            };
            const ccamRaw = exploreCrossClassMatrix(requestedClass, leg1Status, leg2Status, parseHour(legs[0]?.departure || ''), parseHour(legs[1]?.departure || ''));
            if (ccamRaw) {
                ccam = isPremiumUser
                    ? { ...ccamRaw, isLocked: false }
                    : { legClasses: ['🔒', '🔒'], rationale: 'Unlock Trayago Pro to view cross-class alternative', isLocked: true };
            }
        }
        return {
            ...s,
            ...sameTrainPremiumFields,
            wvi,
            ...(ccam ? { ccam } : {}),
        };
    });
}
// ——— City → All valid station codes —————————————————————————————————————————
// Covers all major terminals for each metro city so we never miss trains
// departing from a secondary terminal (e.g. BCT instead of CSMT for Mumbai).
const getCity = (code) => {
    return stationService_1.stationService.getCitySync(code);
};
// —————————————————————————————————————————————————————————————————————————————
// PAN-INDIA MAJOR JUNCTION CORRIDOR MAP
// Each key is a source city (lowercase). Hubs are MAJOR JUNCTIONS ONLY.
// Rule: hub MUST be >= 250km from source AND a high-frequency interchange.
// DO NOT include suburban/local stations (KYN, DR, LTT, PNVL, MMPN etc.)
// —————————————————————————————————————————————————————————————————————————————
const PAN_INDIA_CORRIDOR_HUBS = {
    // —— Mumbai (CSMT/BCT/BDTS) —— min 250km from Mumbai
    mumbai: [
        'PUNE', // 192km — EXCEPTION: Pune is a massive junction, include for short routes
        'SUR', // 453km — Solapur — major Deccan junction
        'UBL', // Hubballi — major North Karnataka junction
        'ST', // 263km — Surat — major western junction
        'BRC', // 391km — Vadodara — Western railway hub
        'ADI', // 493km — Ahmedabad — Gujarat hub
        'BSL', // 451km — Bhusaval — Central/Western switch
        'NGP', // 838km — Nagpur — Central India crossroads
        'ET', // 803km — Itarsi — Central India switch
        'BPL', // 772km — Bhopal — Madhya Pradesh hub
        'RTM', // 670km — Ratlam — Western-Central gateway
        'KOTA', // 1012km — Kota — Rajasthan gateway
        'GWL', // 1202km — Gwalior — North-Central junction
        'SC', // 773km — Secunderabad — Deccan/South hub
        'BZA', // 1064km — Vijayawada — South-East gateway
        'RJT', 'BVC', 'MAO', 'RN', 'MAJN', 'ERS', 'TVC', 'CBE', 'JBP', 'SHM', 'MLDT', 'NJP', 'GHY'
    ],
    // —— Delhi (NDLS/NZM/DLI) —— min 250km from Delhi
    delhi: [
        'AGC', // 200km — Agra — North-Central (slight exception, huge junction)
        'GWL', // 319km — Gwalior — North-Central junction
        'KOTA', // 471km — Kota — Rajasthan gateway
        'BPL', // 705km — Bhopal — Madhya Pradesh hub
        'JHS', // 421km — Jhansi — Bundelkhand crossroads
        'CNB', // 440km — Kanpur — North India hub
        'LKO', // 506km — Lucknow — Awadh hub
        'BSB', // 810km — Varanasi — Eastern UP junction
        'ALD', // 634km — Prayagraj — Sangam junction
        'PNBE', // 1000km — Patna — Bihar hub
        'NGP', // 1094km — Nagpur — Central India
        'JP', // 309km — Jaipur — Rajasthan hub
        'ADI', // 935km — Ahmedabad — Gujarat hub
        'RTM', // 773km — Ratlam — Western gateway
        'BRC', 'ST', 'MAO', 'MAJN', 'ERS', 'TVC', 'CBE', 'BZA', 'SC', 'MAS', 'JBP', 'ET', 'NJP', 'GHY', 'DBRG', 'MLDT', 'SHM', 'KGP'
    ],
    // —— Chennai (MAS/MS) —— min 250km from Chennai
    chennai: [
        'SA', // 311km — Salem — TN gateway
        'CBE', // 496km — Coimbatore — TN/Kerala border
        'BZA', // 432km — Vijayawada — AP junction
        'SC', // 794km — Secunderabad — Deccan hub
        'GNT', // 431km — Guntur — AP hub
        'KCG', // 798km — Kachiguda — Hyderabad
        'NGP', // 1072km — Nagpur — Central India
        'ET', // 1198km — Itarsi — Central switch
        'BPL', // 1291km — Bhopal — MP hub
        'SBC', // 346km — Bengaluru — Karnataka hub
        'MYS', // 498km — Mysuru — Karnataka interior
        'HWH', // 1663km — Howrah — East gateway
        'NJP', 'GHY', 'MLDT', 'SHM', 'KGP', 'PNBE', 'BBS', 'MAO', 'RN', 'MAJN', 'RTM', 'ADI', 'JBP'
    ],
    // —— Kolkata (HWH/SDAH/KOAA) —— min 250km from Kolkata
    kolkata: [
        'TAT', // 249km — Tatanagar — Jharkhand hub (slight exception)
        'ROU', // 360km — Rourkela — West gateway
        'BSP', // 614km — Bilaspur — East-Central hub
        'NGP', // 996km — Nagpur — Central India
        'BBS', // 444km — Bhubaneswar — Odisha hub
        'VSKP', // 693km — Vizag — AP coastal hub
        'BZA', // 1055km — Vijayawada — South gateway
        'ALD', // 820km — Prayagraj — Central UP
        'CNB', // 960km — Kanpur — North India
        'PNBE', // 530km — Patna — Bihar hub
        'DHN', // 261km — Dhanbad — Coal belt junction
        'ASN', // 210km — Asansol — Eastern junction
        'NJP', 'GHY', 'DBRG', 'MLDT', 'ERS', 'TVC', 'CBE', 'BRC', 'RTM', 'ADI', 'ST', 'MAO', 'KGP'
    ],
    // —— Bangalore (SBC/YPR) —— min 250km from Bangalore
    bengaluru: [
        'SA', // 295km — Salem — TN gateway
        'CBE', // 364km — Coimbatore — TN/Kerala
        'MAS', // 346km — Chennai Central
        'GDG', // 469km — Gadag — North Karnataka
        'UBL', // 406km — Hubballi — North Karnataka hub
        'SC', // 571km — Secunderabad — Deccan
        'PUNE', // 843km — Pune — Deccan hub
        'BZA', // 790km — Vijayawada — AP junction
        'NGP', // 1152km — Nagpur — Central India
        'SBC', // self-ref removed at runtime
        'TVC', // 740km — Thiruvananthapuram — Kerala hub
        'MYS', // 139km — EXCLUDED at runtime (too close)
        'NJP', 'GHY', 'MLDT', 'HWH', 'SHM', 'KGP', 'PNBE', 'BBS', 'MAO', 'RN', 'MAJN', 'RTM', 'ADI', 'JBP', 'ET'
    ],
    bangalore: [
        'SA', 'CBE', 'MAS', 'GDG', 'UBL', 'SC', 'PUNE', 'BZA', 'NGP', 'TVC',
        'NJP', 'GHY', 'MLDT', 'HWH', 'SHM', 'KGP', 'PNBE', 'BBS', 'MAO', 'RN', 'MAJN', 'RTM', 'ADI', 'JBP', 'ET'
    ],
    // —— Hyderabad (SC/HYB/KCG) —— min 250km
    hyderabad: [
        'PUNE', // 584km — Deccan hub
        'NGP', // 503km — Nagpur
        'BZA', // 279km — Vijayawada
        'MAS', // 794km — Chennai
        'SBC', // 571km — Bengaluru
        'NZB', // 260km — Nizamabad
        'BPL', // 782km — Bhopal
        'ET', // 691km — Itarsi
        'ALD', // 855km — Prayagraj
        'LKO', // 1099km — Lucknow
        'NJP', 'GHY', 'MLDT', 'HWH', 'SHM', 'KGP', 'PNBE', 'BBS', 'MAO', 'RN', 'MAJN', 'RTM', 'ADI', 'JBP'
    ],
    // —— Ahmedabad (ADI/ST) —— min 250km
    ahmedabad: [
        'BRC', // 101km — Vadodara (minor exception)
        'RTM', // 275km — Ratlam — Western-Central switch
        'BSL', // 558km — Bhusaval
        'PUNE', // 676km — Pune
        'NGP', // 1009km — Nagpur
        'BPL', // 647km — Bhopal
        'ET', // 598km — Itarsi
        'KOTA', // 532km — Kota
        'JP', // 607km — Jaipur
        'NDLS', // 935km — New Delhi
        'MAO', 'RN', 'MAJN', 'ERS', 'TVC'
    ],
    // —— Patna (PNBE) —— min 250km
    patna: [
        'ALD', // 470km — Prayagraj
        'BSB', // 280km — Varanasi
        'CNB', // 534km — Kanpur
        'PNBE', // self — skip at runtime
        'DHN', // 268km — Dhanbad
        'HWH', // 530km — Howrah
        'LKO', // 628km — Lucknow
        'NDLS', // 1000km — Delhi
        'NGP', // 1028km — Nagpur
        'BPL', // 1068km — Bhopal
        'GHY', 'NJP', 'MLDT'
    ],
    // —— Pune (PUNE) —— min 250km
    pune: [
        'SUR', // 261km — Solapur
        'NGP', // 650km — Nagpur
        'BSL', // 265km — Bhusaval
        'SC', // 579km — Secunderabad
        'BZA', // 872km — Vijayawada
        'SBC', // 843km — Bengaluru
        'ET', // 613km — Itarsi
        'BPL', // 580km — Bhopal
        'ADI', // 676km — Ahmedabad
        'NDLS', // 1540km — Delhi
        'MAO', 'RN', 'MAJN', 'ERS', 'TVC'
    ],
    // —— Nagpur (NGP) —— min 250km
    nagpur: [
        'PUNE', // 650km
        'BPL', // 338km — Bhopal
        'ET', // 255km — Itarsi
        'SC', // 507km — Secunderabad
        'BSL', // 388km — Bhusaval
        'BZA', // 637km — Vijayawada
        'ALD', // 466km — Prayagraj
        'GWL', // 621km — Gwalior
        'NDLS', // 1094km — Delhi
        'HWH', // 996km — Howrah
        'GHY', 'NJP', 'MAO'
    ],
    // —— Lucknow (LKO) ——
    lucknow: [
        'CNB', // 80km — Kanpur
        'PRYJ', // 200km — Prayagraj
        'JHS', // 390km — Jhansi
        'ET', // 628km — Itarsi
        'BPL', // 705km — Bhopal
        'NGP', // 980km — Nagpur
        'GKP', // 130km — Gorakhpur
        'DDU', // 280km — Pt Deen Dayal Upadhyaya
        'PNBE', // 530km — Patna
        'HWH', // 1000km — Howrah
        'BSB', // 320km — Varanasi
        'NJP', 'GHY', 'MLDT', 'SHM'
    ],
    // —— Varanasi (BSB/DDU) ——
    varanasi: [
        'PRYJ', // 120km — Prayagraj
        'CNB', // 310km — Kanpur
        'DDU', // 40km — Mughalsarai
        'LKO', // 320km — Lucknow
        'PNBE', // 280km — Patna
        'ET', // 770km — Itarsi
        'BPL', // 830km — Bhopal
        'HWH', // 800km — Howrah
        'NGP', // 840km — Nagpur
        'GAYA', // 250km — Gaya
        'NJP', 'GHY', 'MLDT'
    ],
    // —— Jaipur (JP) ——
    jaipur: [
        'KOTA', // 262km — Kota
        'AGC', // 238km — Agra
        'BPL', // 652km — Bhopal
        'ET', // 760km — Itarsi
        'RTM', // 440km — Ratlam
        'NDLS', // 309km — Delhi
        'CNB', // 720km — Kanpur
        'ADI', // 633km — Ahmedabad
        'BRC', // 741km — Vadodara
        'NGP', // 1130km — Nagpur
        'GWL', // 447km — Gwalior
        'JHS', // 504km — Jhansi
    ],
    // —— Bhopal (BPL) ——
    bhopal: [
        'ET', // 93km — Itarsi
        'NGP', // 338km — Nagpur
        'JHS', // 284km — Jhansi
        'KOTA', // 390km — Kota
        'RTM', // 330km — Ratlam
        'CNB', // 560km — Kanpur
        'LKO', // 705km — Lucknow
        'SUR', // 730km — Solapur
        'BZA', // 870km — Vijayawada
        'NDLS', // 705km — Delhi
        'PRYJ', // 520km — Prayagraj
        'BSL', // 278km — Bhusaval
        'GWL', // 293km — Gwalior
    ],
    // —— Itarsi (ET) ——
    itarsi: [
        'NGP', // 255km — Nagpur
        'BPL', // 93km — Bhopal
        'BSL', // 237km — Bhusaval
        'JHS', // 330km — Jhansi
        'KOTA', // 480km — Kota
        'CNB', // 630km — Kanpur
        'SUR', // 620km — Solapur
        'PUNE', // 613km — Pune
        'SC', // 690km — Secunderabad
        'BZA', // 870km — Vijayawada
        'RTM', // 372km — Ratlam
    ],
    // —— Guwahati (GHY) ——
    guwahati: [
        'NJP', // 378km — New Jalpaiguri
        'MLDT', // 550km — Malda
        'HWH', // 1000km — Howrah
        'PNBE', // 1100km — Patna
        'MGS', // 1260km — Mughalsarai/DDU
        'CNB', // 1430km — Kanpur
        'DBRG', // 300km — Dibrugarh
        'SHM', // 900km — Shalimar
        'KGP', // 910km — Kharagpur
    ],
    // —— Ernakulam/Kochi (ERS) ——
    ernakulam: [
        'CBE', // 194km — Coimbatore
        'MAS', // 683km — Chennai
        'SBC', // 555km — Bengaluru
        'TVC', // 220km — Thiruvananthapuram
        'MAJN', // 416km — Mangaluru
        'SA', // 355km — Salem
        'SC', // 940km — Secunderabad
        'GTL', // 640km — Guntakal
        'MDU', // 280km — Madurai
        'PGT', // 200km — Palakkad
    ],
    // —— Thiruvananthapuram (TVC) ——
    thiruvananthapuram: [
        'ERS', // 220km — Ernakulam
        'CBE', // 414km — Coimbatore
        'MAS', // 903km — Chennai
        'SA', // 575km — Salem
        'SBC', // 740km — Bengaluru
        'MAJN', // 636km — Mangaluru
        'MDU', // 460km — Madurai
        'GTL', // 862km — Guntakal
    ],
    // —— Coimbatore (CBE) ——
    coimbatore: [
        'SA', // 160km — Salem
        'MAS', // 496km — Chennai
        'SBC', // 364km — Bengaluru
        'ERS', // 194km — Ernakulam
        'TVC', // 414km — Thiruvananthapuram
        'MDU', // 278km — Madurai
        'GTL', // 440km — Guntakal
        'SC', // 770km — Secunderabad
        'PGT', // 56km — Palakkad
    ],
    // —— Bhubaneswar (BBS) ——
    bhubaneswar: [
        'KGP', // 270km — Kharagpur
        'BZA', // 390km — Vijayawada
        'VSKP', // 440km — Visakhapatnam
        'HWH', // 444km — Howrah
        'CTC', // 27km — Cuttack
        'NGP', // 900km — Nagpur
        'TATA', // 345km — Tatanagar
    ],
    // —— Visakhapatnam (VSKP) ——
    visakhapatnam: [
        'BZA', // 360km — Vijayawada
        'KGP', // 700km — Kharagpur
        'HWH', // 800km — Howrah
        'SC', // 714km — Secunderabad
        'MAS', // 800km — Chennai
        'BBS', // 440km — Bhubaneswar
        'NGP', // 740km — Nagpur
        'RJY', // 135km — Rajahmundry
    ],
    // —— Madurai (MDU) ——
    madurai: [
        'SA', // 280km — Salem
        'CBE', // 278km — Coimbatore
        'MAS', // 492km — Chennai
        'TVC', // 460km — Thiruvananthapuram
        'ERS', // 280km — Ernakulam
        'TPJ', // 133km — Tiruchirappalli
        'SBC', // 640km — Bengaluru
        'GTL', // 540km — Guntakal
    ],
    // —— Indore (INDB) ——
    indore: [
        'RTM', // 130km — Ratlam
        'BRC', // 400km — Vadodara
        'ET', // 261km — Itarsi
        'BPL', // 193km — Bhopal
        'NGP', // 520km — Nagpur
        'ADI', // 450km — Ahmedabad
        'KOTA', // 395km — Kota
    ],
    // —— Raipur (R) ——
    raipur: [
        'NGP', // 280km — Nagpur
        'BPL', // 488km — Bhopal
        'BSP', // 130km — Bilaspur
        'ET', // 423km — Itarsi
        'HWH', // 1000km — Howrah
        'TATA', // 650km — Tatanagar
        'VSKP', // 640km — Visakhapatnam
    ],
    // —— Surat (ST) ——
    surat: [
        'BRC', // 128km — Vadodara
        'ADI', // 263km — Ahmedabad
        'RTM', // 430km — Ratlam
        'BSL', // 546km — Bhusaval
        'NGP', // 856km — Nagpur
        'PUNE', // 464km — Pune
        'ET', // 660km — Itarsi
        'BPL', // 650km — Bhopal
    ],
    // —— Vadodara (BRC) ——
    vadodara: [
        'ADI', // 101km — Ahmedabad
        'RTM', // 275km — Ratlam
        'BSL', // 420km — Bhusaval
        'NGP', // 760km — Nagpur
        'PUNE', // 360km — Pune
        'ET', // 533km — Itarsi
        'BPL', // 550km — Bhopal
        'KOTA', // 528km — Kota
        'ST', // 128km — Surat
    ],
    // —— Amritsar (ASR) ——
    amritsar: [
        'LDH', // 75km — Ludhiana
        'UMB', // 200km — Ambala
        'NDLS', // 449km — Delhi
        'CDG', // 110km — Chandigarh
        'JP', // 660km — Jaipur
        'AGC', // 565km — Agra
        'CNB', // 900km — Kanpur
        'MB', // 300km — Moradabad
    ],
    // —— Jammu (JAT) ——
    jammu: [
        'CDG', // 280km — Chandigarh
        'LDH', // 330km — Ludhiana
        'NDLS', // 576km — Delhi
        'UMB', // 360km — Ambala
        'MB', // 425km — Moradabad
        'AGC', // 680km — Agra
        'JP', // 786km — Jaipur
    ],
    // —— Goa/Madgaon (MAO) ——
    goa: [
        'RN', // 104km — Ratnagiri
        'MAJN', // 245km — Mangaluru
        'PUNE', // 460km — Pune
        'SBC', // 600km — Bengaluru
        'UBL', // 348km — Hubballi
        'MAS', // 1100km — Chennai
    ],
    madgaon: [
        'RN', // 104km — Ratnagiri
        'MAJN', // 245km — Mangaluru
        'PUNE', // 460km — Pune
        'SBC', // 600km — Bengaluru
        'UBL', // 348km — Hubballi
    ],
};
// ——— Deterministic Priority Corridors ———————————————————————————————————————
// PHASE_4C990: Expanded from 25 to 75+ corridors for Pan-India coverage.
// Key: "sourcecity-destcity" (lowercase, city name from getCity())
const DETERMINISTIC_CORRIDORS = {
    // —— Original Mumbai corridors ——
    "mumbai-gadag": ["SUR", "PUNE", "MRJ", "BGM", "UBL"],
    "mumbai-ubl": ["SUR", "PUNE", "MRJ", "BGM"],
    "mumbai-hubballi": ["SUR", "PUNE", "MRJ", "BGM"],
    "mumbai-hubli": ["SUR", "PUNE", "MRJ", "BGM"],
    "mumbai-hvr": ["SUR", "PUNE", "MRJ", "BGM", "UBL"],
    "mumbai-belagavi": ["SUR", "PUNE", "MRJ", "UBL"],
    "mumbai-belgaum": ["SUR", "PUNE", "MRJ", "UBL"],
    "mumbai-goa": ["RN", "MAO"],
    "mumbai-panaji": ["RN", "MAO"],
    "mumbai-solapur": ["PUNE", "SUR"],
    "mumbai-kolhapur": ["PUNE", "SUR", "MRJ"],
    "mumbai-bengaluru": ["SUR", "PUNE", "UBL"],
    "mumbai-bangalore": ["SUR", "PUNE", "UBL"],
    "mumbai-guwahati": ["HWH", "PNBE", "GHY", "NJP"],
    "mumbai-dibrugarh": ["HWH", "PNBE", "GHY", "NJP", "DBRG"],
    "mumbai-ernakulam": ["MAO", "MAJN", "ERS"],
    "mumbai-trivandrum": ["MAO", "MAJN", "ERS", "TVC"],
    "mumbai-mangalore": ["RN", "MAJN", "MAQ"],
    "mumbai-madgaon": ["RN", "MAO"],
    // —— Mumbai extended ——
    "mumbai-varanasi": ["BSL", "NGP", "ET", "PRYJ", "BSB"],
    "mumbai-patna": ["NGP", "ET", "PRYJ", "DDU", "PNBE"],
    "mumbai-lucknow": ["BSL", "ET", "BPL", "JHS", "CNB", "LKO"],
    "mumbai-delhi": ["BRC", "RTM", "KOTA", "AGC", "NDLS"],
    "mumbai-jaipur": ["BRC", "RTM", "KOTA", "JP"],
    "mumbai-kolkata": ["NGP", "ET", "BSL", "PRYJ", "HWH"],
    "mumbai-hyderabad": ["SUR", "SC", "PUNE"],
    "mumbai-secunderabad": ["SUR", "SC", "PUNE", "NGP"],
    "mumbai-vijayawada": ["SUR", "SC", "NGP", "BZA"],
    "mumbai-bhubaneswar": ["NGP", "VSKP", "BZA", "BBS"],
    "mumbai-vishakhapatnam": ["NGP", "SC", "BZA", "VSKP"],
    "mumbai-visakhapatnam": ["NGP", "SC", "BZA", "VSKP"],
    "mumbai-chennai": ["SUR", "SC", "NGP", "BZA", "MAS"],
    "mumbai-madurai": ["SUR", "SC", "SA", "MDU"],
    "mumbai-coimbatore": ["SUR", "SC", "SA", "CBE"],
    "mumbai-ahmedabad": ["BRC", "ST", "ADI"],
    "ahmedabad-mumbai": ["ADI", "ST", "BRC"],
    "mumbai-surat": ["ST", "BRC"],
    "mumbai-nagpur": ["BSL", "NGP"],
    "mumbai-bhopal": ["BSL", "ET", "BPL"],
    "mumbai-itarsi": ["BSL", "ET"],
    "mumbai-gorakhpur": ["BSL", "NGP", "ET", "BPL", "CNB", "LKO", "GKP"],
    // —— Delhi corridors ——
    "delhi-lko": ["CNB", "PRYJ"],
    "delhi-kolkata": ["CNB", "PRYJ", "DDU", "GAYA", "ASN", "HWH"],
    "delhi-trivandrum": ["ET", "NGP", "BZA", "ERS", "TVC"],
    "delhi-varanasi": ["AGC", "CNB", "PRYJ", "DDU", "BSB"],
    "delhi-patna": ["CNB", "PRYJ", "DDU", "GAYA", "PNBE"],
    "delhi-gorakhpur": ["CNB", "LKO", "GKP"],
    "delhi-guwahati": ["CNB", "PNBE", "KGP", "NJP", "GHY"],
    "delhi-bhopal": ["AGC", "JHS", "BPL"],
    "delhi-jaipur": ["AGC", "KOTA", "JP"],
    "delhi-ahmedabad": ["RTM", "BRC", "ADI"],
    "delhi-surat": ["RTM", "BRC", "ST"],
    "delhi-mumbai": ["KOTA", "RTM", "BRC", "PUNE"],
    "delhi-hyderabad": ["JHS", "ET", "NGP", "SC"],
    "delhi-secunderabad": ["JHS", "ET", "NGP", "SC"],
    "delhi-bangalore": ["JHS", "ET", "NGP", "SC", "SBC"],
    "delhi-bengaluru": ["JHS", "ET", "NGP", "SC", "SBC"],
    "delhi-chennai": ["BPL", "ET", "NGP", "BZA", "MAS"],
    "delhi-madurai": ["BPL", "NGP", "SC", "SA", "MDU"],
    "delhi-ernakulam": ["BPL", "NGP", "SC", "ERS"],
    "delhi-bhubaneswar": ["CNB", "PRYJ", "HWH", "KGP", "BBS"],
    "delhi-visakhapatnam": ["CNB", "DDU", "HWH", "BZA", "VSKP"],
    "delhi-nagpur": ["BPL", "ET", "NGP"],
    "delhi-indore": ["AGC", "KOTA", "RTM"],
    "delhi-raipur": ["ET", "NGP", "BSP"],
    "delhi-amritsar": ["CDG", "LDH", "ASR"],
    // —— Kolkata corridors ——
    "kolkata-bbs": ["KGP", "BLS", "CTC"],
    "kolkata-puri": ["KGP", "BLS", "CTC", "BBS", "KUR"],
    "kolkata-guwahati": ["MLDT", "NJP", "GHY"],
    "kolkata-dibrugarh": ["MLDT", "NJP", "GHY", "DBRG"],
    "kolkata-mumbai": ["KGP", "TATA", "NGP", "ET", "BSL", "PUNE"],
    "kolkata-delhi": ["ASN", "DHN", "MGS", "CNB", "NDLS"],
    "kolkata-chennai": ["KGP", "BBS", "VSKP", "BZA", "MAS"],
    "kolkata-bangalore": ["KGP", "VSKP", "BZA", "SC", "SBC"],
    "kolkata-bengaluru": ["KGP", "VSKP", "BZA", "SC", "SBC"],
    "kolkata-hyderabad": ["KGP", "VSKP", "BZA", "SC"],
    "kolkata-secunderabad": ["KGP", "BBS", "VSKP", "BZA", "SC"],
    "kolkata-patna": ["ASN", "DHN", "GAYA", "PNBE"],
    "kolkata-lucknow": ["ASN", "MGS", "PRYJ", "CNB", "LKO"],
    "kolkata-varanasi": ["ASN", "MGS", "BSB"],
    "kolkata-ahmedabad": ["KGP", "TATA", "NGP", "BPL", "RTM", "ADI"],
    "kolkata-ernakulam": ["KGP", "BBS", "VSKP", "BZA", "MAS", "ERS"],
    "kolkata-trivandrum": ["KGP", "BBS", "BZA", "MAS", "ERS", "TVC"],
    "kolkata-nagpur": ["KGP", "TATA", "NGP"],
    "kolkata-raipur": ["KGP", "TATA", "BSP"],
    // —— Chennai corridors ——
    "chennai-bangalore": ["KPD", "JTJ", "BWT"],
    "chennai-bengaluru": ["KPD", "JTJ", "BWT"],
    "chennai-trivandrum": ["SA", "CBE", "ERS"],
    "chennai-mumbai": ["BZA", "SC", "NGP", "BSL", "PUNE"],
    "chennai-delhi": ["BZA", "NGP", "ET", "BPL", "NDLS"],
    "chennai-kolkata": ["BZA", "VSKP", "KGP", "HWH"],
    "chennai-hyderabad": ["GDR", "RU", "BZA", "SC"],
    "chennai-secunderabad": ["GDR", "RU", "BZA", "SC"],
    "chennai-patna": ["BZA", "KGP", "HWH", "PNBE"],
    "chennai-lucknow": ["BZA", "NGP", "ET", "CNB", "LKO"],
    "chennai-ahmedabad": ["BZA", "NGP", "ET", "RTM", "ADI"],
    "chennai-bhubaneswar": ["BZA", "VSKP", "KGP", "BBS"],
    "chennai-madurai": ["SA", "MDU"],
    "chennai-coimbatore": ["SA", "CBE"],
    "chennai-ernakulam": ["SA", "CBE", "ERS"],
    "chennai-vijayawada": ["GDR", "RU", "BZA"],
    "chennai-visakhapatnam": ["GDR", "RU", "BZA", "VSKP"],
    // —— Bangalore/Bengaluru corridors ——
    "bengaluru-trivandrum": ["CBE", "ERS"],
    "bangalore-trivandrum": ["CBE", "ERS"],
    "bengaluru-mumbai": ["SUR", "PUNE", "UBL"],
    "bangalore-mumbai": ["SUR", "PUNE", "UBL"],
    "bengaluru-delhi": ["SC", "NGP", "ET", "BPL", "JHS", "NDLS"],
    "bangalore-delhi": ["SC", "NGP", "ET", "BPL", "JHS", "NDLS"],
    "bengaluru-kolkata": ["BZA", "VSKP", "KGP", "HWH"],
    "bangalore-kolkata": ["BZA", "VSKP", "KGP", "HWH"],
    "bengaluru-chennai": ["KPD", "JTJ", "BWT"],
    "bangalore-chennai": ["KPD", "JTJ", "BWT"],
    "bengaluru-patna": ["SC", "BZA", "KGP", "HWH", "PNBE"],
    "bangalore-patna": ["SC", "BZA", "KGP", "HWH", "PNBE"],
    "bengaluru-hyderabad": ["SC", "KCG"],
    "bangalore-hyderabad": ["SC", "KCG"],
    "bengaluru-varanasi": ["SC", "NGP", "ET", "PRYJ", "BSB"],
    "bengaluru-lucknow": ["SC", "NGP", "ET", "CNB", "LKO"],
    "bengaluru-ernakulam": ["CBE", "ERS"],
    "bengaluru-coimbatore": ["SA", "CBE"],
    "bengaluru-madurai": ["SA", "MDU"],
    "bengaluru-ahmedabad": ["SC", "NGP", "ET", "RTM", "ADI"],
    "bengaluru-bhubaneswar": ["SC", "BZA", "VSKP", "BBS"],
    "bengaluru-goa": ["UBL", "MAO"],
    "bangalore-goa": ["UBL", "MAO"],
    "bengaluru-nagpur": ["SC", "NGP"],
    "bengaluru-ratlam": ["SC", "NGP", "ET"],
    "ratlam-bengaluru": ["ET", "NGP", "SC"],
    "bengaluru-guwahati": ["BZA", "KGP", "HWH", "NJP", "GHY"],
    // —— Hyderabad/Secunderabad corridors ——
    "hyderabad-mumbai": ["PUNE", "SUR", "SC"],
    "secunderabad-mumbai": ["PUNE", "SUR", "SC"],
    "hyderabad-delhi": ["NGP", "ET", "BPL", "JHS", "NDLS"],
    "secunderabad-delhi": ["NGP", "ET", "BPL", "JHS", "NDLS"],
    "hyderabad-kolkata": ["BZA", "VSKP", "KGP", "HWH"],
    "hyderabad-patna": ["BZA", "KGP", "HWH", "PNBE"],
    "hyderabad-lucknow": ["NGP", "ET", "CNB", "LKO"],
    "hyderabad-chennai": ["BZA", "GDR", "MAS"],
    "hyderabad-bangalore": ["SC", "SBC"],
    "hyderabad-guwahati": ["BZA", "KGP", "HWH", "NJP", "GHY"],
    // —— Lucknow corridors ——
    "lucknow-mumbai": ["CNB", "JHS", "ET", "BSL", "NGP"],
    "lucknow-kolkata": ["PRYJ", "DDU", "GAYA", "ASN", "HWH"],
    "lucknow-chennai": ["CNB", "PRYJ", "BSB", "HWH", "BZA", "MAS"],
    "lucknow-hyderabad": ["CNB", "ET", "NGP", "SC"],
    "lucknow-bangalore": ["CNB", "ET", "NGP", "SC", "SBC"],
    "lucknow-patna": ["PRYJ", "DDU", "GAYA", "PNBE"],
    "lucknow-guwahati": ["PNBE", "KGP", "NJP", "GHY"],
    "lucknow-ahmedabad": ["JHS", "KOTA", "RTM", "ADI"],
    // —— Jaipur corridors ——
    "jaipur-mumbai": ["KOTA", "RTM", "BPL", "BSL", "NGP"],
    "jaipur-chennai": ["KOTA", "BPL", "NGP", "SC", "MAS"],
    "jaipur-kolkata": ["AGC", "CNB", "PRYJ", "DDU", "HWH"],
    "jaipur-bangalore": ["KOTA", "BPL", "ET", "NGP", "SC", "SBC"],
    "jaipur-hyderabad": ["KOTA", "BPL", "NGP", "SC"],
    "jaipur-lucknow": ["AGC", "CNB", "LKO"],
    "jaipur-patna": ["AGC", "CNB", "PRYJ", "DDU", "PNBE"],
    // —— Ahmedabad/Gujarat corridors ——
    "ahmedabad-chennai": ["RTM", "ET", "NGP", "BZA", "MAS"],
    "ahmedabad-kolkata": ["RTM", "BPL", "ET", "NGP", "HWH"],
    "ahmedabad-hyderabad": ["RTM", "BRC", "NGP", "SC"],
    "ahmedabad-bangalore": ["RTM", "BRC", "NGP", "SC", "SBC"],
    "ahmedabad-patna": ["RTM", "BPL", "ET", "PRYJ", "PNBE"],
    "ahmedabad-lucknow": ["RTM", "BPL", "ET", "CNB", "LKO"],
    // —— Patna/Bihar corridors ——
    "patna-mumbai": ["DDU", "ET", "BSL", "NGP", "PUNE"],
    "patna-chennai": ["HWH", "BBS", "VSKP", "BZA", "MAS"],
    "patna-bangalore": ["HWH", "BBS", "BZA", "SC", "SBC"],
    "patna-hyderabad": ["HWH", "BZA", "SC"],
    "patna-guwahati": ["KGP", "NJP", "GHY"],
    // —— Varanasi corridors ——
    "varanasi-mumbai": ["PRYJ", "JHS", "ET", "BSL", "NGP"],
    "varanasi-bangalore": ["PRYJ", "ET", "NGP", "SC", "SBC"],
    "varanasi-chennai": ["DDU", "HWH", "BZA", "MAS"],
    "varanasi-kolkata": ["DDU", "ASN", "HWH"],
    // —— East/NE corridors ——
    "bhubaneswar-mumbai": ["KGP", "TATA", "NGP", "ET", "BSL"],
    "bhubaneswar-delhi": ["KGP", "DHN", "MGS", "CNB", "NDLS"],
    "bhubaneswar-bangalore": ["KGP", "VSKP", "BZA", "SC", "SBC"],
    "visakhapatnam-mumbai": ["BZA", "SC", "NGP", "BSL"],
    "visakhapatnam-delhi": ["BZA", "NGP", "ET", "BPL", "NDLS"],
    "guwahati-mumbai": ["NJP", "HWH", "NGP", "ET", "BSL"],
    "guwahati-delhi": ["NJP", "MLDT", "HWH", "MGS", "CNB"],
    "guwahati-chennai": ["HWH", "KGP", "VSKP", "BZA", "MAS"],
    "guwahati-bangalore": ["HWH", "VSKP", "BZA", "SC", "SBC"],
    // —— South India internal ——
    "ernakulam-delhi": ["SA", "SC", "NGP", "ET", "BPL", "NDLS"],
    "ernakulam-mumbai": ["MAJN", "MAO", "PUNE"],
    "trivandrum-mumbai": ["ERS", "MAJN", "MAO", "PUNE"],
    "trivandrum-delhi": ["ERS", "CBE", "SC", "NGP", "BPL", "NDLS"],
    "madurai-mumbai": ["SA", "SC", "NGP", "BSL"],
    "madurai-delhi": ["SA", "SC", "NGP", "ET", "BPL", "NDLS"],
    "coimbatore-mumbai": ["SA", "SC", "NGP", "BSL"],
    "coimbatore-delhi": ["SA", "SC", "NGP", "ET", "BPL", "NDLS"],
    // —— Pan-India High-Traffic Corridors (Phase 087N57) ——
    // Western / Rajasthan
    "mumbai-ajmer": ["ADI", "BRC", "ST", "ABR", "MJ"],
    "ajmer-mumbai": ["ADI", "BRC", "ST", "ABR", "MJ"],
    "mumbai-udaipur": ["ST", "BRC", "ADI", "RTM", "COR", "UDZ"],
    "udaipur-mumbai": ["UDZ", "COR", "RTM", "ADI", "BRC", "ST"],
    "mumbai-jodhpur": ["ST", "BRC", "ADI", "ABR", "MJ", "JU"],
    "jodhpur-mumbai": ["JU", "MJ", "ABR", "ADI", "BRC", "ST"],
    "mumbai-bikaner": ["ST", "BRC", "ADI", "ABR", "JU", "BKN"],
    "bikaner-mumbai": ["BKN", "JU", "ABR", "ADI", "BRC", "ST"],
    "mumbai-indore": ["ST", "BRC", "RTM", "UJN", "INDB"],
    "indore-mumbai": ["INDB", "UJN", "RTM", "BRC", "ST"],
    "pune-delhi": ["MMR", "BSL", "ET", "BPL", "GWL", "AGC", "NDLS"],
    "delhi-pune": ["AGC", "GWL", "BPL", "ET", "BSL", "MMR", "PUNE"],
    "pune-ahmedabad": ["BSR", "ST", "BRC", "ADI"],
    "ahmedabad-pune": ["ADI", "BRC", "ST", "BSR", "PUNE"],
    "pune-jaipur": ["BSR", "ST", "BRC", "RTM", "KOTA", "JP"],
    "jaipur-pune": ["JP", "KOTA", "RTM", "BRC", "ST", "BSR", "PUNE"],
    "ahmedabad-jaipur": ["PNU", "ABR", "FA", "MJ", "AII", "JP"],
    "jaipur-ahmedabad": ["JP", "AII", "MJ", "FA", "ABR", "PNU", "ADI"],
    // Northern / Himalayan / Pilgrimage
    "delhi-ajmer": ["RE", "AWR", "JP", "KSG", "AII"],
    "ajmer-delhi": ["AII", "KSG", "JP", "AWR", "RE", "NDLS"],
    "delhi-jodhpur": ["RE", "AWR", "JP", "DNA", "MTD", "JU"],
    "jodhpur-delhi": ["JU", "MTD", "DNA", "JP", "AWR", "RE", "NDLS"],
    "delhi-udaipur": ["JP", "AII", "BHL", "COR", "UDZ"],
    "udaipur-delhi": ["UDZ", "COR", "BHL", "AII", "JP", "NDLS"],
    "delhi-jammu": ["UMB", "LDH", "JRC", "PTKC", "JAT"],
    "jammu-delhi": ["JAT", "PTKC", "JRC", "LDH", "UMB", "NDLS"],
    "delhi-dehradun": ["MTC", "SRE", "RK", "HW", "DDN"],
    "dehradun-delhi": ["DDN", "HW", "RK", "SRE", "MTC", "NDLS"],
    "delhi-chandigarh": ["PNP", "KKDE", "UMB", "CDG"],
    "chandigarh-delhi": ["CDG", "UMB", "KKDE", "PNP", "NDLS"],
    "delhi-haridwar": ["MTC", "SRE", "RK", "HW"],
    "haridwar-delhi": ["HW", "RK", "SRE", "MTC", "NDLS"],
    // Southern & Deccan
    "bengaluru-pune": ["UBL", "BGM", "MRJ", "STR", "PUNE"],
    "pune-bengaluru": ["PUNE", "STR", "MRJ", "BGM", "UBL", "SBC"],
    "bengaluru-jaipur": ["SC", "NGP", "ET", "BPL", "RTM", "KOTA", "JP"],
    "jaipur-bengaluru": ["JP", "KOTA", "RTM", "BPL", "ET", "NGP", "SC", "SBC"],
    "chennai-goa": ["RU", "GTL", "UBL", "MAO"],
    "goa-chennai": ["MAO", "UBL", "GTL", "RU", "MAS"],
    "hyderabad-goa": ["WADI", "GTL", "UBL", "MAO"],
    "goa-hyderabad": ["MAO", "UBL", "GTL", "WADI", "SC"],
    // Eastern & Central
    "kolkata-ajmer": ["ASN", "GAYA", "DDU", "PRYJ", "CNB", "AGC", "AII"],
    "ajmer-kolkata": ["AII", "AGC", "CNB", "PRYJ", "DDU", "GAYA", "ASN", "HWH"],
    "kolkata-ranchi": ["KGP", "TATA", "PRR", "MURI", "RNC"],
    "ranchi-kolkata": ["RNC", "MURI", "PRR", "TATA", "KGP", "HWH"],
    "patna-delhi": ["DDU", "PRYJ", "CNB", "NDLS"],
};
// ——— Hub Priority Tiers —————————————————————————————————————————————————————
const A_TIER_HUBS = [
    'NDLS', 'BRC', 'RTM', 'KOTA', 'PRYJ', 'DDU', 'CNB', 'NGP',
    'BPL', 'BZA', 'MAS', 'SBC', 'SC', 'ADI', 'PUNE', 'UBL', 'SUR'
];
const B_TIER_HUBS = [
    'BSL', 'GWL', 'ASN', 'TAT', 'ROU', 'JP', 'LKO', 'PNBE', 'VSKP'
];
const MAJOR_HUBS = [
    'NDLS', 'CSMT', 'HWH', 'SBC', 'MAS', 'SC', 'PNBE', 'LKO', 'CNB', 'ADI',
    'BPL', 'JP', 'NGP', 'BBS', 'GHY', 'CDG', 'BSB', 'PRYJ', 'DDU', 'KGP',
    'VSKP', 'BZA', 'GNT', 'UBL', 'PUNE', 'ST', 'BRC', 'KOTA', 'AGC', 'GWL',
    'JHS', 'GKP', 'BST', 'GD', 'MFP', 'SPJ', 'GAYA', 'BGP', 'MGS', 'ASN',
    'DHN', 'TATA', 'RNC', 'RYP', 'BSP', 'JBP', 'ET', 'BSL', 'MMR', 'NK',
    'BVI', 'SUR', 'GR', 'RC', 'GTL', 'RU', 'KPD', 'ED', 'CBE', 'PGT',
    'SRR', 'ERS', 'TVC', 'MDU', 'TPJ', 'VM', 'CGL',
    'RJT', 'BVC', 'MAO', 'RN', 'MAJN', 'KCG', 'SHM', 'MLDT', 'NJP', 'DBRG',
    'ABR', 'COR', 'UJN', 'INDB', 'JU', 'BHL', 'UMB', 'LDH', 'JRC', 'PTKC', 'JAT', 'HW', 'DDN', 'MTC', 'SRE'
];
// ——— Micro-hub blacklist — NEVER use these as split hubs ————————————————————
// These are suburban, local, or too-close stations that produce useless splits.
const MICRO_HUB_BLACKLIST = new Set([
    // Mumbai suburban cluster
    'KYN', 'KHOPOLI', 'KJT', 'KALVA', 'TBSP', 'PNVL', 'MMPN', 'DR', 'LTT',
    'CSTM', 'KSRA', 'KURLA', 'THANE', 'TNA', 'VASHI', 'PANVEL',
    // Delhi suburban cluster
    'ANVT', 'SZM', 'DEC', 'PTNR', 'GZB', 'FDB',
    // Bangalore suburban
    'BNC', 'KJM', 'YELK', 'YNK',
    // Chennai suburban
    'TBM', 'PER', 'MSB', 'MMCC', 'MBM',
    // Kolkata suburban
    'DUM', 'BLY', 'BALY',
    // Generic micro-stations (1-2 char codes often = small stops)
]);
// MIN distance from SOURCE for a hub to be valid (km)
const MIN_HUB_DISTANCE_KM = 100;
// Valid hubs — used for broad filtering (all major junctions)
const VALID_HUBS = [...new Set([...MAJOR_HUBS])];
// Backward-compat alias used in findCombinedRoutes console.log
const CORRIDOR_HUBS = PAN_INDIA_CORRIDOR_HUBS;
class RouteMemoryStore {
    constructor() {
        this.memory = new Map();
        this.MAX_SIZE = 500;
        this.EXPIRY_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
    }
    learn(source, destination, hub, waitMins, durationMins) {
        this.cleanup();
        const key = `${source.toLowerCase()}-${destination.toLowerCase()}-${hub.toUpperCase()}`;
        const existing = this.memory.get(key);
        if (existing) {
            existing.successCount += 1;
            existing.avgWaitMins = Math.round((existing.avgWaitMins * (existing.successCount - 1) + waitMins) / existing.successCount);
            existing.avgDurationMins = Math.round((existing.avgDurationMins * (existing.successCount - 1) + durationMins) / existing.successCount);
            existing.lastUsedTimestamp = Date.now();
        }
        else {
            if (this.memory.size >= this.MAX_SIZE) {
                let oldestKey = '';
                let oldestTime = Infinity;
                for (const [k, v] of this.memory.entries()) {
                    if (v.lastUsedTimestamp < oldestTime) {
                        oldestTime = v.lastUsedTimestamp;
                        oldestKey = k;
                    }
                }
                if (oldestKey) {
                    this.memory.delete(oldestKey);
                    logger_1.winstonLogger.debug(`[ROUTE_MEMORY_EXPIRE] LRU removed ${oldestKey}`);
                }
            }
            this.memory.set(key, {
                source,
                destination,
                hub,
                avgWaitMins: waitMins,
                avgDurationMins: durationMins,
                successCount: 1,
                lastUsedTimestamp: Date.now()
            });
        }
        logger_1.winstonLogger.debug(`[ROUTE_MEMORY_LEARN] source=${source} dest=${destination} hub=${hub} successCount=${this.memory.get(key)?.successCount}`);
    }
    getBonus(source, destination, hub) {
        this.cleanup();
        const key = `${source.toLowerCase()}-${destination.toLowerCase()}-${hub.toUpperCase()}`;
        const entry = this.memory.get(key);
        if (entry) {
            logger_1.winstonLogger.debug(`[ROUTE_MEMORY_HIT] source=${source} dest=${destination} hub=${hub}`);
            return 120;
        }
        return 0;
    }
    cleanup() {
        const now = Date.now();
        for (const [k, v] of this.memory.entries()) {
            if (now - v.lastUsedTimestamp > this.EXPIRY_MS) {
                this.memory.delete(k);
                logger_1.winstonLogger.debug(`[ROUTE_MEMORY_EXPIRE] TTL removed ${k}`);
            }
        }
    }
}
const successful_route_memory = new RouteMemoryStore();
class SplitAnalyticsMonitor {
    constructor() {
        this.events = [];
        this.metrics = [];
    }
    trackEvent(event, data = {}) {
        this.events.push({ event, timestamp: Date.now(), ...data });
        if (this.events.length > 5000)
            this.events.shift();
    }
    trackSearch(metrics) {
        this.metrics.push(metrics);
        if (this.metrics.length > 2000)
            this.metrics.shift();
    }
    getDashboardData() {
        const total = this.metrics.length || 1;
        const hubsCount = {};
        const failedCorridors = {};
        let totalDur = 0;
        let totalWait = 0;
        let successCount = 0;
        let cacheHits = 0;
        let memoryHits = 0;
        this.metrics.forEach(m => {
            if (m.status === 'SUCCESS' && m.hub) {
                hubsCount[m.hub] = (hubsCount[m.hub] || 0) + 1;
                totalDur += m.totalDuration;
                totalWait += m.waitTime;
                successCount++;
            }
            else if (m.status === 'EMPTY' || m.status === 'FAILED') {
                const key = `${m.source}-${m.destination}`;
                failedCorridors[key] = (failedCorridors[key] || 0) + 1;
            }
            if (m.cacheHit)
                cacheHits++;
            if (m.memoryHit)
                memoryHits++;
        });
        const topHubs = Object.entries(hubsCount).sort((a, b) => b[1] - a[1]).slice(0, 5).map(x => x[0]);
        const topFailed = Object.entries(failedCorridors).sort((a, b) => b[1] - a[1]).slice(0, 5).map(x => x[0]);
        return {
            topSuccessfulHubs: topHubs,
            topFailedCorridors: topFailed,
            avgSplitDuration: successCount ? Math.round(totalDur / successCount) : 0,
            avgWaitTime: successCount ? Math.round(totalWait / successCount) : 0,
            repeatSearchSuccessRate: Math.round((successCount / total) * 100),
            cacheEfficiency: Math.round((cacheHits / total) * 100),
            routeMemoryEfficiency: Math.round((memoryHits / total) * 100)
        };
    }
}
exports.SplitAnalyticsMonitor = SplitAnalyticsMonitor;
exports.split_analytics = new SplitAnalyticsMonitor();
// —— STEP 1 — FREEZE WORKING CONFIG ——
const MAX_SPLIT_RESULTS = 3;
// PHASE_5B182 — internal candidate pool. The engine must carry enough validated
// candidates into the downstream ranking/hub-cap/excludeVia pipeline so that
// "Generate New Alternative Routes" can surface a different hub. This is NOT the
// final API result count — the response sanitizer still caps regular/same-train
// output below.
const MAX_CANDIDATE_POOL_SPLITS = 12;
const MAX_WAIT_MINS = 720;
const MIN_WAIT_MINS = 30;
const MAX_TOTAL_MINS = 1800;
// PHASE_5B187 — progressive search envelopes (minutes). Tier 1 is the tightest
// connection window; later tiers widen only when Tier 1 did not yield enough
// validated candidates. These are search-envelope caps, not final API limits.
const TIER_1_TOTAL_MINS = 16 * 60;
const TIER_2_TOTAL_MINS = 24 * 60;
const TIER_3_TOTAL_MINS = MAX_TOTAL_MINS;
class SplitJourneyEngine {
    constructor() {
        this.MAX_HUBS = 8; // PHASE_4C990: raised from 5 to 8 for Pan-India coverage — more hubs = better alternatives
        this.MAX_TOTAL_CALLS = 40;
        this.MAX_ENGINE_TIME_MS = 22000;
        this.MAX_COMBOS_PER_HUB = 8;
        /** PHASE_087N111 — Phase 2 call reserve so Phase 1 candidate fanout never starves Leg-2 fetches */
        this.MIN_PHASE2_RESERVE = 15;
        this.PHASE1_HUB_CAP = 10;
        /** Hard budget for API fallback calls inside searchLeg. After this many ms
         *  from engine start, searchLeg skips live APIs and uses DB-only. */
        this.API_BUDGET_MS = 2000;
        /**
         * PHASE_084H — Running-days validation limits.
         * MAX_RD_VALIDATION_CALLS: maximum live getTrainInfo calls for running-days
         *   pre-fetch per search. Cache hits do not count toward this limit.
         * MAX_RD_CONCURRENT: maximum parallel getTrainInfo calls in the prefetch pool.
         * These are additive to the leg-search budget but never steals from it
         * because the pre-fetch runs after Phase 2 (leg searches) completes.
         */
        this.MAX_RD_VALIDATION_CALLS = 12;
        this.MAX_RD_CONCURRENT = 4;
        /** Minimum transfer window: 45 minutes — realistic Indian railway minimum */
        this.MIN_BUFFER_MINUTES = 45;
        /** Maximum transfer window: 14 hours — overnight hub stays are valid for Indian rail.
         * PHASE_087L: raised from 360→840 to match the actual runtime guard in findSplitsThroughHub
         * and to restore valid overnight hub connections (e.g. CSMT night arrival at PUNE,
         * next-afternoon departure to HYB) that were incorrectly rejected at the old 720-min ceiling. */
        this.MAX_BUFFER_MINUTES = 840;
        this.TARGET_RESULTS = 15; // was 10
        this.apiCallCount = 0;
        this.engineStartMs = 0;
        // Cache exclusively for split engine searches (3 minute TTL)
        this.legSearchCache = new Map();
        this.legSearchStats = { hits: 0, misses: 0 };
        /** P0-006: Coalesce concurrent split searches for the same route key. */
        this.routeInFlight = new Map();
    }
    // —————————————————————————————————————————————————————————————————————————
    // PHASE_084H — RUNNING-DAYS PRE-FETCH (Phase 2.5)
    //
    // Batch-fetches authoritative running-days for DB-sourced split candidates
    // before the pairing loop runs. This allows resolveSegmentForAvailability()
    // to reuse the already-fetched data instead of calling getTrainInfo again
    // per candidate during the pairing/trust-gate phase.
    //
    // Constraints:
    //   - MAX_RD_CONCURRENT (4): max parallel getTrainInfo calls in the pool
    //   - MAX_RD_VALIDATION_CALLS (12): max live API calls per search
    //   - cache hits (irctcService/cacheService) do not count as API calls
    //   - hard wall: never runs past remainingBudgetMs
    //   - fail-safe: fetch failure = UNKNOWN entry (conservative reject preserved)
    //   - deduplicates train numbers before fetching
    // —————————————————————————————————————————————————————————————————————————
    async prefetchRunningDays(candidateTrainNos, remainingBudgetMs) {
        const result = new Map();
        const wallDeadline = Date.now() + Math.min(remainingBudgetMs, 12000); // hard 12s wall
        let apiCalls = 0;
        let cacheHits = 0;
        // Build unique list — skip passenger-series trains (they are already filtered in isBasicallyValid)
        const uniqueNos = [...candidateTrainNos].filter(n => n && n.length >= 4 && !/^[567]/.test(n));
        if (uniqueNos.length === 0)
            return { cache: result, apiCalls, cacheHits };
        // Check cacheService first (the resolved schedule context already built by irctcService
        // may have running-days embedded). We use a best-effort check on existing keys.
        const toFetch = [];
        for (const tNo of uniqueNos) {
            // Check if we already have a schedule context cached from a prior call this search
            // (the trainStationResolver cacheKey is `sched_ctx_v4_<padded>`)
            const padded = tNo.padStart(5, '0');
            const existingCtx = cacheService_1.cacheService.get(`sched_ctx_v4_${padded}`);
            if (existingCtx && existingCtx.runningDaysAuthoritative === true && existingCtx.runningDays) {
                result.set(padded, {
                    trainNo: padded,
                    runningDays: existingCtx.runningDays,
                    runningDaysAuthoritative: true,
                    isCancelled: existingCtx.is_cancelled ?? null,
                    fetchedAt: Date.now(),
                });
                result.set(tNo, result.get(padded)); // also key by raw number
                cacheHits++;
            }
            else {
                toFetch.push(tNo);
            }
        }
        if (toFetch.length === 0 || apiCalls >= this.MAX_RD_VALIDATION_CALLS) {
            return { cache: result, apiCalls, cacheHits };
        }
        // Concurrency pool — process at most MAX_RD_CONCURRENT in parallel
        const pool = [];
        let idx = 0;
        const runNext = async () => {
            while (idx < toFetch.length && apiCalls < this.MAX_RD_VALIDATION_CALLS) {
                if (Date.now() >= wallDeadline)
                    break;
                const tNo = toFetch[idx++];
                const padded = tNo.padStart(5, '0');
                // Skip if already resolved by another concurrent slot
                if (result.has(padded))
                    continue;
                apiCalls++;
                try {
                    const info = await irctcService_1.irctcService.getTrainInfo(padded);
                    if (info) {
                        const inner = info.trainInfo || info;
                        const liveRd = inner?.running_days || inner?.runningDays ||
                            info?.running_days || info?.runningDays || null;
                        const liveCancelled = inner?.is_cancelled === true || inner?.isCancelled === true
                            ? true
                            : (inner?.is_cancelled === false || inner?.isCancelled === false ? false : null);
                        const liveStatus = inner?.train_status || inner?.status || info?.train_status || info?.status || '';
                        const isCancelledFromStatus = liveStatus && (liveStatus.toLowerCase().includes('cancel') || liveStatus.toLowerCase().includes('suspend'))
                            ? true
                            : null;
                        const isCancelled = liveCancelled !== null ? liveCancelled : isCancelledFromStatus;
                        const entry = {
                            trainNo: padded,
                            runningDays: liveRd,
                            runningDaysAuthoritative: !!liveRd,
                            isCancelled: isCancelled,
                            fetchedAt: Date.now(),
                        };
                        result.set(padded, entry);
                        result.set(tNo, entry); // also key by raw (unpadded) number
                    }
                    else {
                        // getTrainInfo returned nothing — store UNKNOWN entry (fail closed)
                        const unknownEntry = {
                            trainNo: padded,
                            runningDays: null,
                            runningDaysAuthoritative: false,
                            isCancelled: null,
                            fetchedAt: Date.now(),
                        };
                        result.set(padded, unknownEntry);
                        result.set(tNo, unknownEntry);
                    }
                }
                catch {
                    // Timeout or provider error — store UNKNOWN (fail closed, never fail open)
                    const unknownEntry = {
                        trainNo: padded,
                        runningDays: null,
                        runningDaysAuthoritative: false,
                        isCancelled: null,
                        fetchedAt: Date.now(),
                    };
                    result.set(padded, unknownEntry);
                    result.set(tNo, unknownEntry);
                }
            }
        };
        // Launch MAX_RD_CONCURRENT workers
        for (let w = 0; w < this.MAX_RD_CONCURRENT; w++) {
            pool.push(runNext());
        }
        await Promise.all(pool);
        return { cache: result, apiCalls, cacheHits };
    }
    // —————————————————————————————————————————————————————————————————————————
    // DETOUR AND DISTANCE LOGIC
    // —————————————————————————————————————————————————————————————————————————
    /**
     * Returns the MINIMUM km a hub must be from the source to be a valid split point.
     *
     * OLD BEHAVIOR (BUG): getMaxHubDistance() returned 350 for major origins (CSMT etc.)
     * and the filter `distKm >= requiredDist` would reject hubs CLOSER than 350km — e.g.
     * PUNE (~143km haversine from CSMT) was rejected for Mumbai-Solapur despite being an
     * explicit exception in the hub pool. The method name said "max" but acted as a minimum.
     *
     * NEW BEHAVIOR: Graduated 3-tier floor based on direct route haversine distance.
     *   - Short  (< 500km):  50km floor  — allows nearby junctions like Pune for short routes
     *   - Medium (< 1000km): 200km floor — sensible mid-range filter
     *   - Long   (≥ 1000km): 300km floor — restores near-original 350km behavior for
     *                                       long-haul routes (CSMT→HWH, CSMT→PNBE etc.)
     *                                       preventing hub-pool explosion in Step 6.
     * Falls back to MIN_HUB_DISTANCE_KM (100km) if coordinates unavailable.
     *
     * HOTFIX (2026-06-06): original implementation used `< 500 ? 50 : 150` which set the
     * long-haul floor to 150km — too permissive vs old 350km, causing ~2× larger hub pools
     * and 40+ second serial DB overhead in the isNearAnyDestStation Step 6 loop.
     */
    getMinHubDistance(sCode, dCode) {
        const srcStation = routeEngine_1.STATIONS[sCode];
        const dstStation = routeEngine_1.STATIONS[dCode];
        if (srcStation && dstStation) {
            const directKm = this._calculateHaversine(srcStation.lat, srcStation.lng, dstStation.lat, dstStation.lng);
            if (directKm < 500)
                return 50; // Short: allow nearby junctions (e.g. Pune for Mumbai-Solapur)
            if (directKm < 1000)
                return 200; // Medium: moderate filter
            return 300; // Long: near-original 350km behavior, prevents hub explosion
        }
        return MIN_HUB_DISTANCE_KM; // fallback constant (100km)
    }
    async isWithinRange(src, via, dest, maxDetour = 300) {
        const { stationService } = await Promise.resolve().then(() => __importStar(require('./stationService')));
        const cSrc = await stationService.getCoordinates(src);
        const cVia = await stationService.getCoordinates(via);
        const cDest = await stationService.getCoordinates(dest);
        if (!cSrc || !cVia || !cDest)
            return true; // fallback allow if no coords
        const dSrcVia = this._calculateHaversine(cSrc.lat, cSrc.lon, cVia.lat, cVia.lon);
        const dViaDest = this._calculateHaversine(cVia.lat, cVia.lon, cDest.lat, cDest.lon);
        const dSrcDest = this._calculateHaversine(cSrc.lat, cSrc.lon, cDest.lat, cDest.lon);
        return (dSrcVia + dViaDest) <= (dSrcDest + maxDetour);
    }
    _calculateHaversine(lat1, lon1, lat2, lon2) {
        const R = 6371;
        const dLat = ((lat2 - lat1) * Math.PI) / 180;
        const dLon = ((lon2 - lon1) * Math.PI) / 180;
        const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) *
                Math.sin(dLon / 2) * Math.sin(dLon / 2);
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }
    /**
     * Returns true if the via/hub station is within `thresholdKm` of ANY
     * destination station — meaning it IS effectively the destination.
     * Used to:
     *   - prune micro-split hubs (< 30 km from dest)
     *   - detect hub === destination (< 20 km guard)
     */
    async isNearAnyDestStation(via, dCodes, thresholdKm) {
        for (const dCode of dCodes) {
            const cVia = await stationService_1.stationService.getCoordinates(via);
            const cDest = await stationService_1.stationService.getCoordinates(dCode);
            if (!cVia || !cDest)
                continue;
            const dist = this._calculateHaversine(cVia.lat, cVia.lon, cDest.lat, cDest.lon);
            if (dist <= thresholdKm)
                return true;
        }
        return false;
    }
    // —————————————————————————————————————————————————————————————————————————
    // PUBLIC ENTRY POINT
    // —————————————————————————————————————————————————————————————————————————
    _splitRouteKey(source, destination, date) {
        return `${source.toUpperCase().trim()}_${destination.toUpperCase().trim()}_${date}`;
    }
    async findCombinedRoutes(source, destination, date, directTrains, userId, options) {
        date = date || new Date().toISOString().split('T')[0];
        const routeKey = this._splitRouteKey(source, destination, date);
        const pending = this.routeInFlight.get(routeKey);
        if (pending) {
            logger_1.winstonLogger.info(`[SPLIT_ENGINE] Coalescing in-flight split search for ${routeKey}`);
            return pending;
        }
        const operation = this._runFindCombinedRoutes(source, destination, date, directTrains, userId, options);
        this.routeInFlight.set(routeKey, operation);
        try {
            return await operation;
        }
        finally {
            if (this.routeInFlight.get(routeKey) === operation) {
                this.routeInFlight.delete(routeKey);
            }
        }
    }
    async _runFindCombinedRoutes(source, destination, date, directTrains, userId, options) {
        const t0 = Date.now();
        exports.split_analytics.trackEvent('search_started', { source, destination, date });
        logger_1.winstonLogger.debug(`[SPLIT_TRACE] ▶ findCombinedRoutes called: source=${source} destination=${destination} date=${date}`);
        try {
            const result = await this._findCombinedRoutesInternal(source, destination, date, directTrains, userId, options);
            // —— STEP 2 — RESPONSE SANITIZER ——
            let rawSplits = Array.isArray(result.split) ? result.split : [];
            let rejectedCount = 0;
            const seenCombos = new Set();
            const isTrainActive = (t, relaxedMode = false) => {
                if (!t)
                    return false;
                const num = String(t.trainNo || t.number || '').trim();
                // Reject unbookable slow passenger/local trains (numbers starting with 5, 6, or 7)
                if (num.length === 5 && /^[567]/.test(num)) {
                    logger_1.winstonLogger.debug(`[TRAIN_REJECTED_PASSENGER_SERIES] ${num}`);
                    return false;
                }
                // ── PRIORITY 1: HARD BLOCK — always reject these ──
                // Hard blacklist for known inactive/historic/suspended/cancelled trains
                if (['51411', '51412', '00000', '17321', '16332', '16340', '19023', '19024'].includes(num)) {
                    logger_1.winstonLogger.debug(`[TRAIN_REJECTED_CANCELLED] ${num}`);
                    return false;
                }
                const name = (t.trainName || t.name || '').toUpperCase();
                if (name.includes('CANCEL') || name.includes('SUSPENDED')) {
                    logger_1.winstonLogger.debug(`[TRAIN_REJECTED_CANCELLED] ${num}`);
                    return false;
                }
                // PATCH_4C922_A: Reject chair-car-only trains when user requests a sleeping class.
                // Vande Bharat, Shatabdi, Jan Shatabdi, Tejas trains only have CC/EC coaches —
                // they have no 2A, 3A, or SL berths. Provider returns CLASS_NOT_AVAILABLE.
                const SLEEPING_CLASSES = ['1A', '2A', '3A', 'SL'];
                const requestedClass = (options?.classType || 'SL').toUpperCase();
                if (Array.isArray(t.classes) && t.classes.length > 0) {
                    const hasClass = t.classes.some((c) => (typeof c === 'string' ? c : c.class || '').toUpperCase() === requestedClass);
                    if (!hasClass) {
                        logger_1.winstonLogger.debug(`[TRAIN_REJECTED_CLASS_MISMATCH] ${num} does not have requested class ${requestedClass}`);
                        return false;
                    }
                }
                if (SLEEPING_CLASSES.includes(requestedClass)) {
                    const CHAIR_CAR_KEYWORDS = ['VANDE BHARAT', 'VANDEBHARAT', 'SHATABDI', 'JAN SHATABDI', 'TEJAS EXP'];
                    if (CHAIR_CAR_KEYWORDS.some(kw => name.includes(kw))) {
                        logger_1.winstonLogger.debug(`[TRAIN_REJECTED_CLASS_MISMATCH] ${num} (${name}) is chair-car only; requested ${requestedClass}`);
                        return false;
                    }
                }
                if (requestedClass === 'SL') {
                    const PREMIUM_NO_SL_KEYWORDS = ['RAJDHANI', 'TEJAS RAJ', 'GARIB RATH', 'AC EXP', 'AC SF'];
                    if (PREMIUM_NO_SL_KEYWORDS.some(kw => name.includes(kw))) {
                        logger_1.winstonLogger.debug(`[TRAIN_REJECTED_CLASS_MISMATCH] ${num} (${name}) does not have SL class`);
                        return false;
                    }
                }
                // ── PRIORITY 2: SAFE VALIDATION ──
                // Cancellation Check
                if (classifyCancellationState(t) === 'CANCELLED') {
                    logger_1.winstonLogger.debug(`[TRAIN_REJECTED_CANCELLED] ${num}`);
                    return false;
                }
                // Service Date Truth Check — UNKNOWN fails closed, never allowed by default
                const trainDate = t.journeyDate || t.travelDate || t.departureDate || date;
                const rDays = t.runningDays || t.validDays || t.scheduleDays || t.travelDays || t.running_days;
                const verdict = (0, dayUtils_1.trainOperatesOnDate)(trainDate, rDays, {
                    validFrom: t.validFrom,
                    validTo: t.validTo,
                    runningDaysAuthoritative: t.runningDaysAuthoritative === true,
                    dayOffset: t.dayOffset || 0,
                });
                if (verdict !== 'YES') {
                    logger_1.winstonLogger.debug(`[TRAIN_REJECTED_SERVICE_DATE] ${num} verdict=${verdict} on ${trainDate}`);
                    return false;
                }
                // PATCH_4C922_B: Reject Duronto trains in all split proposals.
                // Duronto trains are semi-non-stop — IRCTC blocks booking for intermediate station
                // pairs (error: "BOOKING/CANCELLATION NOT ALLOWED FOR GIVEN PAIR OF STATIONS").
                // In a split journey, leg2 always boards at a hub (intermediate stop), so Duronto
                // trains can never be used as Leg 2. Leg 1 with intermediate source is equally invalid.
                if (name.includes('DURONTO')) {
                    logger_1.winstonLogger.debug(`[TRAIN_REJECTED_DURONTO] ${num} — Duronto trains cannot be used in split journey segments`);
                    return false;
                }
                return true;
            };
            const sanitizedSplits = rawSplits.filter(s => {
                if (!s || !s.hub || !s.legs || s.legs.length !== 2) {
                    rejectedCount++;
                    return false;
                }
                const l1 = s.legs[0];
                const l2 = s.legs[1];
                if (!isTrainActive(l1) || !isTrainActive(l2)) {
                    logger_1.winstonLogger.debug(`[SPLIT_FILTER_CANCELLED] Rejected split due to inactive train: ${l1?.trainNo} or ${l2?.trainNo}`);
                    rejectedCount++;
                    return false;
                }
                // Ensure standard fields exist
                if (typeof s.score !== 'number' || typeof s.totalDuration !== 'number') {
                    rejectedCount++;
                    return false;
                }
                const waitTime = s.wait_time ?? s.bufferMinutes;
                if (typeof waitTime !== 'number') {
                    rejectedCount++;
                    return false;
                }
                // Validate legs are valid
                if (!l1 || !l2 || !l1.trainNo || !l2.trainNo || l1.trainNo === '00000' || l2.trainNo === '00000') {
                    rejectedCount++;
                    return false;
                }
                // Duplicate combo protection
                const comboKey = `${s.hub}_${l1.trainNo}_${l2.trainNo}`;
                if (seenCombos.has(comboKey)) {
                    rejectedCount++;
                    return false;
                }
                seenCombos.add(comboKey);
                return true;
            });
            // ── FALLBACK SAFE MODE ──
            // If sanitizer removed ALL splits, retry with relaxed running-day checks
            // while still blocking cancelled/historical/archived trains
            let finalSanitized = sanitizedSplits;
            if (sanitizedSplits.length === 0 && rawSplits.length > 0) {
                logger_1.winstonLogger.warn(`[RELAXED_VALIDATION_RETRY] Sanitizer rejected all ${rawSplits.length} splits — retrying with relaxed mode`);
                const relaxedSeenCombos = new Set();
                finalSanitized = rawSplits.filter(s => {
                    if (!s || !s.hub || !s.legs || s.legs.length !== 2)
                        return false;
                    const l1 = s.legs[0];
                    const l2 = s.legs[1];
                    // Still block cancelled/historical — pass relaxedMode=true to skip running-day checks
                    if (!isTrainActive(l1, true) || !isTrainActive(l2, true)) {
                        logger_1.winstonLogger.debug(`[RELAXED_VALIDATION_RETRY] Still rejected: ${l1?.trainNo} or ${l2?.trainNo} (cancelled/historical)`);
                        return false;
                    }
                    if (typeof s.score !== 'number' || typeof s.totalDuration !== 'number')
                        return false;
                    const waitTime = s.wait_time ?? s.bufferMinutes;
                    if (typeof waitTime !== 'number')
                        return false;
                    if (!l1 || !l2 || !l1.trainNo || !l2.trainNo || l1.trainNo === '00000' || l2.trainNo === '00000')
                        return false;
                    const comboKey = `${s.hub}_${l1.trainNo}_${l2.trainNo}`;
                    if (relaxedSeenCombos.has(comboKey))
                        return false;
                    relaxedSeenCombos.add(comboKey);
                    return true;
                });
                logger_1.winstonLogger.info(`[RELAXED_VALIDATION_RETRY] Recovered ${finalSanitized.length} splits in relaxed mode`);
            }
            const totalFound = finalSanitized.length;
            const regularSplits = finalSanitized.filter((s) => !s.isSameTrain && s.rescueType !== 'SAME_TRAIN_SEGMENT');
            const sameTrainSplits = finalSanitized.filter((s) => s.isSameTrain || s.rescueType === 'SAME_TRAIN_SEGMENT');
            // ── DEDUP regular splits: multi-field combo key (hub + leg1 + leg2 + dep)
            const regularBestMap = new Map();
            for (const s of regularSplits) {
                const l1No = s.leg1?.trainNo || s.legs?.[0]?.trainNo || '';
                const l2No = s.leg2?.trainNo || s.legs?.[1]?.trainNo || '';
                const l1Dep = s.leg1?.departure || s.legs?.[0]?.departure || '';
                const l2Dep = s.leg2?.departure || s.legs?.[1]?.departure || '';
                const hub = s.hub || s.via || '';
                const comboKey = `${hub}_${l1No}_${l1Dep}_${l2No}_${l2Dep}`;
                const existing = regularBestMap.get(comboKey);
                const sWait = s.wait_time != null ? s.wait_time : (s.bufferMinutes != null ? s.bufferMinutes : 9999);
                const eWait = existing ? (existing.wait_time != null ? existing.wait_time : (existing.bufferMinutes != null ? existing.bufferMinutes : 9999)) : Infinity;
                if (!existing || sWait < eWait)
                    regularBestMap.set(comboKey, s);
            }
            const dedupedRegular = [...regularBestMap.values()];
            logger_1.winstonLogger.info(`[DEDUP_REGULAR] regular: ${regularSplits.length}→${dedupedRegular.length}`);
            // ── DEDUP same-train splits: same (leg1+leg2) trainNo combo → keep best hub
            // Fixes Delhi→GHY showing 12424 Rajdhani twice via NJP and CNB
            const sameTrainBestMap = new Map();
            for (const s of sameTrainSplits) {
                const l1No = s.legs?.[0]?.trainNo || '?';
                const l2No = s.legs?.[1]?.trainNo || '?';
                const comboKey = `${l1No}_${l2No}`;
                const existing = sameTrainBestMap.get(comboKey);
                const sWait = s.wait_time != null ? s.wait_time : (s.bufferMinutes != null ? s.bufferMinutes : 9999);
                const eWait = existing ? (existing.wait_time != null ? existing.wait_time : (existing.bufferMinutes != null ? existing.bufferMinutes : 9999)) : Infinity;
                if (!existing || sWait < eWait)
                    sameTrainBestMap.set(comboKey, s);
            }
            const dedupedSameTrain = [...sameTrainBestMap.values()];
            logger_1.winstonLogger.info(`[DEDUP_SAME_TRAIN] sameTrain: ${sameTrainSplits.length}→${dedupedSameTrain.length}`);
            // Return up to 6 regular + 2 same-train so frontend pagination has real variety
            const excludeVias = options?.excludeVia || [];
            let filteredRegular = excludeVias.length > 0
                ? dedupedRegular.filter((s) => !excludeVias.includes(s.hub))
                : dedupedRegular;
            let filteredSameTrain = excludeVias.length > 0
                ? dedupedSameTrain.filter((s) => !excludeVias.includes(s.hub))
                : dedupedSameTrain;
            // FAIL-SAFE: If excludeVias filtered out ALL available routes because no other hub exists for this corridor,
            // relax the hub exclusion so users still get valid alternative split routes.
            if (filteredRegular.length === 0 && filteredSameTrain.length === 0 && (dedupedRegular.length > 0 || dedupedSameTrain.length > 0)) {
                logger_1.winstonLogger.info(`[HUB_FILTER_RELAXED] excludeVias (${excludeVias.join(',')}) removed all routes. Falling back to all routes.`);
                filteredRegular = dedupedRegular;
                filteredSameTrain = dedupedSameTrain;
            }
            // ── PER-HUB CAP: max 2 results per hub for variety (e.g. KOTA showing 4x → cap to 2)
            // Sort by wait_time ascending first so best connection per hub is always included
            const sortedRegular = [...filteredRegular].sort((a, b) => {
                const wa = a.wait_time != null ? a.wait_time : (a.bufferMinutes != null ? a.bufferMinutes : 9999);
                const wb = b.wait_time != null ? b.wait_time : (b.bufferMinutes != null ? b.bufferMinutes : 9999);
                return wa - wb;
            });
            const hubCountMap = new Map();
            const MAX_PER_HUB = 2;
            const hubCappedRegular = [];
            for (const s of sortedRegular) {
                const hub = s.hub || s.via || 'unknown';
                const count = hubCountMap.get(hub) || 0;
                if (count < MAX_PER_HUB) {
                    hubCappedRegular.push(s);
                    hubCountMap.set(hub, count + 1);
                }
            }
            logger_1.winstonLogger.info(`[HUB_CAP] filtered: ${filteredRegular.length}→capped: ${hubCappedRegular.length}`);
            const topRegular = hubCappedRegular.slice(0, 6);
            const top2SameTrain = filteredSameTrain.slice(0, 2);
            const combinedSplits = [...topRegular, ...top2SameTrain];
            // ── PHASE_4C970: Apply premium gate (output transform only, no algo changes)
            const isPremiumUser = !!options?.isPremiumUser;
            const classType = options?.classType || 'SL';
            const gatedSplits = applyPremiumGate(combinedSplits, isPremiumUser, classType, source, destination);
            // GUARANTEE: Ensure EVERY leg on EVERY split contains all 8 required fields:
            // from, to, fromCode, toCode, travelDate, journeyDate, departureDate, arrivalDate
            const fullySanitizedSplits = gatedSplits.map((s) => {
                const hub = s.hub || s.via || '';
                const rawLegs = s.legs || s.trains || s.segments || [];
                const sanitizedLegs = rawLegs.map((leg, idx) => {
                    const defaultFrom = idx === 0 ? (s.source || source) : hub;
                    const defaultTo = idx === 0 ? hub : (s.destination || destination);
                    const defaultDate = idx === 0 ? (s.leg1?.travelDate || date) : (s.leg2?.travelDate || s.leg1?.travelDate || date);
                    const fromVal = leg.fromCode || leg.from || leg.source || defaultFrom;
                    const toVal = leg.toCode || leg.to || leg.destination || defaultTo;
                    const travelDateVal = leg.travelDate || leg.journeyDate || leg.departureDate || defaultDate;
                    const journeyDateVal = leg.journeyDate || leg.travelDate || leg.departureDate || defaultDate;
                    const departureDateVal = leg.departureDate || leg.travelDate || leg.journeyDate || defaultDate;
                    const arrivalDateVal = leg.arrivalDate || leg.travelDate || leg.journeyDate || defaultDate;
                    return {
                        ...leg,
                        from: fromVal,
                        to: toVal,
                        fromCode: fromVal,
                        toCode: toVal,
                        travelDate: travelDateVal,
                        journeyDate: journeyDateVal,
                        departureDate: departureDateVal,
                        arrivalDate: arrivalDateVal
                    };
                });
                const leg1Sanitized = sanitizedLegs[0] || s.leg1;
                const leg2Sanitized = sanitizedLegs[1] || s.leg2 || leg1Sanitized;
                return {
                    ...s,
                    leg1: leg1Sanitized,
                    leg2: leg2Sanitized,
                    legs: sanitizedLegs,
                    trains: sanitizedLegs,
                    segments: sanitizedLegs
                };
            });
            result.split = fullySanitizedSplits;
            result.splits = fullySanitizedSplits;
            result.smart_routes = fullySanitizedSplits;
            result.hasMoreSplits = regularSplits.length > 6 || sameTrainSplits.length > 2;
            result.totalFound = totalFound;
            // PHASE_084K — Diagnostic structure for split monitoring and missing route telemetry.
            // topRejectionReason must reflect the actual inner rejection reason — never
            // collapse to ROUTE_NOT_FOUND when candidates were generated and then rejected.
            let topRejectionReason = 'NONE';
            if (finalSanitized.length === 0) {
                // Pull inner rejection stats propagated from findSplitJourneys
                const innerStats = result._innerRejectionStats || {};
                // Determine the dominant failure reason ordered by priority
                const dominant = ((innerStats.running_days_unknown || 0) > 0 ? 'RUNNING_DAYS_UNKNOWN' :
                    (innerStats.train_not_running || 0) > 0 ? 'TRAIN_NOT_RUNNING' :
                        (innerStats.db_unverified_stop_data || 0) > 0 ? 'DB_UNVERIFIED_STOP_DATA' :
                            (innerStats.stop_not_found || 0) > 0 ? 'STOP_NOT_FOUND' :
                                (innerStats.trust_gate_reject || 0) > 0 ? 'TRUST_GATE_REJECT' :
                                    null);
                if (dominant) {
                    topRejectionReason = dominant;
                }
                else if (rawSplits.length === 0) {
                    topRejectionReason = 'ROUTE_NOT_FOUND';
                }
                else if (rejectedCount > 0) {
                    topRejectionReason = 'TRANSFER_BUFFER_FAILURE';
                }
                else {
                    topRejectionReason = 'ROUTE_NOT_FOUND';
                }
            }
            result.diagnostic = {
                candidateCount: rawSplits.length,
                rejectedCount: rejectedCount,
                rejectionStats: {
                    rawCandidates: rawSplits.length,
                    sanitizedCandidates: sanitizedSplits.length,
                    recoveredCandidates: finalSanitized.length,
                    sanitizerRejected: rejectedCount,
                    // PHASE_084K — inner stage breakdown
                    ...(result._innerRejectionStats || {}),
                },
                // PHASE_084K — granular running-days and stop counts for admin observability
                runningDaysUnknown: (result._innerRejectionStats || {}).running_days_unknown || 0,
                runningDaysRejected: ((result._innerRejectionStats || {}).running_days_unknown || 0) +
                    ((result._innerRejectionStats || {}).train_not_running || 0),
                stopNotFound: (result._innerRejectionStats || {}).stop_not_found || 0,
                dbUnverifiedStopData: (result._innerRejectionStats || {}).db_unverified_stop_data || 0,
                topRejectionReason: finalSanitized.length > 0 ? 'NONE' : topRejectionReason
            };
            if (combinedSplits.length > 0) {
                // Verification payload logging removed
            }
            logger_1.winstonLogger.debug(`[SPLIT_TRACE] ✅ findCombinedRoutes done in ${Date.now() - t0}ms | direct=${result.direct?.length} split=${result.split?.length}`);
            // —— STEP 8 — BACKEND QA LOGS ——
            logger_1.winstonLogger.info(`[SPLIT_ENGINE] Accepted splits: ${finalSanitized.length}`);
            logger_1.winstonLogger.info(`[SPLIT_ENGINE] Rejected splits: ${rejectedCount}`);
            if (finalSanitized.length !== sanitizedSplits.length) {
                logger_1.winstonLogger.info(`[SAFE_VALIDATION_MODE] Original: ${sanitizedSplits.length} -> Relaxed recovery: ${finalSanitized.length}`);
            }
            if (finalSanitized.length === 0) {
                exports.split_analytics.trackEvent('split_empty', { source, destination });
            }
            else {
                exports.split_analytics.trackEvent('split_generated', { count: finalSanitized.length });
            }
            const responseTime = Date.now() - t0;
            const bestSplit = finalSanitized[0];
            const isCacheHit = !!result._isCacheHit;
            const isMemoryHit = bestSplit && bestSplit._rankScore > 100;
            if (bestSplit) {
                exports.split_analytics.trackSearch({
                    source,
                    destination,
                    hub: bestSplit.hub || null,
                    waitTime: bestSplit.bufferMinutes || 0,
                    totalDuration: bestSplit.totalDuration || 0,
                    splitCount: finalSanitized.length,
                    responseTime,
                    cacheHit: isCacheHit,
                    memoryHit: isMemoryHit,
                    status: 'SUCCESS'
                });
            }
            else {
                exports.split_analytics.trackSearch({
                    source,
                    destination,
                    hub: null,
                    waitTime: 0,
                    totalDuration: 0,
                    splitCount: 0,
                    responseTime,
                    cacheHit: isCacheHit,
                    memoryHit: false,
                    status: 'EMPTY'
                });
            }
            return result;
        }
        catch (err) {
            logger_1.winstonLogger.error(`[SPLIT_TRACE] ❌ Engine threw: ${err?.message}`);
            throw err;
        }
    }
    // ——— INTERNAL IMPLEMENTATION —————————————————————————————————————————————
    async _findCombinedRoutesInternal(source, destination, date, directTrainsRef, userId, options) {
        this.engineStartMs = Date.now();
        this.apiCallCount = 0;
        this.legSearchStats = { hits: 0, misses: 0 };
        const classType = (options?.classType || 'SL').toUpperCase().trim();
        const quota = (options?.quota || 'GN').toUpperCase().trim();
        const excludeVia = Array.isArray(options?.excludeVia)
            ? options.excludeVia.map((v) => String(v).toUpperCase().trim()).filter(Boolean)
            : [];
        // PHASE_5B190 — excludeVia requests represent a different search intent than a
        // normal cached result (the cached result contains the very hubs being excluded).
        // Force fresh computation whenever excludeVia is non-empty so tiered hub
        // discovery and the provider/trust gates can actually find a different hub.
        const bypassSplitCacheForExcludeVia = excludeVia.length > 0;
        // —— SPLIT CACHE CHECK ————————————————————————————————————————————————————
        // Key includes source + destination + date + includeSplit flag + classType + quota.
        // PHASE_5B109 — a cache entry is only honoured if it was produced by the
        // current trust gate. Entries written before the gate existed (or by an older
        // gate revision) are treated as a MISS and recomputed. TTLs are unchanged;
        // this is a payload-level version check, not a TTL or key-format change.
        //
        // PHASE_5B167 — every cached leg is re-validated generically (service-date
        // truth + cancellation). Unknown service-date truth fails closed, so a stale
        // or missing running_days / cancellation field forces a fresh computation.
        /**
         * Generic cached-payload revalidation. Every leg must:
         *  - carry a service date,
         *  - resolve trainOperatesOnDate() to YES (UNKNOWN fails closed), and
         *  - not be cancelled (UNKNOWN cancellation fails closed).
         * Physical SN invariants are not re-asserted here: the trust gate already
         * rewrote station identity before caching, and the version bump ensures old
         * payloads never reach this branch.
         */
        const cachedResultNeedsRevalidation = (result) => {
            const allLegs = (result.split || []).flatMap((s) => s.legs || [s.leg1, s.leg2].filter(Boolean));
            for (const leg of allLegs) {
                const trainNo = String(leg.trainNo || leg.number || '').trim();
                const serviceDate = leg.travelDate || leg.journeyDate || leg.departureDate || undefined;
                const runningDays = leg.running_days || leg.runningDays || undefined;
                if (!trainNo || !serviceDate)
                    return true;
                if (classifyCancellationState(leg) === 'CANCELLED') {
                    logger_1.winstonLogger.warn(`[CACHE_REVALIDATION_MISS] ${source}→${destination}/${date} leg ${trainNo} cancelled — forcing fresh computation`);
                    return true;
                }
                const operates = (0, dayUtils_1.trainOperatesOnDate)(serviceDate, runningDays, {
                    validFrom: leg.validFrom,
                    validTo: leg.validTo,
                    runningDaysAuthoritative: true, // verified trust-gated payload
                    dayOffset: leg.dayOffset || 0,
                });
                if (operates !== 'YES') {
                    logger_1.winstonLogger.warn(`[CACHE_REVALIDATION_MISS] ${source}→${destination}/${date} leg ${trainNo} service-date=${operates} — forcing fresh computation`);
                    return true;
                }
            }
            return false;
        };
        const cached = bypassSplitCacheForExcludeVia
            ? null
            : cacheService_1.cacheService.getCachedSplit(source, destination, date, true, classType, quota);
        if (bypassSplitCacheForExcludeVia) {
            logger_1.winstonLogger.info(`[SPLIT_ENGINE] 🔀 Bypassing split cache for excludeVia request (${excludeVia.join(',')})`);
        }
        else if (cached && !isTrustGatedPayload(cached)) {
            logger_1.winstonLogger.warn(`[TRUST_GATE_STALE_CACHE] Discarding pre-gate L1 split cache entry for ${source}→${destination} on ${date}`);
        }
        else if (cached) {
            if (cachedResultNeedsRevalidation(cached)) {
                logger_1.winstonLogger.warn(`[CACHE_REVALIDATION] L1 cache miss for ${source}→${destination} on ${date}`);
                cacheService_1.cacheService.del(cacheService_1.cacheService.generateSplitKey(source, destination, date, true, classType, quota));
            }
            else {
                logger_1.winstonLogger.info(`[SPLIT_ENGINE] 📦 Returning cached split result for ${source}→${destination} on ${date}`);
                const cachedResult = cached;
                cachedResult._isCacheHit = true;
                logger_1.winstonLogger.info(`[SPLIT_ENGINE_TRACE] CACHE_HIT: source=${source}, destination=${destination}, date=${date}, direct_count=${cachedResult.direct?.length || 0}, split_count=${cachedResult.split?.length || 0}`);
                return cachedResult;
            }
        }
        // Check database-level cache as second-tier cache
        if (!bypassSplitCacheForExcludeVia) {
            try {
                const { supabase } = await Promise.resolve().then(() => __importStar(require('../config/supabase')));
                const dbKey = `split_${source.toUpperCase().trim()}_${destination.toUpperCase().trim()}_${date}_${classType}_${quota}`;
                const { data, error } = await supabase
                    .from('api_search_cache')
                    .select('response, expires_at')
                    .eq('route_key', dbKey)
                    .single();
                if (!error && data) {
                    if (new Date(data.expires_at) >= new Date()) {
                        const parsed = JSON.parse(data.response);
                        // PHASE_5B109 — same version check on L3.
                        if (!isTrustGatedPayload(parsed)) {
                            logger_1.winstonLogger.warn(`[TRUST_GATE_STALE_CACHE] Discarding pre-gate DB split cache entry for ${source}→${destination} on ${date}`);
                        }
                        else if (cachedResultNeedsRevalidation(parsed)) {
                            logger_1.winstonLogger.warn(`[CACHE_REVALIDATION] DB cache miss for ${source}→${destination} on ${date}`);
                        }
                        else {
                            logger_1.winstonLogger.info(`[SPLIT_ENGINE] 🗄️ Returning DB cached split result for ${source}→${destination} on ${date}`);
                            parsed._isCacheHit = true;
                            // Store it in in-memory cache
                            cacheService_1.cacheService.cacheSplit(source, destination, date, parsed, true, classType, quota);
                            return parsed;
                        }
                    }
                }
            }
            catch (e) {
                logger_1.winstonLogger.warn(`[SPLIT_DB_CACHE] Read failed for ${source}→${destination}: ${e.message}`);
            }
        }
        // —— Resolve city → all station codes ——————————————————————————————————————
        const sCodes = await this.resolveCityStations(source);
        const dCodes = await this.resolveCityStations(destination);
        const sCode = sCodes[0];
        const dCode = dCodes[0];
        const [sNameResolved, dNameResolved] = await Promise.all([
            stationService_1.stationService.getStationName(sCode),
            stationService_1.stationService.getStationName(dCode),
        ]);
        const sName = sNameResolved || source;
        const dName = dNameResolved || destination;
        logger_1.winstonLogger.info(`[SPLIT_ENGINE] Source stations: [${sCodes.join(',')}] Dest stations: [${dCodes.join(',')}]`);
        const fromCity = getCity(sCode);
        const toCity = getCity(dCode);
        logger_1.winstonLogger.info(`[SPLIT_ENGINE] ${sName} [${sCodes.join(',')}] → ${dName} [${dCodes.join(',')}] on ${date}`);
        if (fromCity === toCity) {
            logger_1.winstonLogger.info(`[SPLIT_ENGINE] Rejected: Source and destination are in the same city (${fromCity})`);
            return { direct: directTrainsRef || await this.getDirectTrainsForCity(sCodes, dCodes, date), split: [], split_recommended: false, message: 'Source and destination are in the same city' };
        }
        const _directTrainsRaw = directTrainsRef ?? await this.getDirectTrainsForCity(sCodes, dCodes, date);
        let directTrains = Array.isArray(_directTrainsRaw) ? _directTrainsRaw : [];
        // M2: drop directs proven reverse on schedule (fail-open if unproven)
        const sanitizedDirects = [];
        for (const leg of directTrains) {
            const tNo = String(leg.trainNo || leg.number || '').trim();
            const legFrom = String(leg.fromCode || leg.from || leg.fromStationCode || sCode || '').trim();
            const legTo = String(leg.toCode || leg.to || leg.toStationCode || dCode || '').trim();
            if (tNo && legFrom && legTo && await this.isProvenReverseScheduleSegment(tNo, legFrom, legTo)) {
                logger_1.winstonLogger.debug(`[TRAIN_REJECTED_REVERSE_SN] direct ${tNo} ${legFrom}->${legTo}`);
                continue;
            }
            sanitizedDirects.push(leg);
        }
        directTrains = sanitizedDirects;
        const shouldRecommendSplit = this.checkSplitRecommendation(directTrains);
        let splitJourneys = [];
        let message = '';
        const engineStart = Date.now();
        logger_1.winstonLogger.info(`[SPLIT_ENGINE] Running hub search (direct=${directTrains.length}, recommended=${shouldRecommendSplit})`);
        const segmentClass = options?.classType || '3A';
        const segmentQuota = options?.quota || 'GN';
        const { segmentAvailabilityEngine } = await Promise.resolve().then(() => __importStar(require('./segmentAvailabilityEngine')));
        const segmentSplitsPromise = segmentAvailabilityEngine
            .findSegmentSplits(source.toUpperCase(), destination.toUpperCase(), date, directTrains, segmentClass, segmentQuota)
            .catch((e) => {
            logger_1.winstonLogger.warn(`[SPLIT_ENGINE] Failed to resolve same-train segment splits: ${e.message}`);
            return [];
        });
        splitJourneys = await this.findSplitJourneys(sName, dName, sCodes, dCodes, date, directTrains);
        // PHASE_084K — harvest the per-stage rejection stats attached by findSplitJourneys
        const innerRejectionStats = splitJourneys._rejectionStats || {};
        logger_1.winstonLogger.info(`[SPLIT_ENGINE] Engine completed in ${Date.now() - engineStart}ms | direct=${directTrains.length} split=${splitJourneys.length}`);
        if (Object.keys(innerRejectionStats).some(k => innerRejectionStats[k] > 0)) {
            logger_1.winstonLogger.info(`[SPLIT_ENGINE] Inner rejection stats: ${JSON.stringify(innerRejectionStats)}`);
        }
        // —— TWO-TIER VALIDATION: STRICT → RELAXED FALLBACK ——
        let rawSplits = Array.isArray(splitJourneys) ? splitJourneys : [];
        let safeSplits = [];
        // Helper: Check if train is explicitly invalid (cancelled, suspended, historical, dummy)
        const isExplicitlyInvalid = (leg) => {
            const num = String(leg.trainNo || leg.number || '').trim();
            const name = String(leg.trainName || leg.name || '').toUpperCase();
            // Reject known dummy placeholders and permanently cancelled/discontinued trains
            if (!num || num === '00000' || num.length < 4)
                return true;
            if (['51411', '51412', '00000', '17321', '16332', '16340', '19023', '19024'].includes(num))
                return true;
            if (name.includes('CANCEL') || name.includes('SUSPENDED') || name.includes('HISTORICAL'))
                return true;
            if (/^(PASSENGER|UNKNOWN EXPRESS|UNKNOWN TRAIN)\s*\d*/i.test(name.trim()))
                return true;
            return false;
        };
        // Helper: Validate leg structure (requires routing data, valid timings)
        const hasValidStructure = (leg) => {
            const num = String(leg.trainNo || leg.number || '').trim();
            if (!leg.from || !leg.to || !leg.departure || !leg.arrival) {
                logger_1.winstonLogger.debug(`[SPLIT_REJECTED] Leg ${num} missing routing data`);
                return false;
            }
            if (typeof leg.durationMins === 'number' && isNaN(leg.durationMins)) {
                logger_1.winstonLogger.debug(`[SPLIT_REJECTED] Leg ${num} has NaN duration`);
                return false;
            }
            return true;
        };
        // STEP 1: STRICT VALIDATION (with hydration)
        const strictValidatedSplits = [];
        for (const split of rawSplits) {
            if (!split || !split.legs || split.legs.length !== 2)
                continue;
            let validSplit = true;
            for (const leg of split.legs) {
                const num = String(leg.trainNo || leg.number || '').trim();
                // Reject explicitly invalid trains
                if (isExplicitlyInvalid(leg)) {
                    logger_1.winstonLogger.debug(`[STRICT_VALIDATION] Rejecting ${num} — explicitly invalid`);
                    validSplit = false;
                    break;
                }
                // Reject if missing structure
                if (!hasValidStructure(leg)) {
                    validSplit = false;
                    break;
                }
                // Strict: Attempt hydration of fabricated names
                let tName = leg.trainName || leg.name || '';
                const isFabricated = !tName ||
                    /^(Passenger|Unknown Express|Unknown Train|Train)\s*\d*/i.test(tName.trim());
                if (isFabricated) {
                    const dbT = dbTrains_json_1.default.find((t) => String(t.trainNo) === num || String(t.number) === num);
                    if (dbT && dbT.name && !/^(Passenger|Unknown Express|Unknown Train|Train)\s*\d*/i.test(dbT.name)) {
                        tName = dbT.name;
                        leg.trainName = tName;
                        leg.name = tName;
                        logger_1.winstonLogger.debug(`[STRICT_VALIDATION] Hydrated ${num}: ${tName}`);
                    }
                    else {
                        // In strict mode, missing name fails validation
                        logger_1.winstonLogger.debug(`[STRICT_VALIDATION] Rejecting ${num} — name unavailable`);
                        validSplit = false;
                        break;
                    }
                }
                // Reject invalid totalDuration
                if (typeof split.totalDuration === 'number' && isNaN(split.totalDuration)) {
                    logger_1.winstonLogger.debug(`[STRICT_VALIDATION] Rejecting split hub ${split.hub} — NaN duration`);
                    validSplit = false;
                    break;
                }
            }
            if (validSplit) {
                strictValidatedSplits.push(split);
            }
        }
        safeSplits = [...strictValidatedSplits];
        // STEP 2: RELAXED FALLBACK (if strict validation eliminated all splits)
        if (safeSplits.length === 0 && rawSplits.length > 0) {
            logger_1.winstonLogger.info(`[RELAXED_VALIDATION_MODE] Strict validation found 0 splits from ${rawSplits.length} — activating relaxed fallback`);
            const relaxedValidatedSplits = [];
            for (const split of rawSplits) {
                if (!split || !split.legs || split.legs.length !== 2)
                    continue;
                let validSplit = true;
                for (const leg of split.legs) {
                    const num = String(leg.trainNo || leg.number || '').trim();
                    // RELAXED: Still reject explicitly invalid trains
                    if (isExplicitlyInvalid(leg)) {
                        logger_1.winstonLogger.debug(`[RELAXED_VALIDATION] Rejecting ${num} — explicitly invalid`);
                        validSplit = false;
                        break;
                    }
                    // RELAXED: Still require valid structure (routing + timings)
                    if (!hasValidStructure(leg)) {
                        logger_1.winstonLogger.debug(`[RELAXED_VALIDATION] Rejecting ${num} — invalid structure`);
                        validSplit = false;
                        break;
                    }
                    // RELAXED: Allow trains even if name cannot be hydrated
                    // Just try hydration, don't fail if it doesn't work
                    let tName = leg.trainName || leg.name || '';
                    const isFabricated = !tName ||
                        /^(Passenger|Unknown Express|Unknown Train|Train)\s*\d*/i.test(tName.trim());
                    if (isFabricated) {
                        const dbT = dbTrains_json_1.default.find((t) => String(t.trainNo) === num || String(t.number) === num);
                        if (dbT && dbT.name && !/^(Passenger|Unknown Express|Unknown Train|Train)\s*\d*/i.test(dbT.name)) {
                            leg.trainName = dbT.name;
                            leg.name = dbT.name;
                            logger_1.winstonLogger.debug(`[RELAXED_VALIDATION] Hydrated ${num}: ${dbT.name}`);
                        }
                        else {
                            // In relaxed mode, allow train even without hydrated name
                            // Set a safe placeholder that indicates live data pending
                            if (!tName || tName.length === 0) {
                                leg.trainName = `Train ${num}`;
                                leg.name = `Train ${num}`;
                            }
                            logger_1.winstonLogger.debug(`[RELAXED_VALIDATION] Allowing ${num} without hydration`);
                        }
                    }
                }
                if (validSplit && typeof split.totalDuration === 'number' && !isNaN(split.totalDuration)) {
                    relaxedValidatedSplits.push(split);
                }
            }
            if (relaxedValidatedSplits.length > 0) {
                logger_1.winstonLogger.info(`[RELAXED_VALIDATION_MODE] ✅ Recovered ${relaxedValidatedSplits.length} splits using relaxed validation`);
                safeSplits = relaxedValidatedSplits;
            }
        }
        else if (safeSplits.length > 0 && rawSplits.length > safeSplits.length) {
            logger_1.winstonLogger.info(`[RELAXED_RECOVERY_MODE] Strict validation verified ${safeSplits.length} splits. Running relaxed validation on remaining ${rawSplits.length - safeSplits.length} candidates.`);
            const remainingCandidates = rawSplits.filter(s => !strictValidatedSplits.includes(s));
            const recoveredSplits = [];
            for (const split of remainingCandidates) {
                if (!split || !split.legs || split.legs.length !== 2)
                    continue;
                let validSplit = true;
                for (const leg of split.legs) {
                    const num = String(leg.trainNo || leg.number || '').trim();
                    // RELAXED: Still reject explicitly invalid trains
                    if (isExplicitlyInvalid(leg)) {
                        logger_1.winstonLogger.debug(`[RELAXED_RECOVERY] Rejecting ${num} — explicitly invalid`);
                        validSplit = false;
                        break;
                    }
                    // RELAXED: Still require valid structure (routing + timings)
                    if (!hasValidStructure(leg)) {
                        logger_1.winstonLogger.debug(`[RELAXED_RECOVERY] Rejecting ${num} — invalid structure`);
                        validSplit = false;
                        break;
                    }
                    // RELAXED: Allow trains even if name cannot be hydrated
                    let tName = leg.trainName || leg.name || '';
                    const isFabricated = !tName ||
                        /^(Passenger|Unknown Express|Unknown Train|Train)\s*\d*/i.test(tName.trim());
                    if (isFabricated) {
                        const dbT = dbTrains_json_1.default.find((t) => String(t.trainNo) === num || String(t.number) === num);
                        if (dbT && dbT.name && !/^(Passenger|Unknown Express|Unknown Train|Train)\s*\d*/i.test(dbT.name)) {
                            leg.trainName = dbT.name;
                            leg.name = dbT.name;
                            logger_1.winstonLogger.debug(`[RELAXED_RECOVERY] Hydrated ${num}: ${dbT.name}`);
                        }
                        else {
                            if (!tName || tName.length === 0) {
                                leg.trainName = `Train ${num}`;
                                leg.name = `Train ${num}`;
                            }
                            logger_1.winstonLogger.debug(`[RELAXED_RECOVERY] Allowing ${num} without hydration`);
                        }
                    }
                }
                if (validSplit && typeof split.totalDuration === 'number' && !isNaN(split.totalDuration)) {
                    recoveredSplits.push(split);
                }
            }
            if (recoveredSplits.length > 0) {
                logger_1.winstonLogger.info(`[RELAXED_RECOVERY_MODE] ✅ Recovered ${recoveredSplits.length} additional splits`);
                safeSplits.push(...recoveredSplits);
            }
        }
        // —— SAME-TRAIN SEGMENT RESCUES (started in parallel with hub search — PHASE_4C880) ——
        const sameTrainSplits = await segmentSplitsPromise;
        logger_1.winstonLogger.info(`[SPLIT_ENGINE] Same-train segment splits found: ${sameTrainSplits.length}`);
        // Merge same-train splits with regular splits
        const mergedSplits = [...sameTrainSplits, ...safeSplits];
        // —— PHASE_5B109 COMMON PHYSICAL TRUST GATE ————————————————————————————
        // Single choke point for EVERY producer (hub search + same-train segment
        // scan + fallbacks). Candidates are validated against the physical schedule
        // of each leg's own train and their station identity is rewritten from the
        // matched schedule rows. Sinks (cache + learning) always receive only the
        // trusted subset; in shadow mode the API response is left untouched.
        const gate = await this.candidateTrustGate(mergedSplits, directTrains, sCodes, dCodes, date, classType, quota);
        const trustedSplits = gate.trusted;
        // Re-rank the merged list to ensure optimal ordering
        const { rankingService } = await Promise.resolve().then(() => __importStar(require('./rankingService')));
        const rankedSplits = rankingService.rankTrains(gate.forApi);
        safeSplits = rankedSplits;
        message = safeSplits.length > 0
            ? 'Better options available via smart split journey'
            : 'No good split options found';
        // —— ROUTE MEMORY LEARNING ————————————————————————————————————————————————
        // PHASE_5B091 — Only learn from verified routes (LIVE_VERIFIED / DB_VERIFIED)
        // PHASE_5B109 — Learning now reads the TRUST-GATED subset, never the raw
        // merged list. This holds in shadow mode too: sinks stay fail-closed even
        // while the API response is left unchanged for observation.
        trustedSplits.forEach(split => {
            const hCode = split.leg1?.toCode || split.leg2?.fromCode || split.hub;
            const prov = split._provenance || 'DB_UNVERIFIED';
            if (hCode && split.bufferMinutes !== undefined && split.totalDuration !== undefined && (prov === 'LIVE_VERIFIED' || prov === 'DB_VERIFIED')) {
                successful_route_memory.learn(sName, dName, hCode, split.bufferMinutes, split.totalDuration);
            }
            else {
                logger_1.winstonLogger.debug(`[LEARNING_GATE_SKIPPED] Split for hub ${hCode} with provenance ${prov} skipped from route_memory`);
            }
        });
        // —— PERSISTENT SPLIT LEARNING (POST-GATE — PHASE_5B109) ————————————————————
        // Relocated from findSplitJourneys(), where it ran on the top *raw* candidate
        // before any validation. It now records only a trust-gated candidate, and the
        // returned telemetry id is stamped back onto the response so click-through
        // attribution keeps working.
        await this.persistSplitLearning(sCode, dCode, trustedSplits, safeSplits);
        logger_1.winstonLogger.info(`[SPLIT_ENGINE] FINAL SUMMARY: direct=${directTrains.length} split=${safeSplits.length}`);
        const result = {
            direct: directTrains,
            split: safeSplits,
            smart_routes: safeSplits, // duplicate key for frontend compat
            split_recommended: safeSplits.length > 0 && shouldRecommendSplit,
            message
        };
        // PHASE_084K — propagate inner rejection stats for diagnostic aggregation in _runFindCombinedRoutes
        result._innerRejectionStats = innerRejectionStats;
        // —— PHASE_5B109 CACHE PAYLOAD (TRUST-GATED) ——————————————————————————————
        // The cache is a SINK, and sinks are fail-closed regardless of gate mode.
        // In `enforce` mode this is identical to `result`. In `shadow`/`off` mode the
        // live response may still carry unproven candidates for observation, but a
        // rejected candidate must never be written to L1/L3 and served back later as
        // if it had been validated. `_trustGateVersion` lets the read path reject
        // entries produced before this gate existed (cacheService.ts is out of scope
        // for key changes, so the marker travels inside the payload instead).
        const trustedRanked = trustedSplits.length > 0
            ? rankingService.rankTrains(trustedSplits)
            : [];
        const cacheableResult = {
            direct: directTrains,
            split: trustedRanked,
            smart_routes: trustedRanked,
            split_recommended: trustedRanked.length > 0 && shouldRecommendSplit,
            message,
            _trustGateVersion: TRUST_GATE_VERSION
        };
        // —— SPLIT CACHE STORE ————————————————————————————————————————————————————
        // DO NOT cache "No Split Routes Found" (split.length === 0)
        // This allows the engine to retry and recover on subsequent requests.
        // PHASE_5B190 — also do not cache excludeVia results: their hub set is a
        // filtered subset of the full candidate pool and must not poison the normal
        // (no-excludeVia) cache entry.
        const shouldCache = trustedRanked.length > 0 && !bypassSplitCacheForExcludeVia;
        if (shouldCache) {
            cacheService_1.cacheService.cacheSplit(source, destination, date, cacheableResult, true, classType, quota);
            logger_1.winstonLogger.info(`[SPLIT_ENGINE] ✅ Cached result: ${trustedRanked.length} trust-gated splits for ${source}→${destination}`);
            // Persist to database cache
            try {
                const { supabase } = await Promise.resolve().then(() => __importStar(require('../config/supabase')));
                const dbKey = `split_${source.toUpperCase().trim()}_${destination.toUpperCase().trim()}_${date}_${classType}_${quota}`;
                const expiryDate = new Date();
                expiryDate.setMinutes(expiryDate.getMinutes() + 15); // 15-minute cache TTL
                // Check if cache exists first to do upsert cleanly
                const { data: existingCache } = await supabase
                    .from('api_search_cache')
                    .select('id')
                    .eq('route_key', dbKey)
                    .maybeSingle();
                const cachePayload = {
                    route_key: dbKey,
                    // PHASE_5B109 — persist the trust-gated payload, not the raw response.
                    response: JSON.stringify(cacheableResult),
                    expires_at: expiryDate.toISOString(),
                    created_at: new Date().toISOString(),
                    api_used: 'split_engine'
                };
                if (existingCache) {
                    await supabase
                        .from('api_search_cache')
                        .update(cachePayload)
                        .eq('id', existingCache.id);
                }
                else {
                    await supabase
                        .from('api_search_cache')
                        .insert(cachePayload);
                }
                logger_1.winstonLogger.info(`[SPLIT_ENGINE] 🗄️ Saved splits to database cache for ${source}→${destination} under ${dbKey}`);
            }
            catch (dbErr) {
                logger_1.winstonLogger.warn(`[SPLIT_DB_CACHE] Write failed: ${dbErr.message}`);
            }
        }
        else {
            logger_1.winstonLogger.info(`[SPLIT_ENGINE] ⏭️ NOT caching empty result to allow retry on next query`);
        }
        // Adjacent-day fallback logic if we have 0 splits and execution took too long (or we are close to timeout)
        const elapsed = Date.now() - this.engineStartMs;
        if (safeSplits.length === 0 && elapsed > 12000) {
            logger_1.winstonLogger.info(`[SPLIT_ENGINE] Timeout approaching (elapsed: ${elapsed}ms) with 0 splits. Attempting adjacent-date cache fallback.`);
            const prevDate = this.incrementDate(date, -1);
            const nextDate = this.incrementDate(date, 1);
            for (const adjDate of [prevDate, nextDate]) {
                // 1. Check in-memory cache
                // PHASE_5B109 — adjacent-date fallback replays a cached payload under a
                // different date, so it must respect the same generation check.
                let adjCached = cacheService_1.cacheService.getCachedSplit(source, destination, adjDate, true, classType, quota);
                if (adjCached && adjCached.split?.length > 0 && isTrustGatedPayload(adjCached)) {
                    logger_1.winstonLogger.info(`[SPLIT_ENGINE] 🔄 Fallback hit in-memory cache for adjacent date: ${adjDate}`);
                    const shifted = this.shiftSplitDates(adjCached, date, adjDate);
                    return {
                        ...shifted,
                        fallback: true,
                        message: `Result from adjacent date ${adjDate} (fallback)`
                    };
                }
                // 2. Check DB cache
                try {
                    const { supabase } = await Promise.resolve().then(() => __importStar(require('../config/supabase')));
                    const dbKey = `split_${source.toUpperCase().trim()}_${destination.toUpperCase().trim()}_${adjDate}_${classType}_${quota}`;
                    const { data, error } = await supabase
                        .from('api_search_cache')
                        .select('response, expires_at')
                        .eq('route_key', dbKey)
                        .single();
                    if (!error && data) {
                        if (new Date(data.expires_at) >= new Date()) {
                            let parsed = JSON.parse(data.response);
                            if (parsed.split && parsed.split.length > 0 && isTrustGatedPayload(parsed)) {
                                logger_1.winstonLogger.info(`[SPLIT_ENGINE] 🔄 Fallback hit DB cache for adjacent date: ${adjDate}`);
                                parsed = this.shiftSplitDates(parsed, date, adjDate);
                                parsed.fallback = true;
                                parsed.message = `Result from adjacent date ${adjDate} (fallback)`;
                                // Store in memory
                                cacheService_1.cacheService.cacheSplit(source, destination, date, parsed, true, classType, quota);
                                return parsed;
                            }
                        }
                    }
                }
                catch (dbErr) {
                    logger_1.winstonLogger.warn(`[SPLIT_DB_CACHE] Adjacent read failed for ${adjDate}: ${dbErr.message}`);
                }
            }
        }
        if (process.env.NODE_ENV !== 'production')
            console.log(`[SPLIT_ENGINE] Stats: ${this.legSearchStats.hits} cache hits, ${this.legSearchStats.misses} cache misses`);
        return result;
    }
    /**
     * Resolve a city name or station code to ALL known station codes for that metro.
     * Leverages DB-first StationService.
     */
    async resolveCityStations(cityOrCode) {
        if (!cityOrCode || typeof cityOrCode !== 'string')
            return [];
        try {
            return await stationService_1.stationService.getStationsForCity(cityOrCode);
        }
        catch (err) {
            logger_1.winstonLogger.error(`[STATION_RESOLVE] DB lookup failed for "${cityOrCode}": ${err.message}`);
            return [stationService_1.stationService.normalizeInput(cityOrCode)];
        }
    }
    // —————————————————————————————————————————————————————————————————————————
    // DIRECT TRAINS
    // —————————————————————————————————————————————————————————————————————————
    async getDirectTrainsForCity(sCodes, dCodes, date) {
        if (this.apiCallCount >= this.MAX_TOTAL_CALLS)
            return [];
        const pairs = [];
        for (const s of sCodes) {
            for (const d of dCodes) {
                pairs.push({ s, d });
            }
        }
        const allRawTrains = [];
        const pairResults = await Promise.all(pairs.map(async (pair) => {
            try {
                const trains = await this.searchLeg(pair.s, pair.d, date);
                return { pair, trains: Array.isArray(trains) ? trains : [] };
            }
            catch (err) {
                return { pair, trains: [] };
            }
        }));
        for (const res of pairResults) {
            for (const t of res.trains) {
                allRawTrains.push({ t, s: res.pair.s, d: res.pair.d });
            }
        }
        const seenTrainNumbers = new Set();
        const uniqueRawTrains = [];
        for (const item of allRawTrains) {
            const num = String(item.t.train_number || item.t.trainNo || item.t.train_no || item.t.number || '').trim();
            if (num && !seenTrainNumbers.has(num)) {
                seenTrainNumbers.add(num);
                uniqueRawTrains.push(item);
            }
        }
        const topTrains = uniqueRawTrains.slice(0, 4);
        const enriched = await Promise.all(topTrains.map(async (item) => {
            const { t, s, d } = item;
            if (this.apiCallCount >= this.MAX_TOTAL_CALLS)
                return this.mapToLeg(t, s, d);
            this.apiCallCount++;
            const trainNo = t.train_number || t.trainNo || t.number;
            const availRes = await availabilityProvider_1.availabilityProvider.getAvailability({
                trainNo,
                from: s,
                to: d,
                date,
                classType: '3A',
                quota: 'GN'
            }).catch(() => null);
            let normalizedAvail = null;
            if (availRes && availRes.success && availRes.data) {
                const rawAvail = availRes.data;
                let availabilityText = '';
                if (Array.isArray(rawAvail?.data?.availability) && rawAvail.data.availability.length > 0) {
                    availabilityText = rawAvail.data.availability[0]?.availabilityText || '';
                }
                else if (Array.isArray(rawAvail?.availability) && rawAvail.availability.length > 0) {
                    availabilityText = rawAvail.availability[0]?.availabilityText || '';
                }
                else if (rawAvail?.data?.availabilityText) {
                    availabilityText = rawAvail.data.availabilityText;
                }
                else if (rawAvail?.availabilityText) {
                    availabilityText = rawAvail.availabilityText;
                }
                else if (rawAvail?.status) {
                    availabilityText = rawAvail.status;
                }
                else if (rawAvail?.current_status) {
                    availabilityText = rawAvail.current_status;
                }
                if (availabilityText) {
                    normalizedAvail = {
                        status: availabilityText,
                        current_status: availabilityText
                    };
                }
            }
            return this.mapToLeg(t, s, d, normalizedAvail);
        }));
        return enriched.filter(Boolean);
    }
    /**
     * Determines whether a split journey is genuinely recommended over direct trains.
     *
     * Returns TRUE (split recommended) when:
     *   - No direct trains found at all, OR
     *   - Fewer than 3 direct trains available, OR
     *   - All direct trains are in waitlist / fully confirmed seats are scarce
     *
     * Returns FALSE (direct is fine) when 3+ confirmed-seat direct trains exist.
     *
     * NOTE: This flag only drives the `split_recommended` field in the API response —
     * the split engine ALWAYS runs regardless of this value. The flag is used by the
     * frontend to emphasise or de-emphasise the split results in the UI.
     */
    checkSplitRecommendation(direct) {
        // No direct trains → always recommend split
        if (!direct || direct.length === 0)
            return true;
        // Fewer than 3 direct options → lean towards recommending split
        if (direct.length < 3)
            return true;
        // Count how many direct trains have confirmed (non-waitlist) availability
        const WL_PATTERNS = /^WL|^REGRET|^AVAILABLE ON WAITLIST|NO SEATS|FULLY SOLD/i;
        let confirmedCount = 0;
        for (const train of direct) {
            const availText = train.availability?.status ||
                train.availability?.current_status ||
                train.availabilityStatus || '';
            const isWaitlisted = WL_PATTERNS.test(String(availText).trim());
            if (!isWaitlisted)
                confirmedCount++;
        }
        // If 3 or more direct trains have confirmed seats, split is not urgent
        if (confirmedCount >= 3) {
            logger_1.winstonLogger.info(`[SPLIT_RECOMMEND] ${confirmedCount} direct trains with confirmed seats — split not strictly needed`);
            return false;
        }
        logger_1.winstonLogger.info(`[SPLIT_RECOMMEND] Only ${confirmedCount}/${direct.length} direct trains confirmed — recommending split`);
        return true;
    }
    // —————————————————————————————————————————————————————————————————————————
    // GPT-OPTIMISED ROUTE
    // —————————————————————————————————————————————————————————————————————————
    // GPT route optimiser — disabled in favour of real-data-only coverage.
    // Kept for future re-enable; currently not called from findCombinedRoutes.
    async handleGptOptimizedRoute(sName, dName, sCodes, dCodes, date) {
        try {
            const { llmService } = await Promise.resolve().then(() => __importStar(require('./llmService')));
            const gptRoute = await llmService.getOptimalSplitRoute(sName, dName);
            if (!gptRoute?.route)
                return [];
            const hub = gptRoute.route.split('→')[1]?.trim();
            if (!hub)
                return [];
            logger_1.winstonLogger.info(`[GPT_SPLIT] Suggested hub: ${hub}`);
            return await this.findSplitJourneys(sName, dName, sCodes, dCodes, date, undefined, [hub]);
        }
        catch (err) {
            logger_1.winstonLogger.warn(`[GPT_SPLIT] Failed: ${err.message}`);
            return [];
        }
    }
    // —————————————————————————————————————————————————————————————————————————
    // DYNAMIC HUB DETECTION — 2-hop graph
    // —————————————————————————————————————————————————————————————————————————
    /**
     * 2-hop hub discovery:
     *   L1 = all stations reachable from source trains
     *   L2 = all stations reachable from trains that pass through any L1 station
     *   Hubs = L2 ∩ (stations reachable from destination trains)
     *
     * This finds valid intermediate junctions even when no single train
     * serves both source and destination.
     */
    async getDynamicHubs(sourceCode, destCode) {
        try {
            const { supabase } = await Promise.resolve().then(() => __importStar(require('../config/supabase')));
            // —— Step 1: trains passing through source ——————————————————————————————
            const { data: sTrains } = await supabase
                .from('train_schedule').select('Train_No').eq('Station_Code', sourceCode);
            // trains passing through destination
            const { data: dTrains } = await supabase
                .from('train_schedule').select('Train_No').eq('Station_Code', destCode);
            if (!sTrains?.length || !dTrains?.length)
                return [];
            const sNos = [...new Set(sTrains.map((t) => String(t.Train_No)))];
            const dNos = [...new Set(dTrains.map((t) => String(t.Train_No)))];
            // —— Step 2: L1 = all stations on source trains ————————————————————————
            const { data: l1Raw } = await supabase
                .from('train_schedule').select('Station_Code').in('Train_No', sNos);
            if (!l1Raw?.length)
                return [];
            const l1Stations = [...new Set(l1Raw.map((t) => String(t.Station_Code)))]
                .filter(s => s !== sourceCode && s !== destCode);
            // —— Step 3: trains passing through any L1 station (2nd hop) ——————————
            //   Batch in chunks of 50 to avoid Supabase query limits
            const l2TrainNos = new Set();
            const CHUNK = 50;
            for (let i = 0; i < Math.min(l1Stations.length, 200); i += CHUNK) {
                const chunk = l1Stations.slice(i, i + CHUNK);
                const { data: hop2 } = await supabase
                    .from('train_schedule').select('Train_No').in('Station_Code', chunk);
                (hop2 || []).forEach((t) => l2TrainNos.add(String(t.Train_No)));
            }
            // —— Step 4: L2 = stations reachable via 2-hop trains —————————————————
            const hop2Arr = [...l2TrainNos].slice(0, 200);
            const { data: l2Raw } = await supabase
                .from('train_schedule').select('Station_Code').in('Train_No', hop2Arr);
            const l2Stations = new Set((l2Raw || []).map((t) => String(t.Station_Code)));
            // —— Step 5: destination-side stations ————————————————————————————————
            const { data: dStations } = await supabase
                .from('train_schedule').select('Station_Code').in('Train_No', dNos);
            const dSet = new Set((dStations || []).map((t) => String(t.Station_Code)));
            // —— Step 6: intersection = valid hubs ————————————————————————————————
            const hubs = [...l2Stations]
                .filter(s => dSet.has(s) && s !== sourceCode && s !== destCode)
                // Prioritise known major junctions first
                .sort((a, b) => {
                const aIsMajor = MAJOR_HUBS.includes(a) ? 0 : 1;
                const bIsMajor = MAJOR_HUBS.includes(b) ? 0 : 1;
                return aIsMajor - bIsMajor;
            });
            logger_1.winstonLogger.info(`[DYNAMIC_HUB] 2-hop graph: L1=${l1Stations.length} stations, ` +
                `L2 trains=${hop2Arr.length}, hubs found=${hubs.length}`);
            return hubs;
        }
        catch (e) {
            logger_1.winstonLogger.warn(`[DYNAMIC_HUB] Failed: ${e.message}`);
            return [];
        }
    }
    // —————————————————————————————————————————————————————————————————————————
    // CORE SPLIT-JOURNEY FINDER
    // —————————————————————————————————————————————————————————————————————————
    async findSplitJourneys(sName, dName, sCodes, dCodes, date, directTrainsRef, providedHubs) {
        const startTime = Date.now();
        this.engineStartMs = startTime; // API budget clock starts here
        this.apiCallCount = 0;
        this.legSearchStats = { hits: 0, misses: 0 };
        const sCode = sCodes[0]; // primary code for filtering
        const dCode = dCodes[0];
        logger_1.winstonLogger.debug(`[SPLIT_TRACE] ▶ findSplitJourneys: src=${sCode} dst=${dCode} date=${date}`);
        logger_1.winstonLogger.info(`[SPLIT_TRACE] Source codes: ${sCodes.join(',')}, Dest codes: ${dCodes.join(',')}`);
        // —— Step 1: Corridor-first hub pool ———————————————————————————————————
        const sourceCity = getCity(sCode).toLowerCase();
        const destCity = getCity(dCode).toLowerCase();
        const pairKey1 = `${sourceCity.toLowerCase()}-${destCity.toLowerCase()}`;
        const pairKey2 = `${destCity.toLowerCase()}-${sourceCity.toLowerCase()}`;
        const exclude = new Set([...sCodes, ...dCodes]);
        let hubs = [];
        // Deterministic corridors contain curated priority hubs for well-known routes.
        // CHANGED (Fix #2): They are now PRIORITY pools, not EXCLUSIVE pools.
        // Corridor hubs come first, but PAN_INDIA_CORRIDOR_HUBS and MAJOR_HUBS are always
        // appended as fallbacks so the engine can recover if the DB is missing schedules
        // for specific deterministic hubs (e.g. HWH→CSMT not in DB → engine falls back to MGS).
        const isDeterministic = !!(DETERMINISTIC_CORRIDORS[pairKey1] || DETERMINISTIC_CORRIDORS[pairKey2]);
        const corridorFallback = PAN_INDIA_CORRIDOR_HUBS[sourceCity] || MAJOR_HUBS;
        if (isDeterministic) {
            const deterministicHubs = DETERMINISTIC_CORRIDORS[pairKey1] || DETERMINISTIC_CORRIDORS[pairKey2];
            // Priority: deterministic hubs first, then corridor fallback, then all major hubs
            hubs = [...new Set([
                    ...deterministicHubs,
                    ...corridorFallback,
                    ...MAJOR_HUBS
                ])].filter(h => !exclude.has(h));
            logger_1.winstonLogger.info(`[SPLIT_ENGINE] Deterministic-priority corridor ${pairKey1}: priority=[${deterministicHubs.join(',')}] total=${hubs.length}`);
        }
        else {
            hubs = [...new Set([...corridorFallback, ...MAJOR_HUBS])].filter(h => !exclude.has(h));
        }
        // —— Step 2: Blacklist micro-hubs ——————————————————————————————————————
        hubs = hubs.filter(h => !MICRO_HUB_BLACKLIST.has(h));
        logger_1.winstonLogger.info(`[HUB_SELECT] After blacklist: ${hubs.length} hubs (city=${sourceCity})`);
        let cleanDynamicCount = 0;
        let serviceHubsCount = 0;
        // —— Step 3: Add dynamic + service + learned route memory hubs (DB-discovered) ————————————————
        // CHANGED (Fix #2 & Route Memory): Always run dynamic discovery, including for deterministic corridors.
        // Dynamic and learned memory hubs are appended AFTER priority hubs so ordering is preserved.
        {
            const { selfLearningService } = await Promise.resolve().then(() => __importStar(require('./selfLearningService')));
            const [dynamicHubs, serviceHubs, routeMemories] = await Promise.all([
                this.getDynamicHubs(sCode, dCode).catch(() => []),
                hubService_1.hubService.selectHubs(sName, dName).catch(() => []),
                selfLearningService.getRouteMemory(sCode, dCode).catch(() => [])
            ]);
            const memoryHubs = (routeMemories || [])
                .map((m) => m.via_hub)
                .filter((h) => Boolean(h && typeof h === 'string'));
            // Dynamic & learned hubs are also filtered through blacklist and exclusion
            const cleanDynamic = dynamicHubs.filter(h => !MICRO_HUB_BLACKLIST.has(h) && !exclude.has(h));
            const cleanMemory = memoryHubs.filter(h => !MICRO_HUB_BLACKLIST.has(h) && !exclude.has(h));
            cleanDynamicCount = cleanDynamic.length;
            serviceHubsCount = serviceHubs.length;
            hubs = [...new Set([...hubs, ...cleanDynamic, ...cleanMemory, ...serviceHubs.filter(h => !MICRO_HUB_BLACKLIST.has(h))])]
                .filter(h => !exclude.has(h));
        }
        // —— Step 4: Geo filtering — direction + within-range —————————————————
        // CHANGED (Fix #2): Geo filter now runs for ALL routes (including deterministic).
        // Previously skipped for deterministic routes — this was safe only when the hub pool
        // was small. Now that the pool is larger (priority + fallback), geo filter is needed
        // to prune backtracking hubs and rank by detour score.
        //
        // PHASE_087N82 — DETERMINISTIC PRIORITY PINNING:
        // When a deterministic corridor is active, its hubs MUST remain at the front
        // in their declared order. sortViaByDetourScore() sorts purely by geometry and
        // would otherwise demote e.g. ET (position 7) behind generic hubs, exhausting
        // the live budget before the corridor's key junction is evaluated.
        // Fix: sort ONLY the non-deterministic remainder; prepend pinned corridor hubs.
        {
            const validHubs = (0, routeEngine_1.getValidViaStations)(sCode, dCode, hubs);
            const validSet = new Set(validHubs);
            const rejected = hubs.filter(h => !validSet.has(h));
            if (rejected.length > 0) {
                logger_1.winstonLogger.debug(`[GEO_FILTER] Rejected ${rejected.length} off-path hubs: ${rejected.join(', ')}`);
            }
            if (isDeterministic) {
                // Retrieve the declared corridor hubs (same lookup used in Step 1)
                const pinnedCorridorHubs = (DETERMINISTIC_CORRIDORS[pairKey1] || DETERMINISTIC_CORRIDORS[pairKey2] || [])
                    .filter(h => !exclude.has(h) && validSet.has(h));
                // Build the non-deterministic remainder and sort it by detour score
                const pinnedSet = new Set(pinnedCorridorHubs);
                const remainder = validHubs.filter(h => !pinnedSet.has(h));
                const sortedRemainder = (0, routeEngine_1.sortViaByDetourScore)(sCode, dCode, remainder, 600);
                // Pinned corridor hubs come first (declared order preserved), remainder follows
                hubs = [...pinnedCorridorHubs, ...sortedRemainder];
                logger_1.winstonLogger.info(`[SPLIT_ENGINE] N82 deterministic-pinned hub order: pinned=[${pinnedCorridorHubs.join(',')}] remainder=${sortedRemainder.length} total=${hubs.length}`);
            }
            else {
                // Non-deterministic routes: sort full valid list by detour score (unchanged behaviour)
                hubs = (0, routeEngine_1.sortViaByDetourScore)(sCode, dCode, validHubs, 40);
            }
        }
        // —— Fix B & C: Preload coordinates in batch to resolve N+1 queries ——
        const allPreloadCodes = [...new Set([...sCodes, ...hubs, ...dCodes])].map(c => c.toUpperCase().trim());
        const preloadedCoords = new Map();
        const missingCodes = [];
        for (const code of allPreloadCodes) {
            const cacheKey = `station_info_${code}`;
            const cached = cacheService_1.cacheService.get(cacheKey);
            if (cached?.latitude && cached?.longitude) {
                preloadedCoords.set(code, {
                    lat: Number(cached.latitude),
                    lon: Number(cached.longitude)
                });
            }
            else {
                missingCodes.push(code);
            }
        }
        if (missingCodes.length > 0) {
            try {
                const { supabase } = await Promise.resolve().then(() => __importStar(require('../config/supabase')));
                const { data, error } = await supabase
                    .from('station_registry')
                    .select('station_code, latitude, longitude, station_name, city')
                    .in('station_code', missingCodes);
                if (!error && data) {
                    data.forEach((row) => {
                        const code = row.station_code.toUpperCase().trim();
                        if (row.latitude && row.longitude) {
                            const coords = {
                                lat: Number(row.latitude),
                                lon: Number(row.longitude)
                            };
                            preloadedCoords.set(code, coords);
                            const cacheKey = `station_info_${code}`;
                            cacheService_1.cacheService.set(cacheKey, row, 3600);
                        }
                    });
                }
            }
            catch (err) {
                logger_1.winstonLogger.warn(`[BATCH_PRELOAD] Failed: ${err.message}`);
            }
        }
        const getCoordsFallbackLocal = (code) => {
            const clean = code.toUpperCase().trim();
            const preloaded = preloadedCoords.get(clean);
            if (preloaded)
                return preloaded;
            const re = routeEngine_1.STATIONS[clean];
            if (re)
                return { lat: re.lat, lon: re.lng };
            return null;
        };
        const isNearAnyDestStationLocal = (via, destCodes, thresholdKm) => {
            const cVia = getCoordsFallbackLocal(via);
            if (!cVia)
                return false;
            for (const dCode of destCodes) {
                const cDest = getCoordsFallbackLocal(dCode);
                if (!cDest)
                    continue;
                const dist = this._calculateHaversine(cVia.lat, cVia.lon, cDest.lat, cDest.lon);
                if (dist <= thresholdKm)
                    return true;
            }
            return false;
        };
        // —— Step 5: Enforce minimum hub distance (250km from source) ——————————
        const srcCoords = getCoordsFallbackLocal(sCode);
        if (srcCoords) {
            const distFiltered = [];
            for (const h of hubs) {
                const hCoords = getCoordsFallbackLocal(h);
                if (!hCoords) {
                    distFiltered.push(h);
                    continue;
                } // allow if no coords
                const distKm = this._calculateHaversine(srcCoords.lat, srcCoords.lon, hCoords.lat, hCoords.lon);
                const minDist = this.getMinHubDistance(sCode, dCode);
                if (distKm >= minDist) {
                    distFiltered.push(h);
                }
                else if (SplitJourneyEngine.MAJOR_JUNCTION_BYPASS.has(h)) {
                    // PHASE_087I — Designated major junction hub bypass.
                    // PUNE and SUR are verified divisional HQs with train_schedule coverage;
                    // they are valid split points on the Mumbai–Hyderabad corridor even though
                    // they fall below the 200km floor computed for this route length.
                    distFiltered.push(h);
                    logger_1.winstonLogger.info(`[HUB_ACCEPT_JUNCTION] ${h} is ${Math.round(distKm)}km from source — below generic floor (${minDist}km) but accepted as designated major junction hub`);
                }
                else {
                    logger_1.winstonLogger.info(`[HUB_REJECT] ${h} is only ${Math.round(distKm)}km from source — below ${minDist}km minimum floor`);
                }
            }
            hubs = distFiltered;
        }
        // —— Step 6: Remove micro-hubs near destination ————————————————————————
        const finalHubs = [];
        for (const hub of hubs) {
            const isMicro = isNearAnyDestStationLocal(hub, dCodes, 30);
            if (!isMicro) {
                finalHubs.push(hub);
            }
        }
        // PHASE_5B192 — do NOT truncate to MAX_HUBS before validation. Keep the full
        // ranked hub list so bounded chunked search can reach the tail. MAX_HUBS stays
        // as the per-chunk governor in the pairing loop below.
        hubs = finalHubs;
        logger_1.winstonLogger.debug(`[SPLIT_TRACE] Total candidate hubs after all filters: ${hubs.length} → [${hubs.join(', ')}]`);
        logger_1.winstonLogger.info(`[SPLIT_ENGINE] Ranked hub list (${hubs.length}): ${hubs.slice(0, 30).join(', ')}${hubs.length > 30 ? '...' : ''}`);
        const allCombinations = [];
        const seenCombos = new Set();
        // —— PHASE 1: Parallel-fetch leg1 for ALL candidate hubs —————————————————
        // PHASE_5B192 — bounded chunked hub search. Search the full ranked list in
        // MAX_HUBS-sized chunks; after each chunk, the pairing/validation loop runs
        // and the engine stops once enough valid candidates exist. Governors are
        // enforced before every chunk. Tier 2/3 widen the envelope by continuing the
        // NEXT chunk instead of re-filtering already-generated candidates.
        // PHASE_087N111 — Bound Phase 1 candidate hubs to top 10 (PHASE1_HUB_CAP) while preserving
        // N82 deterministic priority order at indices 0,1,2, preventing hub explosion from starving Phase 2.
        const hubPool = hubs.slice(0, this.PHASE1_HUB_CAP);
        logger_1.winstonLogger.info(`[SPLIT_ENGINE] Phase 1: up to ${hubPool.length} ranked hubs (cap=${this.PHASE1_HUB_CAP}, batch=2)`);
        // —— Fix E: Process hubs in batches of 2 to cap parallel concurrency ——
        const leg1Results = [];
        const BATCH_SIZE = 2;
        for (let i = 0; i < hubPool.length; i += BATCH_SIZE) {
            if (Date.now() - startTime > this.MAX_ENGINE_TIME_MS) {
                logger_1.winstonLogger.info('[SPLIT_ENGINE] Phase 1 time governor reached');
                break;
            }
            // PHASE_087N111 — Stop Phase 1 before consuming the reserved Phase 2 call budget (40 - 15 = 25 max calls)
            if (this.apiCallCount >= this.MAX_TOTAL_CALLS - this.MIN_PHASE2_RESERVE) {
                logger_1.winstonLogger.info(`[SPLIT_ENGINE] Phase 1 API call governor reached (${this.apiCallCount}/${this.MAX_TOTAL_CALLS - this.MIN_PHASE2_RESERVE} reserve=${this.MIN_PHASE2_RESERVE})`);
                break;
            }
            const batch = hubPool.slice(i, i + BATCH_SIZE);
            const batchResults = await Promise.all(batch.map(async (hub) => {
                try {
                    const hubCodes = await stationService_1.stationService.getStationsForCity(hub);
                    const hCode = hubCodes[0] || hub.toUpperCase();
                    const hName = (await stationService_1.stationService.getStationName(hCode)) || hub;
                    const trainMap = new Map();
                    // Fan out all source stations for this hub in parallel
                    const searchResults = await Promise.all(sCodes.map(async (sc, index) => {
                        try {
                            this.apiCallCount++;
                            // PHASE_087N98: primary terminal (index 0) always LIVE;
                            // second terminal (index 1) LIVE unless micro/suburban;
                            // index >= 2 always DB-only.
                            const isMicro = SplitJourneyEngine.N98_MICRO_TERMINALS.has(sc);
                            const forceDb = isMicro ? true : index > 1;
                            return { sc, raw: await this.searchLeg(sc, hCode, date, forceDb), forceDb };
                        }
                        catch {
                            return { sc, raw: [], forceDb: true };
                        }
                    }));
                    for (const { sc, raw, forceDb } of searchResults) {
                        if (Array.isArray(raw) && raw.length > 0) {
                            raw.forEach((t) => {
                                const tNo = t.train_number || t.trainNo || t.number || Math.random();
                                const trainKey = String(tNo);
                                // Dedupe: prefer LIVE result over DB result
                                if (!trainMap.has(trainKey) || !forceDb) {
                                    trainMap.set(trainKey, {
                                        ...t,
                                        _fromCode: t.fromStationCode || t.from_station_code || t.from_stn_code || sc,
                                        _sourceLive: !forceDb
                                    });
                                }
                            });
                        }
                    }
                    return { hub, hCode, hName, trains: [...trainMap.values()] };
                }
                catch {
                    return { hub, hCode: hub.toUpperCase(), hName: hub, trains: [] };
                }
            }));
            leg1Results.push(...batchResults);
        }
        // Keep only hubs that actually have leg1 trains
        const viableHubs = leg1Results.filter(h => h.trains.length > 0);
        logger_1.winstonLogger.info(`[SPLIT_ENGINE] Phase 1 done: ${viableHubs.length}/${hubPool.length} hubs have leg1 trains`);
        // —— PHASE 2: Parallel-fetch leg2 for all viable hubs across ALL dest station codes ——
        const leg2Cache = new Map();
        const nextDate = this.incrementDate(date, 1);
        // DATE+2 FIX: Long-haul trains (e.g. Mumbai→Kolkata 36h+) can arrive at the hub
        // on day+2. Without fetching date+2 leg2 trains, these splits are never generated.
        const nextDate2 = this.incrementDate(date, 2);
        // Build all leg2 fetch tasks
        const leg2KeysToFetch = [];
        for (const { hCode } of viableHubs) {
            for (const dC of dCodes) { // Fetch for all resolved destination codes
                const sameDayKey = `${hCode}|${dC}|${date}`;
                const nextDayKey = `${hCode}|${dC}|${nextDate}`;
                const nextDate2Key = `${hCode}|${dC}|${nextDate2}`;
                if (!leg2Cache.has(sameDayKey)) {
                    leg2Cache.set(sameDayKey, []); // placeholder to prevent duplicates
                    leg2KeysToFetch.push({ hCode, dC, dt: date, key: sameDayKey });
                }
                if (!leg2Cache.has(nextDayKey)) {
                    leg2Cache.set(nextDayKey, []); // placeholder
                    leg2KeysToFetch.push({ hCode, dC, dt: nextDate, key: nextDayKey });
                }
                if (!leg2Cache.has(nextDate2Key)) {
                    leg2Cache.set(nextDate2Key, []); // placeholder for long-haul routes
                    leg2KeysToFetch.push({ hCode, dC, dt: nextDate2, key: nextDate2Key });
                }
            }
        }
        // —— Fix E: Process Phase 2 leg searches in batches of 3 to cap parallel concurrency ——
        const LEG2_BATCH_SIZE = 3;
        for (let i = 0; i < leg2KeysToFetch.length; i += LEG2_BATCH_SIZE) {
            if (Date.now() - startTime > this.MAX_ENGINE_TIME_MS || this.apiCallCount >= this.MAX_TOTAL_CALLS) {
                logger_1.winstonLogger.info(`[SPLIT_ENGINE] Phase 2 governor reached (time=${Date.now() - startTime}ms calls=${this.apiCallCount})`);
                break;
            }
            const batch = leg2KeysToFetch.slice(i, i + LEG2_BATCH_SIZE);
            await Promise.all(batch.map(async ({ hCode, dC, dt, key }) => {
                try {
                    this.apiCallCount++;
                    const r = await this.searchLeg(hCode, dC, dt);
                    // PHASE_5B099: Inject _fromCode into every leg2 result, mirroring the leg1
                    // injection at Phase 1. The provider may return fromStationCode equal to
                    // the actual physical boarding station (e.g. SBIB for 19031) rather than
                    // the hub alias (ADI). Preserving it here ensures mapToRichLeg uses the
                    // real physical station code instead of falling back to hCode.
                    const tagged = Array.isArray(r)
                        ? r.map((t) => ({
                            ...t,
                            _fromCode: t.fromStationCode || t.from_station_code || t.from_stn_code || t.fromCode || t.from || hCode,
                        }))
                        : [];
                    leg2Cache.set(key, tagged);
                }
                catch {
                    leg2Cache.set(key, []);
                }
            }));
        }
        logger_1.winstonLogger.info(`[SPLIT_ENGINE] Phase 2 done: ${leg2KeysToFetch.length} batched leg2 fetches for ${viableHubs.length} hubs`);
        // —— PHASE 2.5: Authoritative running-days pre-fetch (PHASE_084H) ————————
        // Collect unique train numbers from all leg1 and leg2 candidates.
        // Batch-fetch getTrainInfo with bounded concurrency before the pairing loop
        // so resolveSegmentForAvailability can reuse the authoritative data instead
        // of calling getTrainInfo N times during pairing (which exhausts the budget).
        const rdCandidateNos = new Set();
        for (const { trains } of viableHubs) {
            for (const t of trains) {
                const num = String(t.train_number || t.trainNo ||
                    t.train_no || t.number || '').trim();
                if (num && num.length >= 4)
                    rdCandidateNos.add(num);
            }
        }
        for (const trains of leg2Cache.values()) {
            for (const t of trains) {
                const num = String(t.train_number || t.trainNo ||
                    t.train_no || t.number || '').trim();
                if (num && num.length >= 4)
                    rdCandidateNos.add(num);
            }
        }
        // Leave at least 15s for the pairing loop; cap prefetch budget at 10s
        const rdElapsed = Date.now() - startTime;
        const rdBudgetMs = Math.max(0, Math.min(10000, this.MAX_ENGINE_TIME_MS - rdElapsed - 15000));
        const { cache: runningDaysCache, apiCalls: rdApiCalls, cacheHits: rdCacheHits } = rdBudgetMs > 100 && rdCandidateNos.size > 0
            ? await this.prefetchRunningDays(rdCandidateNos, rdBudgetMs)
            : { cache: new Map(), apiCalls: 0, cacheHits: 0 };
        // Observability: one WARN-level summary per split search (not per candidate)
        logger_1.winstonLogger.warn(`[RD_PREFETCH] src=${sCode}→${dCode}/${date} candidates=${rdCandidateNos.size}` +
            ` fetched=${runningDaysCache.size / 2}` + // /2 because each entry is keyed by padded AND raw
            ` apiCalls=${rdApiCalls} cacheHits=${rdCacheHits} budgetMs=${rdBudgetMs}`);
        // —— PHASE 3: In-memory pairing — no more API calls ———————————————————
        const directTrainsForFilter = directTrainsRef || await this.getDirectTrainsForCity(sCodes, dCodes, date);
        // —— Parse direct train durations correctly —————————————————————————————
        // The API may return duration as "HH:MM" string (e.g. "26:15") or as a
        // numeric minutes value. Parse both and pick the best non-zero value.
        const directTime = directTrainsForFilter.length > 0 ?
            Math.min(...directTrainsForFilter.map(t => {
                // 1) Prefer explicit numeric field (duration_mins takes priority)
                const numericMins = typeof t.durationMins === 'number' && t.durationMins > 0
                    ? t.durationMins
                    : typeof t.duration_mins === 'number' && t.duration_mins > 0
                        ? t.duration_mins
                        : typeof t.duration === 'number' && t.duration > 0
                            ? t.duration
                            : 0;
                if (numericMins > 0)
                    return numericMins;
                // 2) Parse string duration — handles "26:15", "26:15 hrs", "26h 15m" etc.
                const rawDurStr = String(t.total_journey_time ||
                    t.duration_str ||
                    t.durationStr ||
                    t.journeyDuration ||
                    t.duration ||
                    '');
                // Strip any non-numeric suffix (" hrs", " h", " min") then parse HH:MM
                const cleanDur = rawDurStr.replace(/[^0-9:]/g, '').trim();
                if (cleanDur.includes(':')) {
                    const parts = cleanDur.split(':').map(Number);
                    const parsed = (parts[0] || 0) * 60 + (parts[1] || 0);
                    if (parsed > 0)
                        return parsed;
                }
                // 3) Derive from departure/arrival timestamps if available
                const dep = t.departure || t.departure_time || '';
                const arr = t.arrival || t.arrival_time || '';
                const dayNum = parseInt(t.day_number || t.dayNumber || '1') || 1;
                if (dep && arr) {
                    const depMins = this.parseToMins(dep);
                    const arrMins = ((dayNum - 1) * 1440) + this.parseToMins(arr);
                    const diff = arrMins - depMins;
                    if (diff > 0)
                        return diff;
                }
                return 0;
            }).filter(t => t > 0)) :
            Infinity;
        logger_1.winstonLogger.info(`[SPLIT_ENGINE] directTime=${directTime === Infinity ? 'Infinity (no direct trains)' : directTime + 'min'}`);
        const rejectionStats = {
            source_stop_missing: 0,
            dest_stop_missing: 0,
            wait_time_invalid: 0,
            reverse_or_disconnected: 0,
            same_train: 0,
            availability_issue: 0,
            invalid_time: 0,
            // PHASE_084K — per-stage resolution rejection counters
            running_days_unknown: 0,
            train_not_running: 0,
            stop_not_found: 0,
            db_unverified_stop_data: 0,
            trust_gate_reject: 0,
        };
        // Pre-calculate geography constraints OUTSIDE the loops
        const isReverseLoopGlobal = isNearAnyDestStationLocal(dCode, sCodes, 50);
        if (isReverseLoopGlobal) {
            logger_1.winstonLogger.info(`[SPLIT_ENGINE] Search rejected: Destination is within 50km of source`);
            return [];
        }
        for (const { hCode, hName, trains: leg1Raw } of viableHubs) {
            if (Date.now() - startTime > this.MAX_ENGINE_TIME_MS) {
                logger_1.winstonLogger.info('[SPLIT_ENGINE] Time limit reached during pairing');
                break;
            }
            // RULE: If hub is within 20km of any dest station → it IS the destination
            // Do NOT create a second leg — this would generate garbage like "NZM → NDLS".
            const hubIsDestination = isNearAnyDestStationLocal(hCode, dCodes, 20);
            if (hubIsDestination)
                continue; // already handled in Phase 2 skip above
            let combosThisHub = 0;
            // Collect all leg2 results across all destination station codes
            const validLeg2Pools = [];
            let totalLeg2 = 0;
            for (const dC of dCodes) {
                const isLeg2SameCity = isNearAnyDestStationLocal(dC, [hCode], 20);
                if (isLeg2SameCity)
                    continue;
                const sameDayLegs = leg2Cache.get(`${hCode}|${dC}|${date}`) || [];
                const nextDayLegs = leg2Cache.get(`${hCode}|${dC}|${this.incrementDate(date, 1)}`) || [];
                const nextDay2Legs = leg2Cache.get(`${hCode}|${dC}|${this.incrementDate(date, 2)}`) || [];
                totalLeg2 += sameDayLegs.length + nextDayLegs.length + nextDay2Legs.length;
                validLeg2Pools.push({ leg2Raw: sameDayLegs, leg2Date: date, dC });
                validLeg2Pools.push({ leg2Raw: nextDayLegs, leg2Date: this.incrementDate(date, 1), dC });
                validLeg2Pools.push({ leg2Raw: nextDay2Legs, leg2Date: this.incrementDate(date, 2), dC });
            }
            for (const t1 of leg1Raw) {
                const actualSCode = t1._fromCode || sCode;
                const l1 = this.mapToRichLeg(t1, actualSCode, hCode, sName, hName);
                if (!l1.arrival || l1.arrival === '--:--')
                    continue;
                // Reject trains that don't actually stop at source station.
                // Validate source station exists before boarding.
                if (l1.fromCode && !sCodes.includes(l1.fromCode) && getCity(l1.fromCode) !== getCity(sCode)) {
                    rejectionStats.source_stop_missing++;
                    continue;
                }
                const seenSameDayLeg2 = new Set();
                // Try ALL dest station pools
                for (const { leg2Raw, leg2Date, dC } of validLeg2Pools) {
                    if (combosThisHub >= this.MAX_COMBOS_PER_HUB)
                        break;
                    const effectiveDName = dC === dCode ? dName : dC;
                    for (const t2 of leg2Raw) {
                        if (combosThisHub >= this.MAX_COMBOS_PER_HUB)
                            break;
                        const l2 = this.mapToRichLeg(t2, hCode, dC, hName, effectiveDName);
                        // Deduplicate next-day candidates representing the same physical Leg2 train
                        const leg2Key = `${l2.trainNo}|${hCode}|${l2.fromCode}|${l2.toCode}|${l2.departure}|${l2.arrival}`;
                        if (leg2Date === date) {
                            seenSameDayLeg2.add(leg2Key);
                        }
                        else if (seenSameDayLeg2.has(leg2Key)) {
                            continue;
                        }
                        // —— ISSUE 3 FIX: WAIT TIME N/A ——
                        // Skip splits with missing arrival or departure times
                        if (!l1.arrival || l1.arrival === '--:--' || !l2.departure || l2.departure === '--:--')
                            continue;
                        // Distance/Duration sanity check
                        if (l1.durationMins < 10 || l2.durationMins < 10) {
                            rejectionStats.invalid_time++;
                            continue;
                        }
                        // Remove same train splits
                        if (l1.trainNo === l2.trainNo) {
                            rejectionStats.same_train++;
                            continue;
                        }
                        // Validate destination order in train route
                        if (l2.toCode && !dCodes.includes(l2.toCode) && getCity(l2.toCode) !== getCity(dCode)) {
                            rejectionStats.dest_stop_missing++;
                            continue;
                        }
                        // Station match (lenient)
                        if (l1.toCode && l2.fromCode &&
                            !this.stationsMatch(l1.toCode, hCode) &&
                            !this.stationsMatch(l2.fromCode, hCode)) {
                            rejectionStats.reverse_or_disconnected++;
                            continue;
                        }
                        // Reject disconnected splits (allow same-city connections)
                        if (getCity(l1.toCode || hCode) !== getCity(l2.fromCode || hCode)) {
                            rejectionStats.reverse_or_disconnected++;
                            continue;
                        }
                        // —— ABSOLUTE DATETIME WAIT CALCULATION ————————————————————————
                        // Convert HH:mm + date string to an epoch ms value so we never
                        // suffer from rollover/timezone arithmetic errors.
                        //
                        // PHASE_087N124 FIX B: Multi-day arrival / day-offset calculation.
                        // Simple clock-only comparison (l1ArrMins < l1DepMins ? 2 : 1) fails for
                        // multi-day trains taking >= 24h where arrival time happens to be later in
                        // the clock day than departure (e.g. 12627 SBC 19:20 -> ET 21:20 takes 26 hrs
                        // and arrives Day 2, but clock diff 1280 > 1160 wrongly treated as Day 1).
                        // Use dayNumber - depDay or durationMins if available, before falling back to clock rollover.
                        const l1DepMins = this.parseToMins(l1.departure || '00:00');
                        const l1ArrMins = this.parseToMins(l1.arrival || '00:00');
                        const l1DurMins = l1.durationMins || l1.duration_mins || l1.duration || 0;
                        let l1ArrDayOffset = 1;
                        if (l1.dayNumber && l1.depDay && l1.dayNumber >= l1.depDay && (l1.dayNumber > 1 || l1DurMins > 1440)) {
                            l1ArrDayOffset = 1 + (l1.dayNumber - l1.depDay);
                        }
                        else if (l1DurMins > 0) {
                            l1ArrDayOffset = 1 + Math.floor((l1DepMins + l1DurMins) / 1440);
                        }
                        else if (l1.dayNumber && l1.dayNumber > 1) {
                            l1ArrDayOffset = l1.dayNumber;
                        }
                        else {
                            l1ArrDayOffset = (l1ArrMins < l1DepMins && l1DepMins > 0) ? 2 : 1;
                        }
                        const leg1ArrivalMs = this.toEpochMs(date, l1.arrival, l1ArrDayOffset);
                        const leg2DepartureMs = this.toEpochMs(leg2Date, l2.departure, 1);
                        // If leg2 departs BEFORE leg1 arrives, it must be a next-day train
                        // — push departure forward in 24h increments (handles multi-day trains).
                        let adjustedDep2Ms = leg2DepartureMs;
                        let depDayShift = 0;
                        while (adjustedDep2Ms <= leg1ArrivalMs && depDayShift < 4) {
                            adjustedDep2Ms += 24 * 60 * 60 * 1000;
                            depDayShift++;
                        }
                        const waitMins = Math.round((adjustedDep2Ms - leg1ArrivalMs) / 60000);
                        // —— VALIDATION: Wait time bounds & Inter-Station transfer validation ——————————————
                        let transferMetaObj = null;
                        if (providerConfigService_1.providerConfigService.isInterStationTransfersEnabled()) {
                            const metaRes = this.calculateTransferMeta(l1, l2, waitMins);
                            if (!metaRes.isValid) {
                                rejectionStats.wait_time_invalid++;
                                continue;
                            }
                            transferMetaObj = metaRes.transferMeta;
                        }
                        else {
                            if (waitMins < 25 || waitMins > 840) {
                                rejectionStats.wait_time_invalid++;
                                continue;
                            }
                        }
                        if (process.env.NODE_ENV !== 'production')
                            console.log(`[REAL_AUDIT] COMBO_CREATED | Hub: ${hCode} | Leg1: ${l1.trainNo} | Leg2: ${l2.trainNo} | Wait: ${waitMins}m`);
                        const comboKey = `${hCode}:${l1.trainNo}|${l2.trainNo}`;
                        if (seenCombos.has(comboKey))
                            continue;
                        seenCombos.add(comboKey);
                        const leg1Duration = l1.durationMins > 0 ? l1.durationMins
                            : this.inferDurationMins(l1.departure, l1.arrival);
                        const leg2Duration = l2.durationMins > 0 ? l2.durationMins
                            : this.inferDurationMins(l2.departure, l2.arrival);
                        // —— FIX(4C402): TOTAL DURATION via arithmetic sum ————————————
                        // PREVIOUSLY: used (leg2ArrivalMs - leg1DepartureMs) which suffered
                        // from day-number defaults (arrDay||1) causing ±1440 min drift.
                        // NOW: compute directly from verified leg durations + wait time.
                        // This is always correct because waitMins and legDurations are
                        // already validated from schedule data above.
                        const totalMins = leg1Duration + waitMins + leg2Duration;
                        // —— STRICT DURATION VALIDATION ————————————————————————————————————
                        // Hard minimum: 60 minutes (no teleportation)
                        if (totalMins < 60) {
                            continue;
                        }
                        // Reject if totalTime < directTime * 0.65 (physically impossible shortcut)
                        if (directTime !== Infinity && totalMins < directTime * 0.65) {
                            continue;
                        }
                        // Reject if totalTime > 72h limit
                        if (totalMins > 4320) {
                            continue;
                        }
                        let success_percent;
                        let risk_level;
                        if (waitMins >= 120 && waitMins <= 720) { // 2h–12h = LOW (includes overnight)
                            success_percent = 90;
                            risk_level = 'LOW';
                        }
                        else if (waitMins >= 45 && waitMins < 120) { // 45m–2h = MEDIUM (tight connection)
                            success_percent = 65;
                            risk_level = 'MEDIUM';
                        }
                        else { // >12h or short = MEDIUM (very long layover)
                            success_percent = 60;
                            risk_level = 'MEDIUM';
                        }
                        const rollover = leg2Date !== date;
                        const waitHours = Math.round(waitMins / 60 * 10) / 10;
                        const riskLabel = risk_level === 'LOW' ? 'Safe' : risk_level === 'MEDIUM' ? 'Moderate' : 'Long';
                        const ai_reason = this.buildAiExplanation(l1, l2, sName, hName, dName, waitHours, riskLabel);
                        const leg1ArrDateStr = new Date(leg1ArrivalMs).toISOString().split('T')[0];
                        const leg2DepDateStr = new Date(adjustedDep2Ms).toISOString().split('T')[0];
                        const leg2ArrDateStr = new Date(adjustedDep2Ms + leg2Duration * 60000).toISOString().split('T')[0];
                        const clonedL1 = {
                            ...l1,
                            journeyDate: date,
                            travelDate: date,
                            departureDate: date,
                            arrivalDate: leg1ArrDateStr
                        };
                        const clonedL2 = {
                            ...l2,
                            journeyDate: leg2DepDateStr,
                            travelDate: leg2DepDateStr,
                            departureDate: leg2DepDateStr,
                            arrivalDate: leg2ArrDateStr
                        };
                        const combo = {
                            hub: hName,
                            leg1: clonedL1,
                            leg2: clonedL2,
                            ...(transferMetaObj ? { transferMeta: transferMetaObj } : {}),
                            bufferMinutes: waitMins,
                            totalDuration: totalMins,
                            leg1Duration,
                            leg2Duration,
                            score: 0,
                            badges: ['SPLIT'],
                            travelDate: date,
                            rollover: adjustedDep2Ms !== leg2DepartureMs,
                            ai_strategy: 'Schedule-validated split',
                            ai_insight: ai_reason,
                            delayRisk: risk_level === 'LOW' ? 'Low' : risk_level === 'MEDIUM' ? 'Medium' : 'High',
                            legs: [clonedL1, clonedL2],
                            success_percent,
                            risk_level,
                            ai_reason,
                            total_duration: rankingService_1.rankingService.formatDuration(totalMins),
                            leg1_duration: rankingService_1.rankingService.formatDuration(leg1Duration),
                            leg2_duration: rankingService_1.rankingService.formatDuration(leg2Duration),
                            wait_formatted: rankingService_1.rankingService.formatDuration(waitMins),
                            wait_time: waitMins,
                            steps: [
                                // FIX(4C402): guard against "Board undefined" if name field missing
                                `Board ${l1.trainName || l1.name || 'Train ' + l1.trainNo} (${l1.trainNo}) from ${sName} at ${l1.departure}`,
                                `Arrive ${hName} at ${l1.arrival} — wait ${waitHours}h for connection`,
                                // PHASE_5B099: use l2's physical boarding station name/code, not hub alias name
                                `Board ${l2.trainName || l2.name || 'Train ' + l2.trainNo} (${l2.trainNo}) from ${l2.fromName || l2.fromCode || hName} at ${l2.departure}`,
                                `Arrive ${dName} at ${l2.arrival}`
                            ]
                        };
                        combo.score = rankingService_1.rankingService.calculateScore(combo);
                        // PHASE_5B091 — SPLIT ENGINE PHYSICAL STOP + SERVICE-DATE TRUST GATE.
                        // resolveSegmentForAvailability owns trainOperatesOnDate() and physical
                        // SN/stop validation (UNKNOWN fails closed). Cancellation is checked
                        // generically from the raw fields propagated by mapToRichLeg; only an
                        // explicit CANCELLED signal rejects here because live IRCTC search rows
                        // are already date-filtered to operating trains.
                        const l1Cancellation = classifyCancellationState(l1);
                        const l2Cancellation = classifyCancellationState(l2);
                        if (l1Cancellation === 'CANCELLED') {
                            logger_1.winstonLogger.info(`[SPLIT_CANCELLATION_GATE_REJECTED] Leg1 ${l1.trainNo} (${l1.fromCode}->${l1.toCode}): cancellation=${l1Cancellation}`);
                            continue;
                        }
                        if (l2Cancellation === 'CANCELLED') {
                            logger_1.winstonLogger.info(`[SPLIT_CANCELLATION_GATE_REJECTED] Leg2 ${l2.trainNo} (${l2.fromCode}->${l2.toCode}): cancellation=${l2Cancellation}`);
                            continue;
                        }
                        const { resolveSegmentForAvailability } = await Promise.resolve().then(() => __importStar(require('./trainStationResolver')));
                        const rdHints = { runningDaysCache };
                        const [v1, v2] = await Promise.all([
                            resolveSegmentForAvailability(l1.trainNo, l1.fromCode, l1.toCode, date, rdHints),
                            resolveSegmentForAvailability(l2.trainNo, l2.fromCode, l2.toCode, leg2DepDateStr, rdHints)
                        ]);
                        if (!v1.success) {
                            // PHASE_084K — track per-reason rejection counts for diagnostic aggregation
                            const r1 = v1.reason;
                            if (r1 === 'RUNNING_DAYS_UNKNOWN')
                                rejectionStats.running_days_unknown++;
                            else if (r1 === 'TRAIN_NOT_RUNNING')
                                rejectionStats.train_not_running++;
                            else if (r1 === 'DB_UNVERIFIED_STOP_DATA')
                                rejectionStats.db_unverified_stop_data++;
                            else if (r1 === 'INVALID_BOARDING_STATION' || r1 === 'INVALID_DESTINATION_STATION')
                                rejectionStats.stop_not_found++;
                            logger_1.winstonLogger.info(`[SPLIT_PHYSICAL_STOP_GATE_REJECTED] Leg1 ${l1.trainNo} (${l1.fromCode}->${l1.toCode}): ${v1.reason} - ${v1.message}`);
                            continue;
                        }
                        if (!v2.success) {
                            // PHASE_084K — track per-reason rejection counts for diagnostic aggregation
                            const r2 = v2.reason;
                            if (r2 === 'RUNNING_DAYS_UNKNOWN')
                                rejectionStats.running_days_unknown++;
                            else if (r2 === 'TRAIN_NOT_RUNNING')
                                rejectionStats.train_not_running++;
                            else if (r2 === 'DB_UNVERIFIED_STOP_DATA')
                                rejectionStats.db_unverified_stop_data++;
                            else if (r2 === 'INVALID_BOARDING_STATION' || r2 === 'INVALID_DESTINATION_STATION')
                                rejectionStats.stop_not_found++;
                            logger_1.winstonLogger.info(`[SPLIT_PHYSICAL_STOP_GATE_REJECTED] Leg2 ${l2.trainNo} (${l2.fromCode}->${l2.toCode}): ${v2.reason} - ${v2.message}`);
                            continue;
                        }
                        // PHASE_5B109 — provenance now reads the TYPED `source` discriminator
                        // returned by resolveSegmentForAvailability (no `as any`). A segment
                        // resolved with source 'none' had no schedule at all behind it, so it
                        // is tagged UNVERIFIED and can never reach route memory. The common
                        // trust gate rejects it outright in enforce mode.
                        combo._provenance = deriveProvenance(v1.source, v2.source);
                        allCombinations.push(combo);
                        combosThisHub++;
                        analyticsService_1.analyticsService.logHubSuccess(hName);
                        logger_1.winstonLogger.info(`[SPLIT_ENGINE] ✅ ${hCode}: ${l1.trainNo}+${l2.trainNo} wait=${waitMins}m total=${rankingService_1.rankingService.formatDuration(totalMins)}`);
                    }
                }
            }
            if (combosThisHub > 0) {
                logger_1.winstonLogger.info(`[SPLIT_ENGINE] Hub ${hCode}: ${combosThisHub} combos`);
            }
        }
        const preFilterCount = allCombinations.length;
        logger_1.winstonLogger.debug(`[SPLIT_TRACE] Generated combinations (preFilter): ${preFilterCount}`);
        logger_1.winstonLogger.info(`[SPLIT_ENGINE] TOTAL COMBINATIONS GENERATED: ${preFilterCount}`);
        if (preFilterCount === 0) {
            logger_1.winstonLogger.warn('[SPLIT_ENGINE] ⚠️  ZERO combos generated. Check hub connectivity and train schedules.');
            // removed debug log
        }
        // —— Get direct train time for comparison ——
        // Moved to above loop
        // —— Step 4: Remove useless splits ———————————————————————————————————————
        // PHASE_5B187 — progressive search envelopes. Tier 1 (<=16h) is tried first;
        // if it does not produce enough candidates, the envelope widens to Tier 2
        // (<=24h) and then Tier 3 (<=30h). This is a search envelope, not a final API
        // result cap: downstream ranking/trust/excludeVia still decide what surfaces.
        const baseDurationLimit = directTime !== Infinity ? Math.max(MAX_TOTAL_MINS, directTime + 360) : 4320;
        const passesBaseFilter = (split) => {
            if (directTime !== Infinity && split.totalDuration < directTime * 0.65)
                return false;
            if ((split.bufferMinutes || 0) > MAX_WAIT_MINS)
                return false;
            if (split.totalDuration > baseDurationLimit)
                return false;
            const hubCode = split.leg1?.toCode || split.leg2?.fromCode || '';
            const srcCoord = preloadedCoords.get(sCode) || getCoordsFallbackLocal(sCode);
            const destCoord = preloadedCoords.get(dCode) || getCoordsFallbackLocal(dCode);
            const hubCoord = preloadedCoords.get(hubCode) || getCoordsFallbackLocal(hubCode);
            if (srcCoord && destCoord && hubCoord) {
                const directDist = this._calculateHaversine(srcCoord.lat, srcCoord.lon, destCoord.lat, destCoord.lon);
                const splitDist = this._calculateHaversine(srcCoord.lat, srcCoord.lon, hubCoord.lat, hubCoord.lon) +
                    this._calculateHaversine(hubCoord.lat, hubCoord.lon, destCoord.lat, destCoord.lon);
                if (directDist > 0 && (splitDist / directDist) > 1.30)
                    return false;
            }
            return true;
        };
        const buildFilteredByEnvelope = (maxTotalMins) => {
            return allCombinations.filter(split => passesBaseFilter(split) && split.totalDuration <= maxTotalMins);
        };
        const MIN_TIER_RESULTS = MAX_SPLIT_RESULTS;
        let filteredCombinations = buildFilteredByEnvelope(TIER_1_TOTAL_MINS);
        let activeTier = 1;
        if (filteredCombinations.length < MIN_TIER_RESULTS) {
            filteredCombinations = buildFilteredByEnvelope(TIER_2_TOTAL_MINS);
            activeTier = 2;
        }
        if (filteredCombinations.length < MIN_TIER_RESULTS) {
            filteredCombinations = buildFilteredByEnvelope(TIER_3_TOTAL_MINS);
            activeTier = 3;
        }
        if (filteredCombinations.length < MIN_TIER_RESULTS && baseDurationLimit > TIER_3_TOTAL_MINS) {
            filteredCombinations = buildFilteredByEnvelope(baseDurationLimit);
            activeTier = 4;
        }
        logger_1.winstonLogger.info(`[SPLIT_ENGINE] Progressive envelope: tier=${activeTier} candidates=${filteredCombinations.length} (allCombos=${allCombinations.length})`);
        // Relaxed fallback pool — even more lenient (base + 2h)
        const relaxedCombinations = allCombinations.filter(split => {
            if (directTime !== Infinity && split.totalDuration < directTime * 0.60)
                return false;
            if ((split.bufferMinutes || 0) > MAX_WAIT_MINS)
                return false;
            if (split.totalDuration > baseDurationLimit + 120)
                return false;
            const hubCode = split.leg1?.toCode || split.leg2?.fromCode || '';
            const srcCoord = preloadedCoords.get(sCode) || getCoordsFallbackLocal(sCode);
            const destCoord = preloadedCoords.get(dCode) || getCoordsFallbackLocal(dCode);
            const hubCoord = preloadedCoords.get(hubCode) || getCoordsFallbackLocal(hubCode);
            if (srcCoord && destCoord && hubCoord) {
                const directDist = this._calculateHaversine(srcCoord.lat, srcCoord.lon, destCoord.lat, destCoord.lon);
                const splitDist = this._calculateHaversine(srcCoord.lat, srcCoord.lon, hubCoord.lat, hubCoord.lon) +
                    this._calculateHaversine(hubCoord.lat, hubCoord.lon, destCoord.lat, destCoord.lon);
                if (directDist > 0 && (splitDist / directDist) > 1.30)
                    return false;
            }
            return true;
        });
        const postFilterCount = filteredCombinations.length;
        logger_1.winstonLogger.debug(`[SPLIT_TRACE] preFilterCount=${preFilterCount} postFilterCount=${postFilterCount} relaxedCount=${relaxedCombinations.length}`);
        // —— STEP 3: Deterministic sort ——————————————————————————————————————————
        // Sort by: 1) totalDuration ASC  2) bufferMinutes ASC  3) success_percent DESC
        // Using ONLY these stable numeric fields guarantees identical order across
        // —— Step 5: Smart Recommendation Engine (Learning Integration) ————————————
        const { learningService } = require('./learningService');
        const hubModifiers = new Map();
        for (const combo of filteredCombinations) {
            const h = combo.hub || '';
            if (h && !hubModifiers.has(h)) {
                hubModifiers.set(h, await learningService.getHubSuccessModifier(h));
            }
        }
        // —— DELAY INTELLIGENCE: Pre-fetch delay stats for unique leg1 trains ———————
        // Parallel async fetch — same pattern as hubModifiers above.
        // Returns null if < 5 historical observations (falls back to scheduled buffer).
        const leg1DelayStats = new Map();
        for (const combo of filteredCombinations) {
            const trainNo = String(combo.leg1?.trainNo || '');
            if (trainNo && !leg1DelayStats.has(trainNo)) {
                const stats = await learningService.getTrainDelayStats(trainNo).catch(() => null);
                leg1DelayStats.set(trainNo, stats);
            }
        }
        const withScore = filteredCombinations.map(c => {
            const modifier = hubModifiers.get(c.hub || '') || 0;
            // Delay-aware effective buffer: if leg1 is historically late, real buffer is smaller
            const leg1TrainNo = String(c.leg1?.trainNo || '');
            const delayStats = leg1DelayStats.get(leg1TrainNo) || null;
            const avgLeg1Delay = delayStats?.avgDelayMins ?? 0;
            const effectiveBuffer = Math.max(0, (c.bufferMinutes ?? 0) - avgLeg1Delay);
            // Inject onto combo so rankingService.calculateScore can use it
            c.effectiveBufferMins = effectiveBuffer;
            if (delayStats) {
                c.punctualityScore = delayStats.onTimePct;
                if (delayStats.onTimePct >= 80)
                    c.delayRisk = 'Low';
                else if (delayStats.onTimePct >= 50)
                    c.delayRisk = 'Medium';
                else
                    c.delayRisk = 'High';
                logger_1.winstonLogger.debug(`[DELAY_INTEL] ${leg1TrainNo}: avgDelay=${avgLeg1Delay}m scheduled=${c.bufferMinutes}m effective=${effectiveBuffer}m`);
            }
            let waitPenalty = ((c.bufferMinutes ?? 0) / 60) * 4;
            if ((c.bufferMinutes ?? 0) > 480) { // Penalty for > 8h wait
                waitPenalty += (((c.bufferMinutes ?? 0) - 480) / 60) * 10;
            }
            let trainBonus = 0;
            const getTrainPriority = (name) => {
                const lower = (name || '').toLowerCase();
                if (lower.includes('rajdhani') || lower.includes('duronto') || lower.includes('vande bharat'))
                    return 50;
                if (lower.includes('sf') || lower.includes('superfast') || lower.includes('shatabdi'))
                    return 30;
                if (lower.includes('express') || lower.includes('mail'))
                    return 10;
                if (lower.includes('passenger') || lower.includes('memu') || lower.includes('demu') || lower.includes('local'))
                    return -100;
                return 0;
            };
            trainBonus += getTrainPriority(c.leg1?.trainName || c.leg1?.name || '');
            trainBonus += getTrainPriority(c.leg2?.trainName || c.leg2?.name || '');
            let hubBonus = 0;
            let tier = 'STANDARD';
            const hubCode = c.leg1?.toCode || c.leg2?.fromCode || '';
            if (A_TIER_HUBS.includes(hubCode)) {
                hubBonus = 80;
                tier = 'A';
            }
            else if (B_TIER_HUBS.includes(hubCode)) {
                hubBonus = 40;
                tier = 'B';
            }
            else if (MICRO_HUB_BLACKLIST.has(hubCode)) {
                hubBonus = -100;
                tier = 'MICRO';
            }
            const memoryBoost = successful_route_memory.getBonus(sName, dName, hubCode);
            let detourPenaltyScore = 0;
            try {
                const srcCoord = getCoordsFallbackLocal(sCode);
                const destCoord = getCoordsFallbackLocal(dCode);
                const hubCoord = getCoordsFallbackLocal(hubCode);
                if (srcCoord && destCoord && hubCoord) {
                    const directDist = this._calculateHaversine(srcCoord.lat, srcCoord.lon, destCoord.lat, destCoord.lon);
                    const splitDist = this._calculateHaversine(srcCoord.lat, srcCoord.lon, hubCoord.lat, hubCoord.lon) +
                        this._calculateHaversine(hubCoord.lat, hubCoord.lon, destCoord.lat, destCoord.lon);
                    if (directDist > 0) {
                        const detourRatio = splitDist / directDist;
                        if (detourRatio > 1.1) {
                            detourPenaltyScore += (detourRatio - 1.1) * 2000;
                        }
                        // Overshoot / Reverse penalty
                        const hubToDest = this._calculateHaversine(hubCoord.lat, hubCoord.lon, destCoord.lat, destCoord.lon);
                        if (hubToDest > directDist) {
                            detourPenaltyScore += (hubToDest - directDist) * 15;
                        }
                        if (this._calculateHaversine(srcCoord.lat, srcCoord.lon, hubCoord.lat, hubCoord.lon) > directDist && hubToDest > directDist) {
                            detourPenaltyScore += 3000;
                        }
                    }
                }
            }
            catch (e) {
                logger_1.winstonLogger.error(`[DETOUR_PENALTY_ERROR] ${e.message}`);
            }
            return {
                ...c,
                _rankScore: (c.success_percent ?? 0) * 1.5
                    - waitPenalty
                    - ((c.totalDuration ?? 0) / 60) * 2
                    + trainBonus
                    + hubBonus
                    + memoryBoost
                    - detourPenaltyScore
                    + modifier
            };
        });
        withScore.sort((a, b) => {
            // Primary: sort by the new deterministic score DESC
            if (typeof b.score === 'number' && typeof a.score === 'number' && b.score !== a.score) {
                return b.score - a.score;
            }
            // Secondary: fallback to legacy _rankScore DESC
            const scoreDiff = (b._rankScore ?? 0) - (a._rankScore ?? 0);
            if (scoreDiff !== 0)
                return scoreDiff;
            // Tertiary: shortest total duration
            const durationDiff = (a.totalDuration ?? 99999) - (b.totalDuration ?? 99999);
            if (durationDiff !== 0)
                return durationDiff;
            // Tertiary: shortest wait time
            const waitDiff = (a.bufferMinutes ?? 99999) - (b.bufferMinutes ?? 99999);
            if (waitDiff !== 0)
                return waitDiff;
            // Final tie-breaker: deterministic string compare
            const keyA = `${a.leg1?.trainNo || ''}|${a.leg2?.trainNo || ''}`;
            const keyB = `${b.leg1?.trainNo || ''}|${b.leg2?.trainNo || ''}`;
            return keyA.localeCompare(keyB);
        });
        // —— Step 7: Smart split count cap —————————————————————————————————————
        const directTimeH = directTime !== Infinity ? directTime / 60 : 99;
        logger_1.winstonLogger.info(`[SPLIT_ENGINE] directTime=${Math.round(directTimeH)}h → maxSplits=${MAX_SPLIT_RESULTS}`);
        // —— STEP 7.5: SAFE LIVE RUNNING-DAY VALIDATION ——
        // Validates final candidates against LIVE API but uses SAFE defaults:
        // - If live API fails/returns null → ALLOW (don't reject on API unavailability)
        // - If live API returns empty array → ALLOW (API may not cover this route)
        // - ONLY reject if live API returns results AND train is definitively absent
        logger_1.winstonLogger.info(`[SPLIT_ENGINE] Enforcing safe live running-day validation...`);
        const liveValidatedCombos = [];
        const searchPromises = new Map();
        const getLiveTrains = (f, t, dt) => {
            const key = `${f}_${t}_${dt}`;
            if (!searchPromises.has(key)) {
                searchPromises.set(key, irctcService_1.irctcService.search(f, t, dt).catch(() => null));
            }
            return searchPromises.get(key);
        };
        // Process top 15 candidates in parallel to ensure we get enough valid ones
        const topCandidates = withScore.slice(0, 15);
        const validationResults = await Promise.all(topCandidates.map(async (c) => {
            try {
                const leg1From = c.leg1.fromCode || c.leg1.fromStationCode || c.leg1.from || sCode;
                const leg1To = c.leg1.toCode || c.leg1.toStationCode || c.leg1.to || c.hub;
                const leg1Date = c.leg1.travelDate || date;
                const leg2From = c.leg2.fromCode || c.leg2.fromStationCode || c.leg2.from || c.hub;
                const leg2To = c.leg2.toCode || c.leg2.toStationCode || c.leg2.to || dCode;
                // Use the pre-computed date on the leg object (set during pairing from adjustedDep2Ms)
                // Leg2 for overnight splits will have journeyDate/travelDate = date+1 or date+2 — use it.
                const leg2Date = c.leg2?.journeyDate
                    || c.leg2?.travelDate
                    || c.leg2Date
                    || date;
                const [l1Live, l2Live] = await Promise.all([
                    getLiveTrains(leg1From, leg1To, leg1Date),
                    getLiveTrains(leg2From, leg2To, leg2Date)
                ]);
                // SAFE VALIDATION: Only reject if API explicitly returns non-empty results
                // AND the train is definitively not in them (minimum 2 results to be confident)
                if (l1Live !== null && Array.isArray(l1Live) && l1Live.length >= 2) {
                    const numStr = String(c.leg1.trainNo || c.leg1.train_no || c.leg1.train_number || c.leg1.number || '');
                    // PHASE_087N118: accept train_no in addition to trainNo, train_number, number
                    if (!l1Live.some((t) => String(t.trainNo || t.train_no || t.train_number || t.number || '') === numStr)) {
                        logger_1.winstonLogger.debug(`[TRAIN_REJECTED_DATE_MISMATCH] Leg1 ${numStr} not found in live schedule for ${leg1Date}`);
                        return null;
                    }
                }
                else if (l1Live === null || !Array.isArray(l1Live) || l1Live.length === 0) {
                    // API unavailable or empty — ALLOW by default
                    logger_1.winstonLogger.debug(`[TRAIN_ALLOWED_METADATA_MISSING] Leg1 ${c.leg1.trainNo} — live API unavailable, allowing`);
                }
                if (l2Live !== null && Array.isArray(l2Live) && l2Live.length >= 2) {
                    const numStr = String(c.leg2.trainNo || c.leg2.train_no || c.leg2.train_number || c.leg2.number || '');
                    if (!l2Live.some((t) => String(t.trainNo || t.train_no || t.train_number || t.number || '') === numStr)) {
                        logger_1.winstonLogger.debug(`[TRAIN_REJECTED_DATE_MISMATCH] Leg2 ${numStr} not found in live schedule for ${leg2Date}`);
                        return null;
                    }
                }
                else if (l2Live === null || !Array.isArray(l2Live) || l2Live.length === 0) {
                    // API unavailable or empty — ALLOW by default
                    logger_1.winstonLogger.debug(`[TRAIN_ALLOWED_METADATA_MISSING] Leg2 ${c.leg2.trainNo} — live API unavailable, allowing`);
                }
                return c;
            }
            catch (err) {
                // On error, ALLOW the candidate (safe default)
                logger_1.winstonLogger.debug(`[SAFE_VALIDATION_MODE] Live validation error — allowing candidate`);
                return c;
            }
        }));
        for (const v of validationResults) {
            if (v)
                liveValidatedCombos.push(v);
        }
        // Max 2 results per hub to ensure hub diversity across the result set
        const hubCount = new Map();
        const finalSplits = [];
        for (const c of liveValidatedCombos) {
            const h = c.hub || '';
            const cnt = hubCount.get(h) || 0;
            if (cnt >= 2)
                continue; // max 2 from a single hub
            hubCount.set(h, cnt + 1);
            const { _rankScore, ...clean } = c;
            finalSplits.push(clean);
            if (finalSplits.length >= MAX_CANDIDATE_POOL_SPLITS)
                break;
        }
        // Process suggestions AFTER sorting to check against best score
        if (finalSplits.length > 0) {
            const bestScore = finalSplits[0].score || 0;
            finalSplits.forEach((route, index) => {
                route.suggestions = [];
                route.advisory = [];
                const avgSeatProbability = route.success_percent || 0;
                const waitH = Math.round((route.bufferMinutes || 0) / 60 * 10) / 10;
                // —— Step 9: UI Badges —————————————————————————————————————————————
                const uiBadges = [];
                if (index === 0)
                    uiBadges.push('⭐ Recommended Hub: ' + (route.hub || ''));
                if (avgSeatProbability >= 85)
                    uiBadges.push('✅ Strong Confirmation Corridor');
                if ((route.bufferMinutes || 0) <= 60 && (route.bufferMinutes || 0) >= 15)
                    uiBadges.push('⚡ Fastest Transfer');
                if (waitH >= 1 && waitH <= 3)
                    uiBadges.push('🎫 Best for Tatkal');
                if ((route.bufferMinutes || 0) >= 120)
                    uiBadges.push('🛡️ Recommended Buffer');
                route.badges = uiBadges.length ? uiBadges : ['SPLIT'];
                // Suggestions Logic
                if (avgSeatProbability < 50) {
                    route.suggestions.push("⚠️  Low seat availability. Try another date.");
                    route.advisory.push("📉 Low seat availability today. Try tomorrow.");
                }
                // Advisory Logic: Simulate High Demand & Better Day
                const [dd, mm, yyyy] = date.includes('-') ? (date.split('-').length === 3 && date.split('-')[0].length === 2 ? date.split('-') : []) : [];
                const isoDateStr = (dd && mm && yyyy) ? `${yyyy}-${mm}-${dd}T00:00:00.000Z` : date;
                const dateObj = new Date(isoDateStr);
                const isWeekend = dateObj.getDay() === 0 || dateObj.getDay() === 5 || dateObj.getDay() === 6;
                if (isWeekend) {
                    route.advisory.push("🔥 High demand expected. Book early.");
                }
                if (avgSeatProbability < 30) {
                    route.advisory.push("📅 Better availability expected on next day.");
                }
                if (route.risk_level === 'HIGH' || (route.risk_level === 'MEDIUM' && (route.bufferMinutes || 0) < 60)) {
                    route.advisory.push("±️  High delay risk on this route.");
                }
                if (route.bufferMinutes > 180) {
                    route.suggestions.push("⏳ Long waiting time at interchange station.");
                }
                const depHour = parseInt(route.leg1?.departure?.split(":")[0] || "12", 10);
                const arrHour = parseInt(route.leg2?.arrival?.split(":")[0] || "12", 10);
                if (depHour >= 22 || arrHour <= 5 || route.rollover) {
                    route.suggestions.push("🌙 Includes overnight travel.");
                }
                if (index > 0 && Math.abs((route.score || 0) - bestScore) < 50) {
                    route.suggestions.push("💡 Similar route available with slight variation.");
                }
            });
        }
        logger_1.winstonLogger.debug(`[SPLIT_TRACE] VALID SPLITS AFTER RANKING: ${finalSplits.length} (raw: ${preFilterCount} postFilter: ${postFilterCount})`);
        logger_1.winstonLogger.info(`[SPLIT_ENGINE] VALID SPLITS AFTER RANKING: ${finalSplits.length} (raw: ${preFilterCount})`);
        // —— Loose flow validation ——
        // Accept combos where leg[0] starts from ANY source-city station
        // and leg[1] ends at ANY dest-city station. This handles multi-terminal
        // cities (e.g. CSMT/BCT for Mumbai, NDLS/NZM for Delhi).
        const validatedSplits = finalSplits.filter(split => {
            if (!split.legs || split.legs.length !== 2)
                return false;
            const fromCode = split.legs[0].fromCode || '';
            const toCode = split.legs[1].toCode || '';
            // Accept if source matches any known source-city station code
            const srcOk = !fromCode || sCodes.includes(fromCode) ||
                getCity(fromCode) === getCity(sCode);
            // Accept if destination matches any known dest-city station code
            const dstOk = !toCode || dCodes.includes(toCode) ||
                getCity(toCode) === getCity(dCode);
            return srcOk && dstOk;
        });
        let filteredSplits = [...validatedSplits];
        // —— DEBUG LOGGING ————————————————————————————————————————————————————————
        // Log debug information before fallback
        const debugData = {
            timestamp: new Date().toISOString(),
            source: sCode,
            destination: dCode,
            date: date,
            directTrainCount: directTrainsForFilter.length,
            candidateHubs: hubs,
            rejectedHubs: [], // We'll populate this with actual rejected hubs
            rejectionReasons: [], // We'll populate this with actual rejection reasons
            fallbackAttempts: [], // We'll populate this with fallback attempts
            fallbackStrategy: 'none',
            deterministicSortApplied: true,
            finalSplitCount: filteredSplits.length,
            totalDurationFilter: {
                before: allCombinations.length,
                after: filteredCombinations.length,
                reason: "totalDuration < directTime * 0.65 or totalDuration > directTime + 720"
            },
            waitTimeFilter: {
                before: filteredCombinations.length,
                after: filteredCombinations.filter(split => (split.bufferMinutes || 0) <= this.MAX_BUFFER_MINUTES).length,
                reason: "wait time > 12 hours"
            },
            directionalFilter: {
                before: filteredSplits.length,
                after: filteredSplits.filter(split => {
                    if (!split.legs || split.legs.length !== 2)
                        return false;
                    const fromCode = split.legs[0].fromCode || '';
                    const toCode = split.legs[1].toCode || '';
                    const srcOk = !fromCode || sCodes.includes(fromCode) || getCity(fromCode) === getCity(sCode);
                    const dstOk = !toCode || dCodes.includes(toCode) || getCity(toCode) === getCity(dCode);
                    return srcOk && dstOk;
                }).length,
                reason: "flow validation - source/destination mismatch"
            },
            distanceFilter: {
                before: 0,
                after: 0,
                reason: "distance-based filtering"
            }
        };
        // —— STEP 5: REMOVED SAFETY NET ——————————————————————————————————————————
        // We strictly do NOT return fake/invalid combos anymore because it causes 
        // "Class does not exist" errors in IRCTC API when users click them.
        // —— MANDATORY FALLBACK: Try corridor hubs if zero valid splits ————————————
        if (filteredSplits.length === 0) {
            logger_1.winstonLogger.warn('[SPLIT_ENGINE] ⚠️  Zero splits after filtering — checking validated fallback first');
            logger_1.winstonLogger.debug(`[SPLIT_TRACE] FALLBACK_START: allCombinations=${allCombinations.length} filteredCombinations=${filteredCombinations.length} relaxedCombinations=${relaxedCombinations.length}`);
            // PHASE_5B172 — the "validated fallback" must only reuse candidates that
            // already cleared the SAME authoritative live service-date/cancellation gate
            // (STEP 7.5). `filteredCombinations`/`relaxedCombinations` were captured
            // BEFORE that gate, so they must never be restored as fallbacks.
            const validatedFallbackSource = liveValidatedCombos;
            const validatedFallback = validatedFallbackSource
                .filter(split => {
                if (!split.legs || split.legs.length !== 2)
                    return false;
                const fromCode = split.legs[0].fromCode || '';
                const toCode = split.legs[1].toCode || '';
                const srcOk = !fromCode || sCodes.includes(fromCode) || getCity(fromCode) === getCity(sCode);
                const dstOk = !toCode || dCodes.includes(toCode) || getCity(toCode) === getCity(dCode);
                return srcOk && dstOk;
            })
                .sort((a, b) => {
                const durationDiff = (a.totalDuration ?? 99999) - (b.totalDuration ?? 99999);
                if (durationDiff !== 0)
                    return durationDiff;
                const waitDiff = (a.bufferMinutes ?? 99999) - (b.bufferMinutes ?? 99999);
                if (waitDiff !== 0)
                    return waitDiff;
                const keyA = `${a.leg1?.trainNo || ''}|${a.leg2?.trainNo || ''}`;
                const keyB = `${b.leg1?.trainNo || ''}|${b.leg2?.trainNo || ''}`;
                return keyA.localeCompare(keyB);
            });
            if (validatedFallback.length > 0) {
                logger_1.winstonLogger.warn(`[SPLIT_ENGINE] ✅ Using validated fallback combos (${validatedFallback.length})`);
                logger_1.winstonLogger.debug(`[SPLIT_TRACE] FALLBACK: validated fallback found ${validatedFallback.length} combos`);
                debugData.fallbackStrategy = 'validated-live';
                filteredSplits = [...validatedFallback.slice(0, 20)];
            }
            else {
                // We do NOT use allCombinations as a safety net anymore.
                // If they didn't pass strict day/flow validation, they should not be shown.
                // All combos exhausted — do live major-hub fallback
                const fallbackSplits = [];
                if (isDeterministic) {
                    logger_1.winstonLogger.debug(`[SPLIT_TRACE] Deterministic corridor enforced. Bypassing forced major hub fallback.`);
                }
                else {
                    // STEP 4: Force major hub fallback for long-distance routes
                    const forcedMajorHubs = this.getForcedMajorHubs(sCode, dCode, sourceCity, getCity(dCode));
                    logger_1.winstonLogger.debug(`[SPLIT_TRACE] FORCED_HUB_FALLBACK: trying ${forcedMajorHubs.length} major hubs: [${forcedMajorHubs.join(', ')}]`);
                    for (const hub of forcedMajorHubs) {
                        if (sCodes.includes(hub) || dCodes.includes(hub))
                            continue;
                        try {
                            logger_1.winstonLogger.debug(`[SPLIT_TRACE] FALLBACK_HUB: trying ${hub}`);
                            const hubSplits = await this.findSplitsThroughHub(sCode, sName, hub, dCode, dName, date);
                            debugData.fallbackAttempts.push({ hub, success: hubSplits.length > 0 });
                            logger_1.winstonLogger.debug(`[SPLIT_TRACE] FALLBACK_HUB ${hub}: found ${hubSplits.length} splits`);
                            if (hubSplits.length > 0) {
                                fallbackSplits.push(...hubSplits.slice(0, 2));
                                debugData.fallbackStrategy = 'forced-major-hub';
                                logger_1.winstonLogger.info(`[SPLIT_ENGINE] Found ${hubSplits.length} splits through forced hub ${hub}`);
                                if (fallbackSplits.length >= 4)
                                    break;
                            }
                        }
                        catch (error) {
                            logger_1.winstonLogger.warn(`[SPLIT_ENGINE] Failed to find splits through forced hub ${hub}: ${error.message}`);
                            debugData.fallbackAttempts.push({ hub, success: false });
                        }
                    }
                }
                filteredSplits = [...fallbackSplits];
            }
        }
        if (filteredSplits.length === 0) {
            logger_1.winstonLogger.warn('[SPLIT_ENGINE] ⚠️  No splits found even after all fallbacks — returning empty array');
            // removed debug log
            debugData.finalSplitCount = 0;
            splitDebugLogger_1.SplitDebugLogger.log(debugData);
            return [];
        }
        // Log debug data
        debugData.finalSplitCount = filteredSplits.length;
        splitDebugLogger_1.SplitDebugLogger.log(debugData);
        // splitsToNormalize = validated filteredSplits only (no unsafe raw fallback)
        // OPTION C: Expand the candidate pool so Pass 1 has more naturally-passing splits to choose from.
        // recoverValidLeg is only triggered in Pass 2 for a hard cap of 3 failing candidates.
        const RECOVERY_CAP = 3; // Max number of splits we attempt live recovery on
        let splitsToNormalize = filteredSplits.slice(0, Math.max(MAX_SPLIT_RESULTS * 4, 12));
        // —— PASS 1: Validate WITHOUT recoverValidLeg — fast, no external API calls ——
        const validateLegSync = (leg, rejectedReasonRef, legIndex) => {
            if (!leg) {
                rejectedReasonRef.value = `Leg ${legIndex} missing`;
                return false;
            }
            if (!leg.trainNo || leg.trainNo === "00000") {
                rejectedReasonRef.value = `Leg ${legIndex} missing trainNo`;
                return false;
            }
            if (!leg.departure || leg.departure === "--:--") {
                rejectedReasonRef.value = `Leg ${legIndex} missing departure`;
                return false;
            }
            if (!leg.arrival || leg.arrival === "--:--") {
                rejectedReasonRef.value = `Leg ${legIndex} missing arrival`;
                return false;
            }
            let realTrainReason = '';
            const realTrainResult = this.isRealTrain(leg, (reason) => { realTrainReason = reason; });
            if (!realTrainResult) {
                rejectedReasonRef.value = `Leg ${legIndex} failed isRealTrain: ${realTrainReason}`;
                return false;
            }
            if (!this.isTrainActive(leg)) {
                rejectedReasonRef.value = `Leg ${legIndex} failed isTrainActive`;
                return false;
            }
            return true;
        };
        const validatedResults = [];
        // Resolve full city station clusters for terminal correction
        const rawExpandedSCodes = await this.resolveCityStations(sCode);
        const rawExpandedDCodes = await this.resolveCityStations(dCode);
        const expandedSCodes = Array.from(new Set([...(sCodes || []), ...(rawExpandedSCodes || [])]));
        const expandedDCodes = Array.from(new Set([...(dCodes || []), ...(rawExpandedDCodes || [])]));
        for (const split of splitsToNormalize) {
            let leg1 = split.leg1 ? this.normalizeTrain(split.leg1) : split.leg1;
            let leg2 = split.leg2 ? this.normalizeTrain(split.leg2) : split.leg2;
            const ref = { value: '' };
            if (!validateLegSync(leg1, ref, 1) || !validateLegSync(leg2, ref, 2)) {
                if (process.env.NODE_ENV !== 'production')
                    console.log(`[REAL_AUDIT] VALIDATE_REJECT_SYNC | Hub: ${split.hub} | Reason: ${ref.value}`);
                continue;
            }
            const v1Res = await this.validateLegAndCorrectAsync(leg1, expandedSCodes, 'leg1', date);
            if (!v1Res.isValid) {
                console.log(`[REAL_AUDIT] VALIDATE_REJECT_ASYNC_LEG1 | Hub: ${split.hub} | Train: ${leg1?.trainNo} | Reason: ${v1Res.reason}`);
                continue;
            }
            leg1 = v1Res.correctedLeg;
            const leg2Date = leg2.travelDate || leg2.journeyDate || date;
            const v2Res = await this.validateLegAndCorrectAsync(leg2, expandedDCodes, 'leg2', leg2Date);
            if (!v2Res.isValid) {
                console.log(`[REAL_AUDIT] VALIDATE_REJECT_ASYNC_LEG2 | Hub: ${split.hub} | Train: ${leg2?.trainNo} | Reason: ${v2Res.reason}`);
                continue;
            }
            leg2 = v2Res.correctedLeg;
            if (process.env.NODE_ENV !== 'production')
                console.log(`[REAL_AUDIT] VALIDATED_ACCEPTED | Hub: ${split.hub} | Leg1: ${leg1.trainNo} (${leg1.fromCode}->${leg1.toCode}) | Leg2: ${leg2.trainNo} (${leg2.fromCode}->${leg2.toCode})`);
            validatedResults.push({ split, leg1, leg2 });
        }
        const allNormalizedRaw = validatedResults.map(r => {
            const l1Date = r.leg1?.travelDate || r.leg1?.journeyDate || r.leg1?.departureDate || r.split?.leg1?.travelDate || date;
            const l2Date = r.leg2?.travelDate || r.leg2?.journeyDate || r.leg2?.departureDate || r.split?.leg2?.travelDate || date;
            const leg1 = {
                ...r.leg1,
                travelDate: l1Date,
                journeyDate: l1Date,
                departureDate: l1Date,
                arrivalDate: r.leg1?.arrivalDate || r.split?.leg1?.arrivalDate || l1Date
            };
            const leg2 = {
                ...r.leg2,
                travelDate: l2Date,
                journeyDate: l2Date,
                departureDate: l2Date,
                arrivalDate: r.leg2?.arrivalDate || r.split?.leg2?.arrivalDate || l2Date
            };
            return {
                ...r.split,
                leg1,
                leg2,
                legs: [leg1, leg2],
                travelDate: date,
                leg1Date: l1Date,
                leg2Date: l2Date
            };
        });
        let validIndex = 0;
        const normalizedSplits = allNormalizedRaw
            .filter(Boolean)
            .sort((a, b) => (a.totalDuration || 99999) - (b.totalDuration || 99999))
            .slice(0, 20)
            .map(split => {
            return { ...split, isBest: validIndex++ === 0 };
        });
        logger_1.winstonLogger.info(`[SPLIT_ENGINE] ✅ ${normalizedSplits.length} valid splits | raw=${allCombinations.length} | ` +
            `hubs=${hubs.slice(0, 30).length} | api_calls=${this.apiCallCount}`);
        // Save split learning data
        // PHASE_5B109 — `logSplitRecommendation` used to run HERE, on the top raw
        // candidate, before the validation ladder and before the common trust gate.
        // A physically impossible hub could therefore be written to `split_learning`
        // permanently even when it was later dropped from the response. The call now
        // lives in `getSmartRoutes()` immediately after the trust gate
        // (`persistSplitLearning`). `trackApiUsage` stays put: it counts API usage,
        // not route memory, and is unaffected by candidate validity.
        try {
            if (normalizedSplits.length > 0) {
                const { learningService } = require('./learningService');
                await learningService.trackApiUsage('split');
            }
        }
        catch (saveError) {
            logger_1.winstonLogger.error(`[SPLIT_LEARNING] Failed to track api usage: ${saveError.message}`);
        }
        logger_1.winstonLogger.info(`[SPLIT_ENGINE] Final normalized split count: ${normalizedSplits.length}`);
        if (process.env.NODE_ENV !== 'production')
            console.log(`[SPLIT_FINAL] Total candidates: ${allCombinations.length}, Accepted: ${normalizedSplits.length}`);
        if (process.env.NODE_ENV !== 'production')
            console.log(`[SPLIT_DEBUG] Total time taken by split engine: ${Date.now() - this.engineStartMs}ms`);
        if (process.env.NODE_ENV !== 'production')
            console.log(`[SPLIT_DEBUG] Rejection Stats:`, rejectionStats);
        if (process.env.NODE_ENV !== 'production')
            console.log(`[SPLIT_DEBUG] Cache Stats: ${this.legSearchStats.hits} hits, ${this.legSearchStats.misses} misses`);
        // PHASE_084K — attach rejection stats to the returned array so the caller
        // (_findCombinedRoutesInternal) can surface them in diagnostic telemetry.
        normalizedSplits._rejectionStats = rejectionStats;
        return normalizedSplits;
    }
    // ── CANCELLED TRAINS + FABRICATED NAME FILTER ──
    isTrainActive(leg) {
        if (!leg)
            return false;
        // RELAXED: Allow trains with missing/fabricated names if train number is valid
        // Only reject if explicitly cancelled, suspended, or historical
        const num = String(leg.trainNo || leg.train_number || leg.number || '').trim();
        if (!num || num === '00000' || num.length < 4) {
            logger_1.winstonLogger.debug(`[TRAIN_REJECTED_NOT_FOUND] ${num} - invalid train number`);
            return false;
        }
        const status = String(leg.train_status || leg.status || leg.availability?.status || '').toLowerCase();
        const isCancelled = status.includes('cancel') || leg.is_cancelled === true;
        const isSuspended = status.includes('suspend') || status.includes('permanently');
        const isHistorical = leg.is_historical === true || leg.type === 'historical';
        const noRunningDays = Array.isArray(leg.running_days) && leg.running_days.length === 0;
        if (isCancelled || isSuspended || isHistorical || noRunningDays) {
            logger_1.winstonLogger.debug(`[SPLIT_FILTER_CANCELLED] Rejecting inactive train: ${leg.trainNo || leg.train_number} - Status: ${status}`);
            return false;
        }
        return true;
    }
    // ── FINAL REAL-TRAIN ENFORCEMENT ──
    // Handles BOTH raw API field names (departure_time, train_number, train_name)
    // AND normalized leg field names (departure, arrival, trainNo, trainName/name).
    isRealTrain(train, logCb) {
        if (!train)
            return false;
        // Number — raw OR normalized
        const num = String(train.train_number || train.trainNo || train.train_no || train.trainNumber || train.number || '').trim();
        if (!num || num === '00000' || num.length < 4) {
            if (logCb)
                logCb("invalid trainNo");
            return false;
        }
        // Name — raw OR normalized; reject fabricated placeholders AND missing/N/A names
        const name = String(train.train_name || train.trainName || train.name || '').trim();
        if (!name || name === 'N/A' || /^(Passenger|Unknown Express|Unknown Train|Train)\s*\d*/i.test(name)) {
            logger_1.winstonLogger.warn(`[TRAIN_NAME_WARNING] ${num} - Fabricated/missing name: "${name}" (Bypassing for live route)`);
            if (!train.name || train.name === 'N/A') {
                train.name = `Train ${num}`; // Hydrate safely for UI
                train.trainName = `Train ${num}`;
            }
        }
        // Timings — raw API names first, normalized field names as fallback
        const dep = train.departure_time || train.departureTime || train.from_time || train.departure;
        const arr = train.arrival_time || train.arrivalTime || train.to_time || train.arrival;
        if (!dep || !arr || dep === '--:--' || arr === '--:--') {
            logger_1.winstonLogger.warn(`[TRAIN_REJECTED_NO_TIMETABLE] ${num} - Missing timings (dep=${dep}, arr=${arr})`);
            if (logCb)
                logCb("invalid timing");
            return false;
        }
        // Stops — only enforce when explicitly present (stops field may not exist on all API responses)
        const stops = train.stops || train.stationList || train.station_list || train.schedule;
        if (stops !== undefined && (!Array.isArray(stops) || stops.length < 2)) {
            logger_1.winstonLogger.warn(`[TRAIN_REJECTED_NO_TIMETABLE] ${num} - Insufficient stops (${Array.isArray(stops) ? stops.length : 'non-array'})`);
            if (logCb)
                logCb("missing timetable");
            return false;
        }
        logger_1.winstonLogger.info(`[TRAIN_VERIFIED_REAL] ${num} - "${name}" passed validation`);
        return true;
    }
    // ── FINAL LIVE SPLIT RECOVERY ──
    async recoverValidLeg(from, to, date) {
        logger_1.winstonLogger.info(`[LEG_RECOVERY_STARTED] Attempting live recovery for ${from} -> ${to} on ${date}`);
        let recoverTimer;
        try {
            const apiResult = await Promise.race([
                (0, apiPriority_1.fetchWithPriority)({
                    irctc: () => irctcService_1.irctcService.search(from, to, date),
                    // RapidAPI disabled as per request
                }),
                new Promise((resolve) => {
                    recoverTimer = setTimeout(() => resolve(null), 3000);
                })
            ]).finally(() => {
                if (recoverTimer)
                    clearTimeout(recoverTimer);
            });
            if (Array.isArray(apiResult) && apiResult.length > 0) {
                let recoveryFailReason = '';
                let validTrains = [];
                for (let t of apiResult) {
                    let isReal = this.isRealTrain(t, (reason) => { recoveryFailReason = reason; });
                    // LIVE NAME HYDRATION FLOW
                    if (!isReal && recoveryFailReason === "missing name") {
                        const trainNo = String(t.train_number || t.trainNo || t.train_no || t.trainNumber || t.number || '').trim();
                        if (trainNo && trainNo !== '00000') {
                            try {
                                let officialName = null;
                                // Primary Live Lookup
                                const liveInfo = await irctcService_1.irctcService.getTrainInfo(trainNo);
                                if (liveInfo) {
                                    officialName = liveInfo.trainInfo?.train_name || liveInfo.train_name || liveInfo.trainName || liveInfo.name;
                                }
                                // DB Fallback if live APIs lack the name
                                if (!officialName || officialName === 'N/A') {
                                    officialName = await dbService_1.dbService.dbLookupTrainName(trainNo);
                                }
                                if (officialName && officialName !== 'N/A' && !/^(Passenger|Unknown Express|Unknown Train|Train)\s*\d*/i.test(officialName)) {
                                    t.trainName = officialName;
                                    t.train_name = officialName;
                                    t.name = officialName;
                                    logger_1.winstonLogger.info(`[TRAIN_NAME_HYDRATED] Hydrated ${trainNo} with official name: ${officialName}`);
                                    // STEP 4: ONLY THEN run isRealTrain() again
                                    isReal = this.isRealTrain(t, (reason) => { recoveryFailReason = reason; });
                                }
                            }
                            catch (err) {
                                // Error swallowed
                            }
                        }
                    }
                    if (!isReal)
                        continue;
                    const status = String(t.train_status || t.status || '').toLowerCase();
                    if (status.includes('cancel') || status.includes('suspend') || status.includes('historical')) {
                        recoveryFailReason = 'cancelled/suspended';
                        continue;
                    }
                    validTrains.push(t);
                }
                if (validTrains.length > 0) {
                    const recovered = validTrains[0];
                    logger_1.winstonLogger.info(`[LEG_RECOVERY_SUCCESS] Recovered ${recovered.train_number || recovered.trainNo || recovered.train_no || recovered.trainNumber || recovered.number} for ${from}->${to}`);
                    // Cache ONLY verified recovered trains
                    dbService_1.dbService.saveSearchToDB({ source: from, destination: to, date, trains: [recovered], api_used: "recovery_live" }).catch(() => { });
                    return recovered;
                }
                else {
                    logger_1.winstonLogger.warn(`[LEG_RECOVERY_FAILED] ${from}->${to} Error: ${recoveryFailReason}`);
                }
            }
            else if (apiResult === null) {
                logger_1.winstonLogger.warn(`[LEG_RECOVERY_FAILED] ${from}->${to} Error: live lookup failed (timeout)`);
            }
            else {
                logger_1.winstonLogger.warn(`[LEG_RECOVERY_FAILED] ${from}->${to} Error: live lookup failed (empty array)`);
            }
        }
        catch (e) {
            logger_1.winstonLogger.warn(`[LEG_RECOVERY_FAILED] ${from}->${to} Error: live lookup failed (${e.message})`);
            return null;
        }
        logger_1.winstonLogger.warn(`[LEG_RECOVERY_FAILED] No real live trains found for ${from}->${to}`);
        return null;
    }
    // ── PRIVATE ASYNC VALIDATION AND TERMINAL CORRECTION LAYER ──
    // ─────────────────────────────────────────────────────────────────────────
    // PHASE_5B109 — COMMON POST-MERGE PHYSICAL TRUST GATE
    // ─────────────────────────────────────────────────────────────────────────
    /**
     * Validate one candidate's legs against the physical schedule of each leg's
     * own train, and rewrite station identity from the matched schedule rows.
     *
     * Invariants enforced (all delegated to existing machinery):
     *   A/B  from + to physically exist on that train's schedule
     *   C    from SN < to SN
     *   D    schedule is resolved from the leg's own trainNo
     *   E    exact physical codes only — no alias substitution at identity time
     *   F    leg2 boarding comes from the connecting train's own schedule row
     *   G    hub aliases never become the final physical boarding station
     *   H    same-train candidates take this identical path
     *   I    cached schedules are validated at use time, not at cache time
     */
    async validateCandidateAgainstSchedule(split, sCodes, dCodes, date, scheduleMemo, providerMemo, classType, quota) {
        const legs = Array.isArray(split?.legs) && split.legs.length > 0
            ? split.legs
            : [split?.leg1, split?.leg2].filter(Boolean);
        if (legs.length === 0) {
            return { ok: false, reason: 'NO_LEGS', changed: false };
        }
        const correctedLegs = [];
        let changed = false;
        for (let i = 0; i < legs.length; i++) {
            const leg = legs[i];
            const isFirst = i === 0;
            // Invariant D — schedule must belong to this leg's own train.
            const legTrainNo = (0, availabilityCacheKeys_1.normalizeTrainNumber)(String(leg?.trainNo || leg?.number || '').trim());
            if (!legTrainNo || legTrainNo === '00000') {
                return { ok: false, reason: 'INVALID_TRAIN_NO', changed };
            }
            const currentFrom = String(leg?.fromCode || leg?.from || '').toUpperCase().trim();
            const currentTo = String(leg?.toCode || leg?.to || '').toUpperCase().trim();
            if (!currentFrom || !currentTo) {
                return { ok: false, reason: 'MISSING_LEG_ENDPOINTS', changed };
            }
            // Leg 1 boards within the user's source cluster. Leg 2 boards wherever the
            // connecting train physically stops — its own current code is the only
            // admissible hint, never the hub code. This is invariants F + G.
            const clusterHint = isFirst ? sCodes : [currentFrom];
            const legDate = leg?.travelDate || (isFirst ? date : (split?.leg2Date || date));
            // Invariant I + STEP 9 — memoise by train + endpoints + date so repeated
            // candidates over the same train never re-trigger provider calls.
            const memoKey = `${legTrainNo}|${currentFrom}|${currentTo}|${legDate}`;
            let res = scheduleMemo.get(memoKey);
            if (!res) {
                res = await this.validateLegAndCorrectAsync(leg, clusterHint, isFirst ? 'leg1' : 'leg2', legDate);
                scheduleMemo.set(memoKey, res);
            }
            if (!res.isValid || !res.correctedLeg) {
                return { ok: false, reason: res.reason || 'LEG_REJECTED', changed };
            }
            const corrected = res.correctedLeg;
            // Invariants A/B/C — structural segment check against the resolved stops.
            // validateLegAndCorrectAsync already proved both stops exist and SN order
            // holds; this re-asserts it on the corrected identity via the dedicated
            // validator so the check is explicit and centrally owned.
            const stops = Array.isArray(corrected._resolvedStops) ? corrected._resolvedStops : [];
            if (stops.length > 0) {
                const { trainScheduleIntegrityService } = require('./trainScheduleIntegrityService');
                const segment = trainScheduleIntegrityService.validateSegmentOnSchedule(legTrainNo, stops, String(corrected.fromCode || '').toUpperCase().trim(), String(corrected.toCode || '').toUpperCase().trim());
                if (segment.status === 'INVALID') {
                    return { ok: false, reason: segment.reasons?.[0] || 'SEGMENT_INVALID', changed };
                }
            }
            if (corrected.fromCode !== currentFrom || corrected.toCode !== currentTo) {
                changed = true;
            }
            // PHASE_5B180 — PAN-INDIA PROVIDER TRUST CHECK.
            // Only when structured cancellation truth is UNKNOWN, confirm the leg is
            // not explicitly unavailable for THIS segment/date via the existing
            // single-flighted, canonical-keyed availability path. A provider
            // timeout/error remains UNKNOWN (inconclusive) and never becomes CANCELLED.
            const structuredCancellation = classifyCancellationState(corrected);
            if (structuredCancellation === 'UNKNOWN') {
                const providerKey = `${legTrainNo}|${corrected.fromCode}|${corrected.toCode}|${legDate}|${classType}|${quota}`;
                let providerUnavailable = providerMemo.get(providerKey);
                if (providerUnavailable === undefined) {
                    providerUnavailable = await this.isSegmentExplicitlyUnavailable(legTrainNo, corrected.fromCode, corrected.toCode, legDate, classType, quota);
                    providerMemo.set(providerKey, providerUnavailable);
                }
                if (providerUnavailable) {
                    return { ok: false, reason: 'PROVIDER_UNAVAILABLE_SEGMENT', changed };
                }
            }
            // Preserve every field the producer set (availability, pricing, timings,
            // metadata); only physical identity is overwritten.
            correctedLegs.push({ ...leg, ...corrected });
        }
        // Rebuild the candidate without disturbing ranking inputs or metadata.
        const out = { ...split, legs: correctedLegs };
        if (correctedLegs[0])
            out.leg1 = { ...(split.leg1 || {}), ...correctedLegs[0] };
        if (correctedLegs[1])
            out.leg2 = { ...(split.leg2 || {}), ...correctedLegs[1] };
        return { ok: true, corrected: out, changed };
    }
    /**
     * STEP 7 — generic direct-redundancy rule (no train numbers anywhere).
     *
     * A split is redundant when the connecting (final) leg's train physically
     * serves the user's original source station ahead of that leg's alighting
     * point AND a direct end-to-end option on that same train is actually
     * bookable. A waitlisted direct is NOT bookable, so genuine Same Train
     * Rescue candidates survive.
     *
     * PHASE_5B115 — tri-state. Previously every unknown (no availability text, no
     * resolved stops, unresolved source/alighting stop) returned `false`, which the
     * caller read as a confident "not redundant" and published the split. That fails
     * OPEN: a split can be shown as a workaround for a direct train we never actually
     * checked. The three unknown paths now return 'unknown' so the caller can decide,
     * and only genuinely-evaluated candidates return 'not-redundant'.
     */
    isRedundantAgainstDirect(split, directTrains, sCodes) {
        // No directs offered at all — nothing to be redundant against. This is a real
        // answer, not an unknown: the split stands on its own.
        if (!Array.isArray(directTrains) || directTrains.length === 0)
            return 'not-redundant';
        const legs = Array.isArray(split?.legs) && split.legs.length > 0
            ? split.legs
            : [split?.leg1, split?.leg2].filter(Boolean);
        const finalLeg = legs[legs.length - 1];
        if (!finalLeg)
            return 'unknown';
        const finalTrainNo = (0, availabilityCacheKeys_1.normalizeTrainNumber)(String(finalLeg.trainNo || finalLeg.number || '').trim());
        if (!finalTrainNo || finalTrainNo === '00000')
            return 'not-redundant';
        // Is there a bookable direct on this very train with confirmed availability?
        const bookableDirect = directTrains.find((t) => {
            const tNo = (0, availabilityCacheKeys_1.normalizeTrainNumber)(String(t?.trainNo || t?.number || t?.train_number || '').trim());
            if (tNo !== finalTrainNo)
                return false;
            const availText = String(t?.availability?.status || t?.availability?.current_status || t?.availabilityStatus || '').trim();
            if (!availText) {
                // Same train is offered as a direct but availability unqueried — cannot prove bookable direct redundancy
                return false;
            }
            return !DIRECT_BOOKABLE_WL_PATTERNS.test(availText);
        });
        if (!bookableDirect) {
            return 'not-redundant';
        }
        // Does that train physically serve the user's source before the final
        // leg's alighting station? Uses the schedule already resolved by the gate.
        const stops = Array.isArray(finalLeg._resolvedStops) ? finalLeg._resolvedStops : [];
        if (stops.length === 0)
            return 'not-redundant';
        const wanted = new Set(sCodes.map(c => String(c).toUpperCase().trim()));
        const srcStop = stops.find((s) => wanted.has(String(s.Station_Code || '').toUpperCase().trim()));
        const toStop = stops.find((s) => String(s.Station_Code || '').toUpperCase().trim() === String(finalLeg.toCode || '').toUpperCase().trim());
        // A bookable direct exists on this train but we could not locate the boarding or
        // alighting point on its schedule — inconclusive, do not falsely reject.
        if (!srcStop || !toStop)
            return 'not-redundant';
        return Number(srcStop.SN) < Number(toStop.SN) ? 'redundant' : 'not-redundant';
    }
    /**
     * PHASE_5B109 - post-gate persistent split learning.
     *
     * Writes the top trust-gated candidate to `split_learning` for long-term
     * preference tracking. Relocated from `findSplitJourneys()`, where it ran
     * before any validation. The telemetry id is stamped back onto the API
     * response for click-through attribution.
     */
    async persistSplitLearning(sCode, dCode, trustedSplits, apiSplits) {
        if (trustedSplits.length === 0)
            return;
        try {
            const { learningService } = require('./learningService');
            const topTrusted = trustedSplits[0];
            if (!topTrusted.hub)
                return;
            const telemetryId = await learningService.logSplitRecommendation(sCode, dCode, topTrusted.hub, topTrusted.bufferMinutes || 0, topTrusted.totalDuration || 0, topTrusted.success_percent || 0, topTrusted.transferMeta);
            if (telemetryId) {
                // Stamp the id onto both the trusted set and the API list (which may
                // differ in shadow mode). The controller reads `recommendation_id` for
                // click attribution; the id must appear on whichever set the user sees.
                trustedSplits.forEach((s) => s.recommendation_id = telemetryId);
                apiSplits.forEach((s) => s.recommendation_id = telemetryId);
            }
        }
        catch (err) {
            logger_1.winstonLogger.error(`[SPLIT_LEARNING] logSplitRecommendation failed: ${err.message}`);
        }
    }
    /**
     * The gate. Runs once, immediately after the producers are merged and before
     * ranking / learning / cache / API.
     */
    async candidateTrustGate(candidates, directTrains, sCodes, dCodes, date, classType, quota) {
        const mode = resolveTrustGateMode();
        if (mode === 'off' || !Array.isArray(candidates) || candidates.length === 0) {
            return { mode, forApi: candidates || [], trusted: candidates || [], rejected: 0, corrected: 0 };
        }
        const scheduleMemo = new Map();
        const providerMemo = new Map();
        const trusted = [];
        let rejected = 0;
        let corrected = 0;
        for (const split of candidates) {
            const tag = (split?.rescueType === 'SAME_TRAIN_SEGMENT' || split?.isSameTrain) ? 'SAME_TRAIN' : 'HUB';
            const legs = Array.isArray(split?.legs) && split.legs.length > 0
                ? split.legs
                : [split?.leg1, split?.leg2].filter(Boolean);
            const idTrain = legs[0]?.trainNo || split?.trainNo || 'unknown';
            const idFrom = legs[0]?.fromCode || legs[0]?.from || '?';
            const idTo = legs[legs.length - 1]?.toCode || legs[legs.length - 1]?.to || '?';
            let outcome;
            try {
                outcome = await this.validateCandidateAgainstSchedule(split, sCodes, dCodes, date, scheduleMemo, providerMemo, classType, quota);
            }
            catch (err) {
                // Fail closed: an error in validation must never mint trust.
                outcome = { ok: false, reason: `GATE_ERROR:${err?.message || 'unknown'}`, changed: false };
            }
            if (!outcome.ok) {
                rejected++;
                logger_1.winstonLogger.warn(`[TRUST_GATE_${mode === 'enforce' ? 'REJECT' : 'WOULD_REJECT'}] type=${tag} trainNo=${idTrain} from=${idFrom} to=${idTo} reason=${outcome.reason}`);
                continue; // excluded from `trusted` in every mode — sinks stay fail-closed
            }
            const candidate = outcome.corrected;
            // Check redundancy: only reject when a confirmed, bookable direct alternative
            // actually proves the split candidate is redundant.
            const redundancy = this.isRedundantAgainstDirect(candidate, directTrains, sCodes);
            if (redundancy === 'redundant') {
                rejected++;
                logger_1.winstonLogger.warn(`[TRUST_GATE_${mode === 'enforce' ? 'REJECT' : 'WOULD_REJECT'}] type=${tag} trainNo=${idTrain} from=${idFrom} to=${idTo} reason=REDUNDANT_WITH_BOOKABLE_DIRECT`);
                continue;
            }
            if (outcome.changed) {
                corrected++;
                const cLegs = candidate.legs || [];
                logger_1.winstonLogger.info(`[TRUST_GATE_CORRECT] type=${tag} trainNo=${idTrain} from=${idFrom}->${cLegs[0]?.fromCode || idFrom} to=${idTo}->${cLegs[cLegs.length - 1]?.toCode || idTo} reason=PHYSICAL_STOP_IDENTITY`);
            }
            trusted.push(candidate);
        }
        if (rejected > 0 || corrected > 0) {
            logger_1.winstonLogger.info(`[TRUST_GATE] mode=${mode} in=${candidates.length} trusted=${trusted.length} rejected=${rejected} corrected=${corrected}`);
        }
        // In every active mode, forApi receives only validated and non-cancelled candidates.
        return {
            mode,
            forApi: trusted,
            trusted,
            rejected,
            corrected,
        };
    }
    async isSegmentExplicitlyUnavailable(trainNo, from, to, date, classType, quota) {
        const { smartAvailabilityService } = await Promise.resolve().then(() => __importStar(require('./smartAvailabilityService')));
        const result = await smartAvailabilityService.getAvailability({
            trainNo,
            from,
            to,
            date,
            classType: classType || 'SL',
            quota: quota || 'GN',
        });
        if (result?.success === false) {
            const reason = String(result.reason || '').toUpperCase();
            if (reason === 'TRAIN_NOT_RUNNING' ||
                reason === 'SEGMENT_NOT_BOOKABLE' ||
                reason === 'CLASS_NOT_AVAILABLE' ||
                reason === 'TRAIN_CANCELLED') {
                return true;
            }
        }
        return false;
    }
    async validateLegAndCorrectAsync(leg, cityCodes, role, date) {
        if (!leg)
            return { isValid: false, reason: 'missing leg' };
        const num = (0, availabilityCacheKeys_1.normalizeTrainNumber)(String(leg.trainNo || leg.number || '').trim());
        if (!num || num === '00000')
            return { isValid: false, reason: 'invalid trainNo' };
        // Cancellation check
        if (isTrainCancelled(leg)) {
            return { isValid: false, reason: `Train ${num} is cancelled` };
        }
        // 1. Booking date eligibility check (ARP <= 120 days)
        const travelDateStr = leg.travelDate || date;
        const travelMs = new Date(travelDateStr).getTime();
        const todayMs = new Date().setHours(0, 0, 0, 0);
        const diffDays = (travelMs - todayMs) / (1000 * 60 * 60 * 24);
        if (diffDays > 120) {
            return { isValid: false, reason: `Date ${travelDateStr} is outside the 120-day Advance Reservation Period` };
        }
        // 2. Fetch train schedule
        let stops = [];
        let runningDaysPattern = null;
        let runningDaysAuthoritative = false;
        let validFrom = leg.validFrom || null;
        let validTo = leg.validTo || null;
        // PHASE_5B122 — declared provenance of `stops`. Set at each acquisition site from
        // WHERE the data came from, never inferred from what it contains: a DB row set and
        // a live payload are shape-identical by this point, which is exactly how the two
        // got conflated. Only 'db' and 'irctc' can back an authoritative origin.
        let stopsSource = 'none';
        // PHASE_5B122 — canonical stop-sequence normalizer, used by both live mappers below.
        // Required once at function scope because the two mapper sites sit in different blocks.
        const { normalizeStopSN } = require('./stationResolutionUtils');
        const scheduleCacheKey = `train_schedule_resolved_${num}`;
        const cachedSchedule = cacheService_1.cacheService.get(scheduleCacheKey);
        if (cachedSchedule) {
            // PHASE_5B086: Verify cached stops are not starting from a suspect DB origin.
            // If the registry marks this train with a true physical origin and the cached stops
            // start from a different but cluster-compatible station, the cached schedule may be stale
            // (written before the 5B086 fix). Invalidate and re-run to prevent ghost cards.
            let cacheValid = true;
            {
                // PHASE_5B129 — compile-only change (wrapper retired). Eviction behaviour is
                // INTENTIONALLY unchanged and still fires on an `inferred` origin: discarding a
                // possibly-stale cache entry is cheap and self-correcting, and the entry may have
                // been written by a pre-fix build that did rewrite the origin. Narrowing this to
                // authoritative-only would leave exactly those poisoned entries in place.
                // Deliberately NOT gated on isAuthoritativeOrigin().
                const { getPhysicalOriginWithConfidence } = require('./stationResolutionUtils');
                const { areStationsCompatible } = require('./stationAliases');
                const trueOrig = getPhysicalOriginWithConfidence(num).code;
                if (trueOrig && cachedSchedule.stops.length > 0) {
                    const cachedOrigin = (cachedSchedule.stops[0].Station_Code || '').toUpperCase().trim();
                    if (cachedOrigin !== trueOrig && areStationsCompatible(cachedOrigin, trueOrig)) {
                        // Cached origin is a cluster alias of the suspect DB origin — evict stale cache
                        logger_1.winstonLogger.warn(`[validateLegAndCorrectAsync] Stale/corrupted schedule cache for ${num}: cached origin ${cachedOrigin} ≠ true origin ${trueOrig} — evicting and re-validating`);
                        cacheService_1.cacheService.del(scheduleCacheKey);
                        cacheValid = false;
                    }
                }
            }
            if (cacheValid) {
                stops = cachedSchedule.stops;
                runningDaysPattern = cachedSchedule.runningDaysPattern ?? null;
                runningDaysAuthoritative = readCachedScheduleSource(cachedSchedule) === 'irctc';
                // PHASE_5B122 — a cached payload is authoritative for ORIGIN only if it recorded
                // where it came from. Pre-5B122 entries and DB-only reverse-SN writes resolve to
                // 'none': still fine for the ordering comparisons below, never enough to let the
                // terminal-correction guard fire on a schedule of unknown provenance.
                stopsSource = readCachedScheduleSource(cachedSchedule);
                logger_1.winstonLogger.debug(`[validateLegAndCorrectAsync] Resolved schedule cache hit for train ${num} (source=${stopsSource})`);
            }
        }
        if (stops.length === 0) {
            try {
                const { supabase } = await Promise.resolve().then(() => __importStar(require('../config/supabase')));
                // DB check
                const { data: dbStops, error: dbErr } = await supabase
                    .from('train_schedule')
                    .select('Station_Code, SN, Station_Name')
                    .eq('Train_No', num)
                    .order('SN', { ascending: true });
                if (!dbErr && dbStops && dbStops.length > 0) {
                    // Check if DB stops contain a station from the boarding city cluster.
                    const boardingInDb = cityCodes.some(c => dbStops.some((s) => (s.Station_Code || '').toUpperCase().trim() === c.toUpperCase().trim()));
                    if (boardingInDb) {
                        stops = dbStops;
                        stopsSource = 'db';
                        const { data: meta } = await supabase
                            .from('trains')
                            .select('running_days')
                            .eq('number', num)
                            .maybeSingle();
                        if (meta?.running_days) {
                            runningDaysPattern = meta.running_days;
                            runningDaysAuthoritative = false;
                        }
                        // Generic Pan-India Physical-Stop Verification:
                        // If DB schedule origin (SN=1) was synthetically overwritten by legacy search logging
                        // (e.g. SN=1 ADI in DB for train 19411 whose true origin is GNC), correct SN=1 to true physical origin.
                        // PHASE_5B129 — detection and mutation are now separate concerns.
                        // `trueOrigin` keeps its previous value at ANY confidence, because it feeds
                        // both the mismatch detection here and the live-origin trust check below
                        // (liveOrigin === trueOrigin). Only the REWRITE of stops[0].Station_Code is
                        // gated on authority: an `inferred` first-word-of-train-name guess may raise
                        // dbOriginSuspect (cheap, triggers live re-validation) but must never change
                        // physical station identity.
                        const { getPhysicalOriginWithConfidence, isAuthoritativeOrigin } = require('./stationResolutionUtils');
                        const { areStationsCompatible } = require('./stationAliases');
                        const originResult = getPhysicalOriginWithConfidence(num);
                        const trueOrigin = originResult.code;
                        const mayRewriteOrigin = isAuthoritativeOrigin(originResult);
                        let dbOriginSuspect = false;
                        let suspectDbOriginCode = ''; // track the suspect DB origin for live verification
                        if (trueOrigin && stops.length > 0) {
                            const currentDbOrigin = (stops[0].Station_Code || '').toUpperCase().trim();
                            if (currentDbOrigin !== trueOrigin && areStationsCompatible(currentDbOrigin, trueOrigin)) {
                                if (mayRewriteOrigin) {
                                    stops[0] = { ...stops[0], Station_Code: trueOrigin };
                                }
                                else {
                                    logger_1.winstonLogger.info(`[validateLegAndCorrectAsync] DB origin mismatch for ${num} (db=${currentDbOrigin} registry=${trueOrigin} confidence=${originResult.confidence}) — rewrite SUPPRESSED (non-authoritative); still marking suspect for live validation`);
                                }
                                // MUST remain outside the authority gate — this is the sole trigger for the
                                // authoritative live fetch below, and the leg is rejected outright if that
                                // fetch fails. Clearing it here would serve the corrupt DB schedule instead.
                                dbOriginSuspect = true;
                                suspectDbOriginCode = currentDbOrigin; // e.g. 'ADI' for train 19407
                            }
                        }
                        // PHASE_5B084 + 5B085: When DB SN:1 was synthetically different from the known physical origin,
                        // the DB schedule may contain other corrupted stops (e.g. AII at SN:8 for train 19407,
                        // which does not exist on its authoritative live route SBIB→LGH). Fetch the live route
                        // and use it as the authoritative physical-stop list for this validation, overriding DB.
                        // This mirrors the dbOriginSuspect fix in trainStationResolver.ts (Phase 5B081) and
                        // closes PATH B — the split card generation path that bypassed the resolver.
                        // Live fetch is triggered ONLY when dbOriginSuspect=true (known DB corruption signal).
                        // PHASE_5B085 critical: track whether the live override actually succeeded. If the circuit
                        // breaker is open or live API returns null/empty, we MUST NOT fall through to validate
                        // against the corrupted DB — that would produce ghost cards. Reject the leg instead.
                        let liveOverrideSucceeded = false;
                        if (dbOriginSuspect) {
                            logger_1.winstonLogger.info(`[validateLegAndCorrectAsync] dbOriginSuspect=true for ${num} — fetching authoritative live route for physical-stop validation`);
                            try {
                                const liveInfo = await irctcService_1.irctcService.getTrainInfo(num);
                                if (liveInfo) {
                                    const liveRoute = liveInfo.route || liveInfo.station_list || liveInfo.stops || liveInfo.stations || liveInfo.trainRoute || liveInfo.stationList || [];
                                    const liveStops = liveRoute.map((s, idx) => {
                                        // PHASE_5B122 — canonical SN normalization (serialNo → sn → SN).
                                        // `sequence` and positional fallback are no longer treated as provider
                                        // evidence. The positional value is still emitted so the SN ordering
                                        // comparison further down behaves exactly as before, but `_snProvided`
                                        // records that it was synthesised, so origin derivation cannot mistake
                                        // array position for a real stop sequence.
                                        const normalized = normalizeStopSN(s);
                                        const snProvided = normalized.status === 'valid';
                                        return {
                                            Station_Code: (s.stationCode || s.stnCode || s.station_code || s.Station_Code || s.code || '').toUpperCase().trim(),
                                            SN: snProvided ? normalized.value : (idx + 1),
                                            _snProvided: snProvided,
                                            Station_Name: s.stationName || s.stnName || s.station_name || s.Station_Name || s.name || ''
                                        };
                                    }).filter((s) => s.Station_Code.length > 0);
                                    if (liveStops.length > 0) {
                                        // PHASE_5B086: Verify live API's first stop is the true physical origin.
                                        // If the live API echoes the same corrupted DB origin (e.g., IRCTC returns ADI for
                                        // train 19407 instead of SBIB), the live data is also corrupted. Reject in that case.
                                        // A live origin is trusted only if it equals the true physical origin, OR if it is
                                        // NOT compatible with the suspect DB origin (meaning it's a genuinely different station,
                                        // not just an alias of the suspect code).
                                        const liveOrigin = liveStops[0].Station_Code;
                                        const liveOriginIsSuspect = suspectDbOriginCode && areStationsCompatible(liveOrigin, suspectDbOriginCode);
                                        const liveOriginTrusted = liveOrigin === trueOrigin || !liveOriginIsSuspect;
                                        if (!liveOriginTrusted) {
                                            logger_1.winstonLogger.warn(`[validateLegAndCorrectAsync] Live API also returns suspect origin ${liveOrigin} for ${num} (expected ${trueOrigin}, suspect DB had ${suspectDbOriginCode}) — both DB and live are corrupted. Rejecting leg.`);
                                            // Do not set liveOverrideSucceeded — will be rejected below
                                        }
                                        else {
                                            stops = liveStops;
                                            stopsSource = 'irctc';
                                            liveOverrideSucceeded = true;
                                            const liveRunning = liveInfo.trainInfo?.running_days || liveInfo.running_days || null;
                                            if (liveRunning) {
                                                runningDaysPattern = liveRunning;
                                                runningDaysAuthoritative = true;
                                            }
                                            logger_1.winstonLogger.info(`[validateLegAndCorrectAsync] Authoritative live schedule for ${num}: ${liveStops.length} stops, origin=${liveOrigin} (replaces suspect DB schedule)`);
                                        }
                                    }
                                }
                            }
                            catch (liveErr) {
                                logger_1.winstonLogger.warn(`[validateLegAndCorrectAsync] Live fallback failed for ${num}: ${liveErr.message} — rejecting leg (suspect DB must not be used)`);
                            }
                            // PHASE_5B085+5B086: If live override did not succeed (circuit breaker open, API null,
                            // empty stops, or live API also echoing corrupted origin), do NOT validate against the
                            // corrupted DB schedule. Reject the leg.
                            if (!liveOverrideSucceeded) {
                                logger_1.winstonLogger.warn(`[validateLegAndCorrectAsync] dbOriginSuspect=true but live fetch unavailable or also corrupted for ${num} — rejecting leg to prevent ghost card`);
                                return { isValid: false, reason: `Schedule suspect for train ${num} — live validation unavailable or corrupted` };
                            }
                        }
                    }
                    else {
                        logger_1.winstonLogger.warn(`[SCHED_INCOMPLETE] Train ${num}: DB has ${dbStops.length} stops but boarding cluster not found — falling through to live API.`);
                    }
                }
                if (stops.length === 0) {
                    // Live API check
                    logger_1.winstonLogger.info(`[getTrainInfo_LIVE] Fetching route schedule for train ${num}`);
                    const liveInfo = await irctcService_1.irctcService.getTrainInfo(num);
                    if (liveInfo) {
                        runningDaysPattern = liveInfo.trainInfo?.running_days || liveInfo.running_days || null;
                        runningDaysAuthoritative = !!runningDaysPattern;
                        const route = liveInfo.route || liveInfo.station_list || liveInfo.stops || liveInfo.stations || liveInfo.trainRoute || liveInfo.stationList || [];
                        stops = route.map((s, idx) => {
                            // PHASE_5B122 — canonical SN normalization; see the suspect-path mapper above.
                            const normalized = normalizeStopSN(s);
                            const snProvided = normalized.status === 'valid';
                            return {
                                Station_Code: (s.stationCode || s.stnCode || s.station_code || s.Station_Code || s.code || '').toUpperCase().trim(),
                                SN: snProvided ? normalized.value : (idx + 1),
                                _snProvided: snProvided,
                                Station_Name: s.stationName || s.stnName || s.station_name || s.Station_Name || s.name || ''
                            };
                        });
                        if (stops.length > 0) {
                            stopsSource = 'irctc';
                        }
                        // Only save to DB when we have valid station codes
                        if (stops.length > 0 && stops.some(s => s.Station_Code.length > 0)) {
                            dbService_1.dbService.upsertTrainData({
                                trainNo: num,
                                name: liveInfo.trainInfo?.train_name || liveInfo.trainName || liveInfo.name,
                                type: liveInfo.trainInfo?.type || 'Express',
                                running_days: runningDaysPattern,
                                source: stops[0].Station_Name,
                                destination: stops[stops.length - 1].Station_Name,
                                departure: liveInfo.trainInfo?.departure || '00:00:00',
                                arrival: liveInfo.trainInfo?.arrival || '00:00:00',
                                travelDate: travelDateStr,
                            }).catch(() => { });
                        }
                    }
                } // end if (stops.length === 0)
                // Cache the resolved schedule if stops found.
                // PHASE_5B122 — record the ACTUAL provenance alongside the stops so a later read
                // can tell a live schedule from a DB row set. Same key, same TTL.
                if (stops.length > 0) {
                    cacheService_1.cacheService.set(scheduleCacheKey, {
                        stops,
                        runningDaysPattern,
                        source: stopsSource,
                        _scheduleProvenanceVersion: SCHEDULE_PROVENANCE_VERSION,
                    }, 7200);
                }
            }
            catch (err) {
                logger_1.winstonLogger.warn(`[validateLegAndCorrectAsync] Schedule fetch failed: ${err.message}`);
            }
        }
        if (stops.length === 0) {
            logger_1.winstonLogger.warn(`[validateLegAndCorrectAsync] Route missing for ${num} — rejecting leg (schedule sync active)`);
            return { isValid: false, reason: `Schedule unavailable for train ${num}` };
        }
        // Ingest authoritative service window / running days if DB had placeholder
        const runningDaysLower = String(runningDaysPattern || '').toLowerCase().trim();
        const isPlaceholder = !runningDaysPattern ||
            runningDaysLower === 'daily' ||
            runningDaysLower === 'all days' ||
            runningDaysLower === '0,1,2,3,4,5,6' ||
            runningDaysLower === '1111111' ||
            runningDaysLower.includes('all') ||
            (0, dayUtils_1.isSpecialTrainNumber)(num);
        if ((isPlaceholder || !runningDaysAuthoritative) && stops.length > 0) {
            try {
                const info = await irctcService_1.irctcService.getTrainInfo(num);
                if (info) {
                    const inner = info.trainInfo || info;
                    const liveRunningDays = inner?.running_days || inner?.runningDays || info?.running_days || info?.runningDays || null;
                    const liveValidFrom = inner?.validFrom || inner?.valid_from || info?.validFrom || info?.valid_from || null;
                    const liveValidTo = inner?.validTo || inner?.valid_to || info?.validTo || info?.valid_to || null;
                    const liveStatus = inner?.train_status || inner?.status || info?.train_status || info?.status || null;
                    const liveCancelled = inner?.is_cancelled === true || inner?.isCancelled === true || info?.is_cancelled === true || info?.isCancelled === true ||
                        (liveStatus && (liveStatus.toLowerCase().includes('cancel') || liveStatus.toLowerCase().includes('suspend')))
                        ? true
                        : (inner?.is_cancelled === false || inner?.isCancelled === false ? false : undefined);
                    if (liveCancelled) {
                        return { isValid: false, reason: `Train ${num} is cancelled` };
                    }
                    if (liveValidFrom)
                        validFrom = liveValidFrom;
                    if (liveValidTo)
                        validTo = liveValidTo;
                    if (liveRunningDays) {
                        runningDaysPattern = liveRunningDays;
                        runningDaysAuthoritative = true;
                    }
                }
            }
            catch (e) {
                logger_1.winstonLogger.warn(`[validateLegAndCorrectAsync] Live service window fetch failed for ${num}: ${e.message}`);
            }
        }
        // PHASE_087N — DB 'Daily' fail-open for regular trains when IRCTC is unavailable.
        // If the live service-window fetch did not upgrade runningDaysAuthoritative,
        // and the train is a standard non-special numbered train (not 09xxx),
        // and its running_days is the 'Daily' placeholder stored in DB,
        // treat the DB record as authoritative — fail-open, not fail-closed.
        // This prevents the IRCTC API being unavailable (e.g. missing api_providers table)
        // from blocking ALL DB-sourced leg candidates with 'UNKNOWN' service-date verdicts.
        if (!runningDaysAuthoritative && !(0, dayUtils_1.isSpecialTrainNumber)(num)) {
            const rdCheck = String(runningDaysPattern || '').toLowerCase().trim();
            const isDbDailyPattern = rdCheck === 'daily' ||
                rdCheck === 'all days' ||
                rdCheck === '0,1,2,3,4,5,6' ||
                rdCheck === '1111111' ||
                rdCheck.includes('all');
            // Only apply when stops came from DB (not live IRCTC) — DB-validated schedule
            if (isDbDailyPattern && stopsSource !== 'irctc') {
                runningDaysAuthoritative = true;
                logger_1.winstonLogger.info(`[validateLegAndCorrectAsync] PHASE_087N: DB 'Daily' accepted as authoritative for ` +
                    `regular train ${num} (IRCTC unavailable, stopsSource=${stopsSource})`);
            }
        }
        // 3. Service-date truth — UNKNOWN must fail closed.
        const currentFrom = (leg.fromCode || leg.from || '').toUpperCase().trim();
        const currentTo = (leg.toCode || leg.to || '').toUpperCase().trim();
        let fromStop = stops.find(s => s.Station_Code === currentFrom);
        let toStop = stops.find(s => s.Station_Code === currentTo);
        const { getDayOffsetForStop } = require('./trainStationResolver');
        const dayOffset = fromStop ? getDayOffsetForStop(stops, fromStop) : 0;
        const serviceVerdict = (0, dayUtils_1.trainOperatesOnDate)(travelDateStr, runningDaysPattern, {
            validFrom,
            validTo,
            runningDaysAuthoritative,
            dayOffset,
        });
        if (serviceVerdict !== 'YES') {
            const reason = serviceVerdict === 'NO'
                ? `Train ${num} does not operate on ${travelDateStr}`
                : `Service-date truth unknown for train ${num} on ${travelDateStr}`;
            return { isValid: false, reason };
        }
        // Terminal correction for boarding station
        //
        // PHASE_5B115 — VERIFIED-ORIGIN GUARD.
        // Historically this block substituted the FIRST city-cluster code that happened
        // to appear on the schedule, with no reference to the train's real origin. Because
        // ADI/SBT/SBIB/GNC are one cluster, a leg boarding at SBIB (19031) or GNC (19411)
        // could silently become ADI — a ghost boarding station the passenger cannot use.
        //
        // When the registry holds a HAND-VERIFIED origin for this train (not a name-parsed
        // guess), that origin is authoritative: a different cluster alias must never be
        // substituted for it. Such candidates are rejected through the existing
        // `Source station ... not found` failure path below — no new response shape.
        //
        // `inferred` (name-parsed) origins carry no authority and are deliberately ignored
        // here, so trains like 12833 (name-parsed "ADI") behave exactly as before.
        //
        // PHASE_5B122 — GENERALISED TO THE AUTHORITATIVE TIER.
        // The guard above protected only the 8 trains in EXPLICIT_TRAIN_ORIGINS out of a
        // 10632-train registry. It now also engages when the origin was DERIVED from the
        // authoritative schedule this validation actually ran against — 'live' (provider
        // fetch this request) or 'db-validated' (structurally validated train_schedule
        // rows). That makes the protection pan-India without hardcoding a single train
        // number: any train whose real schedule we hold gets the same treatment 19031 and
        // 19411 get from the hand-verified table.
        //
        // The authority decision is centralised in isAuthoritativeOrigin(); `inferred` and
        // `unknown` still confer nothing, so 12833's name-parsed "ADI" remains inert unless
        // a real schedule backs it. Everything below this point — areStationsCompatible,
        // blockedAlias, the candidate scan, TERMINAL_CORRECTION_BLOCKED — is unchanged.
        if (!fromStop) {
            const { resolvePhysicalOrigin, isAuthoritativeOrigin } = require('./stationResolutionUtils');
            const { areStationsCompatible } = require('./stationAliases');
            // `stopsSource` is the DECLARED provenance of the stops array this validation ran
            // against, set at each acquisition site — never sniffed from the contents.
            const originInfo = resolvePhysicalOrigin(num, stops, stopsSource);
            const verifiedOrigin = isAuthoritativeOrigin(originInfo) && originInfo.code
                ? String(originInfo.code).toUpperCase().trim()
                : null;
            let blockedAlias = '';
            const matchingFrom = cityCodes.find(code => {
                const c = code.toUpperCase().trim();
                if (!stops.some(s => s.Station_Code === c))
                    return false;
                // A sibling of the verified origin may not stand in for it. Codes outside that
                // cluster are genuine mid-route boarding points and stay allowed.
                if (verifiedOrigin && c !== verifiedOrigin && areStationsCompatible(c, verifiedOrigin)) {
                    blockedAlias = c;
                    return false;
                }
                return true;
            });
            if (matchingFrom) {
                const matchedCode = matchingFrom.toUpperCase().trim();
                fromStop = stops.find(s => s.Station_Code === matchedCode);
                logger_1.winstonLogger.info(`[TERMINAL_CORRECTION] Corrected Leg fromCode for train ${num}: ${currentFrom} -> ${matchedCode}`);
            }
            else if (blockedAlias) {
                logger_1.winstonLogger.warn(`[TERMINAL_CORRECTION_BLOCKED] train ${num}: refused to substitute cluster alias ${blockedAlias} ` +
                    `for ${currentFrom} — ${originInfo.confidence} physical origin is ${verifiedOrigin} and is absent from this schedule`);
            }
        }
        // Terminal correction for alighting station (hub or destination)
        if (!toStop) {
            const otherCityCodes = await this.resolveCityStations(currentTo);
            const matchingTo = otherCityCodes.find(code => stops.some(s => s.Station_Code === code.toUpperCase().trim()));
            if (matchingTo) {
                const matchedCode = matchingTo.toUpperCase().trim();
                toStop = stops.find(s => s.Station_Code === matchedCode);
                logger_1.winstonLogger.info(`[TERMINAL_CORRECTION] Corrected Leg toCode for train ${num}: ${currentTo} -> ${matchedCode}`);
            }
        }
        if (!fromStop) {
            console.log(`[VALIDATE_DIAG] trainNo=${num} currentFrom=${currentFrom} cityCodes=${JSON.stringify(cityCodes)} stopsCount=${stops.length} stopCodes=${JSON.stringify(stops.map(s => s.Station_Code))}`);
            return { isValid: false, reason: `Source station ${currentFrom} not found in train ${num} schedule` };
        }
        if (!toStop) {
            return { isValid: false, reason: `Destination station ${currentTo} not found in train ${num} schedule` };
        }
        // Verify sequence SN
        if (Number(fromStop.SN) >= Number(toStop.SN)) {
            return { isValid: false, reason: `Invalid sequence for train ${num}: boarding ${fromStop.Station_Code} (SN:${fromStop.SN}) >= alighting ${toStop.Station_Code} (SN:${toStop.SN})` };
        }
        // Return corrected leg
        // PHASE_5B109: `_resolvedStops` exposes the authoritative stop list this
        // validation actually ran against (DB, live override, or cache) so the
        // common trust gate can re-assert the segment structurally and evaluate
        // direct-redundancy without issuing a second schedule fetch.
        const correctedLeg = {
            ...leg,
            fromCode: fromStop.Station_Code,
            from: fromStop.Station_Code,
            fromName: fromStop.Station_Name || leg.fromName,
            toCode: toStop.Station_Code,
            to: toStop.Station_Code,
            toName: toStop.Station_Name || leg.toName,
            running_days: runningDaysPattern || leg.running_days,
            runningDays: runningDaysPattern || leg.runningDays,
            validFrom: validFrom || leg.validFrom,
            validTo: validTo || leg.validTo,
            runningDaysAuthoritative,
            dayOffset,
            _resolvedStops: stops,
        };
        if (isTrainCancelled(correctedLeg)) {
            return { isValid: false, reason: `Train ${num} is cancelled` };
        }
        return { isValid: true, correctedLeg };
    }
    // ─────────────────────────────────────────────────────────────────────────
    // NORMALIZE — ensures every Leg sent to UI has clean, consistent fields
    // ─────────────────────────────────────────────────────────────────────────
    normalizeTrain(leg) {
        const safe = (v, d = 'N/A') => v !== undefined && v !== null && v !== '' ? v : d;
        return {
            // —— identity ——
            trainNo: (0, availabilityCacheKeys_1.normalizeTrainNumber)(String(safe(leg.trainNo || leg.train_number || leg.train_no || leg.trainNumber || leg.number || leg.train?.number || leg.train?.trainNo, '00000'))),
            trainName: (() => {
                let name = safe(leg.trainName || leg.train_name || leg.name || leg.train?.name || leg.train?.trainName, undefined);
                if (!name) {
                    const tNo = (0, availabilityCacheKeys_1.normalizeTrainNumber)(String(safe(leg.trainNo || leg.train_number || leg.train_no || leg.trainNumber || leg.number || leg.train?.number || leg.train?.trainNo, '00000')));
                    try {
                        const dbTrains = require('../data/dbTrains.json');
                        const dbEntry = dbTrains.find((t) => String(t.trainNo) === tNo || String(t.number) === tNo);
                        if (dbEntry)
                            name = dbEntry.name || dbEntry.trainName || dbEntry.train_name;
                    }
                    catch (e) { }
                }
                return name;
            })(),
            name: (() => {
                let name = safe(leg.trainName || leg.train_name || leg.name || leg.train?.name || leg.train?.trainName, undefined);
                if (!name) {
                    const tNo = (0, availabilityCacheKeys_1.normalizeTrainNumber)(String(safe(leg.trainNo || leg.train_number || leg.train_no || leg.trainNumber || leg.number || leg.train?.number || leg.train?.trainNo, '00000')));
                    try {
                        const dbTrains = require('../data/dbTrains.json');
                        const dbEntry = dbTrains.find((t) => String(t.trainNo) === tNo || String(t.number) === tNo);
                        if (dbEntry)
                            name = dbEntry.name || dbEntry.trainName || dbEntry.train_name;
                    }
                    catch (e) { }
                }
                return name;
            })(),
            // —— route ——
            from: safe(leg.fromCode || leg.from || leg.fromStationCode || leg.from_station_code || leg.source, 'N/A'),
            to: safe(leg.toCode || leg.to || leg.toStationCode || leg.to_station_code || leg.destination, 'N/A'),
            fromCode: safe(leg.fromCode || leg.from || leg.fromStationCode || leg.from_station_code, 'N/A'),
            toCode: safe(leg.toCode || leg.to || leg.toStationCode || leg.to_station_code, 'N/A'),
            fromName: safe(leg.fromName || leg.source, 'N/A'),
            toName: safe(leg.toName || leg.destination, 'N/A'),
            // —— schedule ——
            departure: safe(leg.departure || leg.departureTime || leg.departure_time || leg.from_time, '--:--'),
            arrival: safe(leg.arrival || leg.arrivalTime || leg.arrival_time || leg.to_time, '--:--'),
            dayNumber: leg.dayNumber ?? 1,
            depDay: leg.depDay ?? 1,
            // —— duration ——
            duration: typeof leg.durationMins === 'number' ? leg.durationMins
                : typeof leg.duration === 'number' ? leg.duration : 0,
            durationMins: typeof leg.durationMins === 'number' ? leg.durationMins
                : typeof leg.duration === 'number' ? leg.duration : 0,
            // —— meta ——
            quota: safe(leg.quota, 'GN'),
            class: safe(leg.class ||
                (Array.isArray(leg.classes) && leg.classes[0]) ||
                leg.enqClass ||
                'SL', 'SL'),
            classes: Array.isArray(leg.classes) ? leg.classes : (typeof leg.classes === 'string' ? leg.classes.split(/[\s,]+/) : []),
            journeyDate: safe(leg.journeyDate || leg.travelDate, undefined),
            travelDate: safe(leg.travelDate || leg.journeyDate, undefined),
            availability: leg.availability || this.parseAvailability(undefined),
            type: leg.type || 'Express',
            running_days: leg.running_days,
            runningDays: leg.runningDays,
            train_status: leg.train_status,
            status: leg.status,
            is_cancelled: leg.is_cancelled,
        };
    }
    /**
     * M1/M2 helper: true only when train_schedule proves boarding SN >= alighting SN.
     * Fail-open: missing schedule/stops → false (KEEP train).
     * Reuses cache key train_schedule_resolved_${num} (no new keys).
     */
    async isProvenReverseScheduleSegment(trainNo, from, to) {
        const num = (0, availabilityCacheKeys_1.normalizeTrainNumber)(String(trainNo || '').trim());
        const fromIn = String(from || '').toUpperCase().trim();
        const toIn = String(to || '').toUpperCase().trim();
        if (!num || num === '00000' || !fromIn || !toIn)
            return false;
        const scheduleCacheKey = `train_schedule_resolved_${num}`;
        let stops = [];
        const cached = cacheService_1.cacheService.get(scheduleCacheKey);
        if (cached?.stops?.length) {
            stops = cached.stops;
        }
        else {
            try {
                const { supabase } = await Promise.resolve().then(() => __importStar(require('../config/supabase')));
                const { data: dbStops, error } = await supabase
                    .from('train_schedule')
                    .select('Station_Code, SN')
                    .eq('Train_No', num)
                    .order('SN', { ascending: true });
                if (error || !dbStops?.length)
                    return false;
                stops = dbStops;
                // PHASE_5B122 — this DB-only write is exactly what used to contaminate the shared
                // key: filterProvenReverseTrains runs BEFORE validateLegAndCorrectAsync, and a
                // payload written here without provenance could satisfy that origin-critical read
                // for the full 7200s TTL. `source: 'db'` + the provenance version now make the
                // payload readable as a DB schedule — and deliberately nothing stronger.
                // PHASE_5B167 — runningDaysPattern is null here so a DB-only reverse-SN write can
                // never mint daily service-date truth; UNKNOWN fails closed downstream.
                cacheService_1.cacheService.set(scheduleCacheKey, {
                    stops,
                    runningDaysPattern: null,
                    source: 'db',
                    _scheduleProvenanceVersion: SCHEDULE_PROVENANCE_VERSION,
                }, 7200);
            }
            catch {
                return false;
            }
        }
        const fromStop = stops.find(s => String(s.Station_Code).toUpperCase().trim() === fromIn);
        const toStop = stops.find(s => String(s.Station_Code).toUpperCase().trim() === toIn);
        if (!fromStop || !toStop)
            return false;
        return Number(fromStop.SN) >= Number(toStop.SN);
    }
    async filterProvenReverseTrains(trains, from, to) {
        const out = [];
        for (const t of trains) {
            const tNo = String(t.train_number || t.trainNo || t.train_no || t.trainNumber || t.number || '').trim();
            if (tNo && await this.isProvenReverseScheduleSegment(tNo, from, to)) {
                logger_1.winstonLogger.debug(`[TRAIN_REJECTED_REVERSE_SN] ${tNo} ${from}->${to}`);
                continue;
            }
            out.push(t);
        }
        return out;
    }
    // —————————————————————————————————————————————————————————————————————————
    /**
     * LIVE-FIRST hub leg search with DB fallback.
     * ORDER: 1. Live API (IRCTC/RapidAPI)  2. DB fallback ONLY if live fails/times out
     * Name checking is NOT done here — done in the final sanitizer (isRealTrain + recoverValidLeg).
     * Here we only reject clearly invalid train numbers and explicitly cancelled trains.
     */
    async searchLeg(from, to, date, forceDbFallback = false) {
        // Lightweight pre-filter: only dummy numbers and cancelled status
        const isBasicallyValid = (t) => {
            const num = String(t.train_number || t.trainNo || t.train_no || t.trainNumber || t.number || '').trim();
            if (!num || num === '00000' || num.length < 4)
                return false;
            // Reject passenger train series (5, 6, 7) early to avoid sequential stagger API calls
            if (num.length === 5 && /^[567]/.test(num)) {
                logger_1.winstonLogger.debug(`[TRAIN_REJECTED_PASSENGER_SERIES_EARLY] ${num}`);
                return false;
            }
            const status = String(t.train_status || t.status || '').toLowerCase();
            if (status.includes('cancel') || status.includes('suspend')) {
                logger_1.winstonLogger.debug(`[TRAIN_REJECTED_LIVE] ${num} - explicitly ${status}`);
                return false;
            }
            if (t.is_cancelled === true || t.isCancelled === true) {
                logger_1.winstonLogger.debug(`[TRAIN_REJECTED_LIVE] ${num} - explicitly cancelled`);
                return false;
            }
            return true;
        };
        const cacheKey = `${from}-${to}-${date}`;
        const cached = this.legSearchCache.get(cacheKey);
        if (cached && Date.now() - cached.timestamp < 180000) { // 3 min cache
            logger_1.winstonLogger.debug(`[SPLIT_SEARCH_CACHE_HIT] ${cacheKey}`);
            this.legSearchStats.hits++;
            return cached.data;
        }
        this.legSearchStats.misses++;
        // 1. LIVE-FIRST
        // PHASE_087N124 FIX A: Dynamic engine budget. Rather than an arbitrary 4000ms ceiling
        // that starved Phase 2 of live calls after Phase 1 fanout, compute remaining engine time
        // from MAX_ENGINE_TIME_MS and ensure API call ceiling is respected.
        const elapsed = this.engineStartMs > 0 ? Date.now() - this.engineStartMs : 0;
        const remainingEngineMs = Math.max(0, this.MAX_ENGINE_TIME_MS - elapsed);
        const hasLiveBudget = !forceDbFallback && remainingEngineMs >= 2000 && this.apiCallCount <= this.MAX_TOTAL_CALLS;
        if (hasLiveBudget) {
            const perCallTimeout = Math.max(2000, Math.min(5000, remainingEngineMs - 1000));
            let searchTimer;
            try {
                const apiResult = await Promise.race([
                    (0, apiPriority_1.fetchWithPriority)({
                        irctc: () => irctcService_1.irctcService.search(from, to, date),
                        // rapidAPI disabled
                    }),
                    new Promise((resolve) => {
                        searchTimer = setTimeout(() => resolve(null), perCallTimeout);
                    })
                ]).finally(() => {
                    if (searchTimer)
                        clearTimeout(searchTimer);
                });
                if (Array.isArray(apiResult) && apiResult.length > 0) {
                    const verified = apiResult.filter(isBasicallyValid).map((t) => ({
                        ...t,
                        travelDate: date
                    }));
                    // M1: drop only schedule-proven reverse segments (fail-open if unproven)
                    const forwardOnly = await this.filterProvenReverseTrains(verified, from, to);
                    if (forwardOnly.length > 0) {
                        logger_1.winstonLogger.info(`[TRAIN_VERIFIED_LIVE] ${from}->${to} on ${date}: ${forwardOnly.length} trains via live API`);
                        dbService_1.dbService.saveSearchToDB({ source: from, destination: to, date, trains: forwardOnly, api_used: "split_live" }).catch(() => { });
                        // ── PHASE_087N67: LIVE + DB MERGE ─────────────────────────────────
                        // Live has results but DB may contain hydrated trains (e.g. 12627, 20497)
                        // that IRCTC did not return. Merge both sets; live copy wins on conflict.
                        let merged = forwardOnly;
                        try {
                            const dbResult = await dbService_1.dbService.searchTrains(from, to, date);
                            if (Array.isArray(dbResult) && dbResult.length > 0) {
                                const dbVerified = dbResult.filter(isBasicallyValid).map((t) => ({
                                    ...t,
                                    travelDate: date
                                }));
                                const dbForwardOnly = await this.filterProvenReverseTrains(dbVerified, from, to);
                                if (dbForwardOnly.length > 0) {
                                    // Build a set of canonical train numbers already present in live results
                                    const getCanonicalNo = (t) => String(t.train_number || t.trainNo || t.train_no || t.trainNumber || t.number || '').trim();
                                    const liveNos = new Set(forwardOnly.map(getCanonicalNo).filter(Boolean));
                                    // Append only DB-only trains (those not present in live results)
                                    const dbOnly = dbForwardOnly.filter(t => {
                                        const n = getCanonicalNo(t);
                                        return n && !liveNos.has(n);
                                    });
                                    if (dbOnly.length > 0) {
                                        logger_1.winstonLogger.info(`[SPLIT_SEARCH_DB_SUPPLEMENT] ${from}->${to}: appending ${dbOnly.length} DB-only train(s) to ${forwardOnly.length} live train(s)`);
                                        merged = [...forwardOnly, ...dbOnly];
                                    }
                                }
                            }
                        }
                        catch (dbErr) {
                            // DB supplement failure must not suppress live results
                            logger_1.winstonLogger.warn(`[SPLIT_SEARCH_DB_SUPPLEMENT] DB query failed for ${from}->${to}: ${dbErr?.message} — using live-only result`);
                        }
                        // ── END MERGE ─────────────────────────────────────────────────────
                        this.legSearchCache.set(cacheKey, { data: merged, timestamp: Date.now() });
                        return merged;
                    }
                    logger_1.winstonLogger.warn(`[TRAIN_REJECTED_LIVE_LOOKUP] ${from}->${to} - all ${apiResult.length} live trains failed basic validity`);
                }
                else if (apiResult === null) {
                    logger_1.winstonLogger.info(`[SPLIT_SEARCH_TIMEOUT] Live API timed out for ${from}->${to} - falling back to DB`);
                }
            }
            catch (err) {
                logger_1.winstonLogger.warn(`[TRAIN_REJECTED_LIVE_LOOKUP] ${from}->${to} live API error: ${err?.message} - falling back to DB`);
            }
        }
        else {
            if (forceDbFallback) {
                logger_1.winstonLogger.debug(`[SPLIT_SEARCH_DB_ONLY] Forced DB fallback for secondary terminal ${from}->${to}`);
            }
            else {
                logger_1.winstonLogger.info(`[SPLIT_SEARCH_SKIP] Live budget exhausted (${elapsed}ms) - using DB fallback for ${from}->${to}`);
            }
        }
        // 2. DB FALLBACK - only when live API fails or times out
        try {
            const dbResult = await dbService_1.dbService.searchTrains(from, to, date);
            if (Array.isArray(dbResult) && dbResult.length > 0) {
                const dbVerified = dbResult.filter(isBasicallyValid).map((t) => ({
                    ...t,
                    travelDate: date
                }));
                // M1: drop only schedule-proven reverse segments (fail-open if unproven)
                const forwardOnly = await this.filterProvenReverseTrains(dbVerified, from, to);
                if (forwardOnly.length > 0) {
                    logger_1.winstonLogger.info(`[SPLIT_SEARCH_DB] DB fallback hit: ${from}->${to} = ${forwardOnly.length} trains (live unavailable)`);
                    this.legSearchCache.set(cacheKey, { data: forwardOnly, timestamp: Date.now() });
                    return forwardOnly;
                }
            }
        }
        catch (err) {
            logger_1.winstonLogger.warn(`[SPLIT_SEARCH_DB] DB fallback error: ${from}->${to}: ${err.message}`);
        }
        logger_1.winstonLogger.info(`[SPLIT_SEARCH_MISS] No verified data: ${from}->${to}`);
        return [];
    }
    /** Map raw API response to a basic Leg (used for direct trains) */
    mapToLeg(raw, fromCode = '', toCode = '', avail) {
        // —— Compute duration from all available sources ——————————————————————————
        let durationMins = 0;
        // 1) Explicit numeric field
        if (raw.duration_mins > 0)
            durationMins = raw.duration_mins;
        else if (raw.durationMins > 0)
            durationMins = raw.durationMins;
        else if (typeof raw.duration === 'number' && raw.duration > 0)
            durationMins = raw.duration;
        // 2) String format: "26:15 hrs", "26:15", "26h15m"
        if (!durationMins) {
            const rawStr = String(raw.travel_time || raw.total_journey_time || raw.duration_str || raw.durationStr || raw.duration || '');
            const clean = rawStr.replace(/[^0-9:]/g, '').trim();
            if (clean.includes(':')) {
                const parts = clean.split(':').map(Number);
                durationMins = (parts[0] || 0) * 60 + (parts[1] || 0);
            }
        }
        // 3) Derive from dep/arr + dayNumber
        if (!durationMins) {
            const dep = raw.departure_time || raw.departureTime || raw.from_time || raw.departure || '';
            const arr = raw.arrival_time || raw.arrivalTime || raw.to_time || raw.arrival || '';
            const dayNum = parseInt(raw.day_number || raw.dayNumber || '1') || 1;
            if (dep && arr) {
                const depM = this.parseToMins(dep);
                const arrM = ((dayNum - 1) * 1440) + this.parseToMins(arr);
                const diff = arrM - depM;
                if (diff > 0)
                    durationMins = diff;
            }
        }
        return {
            trainNo: raw.train_number || raw.trainNo || raw.train_no || raw.number || '',
            trainName: raw.train_name || raw.trainName || raw.name || '',
            name: raw.train_name || raw.trainName || raw.name || '',
            departure: raw.departure_time || raw.departureTime || raw.from_time || raw.departure || '',
            arrival: raw.arrival_time || raw.arrivalTime || raw.to_time || raw.arrival || '',
            dayNumber: parseInt(raw.day_number || raw.dayNumber || '1') || 1,
            durationMins,
            duration: durationMins,
            availability: this.parseAvailability(avail)
        };
    }
    /**
     * Map raw API response to a RichLeg that carries station codes and
     * a properly computed duration (respecting multi-day journeys).
     * Infers overnight arrivals when explicit day fields are missing.
     */
    mapToRichLeg(raw, fromCode, toCode, fromName, toName) {
        // Fix: Use the train's actual station code rather than the cluster fallback if available.
        // This prevents availability lookup failures where a train like 12952 (MMCT) is wrongly tagged as CSMT.
        const actualFromCode = raw._fromCode || raw.fromStationCode || raw.from_station_code || raw.from_stn_code || raw.fromCode || raw.from || fromCode;
        const actualToCode = raw.toStationCode || raw.to_station_code || raw.to_stn_code || raw.toCode || raw.to || toCode;
        const dep = raw.departure_time ||
            raw.departureTime ||
            raw.from_time ||
            raw.departure ||
            '';
        const arr = raw.arrival_time ||
            raw.arrivalTime ||
            raw.to_time ||
            raw.arrival ||
            '';
        // ✅ FINAL TRAIN NUMBER LOGIC — 3-STEP MERGED FIX
        let trainNo = (0, availabilityCacheKeys_1.normalizeTrainNumber)(String(raw.train_number ||
            raw.train_no ||
            raw.trainNo ||
            raw.number ||
            raw.train?.trainNo ||
            raw.train?.number ||
            "").trim());
        // ✅ STEP 1: Regex extract 5-digit number from name
        if (!trainNo && raw.name) {
            const regexMatch = raw.name.match(/\d{5}/);
            if (regexMatch)
                trainNo = regexMatch[0];
        }
        // ✅ STEP 2: Partial DB fallback — match first word of DB name against raw name
        if (!trainNo && raw.name) {
            const rawNameLower = raw.name.toLowerCase();
            const dbMatch = dbTrains_json_1.default.find((t) => {
                const firstWord = t.name?.toLowerCase().split(" ")[0];
                return firstWord && rawNameLower.includes(firstWord);
            });
            if (dbMatch)
                trainNo = dbMatch.trainNo;
        }
        // —— ISSUE 2 FIX: HARD VALIDATION ——
        // Skip invalid legs
        if (!actualFromCode || !actualToCode || !dep || !arr) {
            logger_1.winstonLogger.warn(`[SPLIT_INVALID_LEG] Invalid leg skipped: ${raw.trainNo || raw.name}`);
            return {
                trainNo: "00000",
                trainName: "INVALID",
                name: "INVALID",
                departure: "--:--",
                arrival: "--:--",
                fromCode: actualFromCode || fromCode,
                toCode: actualToCode || toCode,
                fromName,
                toName,
                dayNumber: 1,
                durationMins: 0,
            };
        }
        // ✅ FINAL FALLBACK — no match found
        if (!trainNo || trainNo === '00000') {
            logger_1.winstonLogger.warn(`[SPLIT_INVALID_LEG] Missing trainNo for: ${raw.name}`);
            trainNo = "N/A";
        }
        // ✅ FIX(4C402): Safe trainName fallback with dbTrains.json hydration
        // If the provider API returns no name, look it up in the static DB by trainNo
        // to prevent "Board undefined" in the steps template.
        let trainName = raw.train_name ||
            raw.trainName ||
            raw.name ||
            raw.train?.trainName ||
            undefined;
        if (!trainName && trainNo && trainNo !== 'N/A' && trainNo !== '00000') {
            const dbEntry = dbTrains_json_1.default.find((t) => String(t.trainNo) === trainNo || String(t.number) === trainNo);
            if (dbEntry) {
                trainName = dbEntry.name || dbEntry.trainName || dbEntry.train_name;
            }
        }
        // Final safety net: never let name be literally undefined in the steps template
        if (!trainName)
            trainName = `Train ${trainNo}`;
        // —————————————————————————————————————————————————————————
        // 1) Extract duration from all available fields (same as mapToLeg)
        let apiDurationMins = 0;
        if (raw.duration_mins > 0)
            apiDurationMins = raw.duration_mins;
        else if (raw.durationMins > 0)
            apiDurationMins = raw.durationMins;
        else if (typeof raw.duration === 'number' && raw.duration > 0)
            apiDurationMins = raw.duration;
        if (!apiDurationMins) {
            const rawStr = String(raw.travel_time || raw.total_journey_time || raw.duration_str || raw.durationStr || raw.duration || '').toLowerCase();
            // Colon format like "26:00 hrs", "26:00", "04:30 hrs" must be checked FIRST
            // to avoid "26:00 hrs" wrongly matching "00 h" in the hour regex.
            const colonMatch = rawStr.match(/(\d+)\s*:\s*(\d+)/);
            if (colonMatch) {
                apiDurationMins = (parseInt(colonMatch[1]) * 60) + parseInt(colonMatch[2]);
            }
            else {
                // Handle "37h 55m" or "37 h 55 m"
                const hMatch = rawStr.match(/(\d+)\s*h/);
                const mMatch = rawStr.match(/(\d+)\s*m/);
                if (hMatch || mMatch) {
                    apiDurationMins = (parseInt(hMatch?.[1] || '0') * 60) + parseInt(mMatch?.[1] || '0');
                }
                else {
                    const clean = rawStr.replace(/[^0-9:]/g, '').trim();
                    if (clean.includes(':')) {
                        const parts = clean.split(':').map(Number);
                        apiDurationMins = (parts[0] || 0) * 60 + (parts[1] || 0);
                    }
                }
            }
        }
        // 2) Infer day numbers
        let depDay = parseInt(raw.from_day || raw.dep_day || '0') || 1;
        let arrDay = parseInt(raw.day_number || raw.dayNumber || raw.to_day || raw.arr_day || '0') || 0;
        const depMins = this.parseToMins(dep);
        const arrMins = this.parseToMins(arr);
        // If arrDay is missing, infer it from explicit duration or fallback rollover.
        // PHASE_4C914 FIX 1: Check raw duration fields before falling back to the
        // simple time-of-day comparison, which only detects a single midnight crossing
        // and cannot identify multi-day (>24h) journeys.
        if (arrDay === 0) {
            if (apiDurationMins > 0) {
                // Highest-confidence path: apiDurationMins was parsed from the response header.
                arrDay = depDay + Math.floor((depMins + apiDurationMins) / 1440);
            }
            else {
                // Try secondary duration fields that some API flavours return.
                const rawDurMins = parseInt(raw.duration_in_min || raw.durationInMinutes || raw.duration_mins || String(0)) || 0;
                if (rawDurMins > 0) {
                    arrDay = depDay + Math.floor((depMins + rawDurMins) / 1440);
                }
                else {
                    // Last resort: time-of-day comparison -- detects a single midnight crossing only.
                    // Cannot detect multi-day journeys without any duration data.
                    arrDay = (arr && depMins > 0 && arrMins < depMins) ? depDay + 1 : depDay;
                }
            }
        }
        let durationMins = this.calcLegDuration(dep, arr, depDay, arrDay);
        if (durationMins === 0 && apiDurationMins > 0)
            durationMins = apiDurationMins;
        return {
            trainNo: String(trainNo),
            trainName,
            name: trainName,
            departure: dep,
            arrival: arr,
            fromCode: actualFromCode,
            toCode: actualToCode,
            fromName,
            toName,
            dayNumber: arrDay || 1,
            depDay: depDay || 1,
            durationMins: durationMins || 0,
            availability: this.parseAvailability(raw.availability),
            travelDate: raw.travelDate || raw.date || raw.journeyDate,
            journeyDate: raw.journeyDate || raw.travelDate || raw.date,
            running_days: raw.running_days || raw.runningDays || raw.running_days_pattern || raw.runningDaysPattern,
            runningDays: raw.runningDays || raw.running_days || raw.runningDaysPattern || raw.running_days_pattern,
            train_status: raw.train_status || raw.trainStatus || raw.status,
            status: raw.status || raw.train_status || raw.trainStatus,
            is_cancelled: raw.is_cancelled ?? raw.isCancelled ?? raw.cancelled,
            isCancelled: raw.isCancelled ?? raw.is_cancelled ?? raw.cancelled,
            validFrom: raw.validFrom || raw.valid_from,
            validTo: raw.validTo || raw.valid_to,
            runningDaysAuthoritative: raw.runningDaysAuthoritative ?? false,
        };
    }
    parseAvailability(avail) {
        // FIX(4C402): undefined avail is expected when availability data is absent.
        // Demote to debug to eliminate noisy console spam; split is preserved.
        if (!avail) {
            logger_1.winstonLogger.debug(`[SPLIT_AVAIL] No availability payload — defaulting to CHECK_IRCTC`);
            return { status: 'CHECK_IRCTC', wlCount: 0 };
        }
        const status = (avail.current_status || avail.status || '').toUpperCase();
        if (!status) {
            logger_1.winstonLogger.debug(`[SPLIT_AVAIL] Availability payload has no status field`, avail);
            return { status: 'CHECK_IRCTC', wlCount: 0 };
        }
        let wlCount = 0;
        const match = status.match(/WL\s*(\d+)/i);
        if (match)
            wlCount = parseInt(match[1]);
        return { status: status || 'CHECK_IRCTC', wlCount };
    }
    /**
     * Calculate leg duration in minutes, properly handling day rollovers.
     * Example: dep 22:00 day1, arr 06:00 day2 → 480 min (not -960).
     */
    calcLegDuration(dep, arr, depDay, arrDay) {
        if (!dep || !arr)
            return 0;
        const depMins = ((depDay - 1) * 1440) + this.parseToMins(dep);
        const arrMins = ((arrDay - 1) * 1440) + this.parseToMins(arr);
        const dur = arrMins - depMins;
        // Fallback: simple midnight-wrap if day numbers are missing/identical
        if (dur <= 0) {
            const simple = this.parseToMins(arr) - this.parseToMins(dep);
            return simple > 0 ? simple : simple + 1440;
        }
        return dur;
    }
    /**
     * Calculate wait time between leg1 arrival and leg2 departure.
     * @deprecated Use toEpochMs-based arithmetic in Phase 3 loop instead.
     * Kept for reference only.
     */
    calculateWaitMinutes(arrival, departure, rollover) {
        const arrMins = this.parseToMins(arrival);
        const depMins = this.parseToMins(departure);
        if (rollover)
            return (1440 - arrMins) + depMins;
        const diff = depMins - arrMins;
        return diff >= 0 ? diff : diff + 1440;
    }
    /**
     * Convert a date string + HH:mm time + day-offset to epoch milliseconds.
     * dayOffset=1 means the scheduled time is on the base date itself (no offset).
     * dayOffset=2 means it arrives/departs one day after the base date.
     */
    toEpochMs(baseDateStr, time, dayOffset = 1) {
        if (!time || time === '--:--')
            return 0;
        const [h, m] = time.split(':').map(Number);
        // Parse baseDateStr properly (might be dd-mm-yyyy)
        let parsedDate = baseDateStr;
        if (!parsedDate || typeof parsedDate !== 'string') {
            parsedDate = new Date().toISOString().split('T')[0];
        }
        if (parsedDate.match(/^\d{2}-\d{2}-\d{4}$/)) {
            const [dd, mm, yyyy] = parsedDate.split('-');
            parsedDate = `${yyyy}-${mm}-${dd}`;
        }
        const base = new Date(parsedDate + 'T00:00:00.000Z');
        // dayOffset=1 → same day, dayOffset=2 → +1 day, etc.
        base.setUTCDate(base.getUTCDate() + (dayOffset - 1));
        base.setUTCHours(h || 0, m || 0, 0, 0);
        return base.getTime();
    }
    /**
     * Infer leg duration in minutes from HH:mm departure and arrival.
     * Handles midnight rollovers automatically.
     */
    inferDurationMins(dep, arr) {
        if (!dep || !arr || dep === '--:--' || arr === '--:--')
            return 0;
        const depMins = this.parseToMins(dep);
        const arrMins = this.parseToMins(arr);
        if (arrMins > depMins)
            return arrMins - depMins;
        // Midnight rollover
        return (1440 - depMins) + arrMins;
    }
    /**
     * True when two station codes refer to the same station.
     * Falls back to case-insensitive prefix match for abbreviated codes.
     */
    stationsMatch(code1, code2) {
        if (!code1 || !code2)
            return true; // can't validate → allow
        const a = code1.toUpperCase().trim();
        const b = code2.toUpperCase().trim();
        return a === b || a.startsWith(b) || b.startsWith(a);
    }
    /**
     * Helper to resolve physical inter-station distance in km.
     * Checks transferDistances.json matrix first, falls back to default distance 7.5km.
     */
    getInterStationDistance(code1, code2) {
        const c1 = (code1 || '').toUpperCase().trim();
        const c2 = (code2 || '').toUpperCase().trim();
        if (!c1 || !c2 || c1 === c2)
            return 0;
        const key = `${c1}-${c2}`;
        const reverseKey = `${c2}-${c1}`;
        const distances = transferDistances_json_1.default?.distances || {};
        if (distances[key]?.distanceKm !== undefined) {
            return distances[key].distanceKm;
        }
        if (distances[reverseKey]?.distanceKm !== undefined) {
            return distances[reverseKey].distanceKm;
        }
        return 7.5;
    }
    /**
     * PHASE 4C: Pure helper to compute inter-station transfer metadata and validation.
     * Does NOT call external APIs, mutate input legs, or change legacy behavior when flag is false.
     */
    calculateTransferMeta(l1, l2, waitMins) {
        const fromCode = (l1.toCode || '').toUpperCase().trim();
        const toCode = (l2.fromCode || '').toUpperCase().trim();
        const isSameStation = fromCode === toCode;
        if (isSameStation) {
            if (waitMins < 25 || waitMins > 840) {
                return { isValid: false, reason: 'Layover bounds (25m - 840m) violated' };
            }
            return {
                isValid: true,
                transferMeta: {
                    transferType: 'SAME_STATION',
                    stationChange: false,
                    arrivalStation: { code: fromCode, name: l1.toName || fromCode },
                    boardingStation: { code: toCode, name: l2.fromName || toCode },
                    distanceKm: 0,
                    transitMode: 'WALK',
                    estimatedTransferMinutes: 10,
                    minimumRequiredBufferMinutes: 25,
                    actualBufferMinutes: waitMins,
                    bufferSurplusMinutes: waitMins - 25,
                    transportSuggestion: 'Walk to departure platform'
                }
            };
        }
        // Inter-Station Transfer
        const distanceKm = this.getInterStationDistance(fromCode, toCode);
        let requiredMinBuffer = 35;
        let estimatedTransitMins = 20;
        let transport = 'Auto / Cab (~15-20 min ride)';
        let transitMode = 'ROAD_CAB';
        if (distanceKm <= 5.0) {
            requiredMinBuffer = 35;
            estimatedTransitMins = 20;
            transport = 'Auto / Cab (~15-20 min ride)';
            transitMode = 'ROAD_CAB';
        }
        else if (distanceKm <= 15.0) {
            requiredMinBuffer = 45;
            estimatedTransitMins = 30;
            transport = 'Taxi / Auto / Metro (~25-35 min ride)';
            transitMode = 'ROAD_CAB';
        }
        else if (distanceKm <= 30.0) {
            requiredMinBuffer = 90;
            estimatedTransitMins = 60;
            transport = 'Taxi / Metro Line (~50-60 min ride)';
            transitMode = 'ROAD_HIGHWAY';
        }
        else {
            return { isValid: false, reason: `Inter-station transfer distance (${distanceKm}km) exceeds 30km safety limit` };
        }
        if (waitMins < requiredMinBuffer || waitMins > 840) {
            return { isValid: false, reason: `Layover (${waitMins}m) outside allowed buffer range (${requiredMinBuffer}m - 840m) for ${distanceKm}km transfer` };
        }
        return {
            isValid: true,
            transferMeta: {
                transferType: 'INTER_STATION',
                stationChange: true,
                arrivalStation: { code: fromCode, name: l1.toName || fromCode },
                boardingStation: { code: toCode, name: l2.fromName || toCode },
                distanceKm,
                transitMode,
                estimatedTransferMinutes: estimatedTransitMins,
                minimumRequiredBufferMinutes: requiredMinBuffer,
                actualBufferMinutes: waitMins,
                bufferSurplusMinutes: waitMins - requiredMinBuffer,
                transportSuggestion: transport
            }
        };
    }
    /** Build a natural-language AI explanation for the split journey */
    buildAiExplanation(l1, l2, from, hub, to, waitHours, riskLabel) {
        const trainA = l1.trainName || l1.trainNo || 'Train';
        const trainB = l2.trainName || l2.trainNo || 'Train';
        return (`Take ${trainA} from ${from} to ${hub} (arrives ${l1.arrival}), ` +
            `then board ${trainB} to ${to} (departs ${l2.departure}). ` +
            `${riskLabel} transfer — ${waitHours}h buffer at ${hub}.`);
    }
    parseToMins(time) {
        if (!time)
            return 0;
        const [h, m] = time.split(':').map(Number);
        return (h || 0) * 60 + (m || 0);
    }
    incrementDate(dateStr, days) {
        let parsedDate = dateStr;
        if (!parsedDate || typeof parsedDate !== 'string') {
            parsedDate = new Date().toISOString().split('T')[0];
        }
        if (/^\d{8}$/.test(parsedDate)) {
            parsedDate = `${parsedDate.slice(0, 4)}-${parsedDate.slice(4, 6)}-${parsedDate.slice(6, 8)}`;
        }
        else if (parsedDate.match(/^\d{2}-\d{2}-\d{4}$/)) {
            const [dd, mm, yyyy] = parsedDate.split('-');
            parsedDate = `${yyyy}-${mm}-${dd}`;
        }
        const d = new Date(parsedDate + 'T00:00:00.000Z');
        d.setUTCDate(d.getUTCDate() + days);
        return d.toISOString().split('T')[0];
    }
    shiftSplitDates(result, targetDate, sourceDate) {
        if (!result || !result.split)
            return result;
        const tMs = new Date(targetDate + 'T00:00:00.000Z').getTime();
        const sMs = new Date(sourceDate + 'T00:00:00.000Z').getTime();
        const diffDays = Math.round((tMs - sMs) / 86400000);
        if (diffDays === 0)
            return result;
        const shiftDate = (dStr) => {
            if (!dStr)
                return dStr;
            let parsed = dStr.trim();
            if (/^\d{8}$/.test(parsed)) {
                parsed = `${parsed.slice(0, 4)}-${parsed.slice(4, 6)}-${parsed.slice(6, 8)}`;
            }
            else if (parsed.match(/^\d{2}-\d{2}-\d{4}$/)) {
                const [dd, mm, yyyy] = parsed.split('-');
                parsed = `${yyyy}-${mm}-${dd}`;
            }
            const d = new Date(parsed + 'T00:00:00.000Z');
            d.setUTCDate(d.getUTCDate() + diffDays);
            return d.toISOString().split('T')[0];
        };
        const shiftedSplits = result.split.map((s) => {
            const leg1 = s.leg1 ? {
                ...s.leg1,
                travelDate: shiftDate(s.leg1.travelDate),
                journeyDate: shiftDate(s.leg1.journeyDate || s.leg1.travelDate),
                departureDate: shiftDate(s.leg1.departureDate || s.leg1.travelDate),
                arrivalDate: shiftDate(s.leg1.arrivalDate || s.leg1.travelDate)
            } : s.leg1;
            const leg2 = s.leg2 ? {
                ...s.leg2,
                travelDate: shiftDate(s.leg2.travelDate),
                journeyDate: shiftDate(s.leg2.journeyDate || s.leg2.travelDate),
                departureDate: shiftDate(s.leg2.departureDate || s.leg2.travelDate),
                arrivalDate: shiftDate(s.leg2.arrivalDate || s.leg2.travelDate)
            } : s.leg2;
            const legs = s.legs ? s.legs.map((l, idx) => idx === 0 ? leg1 : leg2) : undefined;
            return {
                ...s,
                travelDate: shiftDate(s.travelDate),
                leg1Date: shiftDate(s.leg1Date || leg1?.travelDate),
                leg2Date: shiftDate(s.leg2Date || leg2?.travelDate),
                leg1,
                leg2,
                legs
            };
        });
        return {
            ...result,
            split: shiftedSplits,
            smart_routes: shiftedSplits
        };
    }
    /**
     * Get major corridor hubs for fallback routing
     * Implements forced fallback for major routes: CSMT→GDG, CSMT→NDLS, BCT→HWH, SBC→NDLS
     */
    getMajorCorridorHubs(sourceCity, destinationCity) {
        // Define major corridor hubs based on source and destination cities
        const corridorHubs = {
            mumbai: {
                delhi: ['PUNE', 'SUR', 'BRC', 'RTM', 'KOTA'],
                south: ['PUNE', 'SUR', 'BRC', 'SC', 'BZA'],
                east: ['PUNE', 'SUR', 'BRC', 'NGP', 'BPL']
            },
            delhi: {
                mumbai: ['GWL', 'AGC', 'BPL', 'CNB'],
                south: ['GWL', 'AGC', 'BPL', 'RTM', 'KOTA'],
                east: ['GWL', 'AGC', 'BPL', 'CNB', 'BSB']
            },
            south: {
                delhi: ['SC', 'UBL', 'MAS', 'BZA'],
                mumbai: ['SC', 'UBL', 'MAS', 'BZA'],
                east: ['SC', 'UBL', 'MAS', 'BZA', 'VSKP']
            }
        };
        // Normalize city names
        const src = sourceCity.toLowerCase();
        const dest = destinationCity.toLowerCase();
        // Try direct corridor
        if (corridorHubs[src] && corridorHubs[src][dest]) {
            return corridorHubs[src][dest];
        }
        // Try regional fallbacks
        if (corridorHubs[src]) {
            if (dest.includes('delhi') || dest.includes('agra') || dest.includes('jaipur')) {
                return corridorHubs[src].delhi || [];
            }
            if (dest.includes('chennai') || dest.includes('bangalore') || dest.includes('hyderabad')) {
                return corridorHubs[src].south || [];
            }
            if (dest.includes('kolkata') || dest.includes('patna') || dest.includes('varanasi')) {
                return corridorHubs[src].east || [];
            }
        }
        // Default major hubs
        return ['PUNE', 'SUR', 'BRC', 'RTM', 'KOTA', 'GWL', 'AGC', 'BPL', 'CNB', 'SC', 'UBL', 'MAS', 'BZA'];
    }
    /**
     * STEP 4: Forced major hub list for long-distance fallback.
     * Returns corridor-specific hubs to try when the engine generates 0 combos.
     */
    getForcedMajorHubs(srcCode, dstCode, srcCity, dstCity) {
        const mumbaiCodes = ['CSMT', 'BCT', 'BDTS', 'LTT', 'DR', 'DDR', 'MMCT', 'PNVL'];
        const northCodes = ['NDLS', 'NZM', 'DLI', 'DEE', 'ANVT', 'SZM', 'AGC', 'GWL'];
        const southCodes = ['MAS', 'MS', 'SBC', 'YPR', 'SC', 'HYB', 'KCG'];
        const eastCodes = ['HWH', 'SDAH', 'KOAA', 'SHM'];
        const gadagCodes = ['GDG'];
        const isMumbai = mumbaiCodes.includes(srcCode) || mumbaiCodes.includes(dstCode);
        const isNorth = northCodes.includes(srcCode) || northCodes.includes(dstCode);
        const isGadag = gadagCodes.includes(srcCode) || gadagCodes.includes(dstCode);
        const isEast = eastCodes.includes(srcCode) || eastCodes.includes(dstCode);
        // Symmetric route checks (e.g. Mumbai <-> Delhi, Mumbai <-> Gadag)
        if (isMumbai && isNorth)
            return ['BRC', 'RTM', 'KOTA', 'GWL'];
        if (isMumbai && isGadag)
            return ['PUNE', 'SUR', 'UBL'];
        if (isMumbai && isEast)
            return ['BSL', 'NGP', 'ROU', 'TAT'];
        // Fallback unidirectional source checks
        if (mumbaiCodes.includes(srcCode)) {
            return ['PUNE', 'SUR', 'BRC', 'RTM', 'KOTA', 'NGP', 'BPL', 'ET', 'BSL', 'SC', 'UBL', 'ADI'];
        }
        if (northCodes.includes(srcCode)) {
            return ['AGC', 'GWL', 'BPL', 'CNB', 'LKO', 'RTM', 'KOTA', 'JHS', 'NGP', 'ET', 'ALD', 'BSB'];
        }
        if (southCodes.includes(srcCode)) {
            return ['SC', 'BZA', 'MAS', 'SBC', 'UBL', 'GDG', 'NGP', 'PUNE', 'VSKP', 'CBE', 'SA'];
        }
        if (eastCodes.includes(srcCode)) {
            return ['PNBE', 'DHN', 'TAT', 'BBS', 'VSKP', 'NGP', 'ALD', 'CNB', 'BSP', 'ROU'];
        }
        const generalHubs = PAN_INDIA_CORRIDOR_HUBS[srcCity.toLowerCase()] || MAJOR_HUBS;
        return generalHubs.slice(0, 10);
    }
    /**
     * Find splits through a specific hub as a fallback
     */
    async findSplitsThroughHub(sourceCode, sourceName, hubCode, destCode, destName, date) {
        try {
            // Get hub name
            const hubName = (await stationService_1.stationService.getStationName(hubCode)) || hubCode;
            // Find leg1: source to hub
            const leg1Trains = await this.searchLeg(sourceCode, hubCode, date);
            if (!Array.isArray(leg1Trains) || leg1Trains.length === 0) {
                return [];
            }
            // Find leg2: hub to destination (same day and next day)
            const dCodes = await this.resolveCityStations(destCode);
            const splits = [];
            for (const dC of dCodes) {
                const leg2TrainsSameDay = await this.searchLeg(hubCode, dC, date);
                const leg2TrainsNextDay = await this.searchLeg(hubCode, dC, this.incrementDate(date, 1));
                const leg2Trains = [
                    ...(Array.isArray(leg2TrainsSameDay) ? leg2TrainsSameDay : []),
                    ...(Array.isArray(leg2TrainsNextDay) ? leg2TrainsNextDay : [])
                ];
                if (leg2Trains.length === 0) {
                    continue;
                }
                // PHASE_087L — Sort leg1 by departure time ascending so morning trains
                // (e.g. 12127 dep 06:10) always rank before evening trains regardless of
                // live API return order. Slice increased from 5→8 for broader hub coverage.
                const _parseDep = (t) => this.parseToMins(String(t.departure || t.departure_time || t.dep_time || '').trim() || '00:00');
                const sortedLeg1 = [...leg1Trains].sort((a, b) => _parseDep(a) - _parseDep(b));
                // Try combinations
                for (const leg1Raw of sortedLeg1.slice(0, 8)) { // PHASE_087L: top 5 → top 8
                    const l1 = this.mapToRichLeg(leg1Raw, sourceCode, hubCode, sourceName, hubName);
                    if (!l1.arrival || l1.arrival === '--:--')
                        continue;
                    const seenSameDayLeg2 = new Set();
                    for (const leg2Raw of leg2Trains.slice(0, 8)) { // PHASE_087L: top 5 → top 8
                        const isNextDay = leg2TrainsSameDay?.includes(leg2Raw) ? false : true;
                        const leg2Date = isNextDay ? this.incrementDate(date, 1) : date;
                        const effectiveDName = dC === destCode ? destName : dC;
                        const l2 = this.mapToRichLeg(leg2Raw, hubCode, dC, hubName, effectiveDName);
                        // Deduplicate next-day candidates representing the same physical Leg2 train
                        const leg2Key = `${l2.trainNo}|${hubCode}|${l2.fromCode}|${l2.toCode}|${l2.departure}|${l2.arrival}`;
                        if (leg2Date === date) {
                            seenSameDayLeg2.add(leg2Key);
                        }
                        else if (seenSameDayLeg2.has(leg2Key)) {
                            continue;
                        }
                        if (!l2.departure || l2.departure === '--:--')
                            continue;
                        // Calculate durations (move above to compute correct arrival day)
                        const leg1Duration = l1.durationMins > 0 ? l1.durationMins : this.inferDurationMins(l1.departure, l1.arrival);
                        const leg2Duration = l2.durationMins > 0 ? l2.durationMins : this.inferDurationMins(l2.departure, l2.arrival);
                        // Calculate wait time using duration-based hub arrival day
                        const l1DepMinsForDay = this.parseToMins(l1.departure || '00:00');
                        const l1ArrDay = (l1.depDay || 1) + Math.floor((l1DepMinsForDay + leg1Duration) / 1440);
                        const leg1ArrivalMs = this.toEpochMs(date, l1.arrival, l1ArrDay);
                        const leg2DepartureMs = this.toEpochMs(leg2Date, l2.departure, 1);
                        let adjustedDep2Ms = leg2DepartureMs;
                        let depDayShift = 0;
                        while (adjustedDep2Ms <= leg1ArrivalMs && depDayShift < 4) {
                            adjustedDep2Ms += 24 * 60 * 60 * 1000;
                            depDayShift++;
                        }
                        const waitMins = Math.round((adjustedDep2Ms - leg1ArrivalMs) / 60000);
                        // Guard waitMins (non‑finite, NaN, or unreasonable)
                        // PHASE_087L — raised ceiling from 720→840 min (14h).
                        // Indian overnight hub connections (e.g. CSMT night train arriving PUNE 01:45,
                        // connecting to HYB-bound train at 14:15 = 750 min wait) are operationally valid
                        // and were incorrectly rejected by the old 12-hour ceiling.
                        // 840 min = 14 hours remains a meaningful sanity bound: above this the user
                        // should book accommodation rather than wait at the station.
                        if (!Number.isFinite(waitMins) || Number.isNaN(waitMins) || waitMins < 0 || waitMins > 840) {
                            continue;
                        }
                        // Guard durations
                        if (!Number.isFinite(leg1Duration) || Number.isNaN(leg1Duration) ||
                            !Number.isFinite(leg2Duration) || Number.isNaN(leg2Duration)) {
                            continue;
                        }
                        // Calculate total duration as sum of parts for perfect consistency
                        const totalMins = leg1Duration + waitMins + leg2Duration;
                        const leg1DepartureMs = this.toEpochMs(date, l1.departure, 1);
                        let leg2DepartureMsOriginal = this.toEpochMs(leg2Date, l2.departure, 1);
                        let adjustedDep2MsOriginal = leg2DepartureMsOriginal;
                        // Guard totalMins (range and finite)
                        if (!Number.isFinite(totalMins) || Number.isNaN(totalMins) || totalMins < 60 || totalMins > 4320) {
                            continue;
                        }
                        // Create split journey
                        const rollover = leg2Date !== date;
                        const waitHours = Math.round(waitMins / 60 * 10) / 10;
                        const riskLabel = waitMins >= 120 ? 'Safe' : 'Moderate';
                        const ai_reason = this.buildAiExplanation(l1, l2, sourceName, hubName, destName, waitHours, riskLabel);
                        const leg1ArrDateStr = new Date(leg1ArrivalMs).toISOString().split('T')[0];
                        const leg2DepDateStr = new Date(adjustedDep2Ms).toISOString().split('T')[0];
                        const leg2ArrDateStr = new Date(adjustedDep2Ms + leg2Duration * 60000).toISOString().split('T')[0];
                        const clonedL1 = {
                            ...l1,
                            travelDate: date,
                            journeyDate: date,
                            departureDate: date,
                            arrivalDate: leg1ArrDateStr
                        };
                        const clonedL2 = {
                            ...l2,
                            travelDate: leg2DepDateStr,
                            journeyDate: leg2DepDateStr,
                            departureDate: leg2DepDateStr,
                            arrivalDate: leg2ArrDateStr
                        };
                        const combo = {
                            hub: hubName,
                            leg1: clonedL1,
                            leg2: clonedL2,
                            bufferMinutes: waitMins,
                            totalDuration: totalMins,
                            leg1Duration,
                            leg2Duration,
                            score: 0,
                            badges: ['SPLIT', 'FALLBACK'],
                            // PHASE_4C914 FIX 2: Use leg2Date (already date or date+1) so that
                            // next-day Leg 2 trains carry the correct calendar date instead of the
                            // original search date. For same-day trains leg2Date === date, so
                            // there is no behaviour change in the non-rollover case.
                            travelDate: leg2Date,
                            rollover: adjustedDep2Ms !== leg2DepartureMs,
                            ai_strategy: 'Fallback corridor route',
                            ai_insight: ai_reason,
                            delayRisk: waitMins >= 120 ? 'Low' : 'Medium',
                            legs: [clonedL1, clonedL2],
                            success_percent: waitMins >= 120 ? 85 : 70,
                            risk_level: waitMins >= 120 ? 'LOW' : 'MEDIUM',
                            ai_reason,
                            total_duration: rankingService_1.rankingService.formatDuration(totalMins),
                            leg1_duration: rankingService_1.rankingService.formatDuration(leg1Duration),
                            leg2_duration: rankingService_1.rankingService.formatDuration(leg2Duration),
                            wait_formatted: rankingService_1.rankingService.formatDuration(waitMins),
                            wait_time: waitMins,
                            steps: [
                                `Board ${l1.trainName || l1.name || 'Train ' + l1.trainNo} (${l1.trainNo}) from ${sourceName} at ${l1.departure}`,
                                `Arrive ${hubName} at ${l1.arrival} — wait ${waitHours}h for connection`,
                                `Board ${l2.trainName || l2.name || 'Train ' + l2.trainNo} (${l2.trainNo}) from ${hubName} at ${l2.departure}`,
                                `Arrive ${destName} at ${l2.arrival}`
                            ]
                        };
                        combo.score = rankingService_1.rankingService.calculateScore(combo);
                        // PHASE_5B091 — SPLIT ENGINE PHYSICAL STOP + SERVICE-DATE TRUST GATE
                        const l1Cancellation = classifyCancellationState(l1);
                        const l2Cancellation = classifyCancellationState(l2);
                        if (l1Cancellation === 'CANCELLED') {
                            logger_1.winstonLogger.info(`[SPLIT_CANCELLATION_GATE_REJECTED] Hub Fallback Leg1 ${l1.trainNo} (${l1.fromCode}->${l1.toCode}): cancellation=${l1Cancellation}`);
                            continue;
                        }
                        if (l2Cancellation === 'CANCELLED') {
                            logger_1.winstonLogger.info(`[SPLIT_CANCELLATION_GATE_REJECTED] Hub Fallback Leg2 ${l2.trainNo} (${l2.fromCode}->${l2.toCode}): cancellation=${l2Cancellation}`);
                            continue;
                        }
                        const { resolveSegmentForAvailability } = await Promise.resolve().then(() => __importStar(require('./trainStationResolver')));
                        const [v1, v2] = await Promise.all([
                            resolveSegmentForAvailability(l1.trainNo, l1.fromCode, l1.toCode, date),
                            resolveSegmentForAvailability(l2.trainNo, l2.fromCode, l2.toCode, leg2DepDateStr)
                        ]);
                        if (!v1.success) {
                            logger_1.winstonLogger.info(`[SPLIT_PHYSICAL_STOP_GATE_REJECTED] Hub Fallback Leg1 ${l1.trainNo} (${l1.fromCode}->${l1.toCode}): ${v1.reason}`);
                            continue;
                        }
                        if (!v2.success) {
                            logger_1.winstonLogger.info(`[SPLIT_PHYSICAL_STOP_GATE_REJECTED] Hub Fallback Leg2 ${l2.trainNo} (${l2.fromCode}->${l2.toCode}): ${v2.reason}`);
                            continue;
                        }
                        // PHASE_5B109 — typed provenance (see deriveProvenance).
                        combo._provenance = deriveProvenance(v1.source, v2.source);
                        splits.push(combo);
                    }
                }
            }
            return splits;
        }
        catch (error) {
            logger_1.winstonLogger.error(`[SPLIT_ENGINE] Error in findSplitsThroughHub: ${error.message}`);
            return [];
        }
    }
}
exports.SplitJourneyEngine = SplitJourneyEngine;
/**
 * PHASE_087I — Designated major railway junction hubs that are valid corridor
 * split points even when closer than the computed minimum distance floor.
 *
 * Rationale: getMinHubDistance() returns 200km for the 500-1000km corridor tier
 * (e.g. CSMT→HYB at 622km). PUNE (117km) and SUR (188km) are verified major
 * junctions with timetable coverage in train_schedule and are legitimate booking
 * segments. The 200km floor was designed to block trivial micro-splits at
 * unimportant nearby stations — NOT to exclude major divisional headquarters.
 *
 * Safety constraints:
 *   - Only explicitly validated stations with train_schedule rows may be added.
 *   - These stations must already survive getValidViaStations() (geo/direction check).
 *   - Arbitrary nearby stations (not in this set) continue to be distance-filtered.
 */
SplitJourneyEngine.MAJOR_JUNCTION_BYPASS = new Set([
    'PUNE', // Mumbai–Hyderabad/Pune corridor (verified: train_schedule rows, 117km from CSMT)
    'SUR', // Solapur — Mumbai–Hyderabad corridor (verified: train_schedule rows, 188km from CSMT)
]);
// ─────────────────────────────────────────────────────────────────────────
// PHASE_087N98: PAN-INDIA MULTI-TERMINAL SELECTION
// ─────────────────────────────────────────────────────────────────────────
// PHASE_087N98: Micro/suburban terminal codes that must stay DB-only even as sister terminals
SplitJourneyEngine.N98_MICRO_TERMINALS = new Set([
    'PNVL', 'BIRD', 'KJT', 'SNRD', 'TNA', 'DR', 'BVI', 'KYN', 'NRL'
]);
exports.splitJourneyEngine = new SplitJourneyEngine();
