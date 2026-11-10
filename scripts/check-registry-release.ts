// Checks a version on npm before promote.yml moves `latest` to it. It never publishes and never
// moves a tag; it reads the registry without a token. For hardhat-gas-profile at the version:
// - the version is a plain X.Y.Z and is published;
// - the `beta` dist-tag points at it, so only a version release.yml staged, and a maintainer
//   approved on npmjs.com, moves on;
// - `latest` is not above it, so `latest` never moves backwards. A deprecated name placeholder on
//   `latest` (the owner's `0.0.0-placeholder.0`, or npm's `0.0.0-stage`) is below any version and
//   passes; an undeprecated one fails with the command that deprecates it;
// - its `gitHead` is the tagged commit;
// - in a scratch project, `npm install --ignore-scripts` of the version followed by
//   `npm audit signatures --include-attestations` verifies a provenance attestation for it.
// With --tags-only it runs the dist-tag checks alone: the promote job runs them again just before
// it moves `latest`, since the approval may come hours after the first check.
//
// Usage: node scripts/check-registry-release.ts --version X.Y.Z --commit SHA [--tags-only]
//   [--output FILE]
// `--output` appends `already-latest=true|false` to FILE (GITHUB_OUTPUT). Exits 1 on the first
// failure.
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";

import {
  errorMessage,
  field,
  isMainModule,
  PACKAGE,
  STABLE_VERSION,
  unwrapNpmView,
} from "./release-package.ts";

/** The dist-tag release.yml stages a version under. */
export const BETA = "beta";

/**
 * The versions that may hold `latest` before the first release, each with the deprecation message
 * docs/contributor/releasing.md gives it: the owner's placeholder that reserves the name, and the
 * one npm's staged publishing creates for a name that does not exist.
 */
export const NAME_PLACEHOLDERS: ReadonlyMap<string, string> = new Map([
  ["0.0.0-placeholder.0", "Placeholder that reserves the name; install the version on latest."],
  ["0.0.0-stage", "Placeholder created by npm staged publishing; install the version on latest."],
]);

/** What an npm command returned. */
export interface NpmResult {
  status: number | null;
  stdout: string;
}

/** Runs npm with the given arguments in a directory. Tests pass a stub. */
export type Npm = (args: readonly string[], cwd?: string) => NpmResult;

/** The dist-tags and versions of the package on npm. */
export interface PackageView {
  distTags: Record<string, string>;
  versions: string[];
  /** The deprecation message of the version on `latest`, read only for a name placeholder. */
  latestDeprecated?: string | undefined;
}

/**
 * Runs npm.
 * @param args The arguments.
 * @param cwd The directory to run in.
 * @returns The exit status and standard output; npm prints JSON even when it fails.
 */
