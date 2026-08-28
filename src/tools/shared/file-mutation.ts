import { realpath } from "node:fs/promises"
import { resolve } from "node:path"

// Ported from Pi 6c87d9a026677b601e8278030dcf1ad97fe0bd86 (c) 2025 Mario Zechner, MIT License.
const fileMutationQueues = new Map<string, Promise<void>>()
let registrationQueue: Promise<void> = Promise.resolve()

/** Serializes mutations of the same canonical file while allowing other files in parallel. */
export async function withFileMutationQueue<T>(
    filePath: string,
    operation: () => Promise<T>,
): Promise<T> {
    const registration = registrationQueue.then(async () => {
        const key = await mutationQueueKey(filePath)
        const currentQueue = fileMutationQueues.get(key) ?? Promise.resolve()

        let releaseNext!: () => void
        const nextQueue = new Promise<void>((resolveQueue) => {
            releaseNext = resolveQueue
        })
        const chainedQueue = currentQueue.then(() => nextQueue)
        fileMutationQueues.set(key, chainedQueue)

        return { key, currentQueue, chainedQueue, releaseNext }
    })
    registrationQueue = registration.then(
        () => undefined,
        () => undefined,
    )

    const { key, currentQueue, chainedQueue, releaseNext } = await registration
    await currentQueue
    try {
        return await operation()
    } finally {
        releaseNext()
        if (fileMutationQueues.get(key) === chainedQueue) {
            fileMutationQueues.delete(key)
        }
    }
}

async function mutationQueueKey(filePath: string): Promise<string> {
    const resolvedPath = resolve(filePath)
    try {
        return await realpath(resolvedPath)
    } catch (error) {
        if (isMissingPathError(error)) return resolvedPath
        throw error
    }
}

function isMissingPathError(error: unknown): boolean {
    return typeof error === "object"
        && error !== null
        && "code" in error
        && (error.code === "ENOENT" || error.code === "ENOTDIR")
}
