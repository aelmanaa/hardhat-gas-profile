// Checks the release tarball against its SHA-256 sum and against the release it belongs to. The
// release workflow runs it twice: in the pack job, right after packing, and in the publish job, on
// the downloaded artifact, against the sum the pack job passed as a job output. The sum travels
// outside the artifact it covers, so a swapped artifact fails here.
//
// The sums file must hold exactly one line, for the one package this repository publishes:
// - the file name is a plain `*.tgz` name, the file exists in the directory, and the directory
//   holds no other tarball;
// - its SHA-256 equals the listed sum;
// - its package/package.json names hardhat-gas-profile at the release version, with `gitHead`
//   set to the tagged commit, and no dependency range a registry install cannot resolve
//   (`workspace:`, `catalog:`, `link:` or `file:`). A `link:` range in devDependencies means the
//   package was built against a local checkout, as during development against an unreleased
//   Hardhat; it never ships.
// The version must be a plain X.Y.Z.
//
// Usage: node scripts/check-tarballs.ts --dir DIR --sums FILE --version X.Y.Z --commit SHA
// Prints one line for the tarball, or the first failure, and exits 1 on a failure.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";

import { errorMessage, field, isMainModule, PACKAGE, STABLE_VERSION } from "./release-package.ts";

/** One line of a `sha256sum` listing. */
export interface SumLine {
  sha256: string;
  file: string;
}

/** What the manifest inside the tarball must say. */
export interface Expected {
  name: string;
  version: string;
  commit: string;
}

const SUM_LINE = /^[0-9a-f]{64} {2}[\w.@-]+\.tgz$/;

/** Range prefixes that only a local checkout or a pnpm workspace can resolve. */
export const LOCAL_PREFIXES: readonly string[] = ["workspace:", "catalog:", "link:", "file:"];

/** The dependency fields of a manifest. */
export const DEPENDENCY_FIELDS: readonly string[] = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];

/**
 * Parses the `sha256sum` listing of the release tarball.
 * @param text The listing: one `<sum>  <file>` line.
 * @returns The line.
 * @throws When the line is malformed or there is not exactly one.
 */
export function parseSums(text: string): SumLine {
  const lines = text.split(/\r?\n/).filter((line) => line !== "");
  if (lines.length !== 1) {
    throw new Error(`the sums list ${lines.length} tarballs; this release publishes 1`);
  }
  const [line = ""] = lines;
  if (!SUM_LINE.test(line)) {
    throw new Error(`the sums line is not "<sha256>  <name>.tgz": ${JSON.stringify(line)}`);
  }
  // The pattern fixed the layout: 64 hex digits, two spaces, the file name.
  return { sha256: line.slice(0, 64), file: line.slice(66) };
}

/**
 * Lists the dependencies whose range a registry install cannot resolve.
 * @param manifest A parsed package.json.
 * @returns `<field>.<name>` for each such range.
 */
export function localRanges(manifest: unknown): string[] {
  return DEPENDENCY_FIELDS.flatMap((key) => {
    const ranges = field(manifest, key);
    if (typeof ranges !== "object" || ranges === null) {
      return [];
    }
    return Object.entries(ranges)
      .filter(
        ([, range]) =>
          typeof range === "string" && LOCAL_PREFIXES.some((prefix) => range.startsWith(prefix)),
      )
      .map(([name]) => `${key}.${name}`);
  });
}

/**
 * Checks the manifest of the tarball.
 * @param file The tarball's name, for the message.
 * @param manifestText Its package/package.json.
 * @param expected The package, version and commit it must carry.
 * @throws When a field differs, naming the field and both values.
 */
export function checkManifest(file: string, manifestText: string, expected: Expected): void {
  const manifest: unknown = JSON.parse(manifestText);
  for (const [key, want] of [
    ["name", expected.name],
    ["version", expected.version],
    ["gitHead", expected.commit],
  ] as const) {
    const actual = field(manifest, key);
    if (actual !== want) {
      throw new Error(`${file}: ${key} is ${JSON.stringify(actual)}, expected ${want}`);
    }
  }
  const local = localRanges(manifest);
  if (local.length > 0) {
    throw new Error(
      `${file}: ${local.join(", ")} use a ${LOCAL_PREFIXES.join(", ")} range, which a registry install cannot resolve; depend on a published version`,
    );
  }
}

/**
 * Runs every check on a directory that holds the release tarball.
 * @param directory The directory the tarball is in.
 * @param sumsText The `sha256sum` listing it must match.
 * @param version The release version.
 * @param commit The tagged commit.
 * @returns The line to print.
 */
export function checkTarballs(
  directory: string,
  sumsText: string,
  version: string,
  commit: string,
): string {
  if (!STABLE_VERSION.test(version)) {
    throw new Error(`version ${version} is not a plain X.Y.Z`);
  }
  const sum = parseSums(sumsText);
  const extra = readdirSync(directory).filter((name) => name.endsWith(".tgz") && name !== sum.file);
  if (extra.length > 0) {
    throw new Error(`${directory} holds tarballs the sums do not list: ${extra.join(", ")}`);
  }
  const tarball = path.join(directory, sum.file);
  if (!existsSync(tarball)) {
    throw new Error(`${sum.file} is listed in the sums but missing`);
  }
  const actual = createHash("sha256").update(readFileSync(tarball)).digest("hex");
  if (actual !== sum.sha256) {
    throw new Error(`${sum.file}: SHA-256 is ${actual}, the pack job recorded ${sum.sha256}`);
  }
  // tar runs in the directory with the plain file name, which never holds a slash.
  const manifest = execFileSync("tar", ["-xOzf", sum.file, "package/package.json"], {
    cwd: directory,
    encoding: "utf8",
  });
  checkManifest(sum.file, manifest, { name: PACKAGE, version, commit });
  return `ok   ${PACKAGE}@${version} gitHead ${commit} ${sum.file} ${sum.sha256}`;
}

/**
 * Runs the command line.
 * @param argv The arguments after the script name.
 * @returns The line to print.
 */
export function main(argv: readonly string[]): string {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      dir: { type: "string" },
      sums: { type: "string" },
      version: { type: "string" },
      commit: { type: "string" },
    },
  });
  const { dir, sums, version, commit } = values;
  if (dir === undefined || sums === undefined || version === undefined || commit === undefined) {
    throw new Error(
      "usage: node scripts/check-tarballs.ts --dir DIR --sums FILE --version X.Y.Z --commit SHA",
    );
  }
  return checkTarballs(dir, readFileSync(sums, "utf8"), version, commit);
}

if (isMainModule(import.meta.url)) {
  try {
    process.stdout.write(`${main(process.argv.slice(2))}\n`);
  } catch (error: unknown) {
    process.stderr.write(`FAIL ${errorMessage(error)}\n`);
    process.exitCode = 1;
  }
}
