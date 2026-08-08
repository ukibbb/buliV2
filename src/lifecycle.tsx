// A Promise is an object representing a value that may become available later.
// Think of it as a receipt:
// You order food -> receive a receipt -> food arrives later
//
// In this application:
//
// runtimeTask  = receipt for application startup
// shutdownTask = receipt for application shutdown
//
// Promise States
//
// Every Promise has one of three states:
// pending	Operation is still running
// fulfilled	Operation succeeded
// rejected	Operation fail
//
//A Promise can settle only once:
//
// pending -> fulfilled
// or:
// pending -> rejected
//
// It cannot return to pending or change its final result.
// Basic Example
//
// const task = new Promise<number>((resolve, reject) => {
//   setTimeout(() => {
//     resolve(42)
//   }, 1_000)
// })
//
// Initially:
// task = pending
//
// After one second:
// task = fulfilled with 42
//
// You can wait for it using await:
// const result = await task
// console.log(result) // 42
//
// Or register a callback using .then():
// task.then((result) => {
//   console.log(result) // 42
// })
//
// Promises Are Not Values
//
// This:
// const runtimeTask = createApplication()
// does not mean runtimeTask is the application runtime.
//
// It means:
// runtimeTask is a Promise that may eventually provide a runtime
//
// To get the actual runtime:
// const runtime = await runtimeTask
//
//
// Types describe this difference:
// runtimeTask: Promise<ApplicationHandle>
// runtime: ApplicationHandle
//
// async Functions
//
// createApplication is an async function:
// export async function createApplication(
//   options: ApplicationOptions = {},
// ): Promise<ApplicationRuntime> {
//   // ...
//   return runtime
// }
//
// Every async function automatically returns a Promise.
// This:
// async function getNumber() {
//   return 42
// }
// is used like:
// const task = getNumber() // Promise<number>
// const number = await task // number
//
// Returning a value fulfills the Promise:
// return runtime
//
// Throwing an error rejects it:
// throw error
//
// Promises Do Not Block The Program
// When this runs:
// runtimeTask = createApplication(...)
//
// JavaScript does not freeze until startup completes.
// Instead:
// 1. createApplication() starts
// 2. It returns a pending Promise
// 3. React displays StartupView
// 4. Startup continues
// 5. Promise eventually succeeds or fails
//
// A Promise does not necessarily create a new thread.
// It represents asynchronous work.
// When the work finishes, JavaScript schedules the registered
// Promise callbacks to run.
//
// How runtimeTask Works
// The runtime Promise is created in src/index.tsx:
//
// runtimeTask = createApplication({
//   signal: lifetime.signal,
// })
//
// Its type is:
// Promise<ApplicationHandle>
//
// The possible outcomes are:
// createApplication succeeds
//         |
//         v
// runtimeTask fulfills with ApplicationHandle
// or:
// createApplication fails
//         |
//         v
// runtimeTask rejects with an error
//
// The Promise is immediately passed to React:
// <ApplicationLifecycle
//   runtimeTask={runtimeTask}
//   onStartupError={onStartupError}
//   onExit={onExit}
// />
// The component does not receive a finished runtime yet.
// It receives the Promise representing its future result.
//
// Handling runtimeTask With .then()
//
// Inside ApplicationLifecycle:
//
// void props.runtimeTask.then(
//   (runtime) => {
//     if (mounted) setState({ type: "ready", runtime })
//   },
//   (error: unknown) => {
//     if (!mounted) return
//     props.onStartupError(error)
//     setState({ type: "error", error })
//   },
// )
//
// .then() accepts two callbacks:
// promise.then(onSuccess, onFailure)
//
// The first callback runs when the Promise fulfills:
// (runtime) => {
//   setState({ type: "ready", runtime })
// }
// The second runs when it rejects:
// (error) => {
//   setState({ type: "error", error })
// }
//
// While the Promise remains pending, neither callback runs.
//
// The timeline is:
// ApplicationLifecycle renders
//         |
// state = startup
//         |
// StartupView appears
//         |
// runtimeTask settles
//         |
//         +-> success -> state = ready -> App appears
//         |
//         +-> failure -> state = error -> StartupError appears
//
// What void Means
// The code uses:
// void props.runtimeTask.then(...)
// .then() returns another Promise, \
// but this code does not need to store or await it.
//
// void communicates:
// Start this Promise chain intentionally,
// but do not wait for its resulting value here.
//
// It does not cancel or stop the Promise.
// One Promise Can Have Multiple Listeners
//
// index.tsx also contains:
// void runtimeTask.catch(() => undefined)
//
// At the same time, ApplicationLifecycle uses:
// runtimeTask.then(onSuccess, onFailure)
//
// That is allowed. Multiple parts of the program can observe the same Promise:
// task.then(firstListener)
// task.then(secondListener)
// task.catch(errorListener)
//
// All appropriate listeners are notified when the Promise settles.
// Calling .catch() does not change the original Promise.
// It creates a new derived Promise.
//
// How .catch() Works
//
// This:
// promise.catch(handleError)
//
// is approximately:
// promise.then(undefined, handleError)
//
// For runtimeTask:
// void runtimeTask.catch(() => undefined)
//
// This prevents the runtime from being considered an unhandled rejection.
// The original runtimeTask remains rejected,
// so ApplicationLifecycle can still receive its error.
// Waiting For Runtime During Cleanup
//
// The lifetime cleanup contains:
// const active = await runtimeTask?.catch(() => undefined)
// await active?.dispose()
//
// Consider each outcome.
//
// If startup succeeded:
// const active = await runtimeTask
//// active is ApplicationHandle
// await active.dispose()
//
// If startup failed:
// runtimeTask.catch(() => undefined)
//// produces undefined
//
// const active = undefined
// Therefore this does nothing:
// await active?.dispose()
//
// If startup is still pending, await pauses this cleanup function
// until the Promise settles.
// Importantly, await pauses only the current async function.
// It does not freeze the entire JavaScript program.
// Promises Are Not Automatically Cancellable
//
// This Promise handler cannot be removed:
// runtimeTask.then(...)
// That is why ApplicationLifecycle uses:
// let mounted = true
//
// When the component is removed:
// return () => {
//   mounted = false
// }
// The Promise may still settle, but its callback ignores the result:
// if (mounted) {
//   setState(...)
// }
// Actual startup cancellation is handled separately with an AbortSignal:
// createApplication({
//   signal: lifetime.signal,
// })
// The Promise represents the result. The AbortSignal requests cancellation of the underlying work.
// How shutdownTask Works
// Initially:
// let shutdownTask: Promise<void> | undefined
// It is undefined because shutdown has not started.
// The first call to shutdown() creates it:
// shutdownTask = lifetime.close().catch((error: unknown) => {
//   shutdownFailure ??= error
// })
// lifetime.close() starts cleanup and returns:
// Promise<void>
// void means successful completion has no result value:
// await shutdownTask
// // Cleanup finished, but there is no value to receive.
//
// Why Save shutdownTask?
// Suppose several places request shutdown:
// shutdown()
// shutdown()
// shutdown()
//
// The first call creates the Promise:
// shutdownTask = lifetime.close(...)
// Later calls find the existing Promise:
// if (shutdownTask) return shutdownTask
// Therefore:
// const first = shutdown()
// const second = shutdown()
//
// first === second // true
// Both callers are observing the same cleanup operation.
// Without the saved Promise, every call could attempt to clean everything up again.
// How Shutdown Errors Work
// The important expression is:
// shutdownTask = lifetime.close().catch((error: unknown) => {
//   shutdownFailure ??= error
// })
// .catch() returns a new Promise.
// If lifetime.close() succeeds:
// close Promise fulfills
//         |
//         v
// shutdownTask fulfills
// If lifetime.close() fails:
// close Promise rejects
//         |
//         v
// catch callback records error
//         |
// callback returns undefined
//         |
//         v
// shutdownTask fulfills with no value
// Because the catch callback does not throw again, the resulting shutdownTask is fulfilled.
// The failure is saved separately:
// shutdownFailure ??= error
// It is reported later:
// if (shutdownFailure) {
//   process.exitCode = 1
//   process.stderr.write(...)
// }
// Fire-And-Forget vs Waiting
// Some code starts shutdown without waiting:
// const onExit = () => {
//   void shutdown()
// }
// This means:
// Start shutdown, but this callback does not need to wait for completion.
// The finally block does wait:
// await shutdown(false)
// This means:
// Do not let main() finish until shutdown is complete.
// Both calls receive the same shutdownTask, so they do not create separate shutdown operations.
// Complete Timeline
// main() starts
//     |
//     v
// runtimeTask = createApplication()
//     |
//     | Promise pending
//     v
// StartupView displayed
//     |
//     +-> runtimeTask fulfills
//     |       |
//     |       v
//     |   App displayed
//     |
//     +-> runtimeTask rejects
//             |
//             v
//         StartupError displayed
//
// Later, exit is requested
//     |
//     v
// shutdownTask = lifetime.close()
//     |
//     | Promise pending
//     v
// resources are cleaned up
//     |
//     +-> success -> shutdownTask fulfills
//     |
//     +-> failure -> error recorded -> shutdownTask fulfills
//
// main() awaits shutdownTask
//     |
//     v
// program finishes
// The key idea is:
// A Promise is not the operation's final value.
// It is an object through which you observe the operation's future completion.
//

