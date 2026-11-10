import { createRequire } from "node:module";
import path from "node:path";

import { readJsonFile } from "@nomicfoundation/hardhat-utils/fs";

const require = createRequire(import.meta.url);

/** Reads the version of the installed `hardhat` and of the EDR it runs on. */
async function versionOf(packageJsonPath: string): Promise<string> {
  const { version } = await readJsonFile<{ version: string }>(packageJsonPath);
  return version;
}

export async function getHardhatVersion(): Promise<string> {
  return versionOf(require.resolve("hardhat/package.json"));
}

export async function getEdrVersion(): Promise<string> {
  // EDR is resolved from hardhat's own location, so the version is the one
  // hardhat runs on, not a copy of this plugin's.
  const hardhatRequire = createRequire(require.resolve("hardhat/package.json"));
  const edrMain = hardhatRequire.resolve("@nomicfoundation/edr");
  let dir = path.dirname(edrMain);
  while (path.basename(dir) !== "edr") {
    dir = path.dirname(dir);
  }
  return versionOf(path.join(dir, "package.json"));
}
