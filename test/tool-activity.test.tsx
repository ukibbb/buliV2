import { expect, test } from "bun:test"
import { isValidElement, type ReactNode } from "react"

import type { IToolResultMessage } from "@/agent"
import { ToolActivityLine } from "@/sessions/ui/ToolActivity"
import { glyphs } from "@/terminal/theme"

// The component has no hooks. Reading its intrinsic JSX keeps work counters scoped
// to one presentation, without renderer scheduling or global serialization mocks.
function textContent(node: ReactNode): string {
    if (typeof node === "string" || typeof node === "number") return String(node)
    if (Array.isArray(node)) return node.map(textContent).join("")
    if (isValidElement<{ children?: ReactNode }>(node)) {
        return textContent(node.props.children)
    }
    return ""
}

function activity(
    toolName: string,
    input: Record<string, unknown>,
    result?: IToolResultMessage,
): string {
    return textContent(ToolActivityLine({
        call: { type: "toolCall", toolCallId: "call", toolName, input },
        phase: "running",
        ...(result === undefined ? {} : { result }),
    }))
}

function toolResult(overrides: Partial<IToolResultMessage>): IToolResultMessage {
    return {
        id: "result",
        sessionId: "session",
        runId: "run",
        createdAt: 1,
        role: "toolResult",
        toolCallId: "call",
        toolName: "read",
        content: "",
        isError: true,
        ...overrides,
    }
}

// Small fixtures only: pin the shipped escape-before-code-point-truncation order.
// Large-work tests below build bounded expectations instead of serializing fixtures.
function shippedTarget(value: string, maximum = 96): string {
    const escaped = value.replaceAll("\r", "\\r").replaceAll("\n", "\\n").replaceAll("\t", "\\t")
    const characters = [...escaped]
    return characters.length <= maximum
        ? escaped
        : `${characters.slice(0, maximum - 3).join("")}...`
}

test("preserves compact small tool parameters and fallback targets", () => {
    const cases: [string, Record<string, unknown>, string][] = [
        ["bash", { command: "bun test", timeout: 30 }, "Bash [bun test] timeout=30"],
        ["read", { path: "src/app.ts", offset: 20, limit: 40 }, "Read [src/app.ts] offset=20 limit=40"],
        ["find", { pattern: "**/*.ts", path: "src", limit: 25 }, "Find [**/*.ts] path=src limit=25"],
        ["glob", { pattern: "*.ts", hidden: false }, "Glob [*.ts] hidden=false"],
        ["grep", {
            pattern: "AgentSession", path: "src", glob: "*.ts", ignoreCase: true,
            literal: true, context: 2, limit: 25,
        }, "Grep [AgentSession] path=src glob=*.ts ignoreCase=true literal=true context=2 limit=25"],
        ["edit", { path: "src/app.ts", edits: [{ oldText: "before", newText: "after" }] },
            'Edit [src/app.ts] edits=[{"oldText":"before","newText":"after"}]'],
        ["write", { path: "src/new.ts", content: "export {}\n" }, "Write [src/new.ts]"],
        ["apply_patch", { explanation: "cleanup", changes: [{ kind: "delete", path: "p" }] },
            'Apply patch [cleanup] changes=[{"kind":"delete","path":"p"}]'],
        ["tool_output", { outputId: "id", part: "stdout", encoding: "utf8", offset: 0, maxBytes: 12, maxLines: 2 },
            "Tool output [id] part=stdout encoding=utf8 offset=0 maxBytes=12 maxLines=2"],
        ["custom", { query: "hello", count: 2 }, 'custom [{"query":"hello","count":2}]'],
        ["read", { offset: 0 }, 'Read [{"offset":0}] offset=0'],
        ["read", { path: 7, limit: 0 }, 'Read [{"path":7,"limit":0}] limit=0'],
        ["read_file", { path: "p" }, 'read_file [{"path":"p"}]'],
    ]
    for (const [name, input, expected] of cases) {
        expect(activity(name, input)).toBe(expected)
    }
})

test.each([95, 96, 97])("preserves exact target, parameter and JSON boundaries at %i code points", (length) => {
    const value = `${"a".repeat(length - 1)}\u{1F600}`
    const expected = shippedTarget(value)
    expect(activity("read", { path: value })).toBe(`Read [${expected}]`)
    expect(activity("grep", { pattern: "p", path: value, glob: value }))
        .toBe(`Grep [p] path=${expected} glob=${expected}`)
    const input = { value: "a".repeat(length - 12) }
    expect(activity("custom", input)).toBe(`custom [${shippedTarget(JSON.stringify(input))}]`)
})

test.each([39, 40, 41])("preserves the tool-name boundary at %i code points", (length) => {
    const name = `${"n".repeat(length - 1)}\u{1F600}`
    expect(activity(name, {})).toBe(`${shippedTarget(name, 40)} [{}]`)
})

