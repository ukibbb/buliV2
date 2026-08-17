import { randomUUID } from "node:crypto"
import {
    chmod,
    mkdir,
    readFile,
    rename,
    rm,
    writeFile,
} from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { homedir } from "node:os"
import { setTimeout as delay } from "node:timers/promises"
import { lock } from "proper-lockfile"

import type {
    IAuthStore,
    TAuthCredential,
} from "@/auth/types"

const PROVIDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const RESERVED_PROVIDER_IDS = new Set(["__proto__", "constructor", "prototype"])
const AUTH_METADATA_KEY = "$buli"
const AUTH_OPERATIONS_KEY = "authOperations"
const LOCK_MAX_ATTEMPTS = 601
const LOCK_RETRY_DELAY_MS = 50

export function defaultAuthFilePath(): string {
    return join(homedir(), ".buli", "auth.json")
}

export const AUTH_FILE_PATH = defaultAuthFilePath()

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

function hasErrorCode(value: unknown, code: string): boolean {
    return typeof value === "object"
        && value !== null
        && "code" in value
        && value.code === code
}

function validateProviderId(providerId: string): void {
    if (
        !PROVIDER_ID_PATTERN.test(providerId)
        || RESERVED_PROVIDER_IDS.has(providerId)
    ) {
        throw new TypeError(`Invalid authentication provider ID: ${JSON.stringify(providerId)}`)
    }
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.length > 0
}

function parseCredential(
    providerId: string,
    value: unknown,
): TAuthCredential {
    if (!isRecord(value)) {
        throw new TypeError(`Invalid credential for provider ${providerId}`)
    }
    if (value.type === "api_key") {
        if (!isNonEmptyString(value.key)) {
            throw new TypeError(`Invalid API key credential for provider ${providerId}`)
        }
        return { type: "api_key", key: value.key }
    }
    if (value.type !== "oauth") {
        throw new TypeError(`Unsupported credential type for provider ${providerId}`)
    }

    if (
        !isNonEmptyString(value.access)
        || !isNonEmptyString(value.refresh)
        || typeof value.expires !== "number"
        || !Number.isFinite(value.expires)
        || value.expires < 0
        || (
            value.accountId !== undefined
            && !isNonEmptyString(value.accountId)
        )
        || (
            value.enterpriseUrl !== undefined
            && !isNonEmptyString(value.enterpriseUrl)
        )
    ) {
        throw new TypeError(`Invalid OAuth credential for provider ${providerId}`)
    }

    return {
        type: "oauth",
        access: value.access,
        refresh: value.refresh,
        expires: value.expires,
        ...(typeof value.accountId === "string"
            ? { accountId: value.accountId }
            : {}),
        ...(typeof value.enterpriseUrl === "string"
            ? { enterpriseUrl: value.enterpriseUrl }
            : {}),
    }
}

function copyCredential(credential: TAuthCredential): TAuthCredential {
    if (credential.type === "api_key") {
        return { type: "api_key", key: credential.key }
    }
    return {
        type: "oauth",
        access: credential.access,
        refresh: credential.refresh,
        expires: credential.expires,
        ...(credential.accountId === undefined
            ? {}
            : { accountId: credential.accountId }),
        ...(credential.enterpriseUrl === undefined
            ? {}
            : { enterpriseUrl: credential.enterpriseUrl }),
    }
}

function credentialsEqual(
    left: TAuthCredential | undefined,
    right: TAuthCredential | undefined,
): boolean {
    if (left === undefined || right === undefined) return left === right
    if (left.type !== right.type) return false
    if (left.type === "api_key" && right.type === "api_key") {
        return left.key === right.key
    }
    if (left.type !== "oauth" || right.type !== "oauth") return false
    return left.access === right.access
        && left.refresh === right.refresh
        && left.expires === right.expires
        && left.accountId === right.accountId
        && left.enterpriseUrl === right.enterpriseUrl
}

