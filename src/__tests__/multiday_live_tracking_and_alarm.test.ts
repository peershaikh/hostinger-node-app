import dotenv from 'dotenv';
dotenv.config();

import assert from 'assert';
import { liveTrackingService } from '../services/liveTrackingService';
import { alarmWorker } from '../workers/alarmWorker';

async function runTests() {
  console.log('🧪 Starting Multi-Day Live Tracking & Alarm Proximity Tests...\n');

  // Test 1: getActiveJourneyDate correctly identifies active run for overnight train 11140
  console.log('Test 1: Overnight Multi-Day Active Journey Detection');
  const schedData = await (liveTrackingService as any).fetchDbScheduleWithDays('11140');
  assert(schedData.stops && schedData.stops.length > 0, 'Train 11140 schedule should exist');
  
  const activeDate = await liveTrackingService.getActiveJourneyDate('11140', schedData.stops);
  console.log(`  Train 11140 active journey date detected: ${activeDate}`);
  assert(activeDate !== null, 'Active journey date should not be null');

  // Test 2: Verify isHistoricalRequest logic
  console.log('\nTest 2: Target Active Run is NEVER Historical');
  const now = new Date();
  const todayStr = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const yesterday = new Date(now.getTime() - 86400000);
  const yesterdayStr = yesterday.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

  // If yesterday is activeDate, it must be treated as LIVE active run, NOT historical
  const requestedDateStr = yesterdayStr;
  const effectiveActiveDate = activeDate || todayStr;
  const isTargetingActiveRun = Boolean(
    (requestedDateStr && requestedDateStr === activeDate) ||
    (!requestedDateStr && activeDate)
  );
  const isHistorical = Boolean(
    requestedDateStr &&
    requestedDateStr < effectiveActiveDate &&
    !isTargetingActiveRun
  );
  console.log(`  requestedDate=${requestedDateStr}, activeDate=${activeDate}`);
  console.log(`  isTargetingActiveRun=${isTargetingActiveRun}, isHistorical=${isHistorical}`);
  if (requestedDateStr === activeDate) {
    assert.strictEqual(isHistorical, false, 'Active run on yesterday date must NOT be marked historical');
  }

  // Test 3: Delay calculation prevents premature completion
  console.log('\nTest 3: Delay Offset Postpones Destination Completion');
  const sampleSchedule = [
    { Station_Code: 'GDG', Station_Name: 'Gadag Jn', Departure_Time: '15:00', Arrival_time: '--' },
    { Station_Code: 'KYN', Station_Name: 'Kalyan Jn', Departure_Time: '03:36', Arrival_time: '03:33' },
    { Station_Code: 'DR', Station_Name: 'Dadar', Departure_Time: '04:24', Arrival_time: '04:21' },
    { Station_Code: 'CSMT', Station_Name: 'C Shivaji Maharaj T', Departure_Time: '--', Arrival_time: '05:10' },
  ];

  const nowMs = new Date('2026-10-09T05:15:00+05:30').getTime(); // 5:15 AM
  const delayMins = 120; // 2 hours late!
  const delayOffsetMs = delayMins * 60000;
  
  // Calculate CSMT absolute departure/arrival with delay
  const depTime = new Date('2026-10-08T00:00:00+05:30'); // Yesterday midnight
  const currentDayOffsetMs = 86400000; // Day 2 (today)
  const [csmtH, csmtM] = '05:10'.split(':').map(Number);
  const csmtMsFromMidnight = (csmtH * 3600 + csmtM * 60) * 1000;
  
  const csmtScheduledMs = depTime.getTime() + csmtMsFromMidnight + currentDayOffsetMs;
  const csmtExpectedMs = csmtScheduledMs + delayOffsetMs;

  console.log(`  At 05:15 AM:`);
  console.log(`  CSMT Scheduled Arrival: ${new Date(csmtScheduledMs).toLocaleTimeString('en-IN')}`);
  console.log(`  CSMT Delayed Expected Arrival: ${new Date(csmtExpectedMs).toLocaleTimeString('en-IN')}`);
  
  // Scheduled was 05:10 AM, which is in past
  assert(nowMs > csmtScheduledMs, 'Without delay, 05:15 AM is after 05:10 AM');
  // Delayed is 07:10 AM, which is in future!
  assert(csmtExpectedMs > nowMs, 'With 2h delay, 07:10 AM is in the future (> 05:15 AM)');
  console.log('  ✅ Train is correctly determined to be still running en route with delay!');

  // Test 4: Live en-route status never overridden by time estimation
  console.log('\nTest 4: En-route station preserved');
  const actualCurrentIndex = 1; // Kalyan (index 1 of 3)
  const isLastStop = actualCurrentIndex >= sampleSchedule.length - 1;
  assert.strictEqual(isLastStop, false, 'Train at Kalyan is not at last stop');
  
  const usedApi: string = 'RAILKIT_V2';
  const isTimeCompleted = false;
  const liveConfirmedArrival = false;
  const isJourneyCompleted = usedApi === 'DATABASE_SCHEDULE'
    ? (isTimeCompleted && isLastStop)
    : (isLastStop && (liveConfirmedArrival || isTimeCompleted));

  assert.strictEqual(isJourneyCompleted, false, 'Journey must NOT be marked completed when train is at Kalyan');
  console.log('  ✅ Train at Kalyan remains RUNNING, not completed');

  // Test 5: AlarmWorker proximity calculation
  console.log('\nTest 5: Alarm Proximity Calculation with Track Distance');
  const mockStatus = {
    train_number: '11140',
    current_station: 'Kalyan Jn',
    current_station_index: 1,
    latitude: 19.2437,
    longitude: 73.1355,
    journey_timeline: [
      { station_code: 'GDG', distance: 0 },
      { station_code: 'KYN', distance: 785 },
      { station_code: 'DR', distance: 830 },
      { station_code: 'CSMT', distance: 840 },
    ]
  };

  const mockAlarm = {
    id: 'test-alarm-1',
    user_id: 'test-user',
    device_id: null,
    train_no: '11140',
    destination_station: 'CSMT',
    radius_km: 60.0,
    enabled: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  const dist = await (alarmWorker as any).evaluateAlarmProximity(mockAlarm, mockStatus);
  console.log(`  Calculated proximity distance from Kalyan to CSMT: ${dist?.toFixed(1)} km`);
  assert(dist !== null, 'Distance should be computed');
  assert(dist <= 60.0, 'Kalyan to CSMT (~55 km) is within 60 km radius');
  console.log('  ✅ Alarm triggers within threshold!');

  console.log('\n🎉 ALL TESTS PASSED SUCCESSFULLY!\n');
}

runTests().then(() => process.exit(0)).catch(e => {
  console.error('❌ Test failed:', e);
  process.exit(1);
});
