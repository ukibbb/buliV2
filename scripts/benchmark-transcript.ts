import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { cpus, release, tmpdir } from "node:os"
import { join } from "node:path"
import { CodeRenderable, type Renderable } from "@opentui/core"
import { testRender } from "@opentui/react/test-utils"
import opentuiPackage from "../node_modules/@opentui/core/package.json"
import packageMetadata from "../package.json" with { type: "json" }
import {
    act, createElement, Profiler, useSyncExternalStore, version as reactVersion,
    type ReactNode,
} from "react"

import type { IAgentModel, IToolCallContent, IToolResultMessage, IUserMessage } from "@/agent"
import { AgentSession } from "@/sessions/agent-session"
import { InMemorySessionManager } from "@/sessions/in-memory-session-manager"
import { JsonlSessionManager } from "@/sessions/jsonl/jsonl-session-manager"
import type { ISessionSnapshot } from "@/sessions/snapshot"
import { ToolActivityLine } from "@/sessions/ui/ToolActivity"
import { Transcript } from "@/sessions/ui/Transcript"

// Run from the workspace root: SHOW_CONSOLE=0 NODE_ENV=development bun
// scripts/benchmark-transcript.ts baseline (use "after" for the same later run).
// A .ts entry point keeps this file in the existing scripts/**/*.ts typecheck
// and inherits the root aliases without a new manifest, tsconfig, or dependency.
// Use a unique synthetic directory, configurable through TMPDIR on every host;
// no benchmark path is derived from the user's real workspace/session storage.
const TEMP_PARENT = tmpdir()
const samples = Number(process.env.BENCH_SAMPLES ?? 20)
const warmups = 3
const sessionInfo = {
    id: "benchmark-session", agentId: "benchmark-agent", title: "Synthetic only",
    createdAt: 0, updatedAt: 0,
}
const branches = [
    "messages", "fileChangeProposals", "pendingSteeringMessages",
    "pendingFollowUpMessages", "compactionCheckpoint", "contextUsage",
    "pendingToolCallIds", "streamingMessage",
] as const satisfies readonly (keyof ISessionSnapshot)[]

function stats(values: readonly number[]) {
    assert(values.length > 0)
    const sorted = [...values].sort((a, b) => a - b)
    const middle = Math.floor(sorted.length / 2)
    const median = sorted.length % 2 ? sorted[middle]!
        : (sorted[middle - 1]! + sorted[middle]!) / 2
    return {
        median: Number(median.toFixed(4)),
        p95: Number(sorted[Math.ceil(sorted.length * 0.95) - 1]!.toFixed(4)),
    }
}

function userMessage(id: string, content: string, createdAt: number): IUserMessage {
    return {
        id, content, createdAt, sessionId: sessionInfo.id,
        runId: `run-${id}`, role: "user", source: "prompt",
    }
}