test("escapes target controls before truncating code points, not graphemes or escape tokens", () => {
    const values = [
        "a\r\nb\rc\nd\te\\n",
        `${"a".repeat(92)}\u{1F600}tail`,
        `${"a".repeat(92)}e\u0301tail`,
        ...["\r", "\n", "\t"].map((control) => `${"a".repeat(92)}${control}tail`),
    ]
    for (const value of values) {
        expect(activity("bash", { command: value })).toBe(`Bash [${shippedTarget(value)}]`)
        expect(activity("find", { pattern: "p", path: value }))
            .toBe(`Find [p] path=${shippedTarget(value)}`)
    }
    expect(activity("read", { path: `${"a".repeat(92)}e\u0301tail` }))
        .toBe(`Read [${"a".repeat(92)}e...]`)
    expect(activity("read", { path: `${"a".repeat(92)}\ntail` }))
        .toBe(`Read [${"a".repeat(92)}\\...]`)
})

test("matches native compact JSON quoting, property order, omissions and array holes", () => {
    const shared = { value: "same" }
    const values: unknown[] = [
        null, true, false, 0, -0, 1.25, NaN, Infinity,
        { '"\\\r\n\t\b\f\u0000\uD800': "\uDC00\u{1F600}\u2028" },
        { 10: "ten", 2: "two", z: 1, a: 2, absent: undefined },
        [undefined, , null, () => {}, Symbol("omitted")],
        { omitted: () => {}, symbol: Symbol("omitted"), empty: [] },
        Object.assign(Object.create(null), { a: 1 }),
        [shared, shared],
        { value: "\u{1F600}".repeat(150) },
        { value: "\r\n\t\b\f\u0000\uD800".repeat(30) },
    ]
    for (const value of values) {
        expect(activity("edit", { path: "p", edits: value }))
            .toBe(`Edit [p] edits=${shippedTarget(JSON.stringify(value))}`)
        const input = { value }
        expect(activity("custom", input))
            .toBe(`custom [${shippedTarget(JSON.stringify(input))}]`)
    }
})

test.each([159, 160, 161])("preserves result-detail truncation at %i code points", (length) => {
    const summary = `${"a".repeat(length - 1)}\u{1F600}`
    expect(activity("read", { path: "p" }, toolResult({ summary, isError: false })))
        .toBe(`Read [p] ${shippedTarget(summary, 160)} ${glyphs.success}`)
})

test("keeps detail joining, newline replacement and whole-result trimming in order", () => {
    const cases: [string, string, string][] = [
        ["  first\r\nsecond\rthird\nfourth  ", "  why\tinside  ", "first | second | third | fourth   |   why\tinside"],
        [" ", "boom", "| boom"],
        ["ok", " ", "ok |"],
        ["", " \r\n\t ", "|"],
        [" ", " ", "|"],
        ["", "  ", ""],
        ["\uFEFF  detail  \u00A0", "", "detail"],
        [`${" ".repeat(1_000)}detail${" ".repeat(1_000)}`, "", "detail"],
    ]
    for (const [summary, content, expected] of cases) {
        expect(activity("read", { path: "p", offset: 1 }, toolResult({ summary, content })))
            .toBe(`Read [p] offset=1${expected ? ` | ${expected}` : ""} ${glyphs.failure}`)
    }
    expect(activity("read", { path: "p" }, toolResult({
        isError: false, outcome: "failed", content: "not a displayed error detail",
    }))).toBe(`Read [p] ${glyphs.failure}`)
})

test.each(["edit", "apply_patch"])("bounds %s nested string work without reading later fields or array entries", (name) => {
    for (const size of [1_000, 1_000_000]) {
        const largeText = "x".repeat(size)
        let entryReads = 0
        let textReads = 0
        let suffixReads = 0
        let serializationHooks = 0
        const first: Record<string, unknown> = name === "edit" ? {} : { kind: "write", path: "p" }
        Object.defineProperties(first, {
            [name === "edit" ? "oldText" : "content"]: {
                enumerable: true,
                get() { textReads++; return largeText },
            },
            later: {
                enumerable: true,
                get() { suffixReads++; throw new Error("Undisplayed field was read") },
            },
            toJSON: {
                get() { serializationHooks++; throw new Error("Whole object was serialized") },
            },
        })
        const entries = new Proxy(new Array<unknown>(size), {
            get(target, key, receiver) {
                if (key === "0") { entryReads++; return first }
                if (key === "toJSON") {
                    serializationHooks++
                    throw new Error("Whole array was serialized")
                }
                if (typeof key === "string" && /^\d+$/.test(key)) {
                    suffixReads++
                    throw new Error("Undisplayed array entry was read")
                }
                return Reflect.get(target, key, receiver)
            },
        })
        const prefix = name === "edit" ? '[{"oldText":"' : '[{"kind":"write","path":"p","content":"'
        const preview = `${prefix}${"x".repeat(93 - prefix.length)}...`
        expect(activity(name, name === "edit"
            ? { path: "p", edits: entries }
            : { explanation: "why", changes: entries }))
            .toBe(name === "edit" ? `Edit [p] edits=${preview}` : `Apply patch [why] changes=${preview}`)
        expect({ entryReads, textReads, suffixReads, serializationHooks })
            .toEqual({ entryReads: 1, textReads: 1, suffixReads: 0, serializationHooks: 0 })
    }
})

