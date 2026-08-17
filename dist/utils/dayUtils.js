"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeRunningDays = normalizeRunningDays;
exports.isDayActive = isDayActive;
exports.binaryToDays = binaryToDays;
exports.isDayActiveForBoarding = isDayActiveForBoarding;
exports.isSpecialTrainNumber = isSpecialTrainNumber;
exports.trainOperatesOnDate = trainOperatesOnDate;
const logger_1 = require("../middleware/logger");
/**
 * Normalizes running_days string into a strict 7-length binary array [Sun, Mon, Tue, Wed, Thu, Fri, Sat]
 * 0 = Doesn't run on that day
 * 1 = Runs on that day
 */
function normalizeRunningDays(days) {
    if (!days || typeof days !== 'string' || days.trim() === '') {
        return null;
    }
    const input = days.toLowerCase().trim();
    const binary = new Array(7).fill(0); // [Sun, Mon, Tue, Wed, Thu, Fri, Sat]
    // 1. Daily / All days
    if (input === 'daily' ||
        input === 'all days' ||
        input === '0,1,2,3,4,5,6' ||
        input.includes('all')) {
        return [1, 1, 1, 1, 1, 1, 1];
    }
    // 2. Binary string format (1010101) — MUST run before numeric parsing so '0000001'
    // (Sunday only) is not parsed as single number 1 (Monday).
    const cleanInput = input.replace(/\s+/g, '').replace(/,/g, '');
    if (cleanInput.match(/^[01]{7}$/)) {
        const raw = cleanInput.split('').map(Number);
        // IRCTC gives [Mon, Tue, Wed, Thu, Fri, Sat, Sun]
        // We need [Sun, Mon, Tue, Wed, Thu, Fri, Sat]
        return [raw[6], raw[0], raw[1], raw[2], raw[3], raw[4], raw[5]];
    }
    // 3. Y/N format (YYNYNNN)
    if (cleanInput.match(/^[yn]{7}$/)) {
        const raw = cleanInput.split('').map(char => char === 'y' ? 1 : 0);
        // IRCTC gives [Mon, Tue, Wed, Thu, Fri, Sat, Sun]
        // We need [Sun, Mon, Tue, Wed, Thu, Fri, Sat]
        return [raw[6], raw[0], raw[1], raw[2], raw[3], raw[4], raw[5]];
    }
    // 4. Numeric format (0,1,2,3,4,5,6 or 1, 2, 3)
    const numericParts = input.includes(',') ? input.split(',').map(p => p.trim()) : (input.length === 1 ? [input] : []);
    let foundNumeric = false;
    for (const part of numericParts) {
        const num = parseInt(part, 10);
        if (!isNaN(num) && num >= 0 && num <= 6) {
            binary[num] = 1;
            foundNumeric = true;
        }
    }
    if (foundNumeric) {
        return binary;
    }
    // 5. Text format (Mon, Tue, Wed, Sun, etc.)
    const dayMap = {
        'sun': 0, 'sunday': 0,
        'mon': 1, 'monday': 1,
        'tue': 2, 'tuesday': 2,
        'wed': 3, 'wednesday': 3,
        'thu': 4, 'thursday': 4,
        'fri': 5, 'friday': 5,
        'sat': 6, 'saturday': 6
    };
    let foundText = false;
    const textParts = input.split(/[,\s]+/).map(p => p.trim());
    for (const part of textParts) {
        if (!part)
            continue;
        for (const [key, index] of Object.entries(dayMap)) {
            if (part.includes(key)) {
                binary[index] = 1;
                foundText = true;
                break;
            }
        }
    }
    if (foundText)
        return binary;
    return null;
}
/**
 * Checks if a train runs on a specific date based on its normalized binary running days
 * @param binary - 7-length array from normalizeRunningDays()
 * @param dateStr - Date string in YYYY-MM-DD or DD-MM-YYYY format
 * @returns boolean - true if train runs on that day
 */
function isDayActive(binary, dateStr) {
    if (!binary || binary.length !== 7)
        return false;
    if (!dateStr || dateStr.trim() === '')
        return true; // no date = assume runs
    try {
        let cleanDateStr = dateStr.trim();
        if (/^\d{8}$/.test(cleanDateStr)) {
            // YYYYMMDD format
            cleanDateStr = `${cleanDateStr.slice(0, 4)}-${cleanDateStr.slice(4, 6)}-${cleanDateStr.slice(6, 8)}`;
        }
        else if (cleanDateStr.includes('-')) {
            const parts = cleanDateStr.split('-').map(p => p.trim());
            if (parts[0].length !== 4) {
                // DD-MM-YYYY format
                cleanDateStr = `${parts[2]}-${parts[1]}-${parts[0]}`;
            }
        }
        // Append T00:00:00.000Z to force UTC parsing in all environments
        if (!cleanDateStr.includes('T')) {
            cleanDateStr += 'T00:00:00.000Z';
        }
        const date = new Date(cleanDateStr);
        if (isNaN(date.getTime())) {
            logger_1.winstonLogger?.warn?.(`[DAY_UTILS] Invalid date: ${dateStr}`);
            return false;
        }
        const weekday = date.getUTCDay(); // 0 = Sunday, 1 = Monday, ..., 6 = Saturday
        return binary[weekday] === 1;
    }
    catch (err) {
        logger_1.winstonLogger?.error?.(`[DAY_UTILS] Error parsing date ${dateStr}: ${err}`);
        return false;
    }
}
/**
 * Helper: Get human readable days from binary array
 * Useful for logging/debugging
 */
