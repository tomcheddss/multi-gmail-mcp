import { google } from 'googleapis';
import { homedir } from 'os';
import { join, basename } from 'path';
import { mkdirSync, writeFileSync, readdirSync, statSync, unlinkSync, chmodSync } from 'fs';
import { getAuthenticatedClient, wrapTokenError } from './auth.js';

// Attachments are saved to a private, owner-only cache folder and pruned after 24h.
const CACHE_DIR = process.env.GMAIL_MCP_CACHE_DIR ?? join(homedir(), '.gmail-mcp-cache');
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

async function getGmail(email) {
  const auth = await getAuthenticatedClient(email);
  return { gmail: google.gmail({ version: 'v1', auth }), email };
}

// Runs a Gmail API call and converts token errors into friendly TokenRefreshErrors
async function run(email, fn) {
  try {
    return await fn();
  } catch (err) {
    wrapTokenError(email, err);
  }
}

export function getHeader(headers, name) {
  return headers?.find(h => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';
}

export function extractBody(payload) {
  if (!payload) return '';

  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) {
        return Buffer.from(part.body.data, 'base64').toString('utf8');
      }
    }
    for (const part of payload.parts) {
      if (part.parts) {
        const nested = extractBody(part);
        if (nested) return nested;
      }
      if (part.mimeType === 'text/html' && part.body?.data) {
        return Buffer.from(part.body.data, 'base64').toString('utf8');
      }
    }
  }

  if (payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64').toString('utf8');
  }

  return '';
}

// Walks a MIME payload and returns every part that carries a real attachment.
export function listAttachments(payload, acc = []) {
  if (!payload) return acc;
  if (payload.filename && payload.body?.attachmentId) {
    acc.push({
      filename: payload.filename,
      mimeType: payload.mimeType ?? 'application/octet-stream',
      size: payload.body.size ?? 0,
      attachmentId: payload.body.attachmentId,
    });
  }
  for (const part of payload.parts ?? []) listAttachments(part, acc);
  return acc;
}

// Strips path separators and control characters so a hostile filename can't escape the cache dir.
export function sanitizeFilename(name) {
  const clean = basename(String(name ?? ''))
    .replace(/[\x00-\x1f\x7f/\\]/g, '_')
    .replace(/^\.+/, '_')
    .slice(0, 150);
  return clean || 'attachment';
}

function ensureCacheDir() {
  mkdirSync(CACHE_DIR, { recursive: true, mode: 0o700 });
  chmodSync(CACHE_DIR, 0o700);
  const cutoff = Date.now() - CACHE_TTL_MS;
  for (const f of readdirSync(CACHE_DIR)) {
    const full = join(CACHE_DIR, f);
    try {
      if (statSync(full).mtimeMs < cutoff) unlinkSync(full);
    } catch {
      // ignore files that vanish mid-prune
    }
  }
  return CACHE_DIR;
}

