import { describe, expect, it } from 'vitest'
import { makeTestEnv } from '../../testing'

describe('AnswerBankRepo topics', () => {
  it('classifies a question on save and stores the topic and scope', async () => {
    const { ctx } = await makeTestEnv()
    const why = ctx.answers.save({ question: 'Why Anthropic?', answer: 'Because of the safety work.', kind: 'template' })
    expect(why).toMatchObject({ topic: 'why_company', scope: null })
    const salary = ctx.answers.save({ question: 'Expected salary (USD)', answer: '120000', kind: 'fact' })
    expect(salary).toMatchObject({ topic: 'salary_expectation', scope: 'USD' })
    const years = ctx.answers.save({ question: 'How many years of experience do you have with React?', answer: '6', kind: 'fact' })
    expect(years).toMatchObject({ topic: 'years', scope: 'react' })
    expect(ctx.answers.save({ question: 'Favorite color?', answer: 'Green', kind: 'fact' })).toMatchObject({ topic: null, scope: null })
  })

  it('keeps a topic the caller gives, and a caller can ask for none', async () => {
    const { ctx } = await makeTestEnv()
    const given = ctx.answers.save({ question: 'Your stance on AI help', answer: 'I proofread with AI.', kind: 'fact', topic: 'ai_use_disclosure', scope: null })
    expect(given.topic).toBe('ai_use_disclosure')
    const none = ctx.answers.save({ question: 'Why Anthropic?', answer: 'x', kind: 'template', topic: null })
    expect(none.topic).toBeNull()
  })

  it('classifies again when the question is edited', async () => {
    const { ctx } = await makeTestEnv()
    const entry = ctx.answers.save({ question: 'Favorite color?', answer: 'Green', kind: 'fact' })
    const edited = ctx.answers.save({ id: entry.id, question: 'What is your notice period?', answer: 'Four weeks', kind: 'fact' })
    expect(edited.topic).toBe('notice_period')
  })

  it('finds an answer by topic when the wording differs', async () => {
    const { ctx } = await makeTestEnv()
    const notice = ctx.answers.save({ question: 'What is your notice period?', answer: 'Four weeks', kind: 'fact' })
    expect(ctx.answers.findBest('How much notice do you need to give your current employer?')?.id).toBe(notice.id)
  })

  it('reuses an AI-use or criminal-history answer only for the same question', async () => {
    const { ctx } = await makeTestEnv()
    const stance = ctx.answers.save({ question: 'Did you use AI on this application?', answer: 'I used AI to proofread.', kind: 'fact' })
    expect(ctx.answers.findBest('Did you use AI on this application?')?.id).toBe(stance.id)
    expect(ctx.answers.findBest('AI Policy for Application')).toBeNull()
    const record = ctx.answers.save({ question: 'Have you ever been convicted of a crime?', answer: 'No', kind: 'fact' })
    expect(ctx.answers.findBest('Have you ever been convicted of a felony?')).toBeNull()
    expect(ctx.answers.findBest('Have you ever been convicted of a crime?')?.id).toBe(record.id)
  })

  it('does not hand a saved criminal-history answer to a question that asks for consent to a background check', async () => {
    const { ctx } = await makeTestEnv()
    ctx.answers.save({ question: 'Have you ever been convicted of a crime?', answer: 'No', kind: 'fact' })
    expect(ctx.answers.findBest('Do you consent to a criminal background check?')).toBeNull()
    expect(ctx.answers.findBest('Do you consent to a criminal background check?', { fieldType: 'radio' })).toBeNull()
  })

  it('does not hand a saved AI-use answer to a question that asks to certify no AI was used', async () => {
    const { ctx } = await makeTestEnv()
    ctx.answers.save({ question: 'Did you use AI to help with this application?', answer: 'Yes', kind: 'fact' })
    expect(ctx.answers.findBest('Do you certify that you did not use AI tools to write this application?')).toBeNull()
  })

  it('reuses by topic for a yes/no or choice field only when the question is the same', async () => {
    const { ctx } = await makeTestEnv()
    const saved = ctx.answers.save({ question: 'Are you legally authorized to work in the United States?', answer: 'Yes', kind: 'fact' })
    expect(ctx.answers.findBest('Are you authorized to work in the US?')?.id).toBe(saved.id)
    expect(ctx.answers.findBest('Are you authorized to work in the US?', { fieldType: 'radio' })).toBeNull()
    expect(ctx.answers.findBest('Are you authorized to work in the US?', { fieldType: 'select' })).toBeNull()
    expect(ctx.answers.findBest('Are you legally authorized to work in the United States?', { fieldType: 'radio' })?.id).toBe(saved.id)
    expect(ctx.answers.findBest('Are you authorized to work in the US?', { exact: true })).toBeNull()
  })

  it('refuses a topic match when only one question asks to agree, certify or consent', async () => {
    const { ctx } = await makeTestEnv()
    ctx.answers.save({ question: 'What is your notice period?', answer: 'Four weeks', kind: 'fact' })
    expect(ctx.answers.findBest('Do you agree to give four weeks notice? What is your notice period?')).toBeNull()
    expect(ctx.answers.findBest('How much notice do you need to give?')).not.toBeNull()
  })

  it('matches the scope exactly', async () => {
    const { ctx } = await makeTestEnv()
    const usd = ctx.answers.save({ question: 'Expected salary (USD)', answer: '120000', kind: 'fact' })
    const eur = ctx.answers.save({ question: 'Expected salary (EUR)', answer: '100000', kind: 'fact' })
    expect(ctx.answers.findBest('Salary expectations in USD')?.id).toBe(usd.id)
    expect(ctx.answers.findBest('Desired compensation (EUR)')?.id).toBe(eur.id)
    expect(ctx.answers.findBest('Desired compensation (GBP)')).toBeNull()
    expect(ctx.answers.findBest('What are your salary expectations?')).toBeNull()
  })

  it('does not reuse a fact about one company for another, but does reuse a template', async () => {
    const { ctx } = await makeTestEnv()
    const fact = ctx.answers.save({ question: 'Why Anthropic?', answer: 'Anthropic does safety work.', kind: 'fact' })
    expect(ctx.answers.findBest('Why do you want to work at Stripe?')).toBeNull()
    expect(ctx.answers.findBest('Why Anthropic?')?.id).toBe(fact.id)
    const template = ctx.answers.save({ question: 'Why this company?', answer: 'I like small teams.', kind: 'template' })
    expect(ctx.answers.findBest('Why do you want to work at Stripe?')?.id).toBe(template.id)
  })

  it('prefers the exact question over the topic, and falls back to the close match', async () => {
    const { ctx } = await makeTestEnv()
    const a = ctx.answers.save({ question: 'Are you authorized to work in the US?', answer: 'Yes', kind: 'fact' })
    ctx.answers.save({ question: 'Are you legally authorized to work in the United States?', answer: 'Yes, citizen', kind: 'fact' })
    expect(ctx.answers.findBest('Are you authorized to work in the US?')?.id).toBe(a.id)
    const close = ctx.answers.save({ question: 'Do you enjoy hiking in the mountains on weekends?', answer: 'Yes', kind: 'fact' })
    expect(ctx.answers.findBest('Do you enjoy hiking in the mountains on weekends')?.id).toBe(close.id)
  })

  it('lists the topic with each entry', async () => {
    const { ctx } = await makeTestEnv()
    const entry = ctx.answers.save({ question: 'What is your notice period?', answer: 'Four weeks', kind: 'fact' })
    expect(ctx.answers.list().find((e) => e.id === entry.id)?.topic).toBe('notice_period')
  })
})
