# OpenAI models and context

## Account-authoritative discovery

Buli uses ChatGPT/Codex OAuth, not the OpenAI Platform API-key route. Its model
list comes from the authenticated Codex catalog at
`https://chatgpt.com/backend-api/codex/models?client_version=0.153.4`.
The public `https://models.dev/api.json` catalog only enriches exact matching
account model IDs with display names and reasoning metadata. It cannot grant
model/Fast availability or override the account's context window. The catalog
version is pinned to stable Codex 0.153.4 because Astra declares 0.153.0 as its
minimum compatible client version. This does not add an API-key integration.

The account-scoped in-memory catalog has a five-minute TTL and a ten-second
request timeout. Startup awaits its first load before exposing the prompt editor.
Loading or failed initial discovery leaves no public model list and prevents
normal prompts and manual compaction before any prompt/session persistence.
Authentication failure is recoverable: the UI still opens for `/login` and
`/model`. A later refresh failure keeps the last successful catalog usable and
shows a warning; account-bound model adapters still reject a changed account.

The preferred initial selections, in order, are:

1. `gpt-6-astra::fast`
2. `gpt-6-astra`
3. An available catalog model if neither preference exists.

The first successful discovery applies this preference and the catalog's default
reasoning effort. An explicit model/effort choice made during a refresh is
preserved when supported. Subsequent refreshes do not reapply the startup
preference: they preserve selection, fall back from a removed Fast selection to
its base when available, and report any forced selection change. These preferences
are not persisted across application restarts.

`modelCatalog` in the application snapshot describes readiness and advisory
messages. The private bootstrap registration is provisional, not an entitlement;
its selection ID can exist before any models are exposed to UI consumers.
Provider-neutral injected models bypass account discovery and preserve their
existing configuration path. Bootstrap's optional authentication/catalog inputs
allow owned, isolated integration fixtures without real credentials or requests.

## Astra request settings

Standard and Fast use the same wire model ID, `gpt-6-astra`. The `::fast` suffix
is only a Buli selection ID. Account metadata must advertise `priority` in
`service_tiers`, or `fast` in legacy `additional_speed_tiers`, before Buli creates
the Fast selection. Its adapter injects `service_tier: "priority"` after SDK
serialization so older SDK model-family allowlists cannot silently remove it.
Standard does not inject a tier; a rejected priority request is not silently
retried as Standard. The picker reflects the requested tier, not proof that the
backend honored it; provider limits and availability can still reject or change
processing. Fast is independent of reasoning effort and may consume more usage.

The installed OpenAI SDK's model-ID heuristics do not recognize GPT-6 as a
reasoning family. Positive reasoning metadata therefore enables `forceReasoning`.
The verified built-in Astra adapter also knows this capability. Explicit unknown
model IDs without capability metadata keep SDK inference instead of being forced
through a blanket GPT-family heuristic.

If Codex lists Astra without reasoning metadata and optional public enrichment
is unavailable, its verified native effort list and `low` default are used.
This fallback never invents model/tier availability or a context window. Native
efforts incompatible with Astra are filtered; an explicit list with no compatible
effort cannot publish a selectable Astra entry that would send `none`.

Astra's native efforts are `low`, `medium`, `high`, `xhigh`, and `max`. Its public
Codex reference defaults to `low`; actual account metadata controls the selection.
`none` is not a supported Astra effort. Codex's `ultra` represents orchestration,
not a native Responses effort, and remains outside Buli's supported effort set.

Compaction calls the same captured model adapter with the same selected effort
as the active run, retaining its account binding and Fast tier even if the global
selection changes mid-run. Manual idle compaction uses the current selection.
There is no separate compaction-model setting, automatic cheaper-model routing,
or hard-coded `none` override. Responses requests still omit `max_output_tokens`;
local compaction headroom is not an outgoing generation cap.

## Context and budget

Only a positive integer account `context_window` becomes
`modelProfile.contextWindowTokens`. `max_context_window` and public API
`limit.context/input/output` do not automatically replace it. A missing window
remains unknown; threshold-based preflight compaction is then disabled, while
existing overflow recovery can still attempt compaction.

The account reference and public API describe different quantities. The pinned
Codex Astra record below declares a 272,000 default window and an 872,000 maximum
configurable window. OpenAI's public API documentation declares 1,050,000 total
context, 922,000 maximum input and 128,000 maximum output. None of these public
sources proves an individual account's availability or effective catalog limits.
Buli retains the active account limit rather than assuming the largest number.

Accounting is unchanged; the UI now exposes its existing safety input separately:

```text
local estimate = ceil(UTF-8 bytes of provider-visible JSON / 2)
                 + 2,000 estimated tokens per image

estimate = max(local estimate, conservative retained-provider-usage floor)
safety input = estimate when a provider-usage floor is available
               2 * estimate otherwise

threshold = ceil(0.8 * known context window)
compact when safety input >= threshold
```

The usage floor anchors to the last retained, matching model's reported input and
adds conservative bounds for subsequent messages and the current fixed prefix.
Reported input already includes cached input; output already includes reasoning.
Those detail counts are not added again. This is an estimate of provider-visible
input, not exact tokenization or a cumulative billing counter.

For example:

```text
ctx ~80k/200k (40%)
compact 160k/160k (100% budget)
```

`ctx` uses the estimate and full window. `compact` uses safety input and the
compaction threshold, turning red when that displayed budget is exhausted.
Amber begins at 87.5% of the compaction budget, equivalent to the prior 70%-window
warning with an 80% threshold, now using the safety numerator consistently.
Status fields wrap on narrow terminals so the estimate and safety numbers remain
readable rather than being replaced by an ellipsis beside run hints.
Unknown windows display `compact limit unknown`, never a fabricated percentage.
Usage updates remain tied to completed messages and request preflight, not every
streaming token. The model/effort selector describes configuration for new runs;
an already-running request retains its captured configuration.

## Verification and provenance

`test/fixtures/openai-astra-reference.ts` contains a sanitized public reference,
not an authenticated account capture:

- [Codex reference catalog](https://github.com/openai/codex/blob/db0568dbbb853ce2c377a27a94b5546d4a4d2ec3/codex-rs/models-manager/models.json), pinned to `db0568dbbb853ce2c377a27a94b5546d4a4d2ec3`.
- [models.dev base metadata](https://github.com/anomalyco/models.dev/blob/c12e91757aa9a652a506c3ed73d4462a810b5b67/models/openai/gpt-6-astra.toml) and [OpenAI provider overrides](https://github.com/anomalyco/models.dev/blob/c12e91757aa9a652a506c3ed73d4462a810b5b67/providers/openai/models/gpt-6-astra.toml).
- [OpenAI Astra documentation](https://developers.openai.com/api/docs/models/gpt-6-astra.md) and [Fast-mode documentation](https://developers.openai.com/api/docs/guides/fast-mode.md), inspected on 2026-09-07.

Tests cover the real catalog/auth/SDK registration path with synthetic credentials
and mocked HTTP, including delayed startup, Fast/Standard selection, unknown
reasoning-capable IDs, account-bound headers, exact wire fields, context-limit
provenance, cancellation/rollback, and catalog retry. Runtime tests cover manual
selection races and active-run capture; compaction tests verify the same model
and selected effort; TUI tests cover budget colors and recovery commands on
narrow screens. No paid model calls or real account metadata are required by tests.

The change does not migrate JSONL or add persisted model-profile fields. It also
does not adopt OpenCode's different compaction threshold algorithm, raise context
limits, or change the existing single-request summarization/recovery policy.
