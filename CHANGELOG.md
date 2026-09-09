# Changelog

## 0.1.0-experimental.1 — 2026-09-09

First controlled experimental release of the single-agent `spool` tool.

- Adds explicit canonical-goal attachment, durable step materialization, queue-first claiming, checkpoint/status/resume, explicit heartbeat, and execution completion backed by Absurd 0.5.0.
- Adds machine configuration at `<Pi agent dir>/spool.json`, with individual environment-variable overrides and lazy database connection.
- Bounds PostgreSQL connection, statement, query-read, and shutdown waits; uncertain commit acknowledgement fails closed without automatic retry.
- Publishes strict action-specific field constraints and bounded resume output.

Live evidence covers a graceful same-session Pi restart, a replacement run, and reuse of the original checkpoint. It does not prove SIGKILL recovery or independent continuation from a fresh Pi session. Reviewed acceptance, plan revision, timeline/history, and today/attention views are not implemented.
