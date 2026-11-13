import path from "node:path";
import { styleText } from "node:util";

import type { SuiteResult } from "@nomicfoundation/edr";
import { HardhatPluginError } from "@nomicfoundation/hardhat-errors";
import { ensureError } from "@nomicfoundation/hardhat-utils/error";
import type { HardhatRuntimeEnvironment } from "hardhat/types/hre";
import type { TaskArguments } from "hardhat/types/tasks";

import { PLUGIN_ID } from "./constants.js";
import { isolationWarning, writeGasProfile } from "./profile.js";

interface SolidityTestResult {
  success: boolean;
  value?: { suiteResults?: SuiteResult[] };
  error?: { suiteResults?: SuiteResult[] };
}

const DEFAULT_TEST_PROFILE = "default";

/**
 * Names what turned isolation on: the gas-stats options, or the `isolate`
 * setting of the selected test profile. Profile selection mirrors hardhat's:
 * the `--test-profile` option, then `HARDHAT_TEST_PROFILE`, then `default`.
 */
export function isolationSources(
  hre: HardhatRuntimeEnvironment,
  testProfile: string | undefined,
): string[] {
  const profileName = testProfile ?? process.env.HARDHAT_TEST_PROFILE ?? DEFAULT_TEST_PROFILE;
  const profile = hre.config.test.solidity.profiles[profileName];

  return [
    hre.globalOptions.gasStats ? "--gas-stats" : undefined,
    hre.globalOptions.gasStatsJson !== undefined ? "--gas-stats-json" : undefined,
    profile?.isolate === true ? "the isolate setting" : undefined,
  ].filter((source) => source !== undefined);
}

export default async function testSolidityWithGasProfile(
  args: TaskArguments,
  hre: HardhatRuntimeEnvironment,
  runSuper: (args: TaskArguments) => Promise<unknown>,
): Promise<unknown> {
  if (args.gasProfile !== true) {
    return runSuper(args);
  }

  // `includeTraces` is how hardhat lets plugins collect every test's call
  // traces. Older versions don't have it.
  if (!hre.tasks.getTask(["test", "solidity"]).options.has("includeTraces")) {
    throw new HardhatPluginError(
      PLUGIN_ID,
      "The --gas-profile flag needs hardhat 3.22.0 or later, whose `test solidity` task supports the includeTraces option. Update hardhat and try again.",
    );
  }

  if (hre.globalOptions.coverage) {
    throw new HardhatPluginError(
      PLUGIN_ID,
      "The --gas-profile flag can't be used with --coverage, because coverage instruments the contracts and changes their gas costs. Run the tests with only one of the two flags.",
    );
  }

  const sources = isolationSources(
    hre,
    typeof args.testProfile === "string" ? args.testProfile : undefined,
  );
  if (sources.length > 0) {
    console.warn(styleText("yellow", isolationWarning(sources)));
  }

  // The profile needs every test's call traces; what's printed still depends
  // on the verbosity alone.
  const result = (await runSuper({
    ...args,
    includeTraces: "all",
  })) as SolidityTestResult;

  const suiteResults = result.success ? result.value?.suiteResults : result.error?.suiteResults;

  console.log();
  // A failure to profile is reported, but it never changes the test result.
  try {
    console.log(
      await writeGasProfile(
        suiteResults ?? [],
        path.join(hre.config.paths.cache, "gas-profile"),
        sources.length > 0,
      ),
    );
  } catch (error) {
    ensureError(error);
    console.warn(
      styleText("yellow", `Warning: the gas profile couldn't be written: ${error.message}`),
    );
  }

  return result;
}
