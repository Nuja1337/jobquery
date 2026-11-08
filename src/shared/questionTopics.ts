// Groups the questions application forms keep asking into topics, so a saved answer to "Why Anthropic?"
// is found for "Why do you want to work here?" and an answer about salary in USD is found for any
// wording of that question. Used by the answer bank (main) and, with the same rules, by the field
// mapper for the "years of experience with X" questions.

export const QUESTION_TOPICS = [
  'why_company',
  'about_you',
  'why_role',
  'strengths',
  'weaknesses',
  'project',
  'salary_expectation',
  'notice_period',
  'start_date',
  'relocation',
  'authorization',
  'sponsorship',
  'ai_use_disclosure',
  'criminal_history',
  'references',
  'heard_about',
  'years'
] as const

export type QuestionTopic = (typeof QUESTION_TOPICS)[number]

export interface TopicMatch {
  topic: string
  /** What narrows the topic: a currency code, a country or a skill. Null when the question names none. */
  scope: string | null
}

/**
 * Topics whose answers name the company or the role. A saved fact on one of these is never reused
 * across companies by topic. A template is, because the AI adapts it.
 */
export const COMPANY_SPECIFIC_TOPICS: readonly string[] = ['why_company', 'why_role']

const CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'NZD', 'CHF', 'SEK', 'NOK', 'DKK', 'PLN', 'JPY', 'SGD', 'INR', 'BRL', 'MXN']

/** Currency a question names, as a code ("in USD", "(EUR)", "£"). A bare "$" is not enough to tell. */
function currencyIn(text: string): string | null {
  const code = text.match(new RegExp(`\\b(${CURRENCIES.join('|')})\\b`, 'i'))
  if (code) return code[1].toUpperCase()
  if (/€/.test(text)) return 'EUR'
  if (/£/.test(text)) return 'GBP'
  if (/\bUS\$|\bUS dollars?\b|\bU\.S\. dollars?\b/i.test(text)) return 'USD'
  return null
}

const COUNTRY_NAMES: Array<[RegExp, string]> = [
  [/\bunited states\b/i, 'United States'],
  [/\bU\.?S\.?A?\b/, 'United States'],
  [/\bcanada\b/i, 'Canada'],
  [/\bunited kingdom\b|\bU\.?K\.?\b|\bgreat britain\b|\bbritain\b|\bengland\b/i, 'United Kingdom'],
  [/\bireland\b/i, 'Ireland'],
  [/\bgermany\b/i, 'Germany'],
  [/\bfrance\b/i, 'France'],
  [/\bnetherlands\b|\bholland\b/i, 'Netherlands'],
  [/\bsweden\b/i, 'Sweden'],
  [/\bfinland\b/i, 'Finland'],
  [/\bdenmark\b/i, 'Denmark'],
  [/\bnorway\b/i, 'Norway'],
  [/\bpoland\b/i, 'Poland'],
  [/\bspain\b/i, 'Spain'],
  [/\bitaly\b/i, 'Italy'],
  [/\bportugal\b/i, 'Portugal'],
  [/\bswitzerland\b/i, 'Switzerland'],
  [/\baustria\b/i, 'Austria'],
  [/\baustralia\b/i, 'Australia'],
  [/\bnew zealand\b/i, 'New Zealand'],
  [/\bjapan\b/i, 'Japan'],
  [/\bsingapore\b/i, 'Singapore'],
  [/\bindia\b/i, 'India'],
  [/\bbrazil\b|\bbrasil\b/i, 'Brazil'],
  [/\bmexico\b/i, 'Mexico']
]

/** Country a question names. "US" counts only in capitals, since "work for us" is not the country. */
function countryIn(text: string): string | null {
  for (const [re, name] of COUNTRY_NAMES) if (re.test(text)) return name
  return null
}

// Words that say a "years" question is about experience in general or about the job, not one skill.
const GENERIC_SKILL_WORDS = new Set([
  'total', 'overall', 'professional', 'relevant', 'related', 'similar', 'work', 'working', 'industry', 'field', 'role',
  'position', 'job', 'this', 'that', 'these', 'those', 'our', 'your', 'you', 'company', 'team', 'business', 'career',
  'full', 'time', 'experience', 'general', 'any', 'such', 'the', 'a', 'an', 'it', 'us', 'we', 'them'
])

const YEARS_PATTERNS: RegExp[] = [
  // "years of (professional) experience (do you have) with React"
  /\byears?(?: of)?(?: [a-z-]+){0,3}? experience(?: do you have)?(?: working)?(?: with| in| using| of| on| developing (?:with|in))\s+(.+)$/,
  // "years of Python experience", "years of React development experience"
  /\byears? of\s+(?:hands-on |professional |commercial |relevant |practical |work )*(.+?)\s+(?:experience|development|programming|engineering|administration)\b/,
  // "Years of experience: Python"
  /\byears?(?: of)? experience\s*[:\-–]\s*(.+)$/,
  // "How many years have you worked with Kubernetes"
  /\b(?:years?|yrs)\b.*\b(?:have you|did you)\s+(?:been )?(?:worked|used|using|working|programmed|programming|coded|coding|developed|developing)\s+(?:with|in|on)\s+(.+)$/,
  // "Python (years of experience)", "Python - years"
  /^(.+?)\s*[-–:(]\s*(?:number of |total )?(?:years|yrs)(?: of experience)?\s*\)?$/,
  // "Experience with React (years)"
  /\bexperience\s+(?:with|in|using)\s+(.+?)\s*\(\s*(?:in )?(?:years|yrs)\s*\)$/,
  // "How long have you used React"
  /\bhow long have you (?:been )?(?:used|using|worked|working|programmed|programming|coded|coding|developed|developing)\s+(?:with |in |on )?(.+)$/
]

