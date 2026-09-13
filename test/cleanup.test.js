import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

process.env.GMAIL_MCP_DB_PATH = '/tmp/gmail-test-unused.db';

const { parseSender, aggregateSenders, parseUnsubscribeHeaders, collectMessageIds } =
  await import('../src/cleanup.js');
const { summarizeEvent } = await import('../src/calendar-client.js');

describe('parseSender', () => {
  it('handles display names, bare addresses and quotes', () => {
    assert.deepEqual(parseSender('Vercel <notifications@vercel.com>'), {
      name: 'Vercel',
      address: 'notifications@vercel.com',
    });
    assert.deepEqual(parseSender('"Janus Liu" <a@b.com>'), { name: 'Janus Liu', address: 'a@b.com' });
    assert.deepEqual(parseSender('NoReply@Example.com'), { name: '', address: 'noreply@example.com' });
  });
});

describe('aggregateSenders', () => {
  it('groups by address, counts unread, flags unsubscribe, keeps latest subject, sorts by volume', () => {
    const rows = [
      { from: 'A <a@x.com>', subject: 'old', date: 'Mon, 01 Jan 2024 00:00:00 +0000', listUnsubscribe: false, unread: true },
      { from: 'A <a@x.com>', subject: 'new', date: 'Tue, 01 Jul 2025 00:00:00 +0000', listUnsubscribe: true, unread: false },
      { from: 'b@y.com', subject: 'only', date: 'Wed, 01 Jan 2025 00:00:00 +0000', listUnsubscribe: false, unread: true },
    ];
    const out = aggregateSenders(rows);
    assert.equal(out.length, 2);
    assert.equal(out[0].address, 'a@x.com');
    assert.equal(out[0].count, 2);
    assert.equal(out[0].unread, 1);
    assert.equal(out[0].hasUnsubscribe, true);
    assert.equal(out[0].sampleSubject, 'new');
    assert.equal(out[1].address, 'b@y.com');
    assert.equal('latestTs' in out[0], false);
  });
});

describe('parseUnsubscribeHeaders', () => {
  it('extracts mailto and https targets and detects one-click', () => {
    const r = parseUnsubscribeHeaders(
      '<mailto:unsub@list.example.com?subject=unsubscribe>, <https://example.com/u/123>',
      'List-Unsubscribe=One-Click'
    );
    assert.equal(r.mailto, 'mailto:unsub@list.example.com?subject=unsubscribe');
    assert.equal(r.url, 'https://example.com/u/123');
    assert.equal(r.oneClick, true);
  });

  it('reports no one-click when the Post header is missing', () => {
    const r = parseUnsubscribeHeaders('<https://example.com/u/1>', '');
    assert.equal(r.oneClick, false);
    assert.equal(r.mailto, null);
  });

  it('handles empty headers', () => {
    assert.deepEqual(parseUnsubscribeHeaders('', ''), { mailto: null, url: null, oneClick: false });
  });
});

describe('collectMessageIds', () => {
  it('follows pagination and respects the cap', async () => {
    const pages = [
      { messages: [{ id: '1' }, { id: '2' }], nextPageToken: 'p2' },
      { messages: [{ id: '3' }, { id: '4' }], nextPageToken: 'p3' },
      { messages: [{ id: '5' }] },
    ];
    let call = 0;
    const gmail = { users: { messages: { list: async () => ({ data: pages[call++] }) } } };
    assert.deepEqual(await collectMessageIds(gmail, 'q', 3), ['1', '2', '3', '4'].slice(0, 4));
    call = 0;
    assert.deepEqual(await collectMessageIds(gmail, 'q', 10), ['1', '2', '3', '4', '5']);
  });
});

describe('summarizeEvent', () => {
  it('marks series and instances as recurring and picks date or dateTime', () => {
    const series = summarizeEvent({ id: 's', summary: 'Standup', recurrence: ['RRULE:FREQ=WEEKLY'], start: { dateTime: '2024-01-01T09:00:00Z' }, organizer: { email: 'o@x.com' } });
    assert.equal(series.recurring, true);
    assert.equal(series.start, '2024-01-01T09:00:00Z');
    const inst = summarizeEvent({ id: 'i', recurringEventId: 's', start: { date: '2024-01-08' } });
    assert.equal(inst.recurring, true);
    assert.equal(inst.summary, '(no title)');
    assert.equal(inst.start, '2024-01-08');
  });
});
