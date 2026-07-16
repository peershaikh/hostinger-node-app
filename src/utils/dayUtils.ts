import { winstonLogger } from '../middleware/logger';

/**
 * Normalizes running_days string into a strict 7-length binary array [Sun, Mon, Tue, Wed, Thu, Fri, Sat]
 * 0 = Doesn't run on that day
 * 1 = Runs on that day
 */
export function normalizeRunningDays(days: string | null | undefined): number[] | null {
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

  // 2. Numeric format (0,1,2,3,4,5,6)
  const numericParts = input.split(',').map(p => p.trim());
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

  // 3. Text format (Mon, Tue, Wed, Sun, etc.)
  const dayMap: Record<string, number> = {
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
    if (!part) continue;

    for (const [key, index] of Object.entries(dayMap)) {
      if (part.includes(key)) {
        binary[index] = 1;
        foundText = true;
        break;
      }
    }
  }

  if (foundText) return binary;

  // 4. Binary string format (1010101)
  const cleanInput = input.replace(/\s+/g, '').replace(/,/g, '');
  if (cleanInput.match(/^[01]{7}$/)) {
    const raw = cleanInput.split('').map(Number);
    // IRCTC gives [Mon, Tue, Wed, Thu, Fri, Sat, Sun]
    // We need [Sun, Mon, Tue, Wed, Thu, Fri, Sat]
    return [raw[6], raw[0], raw[1], raw[2], raw[3], raw[4], raw[5]];
  }

  // 5. Y/N format (YYNYNNN)
  if (cleanInput.match(/^[yn]{7}$/)) {
    const raw = cleanInput.split('').map(char => char === 'y' ? 1 : 0);
    // IRCTC gives [Mon, Tue, Wed, Thu, Fri, Sat, Sun]
    // We need [Sun, Mon, Tue, Wed, Thu, Fri, Sat]
    return [raw[6], raw[0], raw[1], raw[2], raw[3], raw[4], raw[5]];
  }

  return null;
}

/**
 * Checks if a train runs on a specific date based on its normalized binary running days
 * @param binary - 7-length array from normalizeRunningDays()
 * @param dateStr - Date string in YYYY-MM-DD or DD-MM-YYYY format
 * @returns boolean - true if train runs on that day
 */
export function isDayActive(binary: number[] | null | undefined, dateStr: string | null | undefined): boolean {
  if (!binary || binary.length !== 7) return false;
  if (!dateStr || dateStr.trim() === '') return true; // no date = assume runs

  try {
    let cleanDateStr = dateStr.trim();
    if (/^\d{8}$/.test(cleanDateStr)) {
      // YYYYMMDD format
      cleanDateStr = `${cleanDateStr.slice(0, 4)}-${cleanDateStr.slice(4, 6)}-${cleanDateStr.slice(6, 8)}`;
    } else if (cleanDateStr.includes('-')) {
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
      winstonLogger?.warn?.(`[DAY_UTILS] Invalid date: ${dateStr}`);
      return false;
    }

    const weekday = date.getUTCDay(); // 0 = Sunday, 1 = Monday, ..., 6 = Saturday
    return binary[weekday] === 1;

  } catch (err) {
    winstonLogger?.error?.(`[DAY_UTILS] Error parsing date ${dateStr}: ${err}`);
    return false;
  }
}

/**
 * Helper: Get human readable days from binary array
 * Useful for logging/debugging
 */
export function binaryToDays(binary: number[] | null): string {
  if (!binary || binary.length !== 7) return 'Unknown';

  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const activeDays = binary
    .map((runs, i) => runs ? dayNames[i] : null)
    .filter(Boolean) as string[];

  if (activeDays.length === 7) return 'Daily';
  if (activeDays.length === 0) return 'No days';

  return activeDays.join(', ');
}

/**
 * Checks if a train runs on a specific boarding date by factoring in the day offset
 * from its origin departure.
 */
export function isDayActiveForBoarding(binary: number[] | null | undefined, boardingDateStr: string | null | undefined, dayOffset: number = 0): boolean {
  if (!binary || binary.length !== 7) return false;
  if (!boardingDateStr || boardingDateStr.trim() === '') return true; // no date = assume runs

  try {
    let cleanDateStr = boardingDateStr.trim();
    if (/^\d{8}$/.test(cleanDateStr)) {
      // YYYYMMDD format
      cleanDateStr = `${cleanDateStr.slice(0, 4)}-${cleanDateStr.slice(4, 6)}-${cleanDateStr.slice(6, 8)}`;
    } else if (cleanDateStr.includes('-')) {
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
      winstonLogger?.warn?.(`[DAY_UTILS] Invalid boarding date: ${boardingDateStr}`);
      return false;
    }

    // Subtract dayOffset to find the Origin departure date
    const originDate = new Date(boardDate.getTime() - dayOffset * 24 * 60 * 60 * 1000);
    const originWeekday = originDate.getUTCDay();

    return binary[originWeekday] === 1;

  } catch (err) {
    winstonLogger?.error?.(`[DAY_UTILS] Error parsing boarding date ${boardingDateStr}: ${err}`);
    return false;
  }
}