// Runs check-registry-release.ts against a stubbed npm that answers like npm 11 or npm 12.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  checkDistTags,
  compareVersions,
  hasProvenance,
  main,
  type Npm,
  type PackageView,
  parseDeprecated,
  parseGitHead,
  parsePackageView,
} from "../check-registry-release.ts";
import { remove } from "./git-repo.ts";

const COMMIT = "c".repeat(40);

function view(distTags: Record<string, string>, versions: string[]): PackageView {
  return { distTags, versions };
}

/** A stub npm with fixed answers; `wrap` answers as npm 12, inside a one-element array. */
function stubNpm(
  state: { distTags: Record<string, string>; versions: string[]; gitHead: string },
  options: { wrap?: boolean; provenance?: boolean; deprecated?: string } = {},
): { npm: Npm; calls: string[] } {
  const calls: string[] = [];
  const json = (value: unknown): string => JSON.stringify(options.wrap === true ? [value] : value);
  const npm: Npm = (args) => {
    calls.push(args.join(" "));
    const [command] = args;
    if (command === "view" && args.includes("dist-tags")) {
      return {
        status: 0,
        stdout: json({ "dist-tags": state.distTags, versions: state.versions }),
      };
    }
    if (command === "view" && args.includes("gitHead")) {
      return { status: 0, stdout: json(state.gitHead) };
    }
    if (command === "view" && args.includes("deprecated")) {
      return {
        status: 0,
        stdout: options.deprecated === undefined ? "" : json(options.deprecated),
      };
    }
    if (command === "install") {
      return { status: 0, stdout: "" };
    }
    if (command === "audit") {
      const version = state.distTags.beta ?? "";
      return {
        status: 0,
        stdout: JSON.stringify({
          invalid: [],
          missing: [],
          verified: [
            {
              name: "hardhat-gas-profile",
              version,
              ...(options.provenance === false ? {} : { attestations: { provenance: {} } }),
            },
          ],
        }),
      };
    }
    throw new Error(`unexpected npm ${args.join(" ")}`);
  };
  return { npm, calls };
}

describe("registry release check", () => {
  it("parses npm 11 and npm 12 output", () => {
    const one = { "dist-tags": { beta: "0.1.0" }, versions: "0.1.0" };
    assert.deepEqual(parsePackageView(JSON.stringify(one)), {
      distTags: { beta: "0.1.0" },
      versions: ["0.1.0"],
    });
    assert.deepEqual(parsePackageView(JSON.stringify([one])).versions, ["0.1.0"]);
    assert.throws(() => parsePackageView(JSON.stringify([one, one])), /array of 2 entries/);
    assert.throws(() => parsePackageView(""), /no published version/);
    assert.throws(
      () => parsePackageView(JSON.stringify({ error: { summary: "E404 not found" } })),
      /E404 not found/,
    );
    assert.equal(parseGitHead(JSON.stringify([COMMIT])), COMMIT);
    assert.equal(parseGitHead(""), undefined);
    assert.equal(parseDeprecated(""), undefined);
    assert.equal(parseDeprecated(JSON.stringify("old")), "old");
    assert.equal(compareVersions("0.10.0", "0.9.9") > 0, true);
  });

  it("reads the provenance npm audit signatures verified", () => {
    const audit = (attestations?: unknown): string =>
      JSON.stringify({
        verified: [{ name: "hardhat-gas-profile", version: "0.1.0", attestations }],
      });
    assert.equal(hasProvenance(audit({ provenance: {} }), "0.1.0"), true);
    assert.equal(hasProvenance(audit({ provenance: {} }), "0.1.1"), false);
    assert.equal(hasProvenance(audit(), "0.1.0"), false);
    assert.throws(() => hasProvenance(JSON.stringify({ error: { summary: "x" } }), "0.1.0"), /x/);
  });

  it("allows only a staged version that does not move latest back", () => {
    assert.equal(checkDistTags(view({ beta: "0.1.0" }, ["0.1.0"]), "0.1.0"), false);
    assert.equal(
      checkDistTags(view({ beta: "0.2.0", latest: "0.1.0" }, ["0.1.0", "0.2.0"]), "0.2.0"),
      false,
    );
    assert.equal(checkDistTags(view({ beta: "0.1.0", latest: "0.1.0" }, ["0.1.0"]), "0.1.0"), true);
    assert.throws(() => checkDistTags(view({}, []), "0.1.0-beta.0"), /not a plain X\.Y\.Z/);
    assert.throws(() => checkDistTags(view({}, []), "0.1.0"), /is not on npm/);
    assert.throws(
      () => checkDistTags(view({ beta: "0.0.9" }, ["0.0.9", "0.1.0"]), "0.1.0"),
      /beta at 0\.0\.9, not 0\.1\.0/,
    );
    assert.throws(
      () => checkDistTags(view({ beta: "0.1.0", latest: "0.2.0" }, ["0.1.0", "0.2.0"]), "0.1.0"),
      /latest at 0\.2\.0, above 0\.1\.0/,
    );
  });

  it("moves latest off a deprecated name placeholder only", () => {
    const placeholder = {
      distTags: { beta: "0.1.0", latest: "0.0.0-placeholder.0" },
      versions: ["0.0.0-placeholder.0", "0.1.0"],
    };
    assert.throws(
      () => checkDistTags(placeholder, "0.1.0"),
      /not deprecated; deprecate it first: npm deprecate hardhat-gas-profile@0\.0\.0-placeholder\.0/,
    );
    assert.equal(checkDistTags({ ...placeholder, latestDeprecated: "x" }, "0.1.0"), false);
    assert.throws(
      () =>
        checkDistTags(
          { ...placeholder, versions: [...placeholder.versions, "0.2.0"], latestDeprecated: "x" },
          "0.1.0",
        ),
      /publishes 0\.2\.0; 0\.1\.0 is lower/,
    );
  });

  it("checks gitHead and provenance, and writes whether latest already moved", () => {
    const state = { distTags: { beta: "0.1.0" }, versions: ["0.1.0"], gitHead: COMMIT };
    const dir = mkdtempSync(path.join(tmpdir(), "crr-"));
    try {
      const output = path.join(dir, "out");
      const { npm, calls } = stubNpm(state, { wrap: true });
      const lines = main(["--version", "0.1.0", "--commit", COMMIT, "--output", output], npm);
      assert.equal(lines.length, 3);
      assert.match(lines[2] ?? "", /verified the provenance/);
      assert.equal(readFileSync(output, "utf8"), "already-latest=false\n");
      assert.ok(calls.some((call) => call.startsWith("install --ignore-scripts")));

      const tagsOnly = stubNpm({ ...state, distTags: { beta: "0.1.0", latest: "0.1.0" } });
      assert.equal(
        main(["--version", "0.1.0", "--commit", COMMIT, "--tags-only"], tagsOnly.npm).length,
        1,
      );
      assert.deepEqual(tagsOnly.calls, ["view hardhat-gas-profile dist-tags versions --json"]);

      assert.throws(
        () => main(["--version", "0.1.0", "--commit", "d".repeat(40)], stubNpm(state).npm),
        /gitHead "c{40}", but tag v0\.1\.0 points at d{40}/,
      );
      assert.throws(
        () =>
          main(
            ["--version", "0.1.0", "--commit", COMMIT],
            stubNpm(state, { provenance: false }).npm,
          ),
        /verified no provenance attestation/,
      );
      assert.throws(() => main(["--version", "0.1.0"], stubNpm(state).npm), /usage:/);
    } finally {
      remove(dir);
    }
  });
});
