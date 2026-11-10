// Decides whether a `vX.Y.Z` tag may start a release. The release workflow runs it first, and the
// maintainer can run it before pushing a tag. Four checks, in this order, each failing with one
// line:
// 1. The tag is annotated and carries an OpenPGP signature by a key in `.github/release-keys/`.
//    The keys are imported into a throwaway GNUPGHOME, so the caller's keyring plays no part, and
//    `git verify-tag --raw` is read by its status lines, never by its human output.
// 2. At the tagged commit, the root package.json is the published hardhat-gas-profile, and the tag
//    name is `v` + its version.
// 3. The version is a plain `X.Y.Z`: no prerelease part and no build metadata.
// 4. The tagged commit is an ancestor of `origin/main`.
//
// Usage: node scripts/verify-release-tag.ts vX.Y.Z [--keys DIR] [--main REF] [--output FILE]
// `--keys` defaults to `.github/release-keys` and `--main` to `origin/main`, which must be
// fetched. `--output` appends `commit=<sha>` and `version=<X.Y.Z>` to FILE (GITHUB_OUTPUT) when
// the tag passes. Exits 0 when the tag passes, 1 when it fails or the script cannot decide.
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";

import {
  errorMessage,
  gitIn,
  isMainModule,
  type Manifest,
  manifestAt,
  STABLE_VERSION,
} from "./release-package.ts";

/** The directory of maintainer public keys, relative to the repository root. */
export const KEYS_DIRECTORY = ".github/release-keys";
/** The ref the tagged commit must be reachable from. */
export const MAIN_REF = "origin/main";

const HOME_PREFIX = "hardhat-gas-profile-release-keys-";
const PGP_SIGNATURE = "-----BEGIN PGP SIGNATURE-----";
const PRIVATE_KEY = "PRIVATE KEY";
const PUBLIC_KEY_BEGIN = "-----BEGIN PGP PUBLIC KEY BLOCK-----";
const PUBLIC_KEY_END = "-----END PGP PUBLIC KEY BLOCK-----";

/** What the script needs to know about where it runs. */
export interface VerifyOptions {
  /** The tag name, for example `v0.1.0`. */
  tag: string;
  /** The repository to look in. */
  cwd: string;
  /** The environment for `git` and `gpg`; the script adds `GNUPGHOME` to it. */
  env: NodeJS.ProcessEnv;
  /** The key directory; defaults to {@link KEYS_DIRECTORY} under `cwd`. */
  keysDirectory?: string;
  /** The ref the tagged commit must be reachable from; defaults to {@link MAIN_REF}. */
  mainRef?: string;
}

/** The one-line reason a tag fails. */
export interface Failure {
  ok: false;
  reason: string;
}

/** Who signed the tag, once the signature is accepted. */
export interface Signature {
  ok: true;
  /** The user id of the key that signed the tag. */
  signer: string;
  /** The fingerprint of the primary key that signed the tag. */
  fingerprint: string;
}

/** The outcome: what passed, or the one-line reason the tag fails. */
export type Verdict =
  | (Signature & {
      /** The published package at the tagged commit. */
      name: string;
      /** The released version, without the `v`. */
      version: string;
      /** The tagged commit. */
      commit: string;
    })
  | Failure;

/** What a command returned. */
interface Command {
  status: number | null;
  stdout: string;
  stderr: string;
}

