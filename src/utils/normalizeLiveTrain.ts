function extractTimeString(timeVal: any): string {
  if (!timeVal) return '--:--';
  if (typeof timeVal === 'string') return timeVal;
  if (typeof timeVal === 'object') {
    const val = timeVal.scheduled || timeVal.time || timeVal.actual || timeVal.arrivalTime || timeVal.departureTime || timeVal.departure_time || timeVal.arrival_time;
    if (val) {
      if (typeof val === 'string') return val;
      if (typeof val === 'object') return extractTimeString(val);
    }
  }
  return '--:--';
}

export function normalizeLiveTrainData(rawData: any) {
  
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
  let trainName = rawData.train_name || rawData.trainName || "";
  let activeJourneyDate = rawData.active_journey_date || rawData.activeJourneyDate || null;

  // Compute from timeline if current index is valid
  if (stations.length > 0) {
    stations.forEach((s: any) => {
      s.arrival_time = extractTimeString(s.arrival_time || s.arrival || s.arrivalTime || s.Arrival_time);
      s.departure_time = extractTimeString(s.departure_time || s.departure || s.departureTime || s.Departure_Time);
      s.delay_minutes = s.delay_minutes ?? delay ?? 0;
      s.platform = s.platform || s.platform_number || s.platform_no || s.platformNumber || null;
    });

    if (currentIndex === -1) {
      currentIndex = stations.findIndex((s: any) => s.is_current);
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
      } else {
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
    trainName,
    speed,
    delay,
    delay_minutes: delay,
    currentStation,
    nextStation,
    distanceRemaining,
    currentIndex,
    stations,
    journey_timeline: stations, // alias — LiveTrackingModal reads journey_timeline
    updatedAt,
    status,
    activeJourneyDate
  };
}
