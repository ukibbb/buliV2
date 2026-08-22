import { expect, test } from "bun:test"
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { runRipgrep } from "@/tools/search/ripgrep"

if (process.platform !== "win32") {
  test("ripgrep timeout kills an uncooperative descendant process group", async () => {
    const directory = await mkdtemp(join(tmpdir(), "buli-ripgrep-timeout-"))
    const executable = join(directory, "rg")
    const marker = join(directory, "descendant-finished")
    try {
      await writeFile(executable, [
        "#!/bin/sh",
        "trap '' TERM",
        "(",
        "  trap '' TERM",
        "  sleep 0.4",
        "  : > \"$1\"",
        ") &",
        "while :; do sleep 1; done",
        "",
      ].join("\n"))
      await chmod(executable, 0o755)

      await expect(runRipgrep({
        executable,
        args: [marker],
        cwd: directory,
        signal: new AbortController().signal,
        timeoutMs: 50,
        delimiter: 10,
        onRecord: () => {},
      })).rejects.toThrow("ripgrep timed out after 50 ms")

      await Bun.sleep(500)
      await expect(Bun.file(marker).exists()).resolves.toBe(false)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("ripgrep abort preserves the AbortSignal reason", async () => {
    const directory = await mkdtemp(join(tmpdir(), "buli-ripgrep-abort-"))
    const executable = join(directory, "rg")
    try {
      await writeFile(executable, [
        "#!/bin/sh",
        "trap '' TERM",
        "while :; do sleep 1; done",
        "",
      ].join("\n"))
      await chmod(executable, 0o755)
      const controller = new AbortController()
      const reason = new DOMException("Stopped by ripgrep test", "AbortError")
      const execution = runRipgrep({
        executable,
        args: [],
        cwd: directory,
        signal: controller.signal,
        timeoutMs: 5_000,
        delimiter: 10,
        onRecord: () => {},
      })

      controller.abort(reason)
      try {
        await execution
        throw new Error("Expected ripgrep to abort")
      } catch (error) {
        expect(error).toBe(reason)
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("ripgrep early stop terminates an uncooperative process", async () => {
    const directory = await mkdtemp(join(tmpdir(), "buli-ripgrep-stop-"))
    const executable = join(directory, "rg")
    try {
      await writeFile(executable, [
        "#!/bin/sh",
        "trap '' TERM",
        "printf 'first\\n'",
        "while :; do sleep 1; done",
        "",
      ].join("\n"))
      await chmod(executable, 0o755)
      const records: string[] = []

      const result = await runRipgrep({
        executable,
        args: [],
        cwd: directory,
        signal: new AbortController().signal,
        timeoutMs: 5_000,
        delimiter: 10,
        onRecord: (record, stop) => {
          records.push(record)
          stop()
        },
      })

      expect(records).toEqual(["first"])
      expect(result.stoppedEarly).toBe(true)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("ripgrep does not inherit dynamic-loader injection variables", async () => {
    const directory = await mkdtemp(join(tmpdir(), "buli-ripgrep-environment-"))
    const executable = join(directory, "rg")
    const previousLdPreload = process.env.LD_PRELOAD
    try {
      await writeFile(executable, [
        "#!/bin/sh",
        "printf '%s\\n' \"${LD_PRELOAD-unset}\"",
        "",
      ].join("\n"))
      await chmod(executable, 0o755)
      process.env.LD_PRELOAD = "/unapproved/library.so"
      const records: string[] = []

      const result = await runRipgrep({
        executable,
        args: [],
        cwd: directory,
        signal: new AbortController().signal,
        timeoutMs: 1_000,
        delimiter: 10,
        onRecord: (record) => records.push(record),
      })

      expect(result.exitCode).toBe(0)
      expect(records).toEqual(["unset"])
    } finally {
      if (previousLdPreload === undefined) delete process.env.LD_PRELOAD
      else process.env.LD_PRELOAD = previousLdPreload
      await rm(directory, { recursive: true, force: true })
    }
  })
}