function run(file: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv): Command {
  const result = spawnSync(file, [...args], { cwd, env, encoding: "utf8" });
  if (result.error !== undefined) {
    throw new Error(`cannot run ${file}: ${result.error.message}`, { cause: result.error });
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

// Importing public keys and verifying need no agent, so gpg must not start one: an agent would
// outlive the throwaway home.
function gpg(args: readonly string[], cwd: string, env: NodeJS.ProcessEnv): Command {
  return run(
    "gpg",
    ["--batch", "--no-tty", "--no-autostart", "--status-fd", "1", ...args],
    cwd,
    env,
  );
}

/**
 * Removes the throwaway GNUPGHOME. The removal is recursive, so the function accepts only a
 * `${HOME_PREFIX}*` directory directly under the system temp directory.
 * @param directory The directory `verifyReleaseTag` created.
 */
export function removeKeyHome(directory: string): void {
  const resolved = path.resolve(directory);
  if (
    path.dirname(resolved) !== path.resolve(tmpdir()) ||
    !path.basename(resolved).startsWith(HOME_PREFIX)
  ) {
    throw new Error(
      `refusing to remove ${directory}: not a ${HOME_PREFIX}* directory under ${tmpdir()}`,
    );
  }
  rmSync(resolved, { recursive: true, force: true });
}

/**
 * Stops a gpg agent that runs for the throwaway home, before the directory goes. The checks start
 * none, so this finds no socket and returns at once; `gpgconf --kill` alone takes seconds even
 * when no agent runs. A missing gpgconf is not an error: there is then no agent to stop.
 * @param home The GNUPGHOME.
 * @param cwd The directory to run gpgconf in.
 * @param env The environment for gpgconf.
 */
export function stopAgent(home: string, cwd: string, env: NodeJS.ProcessEnv): void {
  const socket = spawnSync("gpgconf", ["--homedir", home, "--list-dirs", "agent-socket"], {
    cwd,
    env,
    encoding: "utf8",
  });
  if (socket.status === 0 && existsSync(socket.stdout.trim())) {
    spawnSync("gpgconf", ["--homedir", home, "--kill", "gpg-agent"], { cwd, env });
  }
}

/** The status lines of a gpg run, without the `[GNUPG:] ` prefix. */
function statusLines(command: Command): string[] {
  return `${command.stdout}\n${command.stderr}`
    .split(/\r?\n/)
    .filter((line) => line.startsWith("[GNUPG:] "))
    .map((line) => line.slice("[GNUPG:] ".length));
}

/** The space-separated field of a status line, or "" when it is missing. */
function field(line: string, index: number): string {
  return line.split(" ")[index] ?? "";
}

/**
 * Reads the status lines of a signature check.
 * @param lines The status lines, without the `[GNUPG:] ` prefix.
 * @param trusted The primary fingerprints of the imported keys.
 * @returns The signer and fingerprint, or the reason the signature fails.
 */
export function readSignature(
  lines: readonly string[],
  trusted: ReadonlySet<string>,
): Signature | Failure {
  for (const line of lines) {
    const kind = field(line, 0);
    if (kind === "BADSIG") {
      return {
        ok: false,
        reason: `the signature does not match the tag (key ${field(line, 1)}); re-create the tag with git tag -s`,
      };
    }
    if (kind === "EXPKEYSIG" || kind === "REVKEYSIG") {
      const state = kind === "EXPKEYSIG" ? "expired" : "revoked";
      return {
        ok: false,
        reason: `the signing key ${field(line, 1)} is ${state}; sign with a current key that is in ${KEYS_DIRECTORY}`,
      };
    }
    if (kind === "EXPSIG") {
      return {
        ok: false,
        reason: `the signature by key ${field(line, 1)} has expired; re-create the tag with git tag -s`,
      };
    }
    if (kind === "NO_PUBKEY") {
      return {
        ok: false,
        reason: `signed by key ${field(line, 1)}, which is not in ${KEYS_DIRECTORY}`,
      };
    }
  }
  const valid = lines.find((line) => field(line, 0) === "VALIDSIG");
  const good = lines.find((line) => field(line, 0) === "GOODSIG");
  if (valid === undefined || good === undefined) {
    return {
      ok: false,
      reason: `gpg reported no valid signature on the tag; re-create it with git tag -s using a key in ${KEYS_DIRECTORY}`,
    };
  }
  // VALIDSIG ends with the fingerprint of the primary key, also when a subkey signed.
  const fingerprint = field(valid, 10);
  if (!trusted.has(fingerprint)) {
    return { ok: false, reason: `signed by key ${fingerprint}, which is not in ${KEYS_DIRECTORY}` };
  }
  return { ok: true, signer: good.split(" ").slice(2).join(" ").trim(), fingerprint };
}

/**
 * Reads the primary fingerprints of the keys an import added, from its status lines.
 * @param lines The status lines of `gpg --import`.
 * @returns The fingerprints, one per imported or already present key.
 */
export function importedFingerprints(lines: readonly string[]): Set<string> {
  const fingerprints = new Set<string>();
  for (const line of lines) {
    // IMPORT_OK <reason> <fingerprint>: the fingerprint is the primary key's.
    const [kind, , fingerprint] = line.split(" ");
    if (kind === "IMPORT_OK" && fingerprint !== undefined && fingerprint !== "") {
      fingerprints.add(fingerprint);
    }
  }
  return fingerprints;
}

/**
 * Whether a key file is exactly one armored public-key block, as `gpg --armor --export` writes it.
 * @param text The file's content.
 * @returns True for one block with nothing before or after it.
 */
export function isOnePublicKeyBlock(text: string): boolean {
  const trimmed = text.trim();
  return (
    trimmed.startsWith(PUBLIC_KEY_BEGIN) &&
    trimmed.endsWith(PUBLIC_KEY_END) &&
    trimmed.indexOf("-----BEGIN") === trimmed.lastIndexOf("-----BEGIN") &&
    trimmed.indexOf("-----END") === trimmed.lastIndexOf("-----END")
  );
}

/** Imports every `.asc` file of the key directory into `home`. */
function importKeys(
  keysDirectory: string,
  home: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): { ok: true; fingerprints: Set<string> } | Failure {
  let names: string[];
  try {
    names = readdirSync(keysDirectory)
      .filter((name) => name.endsWith(".asc"))
      .toSorted();
  } catch (error: unknown) {
    const detail = errorMessage(error);
    return { ok: false, reason: `cannot read the key directory ${keysDirectory}: ${detail}` };
  }
  if (names.length === 0) {
    return { ok: false, reason: `no release keys: ${keysDirectory} has no .asc file` };
  }
  const fingerprints = new Set<string>();
  for (const name of names) {
    const file = path.join(keysDirectory, name);
    const text = readFileSync(file, "utf8");
    if (text.includes(PRIVATE_KEY)) {
      return {
        ok: false,
        reason: `${file} contains a private key; remove it, revoke that key, and commit only the output of gpg --armor --export`,
      };
    }
    // One armored public-key block per file, so a reviewer sees in the diff what the file holds.
    if (!isOnePublicKeyBlock(text)) {
      return {
        ok: false,
        reason: `${file} is not one armored public key block; commit only the output of gpg --armor --export <key-id>`,
      };
    }
    // The exit status says nothing useful: gpg exits 2 when it cannot reach an agent it does not
    // need. The IMPORT_OK status lines say what was imported.
    const imported = importedFingerprints(
      statusLines(gpg(["--homedir", home, "--import", file], cwd, env)),
    );
    if (imported.size !== 1) {
      return {
        ok: false,
        reason: `${file} holds ${imported.size} importable keys; commit one key per file, the output of gpg --armor --export <key-id>`,
      };
    }
    for (const fingerprint of imported) {
      fingerprints.add(fingerprint);
    }
  }
  return { ok: true, fingerprints };
}

function checkSignature(options: VerifyOptions, keysDirectory: string): Signature | Failure {
  const { tag, cwd, env } = options;
  const ref = run("git", ["rev-parse", "--verify", "--quiet", `refs/tags/${tag}`], cwd, env);
  if (ref.status !== 0) {
    return { ok: false, reason: `tag ${tag} does not exist` };
  }
  const type = run("git", ["cat-file", "-t", `refs/tags/${tag}`], cwd, env);
  if (type.stdout.trim() !== "tag") {
    return {
      ok: false,
      reason: `tag ${tag} is lightweight; a release tag is signed with git tag -s`,
    };
  }
  const object = run("git", ["cat-file", "tag", `refs/tags/${tag}`], cwd, env);
  if (!object.stdout.includes(PGP_SIGNATURE)) {
    return {
      ok: false,
      reason: `tag ${tag} is annotated but has no OpenPGP signature; re-create it with git tag -s`,
    };
  }
  const home = mkdtempSync(path.join(tmpdir(), HOME_PREFIX));
  const homeEnv: NodeJS.ProcessEnv = { ...env, GNUPGHOME: home };
  try {
    const keys = importKeys(keysDirectory, home, cwd, homeEnv);
    if (!keys.ok) {
      return keys;
    }
    const verified = run(
      "git",
      [
        "-c",
        "gpg.program=gpg",
        "-c",
        "gpg.format=openpgp",
        "verify-tag",
        "--raw",
        `refs/tags/${tag}`,
      ],
      cwd,
      homeEnv,
    );
    return readSignature(statusLines(verified), keys.fingerprints);
  } finally {
    stopAgent(home, cwd, homeEnv);
    removeKeyHome(home);
  }
}

/**
 * Runs the four checks on a tag.
 * @param options The tag, the repository and the environment, see {@link VerifyOptions}.
 * @returns The verdict; it never throws for a failing tag, only when `git` or `gpg` cannot run.
 */
export function verifyReleaseTag(options: VerifyOptions): Verdict {
  const { tag, cwd, env } = options;
  const keysDirectory = options.keysDirectory ?? path.join(cwd, KEYS_DIRECTORY);
  const mainRef = options.mainRef ?? MAIN_REF;

  const signature = checkSignature(options, keysDirectory);
  if (!signature.ok) {
    return signature;
  }

  const commit = run("git", ["rev-parse", `refs/tags/${tag}^{commit}`], cwd, env).stdout.trim();
  let core: Manifest;
  try {
    core = manifestAt(commit, gitIn(cwd));
  } catch (error: unknown) {
    return { ok: false, reason: errorMessage(error) };
  }
  if (tag !== `v${core.version}`) {
    return {
      ok: false,
      reason: `tag ${tag} does not match version ${core.version} of ${core.name}`,
    };
  }
  if (!STABLE_VERSION.test(core.version)) {
    return {
      ok: false,
      reason: `version ${core.version} is not a plain X.Y.Z; a release has no prerelease part or build metadata`,
    };
  }

  const head = run("git", ["rev-parse", "--verify", "--quiet", `${mainRef}^{commit}`], cwd, env);
  if (head.status !== 0) {
    return { ok: false, reason: `${mainRef} is not fetched; run git fetch origin main` };
  }
  const onMain = run("git", ["merge-base", "--is-ancestor", commit, mainRef], cwd, env);
  if (onMain.status !== 0) {
    return { ok: false, reason: `commit ${commit} of ${tag} is not on ${mainRef}` };
  }
  return {
    ...signature,
    name: core.name,
    version: core.version,
    commit,
  };
}

/**
 * Runs the command line.
 * @param argv The arguments after the script name.
 * @param cwd The repository.
 * @param env The environment for `git` and `gpg`.
 * @returns The line to print and whether the tag passed.
 */
export function main(
  argv: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): { ok: boolean; line: string } {
  const { positionals, values } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      keys: { type: "string" },
      main: { type: "string" },
      output: { type: "string" },
    },
  });
  const tag = positionals[0];
  if (tag === undefined || positionals.length !== 1) {
    throw new Error(
      "usage: node scripts/verify-release-tag.ts vX.Y.Z [--keys DIR] [--main REF] [--output FILE]",
    );
  }
  const verdict = verifyReleaseTag({
    tag,
    cwd,
    env,
    ...(values.keys === undefined ? {} : { keysDirectory: path.resolve(cwd, values.keys) }),
    ...(values.main === undefined ? {} : { mainRef: values.main }),
  });
  if (!verdict.ok) {
    return { ok: false, line: `${tag} fails: ${verdict.reason}` };
  }
  if (values.output !== undefined) {
    appendFileSync(values.output, `commit=${verdict.commit}\nversion=${verdict.version}\n`);
  }
  return {
    ok: true,
    line: `${tag} passes: signed by ${verdict.signer} (${verdict.fingerprint}), version ${verdict.version} of ${verdict.name}, commit ${verdict.commit} on ${values.main ?? MAIN_REF}`,
  };
}

if (isMainModule(import.meta.url)) {
  try {
    const result = main(process.argv.slice(2), process.cwd(), process.env);
    if (result.ok) {
      process.stdout.write(`${result.line}\n`);
    } else {
      process.stderr.write(`${result.line}\n`);
      process.exitCode = 1;
    }
  } catch (error: unknown) {
    process.stderr.write(`${errorMessage(error)}\n`);
    process.exitCode = 1;
  }
}