// Writes bytes to the cache and returns the absolute path. Exported for tests.
export function saveAttachmentBytes(messageId, filename, bytes) {
  const dir = ensureCacheDir();
  const safe = sanitizeFilename(filename);
  const path = join(dir, `${String(messageId).slice(0, 12)}_${safe}`);
  writeFileSync(path, bytes, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

export function buildRaw({ from, to, cc, bcc, subject, body, inReplyTo, references }) {
  const lines = [
    `From: ${from}`,
    `To: ${to}`,
    cc ? `Cc: ${cc}` : null,
    bcc ? `Bcc: ${bcc}` : null,
    `Subject: ${subject}`,
    'Content-Type: text/plain; charset=UTF-8',
    inReplyTo ? `In-Reply-To: ${inReplyTo}` : null,
    references ? `References: ${references}` : null,
  ].filter(Boolean);

  return Buffer.from(lines.join('\r\n') + '\r\n\r\n' + body).toString('base64url');
}

export async function searchEmails(email, query, maxResults = 10) {
  const { gmail } = await getGmail(email);
  return run(email, async () => {
    const listRes = await gmail.users.messages.list({ userId: 'me', q: query, maxResults });
    if (!listRes.data.messages?.length) return [];

    const messages = await Promise.all(
      listRes.data.messages.map(msg =>
        gmail.users.messages.get({
          userId: 'me',
          id: msg.id,
          format: 'metadata',
          metadataHeaders: ['From', 'To', 'Subject', 'Date'],
        })
      )
    );

    return messages.map(({ data: msg }) => ({
      id: msg.id,
      threadId: msg.threadId,
      from: getHeader(msg.payload?.headers, 'From'),
      to: getHeader(msg.payload?.headers, 'To'),
      subject: getHeader(msg.payload?.headers, 'Subject'),
      date: getHeader(msg.payload?.headers, 'Date'),
      snippet: msg.snippet,
      labels: msg.labelIds ?? [],
    }));
  });
}

export async function getEmail(email, messageId) {
  const { gmail } = await getGmail(email);
  return run(email, async () => {
    const { data: msg } = await gmail.users.messages.get({
      userId: 'me',
      id: messageId,
      format: 'full',
    });
    return {
      id: msg.id,
      threadId: msg.threadId,
      from: getHeader(msg.payload?.headers, 'From'),
      to: getHeader(msg.payload?.headers, 'To'),
      cc: getHeader(msg.payload?.headers, 'Cc'),
      subject: getHeader(msg.payload?.headers, 'Subject'),
      date: getHeader(msg.payload?.headers, 'Date'),
      messageId: getHeader(msg.payload?.headers, 'Message-ID'),
      references: getHeader(msg.payload?.headers, 'References'),
      body: extractBody(msg.payload),
      labels: msg.labelIds ?? [],
    };
  });
}

export async function listMessageAttachments(email, messageId) {
  const { gmail } = await getGmail(email);
  return run(email, async () => {
    const { data: msg } = await gmail.users.messages.get({
      userId: 'me',
      id: messageId,
      format: 'full',
    });
    return listAttachments(msg.payload);
  });
}

// Downloads one attachment (by attachmentId or filename) into the local cache.
export async function getAttachment(email, messageId, { attachmentId, filename } = {}) {
  const { gmail } = await getGmail(email);
  return run(email, async () => {
    const { data: msg } = await gmail.users.messages.get({
      userId: 'me',
      id: messageId,
      format: 'full',
    });
    const all = listAttachments(msg.payload);
    const target = all.find(a =>
      (attachmentId && a.attachmentId === attachmentId) ||
      (filename && a.filename.toLowerCase() === String(filename).toLowerCase())
    );
    if (!target) {
      const names = all.map(a => a.filename).join(', ') || 'none';
      throw new Error(`Attachment not found on message ${messageId}. Available: ${names}`);
    }
    const { data } = await gmail.users.messages.attachments.get({
      userId: 'me',
      messageId,
      id: target.attachmentId,
    });
    const bytes = Buffer.from(data.data, 'base64url');
    const path = saveAttachmentBytes(messageId, target.filename, bytes);
    return { ...target, size: bytes.length, path };
  });
}

export async function sendEmail(email, { to, subject, body, cc, bcc }) {
  const { gmail } = await getGmail(email);
  return run(email, async () => {
    const raw = buildRaw({ from: email, to, cc, bcc, subject, body });
    const { data } = await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
    return data;
  });
}

export async function replyToEmail(email, messageId, body) {
  const original = await getEmail(email, messageId);
  const { gmail } = await getGmail(email);
  return run(email, async () => {
    const subject = original.subject.startsWith('Re: ')
      ? original.subject
      : `Re: ${original.subject}`;
    const references = original.references
      ? `${original.references} ${original.messageId}`
      : original.messageId;
    const raw = buildRaw({
      from: email,
      to: original.from,
      subject,
      body,
      inReplyTo: original.messageId,
      references,
    });
    const { data } = await gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw, threadId: original.threadId },
    });
    return data;
  });
}

export async function createDraft(email, { to, subject, body, cc, bcc }) {
  const { gmail } = await getGmail(email);
  return run(email, async () => {
    const raw = buildRaw({ from: email, to, cc, bcc, subject, body });
    const { data } = await gmail.users.drafts.create({
      userId: 'me',
      requestBody: { message: { raw } },
    });
    return data;
  });
}

export async function listLabels(email) {
  const { gmail } = await getGmail(email);
  return run(email, async () => {
    const { data } = await gmail.users.labels.list({ userId: 'me' });
    return data.labels ?? [];
  });
}

export async function modifyLabels(email, messageId, addLabelIds = [], removeLabelIds = []) {
  const { gmail } = await getGmail(email);
  return run(email, async () => {
    const { data } = await gmail.users.messages.modify({
      userId: 'me',
      id: messageId,
      requestBody: { addLabelIds, removeLabelIds },
    });
    return data;
  });
}
