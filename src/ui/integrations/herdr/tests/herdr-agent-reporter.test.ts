import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
    createHerdrAgentReporter,
    readHerdrPane,
} from "@/ui/integrations/herdr/herdr-agent-reporter"

const PANE = { paneId: "w1:p2", socketPath: "/tmp/herdr.sock" }

test("reads the Herdr pane only inside a Herdr-managed pane", () => {
    expect(readHerdrPane({})).toBeUndefined()
    expect(readHerdrPane({ HERDR_ENV: "1", HERDR_PANE_ID: "w1:p2" })).toBeUndefined()
    expect(readHerdrPane({
        HERDR_ENV: "0",
        HERDR_PANE_ID: "w1:p2",
        HERDR_SOCKET_PATH: "/tmp/herdr.sock",
    })).toBeUndefined()
    expect(readHerdrPane({
        HERDR_ENV: "1",
        HERDR_PANE_ID: "w1:p2",
        HERDR_SOCKET_PATH: "/tmp/herdr.sock",
    })).toEqual(PANE)
})

test("reports state as a buli agent with strictly increasing seq", () => {
    const sent: Array<{ socketPath: string; request: any }> = []
    const reporter = createHerdrAgentReporter(
        PANE,
        (socketPath, request) => sent.push({ socketPath, request }),
        () => 5,
    )

    reporter.report("working")
    reporter.report("idle")

    expect(sent.map(({ socketPath }) => socketPath)).toEqual([PANE.socketPath, PANE.socketPath])
    expect(sent[0]!.request).toEqual({
        id: "buli:5000",
        method: "pane.report_agent",
        params: {
            pane_id: "w1:p2",
            source: "buli:herdr",
            agent: "buli",
            state: "working",
            seq: 5_000,
        },
    })
    expect(sent[1]!.request.params.state).toBe("idle")
    expect(sent[1]!.request.params.seq).toBe(5_001)
})

test("writes one JSON line to the Herdr socket", async () => {
    const directory = mkdtempSync(join(tmpdir(), "buli-herdr-"))
    const socketPath = join(directory, "herdr.sock")
    const received = Promise.withResolvers<string>()
    const server = createServer((socket) => {
        let buffer = ""
        socket.on("data", (chunk) => {
            buffer += chunk.toString()
            if (!buffer.endsWith("\n")) return
            socket.end("{\"id\":\"buli\",\"result\":{}}\n")
            received.resolve(buffer)
        })
    })
    await new Promise<void>((resolve) => server.listen(socketPath, resolve))

    try {
        createHerdrAgentReporter({ paneId: "w1:p2", socketPath }).report("working")
        const line = await received.promise
        expect(JSON.parse(line).params.state).toBe("working")
    } finally {
        server.close()
        rmSync(directory, { recursive: true, force: true })
    }
})

test("ignores an unavailable Herdr socket", async () => {
    const reporter = createHerdrAgentReporter({
        paneId: "w1:p2",
        socketPath: join(tmpdir(), "buli-herdr-missing.sock"),
    })

    expect(() => reporter.report("idle")).not.toThrow()
    await Bun.sleep(50)
})
