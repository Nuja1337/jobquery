import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { EMPTY_PROFILE } from '@shared/defaults'
import type { Profile } from '@shared/types'
import { groundingIssues, groundingSource, lintText } from './lint'
import { renderProfile } from './prompts'
import profileFixture from './__fixtures__/profile.json'
import scopely from './__fixtures__/scopely-client-engineer.posting.json'

// Regression tests for the second code review (style check).

const profile: Profile = { ...EMPTY_PROFILE, ...(profileFixture as Partial<Profile>) }
const grounded = fs.readFileSync(fileURLToPath(new URL('./__fixtures__/letters/scopely-client-engineer.grounded.txt', import.meta.url)), 'utf8').trim()
const LINE = 'I added a small telemetry layer in C#'

function namesIn(letter: string, skills: string[], extra: string): string[] {
  const prof: Profile = { ...profile, skills: [...profile.skills, ...skills] }
  const source = groundingSource({ title: scopely.title, company: scopely.company, description: `${scopely.text}\n\n${extra}`, profile: renderProfile(prof, 'writing') })
  return groundingIssues(lintText(letter, { grounding: { source, kind: 'letter' } }))
    .filter((i) => /^The name /.test(i.message))
    .map((i) => i.message)
}

describe('F5: product names in camel case are looked up whole', () => {
  it('does not report GitHub or PlayStation as unsupported names', () => {
    const letter = grounded.replace(LINE, `${LINE} and ran its checks in GitHub Actions on every PlayStation build`)
    expect(namesIn(letter, ['GitHub Actions', 'PlayStation'], 'You will work with GitHub Actions and ship to PlayStation and Xbox.')).toEqual([])
  })

  it('does not report the pieces "Hub" or "Station"', () => {
    const letter = grounded.replace(LINE, `${LINE} and ran its checks in GitHub on every PlayStation build`)
    const messages = namesIn(letter, ['GitHub', 'PlayStation'], '')
    expect(messages.join(' ')).not.toMatch(/\b(?:Hub|Station)\b/)
  })

  it('looks the whole token up without regard to case', () => {
    const letter = grounded.replace(LINE, `${LINE} and ran its checks in Github on every Playstation build`)
    expect(namesIn(letter, ['GitHub', 'PlayStation'], '')).toEqual([])
  })

  it('still reports a whole name that neither the profile nor the posting has', () => {
    const letter = grounded.replace(LINE, `${LINE} and ran its checks in GitLab on every NintendoSwitch build`)
    const messages = namesIn(letter, [], '')
    expect(messages).toContain('The name GitLab is in neither the profile nor the posting.')
    expect(messages).toContain('The name NintendoSwitch is in neither the profile nor the posting.')
  })
})
