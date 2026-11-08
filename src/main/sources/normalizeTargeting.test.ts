import { describe, expect, it } from 'vitest'
import { detectRemote, findSalaryInText, htmlToPlain, inferRemote, parseSalary } from './normalize'

describe('remote words in titles', () => {
  it('does not read Distributed Systems or Remote Sensing as a remote job', () => {
    expect(detectRemote('Distributed Systems Engineer')).toBe('unknown')
    expect(detectRemote('Senior Distributed Database Engineer')).toBe('unknown')
    expect(detectRemote('Remote Sensing Engineer')).toBe('unknown')
    expect(detectRemote('Remote Control Software Engineer')).toBe('unknown')
    expect(detectRemote('Remote Desktop Developer')).toBe('unknown')
    expect(inferRemote({ location: 'Boulder, CO', title: 'Remote Sensing Scientist' })).toBe('unknown')
  })

  it('still reads remote jobs', () => {
    expect(detectRemote('Remote Sensing Engineer (Remote)')).toBe('remote')
    expect(detectRemote('Distributed Systems Engineer - Remote')).toBe('remote')
    expect(detectRemote('Distributed')).toBe('remote')
    expect(detectRemote('Distributed - US')).toBe('remote')
    expect(detectRemote('Engineer (Distributed)')).toBe('remote')
    expect(detectRemote('Join our distributed team')).toBe('remote')
    expect(detectRemote('Remote-first')).toBe('remote')
  })
})

describe('pay that is not salary', () => {
  it('skips bonus and relocation ranges', () => {
    expect(findSalaryInText('Relocation bonus of up to $5,000 - $10,000.')).toBeNull()
    expect(findSalaryInText('Signing bonus: $10,000 - $20,000 paid in the first month.')).toBeNull()
    expect(findSalaryInText('A $5,000 - $10,000 relocation package is available.')).toBeNull()
    expect(findSalaryInText('Annual bonus of $10k-$20k.')).toBeNull()
    expect(parseSalary('Bonus $10k', { fieldOnly: true })).toBeNull()
  })

  it('takes the salary when a bonus is named next to it', () => {
    expect(findSalaryInText('Base salary $120,000 - $150,000 plus a bonus of $10,000 - $20,000.')).toEqual({ min: 120000, max: 150000, currency: 'USD' })
    expect(findSalaryInText('Relocation is offered. Salary $100,000 - $130,000.')).toEqual({ min: 100000, max: 130000, currency: 'USD' })
    expect(findSalaryInText('$120,000 - $150,000 bonus eligible')).toEqual({ min: 120000, max: 150000, currency: 'USD' })
    expect(findSalaryInText('Signing bonus and salary: $120,000 - $150,000')).toEqual({ min: 120000, max: 150000, currency: 'USD' })
    expect(findSalaryInText('The base range is $87,069-$124,385 plus equity.')).toEqual({ min: 87069, max: 124385, currency: 'USD' })
  })

  it('finds the salary after a skipped bonus range', () => {
    expect(findSalaryInText('Relocation bonus $5,000 - $10,000. Salary $110,000 - $140,000.')).toEqual({ min: 110000, max: 140000, currency: 'USD' })
  })
})

describe('bare list items', () => {
  it('puts each bare <li> on its own line', () => {
    expect(htmlToPlain('<li>Write C++</li><li>Ship games</li>')).toBe(' * Write C++\n * Ship games'.trim())
  })

  it('leaves real lists alone', () => {
    expect(htmlToPlain('<ul><li>One</li><li>Two</li></ul>')).toBe('* One\n * Two')
  })
})
