import { mkdir, readdir, realpath, stat } from "node:fs/promises"
import { join } from "node:path"

import type { IInstructionFile } from "@/agent"
import { isPathInside, readWorkspaceFile } from "@/common/instruction-text"

const WORKSPACE_INSTRUCTION_FILES = [
    "BULI.md",
    "AGENTS.md",
    "CLAUDE.md",
] as const

/** Creates `.buli` and loads its highest-priority instruction file. */
export async function loadBuliInstructions(
    root: string,
    signal: AbortSignal,
): Promise<IInstructionFile | undefined> {
    signal.throwIfAborted()
    const directory = join(root, ".buli")
    try {
        await mkdir(directory, { recursive: true })
    } catch (cause) {
        signal.throwIfAborted()
        throw new Error(
            `Unable to prepare workspace instructions directory: ${directory}`,
            { cause },
        )
    }
    signal.throwIfAborted()

    let resolvedDirectory: string
    try {
        resolvedDirectory = await realpath(directory)
        const metadata = await stat(resolvedDirectory)
        if (!metadata.isDirectory()) {
            throw new TypeError("Workspace instructions path is not a directory")
        }
    } catch (cause) {
        signal.throwIfAborted()
        throw new Error(
            `Unable to inspect workspace instructions directory: ${directory}`,
            { cause },
        )
    }
    signal.throwIfAborted()
    if (!isPathInside(root, resolvedDirectory)) {
        throw new Error(
            `Workspace instructions directory resolves outside the workspace: ${directory}`,
        )
    }

    let entries: readonly string[]
    try {
        entries = await readdir(resolvedDirectory)
    } catch (cause) {
        signal.throwIfAborted()
        throw new Error(
            `Unable to inspect workspace instructions directory: ${directory}`,
            { cause },
        )
    }
    signal.throwIfAborted()

    const fileName = WORKSPACE_INSTRUCTION_FILES.find((candidate) =>
        entries.includes(candidate)
    )
    if (fileName === undefined) return undefined
    return await readWorkspaceFile(root, `.buli/${fileName}`, signal)
}
