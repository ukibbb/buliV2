import { expect, test } from "bun:test"

test("keeps TUI code behind application and domain contracts", async () => {
  const violations: string[] = []
  const files = new Bun.Glob("src/tui/**/*.{ts,tsx}")

  for await (const path of files.scan({ onlyFiles: true })) {
    const source = await Bun.file(path).text()

    if (/from\s+["']@\/(?:engine|providers)(?:\/|["'])/.test(source)) {
      violations.push(`${path}: concrete engine/provider import`)
    }

    if (/\bBuliApplicationRuntime\b/.test(source)) {
      violations.push(`${path}: concrete application runtime`)
    }
  }

  expect(violations).toEqual([])
})
