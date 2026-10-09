# Explorer tasks

Buli and NoVibe expose `delegate_task` in the normal application composition. The model may choose not to delegate. Each call accepts one to three self-contained tasks; it starts one read-only Explorer per task and waits for the entire group. Results retain input order, regardless of completion order.

Explorers receive project instructions and their task, not the parent's conversation or MCP tools. Their tools are `read`, `find`, `grep`, and `tool_output`. They inherit the active parent run's base model configuration, with separate session context and compaction. Read-only tools do not constitute a filesystem sandbox.

Each child has durable session history. SQLite schema version 2 adds `delegated_tasks`; version 1 is validated and migrated transactionally. Child sessions are excluded from the regular session list. Opening the parent after an interruption marks unfinished tasks as interrupted, without rerunning them.

The parent receives ordered reports, not child transcripts. Each returned report is bounded to keep the group's JSON within normal tool-output limits; the full report remains available in the child history. One research failure does not cancel siblings. Parent cancellation cancels active children. A ten-minute timer requests cancellation of an individual Explorer. Cancellation relies on providers and tools honoring their abort signals; it is not process isolation or a hard token/cost budget.

The transcript displays Explorer headers using `#002575` rails and brackets, with light model/effort text and explicit status labels. Progress is visible independently of result ordering. Expanding an Explorer opens its paginated transcript. A running child can be stopped independently.

## Current scope

- No recursive delegation, write-capable subagents, automatic model routing, or background parent execution.
- Maximum three children per tool call, not a global application-wide concurrency quota.
- Tool output storage remains application-lifetime storage, as for regular tools.
- Child token usage is available through its session state; there is no combined parent-and-children usage dashboard yet.

## Verification

Run `bun run typecheck` and `bun run test`. Tests cover concurrent execution with out-of-order completion, context isolation, read-only tool selection, NoVibe tool registration, ordered failure results, cancellation, recovery, migration, input cardinality, and the collapsed terminal presentation. Check expanded scrolling, stop interactions, and dark-blue contrast manually in the target terminal.
