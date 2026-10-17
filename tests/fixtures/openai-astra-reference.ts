/**
 * Sanitized public reference, not a captured account response or an entitlement.
 * Tests may supply this record through a fake account endpoint to test parsing.
 * Pinned Codex source:
 * https://github.com/openai/codex/blob/db0568dbbb853ce2c377a27a94b5546d4a4d2ec3/codex-rs/models-manager/models.json
 */
export const CODEX_ASTRA_REFERENCE = {
  slug: "gpt-6-astra",
  display_name: "GPT-6-Astra",
  context_window: 272_000,
  max_context_window: 872_000,
  auto_compact_token_limit: null,
  default_reasoning_level: "low",
  supported_reasoning_levels: [
    { effort: "low" },
    { effort: "medium" },
    { effort: "high" },
    { effort: "xhigh" },
    { effort: "max" },
    // Codex orchestration, not a native Responses reasoning effort.
    { effort: "ultra" },
  ],
  service_tiers: [{ id: "priority", name: "Fast" }],
  additional_speed_tiers: ["fast"],
} as const

/**
 * API-shaped projection of the pinned models.dev base + OpenAI provider data:
 * https://github.com/anomalyco/models.dev/tree/c12e91757aa9a652a506c3ed73d4462a810b5b67
 * Base: models/openai/gpt-6-astra.toml; provider: OpenAI reasoning options/modes.
 * Public limits and Fast mode are deliberately not account capability grants.
 * Native ID/efforts were also verified against OpenAI's docs on 2026-09-07:
 * https://developers.openai.com/api/docs/models/gpt-6-astra.md
 */
export const MODELS_DEV_ASTRA_REFERENCE = {
  id: "gpt-6-astra",
  limit: { context: 1_050_000, input: 922_000, output: 128_000 },
  reasoning_options: [{
    type: "effort",
    values: ["low", "medium", "high", "xhigh", "max"],
  }],
  experimental: {
    modes: {
      fast: { provider: { body: { service_tier: "priority" } } },
    },
  },
} as const
