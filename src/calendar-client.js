/**
 * Google Calendar helpers, sharing the per-account OAuth client with Gmail.
 * Requires the calendar.events scope (re-authenticate accounts added before it).
 */
import { google } from 'googleapis';
import { getAuthenticatedClient, wrapTokenError } from './auth.js';

async function getCalendar(email) {
  const auth = await getAuthenticatedClient(email);
  return google.calendar({ version: 'v3', auth });
}

async function run(email, fn) {
  try {
    return await fn();
  } catch (err) {
    wrapTokenError(email, err);
  }
}

export async function listCalendars(email) {
  const cal = await getCalendar(email);
  return run(email, async () => {
    const { data } = await cal.calendarList.list();
    return (data.items ?? []).map(c => ({
      id: c.id,
      summary: c.summary,
      primary: !!c.primary,
      accessRole: c.accessRole,
    }));
  });
}

// Pure: shapes an API event into the compact form the tools print.
export function summarizeEvent(e) {
  return {
    id: e.id,
    summary: e.summary ?? '(no title)',
    status: e.status,
    organizer: e.organizer?.email ?? '',
    creator: e.creator?.email ?? '',
    start: e.start?.dateTime ?? e.start?.date ?? '',
    recurring: !!(e.recurrence?.length || e.recurringEventId),
    recurrence: e.recurrence ?? [],
    attendees: (e.attendees ?? []).length,
  };
}

// Lists events. With recurringOnly=true, returns the recurring *series* (not instances),
// which is what you delete to stop a series for good.
export async function listCalendarEvents(
  email,
  { calendarId = 'primary', query, timeMin, timeMax, max = 100, recurringOnly = false } = {}
) {
  const cal = await getCalendar(email);
  return run(email, async () => {
    const out = [];
    let pageToken;
    while (out.length < max) {
      const { data } = await cal.events.list({
        calendarId,
        q: query,
        timeMin,
        timeMax,
        maxResults: Math.min(250, max - out.length),
        singleEvents: !recurringOnly,
        showDeleted: false,
        pageToken,
        ...(recurringOnly ? {} : { orderBy: 'startTime' }),
      });
      for (const e of data.items ?? []) {
        const s = summarizeEvent(e);
        if (!recurringOnly || s.recurrence.length) out.push(s);
      }
      pageToken = data.nextPageToken;
      if (!pageToken) break;
    }
    return out;
  });
}

export async function getCalendarEvent(email, eventId, calendarId = 'primary') {
  const cal = await getCalendar(email);
  return run(email, async () => {
    const { data } = await cal.events.get({ calendarId, eventId });
    return { ...summarizeEvent(data), description: data.description ?? '' };
  });
}

// Deletes an event. For a recurring series, pass the series ID (from recurringOnly listing)
// to remove every occurrence.
export async function deleteCalendarEvent(email, eventId, calendarId = 'primary') {
  const cal = await getCalendar(email);
  return run(email, async () => {
    await cal.events.delete({ calendarId, eventId, sendUpdates: 'none' });
    return { id: eventId, deleted: true };
  });
}
