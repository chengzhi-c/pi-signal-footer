import { randomBytes } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export const SETTINGS_FILE = "pi-signal-footer.json";

export type FooterLocale = "auto" | "zh" | "en";
export type FooterSettings = {
  enabled: boolean;
  locale: FooterLocale;
  showProject: boolean;
  showSessionName: boolean;
  showDuration: boolean;
  showTurns: boolean;
  showSpeed: boolean;
  showBranch: boolean;
  showCacheRatio: boolean;
};

export const DEFAULT_SETTINGS: Readonly<FooterSettings> = Object.freeze({
  enabled: true,
  locale: "auto",
  showProject: true,
  showSessionName: true,
  showDuration: true,
  showTurns: true,
  showSpeed: true,
  showBranch: true,
  showCacheRatio: true,
});

export type ShowKey = Exclude<keyof FooterSettings, "enabled" | "locale">;

export const SHOW_KEYS = [
  "showProject",
  "showSessionName",
  "showDuration",
  "showTurns",
  "showSpeed",
  "showBranch",
  "showCacheRatio",
] as const satisfies readonly ShowKey[];

export const SHOW_TOKENS = {
  showProject: "path",
  showSessionName: "session",
  showDuration: "time",
  showTurns: "turns",
  showSpeed: "speed",
  showBranch: "branch",
  showCacheRatio: "cache",
} as const satisfies Record<ShowKey, string>;

export const SHOW_ITEM_TOKENS = SHOW_KEYS.map((key) => SHOW_TOKENS[key]).join("|");

export type SettingsParseResult = {
  settings: FooterSettings;
  invalidKeys: string[];
};

export type SettingsLoadError = "invalid-json" | "unreadable";
export type SettingsLoadResult = SettingsParseResult & {
  error?: SettingsLoadError;
};

const BOOLEAN_KEYS = [
  "enabled",
  ...SHOW_KEYS,
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseSettings(raw: unknown): SettingsParseResult {
  const settings: FooterSettings = { ...DEFAULT_SETTINGS };
  if (!isRecord(raw)) return { settings, invalidKeys: ["<root>"] };

  const invalidKeys: string[] = [];
  for (const key of BOOLEAN_KEYS) {
    if (!Object.hasOwn(raw, key)) continue;
    if (typeof raw[key] !== "boolean") {
      invalidKeys.push(key);
      continue;
    }
    settings[key] = raw[key];
  }

  if (Object.hasOwn(raw, "locale")) {
    const locale = raw.locale;
    if (locale === "auto" || locale === "zh" || locale === "en") settings.locale = locale;
    else invalidKeys.push("locale");
  }

  return { settings, invalidKeys };
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isDirectory(path: string): boolean | undefined {
  try {
    return statSync(path).isDirectory();
  } catch (error) {
    return isNotFound(error) ? undefined : false;
  }
}

export function loadSettings(dir: string): SettingsLoadResult {
  let source: string;
  try {
    source = readFileSync(join(dir, SETTINGS_FILE), "utf8");
  } catch (error) {
    if (isNotFound(error) && isDirectory(dir) !== false) {
      return { settings: { ...DEFAULT_SETTINGS }, invalidKeys: [] };
    }
    return { settings: { ...DEFAULT_SETTINGS }, invalidKeys: [], error: "unreadable" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return { settings: { ...DEFAULT_SETTINGS }, invalidKeys: [], error: "invalid-json" };
  }
  return parseSettings(parsed);
}

export function saveSettings(dir: string, next: FooterSettings): void {
  mkdirSync(dir, { recursive: true });
  const target = join(dir, SETTINGS_FILE);
  const temporary = `${target}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  const body = `${JSON.stringify(next, null, 2)}\n`;

  try {
    writeFileSync(temporary, body, { encoding: "utf8", flag: "wx" });
    renameSync(temporary, target);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // The original target remains untouched if cleanup itself fails.
    }
    throw error;
  }
}
