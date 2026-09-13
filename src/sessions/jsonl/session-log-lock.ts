import { dlopen } from "bun:ffi"
import { closeSync, existsSync, openSync, realpathSync } from "node:fs"
import { basename, dirname, join } from "node:path"

const LOCK_EX = 2
const LOCK_NB = 4
let nativeLocks: ReturnType<typeof loadNativeLocks> | undefined

/** Owns a workspace log until disposal or process exit, including a crash. */
export function acquireSessionLogLock(filePath: string): () => void {
    const canonicalPath = existsSync(filePath)
        ? realpathSync(filePath)
        : join(realpathSync(dirname(filePath)), basename(filePath))
    nativeLocks ??= loadNativeLocks()

    // Each manager loads history once. Two writers would therefore count different
    // messages during compaction, and an atomic rewrite could erase another writer's
    // appends. Hold an exclusive, nonblocking flock from BEFORE load() until dispose().
    // The kernel releases it on exit/SIGKILL, so no PID or stale-lock recovery is needed.
    // Use a permanent sidecar: the JSONL inode changes during replaceFile(). Never
    // unlink the sidecar, which would let a second process lock a different inode.
    const descriptor = openSync(`${canonicalPath}.lock`, "a", 0o600)
    try {
        if (nativeLocks.symbols.flock(descriptor, LOCK_EX | LOCK_NB) !== 0) {
            throw new Error(
                `Unable to lock session log ${filePath}. `
                + "Close any other Buli instance using this workspace and retry.",
            )
        }
    } catch (error) {
        closeSync(descriptor)
        throw error
    }

    let released = false
    return () => {
        if (released) return
        released = true
        closeSync(descriptor)
    }
}

function loadNativeLocks() {
    // Buli's release targets are macOS and glibc Linux. Bun FFI calls the OS lock
    // directly, avoiding an external flock command or a persistent helper process.
    if (process.platform !== "darwin" && process.platform !== "linux") {
        throw new Error(`Session log locking is unsupported on ${process.platform}`)
    }
    return dlopen(
        process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6",
        { flock: { args: ["i32", "i32"], returns: "i32" } },
    )
}
