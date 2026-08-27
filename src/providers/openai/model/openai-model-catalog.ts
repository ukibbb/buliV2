import type { IOAuthCredential } from "@/authentication"
import type { ReasoningEffort } from "@/agent"
import {
    MODELS_DEV_API_URL,
    OPENAI_MODEL_CATALOG_TIMEOUT_MS,
    OPENAI_MODEL_CATALOG_TTL_MS,
} from "@/providers/openai/constants"

const REASONING_EFFORTS: readonly ReasoningEffort[] = [
    "none",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
]
const MAX_CATALOG_BYTES = 20 * 1024 * 1024
const MAX_CATALOG_MODELS = 2_000
const FAST_SELECTION_SUFFIX = "::fast"
const FAST_NAME_SUFFIX = " Fast"
const MAX_DISPLAY_NAME_CHARACTERS = 120

export interface IOpenAiCatalogModel {
    /** Unique runtime selection ID. */
    readonly id: string
    /** Base model ID sent to OpenAI. */
    readonly modelId: string
    readonly accountId: string
    readonly name: string
    readonly serviceTier?: "priority"
    readonly reasoningEfforts: readonly ReasoningEffort[]
    readonly defaultReasoningEffort: ReasoningEffort
    readonly contextWindowTokens?: number
}

export interface IOpenAiModelCatalog {
    readonly load: (
        signal?: AbortSignal,
    ) => Promise<readonly IOpenAiCatalogModel[]>
}

export interface IOpenAiModelCatalogAuth {
    readonly fetchModels: (
        signal?: AbortSignal,
    ) => Promise<{ readonly response: Response; readonly accountId: string }>
    readonly requireCredential: (
        signal?: AbortSignal,
    ) => Promise<IOAuthCredential>
}

export interface IOpenAiModelCatalogOptions {
    readonly auth: IOpenAiModelCatalogAuth
    readonly fetch?: typeof fetch
    readonly now?: () => number
    readonly ttlMs?: number
    readonly timeoutMs?: number
}

interface ICachedCatalog {
    readonly accountId: string
    readonly expiresAt: number
    readonly models: readonly IOpenAiCatalogModel[]
}

interface IAccountModel {
    readonly id: string
    readonly name?: string
    readonly reasoningEfforts?: readonly ReasoningEffort[]
    readonly defaultReasoningEffort?: ReasoningEffort
    readonly contextWindowTokens?: number
    readonly fastServiceTier?: "priority"
    readonly priority: number
    readonly sourceIndex: number
}

interface IModelsDevMetadata {
    readonly id: string
    readonly name?: string
    readonly reasoningEfforts?: readonly ReasoningEffort[]
}

/** Loads the account-authoritative Codex catalog and enriches it with models.dev. */
export function createOpenAiModelCatalog(
    options: IOpenAiModelCatalogOptions,
): IOpenAiModelCatalog {
    const rawFetch = options.fetch ?? globalThis.fetch
    const now = options.now ?? Date.now
    const ttlMs = options.ttlMs ?? OPENAI_MODEL_CATALOG_TTL_MS
    const timeoutMs = options.timeoutMs ?? OPENAI_MODEL_CATALOG_TIMEOUT_MS
    let cache: ICachedCatalog | undefined

    return {
        async load(signal) {
            signal?.throwIfAborted()
            const accountSignal = signalWithTimeout(signal, timeoutMs)
            const credential = await options.auth.requireCredential(accountSignal)
            const accountId = requiredAccountId(credential)
            if (
                cache?.accountId === accountId
                && cache.expiresAt > now()
            ) {
                return cache.models
            }

            const loaded = await loadFreshCatalog(
                options.auth,
                rawFetch,
                signal,
                accountSignal,
            )
            signal?.throwIfAborted()
            if (loaded.accountId !== accountId) {
                throw new Error("OpenAI account changed while loading models")
            }
            cache = {
                accountId,
                expiresAt: now() + ttlMs,
                models: loaded.models,
            }
            return loaded.models
        },
    }
}

interface ILoadedCatalog {
    readonly accountId: string
    readonly models: readonly IOpenAiCatalogModel[]
}

