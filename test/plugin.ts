import type { HardhatRuntimeEnvironment } from "hardhat/types/hre";

import assert from "node:assert/strict";
import { readdir, readFile, writeFile, access } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, it, mock } from "node:test";

import { createHardhatRuntimeEnvironment } from "hardhat/hre";

import config from "./fixture-projects/basic/hardhat.config.js";
import { createTmpDir } from "./helpers/tmp-dir.js";
import { isolationWarning } from "../src/internal/profile.js";
import { ISOLATION_NOTE } from "../src/internal/summary.js";

const FIXTURE = path.join(import.meta.dirname, "fixture-projects", "basic");

async function exists(p: string): Promise<boolean> {
  return access(p).then(
    () => true,
    () => false,
  );
}

/** Runs `fn` and returns what it printed with console.log and console.warn. */
async function capture<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; logs: string; warnings: string[] }> {
  const log = mock.method(console, "log", () => {});
  const warn = mock.method(console, "warn", () => {});
  try {
    const result = await fn();
    return {
      result,
      logs: log.mock.calls.map((c) => c.arguments.map(String).join(" ")).join("\n"),
      warnings: warn.mock.calls.map((c) => c.arguments.map(String).join(" ")),
    };
  } finally {
    log.mock.restore();
    warn.mock.restore();
  }
}

describe("hardhat-gas-profile", () => {
  const tmp = createTmpDir("hardhat-gas-profile");
  const originalCwd = process.cwd();

  before(async () => {
    process.chdir(FIXTURE);
    const hre = await createHardhatRuntimeEnvironment(config, {}, FIXTURE);
    await hre.tasks.getTask("build").run({ quiet: true });
  });

  after(() => {
    process.chdir(originalCwd);
  });

  function hreWith(
    options: { cache?: string; isolate?: boolean } = {},
    globalOptions: Record<string, unknown> = {},
  ): Promise<HardhatRuntimeEnvironment> {
    return createHardhatRuntimeEnvironment(
      {
        ...config,
        paths: { cache: options.cache ?? tmp.path },
        test: { solidity: { isolate: options.isolate ?? false } },
      },
      globalOptions,
      FIXTURE,
    );
  }

  it("writes folded stacks and an HTML report, and prints the summary", async () => {
    const hre = await hreWith();

    const { result, logs } = await capture(() =>
      hre.tasks
        .getTask(["test", "solidity"])
        .run({ noCompile: true, gasProfile: true }),
    );

    // A failing test is profiled, and the result is still a failure.
    assert.equal((result as { success: boolean }).success, false);
    const foldedDir = path.join(tmp.path, "gas-profile", "folded");
    assert.deepEqual((await readdir(foldedDir)).sort(), [
      "GasProfileTest.testIncThenFail.folded",
      "GasProfileTest.testIncTwice.folded",
    ]);
    const folded = await readFile(
      path.join(foldedDir, "GasProfileTest.testIncTwice.folded"),
      "utf8",
    );
    assert.match(folded, /^GasProfileTest\.testIncTwice \d+\n/);
    assert.match(folded, /\nGasProfileTest\.testIncTwice;Counter\.inc \d+\n/);

    const htmlPath = path.join(tmp.path, "gas-profile", "index.html");
    assert.ok((await readFile(htmlPath, "utf8")).includes("Counter.inc ×2"));

    assert.ok(logs.includes("Tests by gas (top 2 of 2)"), logs);
    assert.ok(
      logs.includes(
        `Saved gas profile to ${htmlPath}\nSaved folded stacks to ${foldedDir} (2 files)`,
      ),
    );
    assert.ok(!logs.includes(ISOLATION_NOTE));
  });

  it("does nothing extra without the flag", async () => {
    const hre = await hreWith();

    const { logs } = await capture(() =>
      hre.tasks.getTask(["test", "solidity"]).run({ noCompile: true }),
    );

    assert.equal(await exists(path.join(tmp.path, "gas-profile")), false);
    assert.ok(!logs.includes("Tests by gas"));
  });

  it("works through `hardhat test --gas-profile`", async () => {
    const hre = await hreWith();

    await capture(() =>
      hre.tasks
        .getTask("test")
        .run({ noCompile: true, gasProfile: true, testFiles: [] }),
    );

    assert.equal(
      (await readdir(path.join(tmp.path, "gas-profile", "folded"))).length,
      2,
    );
  });

  it("notes isolation when the isolate setting is on", async () => {
    const hre = await hreWith({ isolate: true });

    const { logs, warnings } = await capture(() =>
      hre.tasks
        .getTask(["test", "solidity"])
        .run({ noCompile: true, gasProfile: true }),
    );

    assert.ok(logs.includes(ISOLATION_NOTE));
    assert.ok(
      warnings.some((w) => w.includes(isolationWarning(["the isolate setting"]))),
    );
  });

  it("warns that --gas-stats turns isolation on", async () => {
    const hre = await hreWith({}, { gasStats: true });

    const { warnings } = await capture(() =>
      hre.tasks
        .getTask(["test", "solidity"])
        .run({ noCompile: true, gasProfile: true }),
    );

    assert.ok(warnings.some((w) => w.includes(isolationWarning(["--gas-stats"]))));
  });

  it("refuses to run with --coverage", async () => {
    const hre = await hreWith({}, { coverage: true });

    await assert.rejects(
      hre.tasks
        .getTask(["test", "solidity"])
        .run({ noCompile: true, gasProfile: true }),
      /can't be used with --coverage/,
    );
  });

  it("removes the previous profile when no test runs", async () => {
    const hre = await hreWith();
    const task = hre.tasks.getTask(["test", "solidity"]);

    const { logs } = await capture(async () => {
      await task.run({ noCompile: true, gasProfile: true });
      await task.run({ noCompile: true, gasProfile: true, grep: "matchesNothing" });
    });

    assert.ok(
      logs.includes(
        "Gas profile: no Solidity tests ran, so the previous gas profile was removed.",
      ),
    );
    assert.equal(await exists(path.join(tmp.path, "gas-profile")), false);
  });

  it("keeps the test result when the profile can't be written", async () => {
    // The cache path is a file, so nothing can be written under it.
    const cacheFile = path.join(tmp.path, "not-a-directory");
    await writeFile(cacheFile, "");
    const hre = await hreWith({ cache: cacheFile });

    const { result, warnings } = await capture(() =>
      hre.tasks
        .getTask(["test", "solidity"])
        .run({ noCompile: true, gasProfile: true }),
    );

    assert.equal((result as { success: boolean }).success, false);
    assert.ok(warnings.some((w) => w.includes("the gas profile couldn't be written")));
  });
});
