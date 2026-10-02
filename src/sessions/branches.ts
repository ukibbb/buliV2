import type { TAgentMessage } from "@/agent"
import {
    assertCheckpointAnchor,
    type ICompactionCheckpoint,
} from "@/sessions/compaction/checkpoint"
import {
    assertCompactionCheckpoint,
    assertDurableSessionMessage,
} from "@/sessions/validation"

export const MAIN_BRANCH_ID = "main"

export interface ISessionBranchOrigin {
    readonly branchId: string
    readonly throughMessageId: string | null
}

export interface ISessionBranch {
    readonly id: string
    readonly origin: ISessionBranchOrigin | null
    readonly inheritedCheckpointId: string | null
}

export interface ISessionBranchReferences<TMessage, TCheckpoint> {
    readonly branch: ISessionBranch
    readonly messages: readonly TMessage[]
    readonly checkpoints: readonly TCheckpoint[]
}

export interface ISessionBranchData extends ISessionBranchReferences<TAgentMessage, ICompactionCheckpoint> {}

export interface ISessionBranchReferenceContext<TMessage, TCheckpoint> {
    readonly branchId: string
    readonly messages: readonly TMessage[]
    readonly checkpoint?: TCheckpoint
}

export interface ISessionBranchContext extends ISessionBranchReferenceContext<TAgentMessage, ICompactionCheckpoint> {}

type TBranches = ReadonlyMap<string, ISessionBranchData>

export function validateSessionBranches(
    sessionId: string,
    branches: TBranches,
): void {
    if (!sessionId.trim()) throw new Error("Session ID must not be empty")
    requireBranch(branches, MAIN_BRANCH_ID)
    const messageIds = new Set<string>()
    const checkpointIds = new Set<string>()

    for (const [id, data] of branches) {
        assertBranchIdentity(id, data.branch)
        for (const message of data.messages) {
            assertDurableSessionMessage(message)
            if (message.sessionId !== sessionId) {
                throw new Error(`Message ${message.id} belongs to another session`)
            }
            if (messageIds.has(message.id)) {
                throw new Error(`Duplicate message ID: ${message.id}`)
            }
            messageIds.add(message.id)
        }
        for (const checkpoint of data.checkpoints) {
            assertCompactionCheckpoint(checkpoint)
            if (checkpoint.sessionId !== sessionId) {
                throw new Error(`Checkpoint ${checkpoint.id} belongs to another session`)
            }
            if (checkpointIds.has(checkpoint.id)) {
                throw new Error(`Duplicate checkpoint ID: ${checkpoint.id}`)
            }
            checkpointIds.add(checkpoint.id)
        }
    }

    for (const id of branches.keys()) resolveBranchContext(branches, id)
}

export function resolveBranchContext(
    branches: TBranches,
    branchId: string,
): ISessionBranchContext {
    return structuredClone(resolveBranchReferences(branches, branchId, checkpointFits))
}

/** Resolves references without cloning payloads or retaining expanded branch contexts. */
export function resolveBranchReferences<TMessage extends { readonly id: string }, TCheckpoint extends { readonly id: string }>(
    branches: ReadonlyMap<string, ISessionBranchReferences<TMessage, TCheckpoint>>,
    branchId: string,
    checkpointFits: (checkpoint: TCheckpoint, messages: readonly TMessage[]) => boolean,
): ISessionBranchReferenceContext<TMessage, TCheckpoint> {
    const chain = getBranchChain(branches, branchId)
    const ancestorCheckpoints = new Map<string, TCheckpoint>()
    let messages: TMessage[] = []
    let checkpoint: TCheckpoint | undefined

    for (const data of chain) {
        const { branch } = data
        if (branch.origin) {
            const anchorId = branch.origin.throughMessageId
            if (anchorId === null) {
                messages = []
            } else {
                const index = messages.findIndex((message) => message.id === anchorId)
                if (index === -1) {
                    throw new Error(`Invalid fork message ${anchorId} for branch ${branch.id}`)
                }
                messages = messages.slice(0, index + 1)
            }
        }

        checkpoint = undefined
        if (branch.inheritedCheckpointId !== null) {
            const inherited = ancestorCheckpoints.get(branch.inheritedCheckpointId)
            if (!inherited) {
                throw new Error(`Invalid inherited checkpoint for branch ${branch.id}`)
            }
            if (checkpointFits(inherited, messages)) checkpoint = inherited
        }

        messages = messages.concat(data.messages)
        for (const candidate of data.checkpoints) {
            if (ancestorCheckpoints.has(candidate.id)) {
                throw new Error(`Duplicate checkpoint ID: ${candidate.id}`)
            }
            ancestorCheckpoints.set(candidate.id, candidate)
            if (checkpointFits(candidate, messages)) checkpoint = candidate
        }
    }

    return {
        branchId,
        messages,
        ...(checkpoint === undefined ? {} : { checkpoint }),
    }
}

export function getParentBranchId(
    branches: TBranches,
    branchId: string,
): string {
    const chain = getBranchChain(branches, branchId)
    const origin = chain[chain.length - 1]!.branch.origin
    if (!origin) throw new Error("The main branch has no return destination")
    return origin.branchId
}

function getBranchChain<TData extends { readonly branch: ISessionBranch }>(
    branches: ReadonlyMap<string, TData>,
    branchId: string,
): TData[] {
    const chain: TData[] = []
    const visited = new Set<string>()
    let id: string | null = branchId
    while (id !== null) {
        if (visited.has(id)) throw new Error(`Branch cycle at ${id}`)
        visited.add(id)
        const data: TData = requireBranch(branches, id)
        assertBranchIdentity(id, data.branch)
        chain.push(data)
        id = data.branch.origin?.branchId ?? null
    }
    return chain.reverse()
}

function requireBranch<TData>(branches: ReadonlyMap<string, TData>, id: string): TData {
    const data = branches.get(id)
    if (!data) throw new Error(`Branch does not exist: ${id}`)
    return data
}

function assertBranchIdentity(id: string, branch: ISessionBranch): void {
    if (!id.trim() || branch.id !== id) throw new Error(`Invalid branch ID: ${id}`)
    if ((id === MAIN_BRANCH_ID) !== (branch.origin === null)) {
        throw new Error("Only the main branch may have no parent")
    }
    if (branch.origin === null && branch.inheritedCheckpointId !== null) {
        throw new Error("The main branch cannot inherit a checkpoint")
    }
    if (branch.origin && (
        !branch.origin.branchId.trim()
        || (branch.origin.throughMessageId !== null && !branch.origin.throughMessageId.trim())
    )) {
        throw new Error(`Invalid origin for branch ${id}`)
    }
    if (branch.inheritedCheckpointId !== null && !branch.inheritedCheckpointId.trim()) {
        throw new Error(`Invalid inherited checkpoint for branch ${id}`)
    }
}

function checkpointFits(
    checkpoint: ICompactionCheckpoint,
    messages: readonly TAgentMessage[],
): boolean {
    assertCompactionCheckpoint(checkpoint)
    if (messages.some((message) => message.sessionId !== checkpoint.sessionId)) {
        throw new Error(`Checkpoint ${checkpoint.id} belongs to another session`)
    }
    try {
        assertCheckpointAnchor(checkpoint, messages)
        return true
    } catch {
        return false
    }
}
