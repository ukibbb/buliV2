import { expect, test } from "bun:test"
import { createDeepSeekModelComposition } from "./create-deepseek-model-composition"
import { DEEPSEEK_MODEL_DEFINITIONS } from "@/providers/deepseek/model/deepseek-model-definitions"

test("DeepSeek registers only discovered models with an explicit transient reserve", async () => {
    const composition = createDeepSeekModelComposition({
        auth: { authenticatedFetch: (() => { throw new Error("Unexpected HTTP") }) as unknown as typeof fetch },
        catalog: { load: async () => [{ ...DEEPSEEK_MODEL_DEFINITIONS["deepseek-flash"], provenance: {
            ...DEEPSEEK_MODEL_DEFINITIONS["deepseek-flash"].provenance,
            availability: "api-listed-not-inference-verified" as const,
        } }] },
    })
    expect(composition.models).toEqual([])
    expect(composition.additionalTools).toEqual([])
    expect(composition.discovery?.preferredModelIds).toEqual([])
    const models = await composition.discovery!.loadModels(new AbortController().signal)
    expect(models).toHaveLength(1)
    expect(models[0]).toMatchObject({
        id: "deepseek/deepseek-flash",
        modelProfile: { providerId: "deepseek", modelId: "deepseek-flash", contextWindowTokens: 1_048_576 },
        estimationPolicy: { reasoningHistory: "preserve", outputReserveTokens: 393_216 },
        defaultReasoningEffort: "high",
    })
    expect(models[0]).not.toHaveProperty("fallbackSelectionId")
})

test("DeepSeek empty catalog has no static fallback", async () => {
    const composition = createDeepSeekModelComposition({
        auth: { authenticatedFetch: (() => { throw new Error("Unexpected HTTP") }) as unknown as typeof fetch },
        catalog: { load: async () => [] },
    })
    expect(await composition.discovery!.loadModels(new AbortController().signal)).toEqual([])
})
