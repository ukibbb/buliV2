import { constants as FS_CONSTANTS } from "node:fs"
import { access, opendir, realpath, stat } from "node:fs/promises"
import { homedir } from "node:os"
import {
    delimiter as PATH_DELIMITER,
    isAbsolute,
    join,
    relative,
    resolve,
    sep,
} from "node:path"

import { isPathInside } from "@/tools/paths"

const FD_TIMEOUT_MS = 5_000
const FD_MAX_RESULTS = 200
const FD_MAX_OUTPUT_BYTES = 2 * 1024 * 1024
const FALLBACK_MAX_ENTRIES = 20_000
const SAFE_WINDOWS_EXTENSIONS = new Set([".com", ".exe"])

export interface IFdPathSearchOptions {
    readonly executablePath?: string
    readonly fallbackWhenMissing?: boolean
    readonly searchPath?: string
    readonly pathExt?: string
}

export interface IFdPathSuggestion {
    readonly kind: "file" | "directory"
    readonly path: string
    readonly displayPath: string
}

export type TFdPathSearcher = (
    query: string,
    signal: AbortSignal,
) => Promise<readonly IFdPathSuggestion[]>

/** Creates one abortable, fd-backed path searcher for prompt completion. */
export function createFdPathSearcher(
    workspaceRoot: string,
    options: IFdPathSearchOptions = {},
): TFdPathSearcher {
    const searchPath = options.searchPath ?? process.env.PATH ?? ""
    const pathExt = options.pathExt ?? process.env.PATHEXT
    const canonicalWorkspace = realpath(resolve(workspaceRoot))
    let executableResolution: Promise<string> | undefined

    return async (query, signal) => {
        signal.throwIfAborted()
        const workspace = await canonicalWorkspace
        signal.throwIfAborted()
        executableResolution ??= options.executablePath === undefined
            ? resolveFdExecutable(workspace, searchPath, pathExt)
            : validateFdExecutable(options.executablePath)
        let executable: string
        try {
            executable = await executableResolution
        } catch (error) {
            if (options.fallbackWhenMissing && error instanceof MissingFdExecutableError) {
                return searchWithoutFd(workspace, normalizeQuery(query), signal)
            }
            throw error
        }
        signal.throwIfAborted()
        return searchWithFd(executable, workspace, normalizeQuery(query), signal)
    }
}

async function searchWithoutFd(
    workspace: string,
    query: string,
    signal: AbortSignal,
): Promise<readonly IFdPathSuggestion[]> {
    if (query.includes("\0")) throw new Error("Path query cannot contain a NUL byte")
    const timeout = AbortSignal.timeout(FD_TIMEOUT_MS)
    const operationSignal = AbortSignal.any([signal, timeout])
    try {
        const scope = await searchScope(workspace, query)
        const needle = scope.pattern.toLowerCase()
        const candidates: string[] = []
        const directories = [scope.directory]
        let directoryIndex = 0
        const visitedDirectories = new Set<string>()
        let visitedEntries = 0
        search: while (
            directoryIndex < directories.length
            && candidates.length < FD_MAX_RESULTS
        ) {
            operationSignal.throwIfAborted()
            const directory = directories[directoryIndex]
            directoryIndex += 1
            if (!directory) break
            let canonicalDirectory: string
            try {
                canonicalDirectory = await realpath(directory)
            } catch {
                continue
            }
            if (visitedDirectories.has(canonicalDirectory)) continue
            visitedDirectories.add(canonicalDirectory)

            let entries
            try {
                entries = await opendir(canonicalDirectory)
            } catch {
                continue
            }
            for await (const entry of entries) {
                operationSignal.throwIfAborted()
                visitedEntries += 1
                if (visitedEntries > FALLBACK_MAX_ENTRIES) break search
                if (entry.name.toLowerCase() === ".git") continue
                const candidate = join(canonicalDirectory, entry.name)
                let path: string
                let candidateStat
                try {
                    path = await realpath(candidate)
                    candidateStat = await stat(path)
                } catch {
                    continue
                }
                if (!candidateStat.isFile() && !candidateStat.isDirectory()) continue
                const candidateName = relative(scope.directory, path)
                    .split(sep)
                    .join("/")
                    .toLowerCase()
                if (!needle || candidateName.includes(needle)) candidates.push(path)
                if (!scope.immediate && candidateStat.isDirectory()) directories.push(path)
                if (candidates.length >= FD_MAX_RESULTS) break
            }
        }
        return suggestionsFromCandidates(workspace, query, candidates, operationSignal)
    } catch (error) {
        if (signal.aborted) signal.throwIfAborted()
        if (timeout.aborted) throw new Error(`Path search timed out after ${FD_TIMEOUT_MS} ms`)
        throw error
    }
}