async function sessionBenchmark(history: number, proposals: number) {
    const manager = new InMemorySessionManager()
    manager.createSession(sessionInfo)
    for (let i = 0; i < history; i++) {
        const message = userMessage(`history-${i}`, `Question ${i}`, i + 1)
        manager.appendMessage(i % 2 === 0 ? message : {
            id: message.id, sessionId: message.sessionId, runId: message.runId,
            createdAt: message.createdAt, role: "assistant", stopReason: "stop",
            content: [{ type: "text", text: `Answer ${i}: plain **markdown**.` }],
        })
    }
    // Resolved standalone proposals exercise chronological insertion and do not
    // trigger orphan recovery. Plain .txt diffs avoid grammar download/startup.
    for (let i = 0; i < proposals; i++) {
        manager.saveFileChangeProposal({
            id: `proposal-${i}`, sessionId: sessionInfo.id, runId: `old-${i}`,
            toolCallId: `edit-${i}`, operation: "edit", path: `file-${i}.txt`,
            diff: `--- a/file-${i}.txt\n+++ b/file-${i}.txt\n@@ -1 +1 @@\n-old\n+new\n`,
            status: "applied", createdAt: i + 1, resolvedAt: i + 2,
        })
    }
    manager.saveCompactionCheckpoint({
        id: "checkpoint", sessionId: sessionInfo.id, createdAt: history + 1,
        reason: "manual", compactedMessageCount: 2,
        throughMessageId: "history-1", summary: "Earlier synthetic context.",
    })

    let deltaIndex = -1
    const model: IAgentModel = {
        async *stream() {
            yield { type: "text-start", id: "answer" }
            yield { type: "text-delta", id: "answer", delta: "Live" }
            for (let i = 0; i < warmups + samples; i++) {
                // The generator resumes only after this event has been consumed.
                // Mark just steady deltas, never preflight, start/end, or persistence.
                deltaIndex = i
                yield { type: "text-delta", id: "answer", delta: " x" }
                deltaIndex = -1
            }
            yield { type: "text-end", id: "answer" }
            yield { type: "finish", reason: "stop" }
        },
    }
    let id = 0
    const session = new AgentSession({
        agentId: sessionInfo.agentId, sessionId: sessionInfo.id, manager,
        systemPrompt: "Synthetic benchmark", tools: [],
        resolveRunConfiguration: () => ({ model, reasoningEffort: "medium" }),
        now: () => history + proposals + 10, generateId: () => `live-${id++}`,
    })
    const snapshots: ISessionSnapshot[] = []
    const durations: number[] = []
    const identityChanges = Object.fromEntries(branches.map((key) => [key, 0]))

    // Instance-local timing shim, not a replacement implementation or a global
    // mock. This intentionally depends on the private publication boundary;
    // fail loudly if it is renamed. No React listener is attached in this pass.
    // The timer encloses the real publication only, excluding the builder,
    // reducer, identity comparisons, recording, initial history, and final save.
    const probe = session as unknown as { publishSnapshot(): void }
    const publish = probe.publishSnapshot
    assert.equal(typeof publish, "function", "Publication probe needs updating")
    probe.publishSnapshot = () => {
        if (deltaIndex < 0) return publish.call(session)
        const before = session.getSnapshot()
        const start = performance.now()
        publish.call(session)
        const elapsed = performance.now() - start
        const after = session.getSnapshot()
        if (snapshots.length === 0) snapshots.push(before)
        snapshots.push(after)
        if (deltaIndex < warmups) return
        durations.push(elapsed)
        for (const key of branches) {
            if (before[key] !== after[key]) identityChanges[key]! += 1
        }
    }
    try {
        const run = session.prompt("Continue")
        await run.initialPromptProcessed
        await run.runFinished
        assert.equal(session.getSnapshot().lastRunReason, "completed")
        assert.equal(durations.length, samples, "Expected one publication per delta")
        assert.equal(snapshots.length, warmups + samples + 1)
        assert.equal(snapshots[0]!.messages.length, history + 1)
    } finally {
        probe.publishSnapshot = publish
        await session.dispose()
    }

    // Replay the *actual frozen snapshots*, not synthesized stable props. This
    // preserves broken branch identities, including P=0, without charging React
    // work to session publication. It is deliberately not a live end-to-end run.
    const render = await renderReplay(snapshots, (snapshot) => createElement("scrollbox", {
        width: "100%", height: "100%", stickyScroll: true, stickyStart: "bottom",
    }, createElement(Transcript, snapshot)), "Live x")
    return {
        scenario: "session", history, proposals, checkpoint: true,
        publications: durations.length, publicationMs: stats(durations), identityChanges, render,
    }
}

async function renderReplay<T>(values: readonly T[], render: (value: T) => ReactNode, expectedText: string) {
    assert.equal(values.length, warmups + samples + 1)
    let current = values[0]!
    const listeners = new Set<() => void>()
    const subscribe = (listener: () => void) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
    }
    const getSnapshot = () => current
    let wrapperRenders = 0
    let commits = 0
    let reactDuration = 0
    function Probe() {
        const value = useSyncExternalStore(subscribe, getSnapshot)
        wrapperRenders++
        return render(value)
    }
    const setup = await testRender(createElement(Profiler, {
        id: "benchmark",
        onRender: (_id, _phase, actualDuration) => {
            commits++
            reactDuration += actualDuration
        },
    }, createElement(Probe)), { width: 100, height: 30, useThread: false })
    const actTimes: number[] = []
    const reactTimes: number[] = []
    const frameTimes: number[] = []
    let measuredRenders = 0
    let measuredCommits = 0
    try {
        await setup.renderOnce()
        const highlighting: Promise<void>[] = []
        const visit = (node: Renderable) => {
            if (node instanceof CodeRenderable) highlighting.push(node.highlightingDone)
            for (const child of node.getChildren()) visit(child)
        }
        visit(setup.renderer.root)
        await act(async () => { await Promise.all(highlighting) })
        await setup.renderOnce()

        for (let i = 0; i < warmups + samples; i++) {
            const beforeRenders = wrapperRenders
            const beforeCommits = commits
            const beforeReact = reactDuration
            const start = performance.now()
            act(() => {
                current = values[i + 1]!
                for (const listener of listeners) listener()
            })
            const actMs = performance.now() - start
            const frameStart = performance.now()
            await setup.renderOnce()
            const frameMs = performance.now() - frameStart
            // These are observed wrapper executions and Profiler commit callbacks,
            // NOT snapshot IDs, durable-child render counts, or terminal latency.
            assert(wrapperRenders > beforeRenders, "Store update did not render")
            if (i < warmups) continue
            actTimes.push(actMs)
            frameTimes.push(frameMs)
            reactTimes.push(reactDuration - beforeReact)
            measuredRenders += wrapperRenders - beforeRenders
            measuredCommits += commits - beforeCommits
        }
        // Check visible output outside timing; a mounted wrapper alone would not
        // prove the actual tool line or off-screen streaming tail was painted.
        assert(setup.captureCharFrame().includes(expectedText), "Expected content was not painted")
        return {
            updates: samples, wrapperRenders: measuredRenders, profilerCommits: measuredCommits,
            actFlushMs: stats(actTimes), reactActualMs: measuredCommits ? stats(reactTimes) : null,
            renderOnceMs: stats(frameTimes),
        }
    } finally {
        act(() => setup.renderer.destroy())
    }
}

