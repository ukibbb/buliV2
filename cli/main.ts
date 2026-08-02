#!/usr/bin/env bun

import yargs from "yargs";
import { hideBin } from "yargs/helpers";

import { RunBuliTuiCommand } from "./cmd/tui";

// Node/Bun starts process.argv as [runtimePath, scriptPath, ...userArgs].
// hideBin removes runtimePath and scriptPath so yargs only sees what the user typed.
const args: string[] = hideBin(process.argv);

// Create the yargs CLI builder
const cli = yargs(args)
  // Set the command name
  .scriptName("buli")
  // Keep help text readable by wrapping long lines at 100 characters.
  .wrap(100)
  // Register --help and describe what it does in the help output.
  .help("help", "show help")
  // Allow -h as the short version of --help.
  .alias("help", "h")
  // Keep the top usage line minimal until buli has real subcommands.
  .usage("")
  // Add a built-in completion command for future shell completion scripts.
  .completion("completion", "generate shell completion script")
  // Register the default TUI command so bare `buli` can start the terminal UI.
  // We intentionally do not register an explicit `buli tui` subcommand yet.
  .command(RunBuliTuiCommand)
  .fail((message, error) => {
    if (args[0] === "tui") {
      throw new Error("`buli tui` is not a supported command yet");
    }

    throw error ?? new Error(message);
  })
  // Reject unknown flags/commands so user mistakes fail clearly.
  .strict();

try {
  // Parse the arguments and let yargs handle help, validation, and future commands.
  await cli.parse();
} catch (error) {
  // Print a simple error message for now; richer UI formatting can come later.
  console.error(error instanceof Error ? error.message : String(error));

  // Mark the process as failed without forcefully exiting before async cleanup can run.
  process.exitCode = 1;
}
