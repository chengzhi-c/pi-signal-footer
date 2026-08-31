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

test("ships the Chinese README in the published package", () => {
  assert.ok(manifest.files?.includes("README.zh-CN.md"));
});

test("ships the settings module imported by the extension entrypoint", () => {
  assert.ok(manifest.files?.includes("settings.ts"));
});

test("ships the footer module imported by the extension entrypoint", () => {
  assert.ok(manifest.files?.includes("footer.ts"));
});

test("keeps the runtime host floor, peer floor, and READMEs aligned", () => {
  assert.equal(manifest.peerDependencies?.["@earendil-works/pi-coding-agent"], ">=" + MIN_HOST_VERSION);
  assert.equal(manifest.peerDependencies?.["@earendil-works/pi-tui"], ">=" + MIN_HOST_VERSION);

  for (const path of ["../README.md", "../README.zh-CN.md"]) {
    const readme = readFileSync(new URL(path, import.meta.url), "utf8");
    assert.match(readme, new RegExp(">=" + MIN_HOST_VERSION.replaceAll(".", "\\.")));
    assert.doesNotMatch(readme, /then throws|随后.*抛错/);
  }
});

test("keeps the footer benchmark opt-in and outside the published file list", () => {
  assert.equal(manifest.scripts?.["bench:footer"], "tsx bench/footer.bench.ts");
  assert.ok(!manifest.files?.includes("bench/footer.bench.ts"));
});
