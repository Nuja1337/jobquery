import type { LintSeverity } from '@shared/types'

// Phrases and patterns that make writing read as machine-made or as a template.
// Two sources: the style rules this project follows for its own text, and the tells
// recruiters most often name when they spot AI-written applications.

export interface PhraseRule {
  phrase: string
  severity: LintSeverity
  suggestion: string | null
}

export interface PatternRule {
  id: string
  pattern: RegExp
  severity: LintSeverity
  message: string
  suggestion: string | null
}

const p = (phrase: string, severity: LintSeverity, suggestion: string | null = null): PhraseRule => ({ phrase, severity, suggestion })

export const BANNED_PHRASES: PhraseRule[] = [
  // Words that show up far more in model output than in people's writing.
  p('delve', 'high', 'look into, dig into'),
  p('tapestry', 'high'),
  p('testament to', 'high', 'shows'),
  p('in the realm of', 'high', 'in'),
  p('navigate the complexities', 'high'),
  p('ever-evolving', 'high'),
  p('ever-changing', 'high'),
  p('rapidly evolving', 'medium'),
  p('in today\'s fast-paced', 'high'),
  p('fast-paced environment', 'medium'),
  p('embark', 'medium', 'start'),
  p('journey', 'medium'),
  p('foster', 'medium', 'build, encourage'),
  p('leverage', 'medium', 'use'),
  p('leveraging', 'medium', 'using'),
  p('utilize', 'medium', 'use'),
  p('harness', 'medium', 'use'),
  p('unlock', 'medium'),
  p('unleash', 'high'),
  p('elevate', 'medium', 'improve'),
  p('empower', 'medium', 'help, let'),
  p('streamline', 'medium', 'simplify, speed up'),
  p('seamless', 'medium', 'smooth'),
  p('seamlessly', 'medium'),
  p('robust', 'medium', 'solid, reliable'),
  p('cutting-edge', 'medium'),
  p('cutting edge', 'medium'),
  p('state-of-the-art', 'medium'),
  p('game-changer', 'high'),
  p('game changer', 'high'),
  p('supercharge', 'high'),
  p('pivotal', 'medium', 'key'),
  p('crucial', 'medium', 'important'),
  p('vital', 'low', 'important'),
  p('paramount', 'medium'),
  p('myriad', 'medium', 'many'),
  p('plethora', 'high', 'many'),
  p('multifaceted', 'medium'),
  p('meticulous', 'medium', 'careful'),
  p('meticulously', 'medium', 'carefully'),
  p('invaluable', 'medium'),
  p('transformative', 'medium'),
  p('synergy', 'high'),
  p('synergies', 'high'),
  p('holistic', 'medium'),
  p('resonates with me', 'high'),
  p('resonate', 'medium'),
  p('underscore', 'medium', 'show'),
  p('underscores', 'medium', 'shows'),
  p('showcase', 'medium', 'show'),
  p('showcasing', 'medium', 'showing'),
  p('honed', 'medium', 'built, sharpened'),
  p('intricate', 'low'),
  p('nuanced', 'low'),
  p('comprehensive', 'low'),
  p('intuitive', 'low'),
  p('effortless', 'medium'),
  p('powerful', 'low'),
  p('vibrant', 'medium'),
  p('bustling', 'high'),
  p('nestled', 'high'),
  p('at the forefront', 'medium'),
  p('at the intersection of', 'medium'),
  p('commitment to excellence', 'high'),
  p('world-class', 'medium'),
  p('best-in-class', 'medium'),
  p('mission-driven', 'low'),

  // Cover letter templates everyone has read a thousand times.
  p('i am writing to express my interest', 'high', 'Start with something specific about the role or what you did.'),
  p('i am writing to apply', 'high', 'Start with something specific about the role or what you did.'),
  p('i hope this finds you well', 'high'),
  p('i hope this message finds you well', 'high'),
  p('i am thrilled', 'high'),
  p('i\'m thrilled', 'high'),
  p('thrilled to', 'high'),
  p('i am excited to apply', 'high'),
  p('i\'m excited to apply', 'high'),
  p('excited about the opportunity', 'high'),
  p('excited by the opportunity', 'high'),
  p('unique opportunity', 'medium'),
  p('eager to contribute', 'high'),
  p('keen interest', 'medium'),
  p('passionate about', 'high', 'Say what you did instead of how you feel about it.'),
  p('my passion for', 'high', 'Say what you did instead of how you feel about it.'),
  p('proven track record', 'high', 'Give the number or result instead.'),
  p('results-driven', 'high'),
  p('detail-oriented', 'medium'),
  p('team player', 'medium'),
  p('self-starter', 'medium'),
  p('go-getter', 'high'),
  p('hit the ground running', 'medium'),
  p('wear many hats', 'medium'),
  p('think outside the box', 'high'),
  p('i am confident that', 'high'),
  p('i\'m confident that', 'high'),
  p('i believe i would be a great fit', 'high'),
  p('would be a great fit', 'medium'),
  p('perfect fit', 'medium'),
  p('ideal candidate', 'high'),
  p('valuable asset', 'high'),
  p('make a meaningful impact', 'high'),
  p('meaningful impact', 'medium'),
  p('make a difference', 'low'),
  p('contribute to your team\'s success', 'high'),
  p('aligns perfectly', 'high'),
  p('aligns with my values', 'high'),
  p('align with my', 'medium'),
  p('aligns with my', 'medium'),
  p('your esteemed', 'high'),
  p('esteemed', 'medium'),
  p('renowned', 'medium'),
  p('industry leader', 'medium'),
  p('leader in the industry', 'medium'),
  p('innovative company', 'medium'),
  p('i look forward to the opportunity to discuss', 'medium', 'I\'d be glad to talk more.'),
  p('thank you for considering my application', 'low'),
  p('thank you for your time and consideration', 'low'),

  // Game-industry clichés. Recruiters at studios read these all day.
  p('passion for games', 'high', 'Say what you built instead.'),
  p('passion for gaming', 'high', 'Say what you built instead.'),
  p('passion for game', 'high', 'Say what you built instead.'),
  p('passion for video games', 'high', 'Say what you built instead.'),
  p('love of games', 'medium'),
  p('love for games', 'medium'),
  p('love of gaming', 'medium'),
  p('love for gaming', 'medium'),
  p('lifelong gamer', 'high'),
  p('avid gamer', 'high'),
  p('gaming since', 'high', 'Say what you built instead of when you started playing.'),
  p('playing games since', 'high', 'Say what you built instead of when you started playing.'),
  p('since childhood', 'high'),
  p('since i was a kid', 'high'),
  p('since i was a child', 'high'),
  p('since i was young', 'high'),
  p('since a young age', 'high'),
  p('from a young age', 'medium'),
  p('push the boundaries', 'high', 'Name the thing you pushed and the result.'),
  p('pushing the boundaries', 'high', 'Name the thing you pushed and the result.'),
  p('push boundaries', 'high'),
  p('push the envelope', 'high'),
  p('immersive experience', 'high', 'Name the feature or system instead.'),
  p('immersive experiences', 'high', 'Name the feature or system instead.'),
  p('immersive', 'medium'),
  p('player-first', 'high'),
  p('player first', 'medium'),
  p('player-centric', 'high'),
  p('player-centered', 'medium'),
  p('aaa-quality', 'high'),
  p('aaa quality', 'high'),
  p('level up', 'medium'),
  p('level-up', 'medium'),
  p('next level', 'medium'),
  p('dream job', 'high'),
  p('dream come true', 'high'),
  p('bring your vision to life', 'high'),
  p('bring worlds to life', 'high'),
  p('bring games to life', 'high'),
  p('bring ideas to life', 'medium'),
  p('fellow gamers', 'medium'),
  p('unforgettable', 'medium'),

  // More machine tells.
  p('in today\'s', 'medium'),
  p('in the ever', 'medium'),
  p('digital age', 'high'),
  p('unique blend', 'high', 'Say what the two things are.'),
  p('unique combination', 'medium'),
  p('unique mix', 'medium'),
  p('i\'d love the opportunity', 'high'),
  p('i would love the opportunity', 'high'),
  p('love the opportunity', 'high'),
  p('i am delighted', 'high'),
  p('i\'m delighted', 'high'),
  p('i am eager', 'high'),
  p('i\'m eager', 'high'),
  p('align perfectly', 'high'),
  p('aligned perfectly', 'high'),
  p('aligning perfectly', 'high'),
  p('dive into', 'medium'),
  p('deep dive', 'medium'),
  p('treasure trove', 'high'),
  p('beacon', 'high'),
  p('game-changing', 'high'),
  p('revolutionize', 'medium'),
  p('spearhead', 'medium', 'lead'),
  p('strive', 'medium'),
  p('passionate', 'medium'),
  p('excited to join', 'high'),
  p('excited to bring', 'high'),

  // Filler words.
  p('truly', 'medium'),
  p('genuinely', 'medium'),
  p('incredibly', 'medium'),
  p('deeply', 'low'),
  p('simply', 'low'),
  p('actually', 'low'),
  p('really', 'low'),
  p('just', 'low'),

  // Signposting openers and connectors.
  p('here\'s how', 'medium'),
  p('in short', 'medium'),
  p('simply put', 'medium'),
  p('in conclusion', 'high'),
  p('to sum up', 'medium'),
  p('it is worth noting', 'medium'),
  p('it\'s worth noting', 'medium'),
  p('needless to say', 'medium'),
  p('as an ai', 'high'),
  p('language model', 'high')
]

