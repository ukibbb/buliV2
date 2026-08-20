import { realpath } from "node:fs/promises"
import { isAbsolute, relative, resolve, sep } from "node:path"

export interface IResolvedWorkspacePath {
    readonly root: string
    readonly target: string
    readonly relativePath: string
}

export type TWorkspacePathResolver = (
    path: string,
    signal: AbortSignal,
) => Promise<IResolvedWorkspacePath>

/** Resolves existing paths against one canonical workspace root. */
export function createWorkspacePathResolver(
    workspaceRoot: string,
): TWorkspacePathResolver {
    let canonicalRoot: Promise<string> | undefined

    return async (path, signal) => {
        signal.throwIfAborted()
        if (path.includes("\0")) throw new Error("Path cannot contain a NUL byte")

        canonicalRoot ??= resolveCanonicalRoot(workspaceRoot)
        const root = await canonicalRoot
        signal.throwIfAborted()
        const candidate = isAbsolute(path) ? resolve(path) : resolve(root, path)
        let target: string

        try {
            target = await realpath(candidate)
        } catch (error) {
            throw workspacePathError(path, error)
        }

        signal.throwIfAborted()
        if (!isPathInside(root, target)) {
            throw new Error(`Path is outside the workspace: ${displayPath(path)}`)
        }

        return {
            root,
            target,
            relativePath: toWorkspaceRelativePath(root, target),
        }
    }
}

export function toWorkspaceRelativePath(root: string, target: string): string {
    if (!isPathInside(root, target)) {
        throw new Error("Resolved path is outside the workspace")
    }

    const workspacePath = relative(root, target)
    return workspacePath ? workspacePath.split(sep).join("/") : "."
}

function isPathInside(root: string, target: string): boolean {
    const workspacePath = relative(root, target)
    return workspacePath === "" || (
        workspacePath !== ".."
        && !workspacePath.startsWith(`..${sep}`)
        && !isAbsolute(workspacePath)
    )
}

async function resolveCanonicalRoot(workspaceRoot: string): Promise<string> {
    try {
        return await realpath(resolve(workspaceRoot))
    } catch (error) {
        throw new Error(`Cannot resolve workspace root: ${errorMessage(error)}`)
    }
}

function workspacePathError(path: string, error: unknown): Error {
    const code = errno(error)
    if (code === "ENOENT" || code === "ENOTDIR") {
        return new Error(`Path does not exist: ${displayPath(path)}`)
    }
    if (code === "EACCES" || code === "EPERM") {
        return new Error(`Cannot access path: ${displayPath(path)}`)
    }
    return new Error(`Cannot resolve path ${displayPath(path)}: ${errorMessage(error)}`)
}

function displayPath(path: string): string {
    return JSON.stringify(path || ".")
}

function errno(error: unknown): string | undefined {
    return error instanceof Error && "code" in error
        ? String(error.code)
        : undefined
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}
