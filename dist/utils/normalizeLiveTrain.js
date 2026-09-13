"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseCoachPosition = parseCoachPosition;
exports.normalizeLiveTrainData = normalizeLiveTrainData;
function extractTimeString(timeVal) {
    if (!timeVal)
        return '--:--';
    if (typeof timeVal === 'string')
        return timeVal;
    if (typeof timeVal === 'object') {
        const val = timeVal.scheduled || timeVal.time || timeVal.actual || timeVal.arrivalTime || timeVal.departureTime || timeVal.departure_time || timeVal.arrival_time;
        if (val) {
            if (typeof val === 'string')
                return val;
            if (typeof val === 'object')
                return extractTimeString(val);
        }
    }
    return '--:--';
}
function parseCoachPosition(coachData) {
    if (!coachData)
        return [];
    // 1. Array of coach objects (e.g. from getTrainHistory)
    if (Array.isArray(coachData)) {
        return coachData.map((item, idx) => {
            const code = (item.number || item.code || item.coach || item.type || `C${idx + 1}`).toString().trim().toUpperCase();
            const meta = getCoachMetadata(code);
            return {
                code,
                name: item.name || meta.name,
                category: meta.category,
                type: meta.type,
                color: meta.color,
                position: item.position !== undefined ? Number(item.position) : idx + 1,
            };
        });
    }
    // 2. Comma or space-separated string (e.g. from WIMT trackTrainV2: "L,EOG,GS,GS,A2,A1,B4...")
    if (typeof coachData === 'string') {
        const rawTokens = coachData
            .split(/[,|\s]+/)
            .map((s) => s.trim().toUpperCase())
            .filter(Boolean);
        return rawTokens.map((code, idx) => {
            const meta = getCoachMetadata(code);
            return {
                code,
                name: meta.name,
                category: meta.category,
                type: meta.type,
                color: meta.color,
                position: idx + 1,
            };
        });
    }
    return [];
}
function getCoachMetadata(rawCode) {
    const code = rawCode.toUpperCase();
    if (code === 'L' || code === 'ENG' || code === 'LOCO' || code === 'ENGINE') {
        return { name: 'Locomotive Engine', category: 'ENG', type: 'engine', color: 'zinc' };
    }
    if (code === 'EOG' || code === 'LPR' || code === 'PWR') {
        return { name: 'Power Car / End-On Generation', category: 'EOG', type: 'generator', color: 'slate' };
    }
    if (code === 'SLR' || code === 'SLRD' || code === 'VP' || code === 'HCP' || code === 'VPU') {
        return { name: 'Seating cum Luggage Rake / Parcel', category: 'SLR', type: 'luggage', color: 'slate' };
    }
    if (code === 'GS' || code === 'GEN' || code === 'UR') {
        return { name: 'General Unreserved (Second Class)', category: 'GS', type: 'general', color: 'amber' };
    }
    if (code.startsWith('H') && !code.startsWith('HA') && !code.startsWith('HCP')) {
        return { name: `AC First Class (1A) - ${code}`, category: '1A', type: 'ac1', color: 'rose' };
    }
    if (code.startsWith('HA')) {
        return { name: `AC First + AC 2-Tier Composite - ${code}`, category: 'HA', type: 'composite', color: 'indigo' };
    }
    if (code.startsWith('A') && !code.startsWith('AE')) {
        return { name: `AC 2-Tier (2A) - ${code}`, category: '2A', type: 'ac2', color: 'blue' };
    }
    if (code.startsWith('AE')) {
        return { name: `AC 2-Tier Economy / Special - ${code}`, category: '2A', type: 'ac2', color: 'blue' };
    }
    if (code.startsWith('B')) {
        return { name: `AC 3-Tier (3A) - ${code}`, category: '3A', type: 'ac3', color: 'teal' };
    }
    if (code.startsWith('M')) {
        return { name: `AC 3 Economy (3E) - ${code}`, category: '3E', type: 'ac3e', color: 'cyan' };
    }
    if (code.startsWith('C')) {
        return { name: `AC Chair Car (CC) - ${code}`, category: 'CC', type: 'chair', color: 'sky' };
    }
    if (code.startsWith('E') && code !== 'EOG') {
        return { name: `Executive AC Chair Car (EC) - ${code}`, category: 'EC', type: 'exec_chair', color: 'violet' };
    }
    if (code.startsWith('S') && !code.startsWith('SLR') && !code.startsWith('SLRD')) {
        return { name: `Sleeper Class (SL) - ${code}`, category: 'SL', type: 'sleeper', color: 'emerald' };
    }
    if (code.startsWith('D')) {
        return { name: `Second Sitting (2S) - ${code}`, category: '2S', type: 'sitting', color: 'orange' };
    }
    if (code === 'PC' || code === 'PANTRY') {
        return { name: 'Pantry Car (Catering)', category: 'PC', type: 'pantry', color: 'purple' };
    }
    return { name: `Coach ${code}`, category: 'OTHER', type: 'other', color: 'slate' };
}
function normalizeLiveTrainData(rawData) {
    // Try to find the current station from timeline if it exists
    const stations = rawData.journey_timeline || rawData.timeline || rawData.stations || [];
    let currentStation = rawData.current_station || rawData.currentStationName || "En Route";
    let nextStation = rawData.next_station || rawData.nextStationName || "Unknown";
    let speed = rawData.speed || rawData.current_speed || null;
    let delay = rawData.delay_minutes ?? rawData.delay ?? 0;
    let distanceRemaining = rawData.distance_remaining || rawData.distanceRemaining || null;
    let currentIndex = rawData.current_station_index ?? -1;
    let updatedAt = rawData.last_updated || rawData.updatedAt || new Date().toISOString();
    let status = rawData.status_summary || rawData.status || "Running";
    let trainNo = rawData.train_number || rawData.trainNo || "";
    let trainName = rawData.train_name ||
        rawData.trainName ||
        rawData.trainInfo?.train_name ||
        rawData.trainInfo?.trainName ||
        rawData.trainInfo?.name ||
        rawData.data?.trainName ||
        rawData.data?.train_name ||
        "";
    let activeJourneyDate = rawData.active_journey_date || rawData.activeJourneyDate || null;
    // Extract coach information from various provider patterns
    const rawCoachPosition = rawData.coach_position ||
        rawData.coachPosition ||
        rawData.trainInfo?.[0]?.coachPosition ||
        rawData.trainInfo?.coachPosition ||
        rawData.data?.trainInfo?.[0]?.coachPosition ||
        null;
    const rawRakeType = rawData.rake_type ||
        rawData.rakeType ||
        rawData.trainInfo?.[0]?.rakeType ||
        rawData.trainInfo?.rakeType ||
        rawData.data?.trainInfo?.[0]?.rakeType ||
        null;
    const coaches = parseCoachPosition(rawCoachPosition);
    const totalCoaches = coaches.length;
    // Compute from timeline if current index is valid
    if (stations.length > 0) {
        stations.forEach((s) => {
            s.arrival_time = extractTimeString(s.arrival_time || s.arrival || s.arrivalTime || s.Arrival_time);
            s.departure_time = extractTimeString(s.departure_time || s.departure || s.departureTime || s.Departure_Time);
            s.delay_minutes = s.delay_minutes ?? delay ?? 0;
            s.platform = s.platform || s.platform_number || s.platform_no || s.platformNumber || null;
        });
        if (currentIndex === -1) {
            currentIndex = stations.findIndex((s) => s.is_current);
        }
        if (currentIndex === -1) {
            for (let i = stations.length - 1; i >= 0; i--) {
                if (stations[i].is_departed) {
                    currentIndex = i;
                    break;
                }
            }
        }
        if (currentIndex === -1) {
            currentIndex = 0;
        }
        if (currentIndex >= 0 && currentIndex < stations.length) {
            currentStation = stations[currentIndex].station_name || currentStation;
            if (currentIndex + 1 < stations.length) {
                nextStation = stations[currentIndex + 1].station_name || nextStation;
            }
            else {
                nextStation = "Destination Reached";
            }
        }
    }
    // Ensure speed logic
    if (!speed || speed === 0 || speed === "0") {
        speed = null;
    }
    // Ensure distance logic
    if (!distanceRemaining) {
        if (rawData.distance_from_source && rawData.total_distance) {
            distanceRemaining = `${Math.max(0, rawData.total_distance - rawData.distance_from_source)} km`;
        }
    }
    return {
        trainNo,
        train_number: trainNo,
        trainName,
        train_name: trainName,
        speed,
        delay,
        delay_minutes: delay,
        currentStation,
        current_station: currentStation,
        nextStation,
        next_station: nextStation,
        distanceRemaining,
        currentIndex,
        current_station_index: currentIndex,
        stations,
        journey_timeline: stations, // alias — LiveTrackingModal reads journey_timeline
        updatedAt,
        last_updated: updatedAt,
        status,
        status_summary: status,
        activeJourneyDate,
        active_journey_date: activeJourneyDate,
        is_running: rawData.is_running ?? true,
        is_cancelled: rawData.is_cancelled || false,
        api_used: rawData.api_used || rawData.apiUsed || '',
        is_ai_estimated: rawData.is_ai_estimated || rawData.api_used === 'GEMINI_AI' || false,
        coach_position: rawCoachPosition,
        coachPosition: rawCoachPosition,
        rake_type: rawRakeType,
        rakeType: rawRakeType,
        coaches,
        total_coaches: totalCoaches,
    };
}
