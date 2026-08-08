// AbortSignal and AbortController are built-in JavaScript APIs for requesting cancellation of asynchronous work.
// Basic Idea
//
// Think of them as a fire alarm:
// AbortController = button that activates the alarm
// AbortSignal     = alarm observed by workers
//
// You create them together:
//
// const controller = new AbortController()
// const signal = controller.signal
//
// Code doing work receives only the signal:
// doSomeWork({ signal })
//
// The owner can request cancellation:
// controller.abort()
//
// Why Two Objects?
// The separation controls who can cancel the operation.
// AbortController can trigger cancellation:
// controller.abort()
// AbortSignal can only observe cancellation:
//
// signal.aborted
// signal.reason
// signal.throwIfAborted()
//
// A child service receiving the signal cannot accidentally
// cancel the entire application because this does not exist:
// signal.abort() // invalid
//
// Simple Example
// const controller = new AbortController()
//
// const task = fetch("https://example.com", {
//   signal: controller.signal,
// })
//
// // Request cancellation.
// controller.abort()
//
// await task // rejects, usually with an AbortError
//
// Before abort():
// controller.signal.aborted // false
//
// After abort():
// controller.signal.aborted // true
//
// A signal is one-use. Once aborted, it remains aborted forever.
// To start unrelated cancellable work, create a new controller.
//
// Observing Cancellation
// Code can check the signal manually:
//
// if (signal.aborted) {
//   return
// }
//
// It can throw when cancellation was requested:
// signal.throwIfAborted()
//
// Or listen for the event:
// signal.addEventListener(
//   "abort",
//   () => {
//     console.log("Cancellation requested")
//   },
//   { once: true },
// )
// Cancellation Is Cooperative
//
// Calling:
// controller.abort()
// does not forcibly terminate arbitrary JavaScript.
// It sends a cancellation request. The operation must support the signal:
//
// async function doWork(signal: AbortSignal) {
//   signal.throwIfAborted()
//
//   await somethingAsync()
//
//   signal.throwIfAborted()
// }
//
// If somethingAsync() completely ignores the signal, it may continue running.
// Promises themselves are not cancellable:
//
// const promise = doSomething()
//
// A signal is a separate mechanism used by the work represented by the Promise:
// const promise = doSomething({ signal })
//
export class Lifetime {
  // # private fields and methods  in javascript
  // enforces privacy at runtime
  // typescript private is only enforced by type checker
  // object.#propery - runtime error
  // # also works with methods

  // AbortController, AbortSignal - builtin javascript apis for requestion
  // cancellation of asynchronous work
  // AbortController -
  readonly #controller = new AbortController()


  get signal(): AbortSignal {
    return this.#controller.signal
  }
}
