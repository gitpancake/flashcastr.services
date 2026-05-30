/**
 * Space Invader city code → full city name mapping.
 * Source: invader-spotter.art invasion data.
 */
export const CITY_CODES: Record<string, string> = {
  // France
  PA: 'Paris',
  FTBL: 'Fontainebleau',
  VRS: 'Versailles',
  MTP: 'Montpellier',
  CLF: 'Clermont-Ferrand',
  LY: 'Lyon',
  MRS: 'Marseille',
  BDX: 'Bordeaux',
  AVI: 'Avignon',
  STR: 'Strasbourg',
  TLS: 'Toulouse',
  RNS: 'Rennes',
  BIL: 'Bilbao',
  NTE: 'Nantes',

  // Europe
  LDN: 'London',
  AMS: 'Amsterdam',
  ROM: 'Rome',
  MLN: 'Milan',
  FL: 'Florence',
  BCN: 'Barcelona',
  MAD: 'Madrid',
  BRN: 'Bern',
  BSL: 'Basel',
  PRG: 'Prague',
  VNC: 'Venice',
  BRS: 'Brussels',
  VIE: 'Vienna',
  CPH: 'Copenhagen',
  OSL: 'Oslo',
  STK: 'Stockholm',
  IST: 'Istanbul',
  ATH: 'Athens',

  // Americas
  NY: 'New York',
  LA: 'Los Angeles',
  MIA: 'Miami',
  SF: 'San Francisco',
  HOL: 'Hollywood',
  SD: 'San Diego',
  NAS: 'Nashville',
  ATX: 'Austin',
  SEA: 'Seattle',
  CHI: 'Chicago',
  BOS: 'Boston',
  DC: 'Washington DC',
  SP: 'São Paulo',
  RDJ: 'Rio de Janeiro',
  BA: 'Buenos Aires',
  MEX: 'Mexico City',
  BOG: 'Bogotá',

  // Asia
  TK: 'Tokyo',
  HK: 'Hong Kong',
  BKK: 'Bangkok',
  KTM: 'Kathmandu',
  NP: 'Nepal',
  DHA: 'Dhaka',
  JAK: 'Jakarta',
  KUL: 'Kuala Lumpur',
  TPE: 'Taipei',
  SEL: 'Seoul',

  // Other
  RAV: 'Ravenna',
  MAR: 'Marrakech',
  DJB: 'Djerba',
  MBT: 'Mombasa',
  NBO: 'Nairobi',
  LIB: 'Libreville',
  MLH: 'Mulhouse',
};

/**
 * Resolve a city code to its full name.
 * Returns the code itself if not found (unknown invasion site).
 */
export function resolveCityName(code: string): string {
  return CITY_CODES[code] ?? code;
}
