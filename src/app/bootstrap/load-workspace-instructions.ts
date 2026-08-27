import {
    mkdir,
    readFile,
    readdir,
    realpath,
    stat,
} from "node:fs/promises"
import { isAbsolute, join, relative, sep } from "node:path"

import type { WorkspaceInstructions } from "@/agent"

export const WORKSPACE_INSTRUCTIONS_MAX_BYTES = 64 * 1024

const WORKSPACE_INSTRUCTION_FILES = [
    "BULI.md",
    "AGENTS.md",
    "CLAUDE.md",
] as const

/** Creates `.buli` and loads its highest-priority workspace instruction file. */
export async function loadWorkspaceInstructions(
    workspaceRoot: string,
    signal: AbortSignal,
): Promise<WorkspaceInstructions | undefined> {
    signal.throwIfAborted()
    const root = await realpath(workspaceRoot)
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

    const source = `.buli/${fileName}`
    const candidate = join(resolvedDirectory, fileName)
    let target: string
    try {
        target = await realpath(candidate)
    } catch (cause) {
        signal.throwIfAborted()
        throw new Error(`Unable to inspect workspace instructions: ${source}`, {
            cause,
        })
    }
    signal.throwIfAborted()
    if (!isPathInside(root, target)) {
        throw new Error(
            `Workspace instructions resolve outside the workspace: ${source}`,
        )
    }

    let size: number
    try {
        const metadata = await stat(target)
        if (!metadata.isFile()) {
            throw new TypeError("Workspace instructions are not a regular file")
        }
        size = metadata.size
    } catch (cause) {
        signal.throwIfAborted()
        throw new Error(`Unable to inspect workspace instructions: ${source}`, {
            cause,
        })
    }
    signal.throwIfAborted()
    if (size > WORKSPACE_INSTRUCTIONS_MAX_BYTES) {
        throw new Error(
            `Workspace instructions exceed ${WORKSPACE_INSTRUCTIONS_MAX_BYTES} bytes: ${source}`,
        )
    }

    let bytes: Uint8Array
    try {
        bytes = await readFile(target, { signal })
    } catch (cause) {
        signal.throwIfAborted()
        throw new Error(`Unable to read workspace instructions: ${source}`, {
            cause,
        })
    }
    signal.throwIfAborted()
    if (bytes.byteLength > WORKSPACE_INSTRUCTIONS_MAX_BYTES) {
        throw new Error(
            `Workspace instructions exceed ${WORKSPACE_INSTRUCTIONS_MAX_BYTES} bytes: ${source}`,
        )
    }
    if (bytes.includes(0)) {
        throw new Error(`Workspace instructions contain a NUL byte: ${source}`)
    }

    let content: string
    try {
        content = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    } catch (cause) {
        throw new Error(`Workspace instructions are not valid UTF-8: ${source}`, {
            cause,
        })
    }
    return { source, content }
}

function isPathInside(root: string, target: string): boolean {
    const workspacePath = relative(root, target)
    return workspacePath === "" || (
        workspacePath !== ".."
        && !workspacePath.startsWith(`..${sep}`)
        && !isAbsolute(workspacePath)
    )
}
