import { expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  ProcessSideEffectsUnknownAfterAbortError,
  ProcessSideEffectsUnknownError,
  PROCESS_INTERPRETER_DISPLAY,
  PROCESS_PROGRESS_EVENT_LIMIT,
  PROCESS_TIMEOUT_EXIT_CODE,
  runShellProcess,
} from "@/tools/command/process-runner"
import type {
  IProcessProgress,
  IProcessRunnerOptions,
} from "@/tools/command/process-runner"

const DEFAULT_OUTPUT_LIMITS = {
  stdoutBytes: 64 * 1024,
  stderrBytes: 64 * 1024,
  progressTailBytes: 1024,
} as const
const BASH_EXECUTION_AVAILABLE = process.platform !== "win32"

test("exposes the fixed Bash interpreter display", () => {
  expect(PROCESS_INTERPRETER_DISPLAY).toBe(
    process.platform === "win32"
      ? "Bash unavailable on Windows in v1"
      : "/bin/bash --noprofile --norc -c",
  )
})

test.skipIf(!BASH_EXECUTION_AVAILABLE)(
  "uses Bash instead of the configured SHELL",
  async () => {
    const previousShell = process.env.SHELL
    process.env.SHELL = "/definitely/not/the/selected/shell"
    try {
      const result = await run(
        '[[ -n "$BASH_VERSION" ]] && printf "fixed-bash"',
      )

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe("fixed-bash")
      expect(result.stderr).toBe("")
    } finally {
      if (previousShell === undefined) delete process.env.SHELL
      else process.env.SHELL = previousShell
    }
  },
)

test.skipIf(process.platform === "win32")(
  "passes the fixed non-profile arguments to /bin/bash",
  async () => {
    const result = await run('ps -p "$$" -o command=; :')

    expect(result.exitCode).toBe(0)
    expect(result.stdout.trimStart()).toStartWith(PROCESS_INTERPRETER_DISPLAY)
  },
)

test.skipIf(
  process.platform !== "win32",
)("fails clearly when Windows Bash is unavailable", async () => {
  await expect(run("printf unreachable")).rejects.toThrow("unavailable on Windows")
})

test.skipIf(!BASH_EXECUTION_AVAILABLE)(
  "captures stdout from an exact shell command",
  async () => {
    const result = await run('printf "hello runner"')

    expect(result).toMatchObject({
      exitCode: 0,
      stdout: "hello runner",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      stdoutInvalidUtf8: false,
      stderrInvalidUtf8: false,
      timedOut: false,
    })
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  },
)

test.skipIf(!BASH_EXECUTION_AVAILABLE)(
  "runs without a timeout when timeoutMs is omitted",
  async () => {
    const result = await runShellProcess({
      command: 'printf "no timeout"',
      cwd: process.cwd(),
      signal: new AbortController().signal,
      outputLimits: DEFAULT_OUTPUT_LIMITS,
    })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe("no timeout")
    expect(result.timedOut).toBe(false)
  },
)

test.skipIf(!BASH_EXECUTION_AVAILABLE)(
  "accepts a positive fractional timeout",
  async () => {
    const result = await run('printf "fractional timeout"', {
      timeoutMs: 1_000.5,
    })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe("fractional timeout")
    expect(result.timedOut).toBe(false)
  },
)

test.skipIf(!BASH_EXECUTION_AVAILABLE)(
  "marks complete output that is not valid UTF-8",
  async () => {
    const result = await run("printf '\\377'")

    expect(result.stdout).toBe("�")
    expect(result.stdoutTruncated).toBe(false)
    expect(result.stdoutInvalidUtf8).toBe(true)
    expect(result.stderrInvalidUtf8).toBe(false)
  },
)

test.skipIf(!BASH_EXECUTION_AVAILABLE)(
  "returns stderr and a nonzero exit code without throwing",
  async () => {
    const result = await run('printf "expected failure" >&2; exit 7')

    expect(result.exitCode).toBe(7)
    expect(result.stdout).toBe("")
    expect(result.stderr).toBe("expected failure")
    expect(result.timedOut).toBe(false)
  },
)

test.skipIf(!BASH_EXECUTION_AVAILABLE)(
  "runs in the requested existing directory",
  async () => {
    const workspace = await temporaryDirectory()
    try {
      const result = await run('pwd -P | tr -d "\\n"', { cwd: workspace })

      expect(await realpath(result.stdout)).toBe(await realpath(workspace))
    } finally {
      await removeDirectory(workspace)
    }
  },
)

