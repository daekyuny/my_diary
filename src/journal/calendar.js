import * as google from '../google.js';
// Google Calendar events for one diary date across the chosen calendars.
export async function eventsForDate(date, calendarIds) {
  const from = new Date(`${date}T00:00:00`),
    to = new Date(from);
  to.setDate(to.getDate() + 1);
  const incoming = [];
  for (const id of calendarIds) incoming.push(...(await google.events(id, from, to)));
  return incoming;
}
export function manualEvent(date) {
  return {
    key: `manual:${crypto.randomUUID()}`,
    title: '새 일정',
    note: '',
    start: date,
    end: date,
    allDay: true,
    manual: true,
  };
}