/** Sentence starters that read as essay glue. Flagged only at the start of a sentence. */
export const BANNED_SENTENCE_STARTS = ['additionally', 'furthermore', 'moreover', 'ultimately', 'overall', 'notably', 'importantly', 'consequently']

export const PATTERN_RULES: PatternRule[] = [
  {
    id: 'em-dash',
    // Em and en dashes, a double hyphen, and a spaced hyphen used as a dash. A hyphen at the start of a line is a list marker.
    pattern: /\s?—\s?|\s--\s|\s–\s|(?<=\S)[ \t]-[ \t](?=\S)/g,
    severity: 'high',
    message: 'Dashes used as pauses are a strong AI tell.',
    suggestion: 'Use a comma or a period, or split the sentence.'
  },
  {
    id: 'not-x-but-y',
    pattern: /\bnot\s+(?:only|just|merely|simply)\b[^.!?]{0,80}?\bbut\b/gi,
    severity: 'high',
    message: '"Not only X but Y" is a stock construction.',
    suggestion: 'Say the stronger point directly.'
  },
  {
    id: 'its-not-x-its-y',
    pattern: /\b(?:it|this|that)(?:'s| is| was)\s+(?:not|n't)\s+(?:just|only|about)?[^.!?]{0,60}?[,;]\s*(?:it|this|that)(?:'s| is| was)\b/gi,
    severity: 'high',
    message: '"It\'s not X, it\'s Y" is a stock construction.',
    suggestion: 'Say what it is.'
  },
  {
    id: 'isnt-just',
    pattern: /\b(?:isn't|is not|wasn't|was not)\s+(?:just|only|merely)\b/gi,
    severity: 'medium',
    message: '"Isn\'t just" sets up a contrast that reads as a template.',
    suggestion: 'Say what it is.'
  },
  {
    id: 'rhetorical-question',
    pattern: /[^.!?\n]{8,}\?/g,
    severity: 'medium',
    message: 'Questions in an application read as a sales pitch.',
    suggestion: 'Make it a statement.'
  },
  {
    id: 'exclamation',
    pattern: /!/g,
    severity: 'medium',
    message: 'Exclamation marks read as forced enthusiasm.',
    suggestion: 'Use a period.'
  },
  {
    id: 'semicolon',
    pattern: /;/g,
    severity: 'low',
    message: 'Semicolons stack sentences together.',
    suggestion: 'Split into two sentences.'
  },
  {
    id: 'colon-join',
    pattern: /[a-z]{3,}: [a-z]/g,
    severity: 'low',
    message: 'A colon joining two clauses reads as a writing tic.',
    suggestion: 'Use two sentences.'
  },
  {
    id: 'arrow',
    pattern: /\s(?:->|=>|→|⇒)\s/g,
    severity: 'medium',
    message: 'Arrows in sentences.',
    suggestion: 'Use words.'
  },
  {
    id: 'emoji',
    pattern: /\p{Extended_Pictographic}/gu,
    severity: 'high',
    message: 'Emoji in an application.',
    suggestion: 'Remove it.'
  },
  {
    id: 'markdown',
    pattern: /\*\*[^*]+\*\*|^#{1,6}\s|^\s*[-*•]\s/gm,
    severity: 'high',
    message: 'Markdown or bullets will show up as raw symbols in most forms.',
    suggestion: 'Write plain paragraphs.'
  },
  {
    id: 'placeholder',
    pattern: /\[(?:company|company name|your name|hiring manager|position|role|job title)[^\]]*\]|\{\{[^}]*\}\}|\bXYZ (?:Company|Corp)\b|lorem ipsum|\bNEEDS[_ -]INPUT\b/gi,
    severity: 'high',
    message: 'A template placeholder was left in.',
    suggestion: 'Fill it in or remove it.'
  },
  {
    id: 'as-a-opener',
    pattern: /^(?:As an? [a-z -]{3,40}(?:with|who)\b)/gim,
    severity: 'medium',
    message: '"As a [role] with [N] years" is the most common opener there is.',
    suggestion: 'Open with something you did or something specific about them.'
  },
  {
    id: 'with-years-opener',
    pattern: /(?:^|[.!?]\s+)With\s+(?:over\s+|more than\s+|nearly\s+|almost\s+|about\s+|close to\s+)?(?:\d+\+?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty)\s+years?\b/gm,
    severity: 'high',
    message: '"With N years of experience" is a stock opener.',
    suggestion: 'Open with something you did or something specific about the job.'
  },
  {
    id: 'the-result',
    pattern: /\b(?:The result|The outcome|The best part|The kicker)\?/g,
    severity: 'high',
    message: 'Setup question followed by a reveal.',
    suggestion: 'State the result in the same sentence.'
  }
]