function jsonlBenchmark(directory: string, targetMiB: number) {
    const filePath = join(directory, `${targetMiB}MiB.jsonl`)
    const record = (recordType: string, value: unknown) =>
        JSON.stringify({ recordType, version: 2, [recordType]: value }) + "\n"
    // Keep record count constant across sizes so file length, not a longer
    // in-memory message index, is the independent variable. Direct fixture
    // creation and real manager replay both finish before timing any append.
    const seedMessages = 128
    const payload = "x".repeat(targetMiB * 1024 * 1024 / seedMessages)
    const lines = [record("session", sessionInfo)]
    for (let i = 0; i < seedMessages; i++) {
        lines.push(record("message", userMessage(`seed-${i}`, payload, i + 1)))
    }
    writeFileSync(filePath, lines.join(""), { mode: 0o600 })
    const manager = new JsonlSessionManager({ filePath })
    try {
        assert.equal(manager.getMessages(sessionInfo.id).length, seedMessages)
        const appends = Array.from({ length: warmups + samples }, (_, i) =>
            userMessage(`append-${String(i).padStart(4, "0")}`, "a".repeat(64), 10000 + i))
        for (const message of appends.slice(0, warmups)) manager.appendMessage(message)
        const bytesBefore = statSync(filePath).size
        const durations: number[] = []
        for (const message of appends.slice(warmups)) {
            const start = performance.now()
            manager.appendMessage(message)
            durations.push(performance.now() - start)
        }
        const bytesAfter = statSync(filePath).size
        const appendedRecordBytes = Buffer.byteLength(record("message", appends[warmups]))
        assert.equal(bytesAfter - bytesBefore, samples * appendedRecordBytes)
        assert.equal(manager.getMessages(sessionInfo.id).length, seedMessages + warmups + samples)
        return {
            scenario: "jsonl", targetMiB, seedMessages, bytesBefore, bytesAfter,
            appendContentBytes: 64, appendedRecordBytes, appends: samples, appendMs: stats(durations),
        }
    } finally {
        manager.dispose()
    }
}

async function toolBenchmark(toolName: string, entries: number, phase: "pending" | "running" | "completed") {
    const edits = Array.from({ length: entries }, (_, i) => ({
        oldText: `old-${i}:` + "x".repeat(64), newText: `new-${i}:` + "y".repeat(64),
    }))
    const input = toolName === "edit" ? { path: "synthetic.txt", edits } : { payload: edits }
    const call: IToolCallContent = { type: "toolCall", toolCallId: "tool", toolName, input }
    const result: IToolResultMessage = {
        id: "result", sessionId: sessionInfo.id, runId: "tool-run", createdAt: 1,
        role: "toolResult", toolCallId: call.toolCallId, toolName,
        content: "Completed", summary: "Completed", isError: false, outcome: "completed",
    }
    // New store snapshots force ordinary parent-driven updates while call/input
    // identity stays unchanged, as when unrelated transcript deltas rerender a
    // durable tool. No JSON.stringify/proxy counters alter payload semantics.
    // Byte counting and all fixture construction are outside the render timers.
    const inputBytes = Buffer.byteLength(JSON.stringify(input))
    const values = Array.from({ length: warmups + samples + 1 }, () =>
        phase === "completed" ? { call, result } : { call, phase })
    const render = await renderReplay(values, (props) => createElement(ToolActivityLine, props),
        toolName === "edit" ? "Edit" : toolName)
    return { scenario: "tool", toolName, entries, phase, inputBytes, render }
}

