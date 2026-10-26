import { expect, mock, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { act } from "react"

import { ConfiguredStatusLine } from "../ConfiguredStatusLine"

test("renders the configured command's ANSI lines with the session's model and context", async () => {
    const render = mock(async (_session: unknown, _signal: AbortSignal): Promise<string | undefined> =>
        "\x1b[38;2;59;130;246mGPT-5\x1b[0m │ CONTEXT 23%\n\x1b[1mLEARNING\x1b[0m")
    const setup = await testRender(<ConfiguredStatusLine
        render={render}
        sessionId="session-1"
        modelId="gpt-5"
        modelName="GPT-5"
        contextUsage={{ estimatedInputTokens: 46_000, compactionInputTokens: 46_000, contextWindowTokens: 200_000, shouldCompact: false }}
    />, { width: 60, height: 6 })
    try {
        await act(async () => { await Bun.sleep(350) })
        await act(async () => { await setup.renderOnce() })
        const frame = setup.captureCharFrame()
        expect(frame).toContain("GPT-5 │ CONTEXT 23%")
        expect(frame).toContain("LEARNING")
        expect(render).toHaveBeenCalledTimes(1)
        expect(render.mock.calls[0]![0]).toEqual({
            sessionId: "session-1", modelId: "gpt-5", modelName: "GPT-5", inputTokens: 46_000, contextWindowTokens: 200_000,
        })
    } finally { act(() => setup.renderer.destroy()) }
})

test("draws nothing when the command fails", async () => {
    const setup = await testRender(<ConfiguredStatusLine
        render={async () => undefined}
        sessionId={undefined}
        modelId="m"
        modelName="M"
        contextUsage={undefined}
    />, { width: 40, height: 4 })
    try {
        await act(async () => {
            await Bun.sleep(350)
            await setup.renderOnce()
        })
        expect(setup.captureCharFrame().trim()).toBe("")
    } finally { act(() => setup.renderer.destroy()) }
})
