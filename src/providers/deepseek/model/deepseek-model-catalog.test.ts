import { expect, mock, test } from "bun:test"
import { createDeepSeekModelCatalog } from "./deepseek-model-catalog"

const item = (id: string) => ({ id, object: "model", owned_by: "deepseek" })
const list = (...ids: string[]) => ({ object: "list", data: ids.map(item) })
function fixture(reply: () => Promise<Response>, timeoutMs?: number) {
    const request = mock(reply)
    const catalog = createDeepSeekModelCatalog({ auth: { authenticatedFetch: Object.assign(request, { preconnect: () => undefined }) }, ...(timeoutMs === undefined ? {} : { timeoutMs }) })
    return { catalog, request }
}
test("lists supported IDs only; documentation metadata is immutable and distinct from availability", async () => {
    const f = fixture(async () => Response.json(list("deepseek-flash", "deepseek-v4-pro", "deepseek-chat", "unknown")))
    const models = await f.catalog.load()
    expect(Object.isFrozen(models[0]?.provenance)).toBe(true)
    expect(models.map(m => m.modelId)).toEqual(["deepseek-flash", "deepseek-v4-pro"])
    expect(models[0]).toMatchObject({ contextWindowTokens: 1048576, maxOutputTokens: 393216, reasoningEfforts: ["low", "high", "max"], defaultReasoningEffort: "high", providerInputModalities: ["text", "image"], adapterInputModalities: ["text"], provenance: { availability: "api-listed-not-inference-verified", contextWindowTokens: expect.stringContaining("https://") } })
    expect(models[1]?.providerInputModalities).toEqual(["text"])
    expect(Object.isFrozen(models)).toBe(true)
    await f.catalog.load()
    expect(f.request).toHaveBeenCalledTimes(2)
    expect(f.request).toHaveBeenCalledWith("https://api.deepseek.com/models", expect.objectContaining({ method: "GET" }))
})
test.each([list(), list("unknown")])("valid empty supported list is authoritative %j", async value => {
    expect(await fixture(async () => Response.json(value)).catalog.load()).toEqual([])
})
test.each([null, {}, { data: [] }, { object: "list", data: {} }, { object: "list", data: [null] }, { object: "list", data: [{ id: "deepseek-flash" }] }, list("deepseek-flash", "deepseek-flash"), list(" ")])("rejects malformed catalog %j", async value => {
    await expect(fixture(async () => Response.json(value)).catalog.load()).rejects.toThrow("DeepSeek catalog")
})
test.each([400, 401, 403, 429, 503])("sanitizes HTTP %s without retry", async status => {
    const f = fixture(async () => new Response("synthetic-secret", { status }))
    await expect(f.catalog.load()).rejects.toThrow(`DeepSeek catalog returned HTTP ${status}`)
    expect(f.request).toHaveBeenCalledTimes(1)
})
test("invalid UTF-8, JSON and network failures are sanitized", async () => {
    for (const body of ["secret", new Uint8Array([0xff])]) {
        await expect(fixture(async () => new Response(body)).catalog.load()).rejects.toThrow("Invalid DeepSeek catalog JSON")
    }
    await expect(fixture(async () => { throw new Error("secret") }).catalog.load()).rejects.toThrow("DeepSeek catalog could not be loaded")
})
test("pre-abort does not call fetch", async () => {
    const f = fixture(async () => Response.json(list()))
    const reason = new Error("cancelled")
    await expect(f.catalog.load(AbortSignal.abort(reason))).rejects.toBe(reason)
    expect(f.request).not.toHaveBeenCalled()
})
test.each(["cancel", "timeout"] as const)("%s cleans pending response body", async mode => {
    const entered = Promise.withResolvers<void>()
    const cancel = mock(() => {})
    const f = fixture(async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new TextEncoder().encode('{"object":"list","data":[')); entered.resolve() }, cancel,
    })), mode === "timeout" ? 20 : 1000)
    const controller = new AbortController()
    const outcome = f.catalog.load(controller.signal).catch((error: unknown) => error)
    await entered.promise
    if (mode === "cancel") controller.abort(new Error("cancelled"))
    expect(await outcome).toBeInstanceOf(Error)
    expect(cancel).toHaveBeenCalledTimes(1)
})