assert(Number.isSafeInteger(samples) && samples >= 2 && samples <= 1000, "BENCH_SAMPLES must be 2..1000")
assert.notEqual(process.env.NODE_ENV, "production", "React act/Profiler require a development run")
assert(statSync(TEMP_PARENT).isDirectory())
const git = (args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { cwd: join(import.meta.dir, "..") })
    assert.equal(result.exitCode, 0, "Unable to identify benchmark worktree")
    return result.stdout.toString()
}
const sourceHash = () => createHash("sha256").update(git(["diff", "HEAD", "--", "src"])).digest("hex")
const srcDiffSha256 = sourceHash()
// Version strings alone miss same-version patches, and a changed harness can
// change the workload. Fingerprint these inputs (including untracked patches)
// outside all measured operations and reject runs where they change midway.
const inputFiles = [
    "scripts/benchmark-transcript.ts", "package.json", "bun.lock",
    ...Object.values((packageMetadata as {
        patchedDependencies?: Readonly<Record<string, string>>
    }).patchedDependencies ?? {}),
]
const inputHashes = () => Object.fromEntries(inputFiles.map((path) => [
    path,
    createHash("sha256").update(readFileSync(join(import.meta.dir, "..", path))).digest("hex"),
]))
const benchmarkInputs = inputHashes()
const started = performance.now()
console.log(JSON.stringify({
    scenario: "metadata", label: Bun.argv[2] ?? "baseline", timestamp: new Date().toISOString(),
    bun: Bun.version, react: reactVersion, opentui: opentuiPackage.version,
    platform: process.platform, arch: process.arch, osRelease: release(), cpu: cpus()[0]?.model,
    nodeEnv: process.env.NODE_ENV ?? "development", gitHead: git(["rev-parse", "HEAD"]).trim(),
    srcDiffSha256, benchmarkInputs,
    samples, warmups, renderer: { width: 100, height: 30, useThread: false },
    units: "milliseconds; median and nearest-rank p95 of individual warmed operations",
    scope: [
        "Session publication only: instance-local real publishSnapshot timer, no React listeners; 2-character deltas are not tokens.",
        "Render: recorded real snapshots via useSyncExternalStore; actFlush includes scheduling/reconciliation/commit; Profiler actualDuration excludes commit; renderOnce is a separate manual OpenTUI frame.",
        "History H excludes the new prompt; checkpoint present; plain markdown and short .txt proposals in a bottom-sticky scrollbox; initial build/highlighting, preflight and final persistence excluded.",
        "JSONL: existing newline-terminated synthetic logs, warmed OS cache, real append validation/cloning/I/O; no replay, first-session atomic creation, fsync guarantee, or cold-disk claim.",
        "Tools: parent-driven rerenders in fixed phases with stable large inputs; formatting plus React work, not isolated formatting or actual tool execution.",
        "Sequential machine-local samples, not independent process trials or latency promises; no performance assertions, global mocks, or production instrumentation.",
    ],
}))

// Every filesystem fixture has an explicit path inside our unique approved-temp
// child. Never call defaultSessionFilePath or discover/read ~/.buli session logs.
const directory = mkdtempSync(join(TEMP_PARENT, "benchmark-transcript-"))
try {
    for (const history of [10, 100, 1000]) {
        for (const proposals of [0, 10]) console.log(JSON.stringify(await sessionBenchmark(history, proposals)))
    }
    for (const size of [1, 16]) console.log(JSON.stringify(jsonlBenchmark(directory, size)))
    for (const tool of ["edit", "unknown_tool"]) {
        for (const entries of [16, 4096]) {
            for (const phase of ["pending", "running", "completed"] as const) {
                console.log(JSON.stringify(await toolBenchmark(tool, entries, phase)))
            }
        }
    }
} finally {
    rmSync(directory, { recursive: true, force: true })
}
assert.equal(sourceHash(), srcDiffSha256, "Production worktree changed during benchmark; discard this run")
assert.deepEqual(inputHashes(), benchmarkInputs, "Benchmark inputs changed during the run; discard this run")
console.log(JSON.stringify({ scenario: "complete", fixturesRemoved: true, sourceUnchanged: true, inputsUnchanged: true, elapsedMs: Number((performance.now() - started).toFixed(2)) }))
