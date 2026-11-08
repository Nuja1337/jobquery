import { describe, expect, it } from 'vitest'
import { EMPTY_PROFILE } from '@shared/defaults'
import { nameParts, splitFullName } from './workFactsHelpers'

// The editor splits a name the same way the main process does. The parity check lives in
// src/main/db/repos/profileNameParity.test.ts, so this file never pulls main-process code into the renderer build.
describe('name split in the editor', () => {
  it('takes the first word as first name and the rest as last name', () => {
    expect(splitFullName('Juan Carlos García López')).toEqual({ first: 'Juan', last: 'Carlos García López' })
    expect(nameParts({ fullName: 'Mary Ann Smith', name: EMPTY_PROFILE.name })).toMatchObject({ first: 'Mary', middle: '', last: 'Ann Smith' })
  })
})
