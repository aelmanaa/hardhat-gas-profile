import { overrideTask } from "hardhat/config";
import type { HardhatPlugin } from "hardhat/types/plugins";

import { PLUGIN_ID } from "./internal/constants.js";

const hardhatGasProfilePlugin: HardhatPlugin = {
  id: PLUGIN_ID,
  tasks: [
    overrideTask(["test", "solidity"])
      .addFlag({
        name: "gasProfile",
        description: "Print a gas summary and write an HTML report and folded stacks for each test",
      })
      .setAction(async () => await import("./internal/task-action.js"))
      .build(),
    // `hardhat test` passes its options on by name to the subtasks that
    // declare them, so declaring the flag here makes `hardhat test
    // --gas-profile` reach the `test solidity` override above.
    overrideTask("test")
      .addFlag({
        name: "gasProfile",
        description: "Profile the gas of the Solidity tests (see `test solidity --gas-profile`)",
      })
      .setAction(async () => ({
        default: (args, _hre, runSuper) => runSuper(args),
      }))
      .build(),
  ],
  npmPackage: "hardhat-gas-profile",
};

export default hardhatGasProfilePlugin;