function binaryToDays(binary) {
    if (!binary || binary.length !== 7)
        return 'Unknown';
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const activeDays = binary
        .map((runs, i) => runs ? dayNames[i] : null)
        .filter(Boolean);
    if (activeDays.length === 7)
        return 'Daily';
    if (activeDays.length === 0)
        return 'No days';
    return activeDays.join(', ');
}
/**
 * Checks if a train runs on a specific boarding date by factoring in the day offset
 * from its origin departure.
 */
function isDayActiveForBoarding(binary, boardingDateStr, dayOffset = 0) {
    if (!binary || binary.length !== 7)
        return false;
    if (!boardingDateStr || boardingDateStr.trim() === '')
        return true; // no date = assume runs
    try {
        let cleanDateStr = boardingDateStr.trim();
        if (/^\d{8}$/.test(cleanDateStr)) {
            // YYYYMMDD format
            cleanDateStr = `${cleanDateStr.slice(0, 4)}-${cleanDateStr.slice(4, 6)}-${cleanDateStr.slice(6, 8)}`;
        }
        else if (cleanDateStr.includes('-')) {
            const parts = cleanDateStr.split('-').map(p => p.trim());
            if (parts[0].length !== 4) {
                // DD-MM-YYYY format
                cleanDateStr = `${parts[2]}-${parts[1]}-${parts[0]}`;
            }
        }
        if (!cleanDateStr.includes('T')) {
            cleanDateStr += 'T00:00:00.000Z';
        }
        const boardDate = new Date(cleanDateStr);
        if (isNaN(boardDate.getTime())) {
            logger_1.winstonLogger?.warn?.(`[DAY_UTILS] Invalid boarding date: ${boardingDateStr}`);
            return false;
        }
        // Subtract dayOffset to find the Origin departure date
        const originDate = new Date(boardDate.getTime() - dayOffset * 24 * 60 * 60 * 1000);
        const originWeekday = originDate.getUTCDay();
        return binary[originWeekday] === 1;
    }
    catch (err) {
        logger_1.winstonLogger?.error?.(`[DAY_UTILS] Error parsing boarding date ${boardingDateStr}: ${err}`);
        return false;
    }
}
function isSpecialTrainNumber(trainNo) {
    return /^09\d{3}$/.test(String(trainNo || '').trim());
}
function toUtcIsoDate(value) {
    if (!value || typeof value !== 'string')
        return null;
    let s = value.trim();
    if (!s)
        return null;
    if (/^\d{8}$/.test(s)) {
        s = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
    }
    else if (/^\d{2}-\d{2}-\d{4}$/.test(s)) {
        const [dd, mm, yyyy] = s.split('-');
        s = `${yyyy}-${mm}-${dd}`;
    }
    if (!/^\d{4}-\d{2}-\d{2}/.test(s))
        return null;
    const iso = s.slice(0, 10);
    const date = new Date(`${iso}T00:00:00.000Z`);
    return Number.isNaN(date.getTime()) ? null : iso;
}
function shiftIsoDate(iso, days) {
    const d = new Date(`${iso}T00:00:00.000Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().split('T')[0];
}
function trainOperatesOnDate(serviceDate, runningDays, options = {}) {
    const dateIso = toUtcIsoDate(serviceDate);
    if (!dateIso)
        return 'UNKNOWN';
    const dayOffset = Number.isInteger(options.dayOffset) && (options.dayOffset || 0) > 0
        ? options.dayOffset
        : 0;
    const effectiveIso = dayOffset > 0 ? shiftIsoDate(dateIso, -dayOffset) : dateIso;
    const windowFrom = toUtcIsoDate(options.validFrom);
    const windowTo = toUtcIsoDate(options.validTo);
    // Authoritative service window: the train operates only within [from, to].
    if (windowFrom && windowTo && (effectiveIso < windowFrom || effectiveIso > windowTo)) {
        return 'NO';
    }
    const rd = String(runningDays || '').trim();
    if (!rd)
        return 'UNKNOWN';
    const lower = rd.toLowerCase();
    const isDailyPlaceholder = lower === 'daily' ||
        lower === 'all days' ||
        lower === '0,1,2,3,4,5,6' ||
        lower === '1111111' ||
        lower.includes('all');
    if (isDailyPlaceholder && options.runningDaysAuthoritative === false) {
        // A window already authorises the date when present; otherwise a stale
        // 'Daily' / all-days placeholder proves nothing and must not become YES.
        return windowFrom && windowTo ? 'YES' : 'UNKNOWN';
    }
    const binary = normalizeRunningDays(rd);
    if (!binary) {
        return windowFrom && windowTo ? 'YES' : 'UNKNOWN';
    }
    return isDayActiveForBoarding(binary, dateIso, dayOffset) ? 'YES' : 'NO';
}
