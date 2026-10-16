import { expect, test } from "bun:test"
import { createBuliAgentDefinition } from "@/agent/definitions/buli"
import { QUALITY_INSTRUCTIONS } from "@/agent/definitions/shared/quality-instructions"
import { EphemeralToolOutputStore } from "@/agent/tools/output/ephemeral-tool-output-store"
import { createBuliYoloAgentDefinition } from "./index"

const dependencies = () => ({
    workspaceRoot: "/workspace",
    toolOutputStore: new EphemeralToolOutputStore(),
})

test("Buli and YOLO share quality requirements but have independent workflows", () => {
    const deps = dependencies()
    const buli = createBuliAgentDefinition(deps)
    const originalPrompt = buli.systemPrompt
    const yolo = createBuliYoloAgentDefinition(deps)

    expect(yolo.id).toBe("buli-yolo")
    expect(yolo.name).toBe("Buli YOLO")
    expect(buli.systemPrompt).toContain(QUALITY_INSTRUCTIONS)
    expect(yolo.systemPrompt).toContain(QUALITY_INSTRUCTIONS)
    expect(buli.systemPrompt).toContain("Nie zmieniaj plików, dopóki wyraźnie nie zgodzę się")
    expect(yolo.systemPrompt).not.toContain("Nie zmieniaj plików, dopóki wyraźnie nie zgodzę się")
    expect(yolo.systemPrompt).not.toContain("3. Plan przed edycją")
    expect(yolo.systemPrompt).not.toContain("4. Zgoda i wdrożenie")
    expect(yolo.systemPrompt).toContain("Nie wymagaj osobnego zatwierdzenia")
    expect(yolo.systemPrompt).toContain("Pytania, prośby o wyjaśnienie i porównywanie opcji nie są poleceniem wdrożenia.")
    expect(yolo.systemPrompt).toContain("Nie osłabiaj kryteriów ukończenia ani testów")
    expect(yolo.systemPrompt).toContain("Raport jest częścią zadania")
    expect(yolo.systemPrompt).toContain("Nie wykonuj nieuzgodnionych operacji destrukcyjnych")
    expect(buli.systemPrompt).toBe(originalPrompt)
    expect(yolo.tools.map(tool => tool.name)).toEqual(buli.tools.map(tool => tool.name))
})

test("YOLO requires a teaching explanation before considering the task complete", () => {
    const yolo = createBuliYoloAgentDefinition(dependencies())
    const prompt = yolo.systemPrompt.replace(/\s+/g, " ")

    expect(prompt).toContain("Zadanie kończy się dopiero po wyjaśnieniu rozwiązania.")
    expect(prompt).toContain("Nie zakładaj znajomości projektu ani technologii.")
    expect(prompt).toContain("Wyjaśnij potrzebne podstawy, problem, decyzje i działanie zmienionego kodu na rzeczywistych fragmentach.")
    expect(prompt).toContain("Podaj testy i ograniczenia.")
    expect(prompt).toContain("Lista plików i wyników testów nie zastępuje nauki.")
})

test("YOLO overrides Bash approval guidance without changing Buli or access policy", () => {
    const deps = dependencies()
    const buli = createBuliAgentDefinition(deps)
    const yolo = createBuliYoloAgentDefinition(deps)
    const defaultBash = buli.tools.find(tool => tool.name === "bash")!
    const yoloBash = yolo.tools.find(tool => tool.name === "bash")!

    expect(defaultBash.description).toContain("Obtain the conversational approval")
    expect(yoloBash.description).not.toContain("Obtain the conversational approval")
    expect(yoloBash.description).toContain("without asking for additional approval")
    expect(yoloBash.description).toContain("including read-only commands and tests")
    expect(yoloBash.description).toContain("unagreed destructive operations or production actions")
    expect(yoloBash.description).toContain("It is not a sandbox")
    expect(yoloBash.inputSchema).toBe(defaultBash.inputSchema)
    expect(yoloBash.access).toBe(defaultBash.access)
    expect(createBuliAgentDefinition(deps).tools.find(tool => tool.name === "bash")!.description)
        .toBe(defaultBash.description)
})

test("YOLO retains workspace context, tool instructions and injected tools", () => {
    const deps = dependencies()
    const workspaceInstructions = { source: ".buli/BULI.md", content: "Use project conventions." }
    const yolo = createBuliYoloAgentDefinition({ ...deps, workspaceInstructions })
    expect(yolo.systemPrompt).toContain("Current working directory and workspace root: /workspace.")
    expect(yolo.systemPrompt).toContain(JSON.stringify({ workspaceInstructions }))
    expect(yolo.systemPrompt).toContain("### Text reading")
    expect(yolo.systemPrompt).toContain("Active tools: read, find, grep, tool_output, edit, write, bash.")

    const injected = yolo.tools.find(tool => tool.name === "read")!
    const custom = createBuliYoloAgentDefinition(deps, { tools: [injected] })
    expect(custom.tools.map(tool => tool.name)).toEqual(["read", "tool_output"])
    expect(custom.tools[0]).toBe(injected)
})