test("bounds unknown inputs and known tools with missing or non-string targets", () => {
    const body = "x".repeat(1_000_000)
    for (const name of ["custom", "read"]) {
        for (const path of [undefined, 7]) {
            let reads = 0
            let suffixReads = 0
            const input = {
                ...(path === undefined ? {} : { path }),
                get body() { reads++; return body },
                get later() { suffixReads++; throw new Error("Undisplayed input was read") },
            }
            const prefix = path === undefined ? '{"body":"' : '{"path":7,"body":"'
            expect(activity(name, input))
                .toBe(`${name === "read" ? "Read" : name} [${prefix}${"x".repeat(93 - prefix.length)}...]`)
            expect({ reads, suffixReads }).toEqual({ reads: 1, suffixReads: 0 })
        }
    }
})

test("bounds array entry reads independently of the undisplayed length", () => {
    const counts: number[] = []
    for (const size of [1_000, 1_000_000]) {
        let reads = 0
        const values = new Proxy(new Array<unknown>(size), {
            get(target, key, receiver) {
                if (typeof key === "string" && /^\d+$/.test(key)) {
                    reads++
                    if (reads > 48) throw new Error("Walked past the display budget")
                    return 0
                }
                return Reflect.get(target, key, receiver)
            },
        })
        expect(activity("custom", { values }))
            .toBe(`custom [${'{"values":['.concat("0,".repeat(48)).slice(0, 93)}...]`)
        expect(reads).toBeGreaterThan(0)
        expect(reads).toBeLessThanOrEqual(48)
        counts.push(reads)
    }
    expect(counts[0]).toBe(counts[1])
})

test("bounds huge keys and deeply nested arrays before reading their values", () => {
    let suffixReads = 0
    const leaf = { get later() { suffixReads++; throw new Error("Deep suffix was read") } }
    expect(activity("custom", { ["\u{1F600}".repeat(10_000)]: leaf }))
        .toBe(`custom [{"${"\u{1F600}".repeat(91)}...]`)
    let nested: unknown = leaf
    for (let index = 0; index < 10_000; index++) nested = [nested]
    expect(activity("custom", { nested }))
        .toBe(`custom [${'{"nested":'.concat("[".repeat(96)).slice(0, 93)}...]`)
    expect(suffixReads).toBe(0)
})

test("caps omitted-field reads even when they produce no display characters", () => {
    let reads = 0
    const input = new Proxy(Object.fromEntries(
        Array.from({ length: 1_000 }, (_, index) => [`k${index}`, undefined]),
    ), {
        get(target, key, receiver) {
            if (typeof key === "string" && key.startsWith("k")) reads++
            return Reflect.get(target, key, receiver)
        },
    })
    expect(activity("custom", input)).toBe("custom [[unserializable]]")
    expect(reads).toBe(97)
})

test("uses a fixed fallback for malformed non-JSON data without invoking conversion hooks", () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    let hooks = 0
    const withHook = {
        value: 1,
        toJSON() { hooks++; throw new Error("Conversion hook was called") },
    }
    expect(activity("custom", withHook)).toBe('custom [{"value":1}]')
    expect(hooks).toBe(0)
    for (const value of [cyclic, { value: 1n }, { value: new Date(0) }, {
        get value() { throw new Error("Malformed input") },
    }]) {
        expect(activity("custom", value)).toBe("custom [[unserializable]]")
        expect(activity("edit", { path: "p", edits: value }))
            .toBe("Edit [p] edits=[unserializable]")
    }
})

test("keeps huge malformed JSON-looking string arguments as escaped text", () => {
    const prefix = '{"oldText":"'
    const raw = `${prefix}${'"\r\n\t'.repeat(100_000)}`
    const expected = shippedTarget(`${prefix}${'"\r\n\t'.repeat(100)}`)
    expect(activity("edit", { path: "p", edits: raw })).toBe(`Edit [p] edits=${expected}`)
    expect(activity("bash", { command: raw })).toBe(`Bash [${expected}]`)
    expect(activity("custom", { arguments: raw })).toBe(
        `custom [${shippedTarget(JSON.stringify({ arguments: `${prefix}${'"\r\n\t'.repeat(100)}` }))}]`,
    )
})

test("does not cache mutable input identities or inspect hidden write content", () => {
    const input = { path: "p", edits: [{ oldText: "before", newText: "after" }] }
    expect(activity("edit", input)).toBe('Edit [p] edits=[{"oldText":"before","newText":"after"}]')
    input.path = "changed"
    input.edits[0]!.newText = "updated"
    expect(activity("edit", input)).toBe('Edit [changed] edits=[{"oldText":"before","newText":"updated"}]')
    let reads = 0
    expect(activity("write", {
        path: "p".repeat(1_000_000),
        get content() { reads++; throw new Error("Write content is not displayed") },
    })).toBe(`Write [${"p".repeat(93)}...]`)
    expect(reads).toBe(0)
})
