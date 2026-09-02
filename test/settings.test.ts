import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

import { copyFor } from "../format.ts";
import {
  DEFAULT_SETTINGS,
  SETTINGS_FILE,
  SHOW_ITEM_TOKENS,
  SHOW_KEYS,
  SHOW_TOKENS,
  loadSettings,
  parseSettings,
  saveSettings,
} from "../settings.ts";

const temporaryDirs = new Set<string>();

after(() => {
  for (const dir of temporaryDirs) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-signal-footer-settings-"));
  temporaryDirs.add(dir);
  return dir;
}

test("interpolates every show-item token into help copy", () => {
  const tokens = SHOW_ITEM_TOKENS.split("|");
  assert.equal(new Set(tokens).size, tokens.length);
  assert.deepEqual(tokens, SHOW_KEYS.map((key) => SHOW_TOKENS[key]));
  for (const locale of ["zh", "en"] as const) {
    const text = copyFor(locale);
    const usage = text.usage(SHOW_ITEM_TOKENS);
    const itemUsage = text.itemUsage(SHOW_ITEM_TOKENS);
    for (const token of tokens) {
      assert.ok(usage.includes(token), `${locale} usage missing ${token}`);
      assert.ok(itemUsage.includes(token), `${locale} itemUsage missing ${token}`);
    }
  }
});

test("reports invalid known fields while preserving valid fields and ignoring unknown keys", () => {
  const result = parseSettings({
    enabled: "false",
    locale: "fr",
    showBranch: false,
    futureFlag: true,
  });

  assert.equal(result.settings.enabled, DEFAULT_SETTINGS.enabled);
  assert.equal(result.settings.locale, DEFAULT_SETTINGS.locale);
  assert.equal(result.settings.showBranch, false);
  assert.deepEqual(result.invalidKeys, ["enabled", "locale"]);
});

test("distinguishes missing, invalid JSON, semantic errors, and unreadable settings", () => {
  const missing = loadSettings(tempDir());
  assert.deepEqual(missing.settings, { ...DEFAULT_SETTINGS });
  assert.deepEqual(missing.invalidKeys, []);
  assert.equal(missing.error, undefined);

  const invalidJsonDir = tempDir();
  writeFileSync(join(invalidJsonDir, SETTINGS_FILE), "{not json", "utf8");
  const invalidJson = loadSettings(invalidJsonDir);
  assert.deepEqual(invalidJson.settings, { ...DEFAULT_SETTINGS });
  assert.deepEqual(invalidJson.invalidKeys, []);
  assert.equal(invalidJson.error, "invalid-json");

  const semanticDir = tempDir();
  writeFileSync(join(semanticDir, SETTINGS_FILE), JSON.stringify({ showTurns: 1, showProject: false }), "utf8");
  const semantic = loadSettings(semanticDir);
  assert.equal(semantic.settings.showProject, false);
  assert.equal(semantic.settings.showTurns, DEFAULT_SETTINGS.showTurns);
  assert.deepEqual(semantic.invalidKeys, ["showTurns"]);
  assert.equal(semantic.error, undefined);

  const unreadablePath = join(tempDir(), "not-a-directory");
  writeFileSync(unreadablePath, "file", "utf8");
  const unreadable = loadSettings(unreadablePath);
  assert.deepEqual(unreadable.settings, { ...DEFAULT_SETTINGS });
  assert.deepEqual(unreadable.invalidKeys, []);
  assert.equal(unreadable.error, "unreadable");
});

test("writes valid JSON and removes a temporary file after a failed replacement", () => {
  const dir = tempDir();
  const settings = { ...DEFAULT_SETTINGS, enabled: false };
  saveSettings(dir, settings);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, SETTINGS_FILE), "utf8")), settings);
  assert.deepEqual(readdirSync(dir).filter((name) => name.includes(".tmp")), []);

  const blockedDir = tempDir();
  const targetAsDirectory = join(blockedDir, SETTINGS_FILE);
  mkdirSync(targetAsDirectory);
  assert.throws(() => saveSettings(blockedDir, settings));
  assert.equal(readdirSync(targetAsDirectory).length, 0);
  assert.deepEqual(readdirSync(blockedDir).filter((name) => name.includes(".tmp")), []);
});
