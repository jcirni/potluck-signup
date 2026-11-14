import type { PotluckEvent, Signup } from './types.ts'

function icsEscape(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n')
}

function nextDay(date: string): string {
  const d = new Date(`${date}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10).replace(/-/g, '')
}

/** Build an .ics file for the event ('' when it has no date yet). All-day; the description carries the menu. */
export function buildICS(event: PotluckEvent, signups: Signup[]): string {
  if (!event.date) return ''
  const start = event.date.replace(/-/g, '')
  const menu = signups.map((s) => `${s.dish} (${s.name})`).join('\\n')
  const description = menu ? `Menu so far:\\n${menu}` : 'Potluck signup is open.'
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Potluck Signup//EN',
    'BEGIN:VEVENT',
    `UID:${event.id}@potluck-signup`,
    `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}`,
    `DTSTART;VALUE=DATE:${start}`,
    `DTEND;VALUE=DATE:${nextDay(event.date)}`,
    `SUMMARY:${icsEscape(event.name)}`,
    `DESCRIPTION:${icsEscape(description)}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ]
  return `${lines.join('\r\n')}\r\n`
}
