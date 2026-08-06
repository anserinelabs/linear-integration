import crypto from 'crypto';

import express from 'express';

const PORT = 3336;

const SLASHWORK_AUTH_TOKEN = process.env.SLASHWORK_AUTH_TOKEN;
const SLASHWORK_GROUP_ID = process.env.SLASHWORK_GROUP_ID;
const LINEAR_WEBHOOK_SECRET = process.env.LINEAR_WEBHOOK_SECRET;
const SLASHWORK_GRAPHQL_URL = 'https://anserine.slashwork.com/api/graphql';

if (!SLASHWORK_AUTH_TOKEN || !SLASHWORK_GROUP_ID || !LINEAR_WEBHOOK_SECRET) {
  throw new Error('Missing required environment variables');
}

// Linear asks that we reject payloads whose timestamp is more than a minute
// away from our own clock, to guard against replayed deliveries.
const MAX_TIMESTAMP_SKEW_MS = 60 * 1000;

// Linear's docs don't exhaustively specify the shape of `data`, and which
// nested objects get expanded varies by event. Everything below the top level
// is therefore optional and read defensively.
type LinearNamed = {
  id?: string;
  name?: string;
};

type LinearIssue = {
  id?: string;
  identifier?: string;
  title?: string;
  description?: string;
  priority?: number;
  priorityLabel?: string;
  estimate?: number;
  dueDate?: string;
  url?: string;
  state?: LinearNamed;
  team?: LinearNamed;
  assignee?: LinearNamed;
  creator?: LinearNamed;
  project?: LinearNamed;
  cycle?: LinearNamed & { number?: number };
  parent?: { identifier?: string };
  labels?: LinearNamed[];
};

type LinearComment = {
  id?: string;
  body?: string;
  issueId?: string;
  url?: string;
  user?: LinearNamed;
  issue?: {
    id?: string;
    identifier?: string;
    title?: string;
    url?: string;
    team?: LinearNamed;
  };
};

type LinearWebhookPayload = {
  action: string;
  type: string;
  data: unknown;
  updatedFrom?: Record<string, unknown>;
  actor?: LinearNamed;
  url?: string;
  createdAt?: string;
  organizationId?: string;
  webhookTimestamp?: number;
  webhookId?: string;
};

type FormattedEvent = {
  markdown: string;
  metadata: Record<string, unknown>;
};

type GraphQLResponse = {
  data?: {
    createPost: {
      node: {
        id: string;
      };
    };
  };
  errors?: { message: string }[];
};