export function runNpm(args: readonly string[], cwd: string = process.cwd()): NpmResult {
  const result = spawnSync("npm", [...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (result.error !== undefined) {
    throw new Error(`cannot run npm: ${result.error.message}`, { cause: result.error });
  }
  return { status: result.status, stdout: result.stdout };
}

/** npm's `error.summary` when its JSON carries one, else the whole error. */
function npmError(error: unknown): string {
  const summary = field(error, "summary");
  return typeof summary === "string" ? summary : JSON.stringify(error);
}

/**
 * Parses the output of `npm view <name> dist-tags versions --json`.
 * @param json npm's output.
 * @returns The dist-tags and versions.
 * @throws When npm printed an error or no dist-tags.
 */
export function parsePackageView(json: string): PackageView {
  if (json.trim() === "") {
    throw new Error(`${PACKAGE} has no published version`);
  }
  const parsed = unwrapNpmView(`npm view ${PACKAGE}`, JSON.parse(json));
  const error = field(parsed, "error");
  if (error !== undefined) {
    throw new Error(`npm view ${PACKAGE} failed: ${npmError(error)}`);
  }
  const distTags = field(parsed, "dist-tags");
  const versions = field(parsed, "versions");
  if (typeof distTags !== "object" || distTags === null) {
    throw new Error(`npm view ${PACKAGE} returned no dist-tags`);
  }
  return {
    distTags: Object.fromEntries(
      Object.entries(distTags).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    ),
    // npm prints one version as a string and several as an array.
    versions:
      typeof versions === "string"
        ? [versions]
        : Array.isArray(versions)
          ? versions.filter((version): version is string => typeof version === "string")
          : [],
  };
}

/**
 * Parses the output of `npm view <name>@<version> gitHead --json`.
 * @param json npm's output.
 * @returns The commit, or undefined when the published manifest has none.
 */
export function parseGitHead(json: string): string | undefined {
  if (json.trim() === "") {
    return undefined;
  }
  const parsed = unwrapNpmView("npm view gitHead", JSON.parse(json));
  return typeof parsed === "string" && parsed !== "" ? parsed : undefined;
}

/**
 * Parses the output of `npm view <name>@<version> deprecated --json`.
 * @param json npm's output; empty when the version is not deprecated.
 * @returns The deprecation message, or undefined.
 */
export function parseDeprecated(json: string): string | undefined {
  if (json.trim() === "") {
    return undefined;
  }
  const parsed = unwrapNpmView("npm view deprecated", JSON.parse(json));
  if (typeof parsed !== "string") {
    throw new Error(`npm view deprecated printed ${JSON.stringify(parsed)}`);
  }
  return parsed === "" ? undefined : parsed;
}

/**
 * Whether `npm audit signatures --json --include-attestations` verified a provenance attestation
 * for the package at the version.
 * @param json npm's output.
 * @param version The version.
 * @returns True when the verified list has the package at the version with provenance.
 */
export function hasProvenance(json: string, version: string): boolean {
  const parsed: unknown = JSON.parse(json);
  const error = field(parsed, "error");
  if (error !== undefined) {
    throw new Error(`npm audit signatures failed: ${npmError(error)}`);
  }
  const verified = field(parsed, "verified");
  if (!Array.isArray(verified)) {
    throw new Error("npm audit signatures returned no verified list");
  }
  return verified.some((entry: unknown) => {
    const provenance = field(field(entry, "attestations"), "provenance");
    return (
      field(entry, "name") === PACKAGE &&
      field(entry, "version") === version &&
      typeof provenance === "object" &&
      provenance !== null
    );
  });
}

/**
 * Compares two plain X.Y.Z versions.
 * @param a A version.
 * @param b A version.
 * @returns Negative when `a` is lower, 0 when equal, positive when higher.
 */
export function compareVersions(a: string, b: string): number {
  const parts = (version: string): number[] => {
    if (!STABLE_VERSION.test(version)) {
      throw new Error(`${version} is not a plain X.Y.Z`);
    }
    return version.split(".").map(Number);
  };
  const left = parts(a);
  const right = parts(b);
  return left.map((part, index) => part - (right[index] ?? 0)).find((d) => d !== 0) ?? 0;
}

/**
 * The dist-tag checks: published, on `beta`, `latest` not above it.
 * @param view The package on npm.
 * @param version The version to promote.
 * @returns Whether `latest` already points at the version.
 * @throws With the reason the version may not move to `latest`.
 */
export function checkDistTags(view: PackageView, version: string): boolean {
  if (!STABLE_VERSION.test(version)) {
    throw new Error(`version ${version} is not a plain X.Y.Z; latest never points at a prerelease`);
  }
  if (!view.versions.includes(version)) {
    throw new Error(`${PACKAGE}@${version} is not on npm; run release.yml for it first`);
  }
  const beta = view.distTags[BETA];
  if (beta !== version) {
    throw new Error(
      `${PACKAGE} has beta at ${beta ?? "nothing"}, not ${version}; promote the version release.yml staged last, after its stage was approved`,
    );
  }
  const latest = view.distTags.latest;
  if (latest === undefined || latest === version) {
    return latest === version;
  }
  const placeholder = NAME_PLACEHOLDERS.get(latest);
  if (placeholder !== undefined) {
    const above = view.versions
      .filter((published) => STABLE_VERSION.test(published))
      .filter((published) => compareVersions(published, version) > 0);
    if (above.length > 0) {
      throw new Error(
        `${PACKAGE} has latest at the name placeholder ${latest}, but publishes ${above.join(", ")}; ${version} is lower and would move latest backwards`,
      );
    }
    if (view.latestDeprecated === undefined) {
      throw new Error(
        `${PACKAGE} has latest at ${latest}, a name placeholder that is not deprecated; deprecate it first: npm deprecate ${PACKAGE}@${latest} "${placeholder}"`,
      );
    }
    return false;
  }
  if (!STABLE_VERSION.test(latest)) {
    throw new Error(`${PACKAGE} has latest at ${latest}, which is not a plain X.Y.Z; fix it first`);
  }
  if (compareVersions(latest, version) > 0) {
    throw new Error(
      `${PACKAGE} has latest at ${latest}, above ${version}; latest never moves back`,
    );
  }
  return false;
}

/**
 * Reads the package's dist-tags and versions, and the deprecation of a placeholder on `latest`.
 * @param npm Runs npm.
 * @returns The view.
 */
export function readView(npm: Npm): PackageView {
  const view = parsePackageView(npm(["view", PACKAGE, "dist-tags", "versions", "--json"]).stdout);
  const latest = view.distTags.latest;
  if (latest !== undefined && NAME_PLACEHOLDERS.has(latest)) {
    const deprecated = npm(["view", `${PACKAGE}@${latest}`, "deprecated", "--json"]).stdout;
    return { ...view, latestDeprecated: parseDeprecated(deprecated) };
  }
  return view;
}

/**
 * Installs the version into a scratch project and asks npm to verify its attestations.
 * @param npm Runs npm.
 * @param version The version.
 * @returns The output of `npm audit signatures --json --include-attestations`.
 */
export function auditSignatures(npm: Npm, version: string): string {
  const scratch = mkdtempSync(path.join(tmpdir(), "hardhat-gas-profile-registry-"));
  try {
    writeFileSync(
      path.join(scratch, "package.json"),
      `${JSON.stringify({ name: "scratch", private: true })}\n`,
    );
    const install = npm(
      ["install", "--ignore-scripts", "--no-audit", "--no-fund", `${PACKAGE}@${version}`],
      scratch,
    );
    if (install.status !== 0) {
      throw new Error(`npm install ${PACKAGE}@${version} failed in a scratch project`);
    }
    return npm(["audit", "signatures", "--json", "--include-attestations"], scratch).stdout;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Runs the command line.
 * @param argv The arguments after the script name.
 * @param npm Runs npm.
 * @returns The lines to print.
 */
export function main(argv: readonly string[], npm: Npm): string[] {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      version: { type: "string" },
      commit: { type: "string" },
      "tags-only": { type: "boolean" },
      output: { type: "string" },
    },
  });
  const { version, commit, output } = values;
  if (version === undefined || commit === undefined) {
    throw new Error(
      "usage: node scripts/check-registry-release.ts --version X.Y.Z --commit SHA [--tags-only] [--output FILE]",
    );
  }
  const lines: string[] = [];
  const view = readView(npm);
  const alreadyLatest = checkDistTags(view, version);
  lines.push(
    `ok   ${PACKAGE}@${version} is published and on beta; latest is ${view.distTags.latest ?? "unset"}${alreadyLatest ? ", already this version" : ", not above it"}`,
  );
  if (values["tags-only"] !== true) {
    const gitHead = parseGitHead(
      npm(["view", `${PACKAGE}@${version}`, "gitHead", "--json"]).stdout,
    );
    if (gitHead !== commit) {
      throw new Error(
        `${PACKAGE}@${version} has gitHead ${JSON.stringify(gitHead)}, but tag v${version} points at ${commit}`,
      );
    }
    lines.push(`ok   ${PACKAGE}@${version} was published from ${commit}`);
    if (!hasProvenance(auditSignatures(npm, version), version)) {
      throw new Error(
        `npm audit signatures verified no provenance attestation for ${PACKAGE}@${version}`,
      );
    }
    lines.push(`ok   npm audit signatures verified the provenance of ${PACKAGE}@${version}`);
  }
  if (output !== undefined) {
    appendFileSync(output, `already-latest=${String(alreadyLatest)}\n`);
  }
  return lines;
}

if (isMainModule(import.meta.url)) {
  try {
    process.stdout.write(`${main(process.argv.slice(2), runNpm).join("\n")}\n`);
  } catch (error: unknown) {
    process.stderr.write(`FAIL ${errorMessage(error)}\n`);
    process.exitCode = 1;
  }
}
