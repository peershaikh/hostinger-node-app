"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.rankingService = exports.RankingService = void 0;
const logger_1 = require("../middleware/logger");
class RankingService {
    calculateScore(item) {
        if ('leg1' in item && 'leg2' in item) {
            // --- SPLIT JOURNEY SCORING ---
            const split = item;
            let score = 0;
            // 1. Availability Score (40%)
            const getAvailScore = (avail) => {
                if (!avail || !avail.status)
                    return 0;
                const status = avail.status.toUpperCase();
                if (status.includes('AVAILABLE') || status.includes('CNF'))
                    return 40;
                if (status.includes('RAC'))
                    return 35;
                if (status.includes('WL') || status.includes('WAITLIST')) {
                    const wl = avail.wlCount || 0;
                    if (wl <= 5)
                        return 25;
                    if (wl <= 20)
                        return 15;
                    if (wl <= 50)
                        return 10;
                    return 5;
                }
                return 0; // Regret / Unavailable
            };
            const avail1 = getAvailScore(split.leg1.availability);
            const avail2 = getAvailScore(split.leg2.availability);
            score += (avail1 + avail2) / 2;
            // 2. Connection Safety (25%)
            const isSameTrain = split.leg1.trainNo === split.leg2.trainNo;
            split.isSameTrain = isSameTrain;
            if (isSameTrain) {
                if (!split.badges)
                    split.badges = [];
                if (!split.badges.includes('Same Train Rescue'))
                    split.badges.push('Same Train Rescue');
                score += 25; // Perfect connection
            }
            else {
                const buffer = split.bufferMinutes;
                if (buffer >= 30 && buffer <= 120)
                    score += 25; // Optimal wait
                else if (buffer > 120 && buffer <= 180)
                    score += 15; // Good wait
                else if (buffer > 180 && buffer <= 240)
                    score += 5; // Acceptable
                else if (buffer < 30)
                    score -= 20; // Dangerous connection (penalty)
                else
                    score -= 10; // >240 penalty
            }
            // 3. Confirmation Prediction (20%)
            const getPredPercentage = (avail) => {
                if (!avail || !avail.status)
                    return 0;
                const status = avail.status.toUpperCase();
                if (status.includes('AVAILABLE') || status.includes('CNF'))
                    return 100;
                if (status.includes('RAC'))
                    return 85;
                if (status.includes('WL') || status.includes('WAITLIST')) {
                    const wl = avail.wlCount || 0;
                    if (wl <= 5)
                        return 75;
                    if (wl <= 20)
                        return 50;
                    if (wl <= 50)
                        return 25;
                    return 10;
                }
                return 0;
            };
            const pred1 = getPredPercentage(split.leg1.availability);
            const pred2 = getPredPercentage(split.leg2.availability);
            const avgPred = Math.round((pred1 + pred2) / 2);
            // Attach frontend fields
            split.confirmation_probability = avgPred;
            if (avgPred >= 85)
                split.confidence_badge = 'Very High';
            else if (avgPred >= 70)
                split.confidence_badge = 'High';
            else if (avgPred >= 40)
                split.confidence_badge = 'Medium';
            else if (avgPred >= 15)
                split.confidence_badge = 'Low';
            else
                split.confidence_badge = 'Very Low';
            score += (avgPred * 0.20); // 20% weight
            // 4. Travel Time (10%)
            if (isSameTrain || split.bufferMinutes <= 60)
                score += 10;
            else if (split.bufferMinutes <= 120)
                score += 8;
            else if (split.bufferMinutes <= 240)
                score += 5;
            else
                score += 2;
            // 5. Platform Change (5%)
            if (isSameTrain) {
                score += 5;
            }
            split.recommendation_insight = this.generateAiInsight(split);
            logger_1.winstonLogger.debug(`[RANKING] Split via ${split.hub} | Score: ${score}/100`);
            return score;
        }
        else {
            // --- DIRECT TRAIN SCORING ---
            const leg = item;
            let score = 0;
            const avail = leg.availability;
            if (!avail || !avail.status)
                return 0;
            const status = avail.status.toUpperCase();
            const getPredPercentage = (statusStr, wlCount = 0) => {
                if (statusStr.includes('AVAILABLE') || statusStr.includes('CNF'))
                    return 100;
                if (statusStr.includes('RAC'))
                    return 85;
                if (statusStr.includes('WL') || statusStr.includes('WAITLIST')) {
                    if (wlCount <= 5)
                        return 75;
                    if (wlCount <= 20)
                        return 50;
                    if (wlCount <= 50)
                        return 25;
                    return 10;
                }
                return 0;
            };
            const pred = getPredPercentage(status, avail.wlCount);
            leg.confirmation_probability = pred;
            if (pred >= 85)
                leg.confidence_badge = 'Very High';
            else if (pred >= 70)
                leg.confidence_badge = 'High';
            else if (pred >= 40)
                leg.confidence_badge = 'Medium';
            else if (pred >= 15)
                leg.confidence_badge = 'Low';
            else
                leg.confidence_badge = 'Very Low';
            if (status.includes('AVAILABLE') || status.includes('CNF'))
                score = 100;
            else if (status.includes('RAC'))
                score = 80;
            else if (status.includes('WL') || status.includes('WAITLIST')) {
                const wl = avail.wlCount || 0;
                if (wl <= 5)
                    score = 65;
                else if (wl <= 20)
                    score = 45;
                else if (wl <= 50)
                    score = 25;
                else
                    score = 10;
            }
            logger_1.winstonLogger.debug(`[RANKING] Direct ${leg.trainNo} | Score: ${score}/100`);
            return score;
        }
    }
    generateAiInsight(split) {
        const insights = [];
        if (split.confirmation_probability && split.confirmation_probability >= 85) {
            insights.push("High confirmation chance due to CNF/RAC availability");
        }
        else if (split.confirmation_probability && split.confirmation_probability >= 50) {
            insights.push("Moderate confirmation chance based on waitlist trends");
        }
        if (split.isSameTrain) {
            insights.push("Same train continues after quota change (no platform change required)");
        }
        else {
            insights.push(`Connection time is ${split.bufferMinutes} minutes`);
        }
        return insights.join(". ") + ".";
    }
    isGoodAvailability(avail) {
        if (!avail)
            return false;
        const status = (avail.status || '').toUpperCase();
        return status.includes('AVAILABLE') || status.includes('CNF');
    }
    /**
     * Accurate duration calculation (handles day rollover)
     */
    calculateCorrectDuration(depTime, arrTime, depDay = 1, arrDay = 1) {
        if (!depTime || !arrTime)
            return 0;
        const parseMins = (time, day) => {
            const [h, m] = time.split(':').map(Number);
            return ((day - 1) * 1440) + ((h || 0) * 60) + (m || 0);
        };
        const depTotal = parseMins(depTime, depDay);
        const arrTotal = parseMins(arrTime, arrDay);
        let duration = arrTotal - depTotal;
        if (duration <= 0)
            duration += 1440; // overnight fallback
        return duration;
    }
    formatDuration(mins) {
        const h = Math.floor(mins / 60);
        const m = mins % 60;
        return `${h}h ${m}m`;
    }
    /**
     * Rank items (Best first - lowest score)
     */
    isLegAllowedByPolicy(avail) {
        if (!avail || !avail.status) {
            // PHASE_4C728 FIX_2: fail-closed — block splits with missing availability data.
            // Previously returned true (unsafe), allowing unavailable splits to reach the UI.
            return false;
        }
        const status = String(avail.status).toUpperCase().trim();
        // 1. Block explicit unavailable / regret states
        if (status.includes('REGRET') ||
            status.includes('NOT AVAILABLE') ||
            status.includes('CLASS NOT AVAILABLE') ||
            status.includes('NO SEATS') ||
            status.includes('FULLY SOLD') ||
            status.includes('TRAIN DEPARTED') ||
            status === 'UNAVAILABLE') {
            return false;
        }
        // 2. RAC is always allowed
        if (status.includes('RAC')) {
            return true;
        }
        // 3. Allow all Waitlists - AI Prediction will handle the risk presentation
        if (status.includes('WL') || status.includes('WAITLIST') || status.includes('WAIT')) {
            return true;
        }
        return true;
    }
    isSplitAllowedByPolicy(split) {
        if (!split)
            return false;
        if (split.leg1 && !this.isLegAllowedByPolicy(split.leg1.availability)) {
            return false;
        }
        if (split.leg2 && !this.isLegAllowedByPolicy(split.leg2.availability)) {
            return false;
        }
        return true;
    }
    /**
    * Rank items deterministically (Best first - lowest score)
    * Uses stable sorting with multiple criteria to ensure consistent ordering
    */
    rankTrains(items) {
        if (!items || items.length === 0)
            return [];
        let filteredItems = items;
        if ('leg1' in items[0] && 'leg2' in items[0]) {
            const beforeCount = items.length;
            filteredItems = items.filter(item => {
                const allowed = this.isSplitAllowedByPolicy(item);
                if (!allowed) {
                    logger_1.winstonLogger.info(`[WAITLIST_POLICY_FILTER] Filtered split via ${item.hub} due to waitlist policy. Leg1: ${item.leg1?.trainNo} (${item.leg1?.availability?.status}), Leg2: ${item.leg2?.trainNo} (${item.leg2?.availability?.status})`);
                }
                return allowed;
            });
            const filteredCount = beforeCount - filteredItems.length;
            if (filteredCount > 0) {
                logger_1.winstonLogger.info(`[WAITLIST_POLICY_SUMMARY] Filtered ${filteredCount} splits out of ${beforeCount} total splits`);
            }
        }
        return [...filteredItems].sort((a, b) => {
            // Primary sort by score (Descending - Highest is best)
            const scoreDiff = b.score - a.score;
            if (scoreDiff !== 0)
                return scoreDiff;
            // Secondary sort by stringified JSON for deterministic tie-breaking
            // This ensures identical items always sort in the same order
            const aStr = JSON.stringify(a);
            const bStr = JSON.stringify(b);
            return aStr.localeCompare(bStr);
        });
    }
    prepareForRanking(item) {
        return item; // Already well structured
    }
}
exports.RankingService = RankingService;
exports.rankingService = new RankingService();