test.skipIf(!BASH_EXECUTION_AVAILABLE)(
  "times out only after terminating a descendant process tree",
  async () => {
    const workspace = await temporaryDirectory()
    const markerName = "timeout-descendant.txt"
    const marker = join(workspace, markerName)
    try {
      const result = await run(descendantMarkerCommand(markerName), {
        cwd: workspace,
        timeoutMs: 500,
      })

      expect(result.exitCode).toBe(PROCESS_TIMEOUT_EXIT_CODE)
      expect(result.timedOut).toBe(true)
      expect(result.stdout).toContain("descendant-ready")
      expect(result.cleanupWarning).toBeUndefined()
      await Bun.sleep(1_200)
      expect(await pathExists(marker)).toBe(false)
    } finally {
      await removeDirectory(workspace)
    }
  },
)

test.skipIf(!BASH_EXECUTION_AVAILABLE)(
  "terminates same-group background descendants before reporting success",
  async () => {
    const workspace = await temporaryDirectory()
    const markerName = "background-descendant.txt"
    const marker = join(workspace, markerName)
    try {
      const result = await run(
        `( sleep 1; printf survived > ${quoteBashArgument(markerName)} ) </dev/null >/dev/null 2>&1 &`,
        { cwd: workspace, timeoutMs: 3_000 },
      )

      expect(result.exitCode).toBe(0)
      expect(result.cleanupWarning).toBeUndefined()
      await Bun.sleep(1_200)
      expect(await pathExists(marker)).toBe(false)
    } finally {
      await removeDirectory(workspace)
    }
  },
)

test.skipIf(!BASH_EXECUTION_AVAILABLE)(
  "throws the exact reason when already aborted",
  async () => {
    const controller = new AbortController()
    const reason = new Error("already stopped")
    controller.abort(reason)

    await expect(run(
      'printf "not run"',
      { signal: controller.signal },
    )).rejects.toBe(reason)
  },
)

test.skipIf(!BASH_EXECUTION_AVAILABLE)(
  "marks side effects unknown after aborting a started process",
  async () => {
    const workspace = await temporaryDirectory()
    const markerName = "abort-descendant.txt"
    const marker = join(workspace, markerName)
    const controller = new AbortController()
    const reason = new Error("stop running process")
    let sawReady = false
    try {
      const failure = await run(descendantMarkerCommand(markerName), {
        cwd: workspace,
        signal: controller.signal,
        timeoutMs: 3_000,
        onProgress: (progress) => {
          if (
            progress.stream !== "stdout"
            || !progress.tail.includes("descendant-ready")
          ) {
            return
          }
          sawReady = true
          controller.abort(reason)
        },
      }).then(
        () => undefined,
        (error: unknown) => error,
      )
      expect(failure).toBeInstanceOf(ProcessSideEffectsUnknownAfterAbortError)
      expect(failure).toMatchObject({
        sideEffectsUnknown: true,
        cause: reason,
      })
      expect(sawReady).toBe(true)
      await Bun.sleep(1_200)
      expect(await pathExists(marker)).toBe(false)
    } finally {
      await removeDirectory(workspace)
    }
  },
)

test.skipIf(!BASH_EXECUTION_AVAILABLE)(
  "bounds UTF-8 output and total progress emissions",
  async () => {
    const progress: IProcessProgress[] = []
    const limits = {
      stdoutBytes: 101,
      stderrBytes: 101,
      progressTailBytes: 17,
    }
    const result = await run(bunCommand(
      "for(let i=0;i<160;i++){"
        + 'process.stdout.write("🙂".repeat(256));'
        + 'process.stderr.write("é".repeat(512));'
        + "await Bun.sleep(2)"
        + "}"
        + 'process.stdout.write("stdout-end");'
        + 'process.stderr.write("stderr-end")',
    ), {
      timeoutMs: 3_000,
      outputLimits: limits,
      onProgress: (event) => progress.push(event),
    })

    expect(result.stdoutTruncated).toBe(true)
    expect(result.stderrTruncated).toBe(true)
    expect(result.stdout).toEndWith("... [stdout truncated]")
    expect(result.stderr).toEndWith("... [stderr truncated]")
    expect(result.stdout).not.toContain("�")
    expect(result.stderr).not.toContain("�")
    expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThanOrEqual(
      limits.stdoutBytes + Buffer.byteLength("\n... [stdout truncated]"),
    )
    expect(Buffer.byteLength(result.stderr, "utf8")).toBeLessThanOrEqual(
      limits.stderrBytes + Buffer.byteLength("\n... [stderr truncated]"),
    )
    expect(progress.length).toBeGreaterThan(0)
    expect(progress.length).toBeLessThanOrEqual(PROCESS_PROGRESS_EVENT_LIMIT)
    expect(progress.reduce(
      (bytes, event) => bytes + Buffer.byteLength(event.tail, "utf8"),
      0,
    )).toBeLessThanOrEqual(
      PROCESS_PROGRESS_EVENT_LIMIT * limits.progressTailBytes,
    )
    for (const event of progress) {
      expect(Buffer.byteLength(event.tail, "utf8")).toBeLessThanOrEqual(
        limits.progressTailBytes,
      )
      expect(event.tail).not.toContain("�")
    }
    expect(progress.some((event) => event.truncated)).toBe(true)
  },
)

