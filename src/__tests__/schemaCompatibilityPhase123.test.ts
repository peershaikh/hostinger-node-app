import { stationService } from '../services/stationService';
import { dbService } from '../services/dbService';
import { userRepository } from '../repositories/userRepository';

async function runTests() {
  console.log('\n=== RUNNING TARGETED SCHEMA COMPATIBILITY VERIFICATION TESTS ===\n');
  let passed = 0;
  let failed = 0;

  function assert(name: string, condition: boolean, details?: any) {
    if (condition) {
      console.log(`✅ PASS: ${name}`);
      passed++;
    } else {
      console.error(`❌ FAIL: ${name}`, details || '');
      failed++;
    }
  }

  // TEST 1: stationService.getCoordinatesSync
  try {
    const coordsNdls = stationService.getCoordinatesSync('NDLS');
    assert('stationService.getCoordinatesSync resolves NDLS', !!coordsNdls && coordsNdls.lat > 0 && coordsNdls.lon > 0, coordsNdls);
    
    const coordsHwh = stationService.getCoordinatesSync('HWH');
    assert('stationService.getCoordinatesSync resolves HWH', !!coordsHwh && coordsHwh.lat > 0 && coordsHwh.lon > 0, coordsHwh);

    const coordsCsmt = stationService.getCoordinatesSync('CSMT');
    assert('stationService.getCoordinatesSync resolves CSMT (alias/known)', !!coordsCsmt && coordsCsmt.lat > 0 && coordsCsmt.lon > 0, coordsCsmt);
  } catch (err: any) {
    assert('stationService.getCoordinatesSync executed without error', false, err.message);
  }

  // TEST 2: stationService.getNearbyStations (In-memory, zero DB 42703 error)
  try {
    const nearbyNdls = await stationService.getNearbyStations('NDLS', 50);
    assert('stationService.getNearbyStations returns array', Array.isArray(nearbyNdls));
    assert('stationService.getNearbyStations finds nearby stations for NDLS', nearbyNdls.length > 0, nearbyNdls);
    if (nearbyNdls.length > 0) {
      const first = nearbyNdls[0];
      assert('nearby station has station_code', typeof first.station_code === 'string');
      assert('nearby station has station_name', typeof first.station_name === 'string');
      assert('nearby station has distance_km <= 50', typeof first.distance_km === 'number' && first.distance_km <= 50);
      assert('nearby station has tag Nearby Station', first.tag === 'Nearby Station');
      console.log('Sample nearby stations for NDLS:', nearbyNdls);
    }
  } catch (err: any) {
    assert('stationService.getNearbyStations executed without error', false, err.message);
  }

  // TEST 3: userRepository.findById and findByEmail with maybeSingle
  try {
    const randomUuid = '00000000-0000-0000-0000-000000000000';
    const userById = await userRepository.findById(randomUuid);
    assert('userRepository.findById returns null cleanly for non-existent UUID (no PGRST116 throw)', userById === null);

    const userByEmail = await userRepository.findByEmail('nonexistent-canary-test@trayago.in');
    assert('userRepository.findByEmail returns null cleanly for non-existent email (no PGRST116 throw)', userByEmail === null);
  } catch (err: any) {
    assert('userRepository lookups handle missing rows without unhandled error', false, err.message);
  }

  // TEST 4: dbService train lookup
  try {
    const trainName = await dbService.dbLookupTrainName('12301');
    assert('dbService.dbLookupTrainName executes without SQL 42703 error', true, { trainName });
  } catch (err: any) {
    assert('dbService.dbLookupTrainName executed without error', false, err.message);
  }

  console.log(`\n==================================================`);
  console.log(`SUMMARY: ${passed} passed, ${failed} failed`);
  console.log(`==================================================\n`);

  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
