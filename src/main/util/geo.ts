// Works out which country a free-text location is in, so a preference like "United States"
// matches a job in "Austin, TX". Covers US states, Canadian provinces, common countries and
// large cities. Anything it doesn't recognize returns null and is left to the text match.

const US_STATES: Record<string, string> = {
  AL: 'alabama', AK: 'alaska', AZ: 'arizona', AR: 'arkansas', CA: 'california', CO: 'colorado', CT: 'connecticut',
  DE: 'delaware', FL: 'florida', GA: 'georgia', HI: 'hawaii', ID: 'idaho', IL: 'illinois', IN: 'indiana', IA: 'iowa',
  KS: 'kansas', KY: 'kentucky', LA: 'louisiana', ME: 'maine', MD: 'maryland', MA: 'massachusetts', MI: 'michigan',
  MN: 'minnesota', MS: 'mississippi', MO: 'missouri', MT: 'montana', NE: 'nebraska', NV: 'nevada', NH: 'new hampshire',
  NJ: 'new jersey', NM: 'new mexico', NY: 'new york', NC: 'north carolina', ND: 'north dakota', OH: 'ohio', OK: 'oklahoma',
  OR: 'oregon', PA: 'pennsylvania', RI: 'rhode island', SC: 'south carolina', SD: 'south dakota', TN: 'tennessee',
  TX: 'texas', UT: 'utah', VT: 'vermont', VA: 'virginia', WA: 'washington', WV: 'west virginia', WI: 'wisconsin',
  WY: 'wyoming', DC: 'district of columbia'
}

const CA_PROVINCES: Record<string, string> = {
  AB: 'alberta', BC: 'british columbia', MB: 'manitoba', NB: 'new brunswick', NL: 'newfoundland', NS: 'nova scotia',
  ON: 'ontario', PE: 'prince edward island', QC: 'quebec', SK: 'saskatchewan', YT: 'yukon', NT: 'northwest territories', NU: 'nunavut'
}

const COUNTRIES: Array<{ country: string; pattern: RegExp }> = [
  { country: 'United States', pattern: /\b(united states|u\.s\.a?\.?|usa|us|america|nyc|san francisco|bay area|silicon valley|seattle|boston|chicago|los angeles|austin|denver|atlanta|miami|philadelphia|portland|san diego|san jose|washington,? d\.?c\.?)\b/i },
  { country: 'Canada', pattern: /\b(canada|toronto|vancouver|montreal|ottawa|calgary|edmonton|waterloo)\b/i },
  { country: 'United Kingdom', pattern: /\b(united kingdom|u\.?k\.?|great britain|britain|england|scotland|wales|northern ireland|london|manchester|edinburgh|bristol|cambridge,? uk|oxford)\b/i },
  { country: 'Ireland', pattern: /\b(ireland|dublin|cork)\b/i },
  { country: 'Germany', pattern: /\b(germany|deutschland|berlin|munich|münchen|hamburg|frankfurt|cologne)\b/i },
  { country: 'France', pattern: /\b(france|paris|lyon)\b/i },
  { country: 'Netherlands', pattern: /\b(netherlands|holland|amsterdam|rotterdam|utrecht)\b/i },
  { country: 'Spain', pattern: /\b(spain|madrid|barcelona)\b/i },
  { country: 'Portugal', pattern: /\b(portugal|lisbon|porto)\b/i },
  { country: 'Poland', pattern: /\b(poland|warsaw|krak[oó]w)\b/i },
  { country: 'Sweden', pattern: /\b(sweden|stockholm)\b/i },
  { country: 'Switzerland', pattern: /\b(switzerland|zurich|zürich|geneva)\b/i },
  { country: 'Israel', pattern: /\b(israel|tel aviv|jerusalem|haifa)\b/i },
  { country: 'India', pattern: /\b(india|bangalore|bengaluru|mumbai|hyderabad|pune|delhi|chennai|gurgaon|noida)\b/i },
  { country: 'Singapore', pattern: /\bsingapore\b/i },
  { country: 'Japan', pattern: /\b(japan|tokyo)\b/i },
  { country: 'Australia', pattern: /\b(australia|sydney|melbourne|brisbane|perth)\b/i },
  { country: 'New Zealand', pattern: /\b(new zealand|auckland|wellington)\b/i },
  { country: 'Brazil', pattern: /\b(brazil|brasil|são paulo|sao paulo)\b/i },
  { country: 'Mexico', pattern: /\b(mexico|méxico|mexico city|guadalajara)\b/i }
]

const US_CODE = new RegExp(`,\\s*(${Object.keys(US_STATES).join('|')})\\b`)
const CA_CODE = new RegExp(`,\\s*(${Object.keys(CA_PROVINCES).join('|')})\\b`)
const US_NAME = new RegExp(`\\b(${Object.values(US_STATES).join('|')})\\b`, 'i')
const CA_NAME = new RegExp(`\\b(${Object.values(CA_PROVINCES).join('|')})\\b`, 'i')

/** The country a location is in, or null when it can't tell. */
export function countryOf(location: string): string | null {
  const text = location.trim()
  if (!text) return null
  // Country words win over state names ("Georgia" the country is rare in job posts, so US wins below).
  for (const { country, pattern } of COUNTRIES) {
    if (country !== 'United States' && pattern.test(text)) {
      // "Cambridge, MA" and "London, ON" are North American, not British.
      if (country === 'United Kingdom' && (US_CODE.test(text) || CA_CODE.test(text))) continue
      return country
    }
  }
  if (CA_CODE.test(text) || CA_NAME.test(text)) return 'Canada'
  if (US_CODE.test(text) || US_NAME.test(text)) return 'United States'
  if (COUNTRIES[0].pattern.test(text)) return 'United States'
  return null
}

/** True when both locations name the same country. */
export function sameCountry(a: string, b: string): boolean {
  const ca = countryOf(a)
  const cb = countryOf(b)
  return ca !== null && ca === cb
}

const COUNTRY_ALIASES = new Set([
  ...COUNTRIES.map((c) => c.country.toLowerCase()),
  'us', 'usa', 'u.s.', 'u.s.a.', 'america', 'the united states', 'uk', 'u.k.', 'great britain', 'britain', 'the netherlands', 'holland', 'deutschland'
])

/** True when the text names a whole country rather than a city or region. */
export function isCountryName(text: string): boolean {
  return COUNTRY_ALIASES.has(text.trim().toLowerCase())
}

/** Two-letter US state or Canadian province code for a location, or null. */
export function regionOf(location: string): string | null {
  const code = location.match(US_CODE)?.[1] ?? location.match(CA_CODE)?.[1]
  if (code) return code
  const lower = location.toLowerCase()
  for (const [c, name] of [...Object.entries(US_STATES), ...Object.entries(CA_PROVINCES)]) {
    if (new RegExp(`\\b${name}\\b`).test(lower)) return c
  }
  return null
}
