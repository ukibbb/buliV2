import { expect, test } from "bun:test"
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadModelPreferences, saveModelPreferences } from "./model-preferences"

function fixture() {
    const directory = mkdtempSync(join(tmpdir(), "buli-preferences-"))
    return { directory, path: join(directory, "nested", "preferences.json"), dispose: () => rmSync(directory, { recursive: true, force: true }) }
}

test("missing preferences use defaults; saved pair round-trips and is replaced completely", () => {
    const f = fixture()
    try {
        expect(loadModelPreferences(f.path)).toEqual({})
        const first = { modelId: "kimi", reasoningEffort: "high" as const }
        saveModelPreferences(f.path, first)
        expect(loadModelPreferences(f.path)).toEqual({ selection: first })
        const second = { modelId: "deepseek", reasoningEffort: "max" as const }
        saveModelPreferences(f.path, second)
        expect(loadModelPreferences(f.path)).toEqual({ selection: second })
        expect(readdirSync(join(f.directory, "nested"))).toEqual(["preferences.json"])
    } finally { f.dispose() }
})

for (const content of ["{", "null", "[]", '{"modelId":"x","reasoningEffort":"unknown"}', '{"modelId":" ","reasoningEffort":"high"}']) {
    test(`invalid preferences produce warning: ${content}`, () => {
        const f = fixture()
        try {
            const path = join(f.directory, "preferences.json")
            writeFileSync(path, content)
            expect(loadModelPreferences(path).selection).toBeUndefined()
            expect(loadModelPreferences(path).warning).toContain("Using defaults")
        } finally { f.dispose() }
    })
}

test("read and write failures are reported", () => {
    const f = fixture()
    try {
        expect(loadModelPreferences(f.directory).warning).toContain("Could not read")
        expect(() => saveModelPreferences(f.directory, { modelId: "x", reasoningEffort: "high" })).toThrow("Could not save")
        expect(readdirSync(f.directory)).toEqual([])
    } finally { f.dispose() }
})