async function searchWithFd(
    executable: string,
    workspace: string,
    query: string,
    signal: AbortSignal,
): Promise<readonly IFdPathSuggestion[]> {
    if (query.includes("\0")) throw new Error("Path query cannot contain a NUL byte")
    const timeout = AbortSignal.timeout(FD_TIMEOUT_MS)
    const operationSignal = AbortSignal.any([signal, timeout])
    const scope = await searchScope(workspace, query)
    operationSignal.throwIfAborted()
    const pattern = scope.pattern || "."
    const args = [
        "--absolute-path",
        "--color=never",
        "--print0",
        "--hidden",
        "--follow",
        "--exclude",
        ".[gG][iI][tT]",
        "--max-results",
        String(FD_MAX_RESULTS),
        "--type",
        "file",
        "--type",
        "directory",
        ...(scope.immediate ? ["--max-depth", "1"] : []),
        ...(scope.pattern ? ["--fixed-strings"] : []),
        "--",
        pattern,
        ".",
    ]
    const child = (() => {
        try {
            return Bun.spawn([executable, ...args], {
                cwd: scope.directory,
                env: sanitizedExecutableEnvironment(),
                stdin: "ignore",
                stdout: "pipe",
                stderr: "pipe",
                signal: operationSignal,
                windowsHide: true,
            })
        } catch (error) {
            throw new Error(`Cannot start fd: ${errorMessage(error)}`)
        }
    })()

    let stdout: ArrayBuffer
    let stderr: string
    let exitCode: number
    try {
        [stdout, stderr, exitCode] = await Promise.all([
            new Response(child.stdout).arrayBuffer(),
            new Response(child.stderr).text(),
            child.exited,
        ])
    } catch (error) {
        if (signal.aborted) signal.throwIfAborted()
        if (timeout.aborted) throw new Error(`fd timed out after ${FD_TIMEOUT_MS} ms`)
        throw new Error(`fd search failed: ${errorMessage(error)}`)
    }
    operationSignal.throwIfAborted()
    if (timeout.aborted) throw new Error(`fd timed out after ${FD_TIMEOUT_MS} ms`)
    if (exitCode !== 0) {
        throw new Error(`fd search failed: ${stderr.trim() || `exit code ${exitCode}`}`)
    }
    if (stdout.byteLength > FD_MAX_OUTPUT_BYTES) {
        throw new Error("fd produced too much autocomplete output")
    }

    const candidates = new TextDecoder().decode(stdout)
        .split("\0")
        .filter(Boolean)
    return suggestionsFromCandidates(workspace, query, candidates, operationSignal)
}

async function suggestionsFromCandidates(
    workspace: string,
    query: string,
    candidates: string[],
    signal: AbortSignal,
): Promise<readonly IFdPathSuggestion[]> {
    const direct = query ? await directSuggestion(workspace, query) : undefined
    signal.throwIfAborted()
    if (direct) candidates.unshift(direct.path)
    const suggestions: IFdPathSuggestion[] = []
    const seen = new Set<string>()
    for (const candidate of candidates) {
        signal.throwIfAborted()
        let path: string
        let kind: IFdPathSuggestion["kind"]
        try {
            path = await realpath(candidate)
            const candidateStat = await stat(path)
            if (candidateStat.isDirectory()) kind = "directory"
            else if (candidateStat.isFile()) kind = "file"
            else continue
        } catch {
            continue
        }
        const key = `${kind}\0${path}`
        if (seen.has(key)) continue
        seen.add(key)
        suggestions.push({
            kind,
            path,
            displayPath: displayPath(workspace, path),
        })
    }

    const normalizedNeedle = basenameQuery(query).toLowerCase()
    return suggestions
        .toSorted((left, right) => (
            suggestionScore(right, normalizedNeedle)
            - suggestionScore(left, normalizedNeedle)
            || left.displayPath.localeCompare(right.displayPath)
        ))
        .slice(0, 30)
}

async function searchScope(
    workspace: string,
    query: string,
): Promise<{ readonly directory: string; readonly pattern: string; readonly immediate: boolean }> {
    const expanded = expandHome(query)
    const lastSeparator = Math.max(expanded.lastIndexOf("/"), expanded.lastIndexOf("\\"))
    if (lastSeparator < 0) {
        return { directory: workspace, pattern: query, immediate: false }
    }

    const directoryQuery = expanded.slice(0, lastSeparator + 1)
    const pattern = expanded.slice(lastSeparator + 1)
    const candidate = isAbsolute(directoryQuery)
        ? directoryQuery
        : resolve(workspace, directoryQuery)
    try {
        const directory = await realpath(candidate)
        if ((await stat(directory)).isDirectory()) {
            return { directory, pattern, immediate: true }
        }
    } catch {
        // Fall back to a recursive workspace search for an incomplete directory.
    }
    return { directory: workspace, pattern: query, immediate: false }
}

