const EXCLUDED_SEARCH_GLOBS = [
    "!**/.git",
    "!**/.git/**",
] as const

export const SEARCH_DEFAULT_LIMIT = 100
export const SEARCH_MAX_LIMIT = 200

/** Builds ripgrep arguments that consistently exclude workspace internals. */
export function excludedSearchGlobArguments(): string[] {
    return EXCLUDED_SEARCH_GLOBS.flatMap((pattern) => ["--glob", pattern])
}

/** Detects paths that must never appear in search-tool output. */
export function hasExcludedSearchSegment(path: string): boolean {
    return path.split("/").some((segment) => segment === ".git")
}

/** Reads a required nonempty string from search-tool input. */
export function requireNonEmptyString(
    input: Record<string, unknown>,
    key: string,
): string {
    const value = input[key]
    if (typeof value !== "string") {
        throw new TypeError(`Tool input ${key} must be a string`)
    }
    if (!value) throw new TypeError(`Tool input ${key} cannot be empty`)
    return value
}

/** Reads an optional nonempty string from search-tool input. */
export function optionalString(
    input: Record<string, unknown>,
    key: string,
): string | undefined {
    const value = input[key]
    if (value === undefined) return undefined
    if (typeof value !== "string") {
        throw new TypeError(`Tool input ${key} must be a string`)
    }
    if (!value) throw new TypeError(`Tool input ${key} cannot be empty`)
    return value
}

/** Reads an optional boolean from search-tool input. */
export function optionalBoolean(
    input: Record<string, unknown>,
    key: string,
    fallback: boolean,
): boolean {
    const value = input[key]
    if (value === undefined) return fallback
    if (typeof value !== "boolean") {
        throw new TypeError(`Tool input ${key} must be a boolean`)
    }
    return value
}

/** Reads a bounded optional integer from search-tool input. */
export function optionalInteger(
    input: Record<string, unknown>,
    key: string,
    fallback: number,
    minimum: number,
    maximum?: number,
): number {
    const value = input[key]
    if (value === undefined) return fallback
    if (!Number.isSafeInteger(value) || Number(value) < minimum) {
        throw new TypeError(`Tool input ${key} must be an integer of at least ${minimum}`)
    }
    if (maximum !== undefined && Number(value) > maximum) {
        throw new TypeError(`Tool input ${key} must be at most ${maximum}`)
    }
    return Number(value)
}

/** Rejects NUL bytes before values reach path or process boundaries. */
export function rejectNul(value: string, name: string): void {
    if (value.includes("\0")) throw new Error(`${name} cannot contain a NUL byte`)
}

/** Escapes line breaks so each rendered search result occupies one line. */
export function singleLine(value: string): string {
    return value.replaceAll("\r", "\\r").replaceAll("\n", "\\n")
}
