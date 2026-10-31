import { describe, expect, it } from 'vitest'
import { issuesToInstructions, lintText, splitSentences } from './lint'
import { replaceDashes } from './rules'

const AI_LETTER = `Dear Hiring Manager,

I am writing to express my interest in the Senior Engineer role at your esteemed company. As a results-driven engineer with a proven track record, I am thrilled to apply.

In today's fast-paced world, I leverage cutting-edge tools to deliver robust, scalable, and seamless solutions. It's not just about code, it's about impact! Furthermore, I am passionate about fostering collaboration, innovation, and growth.

I believe I would be a great fit and a valuable asset to your team. I look forward to the opportunity to discuss how I can contribute to your team's success.

Sincerely,
Sam`

const HUMAN_LETTER = `Hi Priya,

Last spring I rebuilt the billing pipeline at Ledgerly after it double-charged about 300 customers in one weekend. The fix took three weeks. Most of that time went into writing the reconciliation job that now runs every night and pages me if totals drift by more than a cent.

Your posting mentions moving invoicing off a monolith. I did the same move at Ledgerly in 2024, splitting invoices, payments and dunning into separate services over about six months while the old system kept running. We cut failed payment retries by 40 percent along the way, mostly by fixing how retries were scheduled.

I'd like to hear how far along the migration is and where you expect the hard parts to be. I can talk any time next week.

Thanks,
Sam`

describe('lintText', () => {
  it('scores a template-heavy letter low and names the problems', () => {
    const report = lintText(AI_LETTER)
    expect(report.score).toBeLessThan(30)
    const rules = report.issues.map((i) => i.rule)
    expect(rules).toContain('phrase:i am writing to express my interest')
    expect(rules).toContain('phrase:proven track record')
    expect(rules).toContain('exclamation')
    expect(rules).toContain('sentence-start')
  })

  it('scores a specific, plain letter high', () => {
    const report = lintText(HUMAN_LETTER)
    expect(report.score).toBeGreaterThanOrEqual(85)
  })

  it('flags em dashes and not-only-but constructions', () => {
    const report = lintText('I led the rollout — and it shipped early. Not only did we ship, but we also cut costs.')
    const rules = report.issues.map((i) => i.rule)
    expect(rules).toContain('em-dash')
    expect(rules).toContain('not-x-but-y')
  })

  it('flags leftover placeholders and markdown', () => {
    const report = lintText('I would love to join [Company Name].\n\n**Key skills**\n- Python')
    const rules = report.issues.map((i) => i.rule)
    expect(rules).toContain('placeholder')
    expect(rules).toContain('markdown')
  })

  it('applies user banned phrases and length targets', () => {
    const report = lintText('I like synergy-free teams and widgets.', { extraBanned: ['widgets'], targetWords: { min: 50, max: 100 } })
    const rules = report.issues.map((i) => i.rule)
    expect(rules).toContain('phrase:widgets')
    expect(rules).toContain('too-short')
  })

  it('does not match banned words inside other words', () => {
    const report = lintText('Adjustable desks are fine. The trusted vendor shipped on time.')
    expect(report.issues.find((i) => i.rule === 'phrase:just')).toBeUndefined()
  })

  it('turns issues into revision instructions', () => {
    const text = issuesToInstructions(lintText(AI_LETTER), 5)
    expect(text.split('\n')).toHaveLength(5)
    expect(text).toMatch(/^- /)
  })
})

describe('helpers', () => {
  it('splits sentences', () => {
    expect(splitSentences('One here. Two there! Three? Yes.')).toEqual(['One here.', 'Two there!', 'Three?', 'Yes.'])
  })

  it('replaces dashes with commas', () => {
    expect(replaceDashes('We shipped — finally — in May.')).toBe('We shipped, finally, in May.')
  })
})
