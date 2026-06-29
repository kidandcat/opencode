import { cmd } from "@/cli/cmd/cmd"
import { withNetworkOptions } from "@/cli/network"
import { runTuiThread } from "../tui/run-thread"

export const AgentsCommand = cmd({
  command: "agents [project]",
  describe: "open the agents fleet view to monitor and dispatch background sessions",
  builder: (yargs) =>
    withNetworkOptions(yargs)
      .positional("project", {
        type: "string",
        describe: "path to start opencode in",
      })
      .option("model", {
        type: "string",
        alias: ["m"],
        describe: "model to use in the format of provider/model",
      })
      .option("agent", {
        type: "string",
        describe: "agent to use for new sessions dispatched from the fleet",
      })
      .option("prompt", {
        type: "string",
        describe: "initial prompt to dispatch as a new session on launch",
      }),
  handler: async (args) => {
    await runTuiThread(args, { initialRoute: { type: "agents" } })
  },
})
