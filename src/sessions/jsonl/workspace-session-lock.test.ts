import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { WorkspaceSessionManager } from "@/sessions/jsonl/workspace-session-manager"

const managerImport = `import { WorkspaceSessionManager } from ${JSON.stringify(
    join(import.meta.dir, "workspace-session-manager.ts"),
)};`

const sharedInfo = {
    id: "shared", agentId: "test-agent", title: "Shared", createdAt: 1, updatedAt: 1,
}

const originalMessage = {
    id: "original", sessionId: "shared", runId: "run-1", role: "user" as const,
    source: "prompt" as const, content: "Before handoff", createdAt: 2,
}

const laterMessage = {
    ...originalMessage, id: "later", content: "After handoff", createdAt: 3,
}

test("workspace conversations remain independent across processes and reload after handoff", async () => {
    const directoryPath = await mkdtemp(join(tmpdir(), "buli-workspace-process-lock-"))
    let owner: WorkspaceSessionManager | undefined
    const probe = (operation: "independent" | "shared") => Bun.spawnSync([
        process.execPath, "-e",
        `${managerImport}
        const manager = new WorkspaceSessionManager({ directoryPath: process.argv[1] });
        try {
            if (process.argv[2] === "independent") {
                manager.createSession({ id: "other", agentId: "test-agent", title: "Other", createdAt: 1, updatedAt: 1 });
                manager.appendMessage({ id: "question", sessionId: "other", runId: "run-2", role: "user", source: "prompt", content: "Independent question", createdAt: 2 });
            } else {
                manager.openSession("shared");
                manager.appendMessage(${JSON.stringify(laterMessage)});
            }
        } catch (error) {
            console.error(error.message);
            process.exitCode = 1;
        } finally {
            manager.dispose();
        }`,
        directoryPath, operation,
    ], { cwd: join(import.meta.dir, "../../.."), timeout: 5000 })

    try {
        owner = new WorkspaceSessionManager({ directoryPath })
        owner.createSession(sharedInfo)
        owner.appendMessage(originalMessage)
        const independent = probe("independent")
        expect(independent.exitCode).toBe(0)
        expect(independent.stderr.toString()).toBe("")
        const blocked = probe("shared")
        expect(blocked.exitCode).toBe(1)
        expect(blocked.stderr.toString()).toContain("Unable to lock session log")
        expect(owner.getMessages("shared")).toEqual([originalMessage])

        owner.releaseSession("shared")
        const acquired = probe("shared")
        expect(acquired.exitCode).toBe(0)
        expect(acquired.stderr.toString()).toBe("")
        owner.openSession("shared")
        expect(owner.getMessages("shared")).toEqual([originalMessage, laterMessage])
        owner.dispose()

        owner = new WorkspaceSessionManager({ directoryPath })
        expect(owner.listSessions().map((info) => info.id).sort()).toEqual(["other", "shared"])
        owner.openSession("other")
        expect(owner.getMessages("other").map((message) => message.content))
            .toEqual(["Independent question"])
    } finally {
        try {
            owner?.dispose()
        } finally {
            await rm(directoryPath, { recursive: true, force: true })
        }
    }
})

test("workspace conversation ownership is released after its process is killed", async () => {
    const directoryPath = await mkdtemp(join(tmpdir(), "buli-workspace-crash-lock-"))
    const ready = Promise.withResolvers<void>()
    let child: ReturnType<typeof Bun.spawn> | undefined
    let observer: WorkspaceSessionManager | undefined
    let readinessTimeout: ReturnType<typeof setTimeout> | undefined
    try {
        const owner = Bun.spawn([
            process.execPath, "-e",
            `${managerImport}
            const manager = new WorkspaceSessionManager({ directoryPath: process.argv[1] });
            manager.createSession(${JSON.stringify(sharedInfo)});
            manager.appendMessage(${JSON.stringify(originalMessage)});
            process.send("locked");
            setInterval(() => manager.listSessions(), 1000);`,
            directoryPath,
        ], {
            cwd: join(import.meta.dir, "../../.."),
            stdout: "ignore",
            stderr: "pipe",
            ipc(message) {
                if (message === "locked") ready.resolve()
            },
        })
        child = owner
        readinessTimeout = setTimeout(() => {
            ready.reject(new Error("Child did not acquire the conversation within five seconds"))
        }, 5000)
        await Promise.race([
            ready.promise,
            owner.exited.then(async (code) => {
                throw new Error(`Conversation owner exited (${code}): ${await new Response(owner.stderr).text()}`)
            }),
        ])
        clearTimeout(readinessTimeout)
        observer = new WorkspaceSessionManager({ directoryPath })
        expect(observer.listSessions()).toEqual([{ ...sharedInfo, updatedAt: 2 }])
        expect(() => observer!.openSession("shared")).toThrow("Unable to lock session log")

        owner.kill("SIGKILL")
        await owner.exited
        observer.openSession("shared")
        expect(observer.getMessages("shared")).toEqual([originalMessage])
        observer.appendMessage(laterMessage)
        observer.releaseSession("shared")
        observer.openSession("shared")
        expect(observer.getMessages("shared")).toEqual([originalMessage, laterMessage])
    } finally {
        clearTimeout(readinessTimeout)
        try {
            if (child) {
                if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
                await child.exited
            }
        } finally {
            try {
                observer?.dispose()
            } finally {
                await rm(directoryPath, { recursive: true, force: true })
            }
        }
    }
}, 15000)
