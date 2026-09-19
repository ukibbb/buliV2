import { expect, mock, test } from "bun:test"
import { createKimiModelCatalog } from "./kimi-model-catalog"

function fixture(respond: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
    const request = mock(respond)
    const auth = { authenticatedFetch: Object.assign(request, { preconnect: () => undefined }) }
    return { auth, request, catalog: createKimiModelCatalog({ auth }) }
}

test("loads only supported API-listed IDs with explicit metadata provenance and no cache", async () => {
    const { catalog, request } = fixture(async () => Response.json({ data: [
        { id: "k3", context_length: 262144, supports_reasoning: true },
        { id: "k3-256k", context_length: 262144 },
        { id: "kimi-for-coding" },
        { id: "kimi-for-coding-highspeed" },
        { id: "future-model" },
    ] }))
    const models = await catalog.load()
    expect(models.map((model) => model.modelId)).toEqual(["k3", "k3-256k", "kimi-for-coding"])
    expect(models.map((model) => model.defaultReasoningEffort)).toEqual(["high", "high", "max"])
    expect(models[0]).toMatchObject({
        contextWindowTokens: 262144,
        reasoningEfforts: ["low", "high", "max"],
        provenance: { availability: "api-listed-not-inference-verified", contextWindowTokens: "api-declared" },
    })
    expect(models[2]).not.toHaveProperty("contextWindowTokens")
    expect(models[2]?.provenance).not.toHaveProperty("contextWindowTokens")
    expect(Object.isFrozen(models)).toBe(true)
    await catalog.load()
    expect(request).toHaveBeenCalledTimes(2)
    expect(request.mock.calls[0]?.[0]).toBe("https://api.kimi.com/coding/v1/models")
    expect(request.mock.calls[0]?.[1]?.method).toBe("GET")
})

test.each([
    null, {}, { data: {} }, { data: [null] }, { data: [{ id: 1 }] },
    { data: [{ id: "k3" }, { id: "k3" }] },
    ...[0, -1, 1.5, "262144", null].map((context_length) => ({ data: [{ id: "k3", context_length }] })),
    { data: [{ id: "k3", supports_reasoning: "true" }] },
    { data: [{ id: "k3", supports_image_in: 1 }] },
    { data: [{ id: "k3", display_name: {} }] },
])("rejects invalid catalog metadata: %j", async (value) => {
    const { catalog } = fixture(async () => Response.json(value))
    await expect(catalog.load()).rejects.toThrow("Kimi catalog")
})

test.each([{ data: [] }, { data: [{ id: "unknown" }] }, { data: [{ id: "k3", supports_reasoning: false }] }])(
    "does not manufacture usable models: %j", async ({ data }) => {
        const { catalog } = fixture(async () => Response.json({ data }))
        await expect(catalog.load()).rejects.toThrow("no supported models")
    },
)

test.each([401, 403, 429, 500, 503])("sanitizes HTTP %s and does not retry", async (status) => {
    const { catalog, request } = fixture(async () => new Response("synthetic-secret", { status }))
    await expect(catalog.load()).rejects.toThrow(`Kimi catalog returned HTTP ${status}`)
    expect(request).toHaveBeenCalledTimes(1)
})

test("sanitizes JSON and transport failures", async () => {
    const invalid = fixture(async () => new Response("synthetic-secret"))
    await expect(invalid.catalog.load()).rejects.toThrow("Invalid Kimi catalog JSON")
    const failed = fixture(async () => { throw new Error("synthetic-secret") })
    await expect(failed.catalog.load()).rejects.toThrow("Kimi catalog could not be loaded")
})

test("pre-aborted discovery makes no request", async () => {
    const { catalog, request } = fixture(async () => Response.json({ data: [] }))
    const reason = new Error("cancelled")
    await expect(catalog.load(AbortSignal.abort(reason))).rejects.toBe(reason)
    expect(request).not.toHaveBeenCalled()
})

test.each(["cancel", "timeout"] as const)("%s interrupts pending body and cancels it", async (mode) => {
    const entered = Promise.withResolvers<void>()
    const cancel = mock(() => {})
    const { auth } = fixture(async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(new TextEncoder().encode('{"data":['))
            entered.resolve()
        },
        cancel,
    })))
    const catalog = createKimiModelCatalog({ auth, timeoutMs: mode === "timeout" ? 20 : 1000 })
    const controller = new AbortController()
    const outcome = catalog.load(controller.signal).then(() => undefined, (error: unknown) => error)
    await entered.promise
    if (mode === "cancel") controller.abort(new Error("cancelled"))
    const error = await outcome
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).name).toBe(mode === "timeout" ? "TimeoutError" : "Error")
    expect(cancel).toHaveBeenCalledTimes(1)
})
