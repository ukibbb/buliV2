import { randomUUID } from "node:crypto"
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { TReasoningEffort } from "@/agent"
import type { IBuliModelSelection } from "@/app/contracts"

const REASONING_EFFORTS: readonly TReasoningEffort[] = [
    "none", "minimal", "low", "medium", "high", "xhigh", "max",
]

export function defaultModelPreferencesPath(): string {
    return join(homedir(), ".buli", "preferences.json")
}

export interface ILoadedModelPreferences {
    readonly selection?: IBuliModelSelection
    readonly warning?: string
}

export function loadModelPreferences(filePath: string): ILoadedModelPreferences {
    try {
        const value: unknown = JSON.parse(readFileSync(filePath, "utf8"))
        if (!isModelSelection(value)) throw new Error("Invalid model preferences")
        return { selection: { modelId: value.modelId, reasoningEffort: value.reasoningEffort } }
    } catch (error) {
        if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
            return {}
        }
        return { warning: `Could not read model preferences at "${filePath}". Using defaults. ${error instanceof Error ? error.message : String(error)}` }
    }
}

export function saveModelPreferences(filePath: string, selection: IBuliModelSelection): void {
    if (!isModelSelection(selection)) throw new Error("Invalid model preferences")
    const temporaryPath = `${filePath}.${randomUUID()}.tmp`
    try {
        mkdirSync(dirname(filePath), { recursive: true })
        writeFileSync(temporaryPath, JSON.stringify(selection, null, 2) + "\n", { encoding: "utf8", mode: 0o600, flag: "wx" })
        renameSync(temporaryPath, filePath)
    } catch (error) {
        throw new Error(`Could not save model preferences at "${filePath}". Selection was not changed.`, { cause: error })
    } finally {
        try {
            rmSync(temporaryPath, { force: true })
        } catch {
            // Cleanup must not hide the original write error or reject a committed save.
        }
    }
}

function isModelSelection(value: unknown): value is IBuliModelSelection {
    if (typeof value !== "object" || value === null) return false
    if (!("modelId" in value) || typeof value.modelId !== "string" || !value.modelId.trim()) return false
    return "reasoningEffort" in value && REASONING_EFFORTS.some((effort) => effort === value.reasoningEffort)
}
