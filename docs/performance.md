# Transcript performance

## First optimization package

This package removes avoidable work before OpenTUI draws the transcript. It does
not batch model events, virtualize history, change tool concurrency or compaction
policy, or backport the native performance changes from OpenTUI #1462.

- `ISessionManager.getPresentationRevision()` is an in-memory invalidation token
  for proposals and the checkpoint, not a persisted format/version. Manager
  implementations and adapters must advance/forward it on successful saves and
  session recreation, including same-ID replacements. Ordinary message appends
  do not invalidate these branches. Missing/deleted sessions return `-1`.
- `AgentSession` reuses private defensive copies until that token changes. The
  existing freezer then preserves public branch identity across text deltas,
  keeping React's durable-history memo effective. A real metadata write refreshes
  both related branches; older snapshots remain immutable. External manager
  writes are observed on the next publication, not through a new notification API.
- Queue revisions cover enqueue, consume, failed-persistence restoration, clear,
  and reset. Public Agent getters remain defensive; session publication reads
  them only after a queue mutation. Immutable pending-proposal projections are
  cached by the exact private proposal object, never by a potentially reused ID.
- Ordinary JSONL appends inspect only the final byte before the existing
  synchronous append. First-session atomic replacement, startup replay/repair,
  and deletion still inspect or rewrite complete logs. Persistence still precedes
  accepted Agent state; there is no new multi-process locking or fsync guarantee.
- Tool previews lazily escape and consume only the displayed code-point budget
  plus lookahead. Structured JSON-data previews stop before reading undisplayed
  values, without serializing entire edit arrays. Small valid inputs retain their
  previous text. Unsupported encountered data has a bounded diagnostic fallback;
  arbitrary proxy/getter code and engine-level object-key enumeration are not
  sandboxed. Whole error-detail joining/normalization remains linear.

Comments next to the implementation explain the cache, ownership, truncation,
and persistence invariants. Tests check identities, authoritative invalidation,
one-byte reads, cleanup/error barriers, Unicode output, and bounded value-access
counts rather than flaky elapsed-time thresholds.

## Reproduction

From the repository root, with dependencies installed:

```sh
SHOW_CONSOLE=0 NODE_ENV=development bun scripts/benchmark-transcript.ts baseline
SHOW_CONSOLE=0 NODE_ENV=development bun scripts/benchmark-transcript.ts after
```

The label only identifies a run; it does not switch source revisions. Capture
`baseline` before changing the implementation, then run the same workload after.
`BENCH_SAMPLES` defaults to 20 (plus three warmups); use the same value on both
sides. Run without concurrent builds, tests, or other benchmarks. `TMPDIR` may
select a temporary parent; every log fixture is created in a unique child and
removed afterward. The script never discovers or uses real `~/.buli` sessions.

Output is JSONL on stdout with environment, source-diff, harness, lockfile, and
patch fingerprints. A changed source/input fingerprint during a run invalidates
it. The source diff fingerprint covers tracked `src` changes, so newly added
source files must also be accounted for when comparing future packages.

The script measures separate boundaries, not live end-to-end latency:

1. Real session snapshot publication during fixed two-character deltas, without
   React listeners; builder/reducer work and final persistence are excluded.
2. Replay of those actual frozen snapshots through `useSyncExternalStore` and
   `Transcript`: synchronous React `act` flush, Profiler render work, and a
   separate manual OpenTUI frame. These samples are not summed per-token times.
3. Warm-cache ordinary appends to synthetic logs with the same record count and
   different payload sizes, excluding setup/replay/first-session replacement.
4. Parent-driven tool-line rerenders with fixed inputs/phases, including both
   formatting and React work, not actual tool execution.

## Initial comparison

Captured on 2026-09-07, Apple M5/macOS arm64, Bun 1.3.14, React 19.2.7, patched
OpenTUI 0.5.10, development React, 100x30 test renderer with threaded output off.
Each side is one sequential run with three warmups and 20 measured operations.
Histories contain short alternating user/assistant messages and a checkpoint;
proposal diffs are short plain-text patches. This is a local synthetic comparison,
not a production latency or throughput guarantee.

| Operation | Before Median / p95 (ms) | After Median / p95 (ms) |
| --- | ---: | ---: |
| React flush, 1,000 messages, no proposals | 3.1471 / 4.7490 | 0.4010 / 0.6243 |
| React flush, 1,000 messages, 10 proposals | 3.0396 / 4.6451 | 0.2528 / 0.3125 |
| OpenTUI frame, 1,000 messages, no proposals | 1.4357 / 2.0621 | 1.4925 / 2.4381 |
| Ordinary append, 1 MiB log | 0.1121 / 0.1596 | 0.0355 / 0.0890 |
| Ordinary append, 16 MiB log | 1.5036 / 2.2825 | 0.0358 / 0.0473 |
| Running edit line, 16 edits (2,734 bytes) | 0.0263 / 0.0422 | 0.0346 / 0.0514 |
| Running edit line, 4,096 edits (710,518 bytes) | 0.6591 / 0.8414 | 0.0333 / 0.0568 |
| Running unknown-tool line, 710,497-byte input | 0.5936 / 0.7185 | 0.0224 / 0.0276 |

Across all six history/proposal cases, each unchanged proposal, checkpoint and
queue branch changed identity 20 times before and zero times after; the streaming
message still changed 20 times and all 20 updates reached React. No events were
dropped to obtain the improvement.

The small edit fixture shows iterator overhead rather than a universal speedup.
The native frame cost for long history is also not improved by this package;
retained-tree traversal remains a separate target. Follow-up work should measure
real input responsiveness, event-loop delay/GC, long code blocks, and visible
frame latency before changing publication cadence or introducing windowing.
