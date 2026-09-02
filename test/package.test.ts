import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { MIN_HOST_VERSION } from "../index.ts";

type PackageManifest = {
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  files?: string[];
  scripts?: Record<string, string>;
};

const manifest = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as PackageManifest;

test("declares Pi host modules as peers without production dependencies", () => {
  assert.equal(manifest.peerDependencies?.["@earendil-works/pi-coding-agent"], ">=0.84.4");
  assert.equal(manifest.peerDependencies?.["@earendil-works/pi-tui"], ">=0.84.4");
  assert.deepEqual(manifest.dependencies ?? {}, {});
});

test("ships the runtime modules and both READMEs", () => {
  assert.deepEqual(manifest.files, [
    "LICENSE",
    "README.md",
    "README.zh-CN.md",
    "format.ts",
    "index.ts",
    "settings.ts",
    "footer.ts",
  ]);
});

test("keeps the runtime host floor, peer floor, and READMEs aligned", () => {
  assert.equal(manifest.peerDependencies?.["@earendil-works/pi-coding-agent"], ">=" + MIN_HOST_VERSION);
  assert.equal(manifest.peerDependencies?.["@earendil-works/pi-tui"], ">=" + MIN_HOST_VERSION);

  const floor = MIN_HOST_VERSION.replaceAll(".", "\\.");
  for (const path of ["../README.md", "../README.zh-CN.md"]) {
    const readme = readFileSync(new URL(path, import.meta.url), "utf8");
    assert.match(readme, new RegExp(">=" + floor));
  }
});

test("keeps the footer benchmark opt-in and outside the published file list", () => {
  assert.equal(manifest.scripts?.["bench:footer"], "tsx bench/footer.bench.ts");
  assert.ok(!manifest.files?.includes("bench/footer.bench.ts"));
});