async function loadFreshCatalog(
    auth: IOpenAiModelCatalogAuth,
    rawFetch: typeof fetch,
    callerSignal: AbortSignal | undefined,
    accountSignal: AbortSignal,
): Promise<ILoadedCatalog> {
    const metadataController = new AbortController()
    const metadataSignal = AbortSignal.any([
        accountSignal,
        metadataController.signal,
    ])
    const metadataPromise = fetchJson(
        rawFetch,
        MODELS_DEV_API_URL,
        {
            method: "GET",
            headers: { Accept: "application/json" },
            redirect: "error",
            credentials: "omit",
            signal: metadataSignal,
        },
        "models.dev catalog",
    ).then(parseModelsDevMetadata).catch(
        () => new Map<string, IModelsDevMetadata>(),
    )

    let accountResult: {
        readonly response: Response
        readonly accountId: string
    }
    let accountValue: unknown
    try {
        accountResult = await auth.fetchModels(accountSignal)
        accountValue = await responseJson(
            accountResult.response,
            "OpenAI Codex model catalog",
        )
    } catch (error) {
        metadataController.abort(error)
        throw error
    }
    callerSignal?.throwIfAborted()

    const accountModels = parseAccountModels(accountValue)
    const metadata = await metadataPromise
    callerSignal?.throwIfAborted()
    const models = mergeCatalog(accountModels, metadata, accountResult.accountId)
    if (models.length === 0) {
        throw new Error("OpenAI Codex returned no usable models")
    }
    return {
        accountId: accountResult.accountId,
        models: Object.freeze(models),
    }
}

async function fetchJson(
    fetcher: typeof fetch,
    url: string,
    init: RequestInit,
    source: string,
): Promise<unknown> {
    const response = await fetcher(url, init)
    return responseJson(response, source)
}

async function responseJson(
    response: Response,
    source: string,
): Promise<unknown> {
    if (!response.ok) {
        throw new Error(`${source} returned HTTP ${response.status}`)
    }
    const contentLength = Number(response.headers.get("content-length"))
    if (Number.isFinite(contentLength) && contentLength > MAX_CATALOG_BYTES) {
        await response.body?.cancel()
        throw new Error(`${source} is too large`)
    }
    try {
        const text = await readBoundedText(response, source)
        return JSON.parse(text) as unknown
    } catch (cause) {
        if (cause instanceof Error && cause.message === `${source} is too large`) {
            throw cause
        }
        if (
            cause instanceof Error
            && (cause.name === "AbortError" || cause.name === "TimeoutError")
        ) {
            throw cause
        }
        throw new Error(`${source} returned invalid JSON`, { cause })
    }
}

async function readBoundedText(
    response: Response,
    source: string,
): Promise<string> {
    if (!response.body) return ""
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
        while (true) {
            const next = await reader.read()
            if (next.done) break
            size += next.value.byteLength
            if (size > MAX_CATALOG_BYTES) {
                await reader.cancel()
                throw new Error(`${source} is too large`)
            }
            chunks.push(next.value)
        }
    } finally {
        reader.releaseLock()
    }

    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
        bytes.set(chunk, offset)
        offset += chunk.byteLength
    }
    return new TextDecoder().decode(bytes)
}

function parseAccountModels(value: unknown): readonly IAccountModel[] {
    if (!isRecord(value)) {
        throw new Error("OpenAI Codex model catalog must be an object")
    }
    const entries = Array.isArray(value.models)
        ? value.models
        : Array.isArray(value.data)
            ? value.data
            : undefined
    if (!entries) {
        throw new Error("OpenAI Codex model catalog has no models array")
    }
    if (entries.length > MAX_CATALOG_MODELS) {
        throw new Error("OpenAI Codex model catalog has too many models")
    }

    const byId = new Map<string, IAccountModel>()
    entries.forEach((entry, sourceIndex) => {
        const model = parseAccountModel(entry, sourceIndex)
        if (!model) return
        const existing = byId.get(model.id)
        if (
            !existing
            || model.priority < existing.priority
            || (
                model.priority === existing.priority
                && model.sourceIndex < existing.sourceIndex
            )
        ) {
            byId.set(model.id, model)
        }
    })
    return [...byId.values()]
}

