"use strict";
/**
 * PHASE_4C862 — Shared station alias definitions for schedule matching and IRCTC API mapping.
 * Train-aware resolution lives in trainStationResolver.ts (does NOT blindly map DR→CSMT).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.IRCTC_CANONICAL = exports.TERMINAL_ALIASES = void 0;
exports.areStationsCompatible = areStationsCompatible;
exports.normalizeForAPILegacy = normalizeForAPILegacy;
const PAN_INDIA_CLUSTERS = [
    ['CSMT', 'CSTM', 'DR', 'DDR', 'BDTS', 'MMCT', 'BCT', 'LTT', 'BVI', 'PNVL', 'KYN', 'TNA'],
    ['NDLS', 'DLI', 'NZM', 'ANVT', 'DEC', 'GZB', 'DEE'],
    ['HWH', 'SDAH', 'KOAA', 'SHM'],
    ['MAS', 'MS', 'PER', 'TBM', 'MMC'],
    ['SBC', 'YPR', 'SMVB', 'BNC', 'KSR'],
    ['SC', 'HYB', 'KCG'],
    ['PUNE', 'CCH', 'LNL'],
    ['ADI', 'SBT', 'GNC'],
    ['BSB', 'BSBS', 'DDU', 'MUV'],
    ['PRYJ', 'PRRB', 'NYN', 'ALD'],
    ['PNBE', 'PPTA', 'RJPB', 'DNR'],
    ['LKO', 'LJN', 'ASH'],
    ['GHY', 'KYQ'],
    ['ST', 'UDN']
];
exports.TERMINAL_ALIASES = {};
for (const cluster of PAN_INDIA_CLUSTERS) {
    for (const stn of cluster) {
        exports.TERMINAL_ALIASES[stn] = cluster.filter(s => s !== stn);
    }
}
/** IRCTC canonical codes for alias clusters — applied only when train schedule contains the canonical stop. */
exports.IRCTC_CANONICAL = {
    CSTM: 'CSMT',
    MMC: 'MAS',
    KSR: 'SBC',
};
function areStationsCompatible(code1, code2) {
    const c1 = code1.toUpperCase().trim();
    const c2 = code2.toUpperCase().trim();
    if (c1 === c2)
        return true;
    return (exports.TERMINAL_ALIASES[c1] || []).includes(c2);
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
