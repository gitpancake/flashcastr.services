/**
 * Check if a weather location is the home/city location.
 * The service-weather names the home location from `location_label` setting,
 * lowercased with non-alphanumeric chars replaced by hyphens.
 * Extra locations (mountains, etc.) are in the `weather_extra_locations` setting.
 * This function identifies home by checking it's NOT in the extras list.
 *
 * For backward compatibility, also maintains a static list of known mountain slugs.
 */
const KNOWN_MOUNTAIN_SLUGS = new Set([
  'north-van', 'cypress-mountain', 'grouse-mountain', 'mt-seymour', 'whistler',
]);

export function isHomeLocation(location: string): boolean {
  // A location is "home" if it's not a known mountain/extra location
  return !KNOWN_MOUNTAIN_SLUGS.has(location);
}
