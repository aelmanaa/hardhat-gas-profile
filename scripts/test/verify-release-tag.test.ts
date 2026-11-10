// Runs verify-release-tag.ts against real git tags signed by keys made for the test, in a
// throwaway GNUPGHOME. Needs `gpg` on the PATH, as the release workflow's runner has.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  importedFingerprints,
  isOnePublicKeyBlock,
  main,
  readSignature,
  removeKeyHome,
  stopAgent,
  verifyReleaseTag,
} from "../verify-release-tag.ts";
import { commit, git, gitEnv, makeRepo, manifest, remove, runScript } from "./git-repo.ts";

const SCRIPT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "verify-release-tag.ts",
);
const FPR = "A".repeat(40);
const MANIFEST = "package.json";

/** A home for the test's own keys, holding the secret halves that sign the tags. */
function makeSigner(): { home: string; maintainer: string; stranger: string } {
  const home = mkdtempSync(path.join(tmpdir(), "vrt-gpg-"));
  const env = { ...gitEnv(), GNUPGHOME: home };
  const fingerprints: string[] = [];
  for (const user of ["Maintainer <m@example.com>", "Stranger <s@example.com>"]) {
    execFileSync(
      "gpg",
      ["--batch", "--passphrase", "", "--quick-gen-key", user, "ed25519", "sign", "never"],
      { env, stdio: "ignore" },
    );
    const listing = execFileSync("gpg", ["--batch", "--with-colons", "--list-secret-keys", user], {
      env,
      encoding: "utf8",
    });
    fingerprints.push(/^fpr:+([0-9A-F]{40}):/m.exec(listing)?.[1] ?? "");
  }
  return { home, maintainer: fingerprints[0] ?? "", stranger: fingerprints[1] ?? "" };
}

function exportKey(home: string, fingerprint: string): string {
  return execFileSync("gpg", ["--batch", "--armor", "--export", fingerprint], {
    env: { ...gitEnv(), GNUPGHOME: home },
    encoding: "utf8",
  });
}

