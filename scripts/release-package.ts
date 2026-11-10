// What the release scripts share: the package's manifest at a commit, git, the version rule and
// npm's JSON output. This repository publishes one package, from the root package.json, so the
// release reads that one manifest and nothing else. Every script here imports only node: modules:
// the release jobs run them with Node 24, which strips the types, and install nothing first.
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/** The npm name of the package this repository publishes. */
export const PACKAGE = "hardhat-gas-profile";

/** A version a release accepts: `X.Y.Z`, nothing else. */
export const STABLE_VERSION: RegExp = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** The name and version of the package at a commit. */
export interface Manifest {
  name: string;
  version: string;
}

/** What `git` returned. */
export interface GitResult {
  status: number | null;
  stdout: string;
}

/** Runs `git` with the given arguments. Tests pass a stub. */
export type Git = (args: readonly string[]) => GitResult;

/**
 * Runs `git` in a directory.
 * @param cwd The repository.
 * @returns The runner.
 */
export function gitIn(cwd: string): Git {
  return (args) => {
    const result = spawnSync("git", [...args], { cwd, encoding: "utf8" });
    if (result.error !== undefined) {
      throw new Error(`cannot run git: ${result.error.message}`, { cause: result.error });
    }
    return { status: result.status, stdout: result.stdout };
  };
}

/**
 * The message of a thrown value, for the one line a release script prints.
 * @param error What was thrown.
 * @returns Its message, or the value as a string when it is not an `Error`.
 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Reads a field of an object.
 * @param value Any value.
 * @param name The field.
 * @returns The field, or undefined when `value` is not an object.
 */
export function field(value: unknown, name: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, name) : undefined;
}

/**
 * Reads the root package.json at a commit.
 * @param commit The commit, tag or branch to read.
 * @param git Runs `git` in the repository.
 * @returns The name and version.
 * @throws When the manifest cannot be read, is not JSON, is private or lacks a name or version.
 */
export function manifestAt(commit: string, git: Git): Manifest {
  const shown = git(["show", `${commit}:package.json`]);
  if (shown.status !== 0) {
    throw new Error(`cannot read package.json at ${commit}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(shown.stdout);
  } catch {
    throw new Error(`package.json at ${commit} is not JSON`);
  }
  if (field(parsed, "private") === true) {
    throw new Error(`package.json at ${commit} is private; nothing is published`);
  }
  const name = field(parsed, "name");
  const version = field(parsed, "version");
  if (name !== PACKAGE) {
    throw new Error(`package.json at ${commit} names ${JSON.stringify(name)}, not ${PACKAGE}`);
  }
  if (typeof version !== "string" || version === "") {
    throw new Error(`package.json at ${commit} has no version`);
  }
  return { name, version };
}

/**
 * Unwraps the parsed `--json` output of `npm view`. npm 11 prints the value itself, and npm 12
 * wraps it in a one-element array.
 * @param command The command that printed the output, for the error message.
 * @param parsed The parsed output.
 * @returns The value, or the only element of a one-element array.
 * @throws When the output is an array of another length.
 */
export function unwrapNpmView(command: string, parsed: unknown): unknown {
  if (!Array.isArray(parsed)) {
    return parsed;
  }
  if (parsed.length !== 1) {
    throw new Error(
      `${command} printed an array of ${parsed.length} entries; expected one value or a one-element array`,
    );
  }
  const [only]: unknown[] = parsed;
  return only;
}

/**
 * Whether the module at `moduleUrl` is the script Node was started with.
 * @param moduleUrl The module's `import.meta.url`.
 * @returns True when Node was started with this module.
 */
export function isMainModule(moduleUrl: string): boolean {
  const started = process.argv[1];
  return started !== undefined && path.resolve(started) === fileURLToPath(moduleUrl);
}
