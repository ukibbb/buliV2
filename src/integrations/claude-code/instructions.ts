import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"

import type { IInstructionFile } from "@/agent"
import { readInstructionFile, readWorkspaceFile, skipIfMissing } from "@/common/instruction-text"

/** Claude Code follows `@path` imports at most four hops from the importing file. */
const MAX_IMPORT_DEPTH = 4

/** User-level instructions shared with Claude Code. */
export function defaultUserInstructionsPath(): string {
    return join(homeDirectory(), ".claude", "CLAUDE.md")
}

/** `$HOME` is read live because Bun's `homedir()` keeps the value from process start. */
function homeDirectory(): string {
    return process.env.HOME || homedir()
}

/**
 * Loads Claude Code's instructions in its order: the user's file followed by the files
 * it imports, then the workspace root `CLAUDE.md`. Both are optional. `workspaceRoot`
 * must already be a real path.
 */
export async function loadClaudeInstructionFiles(
    workspaceRoot: string,
    userInstructionsPath: string,
    signal: AbortSignal,
): Promise<readonly IInstructionFile[]> {
    signal.throwIfAborted()
    const files = [
        ...await loadUserInstructions(userInstructionsPath, signal),
        await skipIfMissing(() => readWorkspaceFile(workspaceRoot, "CLAUDE.md", signal)),
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