describe("release tag check", () => {
  it("reads gpg status lines", () => {
    const trusted = new Set([FPR]);
    const valid = `VALIDSIG X 2026-11-03 1 0 4 0 22 8 01 ${FPR}`;
    assert.deepEqual(readSignature(["GOODSIG K Maintainer <m@example.com>", valid], trusted), {
      ok: true,
      signer: "Maintainer <m@example.com>",
      fingerprint: FPR,
    });
    const reasons = [
      [["BADSIG K x"], /does not match the tag \(key K\)/],
      [["BADSIG"], /does not match the tag \(key \)/],
      [["EXPKEYSIG K x"], /signing key K is expired/],
      [["REVKEYSIG K x"], /signing key K is revoked/],
      [["EXPSIG K x"], /signature by key K has expired/],
      [["NO_PUBKEY K"], /signed by key K, which is not in/],
      [["GOODSIG K x"], /no valid signature/],
      [[valid], /no valid signature/],
      [["GOODSIG K x", valid.replace(FPR, "B".repeat(40))], /signed by key B{40}, which is not in/],
    ] as const;
    for (const [lines, reason] of reasons) {
      const verdict = readSignature(lines, trusted);
      assert.equal(verdict.ok, false);
      assert.match(verdict.ok ? "" : verdict.reason, reason);
    }
  });

  it("reads imported fingerprints and checks the key file shape", () => {
    assert.deepEqual(
      [
        ...importedFingerprints([
          `IMPORT_OK 1 ${FPR}`,
          "IMPORT_OK 0",
          "IMPORT_RES 1",
          "KEY_CONSIDERED x",
        ]),
      ],
      [FPR],
    );
    const block = "-----BEGIN PGP PUBLIC KEY BLOCK-----\nx\n-----END PGP PUBLIC KEY BLOCK-----\n";
    assert.equal(isOnePublicKeyBlock(block), true);
    assert.equal(isOnePublicKeyBlock(`${block}${block}`), false);
    assert.equal(isOnePublicKeyBlock(`junk\n${block}`), false);
  });

  it("removes only its own GNUPGHOME", () => {
    assert.throws(() => removeKeyHome(tmpdir()), /refusing to remove/);
    assert.throws(
      () => removeKeyHome(path.join(tmpdir(), "a", "hardhat-gas-profile-release-keys-x")),
      /refusing/,
    );
    const home = mkdtempSync(path.join(tmpdir(), "hardhat-gas-profile-release-keys-"));
    removeKeyHome(home);
  });

  describe("against signed tags", () => {
    let signer = { home: "", maintainer: "", stranger: "" };
    let root = "";
    let keys = "";
    let onMain = "";
    let offMain = "";

    /** Creates a tag at a commit: signed by a key, annotated only, or lightweight. */
    function tag(
      name: string,
      at: string,
      how: "maintainer" | "stranger" | "annotated" | "light",
    ): void {
      const env = { ...gitEnv(), GNUPGHOME: signer.home };
      if (how === "light") {
        git(root, ["tag", name, at], env);
      } else if (how === "annotated") {
        git(root, ["tag", "-a", "-m", name, name, at], env);
      } else {
        const key = how === "maintainer" ? signer.maintainer : signer.stranger;
        git(
          root,
          [
            "-c",
            "gpg.program=gpg",
            "-c",
            `user.signingkey=${key}`,
            "tag",
            "-s",
            "-m",
            name,
            name,
            at,
          ],
          env,
        );
      }
    }

    function verify(name: string, keysDirectory = keys, mainRef?: string): string {
      const verdict = verifyReleaseTag({
        tag: name,
        cwd: root,
        env: gitEnv(),
        keysDirectory,
        ...(mainRef === undefined ? {} : { mainRef }),
      });
      return verdict.ok ? `ok ${verdict.version} ${verdict.name}` : verdict.reason;
    }

    before(() => {
      signer = makeSigner();
      root = makeRepo("vrt-repo-", {
        [MANIFEST]: manifest("hardhat-gas-profile", "0.0.0", true),
        ".github/release-keys/maintainer.asc": exportKey(signer.home, signer.maintainer),
      });
      keys = path.join(root, ".github/release-keys");
      const privateCommit = git(root, ["rev-parse", "HEAD"]);
      onMain = commit(root, { [MANIFEST]: manifest("hardhat-gas-profile", "0.1.0") }, "0.1.0");
      const renamed = commit(root, { [MANIFEST]: manifest("other-name", "0.1.1") }, "renamed");
      const prerelease = commit(
        root,
        { [MANIFEST]: manifest("hardhat-gas-profile", "0.1.1-beta.1") },
        "prerelease",
      );
      const broken = commit(root, { [MANIFEST]: "{" }, "broken");
      git(root, ["update-ref", "refs/remotes/origin/main", broken]);
      git(root, ["checkout", "--quiet", "-b", "side", onMain]);
      offMain = commit(root, { [MANIFEST]: manifest("hardhat-gas-profile", "0.2.0") }, "side");
      tag("v0.1.0", onMain, "maintainer");
      tag("v0.2.0", offMain, "maintainer");
      tag("v0.0.0", privateCommit, "maintainer");
      tag("v0.1.1", renamed, "maintainer");
      tag("v0.1.1-beta.1", prerelease, "maintainer");
      tag("v9.9.9", broken, "maintainer");
      tag("v0.1.9", onMain, "maintainer");
      tag("stranger", onMain, "stranger");
      tag("annotated", onMain, "annotated");
      tag("light", onMain, "light");
    });
    after(() => {
      // The signer home has a running agent: the keys were made through it.
      stopAgent(signer.home, root, gitEnv());
      remove(signer.home);
      remove(root);
    });

    it("passes a tag signed by a listed key, at the package's version, on main", () => {
      assert.equal(verify("v0.1.0"), "ok 0.1.0 hardhat-gas-profile");
    });

    it("refuses a missing, lightweight, unsigned or foreign-signed tag", () => {
      assert.match(verify("v7.0.0"), /tag v7\.0\.0 does not exist/);
      assert.match(verify("light"), /is lightweight/);
      assert.match(verify("annotated"), /annotated but has no OpenPGP signature/);
      assert.match(
        verify("stranger"),
        /signed by key [0-9A-F]+, which is not in \.github\/release-keys/,
      );
    });

    it("refuses a key directory that is missing, empty or holds the wrong thing", () => {
      assert.match(verify("v0.1.0", path.join(root, "nowhere")), /cannot read the key directory/);
      const folder = mkdtempSync(path.join(tmpdir(), "vrt-keys-"));
      try {
        assert.match(verify("v0.1.0", folder), /has no \.asc file/);
        writeFileSync(path.join(folder, "a.asc"), "-----BEGIN PGP PRIVATE KEY BLOCK-----\n");
        assert.match(verify("v0.1.0", folder), /contains a private key/);
        writeFileSync(path.join(folder, "a.asc"), "not a key\n");
        assert.match(verify("v0.1.0", folder), /is not one armored public key block/);
        writeFileSync(
          path.join(folder, "a.asc"),
          "-----BEGIN PGP PUBLIC KEY BLOCK-----\n\nnope\n-----END PGP PUBLIC KEY BLOCK-----\n",
        );
        assert.match(verify("v0.1.0", folder), /holds 0 importable keys/);
      } finally {
        remove(folder);
      }
    });

    it("refuses a tag whose version or package does not match", () => {
      assert.match(
        verify("v0.1.9"),
        /tag v0\.1\.9 does not match version 0\.1\.0 of hardhat-gas-profile/,
      );
      assert.match(verify("v0.0.0"), /package\.json at [0-9a-f]{40} is private/);
      assert.match(verify("v0.1.1"), /names "other-name", not hardhat-gas-profile/);
      assert.match(verify("v0.1.1-beta.1"), /version 0\.1\.1-beta\.1 is not a plain X\.Y\.Z/);
      assert.match(verify("v9.9.9"), /package\.json at [0-9a-f]{40} is not JSON/);
    });

    it("refuses a commit that is not on main, or a main that is not fetched", () => {
      assert.match(verify("v0.2.0"), /commit [0-9a-f]{40} of v0\.2\.0 is not on origin\/main/);
      assert.match(verify("v0.1.0", keys, "origin/nothing"), /origin\/nothing is not fetched/);
    });

    it("writes the commit and version for the workflow, and runs from the command line", () => {
      const output = path.join(root, "github-output");
      const passed = main(["v0.1.0", "--keys", keys, "--output", output], root, gitEnv());
      assert.equal(passed.ok, true);
      assert.match(
        passed.line,
        /^v0\.1\.0 passes: signed by Maintainer <m@example\.com> \([0-9A-F]{40}\), version 0\.1\.0 of hardhat-gas-profile, commit [0-9a-f]{40} on origin\/main$/,
      );
      assert.equal(readFileSync(output, "utf8"), `commit=${onMain}\nversion=0.1.0\n`);
      assert.equal(main(["v0.2.0", "--main", "side"], root, gitEnv()).ok, true);
      assert.throws(() => main([], root, gitEnv()), /usage: node scripts\/verify-release-tag\.ts/);

      const cli = runScript(SCRIPT, ["v0.1.0", "--keys", keys], root, gitEnv());
      assert.equal(cli.status, 0, cli.stderr);
      assert.match(cli.stdout, /^v0\.1\.0 passes/);
      const refused = runScript(SCRIPT, ["v0.2.0", "--keys", keys], root, gitEnv());
      assert.equal(refused.status, 1);
      assert.match(refused.stderr, /^v0\.2\.0 fails: commit/);
      const usage = runScript(SCRIPT, [], root, gitEnv());
      assert.equal(usage.status, 1);
      assert.match(usage.stderr, /^usage:/);
    });

    it("throws when git cannot start", () => {
      const missing = path.join(root, "missing");
      assert.throws(
        () => verifyReleaseTag({ tag: "v0.1.0", cwd: missing, env: gitEnv() }),
        /cannot run git/,
      );
    });
  });
});
