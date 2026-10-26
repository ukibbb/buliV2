import { readFile, realpath, stat } from "node:fs/promises"
import { isAbsolute, join, relative, sep } from "node:path"

/** One instruction file as the agent prompt names and quotes it. */
export interface IInstructionText {
    readonly source: string
    readonly content: string
}

export const INSTRUCTION_FILE_MAX_BYTES = 64 * 1024

/** Reads a workspace file whose real path must stay inside the workspace. */
export async function readWorkspaceFile(
    root: string,
    source: string,
    signal: AbortSignal,
): Promise<IInstructionText> {
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
export async function readInstructionFile(
    path: string,
    source: string,
    signal: AbortSignal,
): Promise<IInstructionText> {
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
export async function skipIfMissing(
    read: () => Promise<IInstructionText>,
): Promise<IInstructionText | undefined> {
    try {
        return await read()
    } catch (error) {
        if (error instanceof Error && hasCode(error.cause, "ENOENT")) return undefined
        throw error
    }
}

export function isPathInside(root: string, target: string): boolean {
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