test.skipIf(!BASH_EXECUTION_AVAILABLE)(
  "marks side effects unknown when process output handling fails after spawn",
  async () => {
    const failure = await run("printf started; sleep 1", {
      onProgress: () => {
        throw new Error("progress consumer failed")
      },
    }).then(
      () => undefined,
      (error: unknown) => error,
    )

    expect(failure).toBeInstanceOf(ProcessSideEffectsUnknownError)
    expect(failure).toMatchObject({ sideEffectsUnknown: true })
    expect(String(failure)).toContain("progress consumer failed")
  },
)

test.skipIf(!BASH_EXECUTION_AVAILABLE)(
  "does not persist shell cwd or environment changes between calls",
  async () => {
    const workspace = await temporaryDirectory()
    const nested = join(workspace, "nested")
    const environmentKey = `BULI_RUNNER_STATE_${process.pid}_${Date.now()}`
    try {
      await mkdir(nested)
      const inspectState = bunCommand(
        `process.stdout.write(JSON.stringify({cwd:process.cwd(),value:process.env[${JSON.stringify(environmentKey)}]??null}))`,
      )
      const mutateShell = `cd ${quoteBashArgument(toBashPath(nested))}`
        + ` && export ${environmentKey}=changed && ${inspectState}`

      const changed = JSON.parse((await run(mutateShell, { cwd: workspace })).stdout) as {
        readonly cwd: string
        readonly value: string | null
      }
      const fresh = JSON.parse((await run(inspectState, { cwd: workspace })).stdout) as {
        readonly cwd: string
        readonly value: string | null
      }

      expect(await realpath(changed.cwd)).toBe(await realpath(nested))
      expect(changed.value).toBe("changed")
      expect(await realpath(fresh.cwd)).toBe(await realpath(workspace))
      expect(fresh.value).toBeNull()
    } finally {
      await removeDirectory(workspace)
    }
  },
)

test.skipIf(!BASH_EXECUTION_AVAILABLE)(
  "does not execute inherited Bash startup files or imported functions",
  async () => {
    const workspace = await temporaryDirectory()
    const startup = join(workspace, "unapproved-startup.sh")
    const marker = join(workspace, "startup-ran.txt")
    const functionKey = "BASH_FUNC_buli_unapproved%%"
    const previousBashEnv = process.env.BASH_ENV
    const previousFunction = process.env[functionKey]
    const previousPs4 = process.env.PS4
    const previousLdPreload = process.env.LD_PRELOAD
    try {
      await writeFile(startup, `printf startup > ${quoteBashArgument(marker)}`)
      process.env.BASH_ENV = startup
      process.env[functionKey] = "() { printf imported; }"
      process.env.PS4 = `$(printf traced > ${quoteBashArgument(marker)})`
      process.env.LD_PRELOAD = "/unapproved/library.so"

      const result = await run(
        "set -x; if declare -F buli_unapproved >/dev/null; then buli_unapproved; else printf clean:${LD_PRELOAD-unset}; fi",
        { cwd: workspace },
      )

      expect(result.stdout).toBe("clean:unset")
      expect(await pathExists(marker)).toBe(false)
    } finally {
      if (previousBashEnv === undefined) delete process.env.BASH_ENV
      else process.env.BASH_ENV = previousBashEnv
      if (previousFunction === undefined) delete process.env[functionKey]
      else process.env[functionKey] = previousFunction
      if (previousPs4 === undefined) delete process.env.PS4
      else process.env.PS4 = previousPs4
      if (previousLdPreload === undefined) delete process.env.LD_PRELOAD
      else process.env.LD_PRELOAD = previousLdPreload
      await removeDirectory(workspace)
    }
  },
)