/**
 * Replacement used when revisions run out and a dash is still there. A dash between two numbers becomes " to "
 * ("2019 - 2021" becomes "2019 to 2021"). Any other dash becomes a comma. Line breaks stay, and so does a hyphen
 * at the start of a line, which is a list marker.
 */
export function replaceDashes(text: string): string {
  return text
    .replace(/(\d)[ \t]*[—–][ \t]*(\d)/g, '$1 to $2')
    .replace(/(\d)[ \t]+(?:--|-)[ \t]+(\d)/g, '$1 to $2')
    .replace(/^[ \t]*—[ \t]*/gm, '')
    .replace(/[ \t]*—[ \t]*(?=\n|$)/g, ',')
    .replace(/[ \t]*—[ \t]*/g, ', ')
    .replace(/[ \t]--[ \t]/g, ', ')
    .replace(/[ \t]–[ \t]/g, ', ')
    .replace(/(?<=\S)[ \t]+-[ \t]+(?=\S)/g, ', ')
    .replace(/,[ \t]*,/g, ',')
    .replace(/,[ \t]*\./g, '.')
}

/**
 * Banned words that have a plain technical meaning in a game or tools job. One is allowed when the posting or the
 * profile uses it that way, for example a test harness or unlock progression. Fillers and template openers never are.
 */
