import { countryOf } from '../util/geo'

// Country names that work authorization questions name. util/geo.ts knows the countries the job
// boards use most. This list adds the rest that forms ask about, so "Are you legally authorized to
// work in China?" is read as a question about China and not as one the app can't place.

const EXTRA: Array<[country: string, pattern: string]> = [
  ['China', "china|p\\.?r\\.?c\\.?|people'?s republic of china|mainland china|shanghai|beijing|shenzhen|guangzhou|chengdu"],
  ['Hong Kong', 'hong kong'],
  ['Taiwan', 'taiwan|taipei'],
  ['South Korea', 'south korea|republic of korea|korea|seoul'],
  ['Japan', 'japan|tokyo|osaka'],
  ['Singapore', 'singapore'],
  ['India', 'india'],
  ['Australia', 'australia'],
  ['New Zealand', 'new zealand'],
  ['Canada', 'canada'],
  ['Mexico', '(?<!new )mexico'],
  ['Brazil', 'brazil|brasil'],
  ['Argentina', 'argentina'],
  ['Chile', 'chile'],
  ['Colombia', 'colombia'],
  ['Ireland', '(?<!northern )ireland'],
  ['Germany', 'germany|deutschland'],
  ['France', 'france'],
  ['Netherlands', 'the netherlands|netherlands|holland'],
  ['Spain', 'spain'],
  ['Italy', 'italy'],
  ['Portugal', 'portugal'],
  ['Poland', 'poland'],
  ['Sweden', 'sweden'],
  ['Finland', 'finland'],
  ['Denmark', 'denmark'],
  ['Norway', 'norway'],
  ['Switzerland', 'switzerland'],
  ['Austria', 'austria'],
  ['Belgium', 'belgium|brussels'],
  ['Czech Republic', 'czech republic|czechia|prague'],
  ['Hungary', 'hungary|budapest'],
  ['Romania', 'romania|bucharest'],
  ['Greece', 'greece|athens'],
  ['Turkey', 'turkey|t[uü]rkiye|istanbul'],
  ['Ukraine', 'ukraine'],
  ['Russia', 'russia'],
  ['Estonia', 'estonia'],
  ['Lithuania', 'lithuania'],
  ['Latvia', 'latvia'],
  ['Israel', 'israel'],
  ['United Arab Emirates', 'united arab emirates|u\\.?a\\.?e\\.?|dubai|abu dhabi'],
  ['Saudi Arabia', 'saudi arabia'],
  ['Egypt', 'egypt'],
  ['South Africa', 'south africa'],
  ['Nigeria', 'nigeria'],
  ['Kenya', 'kenya'],
  ['Philippines', 'philippines'],
  ['Indonesia', 'indonesia'],
  ['Malaysia', 'malaysia'],
  ['Thailand', 'thailand'],
  ['Vietnam', 'vietnam|viet nam'],
  ['Pakistan', 'pakistan'],
  ['Bangladesh', 'bangladesh'],
  ['United Kingdom', 'united kingdom|u\\.?k\\.?|great britain|britain|england|scotland|wales|northern ireland'],
  ['United States', 'united states(?: of america)?|u\\.?s\\.?a\\.?']
]

const PATTERNS = EXTRA.map(([country, pattern]) => ({ country, re: new RegExp(`(?<![\\p{L}\\p{N}])(?:${pattern})(?![\\p{L}\\p{N}])`, 'iu') }))

/**
 * The country a label names, from the list above only. Null when it names none, or when it names
 * more than one, since a question about two countries has no single answer.
 */
export function extendedCountryIn(text: string): string | null {
  const unique = extendedCountriesIn(text)
  return unique.length === 1 ? unique[0] : null
}

function extendedCountriesIn(text: string): string[] {
  return [...new Set(PATTERNS.filter((p) => p.re.test(text)).map((p) => p.country))]
}

/** Every country a label names. More than one means the question has no single answer. */
export function namedCountries(label: string): string[] {
  const found = new Set(extendedCountriesIn(label))
  // Lowercase "us" in "work for us" isn't the country. "US" in capitals is.
  const geo = countryOf(label.replace(/\bus\b/g, ''))
  if (geo) found.add(geo)
  return [...found]
}

/** The country a label names, from util/geo.ts and the longer list. Null when it names none or several. */
export function namedCountry(label: string): string | null {
  const found = namedCountries(label)
  return found.length === 1 ? found[0] : null
}

/** A country as a comparable key: the same country in different spellings gives the same key. */
function countryKey(text: string): string {
  return (countryOf(text) ?? extendedCountryIn(text) ?? text).trim().toLowerCase()
}

/** True when two texts name the same country ("UK" and "United Kingdom", "Korea" and "South Korea"). */
export function sameCountryName(a: string, b: string): boolean {
  const x = countryKey(a)
  return x !== '' && x === countryKey(b)
}