function operationRevision(
    source: Record<string, unknown>,
    providerId: string,
): number {
    const metadata = source[AUTH_METADATA_KEY]
    if (!isRecord(metadata)) return 0
    const operations = metadata[AUTH_OPERATIONS_KEY]
    if (!isRecord(operations)) return 0
    const revision = operations[providerId]
    return typeof revision === "number"
        && Number.isSafeInteger(revision)
        && revision >= 0
        ? revision
        : 0
}

function setOperationRevision(
    source: Record<string, unknown>,
    providerId: string,
    revision: number,
): void {
    const currentMetadata = isRecord(source[AUTH_METADATA_KEY])
        ? source[AUTH_METADATA_KEY]
        : {}
    const currentOperations = isRecord(currentMetadata[AUTH_OPERATIONS_KEY])
        ? currentMetadata[AUTH_OPERATIONS_KEY]
        : {}
    source[AUTH_METADATA_KEY] = {
        ...currentMetadata,
        [AUTH_OPERATIONS_KEY]: {
            ...currentOperations,
            [providerId]: revision,
        },
    }
}

async function readAuthObject(
    filePath: string,
    signal?: AbortSignal,
): Promise<Record<string, unknown>> {
    signal?.throwIfAborted()

    let text: string
    try {
        text = signal === undefined
            ? await readFile(filePath, "utf8")
            : await readFile(filePath, { encoding: "utf8", signal })
    } catch (cause) {
        signal?.throwIfAborted()
        if (hasErrorCode(cause, "ENOENT")) return {}
        throw new Error(`Unable to read authentication from ${filePath}`, { cause })
    }

    signal?.throwIfAborted()
    try {
        const value: unknown = JSON.parse(text)
        if (!isRecord(value)) {
            throw new TypeError("Expected the authentication file to contain an object")
        }
        return value
    } catch (cause) {
        throw new Error(`Unable to read authentication from ${filePath}`, { cause })
    }
}

async function prepareAuthDirectory(filePath: string): Promise<void> {
    const directory = dirname(filePath)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await chmod(directory, 0o700)
}

