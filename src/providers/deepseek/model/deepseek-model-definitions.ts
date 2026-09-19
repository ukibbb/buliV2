const REASONING_EFFORTS = Object.freeze(["low", "high", "max"] as const)
const SOURCES = Object.freeze({
    contextWindowTokens: "https://api-docs.deepseek.com/quick_start/agent_integrations/codex/",
    maxOutputTokens: "https://api-docs.deepseek.com/api/create-chat-completion/",
    reasoning: "https://api-docs.deepseek.com/guides/thinking_mode/",
    providerInputModalities: "https://api-docs.deepseek.com/quick_start/pricing/",
})

export type TDeepSeekModelId = "deepseek-flash" | "deepseek-v4-pro"

function definition(modelId: TDeepSeekModelId, images: boolean) {
    return Object.freeze({
        modelId,
        name: `DeepSeek · ${modelId}`,
        reasoningEfforts: REASONING_EFFORTS,
        defaultReasoningEffort: "high" as const,
        contextWindowTokens: 1_048_576,
        maxOutputTokens: 393_216,
        providerInputModalities: Object.freeze(images ? ["text", "image"] as const : ["text"] as const),
        adapterInputModalities: Object.freeze(["text"] as const),
        provenance: SOURCES,
    })
}

export const DEEPSEEK_MODEL_DEFINITIONS = Object.freeze({
    "deepseek-flash": definition("deepseek-flash", true),
    "deepseek-v4-pro": definition("deepseek-v4-pro", false),
})

export function isDeepSeekModelId(id: string): id is TDeepSeekModelId {
    return Object.hasOwn(DEEPSEEK_MODEL_DEFINITIONS, id)
}
