import dotenv from 'dotenv';
dotenv.config();

import { supabase } from './config/supabase';
import { stationService } from './services/stationService';
import { segmentAvailabilityEngine } from './services/segmentAvailabilityEngine';
import { rankingService } from './services/rankingService';

const ROUTES = [
  { from: 'CSMT', to: 'SUR', name: 'Mumbai → Solapur' },
  { from: 'CSMT', to: 'HYB', name: 'Mumbai → Hyderabad' },
  { from: 'CSMT', to: 'MAS', name: 'Mumbai → Chennai' },
  { from: 'CSMT', to: 'NGP', name: 'Mumbai → Nagpur' },
  { from: 'NDLS', to: 'HWH', name: 'Delhi → Kolkata' }
];

async function run() {
  console.log('=== REAL ROUTE VERIFICATION ===');
  
  for (const route of ROUTES) {
    console.log(`\nChecking Route: ${route.name} (${route.from} → ${route.to})`);
    
    // Check coordinates resolution
    const fromCoords = await stationService.getCoordinates(route.from);
    const toCoords = await stationService.getCoordinates(route.to);
    console.log(`- Coordinates: ${route.from}=${fromCoords ? 'OK' : 'MISSING'}, ${route.to}=${toCoords ? 'OK' : 'MISSING'}`);

    // Query direct trains from database
    const { data: scheduleData, error } = await supabase
      .from('train_schedule')
      .select('Train_No, Station_Code, SN')
      .in('Station_Code', [route.from, route.to]);

    if (error) {
      console.error(`- DB Query failed:`, error.message);
      continue;
    }

    // Group stops by train number
    const trainStopsMap = new Map<string, { fromSn?: number; toSn?: number }>();
    scheduleData?.forEach(row => {
      const train = row.Train_No;
      if (!trainStopsMap.has(train)) {
        trainStopsMap.set(train, {});
      }
      const stops = trainStopsMap.get(train)!;
      if (row.Station_Code === route.from) stops.fromSn = row.SN;
      if (row.Station_Code === route.to) stops.toSn = row.SN;
    });

    const directTrains: string[] = [];
    for (const [train, stops] of trainStopsMap.entries()) {
      if (stops.fromSn !== undefined && stops.toSn !== undefined && stops.fromSn < stops.toSn) {
        directTrains.push(train);
      }
    }

    console.log(`- Direct Trains found in DB:`, directTrains);

    // Let's print intermediate stops and hubs for one of the trains
    if (directTrains.length > 0) {
      const trainNo = directTrains[0];
      const { data: routeStops } = await supabase
        .from('train_schedule')
        .select('Station_Code, SN, Station_Name')
        .eq('Train_No', trainNo)
        .order('SN', { ascending: true });

      const fromStop = routeStops?.find(s => s.Station_Code === route.from);
      const toStop = routeStops?.find(s => s.Station_Code === route.to);
      if (fromStop && toStop) {
        const intermediate = routeStops?.filter(s => s.SN > fromStop.SN && s.SN < toStop.SN) || [];
        console.log(`  Train ${trainNo} total intermediate stops: ${intermediate.length}`);
        console.log(`  Stops:`, intermediate.map(s => s.Station_Code).join(' → '));
        
        // Find major hubs
        const { segmentAvailabilityEngine } = require('./services/segmentAvailabilityEngine');
        const hubsWithStops = await (segmentAvailabilityEngine as any).getMidpointHubs(trainNo, route.from, route.to);
        console.log(`  Midpoint hubs selected (top 2):`, hubsWithStops.map((h: any) => h.hub));
      }
    }
  }
}

run().catch(console.error);