function parseAccountModel(
    value: unknown,
    sourceIndex: number,
): IAccountModel | undefined {
    if (!isRecord(value)) return undefined
    const id = modelId(value.slug) ?? modelId(value.id)
    if (!id) return undefined

    const visibility = normalizedString(value.visibility)?.toLowerCase()
    if (
        visibility === "hide"
        || visibility === "hidden"
        || visibility === "none"
    ) {
        return undefined
    }
    if (
        Array.isArray(value.input_modalities)
        && !value.input_modalities.some(
            (modality) => normalizedString(modality)?.toLowerCase() === "text",
        )
    ) {
        return undefined
    }

    const reasoningEfforts = accountReasoningEfforts(
        value.supported_reasoning_levels,
    )
    const defaultReasoningEffort = reasoningEffort(
        value.default_reasoning_level,
    )
    const priority = typeof value.priority === "number"
        && Number.isFinite(value.priority)
        ? value.priority
        : Number.MAX_SAFE_INTEGER
    const name = displayName(value.display_name)
    const contextWindowTokens = positiveInteger(value.context_window)
    const fastServiceTier = accountFastServiceTier(value)
    return {
        id,
        priority,
        sourceIndex,
        ...(name ? { name } : {}),
        ...(reasoningEfforts === undefined ? {} : { reasoningEfforts }),
        ...(defaultReasoningEffort === undefined
            ? {}
            : { defaultReasoningEffort }),
        ...(contextWindowTokens === undefined
            ? {}
            : { contextWindowTokens }),
        ...(fastServiceTier === undefined ? {} : { fastServiceTier }),
    }
}

function parseModelsDevMetadata(
    value: unknown,
): ReadonlyMap<string, IModelsDevMetadata> {
    if (!isRecord(value) || !isRecord(value.openai)) {
        return new Map()
    }
    const models = value.openai.models
    if (!isRecord(models)) return new Map()
    const entries = Object.entries(models)
    if (entries.length > MAX_CATALOG_MODELS) return new Map()

    const metadata = new Map<string, IModelsDevMetadata>()
    for (const [recordId, candidate] of entries) {
        if (!isRecord(candidate)) continue
        const id = modelId(candidate.id) ?? modelId(recordId)
        if (!id || metadata.has(id)) continue
        const name = displayName(candidate.name)
        const efforts = modelsDevReasoningEfforts(candidate)
        metadata.set(id, {
            id,
            ...(name ? { name } : {}),
            ...(efforts === undefined ? {} : { reasoningEfforts: efforts }),
        })
    }
    return metadata
}

function mergeCatalog(
    accountModels: readonly IAccountModel[],
    metadata: ReadonlyMap<string, IModelsDevMetadata>,
    accountId: string,
): IOpenAiCatalogModel[] {
    const baseModelIds = new Set(accountModels.map((model) => model.id))
    const sortedModels = [...accountModels].sort((left, right) =>
        left.priority - right.priority || left.id.localeCompare(right.id)
    )
    return sortedModels.flatMap((account): IOpenAiCatalogModel[] => {
        const published = metadata.get(account.id)
        const reasoningEfforts = mergedReasoningEfforts(account, published)
        if (!reasoningEfforts || reasoningEfforts.length === 0) return []

        const defaultReasoningEffort = account.defaultReasoningEffort
            && reasoningEfforts.includes(account.defaultReasoningEffort)
            ? account.defaultReasoningEffort
            : reasoningEfforts.includes("medium")
                ? "medium"
                : reasoningEfforts[0]
        if (!defaultReasoningEffort) return []

        const accountName = account.name
        const name = accountName && accountName !== account.id
            ? accountName
            : published?.name ?? accountName ?? account.id
        const frozenReasoningEfforts = Object.freeze([...reasoningEfforts])
        const base: IOpenAiCatalogModel = Object.freeze({
            id: account.id,
            modelId: account.id,
            accountId,
            name,
            reasoningEfforts: frozenReasoningEfforts,
            defaultReasoningEffort,
            ...(account.contextWindowTokens === undefined
                ? {}
                : { contextWindowTokens: account.contextWindowTokens }),
        })
        const fastId = `${account.id}${FAST_SELECTION_SUFFIX}`
        if (
            account.fastServiceTier === undefined
            || baseModelIds.has(fastId)
        ) {
            return [base]
        }
        const fast: IOpenAiCatalogModel = Object.freeze({
            ...base,
            id: fastId,
            name: fastDisplayName(name),
            serviceTier: account.fastServiceTier,
        })
        return [base, fast]
    })
}

