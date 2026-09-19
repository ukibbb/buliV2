import { chmod, mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import { setTimeout } from "node:timers/promises"

import { canonicalFilePath, tryAcquireFileLock } from "@/common/file-lock"

export async function withAuthFileLock<T>(
    filePath: string,
    signal: AbortSignal | undefined,
    operation: (canonicalPath: string) => Promise<T>,
): Promise<T> {
    signal?.throwIfAborted()
    await mkdir(dirname(filePath), { recursive: true, mode: 0o700 })
    await chmod(dirname(filePath), 0o700)
    const canonicalPath = canonicalFilePath(filePath)
    while (true) {
        signal?.throwIfAborted()
        const release = tryAcquireFileLock(canonicalPath)
        if (release) {
            try {
                signal?.throwIfAborted()
                return await operation(canonicalPath)
            } finally {
                release()
            }
        }
        try {
            await setTimeout(25, undefined, { signal })
        } catch (error) {
            signal?.throwIfAborted()
            throw error
        }
    }
}