/** Tidies a skill taken from a question: drops asides, filler and a trailing "professionally". */
function cleanSkill(raw: string): string | null {
  let s = raw
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\be\.?g\.?\b.*$/, ' ')
    .replace(/[?!.]+$/g, ' ')
    .replace(/\b(?:do you have|have you had|in total|so far|professionally|commercially|in production|in a professional (?:setting|capacity)|currently|at work|on the job)\b/g, ' ')
    .replace(/^(?:the|a|an|using|with|in|on)\s+/, '')
    .replace(/\s+/g, ' ')
    .trim()
  s = s.replace(/[,;:]+$/, '').trim()
  if (!s) return null
  const words = s.split(' ')
  if (words.length > 4 || words.some((w) => GENERIC_SKILL_WORDS.has(w))) return null
  return s
}

/**
 * The skill a "years of experience" question names, lowercase, or null when the question is about
 * experience in general or isn't a years question at all. "How many years of experience do you have
 * with React?" gives "react". "How many years of experience do you have?" gives null.
 */
export function skillFromYearsQuestion(question: string): string | null {
  const text = question
    .toLowerCase()
    .replace(/\(optional\)|\*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!/\b(?:years?|yrs|how long)\b/.test(text)) return null
  for (const re of YEARS_PATTERNS) {
    const hit = text.match(re)
    if (!hit) continue
    const skill = cleanSkill(hit[1])
    if (skill) return skill
  }
  return null
}

/** True for a question about how many years the person has done something. */
export function isYearsQuestion(question: string): boolean {
  const t = question.toLowerCase()
  return /\bhow many (?:full |total )?(?:years?|yrs)\b|\byears?(?: of)? (?:[a-z-]+ ){0,3}?experience\b|\bhow long have you (?:been )?(?:used|using|worked|working|programmed|programming|coded|coding)\b|\b\d+\+?\s*(?:years?|yrs)\b/.test(t) && skillFromYearsQuestion(question) !== null
}

type Classifier = { topic: QuestionTopic; test: (q: string, lower: string) => boolean; scope?: (q: string) => string | null }

const AI_SUBJECT = /\b(ai|a\.i\.|genai|gen ai|generative ai|artificial intelligence|llms?|large language models?|chatgpt|gpt-?\d*|copilot|claude|gemini)\b/i
const AI_ABOUT_APPLICATION = /\b(polic(?:y|ies)|disclos\w*|application|cover letter|resume|cv|assist\w*|generated|wrote|written|drafted|authored|used|use of|using)\b/i

const SALARY = /\b(?:salary|compensation|remuneration|pay|rate)\s+(?:expectations?|requirements?|range|requested|desired|target)\b|\b(?:expected|desired|target|required|minimum|preferred|base|annual|monthly|hourly|ideal)\s+(?:base\s+)?(?:salary|compensation|pay|rate|remuneration)\b|\bsalary\s+expectations?\b|\bcompensation\s+expectations?\b|\bwhat\b.{0,40}\b(?:salary|compensation)\b.{0,40}\b(?:looking for|expect\w*|seeking|require\w*|want)\b|\bhow much\b.{0,40}\b(?:expect|looking to (?:earn|make)|want to (?:earn|make))\b/i
const CURRENT_PAY = /\b(?:current|previous|last|present|most recent|prior|past)\s+(?:base\s+)?(?:salary|compensation|pay)\b|\bsalary history\b/i