import type { IBuliApplicationRuntime } from "@/runtime";
import { BuliRuntimeProvider } from "@/application-state";
import { useState, useEffect } from "react";
import { BuliTui } from "@/tui/Buli";

type TBuliLifecycleState =
  | { type: "startup" }
  | { type: "ready", runtime: IBuliApplicationRuntime }
  | { type: "error", error: unknown }

type TBuliLifecycleStateType = TBuliLifecycleState["type"]

type TBuliLifecycleStateEnum = {
  [K in TBuliLifecycleStateType]: K
}

const BuliLifeCycleState: TBuliLifecycleStateEnum = {
  startup: "startup",
  error: "error",
  ready: "ready"
}


// Decides which terminal screen to show while the application starts and run
interface IBuliApplicationLifecycleProps {
  runtimeTask: Promise<IBuliApplicationRuntime>
  onStartupError: (error: unknown) => void
  onExit: () => void
}

export function BuliApplicationLifcycle(props: IBuliApplicationLifecycleProps) {
  const [state, setState] = useState<TBuliLifecycleState>({ type: "startup" })

  useEffect(() => {
    let mounted = true
    void props.runtimeTask.then(
      (runtime: IBuliApplicationRuntime) => {
        if (mounted) setState({ type: "ready", runtime })
      },
      (error: unknown) => {
        if (!mounted) return
        props.onStartupError(error)
        setState({ type: "error", error })
      }
    )

    return () => { mounted = false }

  }, [props.runtimeTask, props.onStartupError])

  if (state.type === BuliLifeCycleState.startup) return
  if (state.type === BuliLifeCycleState.error) return

  return <BuliRuntimeProvider runtime={state.runtime}><BuliTui /></BuliRuntimeProvider>

}