const ALLOWABLE_TERMS: Array<{ term: string; found: RegExp }> = [
  { term: 'harness', found: /\btest harness(?:es)?\b/i },
  { term: 'unlock', found: /\bunlock(?:s|ed|ing|ables?)?\b/i },
  { term: 'journey', found: /\b(?:player|user|customer) journey\b/i },
  { term: 'immersive', found: /\bimmersive (?:sim|simulation|game|games|environment|environments|audio|worlds?)\b/i },
  { term: 'level up', found: /\blevel up\b/i },
  { term: 'level-up', found: /\blevel-up\b/i },
  { term: 'robust', found: /\brobust (?:netcode|tooling|tools|systems?|pipelines?|testing|test)\b/i },
  { term: 'powerful', found: /\bpowerful (?:tools?|editors?|engines?|scripting)\b/i },
  { term: 'intuitive', found: /\bintuitive (?:tools?|controls?|interfaces?|editors?|ui|ux)\b/i }
]

/** The banned terms that the given texts (a posting, the profile) use in a plain technical sense. Lowercase. */
export function allowedTermsFrom(...texts: Array<string | null | undefined>): string[] {
  const all = texts.filter((t): t is string => !!t).join('\n')
  if (!all.trim()) return []
  return ALLOWABLE_TERMS.filter((a) => a.found.test(all)).map((a) => a.term)
}