async function directSuggestion(
    workspace: string,
    query: string,
): Promise<IFdPathSuggestion | undefined> {
    const expanded = expandHome(query)
    const candidate = isAbsolute(expanded) ? expanded : resolve(workspace, expanded)
    try {
        const path = await realpath(candidate)
        const candidateStat = await stat(path)
        const kind = candidateStat.isDirectory()
            ? "directory"
            : candidateStat.isFile() ? "file" : undefined
        return kind ? { kind, path, displayPath: displayPath(workspace, path) } : undefined
    } catch {
        return undefined
    }
}

function normalizeQuery(query: string): string {
    if (!query.startsWith('"')) return query
    return query.endsWith('"') && query.length > 1
        ? query.slice(1, -1)
        : query.slice(1)
}

function expandHome(path: string): string {
    if (path === "~") return homedir()
    return /^~[\\/]/.test(path) ? resolve(homedir(), path.slice(2)) : path
}

function displayPath(workspace: string, path: string): string {
    if (!isPathInside(workspace, path)) return path.split(sep).join("/")
    const workspacePath = relative(workspace, path)
    return workspacePath ? workspacePath.split(sep).join("/") : "."
}

function basenameQuery(query: string): string {
    const index = Math.max(query.lastIndexOf("/"), query.lastIndexOf("\\"))
    return index < 0 ? query : query.slice(index + 1)
}

function suggestionScore(
    suggestion: IFdPathSuggestion,
    needle: string,
): number {
    const name = suggestion.displayPath.split("/").at(-1)?.toLowerCase() ?? ""
    const path = suggestion.displayPath.toLowerCase()
    const match = !needle
        ? 0
        : name === needle ? 100
            : name.startsWith(needle) ? 80
                : name.includes(needle) ? 50
                    : path.includes(needle) ? 30 : 0
    return match + (suggestion.kind === "directory" ? 10 : 0)
}

async function validateFdExecutable(executablePath: string): Promise<string> {
    if (!isAbsolute(executablePath)) {
        throw new TypeError("fd executable path must be absolute")
    }
    try {
        const executable = await realpath(executablePath)
        const executableStat = await stat(executable)
        if (!executableStat.isFile()) throw new Error("path is not a file")
        if (process.platform !== "win32") {
            await access(executable, FS_CONSTANTS.X_OK)
        }
        return executable
    } catch (error) {
        if (isMissingPathError(error)) {
            throw new MissingFdExecutableError(executablePath)
        }
        throw new Error(
            `Cannot use bundled fd executable ${JSON.stringify(executablePath)}: `
            + errorMessage(error),
        )
    }
}

class MissingFdExecutableError extends Error {
    constructor(path: string) {
        super(`Bundled fd executable is missing: ${JSON.stringify(path)}`)
    }
}

function isMissingPathError(error: unknown): boolean {
    return error instanceof Error
        && "code" in error
        && String(error.code) === "ENOENT"
}

async function resolveFdExecutable(
    workspace: string,
    searchPath: string,
    pathExt: string | undefined,
): Promise<string> {
    const names = process.platform === "win32"
        ? windowsCandidateNames(pathExt)
        : ["fd", "fdfind"]
    for (const pathEntry of searchPath.split(PATH_DELIMITER)) {
        if (!pathEntry || !isAbsolute(pathEntry)) continue
        let directory: string
        try {
            directory = await realpath(pathEntry)
            if (!(await stat(directory)).isDirectory()) continue
        } catch {
            continue
        }
        if (isPathInside(workspace, directory)) continue

        for (const name of names) {
            try {
                const executable = await realpath(join(directory, name))
                if (isPathInside(workspace, executable)) continue
                if (!(await stat(executable)).isFile()) continue
                if (process.platform !== "win32") {
                    await access(executable, FS_CONSTANTS.X_OK)
                }
                return executable
            } catch {
                continue
            }
        }
    }
    throw new Error("fd is required but no safe executable was found on PATH")
}

function windowsCandidateNames(pathExt: string | undefined): string[] {
    const configured = pathExt ?? ".COM;.EXE"
    const extensions = configured.split(";")
        .map((value) => value.trim().toLowerCase())
        .filter((value, index, values) => (
            SAFE_WINDOWS_EXTENSIONS.has(value) && values.indexOf(value) === index
        ))
    return extensions.map((extension) => `fd${extension}`)
}

function sanitizedExecutableEnvironment(): Record<string, string> {
    const environment: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env)) {
        if (
            value === undefined
            || key === "LD_AUDIT"
            || key === "LD_LIBRARY_PATH"
            || key === "LD_PRELOAD"
            || key.startsWith("DYLD_")
        ) continue
        environment[key] = value
    }
    return environment
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}
