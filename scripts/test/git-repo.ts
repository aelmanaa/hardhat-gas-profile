// Temporary git repositories for the release script tests. Each repository has its own config,
// so the tests never read the caller's git or gpg settings.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

// A git hook exports GIT_DIR (and, for some hooks, GIT_INDEX_FILE and GIT_WORK_TREE) to what it
// runs. A test started from a hook, such as the pre-push run of the test suite, would then point
// every git command, its own and those of the scripts it starts, at the repository being pushed
// instead of its temporary one: `git init` there sets core.bare, and commits, tags and
// update-ref land on its branches. So the test process drops every GIT_* variable before any
// test runs, and each child process inherits the cleaned environment.
for (const key of Object.keys(process.env)) {
  if (key.startsWith("GIT_")) {
    Reflect.deleteProperty(process.env, key);
  }
}

/** The environment for git in a test: no global or system config, a fixed author and date. */
export function gitEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    // The caller's environment keeps PATH and, under c8, NODE_V8_COVERAGE for the scripts the
    // tests start; the rest pins git to no user config and a fixed author and date.
    ...process.env,
    HOME: tmpdir(),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.com",
    GIT_AUTHOR_DATE: "2026-11-03T00:00:00Z",
    GIT_COMMITTER_DATE: "2026-11-03T00:00:00Z",
    ...extra,
  };
}

/** Runs git in a repository and returns its trimmed output; throws when git fails. */
export function git(
  cwd: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = gitEnv(),
): string {
  return execFileSync("git", [...args], { cwd, env, encoding: "utf8" }).trim();
}

/** Writes files, relative to `root`, creating folders as needed. */
export function writeFiles(root: string, files: Readonly<Record<string, string>>): void {
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  }
}

/** A package manifest. */
export function manifest(name: string, version: string, isPrivate = false): string {
  return `${JSON.stringify({ name, version, ...(isPrivate ? { private: true } : {}) })}\n`;
}

/** Creates a repository with one commit of `files`, and returns its folder. */
export function makeRepo(prefix: string, files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  git(root, ["init", "--quiet", "--initial-branch=main"]);
  // Stop before the first commit unless git works in the new folder and nowhere else.
  const top = git(root, ["rev-parse", "--show-toplevel"]);
  if (realpathSync(top) !== realpathSync(root)) {
    throw new Error(`git resolved ${root} to the repository at ${top}; refusing to commit there`);
  }
  commit(root, files, "initial");
  return root;
}

/** Writes `files` and commits them; returns the new commit. */
export function commit(
  root: string,
  files: Readonly<Record<string, string>>,
  message: string,
): string {
  writeFiles(root, files);
  git(root, ["add", "--all"]);
  git(root, ["-c", "commit.gpgsign=false", "commit", "--quiet", "--allow-empty", "-m", message]);
  return git(root, ["rev-parse", "HEAD"]);
}

/** Runs a script with Node in `cwd`. */
export function runScript(
  script: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): { status: number | null; stdout: string; stderr: string } {
  // Node 24.0.0 prints a type-stripping ExperimentalWarning that the output checks would see.
  const result = spawnSync(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", script, ...args],
    { cwd, env, encoding: "utf8" },
  );
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Removes a temporary folder. */
export function remove(root: string): void {
  rmSync(root, { recursive: true, force: true });
}
