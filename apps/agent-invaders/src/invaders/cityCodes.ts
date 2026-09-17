export const CITY_NAMES: Readonly<Record<string, string>> = {
  SPACE: "Space", BRL: "Berlin", FKF: "Frankfurt", KLN: "Köln", MUN: "Munich", MLB: "Melbourne",
  PRT: "Perth", WN: "Vienna", DHK: "Dhaka", ANVR: "Anvers", BXL: "Bruxelles", CHAR: "Charleroi",
  RDU: "Redu", BT: "Bhutan", POTI: "Potosi", GRU: "Grude", SP: "São Paulo", HK: "Hong Kong",
  DJN: "Daejeon", SL: "Seoul", BRC: "Barcelona", BBO: "Bilbao", MLGA: "Málaga", MEN: "Menorca",
  LA: "Los Angeles", MIA: "Miami", NY: "New York", SD: "San Diego", AIX: "Aix-en-Provence",
  AMI: "Amiens", AVI: "Avignon", BTA: "Bastia", BAB: "Biarritz-Anglet-Bayonne", CAPF: "Cap Ferret",
  CLR: "Clermont-Ferrand", CON: "Contis-Les-Bains", CAZ: "Côte d'Azur", DIJ: "Dijon",
  FTBL: "Fontainebleau", FRQ: "Forcalquier", GRN: "Grenoble", LCT: "La Ciotat", REUN: "La Réunion",
  LIL: "Lille", LBR: "Luberon", LY: "Lyon", MARS: "Marseille", MTB: "Montauban", MPL: "Montpellier",
  NA: "Nantes", NIM: "Nîmes", ORLN: "Orléans", PA: "Paris", PAU: "Pau", PRP: "Perpignan", RN: "Rennes",
  TLS: "Toulouse", VLMO: "Valmorel", VRS: "Versailles", LDN: "London", MAN: "Manchester",
  NCL: "Newcastle", VRN: "Varanasi", ELT: "Eilat", RA: "Ravenna", ROM: "Roma", TK: "Tokyo",
  MBSA: "Mombasa", MRAK: "Marrakech", RBA: "Rabat", CCU: "Cancún", KAT: "Katmandou", AMS: "Amsterdam",
  NOO: "Noordwijk", RTD: "Rotterdam", FAO: "Faro", LJU: "Ljubljana", HALM: "Halmstad", STK: "Stockholm",
  VSB: "Visby", ANZR: "Anzère", BSL: "Basel", BRN: "Bern", GNV: "Genève", LSN: "Lausanne",
  GRTI: "Grumeti", BGK: "Bangkok", DJBA: "Djerba", IST: "Istanbul",
};

export const PARIS_DISTRICT_CODES: readonly string[] = [
  "PA01", "PA02", "PA03", "PA04", "PA05", "PA06", "PA07", "PA08", "PA09", "PA10", "PA11", "PA12",
  "PA13", "PA14", "PA15", "PA16", "PA17", "PA18", "PA19", "PA20", "PA77", "PA92", "PA93", "PA94", "PA95",
];

export function cityNameFor(cityCode: string): string | null {
  return CITY_NAMES[cityCode] ?? null;
}

export function isKnownCityCode(cityCode: string): boolean {
  return cityCode in CITY_NAMES;
}

export function districtToCityCode(districtCode: string): string {
  return districtCode.replace(/\d+$/, "");
}

export function searchFormCodesFor(cityCode: string): readonly string[] {
  if (cityCode === "PA") return PARIS_DISTRICT_CODES;
  return [cityCode];
}

export function cityGlossary(cityCodes: Iterable<string>): string {
  const lines: string[] = [];
  for (const code of new Set(cityCodes)) {
    const name = cityNameFor(code);
    lines.push(name ? `${code} = ${name}` : `${code} = (unknown city; use the bare code)`);
  }
  return lines.join("\n");
}