async function writeAuthObject(
    filePath: string,
    value: Record<string, unknown>,
): Promise<void> {
    const temporaryPath = join(
        dirname(filePath),
        `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
    )

    try {
        await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
            encoding: "utf8",
            flag: "wx",
            mode: 0o600,
        })
        await chmod(temporaryPath, 0o600)
        await rename(temporaryPath, filePath)
    } catch (cause) {
        throw new Error(`Unable to write authentication to ${filePath}`, { cause })
    } finally {
        await rm(temporaryPath, { force: true }).catch(() => undefined)
    }
}

async function waitForLockRetry(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    if (signal === undefined) {
        await delay(LOCK_RETRY_DELAY_MS)
        return
    }

    try {
        await delay(LOCK_RETRY_DELAY_MS, undefined, { signal })
    } catch (cause) {
        signal.throwIfAborted()
        throw cause
    }
}

async function acquireAuthLock(
    filePath: string,
    signal?: AbortSignal,
): Promise<() => Promise<void>> {
    for (let attempt = 0; attempt < LOCK_MAX_ATTEMPTS; attempt += 1) {
        signal?.throwIfAborted()

        let release: (() => Promise<void>) | undefined
        try {
            release = await lock(filePath, {
                realpath: false,
                retries: 0,
            })
        } catch (cause) {
            signal?.throwIfAborted()
            if (
                !hasErrorCode(cause, "ELOCKED")
                || attempt === LOCK_MAX_ATTEMPTS - 1
            ) {
                throw new Error(`Unable to lock authentication file ${filePath}`, {
                    cause,
                })
            }
            await waitForLockRetry(signal)
            continue
        }

        if (signal?.aborted) {
            try {
                await release()
            } finally {
                signal.throwIfAborted()
            }
        }
        return release
    }

    throw new Error(`Unable to lock authentication file ${filePath}`)
}

export class FileAuthStore implements IAuthStore {
    constructor(private readonly path = defaultAuthFilePath()) {}

    async get(
        providerId: string,
        signal?: AbortSignal,
    ): Promise<TAuthCredential | undefined> {
        signal?.throwIfAborted()
        validateProviderId(providerId)
        const source = await readAuthObject(this.path, signal)
        return Object.hasOwn(source, providerId)
            ? parseCredential(providerId, source[providerId])
            : undefined
    }

    async set(
        providerId: string,
        credential: TAuthCredential,
        signal?: AbortSignal,
    ): Promise<void> {
        signal?.throwIfAborted()
        validateProviderId(providerId)
        const next = parseCredential(providerId, credential)

        await this.withLock(signal, async () => {
            const source = await readAuthObject(this.path, signal)
            source[providerId] = next
            setOperationRevision(
                source,
                providerId,
                nextOperationRevision(source, providerId),
            )
            await writeAuthObject(this.path, source)
        })
    }

    async remove(
        providerId: string,
        signal?: AbortSignal,
    ): Promise<boolean> {
        signal?.throwIfAborted()
        validateProviderId(providerId)

        return this.withLock(signal, async () => {
            const source = await readAuthObject(this.path, signal)
            const existed = Object.hasOwn(source, providerId)
            delete source[providerId]
            setOperationRevision(
                source,
                providerId,
                nextOperationRevision(source, providerId),
            )
            await writeAuthObject(this.path, source)
            return existed
        })
    }

    async modify(
        providerId: string,
        update: (
            current: TAuthCredential | undefined,
        ) => Promise<TAuthCredential | undefined>,
        signal?: AbortSignal,
    ): Promise<TAuthCredential | undefined> {
        signal?.throwIfAborted()
        validateProviderId(providerId)

        return this.withLock(signal, async () => {
            const source = await readAuthObject(this.path, signal)
            let current: TAuthCredential | undefined
            let malformed = false
            if (Object.hasOwn(source, providerId)) {
                try {
                    current = parseCredential(providerId, source[providerId])
                } catch {
                    malformed = true
                    current = undefined
                }
            }
            const before = current === undefined
                ? undefined
                : copyCredential(current)

            signal?.throwIfAborted()
            const candidate = await update(current)
            const next = candidate === undefined
                ? undefined
                : parseCredential(providerId, candidate)

            if (!malformed && credentialsEqual(before, next)) return next
            if (next === undefined) delete source[providerId]
            else source[providerId] = next
            await writeAuthObject(this.path, source)
            return next
        })
    }

    async beginOperation(
        providerId: string,
        signal?: AbortSignal,
    ): Promise<number> {
        signal?.throwIfAborted()
        validateProviderId(providerId)

        return this.withLock(signal, async () => {
            const source = await readAuthObject(this.path, signal)
            const operation = nextOperationRevision(source, providerId)
            setOperationRevision(source, providerId, operation)
            await writeAuthObject(this.path, source)
            return operation
        })
    }

    async commitOperation(
        providerId: string,
        operation: number,
        credential: TAuthCredential,
    ): Promise<boolean> {
        validateProviderId(providerId)
        if (!Number.isSafeInteger(operation) || operation <= 0) {
            throw new TypeError("Invalid authentication operation revision")
        }
        const next = parseCredential(providerId, credential)

        return this.withLock(undefined, async () => {
            const source = await readAuthObject(this.path)
            if (operationRevision(source, providerId) !== operation) return false
            source[providerId] = next
            await writeAuthObject(this.path, source)
            return true
        })
    }

    private async withLock<TResult>(
        signal: AbortSignal | undefined,
        operation: () => Promise<TResult>,
    ): Promise<TResult> {
        signal?.throwIfAborted()
        await prepareAuthDirectory(this.path)
        signal?.throwIfAborted()
        const release = await acquireAuthLock(this.path, signal)

        try {
            signal?.throwIfAborted()
            return await operation()
        } finally {
            await release()
        }
    }
}

function nextOperationRevision(
    source: Record<string, unknown>,
    providerId: string,
): number {
    const current = operationRevision(source, providerId)
    if (current >= Number.MAX_SAFE_INTEGER) {
        throw new Error(`Authentication operation revision overflow for ${providerId}`)
    }
    return current + 1
}
