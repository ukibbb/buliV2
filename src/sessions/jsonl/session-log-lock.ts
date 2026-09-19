import { canonicalFilePath, tryAcquireFileLock } from "@/common/file-lock"

/** Owns a workspace log until disposal or process exit, including a crash. */
export function acquireSessionLogLock(filePath: string): () => void {
    const release = tryAcquireFileLock(canonicalFilePath(filePath))
    if (!release) {
        throw new Error(
            `Unable to lock session log ${filePath}. `
            + "Close any other Buli instance using this workspace and retry.",
        )
    }
    return release
}
