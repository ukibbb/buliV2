import { runMainTui } from "@/entrypoints/run-main-tui";
import type { CommandModule } from "yargs";

type RunBuliTuiArgs = {};

export const RunBuliTuiCommand: CommandModule<{}, RunBuliTuiArgs> = {
  command: "$0",
  // This text appears in `buli --help` so users can discover what the command does.
  describe: "start the Buli terminal user interface",
  handler: async () => {
    await runMainTui();
  },
};
