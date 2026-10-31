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
  p('excited about the opportunity', 'medium'),
  p('excited by the opportunity', 'medium'),
  p('unique opportunity', 'medium'),
  p('eager to contribute', 'medium'),
  p('keen interest', 'medium'),
  p('passionate about', 'medium', 'Say what you did instead of how you feel about it.'),
  p('my passion for', 'medium'),
  p('proven track record', 'high', 'Give the number or result instead.'),
  p('results-driven', 'high'),
  p('detail-oriented', 'medium'),
  p('team player', 'medium'),
  p('self-starter', 'medium'),
  p('go-getter', 'high'),
  p('hit the ground running', 'medium'),
  p('wear many hats', 'medium'),
  p('think outside the box', 'high'),
  p('i am confident that', 'medium'),
  p('i\'m confident that', 'medium'),
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
    pattern: /\s?—\s?|\s--\s|\s–\s/g,
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
    pattern: /\[(?:company|company name|your name|hiring manager|position|role|job title)[^\]]*\]|\{\{[^}]*\}\}|\bXYZ (?:Company|Corp)\b|lorem ipsum/gi,
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
    id: 'the-result',
    pattern: /\b(?:The result|The outcome|The best part|The kicker)\?/g,
    severity: 'high',
    message: 'Setup question followed by a reveal.',
    suggestion: 'State the result in the same sentence.'
  }
]

/** Replacement used when revisions run out and a dash is still there. */
export function replaceDashes(text: string): string {
  return text
    .replace(/\s*—\s*/g, ', ')
    .replace(/\s--\s/g, ', ')
    .replace(/\s–\s/g, ', ')
    .replace(/,\s*,/g, ',')
    .replace(/,\s*\./g, '.')
}
