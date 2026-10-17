import { expect, test } from "bun:test"

import { getModelFeedback } from "@/ui/chat/model-feedback"

type TModelFeedbackSource = Parameters<typeof getModelFeedback>[0]

const MODEL_ID = "test-model"
const MODEL_NAME = "Test model"
const REASONING_EFFORT = "high"
const CATALOG_STATUSES = [undefined, "loading", "ready", "error"] as const

function modelSource(overrides: Partial<TModelFeedbackSource> = {}): TModelFeedbackSource {
    return {
        models: [{ id: MODEL_ID, name: MODEL_NAME, reasoningEfforts: [REASONING_EFFORT] }],
        selection: { modelId: MODEL_ID, reasoningEffort: REASONING_EFFORT },
        ...overrides,
    }
}

function catalogSource(status: (typeof CATALOG_STATUSES)[number]): TModelFeedbackSource {
    return modelSource(status === undefined ? {} : { modelCatalog: { status } })
}

test.each([
    [undefined, MODEL_NAME, REASONING_EFFORT],
    ["loading", "Loading models", "--"],
    ["ready", MODEL_NAME, REASONING_EFFORT],
    ["error", "Model unavailable", "--"],
] as const)("falls back to catalog readiness when availability is absent (%s)", (status, name, effort) => {
    const feedback = getModelFeedback(catalogSource(status), null)

    expect(feedback.selectedModelName).toBe(name)
    expect(feedback.reasoningEffort).toBe(effort)
})

test.each([...CATALOG_STATUSES])("explicit availability takes precedence over catalog status (%s)", (status) => {
    const source = { ...catalogSource(status), selectedModelAvailable: true }
    const feedback = getModelFeedback(source, null)

    expect(feedback.selectedModelName).toBe(MODEL_NAME)
    expect(feedback.reasoningEffort).toBe(REASONING_EFFORT)
})

test.each([...CATALOG_STATUSES])("explicit unavailability takes precedence over catalog status (%s)", (status) => {
    const source = { ...catalogSource(status), selectedModelAvailable: false }
    const feedback = getModelFeedback(source, null)

    expect(feedback.selectedModelName).toBe(status === "loading" ? "Loading models" : "Model unavailable")
    expect(feedback.reasoningEffort).toBe("--")
})

test("uses the selected model ID when its display entry is missing", () => {
    const feedback = getModelFeedback(modelSource({ models: [] }), null)

    expect(feedback.selectedModelName).toBe(MODEL_ID)
    expect(feedback.reasoningEffort).toBe(REASONING_EFFORT)
})

test("preserves an explicitly empty model name rather than replacing it with the ID", () => {
    const feedback = getModelFeedback(modelSource({
        models: [{ id: MODEL_ID, name: "", reasoningEfforts: [REASONING_EFFORT] }],
    }), null)

    expect(feedback.selectedModelName).toBe("")
})

test.each([
    [undefined, null],
    [{ status: "ready" }, null],
    [{ status: "error" }, null],
    [{ status: "loading" }, { message: "Loading available account models...", severity: "warning" }],
    [{ status: "loading", message: "Please wait" }, { message: "Please wait", severity: "warning" }],
    [{ status: "ready", message: "Catalog refreshed" }, { message: "Catalog refreshed", severity: "warning" }],
    [{ status: "error", message: "Catalog failed" }, { message: "Catalog failed", severity: "error" }],
    [{ status: "loading", message: "" }, null],
] as const)("derives the catalog notice without inventing missing errors (%j)", (catalog, expected) => {
    const source = modelSource(catalog === undefined ? {} : { modelCatalog: catalog })

    expect(getModelFeedback(source, null).catalogNotice).toEqual(expected)
})

test.each([
    [{ status: "loading" }, "Loading available account models..."],
    [{ status: "error", message: "Catalog failed" }, "Catalog failed"],
] as const)("does not duplicate a catalog notice already shown as input error (%j)", (catalog, inputError) => {
    const source = modelSource({ modelCatalog: catalog })

    expect(getModelFeedback(source, inputError).catalogNotice).toBeNull()
})

test("retains a catalog notice when the input error is different", () => {
    const source = modelSource({ modelCatalog: { status: "error", message: "Catalog failed" } })

    expect(getModelFeedback(source, "Could not paste").catalogNotice).toEqual({
        message: "Catalog failed",
        severity: "error",
    })
})

test("keeps catalog warnings independent of explicit model availability", () => {
    const source = modelSource({
        selectedModelAvailable: true,
        modelCatalog: { status: "error", message: "Discovery failed" },
    })

    expect(getModelFeedback(source, null)).toMatchObject({
        selectedModelName: MODEL_NAME,
        reasoningEffort: REASONING_EFFORT,
        catalogNotice: { message: "Discovery failed", severity: "error" },
    })
})

test("returns no provider warnings when provider catalogs are absent", () => {
    expect(getModelFeedback(modelSource(), null).providerWarnings).toEqual([])
})

test("reports only failed provider catalogs and preserves their order and IDs", () => {
    const source = modelSource({
        providerCatalogs: [
            { providerId: "ready", status: "ready", stale: true, message: "Not an error" },
            { providerId: "second", status: "error", stale: false, message: "Second failed" },
            { providerId: "disconnected", status: "disconnected", stale: false, message: "Not connected" },
            { providerId: "first", status: "error", stale: true, message: "First failed" },
        ],
    })

    expect(getModelFeedback(source, null).providerWarnings).toEqual([
        { providerId: "second", message: "Second failed" },
        { providerId: "first", message: "First failed Using the previous catalog." },
    ])
})

test.each([
    [undefined, false, ""],
    [undefined, true, " Using the previous catalog."],
    ["", false, ""],
    ["", true, " Using the previous catalog."],
    ["Provider failed", false, "Provider failed"],
    ["Provider failed", true, "Provider failed Using the previous catalog."],
] as const)("preserves optional provider text and the stale-catalog suffix (%j, stale=%s)", (message, stale, expected) => {
    const source = modelSource({
        providerCatalogs: [{
            providerId: "provider",
            status: "error",
            stale,
            ...(message === undefined ? {} : { message }),
        }],
    })

    expect(getModelFeedback(source, null).providerWarnings).toEqual([
        { providerId: "provider", message: expected },
    ])
})
