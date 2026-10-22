import { createConnection } from "node:net"

export type THerdrAgentState = "idle" | "working"

export interface IHerdrPane {
    readonly paneId: string
    readonly socketPath: string
}

export interface IHerdrAgentReporter {
    readonly report: (state: THerdrAgentState) => void
}

export type THerdrRequestSender = (socketPath: string, request: unknown) => void

const AGENT_LABEL = "buli"
const REPORT_SOURCE = "buli:herdr"

/** Returns the Herdr pane hosting this process, or undefined outside Herdr. */
export function readHerdrPane(env: NodeJS.ProcessEnv = process.env): IHerdrPane | undefined {
    if (env.HERDR_ENV !== "1") return undefined
    const paneId = env.HERDR_PANE_ID
    const socketPath = env.HERDR_SOCKET_PATH
    if (!paneId || !socketPath) return undefined
    return { paneId, socketPath }
}

/** Reports buli's lifecycle state to the Herdr pane it runs in. */
export function createHerdrAgentReporter(
    pane: IHerdrPane,
    send: THerdrRequestSender = sendHerdrRequest,
    now: () => number = Date.now,
): IHerdrAgentReporter {
    let lastSeq = 0
    return {
        report: (state) => {
            // Herdr drops reports with a lower seq than the last one from this source,
            // so seq must stay increasing across reconnects and buli restarts.
            lastSeq = Math.max(lastSeq + 1, now() * 1_000)
            send(pane.socketPath, {
                id: `buli:${lastSeq}`,
                method: "pane.report_agent",
                params: {
                    pane_id: pane.paneId,
                    source: REPORT_SOURCE,
                    agent: AGENT_LABEL,
                    state,
                    seq: lastSeq,
                },
            })
        },
    }
}

/** Fire-and-forget: Herdr being unavailable must never affect buli. */
function sendHerdrRequest(socketPath: string, request: unknown): void {
    const socket = createConnection(socketPath)
    socket.on("error", () => { })
    socket.on("data", () => socket.end())
    socket.setTimeout(2_000, () => socket.destroy())
    socket.write(`${JSON.stringify(request)}\n`)
}