test("rejects invalid commands, cwd values, signals, timeouts, and limits", async () => {
  const workspace = await temporaryDirectory()
  const file = join(workspace, "file.txt")
  try {
    await writeFile(file, "not a directory")
    await expect(run("", { cwd: workspace })).rejects.toThrow("nonempty string")
    await expect(run("   ", { cwd: workspace })).rejects.toThrow("nonempty string")
    await expect(run("bad\0command", { cwd: workspace })).rejects.toThrow("NUL byte")
    await expect(run("exit 0", { cwd: join(workspace, "missing") })).rejects.toThrow(
      "cwd does not exist",
    )
    await expect(run("exit 0", { cwd: file })).rejects.toThrow("not a directory")
    await expect(runShellProcess({
      command: "exit 0",
      cwd: workspace,
      signal: null as unknown as AbortSignal,
      timeoutMs: 1,
      outputLimits: DEFAULT_OUTPUT_LIMITS,
    })).rejects.toThrow("signal must be an AbortSignal")
    await expect(run("exit 0", { cwd: workspace, timeoutMs: 0 })).rejects.toThrow(
      "timeoutMs must be a finite number greater than 0",
    )
    await expect(run("exit 0", { cwd: workspace, timeoutMs: Infinity })).rejects.toThrow(
      "timeoutMs must be a finite number greater than 0",
    )
    await expect(run("exit 0", {
      cwd: workspace,
      timeoutMs: 2_147_483_648,
    })).rejects.toThrow(
      "timeoutMs must be a finite number greater than 0 and at most 2147483647",
    )
    await expect(run("exit 0", {
      cwd: workspace,
      outputLimits: { ...DEFAULT_OUTPUT_LIMITS, stdoutBytes: -1 },
    })).rejects.toThrow("outputLimits.stdoutBytes must be an integer")
    await expect(run("exit 0", {
      cwd: workspace,
      outputLimits: { ...DEFAULT_OUTPUT_LIMITS, stderrBytes: 1.5 },
    })).rejects.toThrow("outputLimits.stderrBytes must be an integer")
    await expect(run("exit 0", {
      cwd: workspace,
      outputLimits: {
        ...DEFAULT_OUTPUT_LIMITS,
        progressTailBytes: Number.MAX_SAFE_INTEGER,
      },
    })).rejects.toThrow("outputLimits.progressTailBytes must be an integer")
  } finally {
    await removeDirectory(workspace)
  }
})

interface IRunOverrides {
  readonly cwd?: string
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
  readonly outputLimits?: IProcessRunnerOptions["outputLimits"]
  readonly onProgress?: IProcessRunnerOptions["onProgress"]
}

async function run(command: string, overrides: IRunOverrides = {}) {
  const options: IProcessRunnerOptions = {
    command,
    cwd: overrides.cwd ?? process.cwd(),
    signal: overrides.signal ?? new AbortController().signal,
    timeoutMs: overrides.timeoutMs ?? 2_000,
    outputLimits: overrides.outputLimits ?? DEFAULT_OUTPUT_LIMITS,
    ...(overrides.onProgress === undefined
      ? {}
      : { onProgress: overrides.onProgress }),
  }
  return await runShellProcess(options)
}

function descendantMarkerCommand(markerName: string): string {
  return `( trap '' TERM; printf 'descendant-ready\\n'; sleep 1; `
    + `printf survived > ${quoteBashArgument(markerName)} ) & wait`
}

function bunCommand(source: string): string {
  const encodedSource = Buffer.from(`(async()=>{${source}})()`, "utf8").toString("hex")
  const loader = `await eval(Buffer.from('${encodedSource}','hex').toString())`
  return `${quoteBashArgument(toBashPath(process.execPath))} -e ${quoteBashArgument(loader)}`
}

function quoteBashArgument(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function toBashPath(value: string): string {
  return process.platform === "win32" ? value.replaceAll("\\", "/") : value
}

async function temporaryDirectory(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "buli-process-runner-"))
}

async function removeDirectory(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true })
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false
    }
    throw error
  }
}
