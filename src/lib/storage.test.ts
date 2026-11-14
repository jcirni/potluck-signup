import { describe, expect, it } from 'vitest'
import { cleanEvent, cleanSignup } from './storage.ts'
import { DEFAULT_TARGETS, EMPTY_DIETARY_NEEDS } from './types.ts'

function rawSignup(partial: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 's1',
    eventId: 'friendsgiving',
    name: 'Joe',
    dish: 'Salmon',
    course: 'Mains',
    needOven: true,
    allergies: 'None',
    servings: 8,
    createdAt: '2026-11-14T00:00:00.000Z',
    ...partial,
  }
}

function rawEvent(partial: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'friendsgiving',
    name: 'Friendsgiving',
    date: '2026-11-26',
    headcount: 12,
    targets: { ...DEFAULT_TARGETS },
    createdAt: '2026-11-14T00:00:00.000Z',
    ...partial,
  }
}

describe('cleanSignup', () => {
  it('accepts a valid signup and preserves dishId, scale, and the edit token hash', () => {
    const s = cleanSignup(rawSignup({ dishId: 'baked-salmon', scale: 2, editTokenHash: 'abc123' }))
    expect(s).toMatchObject({ id: 's1', dishId: 'baked-salmon', scale: 2, editTokenHash: 'abc123', needOven: true })
  })

  it('fills defaults for optional fields', () => {
    const s = cleanSignup({ id: 's2', eventId: 'e', name: 'A', dish: 'Pie', course: 'Desserts' })
    expect(s).toMatchObject({ allergies: '', servings: 0, needOven: false })
    expect(s?.dishId).toBeUndefined()
    expect(s?.scale).toBeUndefined()
  })

  it('rejects non-objects, missing fields, and unknown courses', () => {
    expect(cleanSignup(null)).toBeNull()
    expect(cleanSignup('nope')).toBeNull()
    expect(cleanSignup(rawSignup({ name: undefined }))).toBeNull()
    expect(cleanSignup(rawSignup({ course: 'Snacks' }))).toBeNull()
    expect(cleanSignup(rawSignup({ eventId: undefined }))).toBeNull()
  })

  it('rejects fields longer than the database limits', () => {
    expect(cleanSignup(rawSignup({ name: 'n'.repeat(81) }))).toBeNull()
    expect(cleanSignup(rawSignup({ name: '' }))).toBeNull()
    expect(cleanSignup(rawSignup({ dish: 'd'.repeat(121) }))).toBeNull()
    expect(cleanSignup(rawSignup({ allergies: 'a'.repeat(201) }))).toBeNull()
    expect(cleanSignup(rawSignup({ dishId: 'x'.repeat(81) }))).toBeNull()
    expect(cleanSignup(rawSignup({ name: 'n'.repeat(80) }))).not.toBeNull()
    expect(cleanSignup(rawSignup({ allergies: 'a'.repeat(200) }))).not.toBeNull()
  })

  it('rejects out-of-range recipe scales but accepts the boundaries', () => {
    expect(cleanSignup(rawSignup({ scale: 0 }))).toBeNull()
    expect(cleanSignup(rawSignup({ scale: 11 }))).toBeNull()
    expect(cleanSignup(rawSignup({ scale: 10 }))).not.toBeNull()
    expect(cleanSignup(rawSignup({ scale: 0.5 }))).not.toBeNull()
  })
})

describe('cleanEvent', () => {
  it('accepts a valid event and keeps its fields', () => {
    const e = cleanEvent(rawEvent({ dietaryNeeds: { vegetarian: 2, vegan: 1, glutenFree: 0, noPork: 3 } }))
    expect(e).toMatchObject({ id: 'friendsgiving', name: 'Friendsgiving', date: '2026-11-26', headcount: 12 })
    expect(e?.dietaryNeeds).toEqual({ vegetarian: 2, vegan: 1, glutenFree: 0, noPork: 3 })
  })

  it('defaults dietaryNeeds when missing and fills gaps when partial', () => {
    expect(cleanEvent(rawEvent())?.dietaryNeeds).toEqual(EMPTY_DIETARY_NEEDS)
    expect(cleanEvent(rawEvent({ dietaryNeeds: { vegan: 2 } }))?.dietaryNeeds).toEqual({
      vegetarian: 0,
      vegan: 2,
      glutenFree: 0,
      noPork: 0,
    })
  })

  it('defaults date and headcount when absent', () => {
    const e = cleanEvent({ id: 'x', name: 'X', targets: { ...DEFAULT_TARGETS } })
    expect(e).toMatchObject({ date: '', headcount: 0 })
  })

  it('rejects non-objects, missing targets, and over-length names', () => {
    expect(cleanEvent(null)).toBeNull()
    expect(cleanEvent(rawEvent({ targets: undefined }))).toBeNull()
    expect(cleanEvent(rawEvent({ targets: { Mains: 3 } }))).toBeNull()
    expect(cleanEvent(rawEvent({ name: 'n'.repeat(121) }))).toBeNull()
    expect(cleanEvent(rawEvent({ name: 'n'.repeat(120) }))).not.toBeNull()
  })
})
