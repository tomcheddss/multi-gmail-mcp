/**
 * Inbox-cleanup helpers: sender statistics, bulk label changes, unsubscribe,
 * and Gmail filters. Everything here is built for triage across many messages.
 */
import { google } from 'googleapis';
import { getAuthenticatedClient, wrapTokenError } from './auth.js';
import { getHeader, buildRaw } from './gmail-client.js';

const BATCH = 1000; // Gmail batchModify hard limit
const META_CONCURRENCY = 8;

async function getGmail(email) {
  const auth = await getAuthenticatedClient(email);
  return google.gmail({ version: 'v1', auth });
}

async function run(email, fn) {
  try {
    return await fn();
  } catch (err) {
    wrapTokenError(email, err);
  }
}

// Collects up to `max` message IDs matching a query, following pagination.
export async function collectMessageIds(gmail, query, max) {
  const ids = [];
  let pageToken;
  while (ids.length < max) {
    const { data } = await withBackoff(() =>
      gmail.users.messages.list({
        userId: 'me',
        q: query,
        maxResults: Math.min(500, max - ids.length),
        pageToken,
      })
    );
    for (const m of data.messages ?? []) ids.push(m.id);
    pageToken = data.nextPageToken;
    if (!pageToken || !data.messages?.length) break;
  }
  return ids;
}

function isRateLimit(err) {
  const msg = (err?.message ?? '').toLowerCase();
  return err?.code === 429 || err?.status === 429 ||
    msg.includes('quota exceeded') || msg.includes('rate limit') || msg.includes('user-rate limit');
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Retries a Gmail call on rate-limit errors with exponential backoff (up to ~1 min total).
export async function withBackoff(fn, { retries = 6, baseMs = 1000 } = {}) {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (!isRateLimit(err) || attempt >= retries) throw err;
      await sleep(baseMs * 2 ** attempt + Math.random() * 250);
      attempt += 1;
    }
  }
}

