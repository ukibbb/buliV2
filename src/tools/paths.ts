import { realpath, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { isAbsolute, relative, resolve, sep } from "node:path"

import type { IUserPathReference } from "@/agent"

export interface IResolvedWorkspacePath {
    readonly root: string
    readonly target: string
    readonly relativePath: string
}

export type TWorkspacePathResolver = (
    path: string,
    signal: AbortSignal,
) => Promise<IResolvedWorkspacePath>

export type TSelectedPathResolver = (
    path: string,
    references: readonly IUserPathReference[],
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

/** Resolves workspace paths plus exact path capabilities selected through `@`. */
export function createSelectedPathResolver(
    workspaceRoot: string,
): TSelectedPathResolver {
    let canonicalRoot: Promise<string> | undefined

    return async (path, references, signal) => {
        signal.throwIfAborted()
        if (path.includes("\0")) throw new Error("Path cannot contain a NUL byte")

        canonicalRoot ??= resolveCanonicalRoot(workspaceRoot)
        const root = await canonicalRoot
        signal.throwIfAborted()
        const expanded = path === "~"
            ? homedir()
            : path.startsWith(`~${sep}`) ? resolve(homedir(), path.slice(2)) : path
        const candidate = isAbsolute(expanded)
            ? resolve(expanded)
            : resolve(root, expanded)
        let target: string
        try {
            target = await realpath(candidate)
        } catch (error) {
            throw workspacePathError(path, error)
        }
        signal.throwIfAborted()

        if (isPathInside(root, target)) {
            return {
                root,
                target,
                relativePath: toWorkspaceRelativePath(root, target),
            }
        }

        for (const reference of references) {
            signal.throwIfAborted()
            let currentReference: string
            try {
                currentReference = await realpath(reference.path)
                const referenceStat = await stat(currentReference)
                if (currentReference !== reference.path) continue
                if (reference.kind === "file" && !referenceStat.isFile()) continue
                if (
                    reference.kind === "directory"
                    && !referenceStat.isDirectory()
                ) continue
            } catch {
                continue
            }

            const allowed = reference.kind === "file"
                ? target === currentReference
                : isPathInside(currentReference, target)
            if (!allowed) continue
            return {
                root,
                target,
                relativePath: target.split(sep).join("/"),
            }
        }

        throw new Error(
            `Path is outside the workspace and was not selected with @: ${displayPath(path)}`,
        )
    }
}

/** Converts an absolute in-workspace path to a normalized relative path. */
export function toWorkspaceRelativePath(root: string, target: string): string {
    if (!isPathInside(root, target)) {
        throw new Error("Resolved path is outside the workspace")
    }

    const workspacePath = relative(root, target)
    return workspacePath ? workspacePath.split(sep).join("/") : "."
}

export function isPathInside(root: string, target: string): boolean {
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
