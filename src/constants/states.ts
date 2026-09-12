// hostinger-node-app-repo/src/constants/states.ts
// Comprehensive list of 28 Indian States, 8 Union Territories, and International option

export const INDIAN_STATES: string[] = [
  'Andhra Pradesh',
  'Arunachal Pradesh',
  'Assam',
  'Bihar',
  'Chhattisgarh',
  'Goa',
  'Gujarat',
  'Haryana',
  'Himachal Pradesh',
  'Jharkhand',
  'Karnataka',
  'Kerala',
  'Madhya Pradesh',
  'Maharashtra',
  'Manipur',
  'Meghalaya',
  'Mizoram',
  'Nagaland',
  'Odisha',
  'Punjab',
  'Rajasthan',
  'Sikkim',
  'Tamil Nadu',
  'Telangana',
  'Tripura',
  'Uttar Pradesh',
  'Uttarakhand',
  'West Bengal'
];

export const UNION_TERRITORIES: string[] = [
  'Andaman and Nicobar Islands',
  'Chandigarh',
  'Dadra and Nagar Haveli and Daman and Diu',
  'Delhi (NCT)',
  'Jammu and Kashmir',
  'Ladakh',
  'Lakshadweep',
  'Puducherry'
];

export const OTHER_REGIONS: string[] = [
  'Other / Outside India'
];

export const ALL_REGIONS: string[] = [
  ...INDIAN_STATES,
  ...UNION_TERRITORIES,
  ...OTHER_REGIONS
];

const VALID_REGION_SET = new Set(ALL_REGIONS.map(s => s.toLowerCase()));

export function isValidRegion(region: string): boolean {
  if (!region || typeof region !== 'string') return false;
  return VALID_REGION_SET.has(region.trim().toLowerCase());
}

export function normalizeRegion(region: string): string | undefined {
  if (!region || typeof region !== 'string') return undefined;
  const match = ALL_REGIONS.find(s => s.toLowerCase() === region.trim().toLowerCase());
  return match || region.trim();
}
