import type { Renderable, InputRenderable, TextareaRenderable } from "@opentui/core"
import { expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { act } from "react"
import { BuliUiController } from "@/ui/ui-controller"
import type { IBuliApplication, IUserPromptCommand } from "@/app/contracts"
import { BuliUiControllerProvider } from "@/ui/context/ui-controller-context"
import { CommandPanel } from "./CommandPanel"
import { BuliRuntimeProvider } from "@/ui/context/application-context"
import { ChatInput } from "./ChatInput"

test("keyboard form saves multiline prompt, preserves chat draft and isolates Tab", async () => {
    const saved: IUserPromptCommand[] = []
    let toggles = 0
    const application = {
        workspaceRoot: "/workspace",
        promptCommands: {
            list: () => saved,
            add: (command: IUserPromptCommand) => { saved.push(command) },
            remove: (name: string) => { saved.splice(saved.findIndex(command => command.name === name), 1) },
        },
        toggleBuliAgent: async () => { toggles++ },
    } as unknown as IBuliApplication
    const controller = new BuliUiController({ application })
    controller.updateInput("Keep draft")
    controller.openCommands()
    const setup = await testRender(<BuliRuntimeProvider runtime={application}><BuliUiControllerProvider controller={controller}>
        <CommandPanel /><ChatInput />
    </BuliUiControllerProvider></BuliRuntimeProvider>, { width: 80, height: 24 })
    const key = async (name: string, sequence = "") => {
        await act(async () => {
            setup.renderer.keyInput.processParsedKey({ name, sequence, ctrl: false, meta: false, shift: false } as Parameters<typeof setup.renderer.keyInput.processParsedKey>[0])
            await setup.renderOnce()
        })
    }
    const type = async (text: string) => { for (const char of text) await key(char, char) }
    try {
        await act(async () => { await setup.renderOnce() })
        expect(setup.captureCharFrame()).toContain("[Add new]")
        await key("return", "\r")
        expect(setup.captureCharFrame()).toContain("Add command")
        await type("review")
        await key("tab", "\t")
        await type("First line")
        await key("return", "\r")
        await type("Second line")
        await key("tab", "\t")
        await key("tab", "\t")
        await key("return", "\r")
        expect(saved).toEqual([{ name: "review", prompt: "First line\nSecond line" }])
        expect(controller.getInputDraft().text).toBe("Keep draft")
        expect(toggles).toBe(0)
        expect(setup.captureCharFrame()).toContain("/review")
        const remove = findById(setup.renderer.root, "delete-command-review")!
        await act(async () => {
            await setup.mockMouse.click(remove.screenX + 2, remove.screenY)
            await setup.renderOnce()
        })
        expect(saved).toEqual([])
        const add = findById(setup.renderer.root, "add-command")!
        await act(async () => {
            await setup.mockMouse.click(add.screenX + 3, add.screenY)
            await setup.renderOnce()
        })
        expect(controller.getSnapshot().commandPanel?.mode).toBe("add")
        const name = findById(setup.renderer.root, "command-name") as InputRenderable
        const prompt = findById(setup.renderer.root, "command-prompt") as TextareaRenderable
        await act(async () => {
            name.value = "explain"
            prompt.setText("Explain code")
            await setup.renderOnce()
        })
        const save = findById(setup.renderer.root, "save-command")!
        await act(async () => {
            await setup.mockMouse.click(save.screenX + 1, save.screenY)
            await setup.renderOnce()
        })
        expect(saved).toEqual([{ name: "explain", prompt: "Explain code" }])
    } finally { act(() => setup.renderer.destroy()); controller.dispose() }
})

function findById(root: Renderable, id: string): Renderable | undefined {
    if (root.id === id) return root
    for (const child of root.getChildren()) {
        const result = findById(child, id)
        if (result) return result
    }
    return undefined
}
