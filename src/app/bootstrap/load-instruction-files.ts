import {
    mkdir,
    readFile,
    readdir,
    realpath,
    stat,
} from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"

import type { IInstructionFile } from "@/agent"

export const INSTRUCTION_FILE_MAX_BYTES = 64 * 1024

/** Claude Code follows `@path` imports at most four hops from the importing file. */
const MAX_IMPORT_DEPTH = 4

const WORKSPACE_INSTRUCTION_FILES = [
    "BULI.md",
    "AGENTS.md",
    "CLAUDE.md",
] as const

/** User-level instructions shared with Claude Code. */
export function defaultUserInstructionsPath(): string {
    return join(homeDirectory(), ".claude", "CLAUDE.md")
}

/** `$HOME` is read live because Bun's `homedir()` keeps the value from process start. */
function homeDirectory(): string {
    return process.env.HOME || homedir()
}

/**
 * Loads instructions in Claude Code's order: the user's file followed by the files it
 * imports, the workspace root `CLAUDE.md`, then the highest-priority `.buli` file,
 * which also creates `.buli`. The user and root files are optional. `workspaceRoot`
 * must already be a real path.
 */
export async function loadInstructionFiles(
    workspaceRoot: string,
    userInstructionsPath: string,
    signal: AbortSignal,
): Promise<readonly IInstructionFile[]> {
    signal.throwIfAborted()
    const files = [
        ...await loadUserInstructions(userInstructionsPath, signal),
        await skipIfMissing(() => readWorkspaceFile(workspaceRoot, "CLAUDE.md", signal)),
        await loadBuliInstructions(workspaceRoot, signal),
    ]
    return files.filter((file) => file !== undefined)
}

/**
 * Reads the user's file, then each file it imports with `@path`, depth-first.
 * An import that cannot be read is skipped like in Claude Code, so a prose mention
 * such as `@docs/` never blocks startup. A file is read once, at the depth where it
 * is first reached; a file first reached at the depth limit keeps its imports unread.
 */
async function loadUserInstructions(
    path: string,
    signal: AbortSignal,
): Promise<readonly IInstructionFile[]> {
    const files: IInstructionFile[] = []
    const visited = new Set<string>()
    const visit = async (source: string, depth: number): Promise<void> => {
        if (visited.has(source)) return
        visited.add(source)
        const read = () => readInstructionFile(source, source, signal)
        const file = depth === 0
            ? await skipIfMissing(read)
            : await read().catch(() => {
                signal.throwIfAborted()
                return undefined
            })
        if (file === undefined) return
        files.push(file)
        if (depth === MAX_IMPORT_DEPTH) return
        for (const importPath of findImportPaths(file.content)) {
            await visit(resolveImportPath(importPath, dirname(source)), depth + 1)
        }
    }
    await visit(path, 0)
    return files
}

/**
 * `@path` references outside code blocks and code spans; `\ ` escapes a space.
 * A fence may be indented (as in list items) and an unclosed one runs to the end.
 */
function findImportPaths(content: string): string[] {
    const prose = content
        .replace(/^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^[ \t]*\1[`~]*[ \t]*$|(?![\s\S]))/gm, "")
        .replace(/`[^`\n]*`/g, "")
    return [...prose.matchAll(/(?:^|\s)@((?:\\ |\S)+)/g)]
        .map(([, path = ""]) => path.replaceAll("\\ ", " "))
}

/** Resolves `~` to the home directory and other relative paths against the importing file. */
function resolveImportPath(path: string, importingDirectory: string): string {
    if (path === "~" || path.startsWith("~/")) return join(homeDirectory(), path.slice(1))
    return resolve(importingDirectory, path)
}

/** Reads the file appended to Buli's system prompt. */
export async function loadSystemPromptFile(path: string, signal: AbortSignal): Promise<string> {
    const source = resolve(path)
    return (await readInstructionFile(source, source, signal)).content
}

/** Creates `.buli` and loads its highest-priority instruction file. */
async function loadBuliInstructions(
    root: string,
    signal: AbortSignal,
): Promise<IInstructionFile | undefined> {
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

/** Reads a workspace file whose real path must stay inside the workspace. */
async function readWorkspaceFile(
    root: string,
    source: string,
    signal: AbortSignal,
): Promise<IInstructionFile> {
    let target: string
    try {
        target = await realpath(join(root, source))
    } catch (cause) {
        signal.throwIfAborted()
        throw new Error(`Unable to inspect instructions: ${source}`, { cause })
    }
    signal.throwIfAborted()
    if (!isPathInside(root, target)) {
        throw new Error(
            `Workspace instructions resolve outside the workspace: ${source}`,
        )
    }
    return await readInstructionFile(target, source, signal)
}

/** Reads a regular file, following symlinks, as bounded UTF-8 text without NUL bytes. */
async function readInstructionFile(
    path: string,
    source: string,
    signal: AbortSignal,
): Promise<IInstructionFile> {
    let size: number
    try {
        const metadata = await stat(path)
        if (!metadata.isFile()) {
            throw new TypeError("Instructions are not a regular file")
        }
        size = metadata.size
    } catch (cause) {
        signal.throwIfAborted()
        throw new Error(`Unable to inspect instructions: ${source}`, {
            cause,
        })
    }
    signal.throwIfAborted()
    if (size > INSTRUCTION_FILE_MAX_BYTES) {
        throw new Error(
            `Instructions exceed ${INSTRUCTION_FILE_MAX_BYTES} bytes: ${source}`,
        )
    }

    let bytes: Uint8Array
    try {
        bytes = await readFile(path, { signal })
    } catch (cause) {
        signal.throwIfAborted()
        throw new Error(`Unable to read instructions: ${source}`, {
            cause,
        })
    }
    signal.throwIfAborted()
    if (bytes.byteLength > INSTRUCTION_FILE_MAX_BYTES) {
        throw new Error(
            `Instructions exceed ${INSTRUCTION_FILE_MAX_BYTES} bytes: ${source}`,
        )
    }
    if (bytes.includes(0)) {
        throw new Error(`Instructions contain a NUL byte: ${source}`)
    }

    let content: string
    try {
        content = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    } catch (cause) {
        throw new Error(`Instructions are not valid UTF-8: ${source}`, {
            cause,
        })
    }
    return { source, content }
}

/** Optional files: a missing one yields undefined; any other failure still throws. */
async function skipIfMissing(
    read: () => Promise<IInstructionFile>,
): Promise<IInstructionFile | undefined> {
    try {
        return await read()
    } catch (error) {
        if (error instanceof Error && hasCode(error.cause, "ENOENT")) return undefined
        throw error
    }
}

function isPathInside(root: string, target: string): boolean {
    const workspacePath = relative(root, target)
    return workspacePath === "" || (
        workspacePath !== ".."
        && !workspacePath.startsWith(`..${sep}`)
        && !isAbsolute(workspacePath)
    )
}

function hasCode(error: unknown, code: string): boolean {
    return typeof error === "object" && error !== null && "code" in error && error.code === code
}