// Bounded-concurrency map that stops scheduling new work as soon as one item fails.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  let failed = null;
  async function worker() {
    while (next < items.length && !failed) {
      const i = next++;
      try {
        out[i] = await fn(items[i], i);
      } catch (err) {
        failed = failed ?? err;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failed) throw failed;
  return out;
}

// Pure: "Name <addr>" -> { name, address }
export function parseSender(from) {
  const raw = String(from ?? '').trim();
  const angle = raw.match(/^(.*?)<([^<>]+)>\s*$/);
  if (angle) {
    return {
      name: angle[1].trim().replace(/^"|"$/g, '').trim(),
      address: angle[2].trim().toLowerCase(),
    };
  }
  return { name: '', address: raw.toLowerCase() };
}

// Pure: aggregates metadata rows into per-sender stats, sorted by count desc.
export function aggregateSenders(rows) {
  const map = new Map();
  for (const r of rows) {
    const { name, address } = parseSender(r.from);
    if (!address) continue;
    const s = map.get(address) ?? {
      address,
      name,
      count: 0,
      unread: 0,
      hasUnsubscribe: false,
      latest: '',
      sampleSubject: '',
    };
    s.count += 1;
    if (r.unread) s.unread += 1;
    if (r.listUnsubscribe) s.hasUnsubscribe = true;
    if (!s.name && name) s.name = name;
    const ts = Date.parse(r.date);
    if (!Number.isNaN(ts) && (!s.latestTs || ts > s.latestTs)) {
      s.latestTs = ts;
      s.latest = r.date;
      s.sampleSubject = r.subject;
    } else if (!s.sampleSubject) {
      s.sampleSubject = r.subject;
    }
    map.set(address, s);
  }
  return [...map.values()]
    .map(({ latestTs, ...rest }) => rest)
    .sort((a, b) => b.count - a.count);
}

// Samples up to `sampleSize` messages matching `query` and returns per-sender stats.
export async function senderStats(email, query = 'in:inbox', sampleSize = 500) {
  const gmail = await getGmail(email);
  return run(email, async () => {
    const ids = await collectMessageIds(gmail, query, sampleSize);
    const rows = await mapLimit(ids, META_CONCURRENCY, async id => {
      const { data: msg } = await withBackoff(() =>
        gmail.users.messages.get({
          userId: 'me',
          id,
          format: 'metadata',
          metadataHeaders: ['From', 'Subject', 'Date', 'List-Unsubscribe'],
        })
      );
      const h = msg.payload?.headers;
      return {
        from: getHeader(h, 'From'),
        subject: getHeader(h, 'Subject'),
        date: getHeader(h, 'Date'),
        listUnsubscribe: !!getHeader(h, 'List-Unsubscribe'),
        unread: (msg.labelIds ?? []).includes('UNREAD'),
      };
    });
    return { sampled: ids.length, senders: aggregateSenders(rows) };
  });
}

// Applies label changes to every message matching `query` (capped at `max`).
// dryRun returns the count only.
export async function bulkModify(
  email,
  query,
  { addLabelIds = [], removeLabelIds = [] },
  { max = 1000, dryRun = false } = {}
) {
  if (!query || !query.trim()) throw new Error('A non-empty query is required for bulk operations.');
  const gmail = await getGmail(email);
  return run(email, async () => {
    const ids = await collectMessageIds(gmail, query, max);
    if (dryRun || !ids.length) return { matched: ids.length, modified: 0, dryRun };
    for (let i = 0; i < ids.length; i += BATCH) {
      await withBackoff(() =>
        gmail.users.messages.batchModify({
          userId: 'me',
          requestBody: { ids: ids.slice(i, i + BATCH), addLabelIds, removeLabelIds },
        })
      );
    }
    return { matched: ids.length, modified: ids.length, dryRun: false };
  });
}

// Pure: parses List-Unsubscribe / List-Unsubscribe-Post headers.
export function parseUnsubscribeHeaders(listUnsubscribe, listUnsubscribePost) {
  const targets = [...String(listUnsubscribe ?? '').matchAll(/<([^>]+)>/g)].map(m => m[1].trim());
  const mailto = targets.find(t => t.toLowerCase().startsWith('mailto:'));
  const https = targets.find(t => /^https?:\/\//i.test(t));
  const oneClick =
    !!https && /list-unsubscribe=one-click/i.test(String(listUnsubscribePost ?? ''));
  return { mailto: mailto ?? null, url: https ?? null, oneClick };
}

export async function getUnsubscribeInfo(email, messageId) {
  const gmail = await getGmail(email);
  return run(email, async () => {
    const { data: msg } = await gmail.users.messages.get({
      userId: 'me',
      id: messageId,
      format: 'metadata',
      metadataHeaders: ['From', 'Subject', 'List-Unsubscribe', 'List-Unsubscribe-Post'],
    });
    const h = msg.payload?.headers;
    return {
      from: getHeader(h, 'From'),
      subject: getHeader(h, 'Subject'),
      ...parseUnsubscribeHeaders(
        getHeader(h, 'List-Unsubscribe'),
        getHeader(h, 'List-Unsubscribe-Post')
      ),
    };
  });
}

// Unsubscribes using the message's headers. Prefers RFC 8058 one-click POST,
// then mailto:, otherwise returns the URL for the user to open manually.
export async function unsubscribe(email, messageId) {
  const info = await getUnsubscribeInfo(email, messageId);
  if (!info.mailto && !info.url) {
    return { ...info, method: 'none', done: false };
  }
  if (info.url && info.oneClick) {
    const res = await fetch(info.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'List-Unsubscribe=One-Click',
      redirect: 'follow',
    });
    return { ...info, method: 'one-click', done: res.ok, status: res.status };
  }
  if (info.mailto) {
    const u = new URL(info.mailto);
    const to = u.pathname;
    const subject = u.searchParams.get('subject') ?? 'unsubscribe';
    const gmail = await getGmail(email);
    await run(email, () =>
      gmail.users.messages.send({
        userId: 'me',
        requestBody: { raw: buildRaw({ from: email, to, subject, body: 'unsubscribe' }) },
      })
    );
    return { ...info, method: 'mailto', done: true };
  }
  return { ...info, method: 'manual', done: false };
}

// --- Labels and filters -----------------------------------------------------

export async function ensureLabel(email, name) {
  const gmail = await getGmail(email);
  return run(email, async () => {
    const { data } = await gmail.users.labels.list({ userId: 'me' });
    const existing = (data.labels ?? []).find(l => l.name.toLowerCase() === name.toLowerCase());
    if (existing) return { id: existing.id, name: existing.name, created: false };
    const { data: created } = await gmail.users.labels.create({
      userId: 'me',
      requestBody: {
        name,
        labelListVisibility: 'labelShow',
        messageListVisibility: 'show',
      },
    });
    return { id: created.id, name: created.name, created: true };
  });
}

export async function listFilters(email) {
  const gmail = await getGmail(email);
  return run(email, async () => {
    const { data } = await gmail.users.settings.filters.list({ userId: 'me' });
    return data.filter ?? [];
  });
}

export async function createFilter(
  email,
  { from, to, subject, query, addLabel, skipInbox = false, markRead = false, trash = false }
) {
  if (!from && !to && !subject && !query) {
    throw new Error('Provide at least one of from, to, subject, or query.');
  }
  const gmail = await getGmail(email);
  const addLabelIds = [];
  const removeLabelIds = [];
  if (addLabel) addLabelIds.push((await ensureLabel(email, addLabel)).id);
  if (trash) addLabelIds.push('TRASH');
  if (skipInbox) removeLabelIds.push('INBOX');
  if (markRead) removeLabelIds.push('UNREAD');
  return run(email, async () => {
    const { data } = await gmail.users.settings.filters.create({
      userId: 'me',
      requestBody: {
        criteria: { from, to, subject, query },
        action: { addLabelIds, removeLabelIds },
      },
    });
    return data;
  });
}

export async function deleteFilter(email, filterId) {
  const gmail = await getGmail(email);
  return run(email, async () => {
    await gmail.users.settings.filters.delete({ userId: 'me', id: filterId });
    return { id: filterId, deleted: true };
  });
}