function accountFastServiceTier(
    model: Record<string, unknown>,
): "priority" | undefined {
    if (
        Array.isArray(model.service_tiers)
        && model.service_tiers.some((candidate) =>
            isRecord(candidate)
            && normalizedString(candidate.id)?.toLowerCase() === "priority"
        )
    ) {
        return "priority"
    }
    if (
        Array.isArray(model.additional_speed_tiers)
        && model.additional_speed_tiers.some((candidate) =>
            normalizedString(candidate)?.toLowerCase() === "fast"
        )
    ) {
        return "priority"
    }
    return undefined
}

function mergedReasoningEfforts(
    account: IAccountModel,
    published: IModelsDevMetadata | undefined,
): readonly ReasoningEffort[] | undefined {
    if (account.reasoningEfforts !== undefined) {
        return account.reasoningEfforts.length > 0
            ? account.reasoningEfforts
            : account.defaultReasoningEffort
                ? [account.defaultReasoningEffort]
                : undefined
    }

    const publishedEfforts = published?.reasoningEfforts
    if (
        publishedEfforts?.length
        && (
            account.defaultReasoningEffort === undefined
            || publishedEfforts.includes(account.defaultReasoningEffort)
        )
    ) {
        return publishedEfforts
    }
    return account.defaultReasoningEffort
        ? [account.defaultReasoningEffort]
        : publishedEfforts?.length
            ? publishedEfforts
            : ["none"]
}

function accountReasoningEfforts(
    value: unknown,
): readonly ReasoningEffort[] | undefined {
    if (!Array.isArray(value)) return undefined
    const found = new Set<ReasoningEffort>()
    for (const candidate of value) {
        const effort = reasoningEffort(
            isRecord(candidate) ? candidate.effort : candidate,
        )
        if (effort) found.add(effort)
    }
    return REASONING_EFFORTS.filter((effort) => found.has(effort))
}

function modelsDevReasoningEfforts(
    model: Record<string, unknown>,
): readonly ReasoningEffort[] | undefined {
    if (Array.isArray(model.reasoning_options)) {
        const option = model.reasoning_options.find(
            (candidate) => isRecord(candidate) && candidate.type === "effort",
        )
        if (isRecord(option) && Array.isArray(option.values)) {
            const found = new Set<ReasoningEffort>()
            for (const value of option.values) {
                const effort = value === null ? "none" : reasoningEffort(value)
                if (effort) found.add(effort)
            }
            return REASONING_EFFORTS.filter((effort) => found.has(effort))
        }
    }
    return model.reasoning === false ? ["none"] : undefined
}

function reasoningEffort(value: unknown): ReasoningEffort | undefined {
    const normalized = normalizedString(value)?.toLowerCase()
    return REASONING_EFFORTS.find((effort) => effort === normalized)
}

function modelId(value: unknown): string | undefined {
    const normalized = normalizedString(value)
    if (
        !normalized
        || normalized.length > 200
        || /[\u0000-\u001f\u007f-\u009f]/.test(normalized)
    ) {
        return undefined
    }
    return normalized
}

function displayName(value: unknown): string | undefined {
    const normalized = normalizedString(value)
        ?.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
    if (!normalized) return undefined
    return [...normalized].slice(0, MAX_DISPLAY_NAME_CHARACTERS).join("")
}

function fastDisplayName(baseName: string): string {
    const baseCharacters = MAX_DISPLAY_NAME_CHARACTERS
        - [...FAST_NAME_SUFFIX].length
    const truncatedBase = [...baseName]
        .slice(0, baseCharacters)
        .join("")
        .trimEnd()
    return `${truncatedBase}${FAST_NAME_SUFFIX}`
}

function normalizedString(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined
    const normalized = value.trim()
    return normalized || undefined
}

function positiveInteger(value: unknown): number | undefined {
    return typeof value === "number"
        && Number.isSafeInteger(value)
        && value > 0
        ? value
        : undefined
}

function requiredAccountId(credential: IOAuthCredential): string {
    const accountId = credential.accountId?.trim()
    if (!accountId) {
        throw new Error("OpenAI OAuth credential has no account ID")
    }
    return accountId
}

function signalWithTimeout(
    signal: AbortSignal | undefined,
    timeoutMs: number,
): AbortSignal {
    const timeout = AbortSignal.timeout(timeoutMs)
    return signal ? AbortSignal.any([signal, timeout]) : timeout
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}
