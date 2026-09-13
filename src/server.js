import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { listAccounts, storeTokens, removeAccount, setLabel, resolveEmail } from './db.js';
import { resolveAccount } from './account-resolver.js';
import { initiateAuth, checkAuthStatus } from './auth.js';
import {
  searchEmails,
  getEmail,
  listMessageAttachments,
  getAttachment,
  sendEmail,
  replyToEmail,
  createDraft,
  createReplyDraft,
  listDrafts,
  listLabels,
  modifyLabels,
} from './gmail-client.js';
import {
  senderStats,
  bulkModify,
  getUnsubscribeInfo,
  unsubscribe,
  ensureLabel,
  deleteLabel,
  findLabelsByPrefix,
  listFilters,
  createFilter,
  deleteFilter,
} from './cleanup.js';
import {
  listCalendars,
  listCalendarEvents,
  getCalendarEvent,
  deleteCalendarEvent,
} from './calendar-client.js';

const TOOLS = [
  {
    name: 'list_accounts',
    description:
      'List all authenticated Gmail accounts with their labels. ' +
      'Labels are the authoritative account identifiers — always use the label to determine ' +
      'which account is work, personal, etc. Never infer account purpose from the email domain. ' +
      'Always call this first so you know which label maps to which address.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'set_active_account',
    description:
      'Set a default Gmail account for this conversation. ' +
      'After this, all tools can omit the email/label parameter and will use this account.',
    inputSchema: {
      type: 'object',
      properties: {
        account: {
          type: 'string',
          description: 'Email address or label (e.g. "work", "personal")',
        },
      },
      required: ['account'],
    },
  },
  {
    name: 'get_active_account',
    description: 'Show the currently active Gmail account for this conversation.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'initiate_auth',
    description:
      'Start OAuth2 authentication for a Gmail account. ' +
      'Returns a URL the user must open in their browser. ' +
      'After the user completes sign-in, call complete_auth.',
    inputSchema: {
      type: 'object',
      properties: {
        email: { type: 'string', description: 'Gmail address to authenticate' },
        label: {
          type: 'string',
          description: 'Optional label for this account (e.g. "work", "personal")',
        },
      },
      required: ['email'],
    },
  },
  {
    name: 'complete_auth',
    description:
      'Finish OAuth2 authentication after the user has opened the URL from initiate_auth ' +
      'and completed the Google sign-in flow.',
    inputSchema: {
      type: 'object',
      properties: {
        email: { type: 'string', description: 'Gmail address being authenticated' },
      },
      required: ['email'],
    },
  },
  {
    name: 'check_auth_status',
    description:
      'Check whether the OAuth token for one or all accounts is valid. ' +
      'Call this proactively before send operations in long conversations to avoid mid-flight auth failures.',
    inputSchema: {
      type: 'object',
      properties: {
        account: {
          type: 'string',
          description:
            'Email address or label to check. Omit to check all authenticated accounts.',
        },
      },
    },
  },
  {
    name: 'set_account_label',
    description: 'Set or update the label for an existing Gmail account.',
    inputSchema: {
      type: 'object',
      properties: {
        account: { type: 'string', description: 'Email address or current label' },
        label: { type: 'string', description: 'New label to assign (e.g. "work", "personal")' },
      },
      required: ['account', 'label'],
    },
  },
  {
    name: 'remove_account',
    description: 'Remove a Gmail account and its stored credentials.',
    inputSchema: {
      type: 'object',
      properties: {
        account: { type: 'string', description: 'Email address or label to remove' },
      },
      required: ['account'],
    },
  },
  {
    name: 'search_emails',
    description: 'Search emails using Gmail search syntax (e.g. "from:foo is:unread").',
    inputSchema: {
      type: 'object',
      properties: {
        account: {
          type: 'string',
          description: 'Email address or label (e.g. "work"). Uses active account if omitted.',
        },
        query: { type: 'string', description: 'Gmail search query' },
        max_results: { type: 'number', description: 'Maximum number of results (default: 10)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_email',
    description: 'Fetch the full content of an email by ID.',
    inputSchema: {
      type: 'object',
      properties: {
        account: {
          type: 'string',
          description: 'Email address or label. Uses active account if omitted.',
        },
        message_id: { type: 'string', description: 'Email message ID' },
      },
      required: ['message_id'],
    },
  },
  {
    name: 'list_attachments',
    description: 'List the attachments on an email (filename, type, size) without downloading them.',
    inputSchema: {
      type: 'object',
      properties: {
        account: {
          type: 'string',
          description: 'Email address or label. Uses active account if omitted.',
        },
        message_id: { type: 'string', description: 'Email message ID' },
      },
      required: ['message_id'],
    },
  },
  {
    name: 'get_attachment',
    description:
      'Download one attachment from an email into a private local cache folder ' +
      '(~/.gmail-mcp-cache, owner-only, pruned after 24h) and return its file path. ' +
      'Identify the attachment by filename or attachment_id (see list_attachments). ' +
      'Only downloads on explicit request — never bulk-fetches.',
    inputSchema: {
      type: 'object',
      properties: {
        account: {
          type: 'string',
          description: 'Email address or label. Uses active account if omitted.',
        },
        message_id: { type: 'string', description: 'Email message ID' },
        filename: { type: 'string', description: 'Attachment filename (case-insensitive)' },
        attachment_id: { type: 'string', description: 'Attachment ID from list_attachments' },
      },
      required: ['message_id'],
    },
  },
  {
    name: 'send_email',
    description: 'Send an email from a Gmail account.',
    inputSchema: {
      type: 'object',
      properties: {
        account: {
          type: 'string',
          description: 'Email address or label to send from. Uses active account if omitted.',
        },
        to: { type: 'string', description: 'Recipient address(es)' },
        subject: { type: 'string', description: 'Subject line' },
        body: { type: 'string', description: 'Plain-text body' },
        cc: { type: 'string', description: 'CC recipients (optional)' },
        bcc: { type: 'string', description: 'BCC recipients (optional)' },
      },
      required: ['to', 'subject', 'body'],
    },
  },
  {
    name: 'reply_to_email',
    description: 'Reply to an existing email, preserving thread context.',
    inputSchema: {
      type: 'object',
      properties: {
        account: {
          type: 'string',
          description: 'Email address or label to reply from. Uses active account if omitted.',
        },
        message_id: { type: 'string', description: 'ID of the email to reply to' },
        body: { type: 'string', description: 'Plain-text reply body' },
      },
      required: ['message_id', 'body'],
    },
  },
  {
    name: 'create_draft',
    description: 'Save an email as a draft without sending.',
    inputSchema: {
      type: 'object',
      properties: {
        account: {
          type: 'string',
          description: 'Email address or label. Uses active account if omitted.',
        },
        to: { type: 'string', description: 'Recipient address(es)' },
        subject: { type: 'string', description: 'Subject line' },
        body: { type: 'string', description: 'Plain-text body' },
        cc: { type: 'string', description: 'CC recipients (optional)' },
        bcc: { type: 'string', description: 'BCC recipients (optional)' },
      },
      required: ['to', 'subject', 'body'],
    },
  },
  {
    name: 'create_reply_draft',
    description:
      'Create a draft REPLY inside an existing thread (sets threadId, In-Reply-To and References so ' +
      'it appears under the conversation in Gmail and other clients). Use this, not create_draft, ' +
      'whenever replying to a message. Never sends.',
    inputSchema: {
      type: 'object',
      properties: {
        account: {
          type: 'string',
          description: 'Email address or label. Uses active account if omitted.',
        },
        message_id: { type: 'string', description: 'ID of the message being replied to' },
        body: { type: 'string', description: 'Plain-text reply body' },
        reply_all: { type: 'boolean', description: 'Also CC the original recipients (default false)' },
      },
      required: ['message_id', 'body'],
    },
  },
  {
    name: 'list_drafts',
    description:
      'List drafts, optionally only those on a given thread_id. Check this before creating a reply ' +
      'draft so a thread never gets two drafts.',
    inputSchema: {
      type: 'object',
      properties: {
        account: {
          type: 'string',
          description: 'Email address or label. Uses active account if omitted.',
        },
        thread_id: { type: 'string', description: 'Only drafts on this thread (optional)' },
      },
    },
  },
  {
    name: 'list_labels',
    description: 'List all Gmail labels for an account.',
    inputSchema: {
      type: 'object',
      properties: {
        account: {
          type: 'string',
          description: 'Email address or label. Uses active account if omitted.',
        },
      },
    },
  },
  {
    name: 'add_label',
    description: 'Add one or more labels to an email.',
    inputSchema: {
      type: 'object',
      properties: {
        account: {
          type: 'string',
          description: 'Email address or label. Uses active account if omitted.',
        },
        message_id: { type: 'string', description: 'Email message ID' },
        label_ids: { type: 'array', items: { type: 'string' }, description: 'Label IDs to add' },
      },
      required: ['message_id', 'label_ids'],
    },
  },
  {
    name: 'remove_label',
    description: 'Remove one or more labels from an email.',
    inputSchema: {
      type: 'object',
      properties: {
        account: {
          type: 'string',
          description: 'Email address or label. Uses active account if omitted.',
        },
        message_id: { type: 'string', description: 'Email message ID' },
        label_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Label IDs to remove',
        },
      },
      required: ['message_id', 'label_ids'],
    },
  },
  {
    name: 'archive_email',
    description: 'Archive an email by removing it from the inbox.',
    inputSchema: {
      type: 'object',
      properties: {
        account: {
          type: 'string',
          description: 'Email address or label. Uses active account if omitted.',
        },
        message_id: { type: 'string', description: 'Email message ID' },
      },
      required: ['message_id'],
    },
  },
  {
    name: 'mark_as_read',
    description: 'Mark an email as read.',
    inputSchema: {
      type: 'object',
      properties: {
        account: {
          type: 'string',
          description: 'Email address or label. Uses active account if omitted.',
        },
        message_id: { type: 'string', description: 'Email message ID' },
      },
      required: ['message_id'],
    },
  },
  {
    name: 'mark_as_unread',
    description: 'Mark an email as unread.',
    inputSchema: {
      type: 'object',
      properties: {
        account: {
          type: 'string',
          description: 'Email address or label. Uses active account if omitted.',
        },
        message_id: { type: 'string', description: 'Email message ID' },
      },
      required: ['message_id'],
    },
  },
  // --- Cleanup: sender stats, bulk actions, unsubscribe, filters -------------
  {
    name: 'sender_stats',
    description:
      'Sample messages matching a query and return per-sender counts, unread counts, whether the ' +
      'sender offers List-Unsubscribe, latest date and a sample subject. Sorted by volume. ' +
      'Use this first when triaging an inbox.',
    inputSchema: {
      type: 'object',
      properties: {
        account: {
          type: 'string',
          description: 'Email address or label. Uses active account if omitted.',
        },
        query: { type: 'string', description: 'Gmail search query (default: in:inbox)' },
        sample_size: { type: 'number', description: 'Messages to sample (default 500, max 2000)' },
        top: { type: 'number', description: 'How many senders to return (default 50)' },
      },
    },
  },
  {
    name: 'bulk_modify',
    description:
      'Apply a label change to every message matching a query, up to max_messages. ' +
      'Actions: archive (remove from Inbox), trash, mark_read, or custom add/remove labels. ' +
      'Always run with dry_run=true first and confirm the count with the user before executing.',
    inputSchema: {
      type: 'object',
      properties: {
        account: {
          type: 'string',
          description: 'Email address or label. Uses active account if omitted.',
        },
        query: { type: 'string', description: 'Gmail search query, e.g. "from:news@x.com older_than:1y"' },
        action: {
          type: 'string',
          enum: ['archive', 'trash', 'mark_read', 'custom'],
          description: 'Preset action, or custom with add_labels/remove_labels',
        },
        add_labels: { type: 'array', items: { type: 'string' }, description: 'Label names to add (custom)' },
        remove_labels: { type: 'array', items: { type: 'string' }, description: 'Label IDs to remove (custom)' },
        max_messages: { type: 'number', description: 'Safety cap (default 1000, max 10000)' },
        dry_run: { type: 'boolean', description: 'Only count matches (default true)' },
      },
      required: ['query', 'action'],
    },
  },
  {
    name: 'get_unsubscribe_info',
    description: 'Read the List-Unsubscribe headers of a message and report how it can be unsubscribed.',
    inputSchema: {
      type: 'object',
      properties: {
        account: {
          type: 'string',
          description: 'Email address or label. Uses active account if omitted.',
        },
        message_id: { type: 'string', description: 'Email message ID' },
      },
      required: ['message_id'],
    },
  },
  {
    name: 'unsubscribe',
    description:
      'Unsubscribe from the sender of a message using its List-Unsubscribe headers: ' +
      'one-click POST if offered, else a mailto unsubscribe email, else returns a URL for the user to open.',
    inputSchema: {
      type: 'object',
      properties: {
        account: {
          type: 'string',
          description: 'Email address or label. Uses active account if omitted.',
        },
        message_id: { type: 'string', description: 'Email message ID' },
      },
      required: ['message_id'],
    },
  },
  {
    name: 'create_label',
    description: 'Create a Gmail label if it does not exist (nested labels use "Parent/Child").',
    inputSchema: {
      type: 'object',
      properties: {
        account: {
          type: 'string',
          description: 'Email address or label. Uses active account if omitted.',
        },
        name: { type: 'string', description: 'Label name' },
      },
      required: ['name'],
    },
  },
  {
    name: 'delete_label',
    description:
      'Delete a user label by name or ID. Messages are not deleted, they just lose the label. ' +
      'System labels cannot be removed. Use delete_label_tree to remove a whole nested family.',
    inputSchema: {
      type: 'object',
      properties: {
        account: {
          type: 'string',
          description: 'Email address or label. Uses active account if omitted.',
        },
        name: { type: 'string', description: 'Label name or ID' },
      },
      required: ['name'],
    },
  },
  {
    name: 'delete_label_tree',
    description:
      'Delete every user label whose name starts with a prefix, children first ' +
      '(e.g. prefix "[Superhuman]" removes the parent and all nested labels). ' +
      'Messages keep existing; they only lose these labels. Confirm with the user before calling.',
    inputSchema: {
      type: 'object',
      properties: {
        account: {
          type: 'string',
          description: 'Email address or label. Uses active account if omitted.',
        },
        prefix: { type: 'string', description: 'Label name prefix, e.g. "[Superhuman]"' },
        dry_run: { type: 'boolean', description: 'Only list what would be deleted (default true)' },
      },
      required: ['prefix'],
    },
  },
  {
    name: 'list_filters',
    description: 'List Gmail filters (criteria and actions) on an account.',
    inputSchema: { type: 'object', properties: {
        account: {
          type: 'string',
          description: 'Email address or label. Uses active account if omitted.',
        },
    } },
  },
  {
    name: 'create_filter',
    description:
      'Create a Gmail filter. Matches on from/to/subject/query and can add a label (created if missing), ' +
      'skip the inbox, mark read, or trash. Applies to future mail only; use bulk_modify for existing mail.',
    inputSchema: {
      type: 'object',
      properties: {
        account: {
          type: 'string',
          description: 'Email address or label. Uses active account if omitted.',
        },
        from: { type: 'string', description: 'Sender address or domain' },
        to: { type: 'string', description: 'Recipient address' },
        subject: { type: 'string', description: 'Subject contains' },
        query: { type: 'string', description: 'Gmail search query' },
        add_label: { type: 'string', description: 'Label name to apply' },
        skip_inbox: { type: 'boolean', description: 'Archive on arrival' },
        mark_read: { type: 'boolean', description: 'Mark as read on arrival' },
        trash: { type: 'boolean', description: 'Send straight to trash' },
      },
    },
  },
  {
    name: 'delete_filter',
    description: 'Delete a Gmail filter by ID.',
    inputSchema: {
      type: 'object',
      properties: {
        account: {
          type: 'string',
          description: 'Email address or label. Uses active account if omitted.',
        },
        filter_id: { type: 'string', description: 'Filter ID from list_filters' },
      },
      required: ['filter_id'],
    },
  },
  // --- Calendar --------------------------------------------------------------
  {
    name: 'list_calendars',
    description: 'List the calendars visible to an account.',
    inputSchema: { type: 'object', properties: {
        account: {
          type: 'string',
          description: 'Email address or label. Uses active account if omitted.',
        },
    } },
  },
  {
    name: 'list_calendar_events',
    description:
      'List calendar events. With recurring_only=true returns recurring SERIES (delete the series ID ' +
      'to stop all future occurrences). Otherwise returns individual events ordered by start time.',
    inputSchema: {
      type: 'object',
      properties: {
        account: {
          type: 'string',
          description: 'Email address or label. Uses active account if omitted.',
        },
        calendar_id: { type: 'string', description: 'Calendar ID (default primary)' },
        query: { type: 'string', description: 'Free-text search' },
        time_min: { type: 'string', description: 'RFC3339 lower bound, e.g. 2026-01-01T00:00:00Z' },
        time_max: { type: 'string', description: 'RFC3339 upper bound' },
        recurring_only: { type: 'boolean', description: 'Only recurring series (default false)' },
        max: { type: 'number', description: 'Max results (default 100)' },
      },
    },
  },
  {
    name: 'get_calendar_event',
    description: 'Fetch one calendar event including its description.',
    inputSchema: {
      type: 'object',
      properties: {
        account: {
          type: 'string',
          description: 'Email address or label. Uses active account if omitted.',
        },
        event_id: { type: 'string', description: 'Event ID' },
        calendar_id: { type: 'string', description: 'Calendar ID (default primary)' },
      },
      required: ['event_id'],
    },
  },
  {
    name: 'delete_calendar_event',
    description:
      'Delete a calendar event without notifying attendees. Pass a series ID to remove a whole ' +
      'recurring series. Confirm with the user before calling.',
    inputSchema: {
      type: 'object',
      properties: {
        account: {
          type: 'string',
          description: 'Email address or label. Uses active account if omitted.',
        },
        event_id: { type: 'string', description: 'Event or series ID' },
        calendar_id: { type: 'string', description: 'Calendar ID (default primary)' },
      },
      required: ['event_id'],
    },
  },
];

// Returns a fully configured MCP Server instance with isolated session state.
// Call once per stdio session, or once per HTTP client session.
export function createServer() {
  const pendingSessions = new Map();
  let activeAccount = null;

  const server = new Server(
    { name: 'multi-gmail-mcp', version: '1.0.6' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      let text;

      switch (name) {
        case 'list_accounts': {
          const accounts = listAccounts();
          if (!accounts.length) {
            text = 'No Gmail accounts authenticated yet. Use initiate_auth to add one.';
            break;
          }
          const active = activeAccount ? `\nActive account: ${activeAccount}` : '';
          text =
            'Account map (labels are authoritative — do not infer purpose from email domains):\n' +
            accounts
              .map(({ email, label }) => {
                const labelPart = label ? `[${label}]` : '[no label]';
                return `  ${labelPart.padEnd(20)} → ${email}`;
              })
              .join('\n') +
            active;
          break;
        }

        case 'set_active_account': {
          const email = resolveAccount(args.account, activeAccount);
          activeAccount = args.account;
          text = `Active account set to: ${email}${args.account !== email ? ` (label: "${args.account}")` : ''}`;
          break;
        }

        case 'get_active_account': {
          if (!activeAccount) {
            text = 'No active account set. Use set_active_account to set one.';
          } else {
            const email = resolveEmail(activeAccount);
            text = `Active account: ${email}${activeAccount !== email ? ` (label: "${activeAccount}")` : ''}`;
          }
          break;
        }

        case 'initiate_auth': {
          const { email, label } = args;
          if (pendingSessions.has(email)) {
            const existing = pendingSessions.get(email);
            text =
              `Authentication already in progress for ${email}.\n\n` +
              `Open this URL if you haven't already:\n${existing.authUrl}\n\n` +
              `Then call complete_auth with email: ${email}`;
            break;
          }
          const session = await initiateAuth();
          pendingSessions.set(email, { ...session, label });
          text =
            `Authentication started for ${email}.\n\n` +
            `Please open this URL in your browser:\n${session.authUrl}\n\n` +
            `After completing sign-in, call complete_auth with email: ${email}`;
          break;
        }

        case 'complete_auth': {
          const { email } = args;
          const session = pendingSessions.get(email);
          if (!session) {
            text = `No pending authentication for ${email}. Call initiate_auth first.`;
            break;
          }
          const tokens = await session.tokenPromise;
          storeTokens(email, tokens, session.label ?? null);
          pendingSessions.delete(email);
          text = `Successfully authenticated ${email}!` +
            (session.label ? ` Label: "${session.label}"` : '');
          break;
        }

        case 'check_auth_status': {
          const targets = args.account
            ? [resolveAccount(args.account, activeAccount)]
            : listAccounts().map(a => a.email);

          const results = await Promise.all(targets.map(e => checkAuthStatus(e)));
          text = results
            .map(r =>
              r.valid
                ? `✓ ${r.email} — token valid`
                : `✗ ${r.email} — ${r.error}`
            )
            .join('\n');
          break;
        }

        case 'set_account_label': {
          const email = resolveAccount(args.account, activeAccount);
          setLabel(email, args.label);
          text = `Label "${args.label}" set for ${email}`;
          break;
        }

        case 'remove_account': {
          const email = resolveAccount(args.account, activeAccount);
          removeAccount(email);
          if (activeAccount === args.account || activeAccount === email) activeAccount = null;
          text = `Removed account: ${email}`;
          break;
        }

        case 'search_emails': {
          const email = resolveAccount(args.account, activeAccount);
          const results = await searchEmails(email, args.query, args.max_results);
          if (!results.length) {
            text = `No emails found in ${email} matching your query.`;
            break;
          }
          text = results
            .map(m =>
              [
                `ID: ${m.id}`,
                `From: ${m.from}`,
                `Subject: ${m.subject}`,
                `Date: ${m.date}`,
                `Snippet: ${m.snippet}`,
                `Labels: ${m.labels.join(', ')}`,
              ].join('\n')
            )
            .join('\n\n---\n\n');
          break;
        }

        case 'get_email': {
          const email = resolveAccount(args.account, activeAccount);
          const msg = await getEmail(email, args.message_id);
          text = [
            `From: ${msg.from}`,
            `To: ${msg.to}`,
            msg.cc ? `Cc: ${msg.cc}` : null,
            `Subject: ${msg.subject}`,
            `Date: ${msg.date}`,
            `Labels: ${msg.labels.join(', ')}`,
            '',
            msg.body,
          ]
            .filter(l => l !== null)
            .join('\n');
          break;
        }

        case 'list_attachments': {
          const email = resolveAccount(args.account, activeAccount);
          const list = await listMessageAttachments(email, args.message_id);
          text = list.length
            ? list
                .map(a => `${a.filename}  (${a.mimeType}, ${a.size} bytes)  id: ${a.attachmentId}`)
                .join('\n')
            : 'No attachments on this message.';
          break;
        }

        case 'get_attachment': {
          const email = resolveAccount(args.account, activeAccount);
          if (!args.filename && !args.attachment_id) {
            throw new Error('Provide filename or attachment_id.');
          }
          const saved = await getAttachment(email, args.message_id, {
            attachmentId: args.attachment_id,
            filename: args.filename,
          });
          text = `Saved ${saved.filename} (${saved.mimeType}, ${saved.size} bytes) to ${saved.path}`;
          break;
        }

        case 'sender_stats': {
          const email = resolveAccount(args.account, activeAccount);
          const sample = Math.min(args.sample_size ?? 500, 2000);
          const { sampled, senders } = await senderStats(email, args.query ?? 'in:inbox', sample);
          const top = senders.slice(0, args.top ?? 50);
          text = [
            `Sampled ${sampled} messages on ${email} (${senders.length} distinct senders). Top ${top.length}:`,
            '',
            ...top.map(
              s =>
                `${String(s.count).padStart(4)}  ${s.address}` +
                (s.name ? `  (${s.name})` : '') +
                `  unread:${s.unread}` +
                (s.hasUnsubscribe ? '  [unsub]' : '') +
                `  latest:${s.latest.slice(0, 16)}` +
                `  e.g. "${s.sampleSubject.slice(0, 60)}"`
            ),
          ].join('\n');
          break;
        }

        case 'bulk_modify': {
          const email = resolveAccount(args.account, activeAccount);
          const presets = {
            archive: { removeLabelIds: ['INBOX'] },
            trash: { addLabelIds: ['TRASH'] },
            mark_read: { removeLabelIds: ['UNREAD'] },
          };
          let change = presets[args.action];
          if (args.action === 'custom') {
            const addLabelIds = [];
            for (const n of args.add_labels ?? []) addLabelIds.push((await ensureLabel(email, n)).id);
            change = { addLabelIds, removeLabelIds: args.remove_labels ?? [] };
          }
          if (!change) throw new Error(`Unknown action: ${args.action}`);
          const dryRun = args.dry_run !== false;
          const max = Math.min(args.max_messages ?? 1000, 10000);
          const r = await bulkModify(email, args.query, change, { max, dryRun });
          text = dryRun
            ? `Dry run: ${r.matched} message(s) on ${email} match "${args.query}" (cap ${max}). Re-run with dry_run=false to ${args.action}.`
            : `${args.action}: modified ${r.modified} message(s) on ${email} matching "${args.query}".`;
          break;
        }

        case 'get_unsubscribe_info': {
          const email = resolveAccount(args.account, activeAccount);
          const i = await getUnsubscribeInfo(email, args.message_id);
          text = [
            `From: ${i.from}`,
            `Subject: ${i.subject}`,
            `One-click: ${i.oneClick ? 'yes' : 'no'}`,
            `URL: ${i.url ?? 'none'}`,
            `Mailto: ${i.mailto ?? 'none'}`,
          ].join('\n');
          break;
        }

        case 'unsubscribe': {
          const email = resolveAccount(args.account, activeAccount);
          const r = await unsubscribe(email, args.message_id);
          if (r.method === 'none') text = `No List-Unsubscribe header on this message from ${r.from}. Consider a filter to trash instead.`;
          else if (r.method === 'manual') text = `No automatic method for ${r.from}. Open this URL to unsubscribe: ${r.url}`;
          else text = `Unsubscribed from ${r.from} via ${r.method}${r.status ? ` (HTTP ${r.status})` : ''}.` + (r.done ? '' : ' Response was not OK; verify manually: ' + (r.url ?? r.mailto));
          break;
        }

        case 'create_label': {
          const email = resolveAccount(args.account, activeAccount);
          const l = await ensureLabel(email, args.name);
          text = `${l.created ? 'Created' : 'Already exists'}: ${l.name} (id ${l.id})`;
          break;
        }

        case 'delete_label': {
          const email = resolveAccount(args.account, activeAccount);
          const l = await deleteLabel(email, args.name);
          text = `Deleted label "${l.name}" (${l.id}) on ${email}.`;
          break;
        }

        case 'delete_label_tree': {
          const email = resolveAccount(args.account, activeAccount);
          const found = await findLabelsByPrefix(email, args.prefix);
          if (!found.length) {
            text = `No labels start with "${args.prefix}" on ${email}.`;
            break;
          }
          if (args.dry_run !== false) {
            text = `Dry run: ${found.length} label(s) would be deleted on ${email}:\n` +
              found.map(l => `  ${l.name}`).join('\n');
            break;
          }
          const done = [];
          for (const l of found) {
            await deleteLabel(email, l.id);
            done.push(l.name);
          }
          text = `Deleted ${done.length} label(s) on ${email}:\n` + done.map(n => `  ${n}`).join('\n');
          break;
        }

        case 'list_filters': {
          const email = resolveAccount(args.account, activeAccount);
          const filters = await listFilters(email);
          text = filters.length
            ? filters
                .map(f => `${f.id}  criteria=${JSON.stringify(f.criteria)}  action=${JSON.stringify(f.action)}`)
                .join('\n')
            : `No filters on ${email}.`;
          break;
        }

        case 'create_filter': {
          const email = resolveAccount(args.account, activeAccount);
          const f = await createFilter(email, {
            from: args.from,
            to: args.to,
            subject: args.subject,
            query: args.query,
            addLabel: args.add_label,
            skipInbox: !!args.skip_inbox,
            markRead: !!args.mark_read,
            trash: !!args.trash,
          });
          text = `Filter created on ${email}: id ${f.id}`;
          break;
        }

        case 'delete_filter': {
          const email = resolveAccount(args.account, activeAccount);
          await deleteFilter(email, args.filter_id);
          text = `Filter ${args.filter_id} deleted on ${email}.`;
          break;
        }

        case 'list_calendars': {
          const email = resolveAccount(args.account, activeAccount);
          const cals = await listCalendars(email);
          text = cals.map(c => `${c.id}  ${c.summary}${c.primary ? '  [primary]' : ''}  (${c.accessRole})`).join('\n');
          break;
        }

        case 'list_calendar_events': {
          const email = resolveAccount(args.account, activeAccount);
          const events = await listCalendarEvents(email, {
            calendarId: args.calendar_id,
            query: args.query,
            timeMin: args.time_min,
            timeMax: args.time_max,
            max: args.max,
            recurringOnly: !!args.recurring_only,
          });
          text = events.length
            ? events
                .map(
                  e =>
                    `${e.id}  ${e.start.slice(0, 16)}  ${e.summary}` +
                    (e.recurring ? `  [recurring ${e.recurrence.join(' ')}]` : '') +
                    (e.organizer ? `  organizer:${e.organizer}` : '') +
                    `  attendees:${e.attendees}`
                )
                .join('\n')
            : 'No events found.';
          break;
        }

        case 'get_calendar_event': {
          const email = resolveAccount(args.account, activeAccount);
          const e = await getCalendarEvent(email, args.event_id, args.calendar_id);
          text = [
            `Title: ${e.summary}`,
            `Start: ${e.start}`,
            `Organizer: ${e.organizer}`,
            `Recurring: ${e.recurring ? e.recurrence.join(' ') || 'instance' : 'no'}`,
            `Attendees: ${e.attendees}`,
            '',
            e.description,
          ].join('\n');
          break;
        }

        case 'delete_calendar_event': {
          const email = resolveAccount(args.account, activeAccount);
          await deleteCalendarEvent(email, args.event_id, args.calendar_id);
          text = `Deleted event ${args.event_id} on ${email}.`;
          break;
        }

        case 'send_email': {
          const email = resolveAccount(args.account, activeAccount);
          const sent = await sendEmail(email, {
            to: args.to,
            subject: args.subject,
            body: args.body,
            cc: args.cc,
            bcc: args.bcc,
          });
          text = `Email sent from ${email}. Message ID: ${sent.id}`;
          break;
        }

        case 'reply_to_email': {
          const email = resolveAccount(args.account, activeAccount);
          const replied = await replyToEmail(email, args.message_id, args.body);
          text = `Reply sent from ${email}. Message ID: ${replied.id}`;
          break;
        }

        case 'create_draft': {
          const email = resolveAccount(args.account, activeAccount);
          const draft = await createDraft(email, {
            to: args.to,
            subject: args.subject,
            body: args.body,
            cc: args.cc,
            bcc: args.bcc,
          });
          text = `Draft created in ${email}. Draft ID: ${draft.id}`;
          break;
        }

        case 'create_reply_draft': {
          const email = resolveAccount(args.account, activeAccount);
          const d = await createReplyDraft(email, args.message_id, args.body, {
            replyAll: !!args.reply_all,
          });
          text = `Reply draft created in ${email} on thread ${d.threadId} to ${d.to} ("${d.subject}"). Draft ID: ${d.id}`;
          break;
        }

        case 'list_drafts': {
          const email = resolveAccount(args.account, activeAccount);
          const drafts = await listDrafts(email, { threadId: args.thread_id });
          text = drafts.length
            ? drafts.map(d => `${d.id}  thread:${d.threadId}  message:${d.messageId}`).join('\n')
            : (args.thread_id ? `No drafts on thread ${args.thread_id}.` : 'No drafts.');
          break;
        }

        case 'list_labels': {
          const email = resolveAccount(args.account, activeAccount);
          const labels = await listLabels(email);
          text = labels.map(l => `${l.name}  (ID: ${l.id})`).join('\n');
          break;
        }

        case 'add_label': {
          const email = resolveAccount(args.account, activeAccount);
          await modifyLabels(email, args.message_id, args.label_ids, []);
          text = `Labels added to message ${args.message_id}.`;
          break;
        }

        case 'remove_label': {
          const email = resolveAccount(args.account, activeAccount);
          await modifyLabels(email, args.message_id, [], args.label_ids);
          text = `Labels removed from message ${args.message_id}.`;
          break;
        }

        case 'archive_email': {
          const email = resolveAccount(args.account, activeAccount);
          await modifyLabels(email, args.message_id, [], ['INBOX']);
          text = `Message ${args.message_id} archived from ${email}.`;
          break;
        }

        case 'mark_as_read': {
          const email = resolveAccount(args.account, activeAccount);
          await modifyLabels(email, args.message_id, [], ['UNREAD']);
          text = `Message ${args.message_id} marked as read.`;
          break;
        }

        case 'mark_as_unread': {
          const email = resolveAccount(args.account, activeAccount);
          await modifyLabels(email, args.message_id, ['UNREAD'], []);
          text = `Message ${args.message_id} marked as unread.`;
          break;
        }

        default:
          throw new Error(`Unknown tool: ${name}`);
      }

      return { content: [{ type: 'text', text }] };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${err.message}` }],
        isError: true,
      };
    }
  });

  return server;
}
