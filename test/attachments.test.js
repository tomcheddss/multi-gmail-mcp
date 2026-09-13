import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, utimesSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

process.env.GMAIL_MCP_DB_PATH = '/tmp/gmail-test-unused.db';
process.env.GMAIL_MCP_CACHE_DIR = mkdtempSync(join(tmpdir(), 'gmail-mcp-cache-'));

const { listAttachments, sanitizeFilename, saveAttachmentBytes } = await import('../src/gmail-client.js');

describe('listAttachments', () => {
  it('finds attachments in nested multipart payloads and skips inline body parts', () => {
    const payload = {
      mimeType: 'multipart/mixed',
      parts: [
        { mimeType: 'multipart/alternative', parts: [
          { mimeType: 'text/plain', filename: '', body: { data: 'aGk=' } },
          { mimeType: 'text/html', filename: '', body: { data: 'aGk=' } },
        ]},
        { mimeType: 'application/pdf', filename: 'letter.pdf', body: { attachmentId: 'att1', size: 1234 } },
        { mimeType: 'application/zip', filename: 'report.zip', body: { attachmentId: 'att2', size: 99 } },
      ],
    };
    const list = listAttachments(payload);
    assert.deepEqual(list.map(a => a.filename), ['letter.pdf', 'report.zip']);
    assert.equal(list[0].attachmentId, 'att1');
    assert.equal(list[1].size, 99);
  });

  it('returns an empty list for a plain message', () => {
    assert.deepEqual(listAttachments({ mimeType: 'text/plain', body: { data: 'aGk=' } }), []);
  });
});

describe('sanitizeFilename', () => {
  it('strips directory traversal and hidden-file prefixes', () => {
    assert.equal(sanitizeFilename('../../etc/passwd'), 'passwd');
    assert.equal(sanitizeFilename('.bashrc'), '_bashrc');
    assert.equal(sanitizeFilename(''), 'attachment');
  });
});

describe('saveAttachmentBytes', () => {
  it('writes the file owner-only inside the cache dir and prunes stale files', () => {
    const stale = saveAttachmentBytes('oldmsg', 'old.txt', Buffer.from('old'));
    const past = (Date.now() - 48 * 3600 * 1000) / 1000;
    utimesSync(stale, past, past);

    const path = saveAttachmentBytes('1a09abcdef0123456789', 'letter.pdf', Buffer.from('%PDF-1.4'));
    assert.ok(path.startsWith(process.env.GMAIL_MCP_CACHE_DIR));
    assert.equal(readFileSync(path, 'utf8'), '%PDF-1.4');
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(statSync(process.env.GMAIL_MCP_CACHE_DIR).mode & 0o777, 0o700);
    assert.equal(existsSync(stale), false, 'stale file should be pruned');
  });
});
