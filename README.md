# Slashwork Linear Integration

This is the integration that Slashwork itself uses to send Linear events into our own internal Slashwork group. It's released here as example code in case you might find it useful. It currently processes issue changes (created, updated, deleted) and issue comments (only, nothing else) and then posts those into a group on Slashwork.

You'll need to configure the following in `.env`:

- `LINEAR_WEBHOOK_SECRET` -- the signing secret of the webhook you create below
- `SLASHWORK_AUTH_TOKEN` -- the auth token of a Slashwork app
- `SLASHWORK_GROUP_ID` -- the Slashwork group ID to post into (create a group and grab from the URL)

You'll also need to change `SLASHWORK_GRAPHQL_URL` in `server.ts` to point to your company instead of ours.

The server receives Linear webhooks, so it needs to be running somewhere with a public DNS domain. On that server, `npm run build` then `npm run server`. The code only speaks HTTP, not HTTPS, so you'll probably also want to change the URL in the `Caddyfile` and then `caddy start` -- or have some other way to terminate TLS and send it to port 3336.

On the Linear side, go to Settings -> API -> Webhooks -> New webhook. Point the URL at `https://yourserver.example/webhook/linear`, and under "Data change events" enable "Issues" and "Issue comments". Everything else is ignored if you send it. Once the webhook is created, copy its signing secret to use as `LINEAR_WEBHOOK_SECRET`.

Every issue event becomes its own post, including updates -- so a busy team will produce a busy stream. Update posts summarise what actually changed (status, assignee, priority, labels, and so on) using the `updatedFrom` field Linear sends, so each post says why it exists. If that's still too much, the place to filter is `describeIssueChanges` in `server.ts`.

## Claude Code

The code here was written substantially by Claude Code. It's actually really good at using GraphQL introspection to figure out how the Slashwork API works, if you ask it to do so -- you can tell it to use the `SLASHWORK_AUTH_TOKEN` to make introspection requests against the `SLASHWORK_GRAPHQL_URL` in order to figure out how to do things.
