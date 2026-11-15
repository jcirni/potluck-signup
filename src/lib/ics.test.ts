import { describe, expect, it } from 'vitest'
import { buildICS } from './ics.ts'
import { DEFAULT_TARGETS, EMPTY_DIETARY_NEEDS, type PotluckEvent, type Signup } from './types.ts'

function event(partial: Partial<PotluckEvent>): PotluckEvent {
  return {
    id: 'friendsgiving',
    name: 'Friendsgiving',
    date: '2026-11-26',
    headcount: 12,
    targets: DEFAULT_TARGETS,
    dietaryNeeds: EMPTY_DIETARY_NEEDS,
    accent: 'brass',
    createdAt: '2026-11-14T00:00:00.000Z',
    ...partial,
  }
}

function signup(partial: Partial<Signup> & { id: string }): Signup {
  return {
    eventId: 'friendsgiving',
    name: 'Test',
    dish: 'Test dish',
    course: 'Mains',
    needOven: false,
    allergies: '',
    servings: 4,
    createdAt: '2026-11-14T00:00:00.000Z',
    ...partial,
  }
}

describe('buildICS', () => {
  it('produces a complete VEVENT with CRLF line endings', () => {
    const ics = buildICS(event({}), [])
    expect(ics).toContain('BEGIN:VCALENDAR\r\n')
    expect(ics).toContain('BEGIN:VEVENT\r\n')
    expect(ics).toContain('END:VEVENT\r\n')
    expect(ics).toContain('UID:friendsgiving@potluck-signup')
    expect(ics).toContain('SUMMARY:Friendsgiving')
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true)
  })

  it('ends the all-day event the day after, across month and year boundaries', () => {
    expect(buildICS(event({ date: '2026-11-30' }), [])).toContain('DTEND;VALUE=DATE:20261201')
    expect(buildICS(event({ date: '2026-12-31' }), [])).toContain('DTEND;VALUE=DATE:20270101')
  })

  it('escapes commas and semicolons in the event name and lists the menu', () => {
    const ics = buildICS(event({ name: 'Smith, Jones; Reunion' }), [
      signup({ id: '1', name: 'Joe', dish: 'Salmon' }),
      signup({ id: '2', name: 'Val', dish: 'Stuffing' }),
    ])
    expect(ics).toContain('SUMMARY:Smith\\, Jones\\; Reunion')
    expect(ics).toContain('Salmon (Joe)')
    expect(ics).toContain('Stuffing (Val)')
  })
})