async function postToSlashwork(
  markdown: string,
  metadata: string,
): Promise<void> {
  const mutation = `
    mutation CreatePost($groupId: ID!, $input: CreatePostMutationInput!) {
      createPost(groupId: $groupId, input: $input) {
        node {
          id
        }
      }
    }
  `;

  const variables = {
    groupId: SLASHWORK_GROUP_ID,
    input: {
      markdown,
      metadata,
    },
  };

  const response = await fetch(SLASHWORK_GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${SLASHWORK_AUTH_TOKEN}`,
    },
    body: JSON.stringify({
      query: mutation,
      variables,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('Failed to post to Slashwork:', errorText);
    throw new Error(`Slashwork API error: ${response.status}`);
  }

  const result = (await response.json()) as GraphQLResponse;
  if (result.errors) {
    console.error('GraphQL errors:', result.errors);
    throw new Error('GraphQL mutation failed');
  }

  if (!result.data) {
    throw new Error('No data in GraphQL response');
  }

  console.log(
    'Successfully posted to Slashwork:',
    result.data.createPost.node.id,
  );
}

const PRIORITY_NAMES: Record<number, string> = {
  0: 'No priority',
  1: 'Urgent',
  2: 'High',
  3: 'Medium',
  4: 'Low',
};

function priorityName(priority: unknown): string | undefined {
  if (typeof priority !== 'number') {
    return undefined;
  }
  return PRIORITY_NAMES[priority] ?? String(priority);
}

function actorName(payload: LinearWebhookPayload, fallback?: LinearNamed) {
  return payload.actor?.name ?? fallback?.name ?? 'someone';
}

function issueHeading(
  identifier: string | undefined,
  title: string | undefined,
  url: string | undefined,
): string {
  const label = `\`${identifier ?? 'issue'}\``;
  const linked = url ? `[${label}](${url})` : label;
  return title ? `${linked} __${title}__` : linked;
}

function contextLine(team?: LinearNamed, state?: LinearNamed): string {
  const parts: string[] = [];
  if (team?.name) {
    parts.push(`**[${team.name}]**`);
  }
  if (state?.name) {
    parts.push(`\`[${state.name}]\``);
  }
  return parts.join(' ');
}

function blockquote(text: string | undefined): string {
  const trimmed = text?.trim();
  if (!trimmed) {
    return '';
  }
  return trimmed
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

function cycleName(cycle: LinearIssue['cycle']): string {
  if (cycle?.name) {
    return cycle.name;
  }
  if (cycle?.number !== undefined) {
    return `Cycle ${cycle.number}`;
  }
  return 'none';
}

// `updatedFrom` holds the previous values, but for relations those are raw
// UUIDs we can't resolve, so we generally render the new value only. Old and
// new are both shown for the fields where the previous value is readable.
function describeIssueChanges(
  issue: LinearIssue,
  updatedFrom: Record<string, unknown>,
): string[] {
  const changes: string[] = [];

  for (const key of Object.keys(updatedFrom)) {
    // Present on every single update, and never interesting on its own.
    if (key === 'updatedAt') {
      continue;
    }

    switch (key) {
      case 'stateId':
        changes.push(`Status: ${issue.state?.name ?? 'unknown'}`);
        break;
      case 'assigneeId':
        changes.push(`Assignee: ${issue.assignee?.name ?? 'unassigned'}`);
        break;
      case 'title': {
        const previous = updatedFrom.title;
        const current = issue.title ?? 'untitled';
        changes.push(
          typeof previous === 'string'
            ? `Title: ${previous} → ${current}`
            : `Title: ${current}`,
        );
        break;
      }
      case 'priority': {
        const previous = priorityName(updatedFrom.priority);
        const current =
          issue.priorityLabel ?? priorityName(issue.priority) ?? 'unknown';
        changes.push(
          previous
            ? `Priority: ${previous} → ${current}`
            : `Priority: ${current}`,
        );
        break;
      }
      case 'projectId':
        changes.push(`Project: ${issue.project?.name ?? 'none'}`);
        break;
      case 'cycleId':
        changes.push(`Cycle: ${cycleName(issue.cycle)}`);
        break;
      case 'parentId':
        changes.push(`Parent: ${issue.parent?.identifier ?? 'none'}`);
        break;
      case 'labelIds': {
        const labels = (issue.labels ?? [])
          .map((label) => label.name)
          .filter((name) => !!name);
        changes.push(`Labels: ${labels.length ? labels.join(', ') : 'none'}`);
        break;
      }
      case 'estimate':
        changes.push(`Estimate: ${issue.estimate ?? 'none'}`);
        break;
      case 'dueDate':
        changes.push(`Due date: ${issue.dueDate ?? 'none'}`);
        break;
      case 'description':
        // Don't inline the whole new body; it can be enormous.
        changes.push('Description: edited');
        break;
      default:
        changes.push(key);
    }
  }

  return changes;
}

function joinSections(sections: string[]): string {
  return sections.filter((section) => section !== '').join('\n\n');
}

function formatIssuePost(payload: LinearWebhookPayload): FormattedEvent | null {
  const issue = payload.data as LinearIssue;
  const heading = issueHeading(
    issue.identifier,
    issue.title,
    issue.url ?? payload.url,
  );

  let body: string;
  let trailer: string;

  switch (payload.action) {
    case 'create': {
      const description = issue.description?.trim();
      body = description ? `Description: \n${description}` : '';
      trailer = `Created by ${actorName(payload, issue.creator)}`;
      break;
    }
    case 'update': {
      const changes = describeIssueChanges(issue, payload.updatedFrom ?? {});
      body = changes.length
        ? changes.map((change) => `- ${change}`).join('\n')
        : 'Issue updated.';
      trailer = `Updated by ${actorName(payload, issue.creator)}`;
      break;
    }
    case 'remove':
      body = 'Issue deleted.';
      trailer = `Deleted by ${actorName(payload, issue.creator)}`;
      break;
    default:
      console.log('Unhandled Linear issue action:', payload.action);
      return null;
  }

  return {
    markdown: joinSections([
      heading,
      body,
      contextLine(issue.team, issue.state),
      trailer,
    ]),
    metadata: {
      issueId: issue.id,
      identifier: issue.identifier,
    },
  };
}

function formatCommentPost(
  payload: LinearWebhookPayload,
): FormattedEvent | null {
  const comment = payload.data as LinearComment;
  const issue = comment.issue;
  const heading = issueHeading(
    issue?.identifier ?? comment.issueId,
    issue?.title,
    comment.url ?? payload.url ?? issue?.url,
  );

  let body: string;
  let trailer: string;

  switch (payload.action) {
    case 'create':
      body = blockquote(comment.body);
      trailer = `Comment by ${actorName(payload, comment.user)}`;
      break;
    case 'update':
      body = blockquote(comment.body);
      trailer = `Comment edited by ${actorName(payload, comment.user)}`;
      break;
    case 'remove':
      body = 'Comment deleted.';
      trailer = `Deleted by ${actorName(payload, comment.user)}`;
      break;
    default:
      console.log('Unhandled Linear comment action:', payload.action);
      return null;
  }

  return {
    markdown: joinSections([heading, body, contextLine(issue?.team), trailer]),
    metadata: {
      commentId: comment.id,
      issueId: issue?.id ?? comment.issueId,
      identifier: issue?.identifier,
    },
  };
}

const app = express();

// Use raw body so we can verify the HMAC signature before parsing JSON
app.use(express.raw({ type: 'application/json' }));

function verifySignatureMiddleware(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): void {
  const signature = req.headers['linear-signature'];
  if (!signature || typeof signature !== 'string') {
    res.sendStatus(401);
    return;
  }

  const hmac = crypto.createHmac('sha256', LINEAR_WEBHOOK_SECRET!);
  hmac.update(req.body as Buffer);
  // Linear sends a bare hex digest, with no `sha256=` prefix.
  const expected = hmac.digest('hex');

  try {
    if (
      signature.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
    ) {
      next();
    } else {
      res.sendStatus(401);
    }
  } catch {
    res.sendStatus(401);
  }
}

app.post('/webhook/linear', verifySignatureMiddleware, (req, res) => {
  // Linear disables a webhook that doesn't answer 200 within five seconds, so
  // acknowledge first and do the work afterwards.
  res.sendStatus(200);

  let payload: LinearWebhookPayload;
  try {
    payload = JSON.parse(
      (req.body as Buffer).toString(),
    ) as LinearWebhookPayload;
  } catch {
    console.error('Failed to parse webhook payload');
    return;
  }

  if (
    payload.webhookTimestamp !== undefined &&
    Math.abs(Date.now() - payload.webhookTimestamp) > MAX_TIMESTAMP_SKEW_MS
  ) {
    console.warn(
      'Stale webhook timestamp, skipping:',
      payload.webhookTimestamp,
    );
    return;
  }

  let formatted: FormattedEvent | null;
  switch (payload.type) {
    case 'Issue':
      formatted = formatIssuePost(payload);
      break;
    case 'Comment':
      formatted = formatCommentPost(payload);
      break;
    default:
      console.log('Unhandled Linear event type:', payload.type);
      return;
  }

  if (!formatted) {
    return;
  }

  const metadata = JSON.stringify({
    source: 'linear',
    type: payload.type,
    action: payload.action,
    url: payload.url,
    ...formatted.metadata,
  });

  postToSlashwork(formatted.markdown, metadata).catch((err: unknown) => {
    console.error('Failed to post Linear event to Slashwork:', err);
  });
});

app.listen(PORT, () => {
  console.log(`Linear webhook server listening on port ${PORT}`);
});
