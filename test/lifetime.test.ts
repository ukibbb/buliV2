import { expect, test } from "bun:test"

import { Lifetime } from "@/lifetime"

test("close is idempotent and aborts with the first reason", async () => {
  const lifetime = new Lifetime()
  const reason = new Error("shutdown requested")
  let abortCount = 0
  lifetime.signal.addEventListener("abort", () => {
    abortCount += 1
  })

  const firstClose = lifetime.close(reason)
  const secondClose = lifetime.close(new Error("ignored"))

  expect(secondClose).toBe(firstClose)
  await firstClose
  await lifetime.waitForClose()
  expect(lifetime.signal.aborted).toBe(true)
  expect(lifetime.signal.reason).toBe(reason)
  expect(abortCount).toBe(1)
})

test("runs cleanups once in reverse registration order", async () => {
  const lifetime = new Lifetime()
  const calls: string[] = []
  lifetime.addCleanup(() => {
    calls.push("first")
  })
  lifetime.addCleanup(async () => {
    calls.push("second:start")
    await Promise.resolve()
    calls.push("second:end")
  })
  lifetime.addCleanup(() => {
    calls.push("third")
  })

  await Promise.all([
    lifetime.close(),
    lifetime.close(),
    lifetime.waitForClose(),
  ])

  expect(calls).toEqual(["third", "second:start", "second:end", "first"])
})

test("aggregates cleanup failures after attempting every cleanup", async () => {
  const lifetime = new Lifetime()
  const firstFailure = new Error("first cleanup failed")
  const secondFailure = new Error("second cleanup failed")
  const calls: string[] = []
  lifetime.addCleanup(() => {
    calls.push("first")
    throw firstFailure
  })
  lifetime.addCleanup(() => {
    calls.push("middle")
  })
  lifetime.addCleanup(() => {
    calls.push("last")
    throw secondFailure
  })

  const failure = await lifetime.close().catch((error: unknown) => error)

  expect(failure).toBeInstanceOf(AggregateError)
  expect((failure as AggregateError).message).toBe("Buli shutdown failed")
  expect((failure as AggregateError).errors).toEqual([
    secondFailure,
    firstFailure,
  ])
  expect(calls).toEqual(["last", "middle", "first"])
})

test("is reentrant when an abort listener requests shutdown again", async () => {
  const lifetime = new Lifetime()
  const cleanup = Promise.withResolvers<void>()
  let cleanupCount = 0
  lifetime.addCleanup(async () => {
    cleanupCount += 1
    await cleanup.promise
  })

  let nestedClose: Promise<void> | undefined
  lifetime.signal.addEventListener("abort", () => {
    nestedClose = lifetime.close()
  })

  const outerClose = lifetime.close()
  expect(nestedClose).toBe(outerClose)
  expect(cleanupCount).toBe(1)

  cleanup.resolve()
  await outerClose
})

test("does not deadlock when an async cleanup requests shutdown", async () => {
  const lifetime = new Lifetime()
  let cleanupFinished = false
  lifetime.addCleanup(async () => {
    await Promise.resolve()
    await lifetime.close()
    cleanupFinished = true
  })

  await lifetime.close()

  expect(cleanupFinished).toBe(true)
})

test("does not deadlock when a cleanup waits for shutdown", async () => {
  const lifetime = new Lifetime()
  let cleanupFinished = false
  lifetime.addCleanup(async () => {
    await Promise.resolve()
    await lifetime.waitForClose()
    cleanupFinished = true
  })

  await lifetime.close()

  expect(cleanupFinished).toBe(true)
})

test("unregisters a cleanup before shutdown and remains idempotent", async () => {
  const lifetime = new Lifetime()
  let cleanupCount = 0
  const unregister = lifetime.addCleanup(() => {
    cleanupCount += 1
  })

  unregister()
  unregister()
  await lifetime.close()

  expect(cleanupCount).toBe(0)
})

test("rejects cleanup registration after shutdown starts", async () => {
  const lifetime = new Lifetime()
  const cleanup = Promise.withResolvers<void>()
  lifetime.addCleanup(() => cleanup.promise)

  const closing = lifetime.close()
  expect(() => lifetime.addCleanup(() => {})).toThrow(
    "Cannot register cleanup after shutdown has started",
  )

  cleanup.resolve()
  await closing
})

test("waitForClose waits when called before shutdown and through cleanup", async () => {
  const lifetime = new Lifetime()
  const cleanup = Promise.withResolvers<void>()
  lifetime.addCleanup(() => cleanup.promise)
  let waitFinished = false
  const waiting = lifetime.waitForClose().then(() => {
    waitFinished = true
  })

  await Promise.resolve()
  expect(waitFinished).toBe(false)

  const closing = lifetime.close()
  await Promise.resolve()
  expect(waitFinished).toBe(false)

  cleanup.resolve()
  await Promise.all([closing, waiting])
  expect(waitFinished).toBe(true)
})

test("uses a descriptive default shutdown reason", async () => {
  const lifetime = new Lifetime()

  await lifetime.close()

  expect(lifetime.signal.reason).toEqual(new Error("Buli is shutting down"))
})
