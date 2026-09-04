"use strict";
/**
 * PHASE_4C862 — Shared station alias definitions for schedule matching and IRCTC API mapping.
 * Train-aware resolution lives in trainStationResolver.ts (does NOT blindly map DR→CSMT).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.IRCTC_CANONICAL = exports.TERMINAL_ALIASES = exports.PAN_INDIA_CLUSTERS = void 0;
exports.areStationsCompatible = areStationsCompatible;
exports.isCompatibleWithRequestedDestinations = isCompatibleWithRequestedDestinations;
exports.normalizeForAPILegacy = normalizeForAPILegacy;
exports.PAN_INDIA_CLUSTERS = [
    ['CSMT', 'CSTM', 'DR', 'DDR', 'BDTS', 'MMCT', 'BCT', 'LTT', 'BVI', 'PNVL', 'KYN', 'TNA'],
    ['NDLS', 'DLI', 'NZM', 'ANVT', 'DEC', 'GZB', 'DEE'],
    ['HWH', 'SDAH', 'KOAA', 'SHM'],
    ['MAS', 'MS', 'PER', 'TBM', 'MMC'],
    ['SBC', 'YPR', 'SMVB', 'BNC', 'KSR'],
    ['SC', 'HYB', 'KCG'],
    ['PUNE', 'CCH', 'LNL', 'SVJR', 'KK', 'HDP'],
    ['ADI', 'SBT', 'SBIB', 'GNC'],
    ['BSB', 'BSBS', 'DDU', 'MUV'],
    ['PRYJ', 'PRRB', 'NYN', 'ALD'],
    ['PNBE', 'PPTA', 'RJPB', 'DNR'],
    ['LKO', 'LJN', 'ASH'],
    ['GHY', 'KYQ'],
    ['ST', 'UDN']
];
exports.TERMINAL_ALIASES = {};
for (const cluster of exports.PAN_INDIA_CLUSTERS) {
    for (const stn of cluster) {
        exports.TERMINAL_ALIASES[stn] = cluster.filter(s => s !== stn);
    }
}
/** IRCTC canonical codes for alias clusters — applied only when train schedule contains the canonical stop. */
exports.IRCTC_CANONICAL = {
    CSTM: 'CSMT',
    MMC: 'MAS',
    KSR: 'SBC',
    // PHASE_5B037 — ADI cluster: Sabarmati / Gandhinagar Canton → Ahmedabad
    GNC: 'ADI',
    SBT: 'ADI',
    // PHASE_5B037 — Bengaluru: Yeshwantpur → SBC (IRCTC canonical)
    YPR: 'SBC',
};
function areStationsCompatible(code1, code2) {
    const c1 = code1.toUpperCase().trim();
    const c2 = code2.toUpperCase().trim();
    if (c1 === c2)
        return true;
    return (exports.TERMINAL_ALIASES[c1] || []).includes(c2);
}
/**
 * PHASE_087N145: Verify if a final candidate destination is compatible with
 * the requested destination city cluster. If the destination resolves to a known
 * pan-India cluster (e.g. Pune), the destination MUST belong to that cluster.
 */
function isCompatibleWithRequestedDestinations(finalTo, dCodes) {
    const normFinal = (finalTo || '').toUpperCase().trim();
    const normDCodes = (dCodes || []).map(c => (c || '').toUpperCase().trim()).filter(Boolean);
    if (!normFinal || normDCodes.length === 0)
        return false;
    // Find if any requested destination code belongs to a known cluster
    for (const cluster of exports.PAN_INDIA_CLUSTERS) {
        const clusterMatches = cluster.filter(c => normDCodes.includes(c));
        if (clusterMatches.length > 0) {
            // The requested destination is in this pan-India cluster!
            // Therefore, final destination MUST belong to this cluster.
            return cluster.includes(normFinal);
        }
    }
    // If not in a PAN_INDIA_CLUSTER, fallback to dCodes membership
    return normDCodes.includes(normFinal);
}
/**
 * Legacy blind normalization — deprecated for availability; kept for non-train-scoped callers.
 * @deprecated Use trainStationResolver.toIrctcApiCode() with schedule context.
 */
function normalizeForAPILegacy(code) {
    if (!code)
        return '';
    const clean = code.toUpperCase().trim();
    if (clean === 'CSTM')
        return 'CSMT';
    if (clean === 'DR')
        return 'CSMT';
    if (clean === 'DDR')
        return 'CSMT';
    if (clean === 'MMC')
        return 'MAS';
    if (clean === 'KSR')
        return 'SBC';
    return clean;
}
