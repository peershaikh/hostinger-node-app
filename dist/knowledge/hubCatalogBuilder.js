"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildHubCandidatesFromStops = buildHubCandidatesFromStops;
/**
 * PHASE_4C871 — Hub catalog builder (mirrors segmentAvailabilityEngine._buildHubsFromStops).
 * Isolated copy — does not modify rescue engine logic.
 */
const stationAliases_1 = require("../services/stationAliases");
const stationService_1 = require("../services/stationService");
const majorHubs_1 = require("./majorHubs");
function haversineKm(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLon = ((lon2 - lon1) * Math.PI) / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
/**
 * Build top-2 midpoint hubs from schedule stops (same algorithm as rescue engine).
 */
async function buildHubCandidatesFromStops(stops, srcCode, destCode) {
    const srcStop = stops.find((s) => s.Station_Code === srcCode || (0, stationAliases_1.areStationsCompatible)(s.Station_Code, srcCode));
    const destStop = stops.find((s) => s.Station_Code === destCode || (0, stationAliases_1.areStationsCompatible)(s.Station_Code, destCode));
    if (!srcStop || !destStop)
        return [];
    const srcSn = srcStop.SN;
    const destSn = destStop.SN;
    const intermediateStops = stops.filter((s) => {
        const isBetween = srcSn < destSn
            ? s.SN > srcSn && s.SN < destSn
            : s.SN < srcSn && s.SN > destSn;
        return isBetween && (0, majorHubs_1.isMajorHub)(s.Station_Code);
    });
    if (intermediateStops.length === 0)
        return [];
    const srcCoords = await stationService_1.stationService.getCoordinates(srcStop.Station_Code);
    const destCoords = await stationService_1.stationService.getCoordinates(destStop.Station_Code);
    if (!srcCoords || !destCoords)
        return [];
    const midLat = (srcCoords.lat + destCoords.lat) / 2;
    const midLon = (srcCoords.lon + destCoords.lon) / 2;
    const scored = [];
    for (const stop of intermediateStops) {
        const stopCoords = await stationService_1.stationService.getCoordinates(stop.Station_Code);
        if (stopCoords) {
            const dist = haversineKm(stopCoords.lat, stopCoords.lon, midLat, midLon);
            scored.push({ stop, dist });
        }
    }
    scored.sort((a, b) => a.dist - b.dist);
    return scored.slice(0, 2).map((x, idx) => ({
        hub_station: x.stop.Station_Code.toUpperCase().trim(),
        hub_sn: x.stop.SN,
        src_sn: srcSn,
        dest_sn: destSn,
        rank_score: Math.max(0, 100 - x.dist - idx * 0.1),
        buffer_minutes: null,
        is_major_hub: true,
    }));
}
