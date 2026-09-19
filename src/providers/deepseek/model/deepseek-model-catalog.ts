import { DEEPSEEK_MODEL_DEFINITIONS, isDeepSeekModelId } from "./deepseek-model-definitions"

type Definition = typeof DEEPSEEK_MODEL_DEFINITIONS[keyof typeof DEEPSEEK_MODEL_DEFINITIONS]
export type IDeepSeekCatalogModel = Omit<Definition, "provenance"> & {
    readonly provenance: Definition["provenance"] & { readonly availability: "api-listed-not-inference-verified" }
}
export interface IDeepSeekModelCatalog {
    readonly load: (signal?: AbortSignal) => Promise<readonly IDeepSeekCatalogModel[]>
}
interface IDeepSeekModelCatalogOptions {
    readonly auth: { readonly authenticatedFetch: typeof fetch }
    readonly timeoutMs?: number
}

export function createDeepSeekModelCatalog(options: IDeepSeekModelCatalogOptions): IDeepSeekModelCatalog {
    const timeoutMs = options.timeoutMs ?? 10_000
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("Invalid DeepSeek catalog timeout")
    return {
        async load(callerSignal) {
            callerSignal?.throwIfAborted()
            const timeout = AbortSignal.timeout(timeoutMs)
            const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout
            try {
                const response = await options.auth.authenticatedFetch("https://api.deepseek.com/models", { method: "GET", signal })
                if (!response.ok) {
                    await response.body?.cancel().catch(() => {})
                    throw new CatalogError(`DeepSeek catalog returned HTTP ${response.status}`)
                }
                const value = await readJson(response, signal)
                signal.throwIfAborted()
                return parseCatalog(value)
            } catch (error) {
                signal.throwIfAborted()
                if (error instanceof CatalogError) throw error
                throw new Error("DeepSeek catalog could not be loaded")
            }
        },
    }
}
class CatalogError extends Error {}
function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value)
}
function parseCatalog(value: unknown): readonly IDeepSeekCatalogModel[] {
    if (!isRecord(value) || value.object !== "list" || !Array.isArray(value.data)) throw new CatalogError("Invalid DeepSeek catalog response")
    const ids = new Set<string>()
    const models: IDeepSeekCatalogModel[] = []
    for (const item of value.data) {
        if (!isRecord(item) || typeof item.id !== "string" || !item.id.trim() || item.object !== "model" || typeof item.owned_by !== "string" || !item.owned_by.trim()) {
            throw new CatalogError("Invalid DeepSeek catalog model")
        }
        if (ids.has(item.id)) throw new CatalogError("Duplicate DeepSeek catalog model ID")
        ids.add(item.id)
        if (!isDeepSeekModelId(item.id)) continue
        const definition = DEEPSEEK_MODEL_DEFINITIONS[item.id]
        models.push(Object.freeze({
            ...definition,
            provenance: Object.freeze({ ...definition.provenance, availability: "api-listed-not-inference-verified" as const }),
        }))
    }
    return Object.freeze(models)
}
async function readJson(response: Response, signal: AbortSignal): Promise<unknown> {
    if (!response.body) throw new CatalogError("Invalid DeepSeek catalog JSON")
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
        throw new CatalogError("Invalid DeepSeek catalog JSON")
    } finally {
        signal.removeEventListener("abort", cancel)
        reader.releaseLock()
    }
}
