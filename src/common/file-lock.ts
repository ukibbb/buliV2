import { dlopen, read } from "bun:ffi"
import { closeSync, existsSync, openSync, realpathSync } from "node:fs"
import { basename, dirname, join } from "node:path"

const LOCK_EX = 2
const LOCK_NB = 4
let nativeLocks: ReturnType<typeof loadNativeLocks> | undefined

export function canonicalFilePath(filePath: string): string {
    return existsSync(filePath)
        ? realpathSync(filePath)
        : join(realpathSync(dirname(filePath)), basename(filePath))
}

/** The sidecar must never be unlinked: replacement would create a second lock inode. */
export function tryAcquireFileLock(filePath: string): (() => void) | undefined {
    nativeLocks ??= loadNativeLocks()
    const descriptor = openSync(`${filePath}.lock`, "a", 0o600)
    try {
        if (nativeLocks.flock(descriptor, LOCK_EX | LOCK_NB) !== 0) {
            const code = nativeLocks.errno()
            if (code === nativeLocks.wouldBlock) {
                closeSync(descriptor)
                return undefined
            }
            throw new Error(`Unable to lock file ${filePath} (errno ${code})`)
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
    if (process.platform === "darwin") {
        const library = dlopen("/usr/lib/libSystem.B.dylib", {
            flock: { args: ["i32", "i32"], returns: "i32" },
            __error: { args: [], returns: "ptr" },
        })
        return {
            flock: library.symbols.flock,
            errno: () => {
                const pointer = library.symbols.__error()
                if (pointer === null) throw new Error("Unable to read lock errno")
                return read.i32(pointer)
            },
            wouldBlock: 35,
        }
    }
    if (process.platform === "linux") {
        const library = dlopen("libc.so.6", {
            flock: { args: ["i32", "i32"], returns: "i32" },
            __errno_location: { args: [], returns: "ptr" },
        })
        return {
            flock: library.symbols.flock,
            errno: () => {
                const pointer = library.symbols.__errno_location()
                if (pointer === null) throw new Error("Unable to read lock errno")
                return read.i32(pointer)
            },
            wouldBlock: 11,
        }
    }
    throw new Error(`File locking is unsupported on ${process.platform}`)
}
