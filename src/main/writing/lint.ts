import type { LintIssue, LintReport, LintSeverity } from '@shared/types'
import { BANNED_PHRASES, BANNED_SENTENCE_STARTS, PATTERN_RULES } from './rules'

export interface LintOptions {
  /** Extra phrases from the user's settings. */
  extraBanned?: string[]
  /** Banned terms the posting or the profile uses in a plain sense, such as "harness" in "test harness". Not flagged. */
  allowedTerms?: string[]
  /** Expected length in words. Outside the range is flagged. */
  targetWords?: { min: number; max: number }
  /**
   * Holds the text against the posting and the profile. A text with a grounding issue keeps its score and is never
   * blocked, but is less grounded: it goes out below the auto-send confidence and its issues feed the revision notes.
   */
  grounding?: GroundingOptions
}

const WEIGHT: Record<LintSeverity, number> = { high: 12, medium: 5, low: 2 }

/**
 * Pattern rules that hold a text back whatever its score. A high-severity phrase blocks too.
 * A text with one of these is a tell that a recruiter spots at once, so it is revised or flagged.
 */
const BLOCKING_RULES: ReadonlySet<string> = new Set(['em-dash', 'not-x-but-y', 'its-not-x-its-y', 'placeholder', 'markdown', 'emoji', 'as-a-opener', 'the-result'])

/** True for an issue that keeps a text from passing, however high its score is. */
export function isBlockingIssue(issue: LintIssue): boolean {
  return issue.severity === 'high' || BLOCKING_RULES.has(issue.rule)
}

/**
 * A text clears the checks for a cover letter when it passes the style check and is grounded. A letter that does not is
 * held back: an optional upload is left empty, and a required upload or text box keeps the application in needs_attention.
 */
export function lettersCheckPasses(report: LintReport, minLintScore: number): boolean {
  return lintPasses(report, minLintScore) && groundingIssues(report).length === 0
}

/** The issues that block a text: high-severity phrases, dashes, contrast formulas, placeholders, markdown, emoji and stock openers. */
export function blockingIssues(report: LintReport): LintIssue[] {
  return report.issues.filter(isBlockingIssue)
}

/** A text passes when its score reaches the minimum and nothing blocks it. */
export function lintPasses(report: LintReport, minLintScore: number): boolean {
  return report.score >= minLintScore && blockingIssues(report).length === 0
}

/**
 * Whether a revision is at least as good as the text it would replace. Fewer blocking issues win. Then, when the
 * minimum score is known, the one that reaches it. Then fewer grounding issues, then the score.
 */
export function isBetterLint(candidate: LintReport, current: LintReport, minLintScore?: number): boolean {
  const a = blockingIssues(candidate).length
  const b = blockingIssues(current).length
  if (a !== b) return a < b
  if (minLintScore !== undefined) {
    const reaches = candidate.score >= minLintScore
    if (reaches !== current.score >= minLintScore) return reaches
  }
  const ga = groundingIssues(candidate).length
  const gb = groundingIssues(current).length
  if (ga !== gb) return ga < gb
  return candidate.score >= current.score
}

/** The issue to name first when a text is held back: a blocking one if there is any, else the worst style issue. */
export function topIssue(report: LintReport): LintIssue | null {
  return blockingIssues(report)[0] ?? report.issues.find((i) => !isGroundingIssue(i)) ?? report.issues[0] ?? null
}

/** Starts the note on a cover letter the style check holds back. Also how that note is told from other notes. */
export const HELD_LETTER_NOTE = 'The cover letter was held back by the style check.'

/** One or two plain sentences on why a text did not pass, naming its top issue. For notes the person reads. */
export function failureReason(report: LintReport, minLintScore: number): string {
  const issue = topIssue(report)
  if (issue && (blockingIssues(report).length > 0 || report.score < minLintScore)) {
    const text = issue.match && !issue.message.includes(issue.match) ? ` The text is "${issue.match.length > 60 ? `${issue.match.slice(0, 57)}...` : issue.match}".` : ''
    return `${issue.message}${text}`
  }
  // A text that passes the style check can still be held for what it does not tie to. Name that.
  const grounding = groundingIssues(report)[0]
  if (grounding) return grounding.message
  return `Its score is ${report.score} and the minimum is ${minLintScore}.`
}
/** Repeats of one rule stop costing points after this many, so one habit can't zero the score alone. */
const MAX_COUNTED_PER_RULE = 3

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function normalize(text: string): string {
  return text.replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
}

