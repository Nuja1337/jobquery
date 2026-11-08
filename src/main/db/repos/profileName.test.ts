import { describe, expect, it } from 'vitest'
import { makeProfile, makeTestEnv } from '../../testing'
import { splitFullName } from './profile'

// Regression tests for the second code review (name parts).

describe('F14: splitting the full name', () => {
  it('takes the first word as the first name and the rest as the last name', () => {
    expect(splitFullName('Juan Carlos García López')).toEqual({ first: 'Juan', last: 'Carlos García López' })
    expect(splitFullName('Mary Ann  Smith')).toEqual({ first: 'Mary', last: 'Ann Smith' })
    expect(splitFullName('Alex Rivera')).toEqual({ first: 'Alex', last: 'Rivera' })
    expect(splitFullName('Cher')).toEqual({ first: '', last: '' })
  })

  it('re-splits from a new full name when the stored parts are the split of the old one', async () => {
    const { ctx } = await makeTestEnv()
    ctx.profile.save(makeProfile({ fullName: 'Sam Rivera' }))
    expect(ctx.profile.get().profile.name).toMatchObject({ first: 'Sam', last: 'Rivera' })
    const saved = ctx.profile.save({ ...ctx.profile.get().profile, fullName: 'Samuel Rivera Jones' })
    expect(saved.profile.name).toMatchObject({ first: 'Samuel', middle: '', last: 'Rivera Jones' })
  })

  it('keeps parts the owner typed by hand', async () => {
    const { ctx } = await makeTestEnv()
    ctx.profile.save(makeProfile({ fullName: 'Sam Rivera' }))
    const typed = { ...ctx.profile.get().profile, name: { ...ctx.profile.get().profile.name, last: 'Rivera-Jones' } }
    ctx.profile.save(typed)
    const saved = ctx.profile.save({ ...ctx.profile.get().profile, fullName: 'Samuel Rivera' })
    expect(saved.profile.name).toMatchObject({ first: 'Sam', last: 'Rivera-Jones' })
  })

  it('re-splits names that the earlier last-word split saved', async () => {
    const { ctx } = await makeTestEnv()
    ctx.profile.save({ ...makeProfile({ fullName: 'Juan Carlos García López' }), name: { first: 'Juan', middle: '', last: 'López', preferred: '', pronunciation: '' } })
    const saved = ctx.profile.save({ ...ctx.profile.get().profile, fullName: 'Juan Carlos García' })
    expect(saved.profile.name).toMatchObject({ first: 'Juan', last: 'Carlos García' })
  })
})
