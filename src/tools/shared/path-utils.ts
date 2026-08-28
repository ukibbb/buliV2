import { constants } from "node:fs"
import { access } from "node:fs/promises"
import { homedir } from "node:os"
import {
    isAbsolute,
    join,
    resolve as nodeResolvePath,
} from "node:path"
import { fileURLToPath } from "node:url"

// Ported from Pi 6c87d9a026677b601e8278030dcf1ad97fe0bd86 (c) 2025 Mario Zechner, MIT License.
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g
const NARROW_NO_BREAK_SPACE = "\u202F"

/** Resolves Pi-style tool paths relative to a workspace root. */
export function resolveToCwd(filePath: string, cwd: string): string {
    const normalized = normalizePath(filePath, true)
    const normalizedCwd = normalizePath(cwd, false)
    return isAbsolute(normalized)
        ? nodeResolvePath(normalized)
        : nodeResolvePath(normalizedCwd, normalized)
}

/** Resolves a read path, including Pi's macOS filename fallbacks. */
export async function resolveReadPath(
    filePath: string,
    cwd: string,
): Promise<string> {
    const resolved = resolveToCwd(filePath, cwd)
    if (await pathExists(resolved)) return resolved

    const amPmVariant = resolved.replace(
        / (AM|PM)\./gi,
        `${NARROW_NO_BREAK_SPACE}$1.`,
    )
    if (amPmVariant !== resolved && await pathExists(amPmVariant)) {
        return amPmVariant
    }

    const nfdVariant = resolved.normalize("NFD")
    if (nfdVariant !== resolved && await pathExists(nfdVariant)) {
        return nfdVariant
    }

    const curlyVariant = resolved.replace(/'/g, "\u2019")
    if (curlyVariant !== resolved && await pathExists(curlyVariant)) {
        return curlyVariant
    }

    const nfdCurlyVariant = nfdVariant.replace(/'/g, "\u2019")
    if (nfdCurlyVariant !== resolved && await pathExists(nfdCurlyVariant)) {
        return nfdCurlyVariant
    }

    return resolved
}

export async function pathExists(filePath: string): Promise<boolean> {
    try {
        await access(filePath, constants.F_OK)
        return true
    } catch {
        return false
    }
}

function normalizePath(input: string, normalizeToolInput: boolean): string {
    let normalized = normalizeToolInput
        ? input.replace(UNICODE_SPACES, " ")
        : input
    if (normalizeToolInput && normalized.startsWith("@")) {
        normalized = normalized.slice(1)
    }
    if (process.platform === "win32") {
        normalized = normalizeWindowsShellPath(normalized)
    }

    const home = homedir()
    if (normalized === "~") return home
    if (
        normalized.startsWith("~/")
        || (process.platform === "win32" && normalized.startsWith("~\\"))
    ) {
        return join(home, normalized.slice(2))
    }

    if (/^file:\/\//.test(normalized)) {
        return fileURLToPath(normalized)
    }
    return normalized
}

function normalizeWindowsShellPath(filePath: string): string {
    if (
        !filePath.startsWith("/")
        || filePath.startsWith("//")
        || filePath.includes("\\")
    ) {
        return filePath
    }
    const match = filePath.match(
        /^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i,
    )
    if (!match) return filePath
    const suffix = match[2]?.replaceAll("/", "\\")
    return `${match[1]!.toUpperCase()}:\\${suffix ?? ""}`
}
