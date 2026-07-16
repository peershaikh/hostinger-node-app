"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.formatStatus = void 0;
exports.normalizeRawPnr = normalizeRawPnr;
const formatStatus = (type, num) => {
    const cleanType = type !== undefined && type !== null ? String(type).toUpperCase().trim() : "";
    const cleanNum = num !== undefined && num !== null ? String(num).trim() : "";
    if (!cleanType)
        return "Unknown";
    if (!cleanNum || cleanNum === "0")
        return cleanType;
    if (cleanType === cleanNum)
        return cleanType;
    return `${cleanType}/${cleanNum}`;
};
exports.formatStatus = formatStatus;
function normalizeRawPnr(rawStatus) {
    if (!rawStatus) {
        throw new Error("Cannot normalize null or undefined PNR response");
    }
    // Handle wrappers
    const pData = rawStatus.data || rawStatus;
    // Extract train details
    const train_no = String(pData.trainNumber || pData.train?.number || pData.train_no || pData.trainNo || '00000').trim();
    const train_name = String(pData.trainName || pData.train?.name || pData.train_name || 'Unknown Train').trim();
    // Extract journey date
    const journey_date = String(pData.journey?.dateOfJourney || pData.boardingDay || pData.journey?.departure || pData.journey_date || pData.journeyDate || 'N/A').trim();
    // Extract stations
    const source_code = String(pData.journey?.source?.code || pData.from?.code || pData.journey?.from?.code || pData.source_code || '').trim();
    const source_name = String(pData.journey?.source?.name || pData.from?.name || pData.journey?.from?.name || pData.source_name || '').trim();
    const destination_code = String(pData.journey?.destination?.code || pData.to?.code || pData.journey?.to?.code || pData.destination_code || '').trim();
    const destination_name = String(pData.journey?.destination?.name || pData.to?.name || pData.journey?.to?.name || pData.destination_name || '').trim();
    const boarding_station = String(pData.journey?.boardingPoint?.name || pData.boardingStation?.name || pData.journey?.from?.name || '').trim();
    // Chart status
    const chart_status = String(pData.chart?.status || pData.chartStatus || pData.chart_status || 'Chart Not Prepared').trim();
    // Quota & Class
    const classVal = String(pData.journey?.class || pData.class || pData.journeyClass || pData.bookingClass || 'Unknown').trim();
    const quota = String(pData.journey?.quota || pData.quota || 'GN').trim();
    // Passengers
    const rawPassengers = Array.isArray(pData.passengers) ? pData.passengers : Array.isArray(pData.data?.passengers) ? pData.data.passengers : [];
    const passengers = rawPassengers.map((p, idx) => {
        const name = String(p.serialNumber || p.passengerName || p.name || `Passenger ${idx + 1}`).trim();
        // Booking status
        let booking_status = "Unknown";
        if (p.booking?.details) {
            booking_status = p.booking.details;
        }
        else {
            const type = p.bookingStatus || p.status || p.booking_status || p.booking?.status;
            const num = p.bookingNumber || p.bookingNo || p.seatNumber || p.booking?.berthNo;
            booking_status = (0, exports.formatStatus)(type, num);
        }
        // Current status
        let current_status = "Unknown";
        if (p.current?.details) {
            current_status = p.current.details;
        }
        else {
            const type = p.currentStatus || p.currentNumber || p.seat || p.status || p.current?.status;
            const num = p.currentNumber || p.seat || p.seatNumber || p.current?.berthNo;
            current_status = (0, exports.formatStatus)(type, num);
        }
        return {
            name,
            booking_status,
            current_status
        };
    });
    return {
        pnr: String(pData.pnr || pData.PNR || pData.pnrNo || pData.pnrNumber || '').trim(),
        train_no,
        train_name,
        journey_date,
        source_code,
        source_name,
        destination_code,
        destination_name,
        boarding_station,
        chart_status,
        class: classVal,
        quota,
        passengers
    };
}