/** Splits prose into sentences. Good enough for scoring, not for grammar. */
export function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+(?=["'(]?[A-Z0-9])/)
    .map((s) => s.trim())
    .filter((s) => /[a-zA-Z]/.test(s))
}

function wordCount(s: string): number {
  return s.split(/\s+/).filter((w) => /[a-zA-Z0-9]/.test(w)).length
}

/** Paragraphs that are only a greeting, sign-off or name don't count toward sentence stats. */
function bodyParagraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0 && wordCount(p) > 4)
}

export function lintText(input: string, options: LintOptions = {}): LintReport {
  const text = normalize(input)
  const lower = text.toLowerCase()
  const issues: LintIssue[] = []

  const add = (rule: string, severity: LintSeverity, message: string, match: string | null, index: number | null, suggestion: string | null) =>
    issues.push({ rule, severity, message, match, index, suggestion })

  // Banned phrases, matched on word boundaries.
  const allowed = new Set((options.allowedTerms ?? []).map((t) => normalize(t).trim().toLowerCase()).filter(Boolean))
  const phrases = [
    ...BANNED_PHRASES.filter((r) => !allowed.has(r.phrase.toLowerCase())),
    ...(options.extraBanned ?? []).filter((s) => s.trim()).map((phrase) => ({ phrase: phrase.trim().toLowerCase(), severity: 'medium' as const, suggestion: null }))
  ]
  for (const rule of phrases) {
    const re = new RegExp(`(?<![a-z])${escapeRegex(rule.phrase.toLowerCase())}(?![a-z])`, 'g')
    for (const m of lower.matchAll(re)) {
      add(`phrase:${rule.phrase}`, rule.severity, `"${text.slice(m.index, m.index + m[0].length)}" reads as stock or AI phrasing.`, text.slice(m.index, m.index + m[0].length), m.index, rule.suggestion)
    }
  }

  // Structural patterns.
  for (const rule of PATTERN_RULES) {
    rule.pattern.lastIndex = 0
    for (const m of text.matchAll(rule.pattern)) {
      add(rule.id, rule.severity, rule.message, m[0].trim() || m[0], m.index ?? null, rule.suggestion)
    }
  }

  const paragraphs = bodyParagraphs(text)
  const sentences = paragraphs.flatMap(splitSentences)
  const lengths = sentences.map(wordCount)
  const words = wordCount(text)
  const avg = lengths.length ? lengths.reduce((a, b) => a + b, 0) / lengths.length : 0
  const std = lengths.length ? Math.sqrt(lengths.reduce((a, b) => a + (b - avg) ** 2, 0) / lengths.length) : 0

  // Essay connectors at the start of a sentence.
  for (const s of sentences) {
    const first = s.toLowerCase().match(/^[a-z]+/)?.[0]
    if (first && BANNED_SENTENCE_STARTS.includes(first)) {
      add('sentence-start', 'medium', `Starting a sentence with "${first}" reads as essay filler.`, s.slice(0, first.length), text.indexOf(s), 'Drop it or join the sentences.')
    }
  }

  // People vary sentence length a lot. Models tend to keep every sentence about the same.
  if (sentences.length >= 6 && std < 4.5) {
    add('uniform-sentences', 'medium', `Sentences are all about the same length (spread ${std.toFixed(1)} words).`, null, null, 'Mix in a few short sentences and one longer one.')
  }

  // Short fragments used for effect ("No fluff. Just results.").
  const fragments = sentences.filter((s) => wordCount(s) <= 3 && !/^(thanks|thank you|best|cheers|sincerely|regards)/i.test(s))
  if (fragments.length >= 2) {
    add('fragments', 'medium', 'Several short fragments in a row read as slogan writing.', fragments.slice(0, 3).join(' '), null, 'Fold them into full sentences.')
  }

  // Lists of three, the classic rhythm of generated text.
  const triplets = [...text.matchAll(/\b[\w'-]+(?: [\w'-]+){0,2}, [\w'-]+(?: [\w'-]+){0,2},? and [\w'-]+/g)]
  if (triplets.length >= 2) {
    for (const m of triplets.slice(1)) {
      add('triplets', 'medium', 'Another list of three. One or two items usually say it better.', m[0], m.index ?? null, 'Keep the one or two items that matter most.')
    }
  }

  // Every sentence starting with "I".
  const iStarts = sentences.filter((s) => /^I\b/.test(s)).length
  if (sentences.length >= 5 && iStarts / sentences.length > 0.5) {
    add('i-starts', 'low', `${iStarts} of ${sentences.length} sentences start with "I".`, null, null, 'Lead some sentences with the work or the result.')
  }

  for (const para of paragraphs) {
    const n = wordCount(para)
    if (n > 140) add('long-paragraph', 'low', `A ${n}-word paragraph is hard to scan.`, para.slice(0, 60), text.indexOf(para), 'Split it.')
  }

  if (options.targetWords) {
    const { min, max } = options.targetWords
    if (words < min) add('too-short', 'medium', `${words} words, aim for at least ${min}.`, null, null, null)
    if (words > max) add('too-long', 'medium', `${words} words, aim for at most ${max}.`, null, null, 'Cut the least specific sentences first.')
  }

  // Score: start at 100, take points off per issue, counting each rule at most three times. Grounding issues come later and cost nothing.
  const counted = new Map<string, number>()
  let penalty = 0
  for (const issue of issues) {
    const seen = counted.get(issue.rule) ?? 0
    if (seen >= MAX_COUNTED_PER_RULE) continue
    counted.set(issue.rule, seen + 1)
    penalty += WEIGHT[issue.severity]
  }

  if (options.grounding) issues.push(...groundingIssuesFor(text, words, options.grounding))

  issues.sort((a, b) => WEIGHT[b.severity] - WEIGHT[a.severity] || (a.index ?? 0) - (b.index ?? 0))

  return {
    score: Math.max(0, Math.min(100, 100 - penalty)),
    issues,
    stats: {
      words,
      sentences: sentences.length,
      avgSentenceWords: Math.round(avg * 10) / 10,
      sentenceLengthStdDev: Math.round(std * 10) / 10,
      paragraphs: paragraphs.length
    }
  }
}

/** Turns a lint report into instructions for a revision pass. */
export function issuesToInstructions(report: LintReport, limit = 12): string {
  const lines: string[] = []
  const seen = new Set<string>()
  // Blocking issues come first so the limit never cuts them off.
  const ordered = [...report.issues].sort((a, b) => Number(isBlockingIssue(b)) - Number(isBlockingIssue(a)))
  for (const issue of ordered) {
    const key = `${issue.rule}|${issue.match ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    const where = issue.match ? ` Text: "${issue.match}".` : ''
    const fix = issue.suggestion ? ` Fix: ${issue.suggestion}` : ''
    lines.push(`- ${issue.message}${where}${fix}`)
    if (lines.length >= limit) break
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Grounding: does the text hold to the posting and the profile?
// ---------------------------------------------------------------------------

/** What a text is held against: a cover letter, an answer about the company or role, or any other open answer. */
export type GroundingKind = 'letter' | 'company' | 'general'

/** Rule ids of the grounding issues. They lower confidence and feed revisions, but never block a text or cost score points. */
export const GROUNDING_RULES = {
  noDetail: 'grounding:no-posting-detail',
  echo: 'grounding:resume-echo',
  number: 'grounding:unsupported-number',
  name: 'grounding:unsupported-name'
} as const

/** True for an issue from the grounding checks. */
export function isGroundingIssue(issue: LintIssue): boolean {
  return issue.rule.startsWith('grounding:')
}

/** The grounding issues of a report. A text with any is less grounded and goes out below the auto-send confidence. */
export function groundingIssues(report: LintReport): LintIssue[] {
  return report.issues.filter(isGroundingIssue)
}

/** Starts the note on a text that is less grounded. Also how that note is told from other notes. */
export const GROUNDING_NOTE_START = 'Not tied to the posting and the profile.'

/** One plain sentence or two on why a text is less grounded, for the note the person reads. Null when it is grounded. */
export function groundingNote(report: LintReport): string | null {
  const issue = groundingIssues(report)[0]
  if (!issue) return null
  return `${GROUNDING_NOTE_START} ${issue.message}`
}

/** What a posting and a profile give a text to hold on to. Built once per job by groundingSource. */
/** The dates of one job, as the profile holds them. */
export interface GroundingExperience {
  start?: string | null
  end?: string | null
}

export interface GroundingSource {
  /** False for a posting too thin or too foreign to hold a text against, such as a stub or one in another script. No grounding issues are raised. */
  usable: boolean
  /** Stems of the posting's own words, without the company name, stock hiring words and generic game words. */
  terms: Set<string>
  title: string
  /** Every lowercase word and stem of the sources, for telling a name the text invented. */
  words: Set<string>
  numbers: Set<string>
  /** Four-word runs of the profile, for finding text that repeats it. */
  shingles: Set<string>
}

export interface GroundingOptions {
  source: GroundingSource
  kind: GroundingKind
  /** More text whose numbers and names are fine, such as the question or what the person asked for. */
  extra?: string
}

/** A posting with fewer distinctive words than this is a stub. Nothing can be held against it. */
const MIN_POSTING_TERMS = 15
/** Texts shorter than this say too little to judge. */
const MIN_GROUNDED_WORDS = 15
/** The distinctive posting words a text must use to count as tied to the posting. */
const DETAIL_NEEDED: Record<GroundingKind, number> = { letter: 3, company: 2, general: 0 }
const ECHO_SHINGLE = 4
const ECHO_RATIO = 0.5
const ECHO_MIN_WORDS = 30

const WORD_RE = /\p{Script=Latin}[\p{Script=Latin}\p{N}+#]*/gu

/** The Latin-script words of a text with their original case. Hyphens and apostrophes split words. */
function latinWords(text: string): string[] {
  return text.match(WORD_RE) ?? []
}

/** A crude stem, the same on both sides of a comparison: "rewards" and "reward", "monitoring" and "monitor". */
function stem(word: string): string {
  let w = word.toLowerCase()
  if (w.length > 5 && w.endsWith('ies')) return `${w.slice(0, -3)}y`
  if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3)
  else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2)
  else if (w.length > 4 && w.endsWith('es')) w = w.slice(0, -2)
  else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1)
  if (w.length > 3 && w.endsWith('e')) w = w.slice(0, -1)
  return w
}

/** Words that say nothing about one posting: grammar, stock hiring talk, and words every game or software job uses. */
const STOP_WORDS = `a an the and or but if then than that this these those there here of to in on at by for from with without into onto over under
about above below between among through during before after while until since as is are was were be been being am do does did done doing have has had having
will would shall should can could may might must not no nor so such very more most much many some any each every other another own same also just only even
still yet both either neither all one two three four five six seven eight nine ten first second third new its our ours your yours their theirs his her hers
him them they you we us me my mine who whom whose which what when where why how whether per via etc able across along already always among around away back
because become becomes began best better beyond bring brings came come comes day days down early else ever few full get gets getting give given gives go goes
going good great help helps high however include includes including indeed instead keep know known last least less let like likely line long look looking
looks lot made make makes making means need needs next now off often once open part parts people place put quite rather really right run runs said say see
seen set several show shows small something sometimes soon start started take takes taken tell thing things think though thus today together too took toward
towards try trying turn upon use used uses using various want wants way ways well went whole within work works working world year years
experience experienced skill skills ability abilities strong excellent proven professional role roles position positions job jobs team teams teammate teammates
company companies candidate candidates applicant applicants application apply applying seeking join joining opportunity opportunities responsibility
responsibilities required requirement requirements qualification qualifications preferred plus bonus nice knowledge understanding familiarity familiar
demonstrated demonstrate demonstrates passion passionate collaborate collaboration collaborative collaborating communicate communication communications
written verbal environment culture diverse diversity inclusive inclusion equal employment employer employee employees benefits salary pay base range
compensation eligible package medical dental vision paid time wellness discount discounts policy policies privacy notice information personal data rights
background backgrounds check checks offer stage process hybrid remote onsite office location locations worldwide global globally international leading
leader talented talent exceptional innovative innovation ambitious exciting excited journey adventure mission vision values value committed commitment
welcome individual individuals person race color religion gender sexual orientation identity expression national origin disability age genetic veteran
status marital pregnancy protected law laws federal local applicable consistent consider considered conviction records arrest qualified merit basis
game games gaming gamer gamers gameplay player players play playing played studio studios development develop developer developers developing developed
engineer engineers engineering designer designers design designing designed programmer programmers programming artist artists producer producers manager
managers lead leads leading leadership senior junior staff principal software tool tools tooling system systems build builds building built create creates
creating created creation product products project projects feature features content technical technology technologies technique techniques code coding
codebase platform platforms mobile console pc web client server engine engines pipeline pipelines workflow workflows quality performance scalable scale
solution solutions problem problems solving solve challenge challenges challenging complex complexity practical practice practices industry shipped ship
shipping release released launch launched live service entertainment video interactive title titles feedback improve improving improvement improvements
ownership owning owned end deliver delivering delivery drive driving impact grow growth learn learning fast fun love loved loves enjoy hard real
multiple wide variety different existing additional meaningful compelling satisfying engage engaging excite reliable actionable ambiguous understand
evaluate approach approaches goal goals needed needing member members partner partners partnerships stakeholder stakeholders direction large big top
free view email contact click
time times thing person man woman child life hand eye head face house home family friend group number case point money story fact month night kind
side area city name minute idea ideas body information level office result change changes changed morning reason research moment air teacher education
foot age music market sense nation plan college interest effect class control care field rate heart leader mind price report decision view relationship
town road difference building action model season society director record paper space ground form event matter center couple site activity table need
situation cost figure street image phone data picture piece land news step type attention source organization hair culture chance energy period course
summer plant term letter condition choice test tests testing question questions meet meeting meetings match matches ask asks asked write writes writing
written wrote read reading talk talking discuss discussion prototype prototypes prototyping bug bugs debug debugging feel feels felt seem seems leave call
calls begin move live believe hold happen sit stand lose pay watch follow stop speak allow add spend walk win offer remember appear buy wait serve send
expect stay fall cut reach remain suggest raise pass sell decide pull bad certain clear easy economic human important late little low major possible
public recent social special sure true young quick quickly rough careful clean simple simply clearly closely directly easily especially exactly finally
generally largely mostly nearly probably recently similar usually argue calm notebook mistake mistakes honest useful colleagues colleague habit repeat
search dependable notes plainly screen deadline outside keep kept find found finds finding cause causes caused break breaks broke broken
behind week weeks share shares shared sharing answer answers answered language languages ahead alone amount anyone anything apart aside attempt available avoid
aware basic became benefit beside bit bottom bound brief brought busy carry chain choose close cold comfortable common compare complete concern confident
connect contain count cover current daily deal deep depend describe detail details difficult discover double doubt due enough entire equal essential exact
example explain express extra fail fair fairly far fear fill final fine firm fit fix flat focus forward fresh front future gather general guess half handle
happy hear hope hour huge ideal imagine inside itself jump key later lesson lift list listen lower main manage mean mention method middle nobody normal note
notice ordinary overall page pair particular past path pattern perhaps personal pick plain popular positive prepare present pretty previous prior private
proper proud prove purpose quiet ready regular rely remove replace respond rest return rise risk rule safe save scene second seek select sentence serious
shape short single slow smart solid sort sound speed spot stable steady stuff style subject succeed sudden suppose surprise switch teach tend thank thin
thought tiny top total touch track trade train trust truth twice unit unless unlike until upper usual valuable wide willing wonder worth worry
`
  .split(/\s+/)
  .filter(Boolean)

const STOP_STEMS = new Set(STOP_WORDS.map(stem))

/** Capitalized words that are not names: greetings, forms of address, months and days. */
const NOT_NAMES = new Set(
  `hi hello dear thanks thank best regards sincerely cheers hiring manager team recruiting recruiter talent acquisition committee ms mr mrs mx dr
  january february march april may june july august september october november december monday tuesday wednesday thursday friday saturday sunday english`.split(/\s+/)
)

const NUMBER_RE = /\d[\d,]*(?:\.\d+)?/g

function numbersIn(text: string): string[] {
  // 2D, 3D and 4K name formats, not amounts.
  return (text.replace(/\b\d[dDkK]\b/g, ' ').match(NUMBER_RE) ?? []).map((n) => n.replace(/,/g, '').replace(/\.$/, ''))
}

/**
 * Resume shorthand and its long form. A group counts as known when the profile or the posting uses any term of it, so
 * "UE5" in the profile supports "Unreal Engine 5" in a letter. A term that starts with ! matches only in that case,
 * since the lowercase word is also plain English.
 */
const ALIAS_GROUPS: string[][] = [
  ['UE5', 'Unreal Engine 5'],
  ['UE4', 'Unreal Engine 4'],
  ['UE', 'Unreal Engine', 'Unreal'],
  ['!Switch', 'Nintendo Switch'],
  ['PS4', 'PlayStation 4', 'Playstation 4'],
  ['PS5', 'PlayStation 5', 'Playstation 5'],
  ['Xbox Series X|S', 'Xbox Series X', 'Xbox Series S', 'XSX'],
  ['Xbox One', 'XB1'],
  ['Steam Deck', 'SteamDeck'],
  ['C#', 'C sharp', 'CSharp'],
  ['C++', 'CPP', 'C plus plus'],
  ['JS', 'JavaScript'],
  ['TS', 'TypeScript'],
  ['K8s', 'Kubernetes'],
  ['GCP', 'Google Cloud', 'Google Cloud Platform'],
  ['AWS', 'Amazon Web Services'],
  ['Postgres', 'PostgreSQL'],
  ['Mongo', 'MongoDB'],
  ['Node', 'Node.js', 'NodeJS'],
  ['React', 'React.js', 'ReactJS'],
  ['Unity', 'Unity3D', 'Unity 3D'],
  ['VS Code', 'VSCode', 'Visual Studio Code'],
  ['.NET', 'dotnet', 'DotNet'],
  ['macOS', 'Mac OS', 'OS X'],
  ['Perforce', 'P4', 'Helix Core']
]

const TERM_EDGE = '(?<![\p{L}\p{N}+#])'
const TERM_END = '(?![\p{L}\p{N}+#])'
const ALIASES = ALIAS_GROUPS.map((group) => {
  const terms = group.map((t) => t.replace(/^!/, ''))
  const matchers = group.map((t) => {
    const exact = t.startsWith('!')
    const body = escapeRegex(t.replace(/^!/, '')).replace(/ /g, '\s+')
    return new RegExp(`${TERM_EDGE}${body}${TERM_END}`, exact ? 'u' : 'iu')
  })
  return { terms, matchers }
})

/** Adds the words and numbers of every alias group that the text uses to the sets. */
function addAliases(text: string, words: Set<string>, numbers: Set<string>): void {
  for (const { terms, matchers } of ALIASES) {
    if (!matchers.some((re) => re.test(text))) continue
    for (const t of terms) {
      for (const w of latinWords(t)) {
        words.add(w.toLowerCase())
        words.add(stem(w))
      }
      for (const n of numbersIn(t)) numbers.add(n)
    }
  }
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

/** A resume date as months since year 0, or null when it holds no year. A bare year gives its first and last month. */
function monthRange(raw: string | null | undefined, now: Date): [number, number] | null {
  const s = (raw ?? '').trim()
  if (!s) return null
  if (/^(?:present|current|now|today|ongoing)$/i.test(s)) {
    const m = now.getFullYear() * 12 + now.getMonth()
    return [m, m]
  }
  const year = /\b(19|20)\d{2}\b/.exec(s)
  if (!year) return null
  const y = Number(year[0])
  const iso = /\b(?:19|20)\d{2}[-/.](\d{1,2})\b/.exec(s)
  const named = MONTHS.indexOf(s.slice(0, 3).toLowerCase())
  const month = iso ? Number(iso[1]) - 1 : named >= 0 ? named : null
  if (month !== null && month >= 0 && month < 12) return [y * 12 + month, y * 12 + month]
  return [y * 12, y * 12 + 11]
}

/**
 * Tenure numbers a letter may state: the years (rounded down or up) and months at each employer and in total, worked
 * out from the profile's experience dates. "In 5 years at Hollow Lantern" is supported when the job started in 2021.
 */
function tenureNumbers(experience: GroundingExperience[], now: Date): Set<string> {
  const out = new Set<string>()
  const add = (months: number) => {
    if (!Number.isFinite(months) || months <= 0) return
    out.add(String(Math.round(months)))
    out.add(String(Math.floor(months / 12)))
    out.add(String(Math.ceil(months / 12)))
  }
  let first: [number, number] | null = null
  let last: [number, number] | null = null
  for (const e of experience) {
    const start = monthRange(e.start, now)
    if (!start) continue
    const end = monthRange(e.end ?? 'present', now) ?? monthRange('present', now)!
    for (const s of start) for (const f of end) add(f - s)
    if (!first || start[0] < first[0]) first = start
    if (!last || end[1] > last[1]) last = end
  }
  if (first && last) for (const s of first) for (const f of last) add(f - s)
  out.delete('0')
  return out
}

function shinglesOf(words: string[], size: number): Set<string> {
  const out = new Set<string>()
  for (let i = 0; i + size <= words.length; i++) out.add(words.slice(i, i + size).join(' '))
  return out
}

/**
 * Builds what the grounding checks hold a text against. Call it once per job. `profile` is the candidate's profile as
 * text, and `notes` anything else of theirs such as their notes for the AI. Their numbers and names count as the
 * candidate's own.
 */
export function groundingSource(input: { title: string; company: string; description: string; profile: string; notes?: string; /** The profile's jobs, for tenure numbers. */ experience?: GroundingExperience[]; /** The date tenure is counted to. Today by default. */ now?: Date }): GroundingSource {
  const own = new Set(latinWords(input.company).map(stem))
  const terms = new Set<string>()
  for (const raw of latinWords(input.description)) {
    const lower = raw.toLowerCase()
    const special = /[+#\d]/.test(lower) ? lower.length >= 2 : raw.length >= 3 && raw === raw.toUpperCase()
    if (!special && lower.length < 4) continue
    const s = stem(lower)
    if (!STOP_STEMS.has(s) && !own.has(s)) terms.add(s)
  }
  const all = `${input.title}\n${input.company}\n${input.description}\n${input.profile}\n${input.notes ?? ''}`
  const words = new Set<string>()
  for (const w of latinWords(all)) {
    words.add(w.toLowerCase())
    words.add(stem(w))
  }
  const numbers = new Set(numbersIn(all))
  addAliases(all, words, numbers)
  for (const n of tenureNumbers(input.experience ?? [], input.now ?? new Date())) numbers.add(n)
  return {
    usable: terms.size >= MIN_POSTING_TERMS,
    terms,
    title: input.title,
    words,
    numbers,
    shingles: shinglesOf(latinWords(input.profile).map((w) => w.toLowerCase()), ECHO_SHINGLE)
  }
}

/** Capitalized words that do not start a sentence. */
function midSentenceNames(text: string): string[] {
  const out: string[] = []
  // Whole tokens, so "GitHub" and "PlayStation" are not cut into "Hub" and "Station".
  for (const m of text.matchAll(/(?<![\p{L}\p{N}+#])\p{Lu}[\p{L}\p{N}+#]*/gu)) {
    if (!/\p{Ll}/u.test(m[0])) continue
    const before = text.slice(0, m.index).replace(/[\s"'“”‘’([]+$/, '')
    const gap = text.slice(before.length, m.index)
    const starts = before === '' || /[.!?:]$/.test(before) || /\n/.test(gap)
    if (!starts) out.push(m[0])
  }
  return out
}

function groundingIssuesFor(text: string, wordTotal: number, options: GroundingOptions): LintIssue[] {
  const { source, kind } = options
  if (!source.usable || wordTotal < MIN_GROUNDED_WORDS) return []
  const issues: LintIssue[] = []
  const add = (rule: string, message: string, match: string | null, suggestion: string) => issues.push({ rule, severity: 'medium', message, match, index: null, suggestion })

  // A detail from the posting. Naming the job title or the company says nothing, so the title is taken out first.
  const needed = DETAIL_NEEDED[kind]
  if (needed > 0) {
    let rest = text
    for (const t of [source.title, source.title.split(/\s*[-–(,]\s*/)[0]]) {
      if (t.trim()) rest = rest.replace(new RegExp(escapeRegex(t.trim()), 'gi'), ' ')
    }
    const matched = new Set<string>()
    for (const w of latinWords(rest)) {
      const s = stem(w)
      if (source.terms.has(s)) matched.add(s)
    }
    if (matched.size < needed) {
      add(
        GROUNDING_RULES.noDetail,
        matched.size === 0
          ? 'It names no detail from the posting, such as a product, a tool, a team or a responsibility.'
          : `It names too little from the posting. Name at least ${needed} different things the posting says, such as a product, a tool, a team or a responsibility.`,
        null,
        "Tie one real project to something the posting says, in the posting's own words."
      )
    }
  }

  // A text that mostly repeats the resume adds nothing the reader doesn't already have.
  if (kind !== 'general') {
    const words = bodyParagraphs(text).flatMap(latinWords).map((w) => w.toLowerCase())
    if (words.length >= ECHO_MIN_WORDS) {
      const echoed = new Set<number>()
      for (let i = 0; i + ECHO_SHINGLE <= words.length; i++) {
        if (source.shingles.has(words.slice(i, i + ECHO_SHINGLE).join(' '))) for (let k = i; k < i + ECHO_SHINGLE; k++) echoed.add(k)
      }
      if (echoed.size / words.length >= ECHO_RATIO) {
        add(GROUNDING_RULES.echo, 'Most of it repeats the resume in the same words.', null, 'Explain one decision from one project in new words instead of restating the resume.')
      }
    }
  }

  // Numbers and names that the profile and the posting don't have were invented.
  const extra = options.extra ?? ''
  const extraNumbers = new Set(numbersIn(extra))
  const extraWords = new Set(latinWords(extra).flatMap((w) => [w.toLowerCase(), stem(w)]))
  const badNumbers = [...new Set(numbersIn(text))].filter((n) => !source.numbers.has(n) && !extraNumbers.has(n))
  for (const n of badNumbers.slice(0, 3)) {
    add(GROUNDING_RULES.number, `The number ${n} is in neither the profile nor the posting.`, n, 'Remove it, or use a number the profile gives.')
  }
  const known = (n: string) => source.words.has(n.toLowerCase()) || source.words.has(stem(n)) || extraWords.has(n.toLowerCase()) || extraWords.has(stem(n))
  const badNames = [...new Set(midSentenceNames(text).filter((n) => !NOT_NAMES.has(n.toLowerCase()) && !known(n)))]
  for (const n of badNames.slice(0, 3)) {
    add(GROUNDING_RULES.name, `The name ${n} is in neither the profile nor the posting.`, n, 'Remove it, or use a name the profile or the posting gives.')
  }
  return issues
}

/** Whether a question asks about the employer, the role or why the person wants it. Such an answer must name something specific to the posting. */
export function asksAboutEmployer(question: string): boolean {
  const q = question.replace(/\s+/g, ' ')
  if (/\b(?:leaving|left|last job|previous job)\b/i.test(q)) return false
  return [
    /\bwhy\b[^?]*\b(?:want|interested|apply(?:ing)?|join|work (?:for|with|at|here)|choose|chose|excited|us|this (?:role|position|job|company|team|studio|opportunity)|our (?:company|studio|team)|(?:a |the )?(?:good |great |right )?fit)\b/i,
    /\b(?:what|which)\b[^?]*\b(?:attracts?|interests?|excites?|draws?|appeals?|motivates?)\b[^?]*\b(?:you|to)\b/i,
    /\b(?:interest|interested|excited|excitement|motivation|motivated)\b[^?]*\b(?:in|about|by)\b[^?]*\b(?:role|position|job|company|us|team|studio|opportunity|posting)\b/i,
    /\b(?:tell|show|share)\b[^?]*\bwhy\b/i,
    /\bwhat (?:do you|would you) (?:know|like) about\b/i
  ].some((re) => re.test(q))
}
