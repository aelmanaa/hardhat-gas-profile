// Runs check-tarballs.ts against tarballs packed for the test with the system tar.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { checkManifest, checkTarballs, localRanges, main, parseSums } from "../check-tarballs.ts";
import { remove } from "./git-repo.ts";

const COMMIT = "a".repeat(40);
const SUM = "b".repeat(64);

const folders: string[] = [];

/** Packs a manifest into `<dir>/<file>` the way npm lays a tarball out, and returns its sum. */
function pack(dir: string, file: string, manifest: Record<string, unknown>): string {
  const source = mkdtempSync(path.join(tmpdir(), "ct-src-"));
  folders.push(source);
  mkdirSync(path.join(source, "package"));
  writeFileSync(path.join(source, "package", "package.json"), JSON.stringify(manifest));
  execFileSync("tar", ["-czf", path.join(dir, file), "-C", source, "package"]);
  return createHash("sha256")
    .update(readFileSync(path.join(dir, file)))
    .digest("hex");
}

function folder(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "ct-out-"));
  folders.push(dir);
  return dir;
}

const good = {
  name: "hardhat-gas-profile",
  version: "0.1.0",
  gitHead: COMMIT,
  peerDependencies: { hardhat: "^3.21.2" },
  devDependencies: { hardhat: "^3.22.0" },
};

describe("release tarball check", () => {
  after(() => {
    for (const dir of folders) {
      remove(dir);
    }
  });

  it("parses exactly one sums line", () => {
    assert.deepEqual(parseSums(`${SUM}  hardhat-gas-profile-0.1.0.tgz\n`), {
      sha256: SUM,
      file: "hardhat-gas-profile-0.1.0.tgz",
    });
    assert.throws(() => parseSums(""), /list 0 tarballs/);
    assert.throws(() => parseSums(`${SUM}  a.tgz\n${SUM}  b.tgz\n`), /list 2 tarballs/);
    assert.throws(() => parseSums(`${SUM} a.tgz`), /is not "<sha256>  <name>\.tgz"/);
    assert.throws(() => parseSums(`${SUM}  ../a.tgz`), /is not/);
  });

  it("refuses a local dependency range", () => {
    assert.deepEqual(
      localRanges({
        dependencies: { a: "^1.0.0", b: "workspace:^" },
        devDependencies: { hardhat: "link:../hardhat", c: "file:../c", d: "catalog:" },
      }),
      ["dependencies.b", "devDependencies.hardhat", "devDependencies.c", "devDependencies.d"],
    );
    const expected = { name: "hardhat-gas-profile", version: "0.1.0", commit: COMMIT };
    checkManifest("t.tgz", JSON.stringify(good), expected);
    assert.throws(
      () =>
        checkManifest(
          "t.tgz",
          JSON.stringify({ ...good, devDependencies: { hardhat: "link:../hardhat" } }),
          expected,
        ),
      /devDependencies\.hardhat use a workspace:, catalog:, link:, file: range/,
    );
    assert.throws(
      () => checkManifest("t.tgz", JSON.stringify({ ...good, gitHead: undefined }), expected),
      /gitHead is undefined, expected a{40}/,
    );
    assert.throws(
      () => checkManifest("t.tgz", JSON.stringify({ ...good, version: "0.1.1" }), expected),
      /version is "0\.1\.1", expected 0\.1\.0/,
    );
  });

  it("passes the packed tarball and refuses a changed, missing or extra one", () => {
    const dir = folder();
    const file = "hardhat-gas-profile-0.1.0.tgz";
    const sum = pack(dir, file, good);
    assert.equal(
      checkTarballs(dir, `${sum}  ${file}\n`, "0.1.0", COMMIT),
      `ok   hardhat-gas-profile@0.1.0 gitHead ${COMMIT} ${file} ${sum}`,
    );
    assert.throws(() => checkTarballs(dir, `${SUM}  ${file}\n`, "0.1.0", COMMIT), /SHA-256 is/);
    assert.throws(() => checkTarballs(dir, `${sum}  ${file}\n`, "0.1.0-beta.0", COMMIT), /plain/);
    assert.throws(
      () => checkTarballs(dir, `${sum}  other.tgz\n`, "0.1.0", COMMIT),
      /tarballs the sums do not list/,
    );
    const empty = folder();
    assert.throws(() => checkTarballs(empty, `${sum}  ${file}\n`, "0.1.0", COMMIT), /missing/);
    const wrong = folder();
    const wrongSum = pack(wrong, file, { ...good, name: "other" });
    assert.throws(
      () => checkTarballs(wrong, `${wrongSum}  ${file}\n`, "0.1.0", COMMIT),
      /name is "other", expected hardhat-gas-profile/,
    );
  });

  it("runs from the command line arguments", () => {
    const dir = folder();
    const file = "hardhat-gas-profile-0.1.0.tgz";
    const sum = pack(dir, file, good);
    const sums = path.join(dir, "SHA256SUMS");
    writeFileSync(sums, `${sum}  ${file}\n`);
    assert.match(
      main(["--dir", dir, "--sums", sums, "--version", "0.1.0", "--commit", COMMIT]),
      /^ok {3}hardhat-gas-profile@0\.1\.0/,
    );
    assert.throws(() => main(["--dir", dir]), /usage:/);
  });
});
