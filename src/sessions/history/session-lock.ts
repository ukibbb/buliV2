import { createHash } from "node:crypto"
import { realpathSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { canonicalFilePath, tryAcquireFileLock } from "@/common/file-lock"

export function defaultHistoryDirectoryPath(workspaceRoot = process.cwd()): string {
    const workspaceId = createHash("sha256").update(realpathSync(workspaceRoot)).digest("hex")
    return join(homedir(), ".buli", "sessions", workspaceId)
}

/** Keeps the historical sidecar name so ownership also excludes older processes. */
export function acquireSessionLock(directory: string, sessionId: string): () => void {
    const filename = `${createHash("sha256").update(sessionId).digest("hex")}.jsonl`
    const release = tryAcquireFileLock(canonicalFilePath(join(directory, filename)))
    if (!release) throw new Error(`Unable to lock session ${sessionId}. Close its other owner and retry.`)
    return release
}
