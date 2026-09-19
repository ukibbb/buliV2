import type { TKimiModelId } from "./kimi-agent-model"

const MODELS_URL = "https://api.kimi.com/coding/v1/models"
const DOCUMENTATION_URL = "https://www.kimi.com/code/docs/en/kimi-code/models.html"
const REASONING_EFFORTS = Object.freeze(["low", "high", "max"] as const)

export interface IKimiCatalogModel {
    readonly modelId: TKimiModelId
    readonly name: string
    readonly reasoningEfforts: typeof REASONING_EFFORTS
    readonly defaultReasoningEffort: "high" | "max"
    readonly contextWindowTokens?: number
    readonly provenance: {
        readonly availability: "api-listed-not-inference-verified"
        readonly contextWindowTokens?: "api-declared"
        readonly reasoning: typeof DOCUMENTATION_URL
    }
}

export interface IKimiModelCatalog {
    readonly load: (signal?: AbortSignal) => Promise<readonly IKimiCatalogModel[]>
}

interface IKimiModelCatalogOptions {
    readonly auth: { readonly authenticatedFetch: typeof fetch }
    readonly timeoutMs?: number
}

export function createKimiModelCatalog(options: IKimiModelCatalogOptions): IKimiModelCatalog {
    const timeoutMs = options.timeoutMs ?? 10_000
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("Invalid Kimi catalog timeout")
    return {
        async load(callerSignal) {
            callerSignal?.throwIfAborted()
            const timeout = AbortSignal.timeout(timeoutMs)
            const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout
            try {
                const response = await options.auth.authenticatedFetch(MODELS_URL, { method: "GET", signal })
                if (!response.ok) {
                    await response.body?.cancel().catch(() => {})
                    throw new CatalogError(`Kimi catalog returned HTTP ${response.status}`)
                }
                const value = await readJson(response, signal)
                signal.throwIfAborted()
                return parseCatalog(value)
            } catch (error) {
                signal.throwIfAborted()
                if (error instanceof CatalogError) throw error
                throw new Error("Kimi catalog could not be loaded")
            }
        },
    }
}

class CatalogError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value)
}

function isSupportedId(id: string): id is TKimiModelId {
    return id === "k3" || id === "k3-256k" || id === "kimi-for-coding"
}

function parseCatalog(value: unknown): readonly IKimiCatalogModel[] {
    if (!isRecord(value) || !Array.isArray(value.data)) throw new CatalogError("Invalid Kimi catalog response")
    const ids = new Set<string>()
    const models: IKimiCatalogModel[] = []
    for (const item of value.data) {
        if (!isRecord(item) || typeof item.id !== "string" || !item.id.trim()) {
            throw new CatalogError("Invalid Kimi catalog model ID")
        }
        if (ids.has(item.id)) throw new CatalogError("Duplicate Kimi catalog model ID")
        ids.add(item.id)
        if (!isSupportedId(item.id)) continue
        const context = item.context_length
        if (context !== undefined && (typeof context !== "number" || !Number.isSafeInteger(context) || context <= 0)) {
            throw new CatalogError("Invalid Kimi catalog context length")
        }
        for (const key of ["supports_reasoning", "supports_image_in", "supports_video_in"] as const) {
            if (item[key] !== undefined && typeof item[key] !== "boolean") {
                throw new CatalogError("Invalid Kimi catalog capability")
            }
        }
        if (item.display_name !== undefined && item.display_name !== null && typeof item.display_name !== "string") {
            throw new CatalogError("Invalid Kimi catalog display name")
        }
        if (item.supports_reasoning === false) continue
        models.push(Object.freeze({
            modelId: item.id,
            name: `Kimi Code · ${item.id}`,
            reasoningEfforts: REASONING_EFFORTS,
            defaultReasoningEffort: item.id === "kimi-for-coding" ? "max" : "high",
            ...(typeof context === "number" ? { contextWindowTokens: context } : {}),
            provenance: Object.freeze({
                availability: "api-listed-not-inference-verified" as const,
                ...(context === undefined ? {} : { contextWindowTokens: "api-declared" as const }),
                reasoning: DOCUMENTATION_URL,
            }),
        }))
    }
    if (models.length === 0) throw new CatalogError("Kimi catalog returned no supported models")
    return Object.freeze(models)
}

async function readJson(response: Response, signal: AbortSignal): Promise<unknown> {
    if (!response.body) throw new CatalogError("Invalid Kimi catalog JSON")
    const reader = response.body.getReader()
    const cancel = () => { void reader.cancel().catch(() => {}) }
    signal.addEventListener("abort", cancel, { once: true })
    try {
        signal.throwIfAborted()
        const decoder = new TextDecoder("utf-8", { fatal: true })
        let text = ""
        while (true) {
            const chunk = await reader.read()
            signal.throwIfAborted()
            if (chunk.done) break
            text += decoder.decode(chunk.value, { stream: true })
        }
        text += decoder.decode()
        return JSON.parse(text) as unknown
    } catch {
        cancel()
        signal.throwIfAborted()
        throw new CatalogError("Invalid Kimi catalog JSON")
    } finally {
        signal.removeEventListener("abort", cancel)
        reader.releaseLock()
    }
}
