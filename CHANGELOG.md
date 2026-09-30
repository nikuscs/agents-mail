# Changelog

## Unreleased

## 0.0.1 - 2026-09-30

- Catch-all inbox on Cloudflare Email Routing: emails in D1, attachments in R2, full addressing kept, including the SMTP recipient.
- Send through the Cloudflare Email Service binding with named addresses, cc, bcc, reply-to and attachments; html-only mail gets a plain-text part, and every outgoing email is validated.
- Reply (or reply all) in the thread, with a `to` override, and forward with attachments; send results list the recipients used.
- Wait for a matching email, with the verification code and link pulled out, or for a reply in a thread, even one that already arrived; waits match the SMTP recipient, and thread waits only accept senders from the mail you sent there.
- Unread state, and marking emails read or unread.
- Search by sender, recipient, direction, thread, date, unread, category or text, html-only mail included.
- Stateless MCP server at `/mcp` with eight tools, from `list_emails` to `delete_email`.
- Optional read-only token, address allowlist (`AGENTS_MAIL_ACCEPT`), daily inbound limit (`AGENTS_MAIL_INBOUND_LIMIT`) and hourly retention (`AGENTS_MAIL_RETENTION_DAYS`); incoming mail over 10 MiB is rejected.
- Optional TypeSafe JEV categorization and prompt-injection scoring of exactly what agents read (sender, subject, attachment names and the whole text, in chunks); suspicious and unscored received mail is hidden from lists, waits and `get_email`, raw html comes only with `html: true`, and sent mail is always listed.
- The Worker refuses to serve with a short or shared token, or with JEV on and no key.
- One-command deploy that provisions D1, R2, Email Sending, Email Routing and the catch-all rule, writes `.prod.vars` as 0600 and always binds the current D1 database.
- `agents-mail` agent skill, installable with `npx skills add nikuscs/agents-mail --skill agents-mail`.
