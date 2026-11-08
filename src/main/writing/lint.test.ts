import { describe, expect, it } from 'vitest'
import { blockingIssues, failureReason, isBetterLint, issuesToInstructions, lintPasses, lintText, splitSentences, topIssue } from './lint'
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

const PLAIN = 'I rebuilt the billing system at Ledgerly after a weekend of double charges. The retry fix cut failed payments by 40 percent, and I wrote the nightly check that still runs.'

describe('blockingIssues', () => {
  it('passes plain text', () => {
    const report = lintText(PLAIN)
    expect(blockingIssues(report)).toEqual([])
    expect(lintPasses(report, 80)).toBe(true)
  })

  it('blocks the 88-scoring template opener even though its score passes', () => {
    const report = lintText(`I am writing to express my interest in this role. ${PLAIN}`)
    expect(report.score).toBeGreaterThanOrEqual(80)
    expect(blockingIssues(report).map((i) => i.rule)).toEqual(['phrase:i am writing to express my interest'])
    expect(lintPasses(report, 80)).toBe(false)
  })

  it.each([
    ['passionate about', 'I am passionate about payment systems.'],
    ['my passion for', 'My passion for payment systems started at Ledgerly.'],
    ['excited about the opportunity', 'I am excited about the opportunity to build payment tools.'],
    ['i am confident that', 'I am confident that the retry fix will carry over.'],
    ["i'm confident that", "I'm confident that the retry fix will carry over."],
    ['eager to contribute', 'I am eager to contribute to the payments team.']
  ])('blocks the template opener "%s"', (phrase, sentence) => {
    const report = lintText(`${PLAIN} ${sentence}`)
    const hit = report.issues.find((i) => i.rule === `phrase:${phrase}`)
    expect(hit?.severity).toBe('high')
    expect(blockingIssues(report)).toContain(hit)
  })

  it.each([
    ['em-dash', `${PLAIN} The fix was small — one flag.`],
    ['not-x-but-y', `${PLAIN} We did not only ship, but also cut costs.`],
    ['its-not-x-its-y', `${PLAIN} It's not a rewrite, it's a repair.`],
    ['placeholder', `${PLAIN} I would like to join [Company Name].`],
    ['markdown', `${PLAIN}

**Key skills**`],
    ['emoji', `${PLAIN} Thanks 🙂`],
    ['as-a-opener', `As a senior engineer with six years of experience, ${PLAIN.charAt(0).toLowerCase()}${PLAIN.slice(1)}`]
  ])('blocks %s', (rule, text) => {
    const report = lintText(text)
    expect(blockingIssues(report).map((i) => i.rule)).toContain(rule)
    expect(lintPasses(report, 0)).toBe(false)
  })

  it('does not block medium and low issues, which only cost points', () => {
    const report = lintText(`${PLAIN} This was really a good result; the team agreed.`)
    expect(report.issues.length).toBeGreaterThan(0)
    expect(blockingIssues(report)).toEqual([])
  })

  it('also needs the minimum score', () => {
    const report = lintText(PLAIN)
    expect(lintPasses(report, report.score + 1)).toBe(false)
  })

  it('prefers a text with fewer blocking issues even when its score is lower', () => {
    const blocked = lintText(`I am writing to express my interest in this role. ${PLAIN}`)
    const clean = lintText(`${PLAIN} This was really a good result; the team agreed. It was just simply actually fine. We leveraged a robust and truly seamless setup.`)
    expect(clean.score).toBeLessThan(blocked.score)
    expect(isBetterLint(clean, blocked)).toBe(true)
    expect(isBetterLint(blocked, clean)).toBe(false)
    // With the same blocking count, the score decides.
    expect(isBetterLint(lintText(PLAIN), clean)).toBe(true)
  })

  it('names the blocking issue first and lists blocking issues first in revision notes', () => {
    const report = lintText(`This is really a good result. ${PLAIN} I am writing to express my interest in this role.`)
    expect(topIssue(report)?.rule).toBe('phrase:i am writing to express my interest')
    expect(failureReason(report, 80)).toContain('I am writing to express my interest')
    expect(issuesToInstructions(report, 1)).toContain('I am writing to express my interest')
  })

  it('explains a score-only failure with the score', () => {
    const report = lintText(PLAIN)
    expect(failureReason({ ...report, score: 70, issues: [] }, 80)).toBe('Its score is 70 and the minimum is 80.')
  })
})
