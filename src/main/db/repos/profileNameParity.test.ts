import { describe, expect, it } from 'vitest'
import { splitFullName as editorSplit } from '../../../renderer/src/components/workFactsHelpers'
import { splitFullName } from './profile'

// The Profile editor prefills the name parts with its own copy of the split. Both must agree.
describe('name split parity', () => {
  it('matches the editor split', () => {
    for (const name of ['Alex Rivera', 'Mary Ann Smith', 'Juan Carlos García López', 'Cher', '  ']) expect(editorSplit(name)).toEqual(splitFullName(name))
  })
})
