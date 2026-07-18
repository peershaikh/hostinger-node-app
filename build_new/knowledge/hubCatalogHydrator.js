"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.hydrateCatalogEntries = hydrateCatalogEntries;
exports.extractHubCodes = extractHubCodes;
exports.computeHubDiff = computeHubDiff;
/**
 * PHASE_4C877 — Hydrate rescue_hub_catalog rows into runtime hub shape.
 * Used by B1 dual-read only; does not alter production hub selection.
 */
const stationAliases_1 = require("../services/stationAliases");
const MAX_HUBS = 2;
function findStopByCode(stops, code) {
    return stops.find((s) => s.Station_Code === code || (0, stationAliases_1.areStationsCompatible)(s.Station_Code, code));
}
function findStopBySn(stops, sn) {
    return stops.find((s) => s.SN === sn);
}
function isHubBetween(hubSn, srcSn, destSn) {
    return srcSn < destSn
        ? hubSn > srcSn && hubSn < destSn
        : hubSn < srcSn && hubSn > destSn;
}
/**
 * Join catalog SN fields to schedule stops; emit the same object shape as _buildHubsFromStops.
 */
function hydrateCatalogEntries(catalog, stops, srcCode, destCode) {
    if (!catalog.length) {
        return { success: false, hubs: [], failureReason: 'empty_catalog' };
    }
    if (!stops || stops.length <= 2) {
        return { success: false, hubs: [], failureReason: 'insufficient_schedule' };
    }
    const srcStop = findStopByCode(stops, srcCode);
    const destStop = findStopByCode(stops, destCode);
    if (!srcStop || !destStop) {
        return { success: false, hubs: [], failureReason: 'src_dest_not_on_schedule' };
    }
    const sortedCatalog = [...catalog]
        .sort((a, b) => b.rank_score - a.rank_score)
        .slice(0, MAX_HUBS);
    const hydrated = [];
    for (const entry of sortedCatalog) {
        if (entry.src_sn !== srcStop.SN || entry.dest_sn !== destStop.SN) {
            continue;
        }
        const hubStop = findStopBySn(stops, entry.hub_sn);
        if (!hubStop) {
            continue;
        }
        const hubCode = hubStop.Station_Code.toUpperCase().trim();
        if (hubCode !== entry.hub_station.toUpperCase().trim()) {
            continue;
        }
        if (!isHubBetween(hubStop.SN, srcStop.SN, destStop.SN)) {
            continue;
        }
        hydrated.push({
            hub: hubStop.Station_Code,
            stop: hubStop,
            srcStop,
            destStop,
            stops,
        });
    }
    if (hydrated.length === 0) {
        return { success: false, hubs: [], failureReason: 'no_valid_catalog_rows' };
    }
    return { success: true, hubs: hydrated };
}
function extractHubCodes(hubs) {
    return hubs
        .map((h) => (h.hub || '').toUpperCase().trim())
        .filter(Boolean);
}
function computeHubDiff(runtimeCodes, catalogCodes) {
    const runtimeSet = new Set(runtimeCodes);
    const catalogSet = new Set(catalogCodes);
    return {
        runtime_only: runtimeCodes.filter((h) => !catalogSet.has(h)),
        catalog_only: catalogCodes.filter((h) => !runtimeSet.has(h)),
    };
}