const CLASSIFIERS: Classifier[] = [
  { topic: 'ai_use_disclosure', test: (q) => AI_SUBJECT.test(q) && AI_ABOUT_APPLICATION.test(q) },
  { topic: 'criminal_history', test: (_q, l) => /\b(convicted|conviction|criminal|felony|felonies|misdemeanou?r|arrested|arrest record|pleaded)\b/.test(l) },
  { topic: 'sponsorship', test: (_q, l) => /\bsponsor\w*\b/.test(l), scope: countryIn },
  { topic: 'authorization', test: (_q, l) => /authori[sz]ed to work|legally (?:authori[sz]ed|eligible|permitted|entitled)|right to work|eligible to work|work permit|work authori[sz]ation/.test(l), scope: countryIn },
  { topic: 'salary_expectation', test: (q) => SALARY.test(q) && !CURRENT_PAY.test(q), scope: currencyIn },
  { topic: 'notice_period', test: (_q, l) => /\bnotice\b/.test(l) && /\b(period|weeks|days|how (?:much|long)|current employer|give|required|resign\w*)\b/.test(l) && !/\b(privacy|legal|data|cookie|candidate)\b/.test(l) },
  {
    topic: 'start_date',
    test: (_q, l) =>
      /\b(earliest|desired|preferred|expected|anticipated)\b.{0,20}\b(start|availab\w*|join\w*)\b|\bwhen (?:can|could|would) you (?:start|join|begin)\b|\bavailable to (?:start|join)\b|\bhow soon can you\b|\bavailable from\b|\byour (?:start|availability) date\b|\bdate available\b/.test(l)
  },
  { topic: 'relocation', test: (_q, l) => /\brelocat\w*/.test(l) && /\b(willing|open|able|prepared|ready|happy|comfortable|consider|would you)\b/.test(l) && !/\b(assistance|support|package|reimburse\w*|stipend|need)\b/.test(l) },
  { topic: 'references', test: (_q, l) => /\breferences?\b/.test(l) && !/\b(referral|referred|referrer|reference (?:number|code|id)|job reference|requisition)\b/.test(l) },
  { topic: 'heard_about', test: (_q, l) => /how did you (?:hear|find|learn)|where did you (?:hear|find|see)|referral source|source of (?:the )?application/.test(l) },
  { topic: 'years', test: (q) => isYearsQuestion(q), scope: (q) => skillFromYearsQuestion(q) },
  {
    topic: 'weaknesses',
    test: (_q, l) => /\bweakness(?:es)?\b|\bareas? (?:for|of|to) (?:improvement|growth|develop\w*)\b|\bwhat (?:would|do) you (?:like|want|need) to improve\b/.test(l)
  },
  { topic: 'strengths', test: (_q, l) => /\bstrengths?\b/.test(l) },
  {
    topic: 'project',
    test: (_q, l) =>
      /\b(?:proud(?:est)? of|favou?rite|best|most (?:significant|challenging|impactful|interesting)|recent|notable|biggest|greatest)\b.{0,40}\b(?:projects?|accomplishments?|achievements?|work|things? you(?:'ve| have)? (?:built|made|shipped))\b|\b(?:describe|tell us about|walk us through|share)\b.{0,20}\b(?:a|an|one|your)\b.{0,30}\bprojects?\b/.test(l)
  },
  {
    topic: 'about_you',
    test: (_q, l) => /\b(?:tell (?:us|me)|something|a (?:bit|little)) about (?:yourself|you)\b|\babout yourself\b|\bintroduce yourself\b|\bwho you are\b|\bbrief (?:bio|introduction)\b|\bpersonal (?:statement|summary)\b/.test(l)
  },
  {
    topic: 'why_role',
    test: (_q, l) =>
      /\bwhy\b.{0,40}\b(?:this (?:role|job|position|opportunity)|(?:the|this) \w+ (?:role|position)|apply(?:ing)? (?:for|to) this)\b|\bwhy should we (?:hire|choose|pick|select) you\b|\bwhy are you a (?:good|great|strong) fit\b|\bwhat makes you (?:a|the) (?:good|great|best|right|strong)\b/.test(l)
  },
  {
    topic: 'why_company',
    test: (_q, l) =>
      /\bwhy\b.{0,40}\b(?:this company|work (?:here|for us|with us|at|for)|join (?:us|our)|(?:us|our company|our team|our mission)\b|(?:interested|interest) (?:in|you)|apply here)|\bwhy do you want to work\b|\bwhat (?:excites?|interests?|draws?|attracts?|motivates?) you\b.{0,30}\b(?:about|to)\b.{0,30}\b(?:us|company|team|mission|here|working)\b|^\W*why (?!now\b|you\b|me\b|not\b|so\b)[\w.&'’ -]{2,40}\??\W*$/.test(l) &&
      !/\b(?:role|position|job|hire)\b/.test(l)
  }
]

/**
 * The topic of a form question and what narrows it (currency, country or skill), or null when it
 * is not one of the known topics. The first match wins, in the order of QUESTION_TOPICS' checks:
 * sensitive topics first, so "Did you use AI on your cover letter?" is never a cover letter question.
 */
export function topicFor(question: string): TopicMatch | null {
  const q = question.replace(/\s+/g, ' ').trim()
  if (!q) return null
  const lower = q.toLowerCase()
  for (const c of CLASSIFIERS) {
    if (!c.test(q, lower)) continue
    return { topic: c.topic, scope: c.scope ? c.scope(q) : null }
  }
  return null
}

/** True when the question asks what pay the person expects. "Current salary" and "salary history" do not count. */
export function isSalaryExpectationQuestion(question: string): boolean {
  return SALARY.test(question) && !CURRENT_PAY.test(question)
}

/** The currency code a question names, such as "USD" in "Expected salary (USD)", or null. */
export function currencyInQuestion(question: string): string | null {
  return currencyIn(question)
}

/** The country a question names, or null. */
export function countryInQuestion(question: string): string | null {
  return countryIn(question)
}
