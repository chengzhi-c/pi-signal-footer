import {
  type ExtensionAPI,
  type ExtensionContext,
  getAgentDir,
  VERSION,
} from "@earendil-works/pi-coding-agent";
import { join } from "node:path";

import {
  DEFAULT_SETTINGS,
  SETTINGS_FILE,
  loadSettings,
  saveSettings,
  SHOW_ITEM_TOKENS,
  SHOW_KEYS,
  SHOW_TOKENS,
  type FooterLocale,
  type FooterSettings,
  type ShowKey,
} from "./settings.ts";
export {
  DEFAULT_SETTINGS,
  SETTINGS_FILE,
  loadSettings,
  parseSettings,
  saveSettings,
} from "./settings.ts";
export type { FooterLocale, FooterSettings, SettingsLoadError, SettingsLoadResult, SettingsParseResult } from "./settings.ts";

import { handleStream, installFooter, resetStreamState } from "./footer.ts";
export { handleStream, resolveHome } from "./footer.ts";

import {
  copyFor,
  itemDisplayName,
  legendLines,
  resolveLocale,
} from "./format.ts";

// 短名词是对外命令面；完整设置键名保留为隐式别名，旧习惯不至于断。
const CHIP_COMMANDS: Readonly<Record<string, ShowKey>> = Object.freeze({
  ...Object.fromEntries(SHOW_KEYS.map((key) => [SHOW_TOKENS[key], key])),
  ...Object.fromEntries(SHOW_KEYS.map((key) => [key.toLowerCase(), key])),
});

function parseToggle(value: string): boolean | undefined {
  if (value === "on" || value === "true" || value === "1") return true;
  if (value === "off" || value === "false" || value === "0") return false;
  return undefined;
}

const LEGEND_WIDGET_KEY = "pi-signal-footer-legend";
export const MIN_HOST_VERSION = "0.84.4";

function parseVersion(version: string): { numbers: [number, number, number]; prerelease: boolean } | undefined {
  const match = version.trim().match(
    /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/,
  );
  if (!match) return undefined;
  const numbers = [match[1], match[2] ?? "0", match[3] ?? "0"].map(Number);
  if (numbers.some((value) => !Number.isSafeInteger(value) || value < 0)) return undefined;
  return { numbers: numbers as [number, number, number], prerelease: match[4] !== undefined };
}

export function hostVersionTooOld(version: string, minimum = MIN_HOST_VERSION): boolean {
  const actual = parseVersion(version);
  const required = parseVersion(minimum);
  if (!actual || !required) return true;

  for (const index of [0, 1, 2] as const) {
    if (actual.numbers[index] !== required.numbers[index]) {
      return actual.numbers[index] < required.numbers[index];
    }
  }
  return actual.prerelease && !required.prerelease;
}

function hideLegend(ctx: ExtensionContext): void {
  ctx.ui.setWidget(LEGEND_WIDGET_KEY, undefined);
}

export function createExtension(options: { agentDir?: string; hostVersion?: string } = {}): (pi: ExtensionAPI) => void {
  const agentDir = () => options.agentDir ?? getAgentDir();
  const hostVersion = options.hostVersion ?? VERSION;
  const footerSupported = !hostVersionTooOld(hostVersion);
  let settings: FooterSettings = { ...DEFAULT_SETTINGS };
  let warnedInvalid = false;
  let warnedHost = false;
  let legendVisible = false;
  // Avoid clearing the global slot when this instance never installed it;
  // Pi does not expose current footer ownership to extensions.
  let footerInstalled = false;

  const warnUnsupportedHost = (ctx: ExtensionContext): void => {
    if (warnedHost) return;
    warnedHost = true;
    if (typeof ctx.ui.notify === "function") {
      ctx.ui.notify(`pi-signal-footer needs Pi ${MIN_HOST_VERSION}+ (this host is ${hostVersion}).`, "warning");
    }
  };

  const showLegend = (ctx: ExtensionContext, locale: ReturnType<typeof resolveLocale>): void => {
    ctx.ui.setWidget(LEGEND_WIDGET_KEY, [...legendLines(locale)], { placement: "aboveEditor" });
    legendVisible = true;
  };

  const clearLegend = (ctx: ExtensionContext): void => {
    legendVisible = false;
    hideLegend(ctx);
  };

  const installConfiguredFooter = (ctx: ExtensionContext, next: FooterSettings): void => {
    installFooter(ctx, next);
    footerInstalled = true;
  };

  const clearConfiguredFooter = (ctx: ExtensionContext): void => {
    if (!footerInstalled) return;
    ctx.ui.setFooter(undefined);
    footerInstalled = false;
  };

  const applyLoaded = (ctx: ExtensionContext): ReturnType<typeof loadSettings> => {
    const loaded = loadSettings(agentDir());
    settings = loaded.settings;
    const locale = resolveLocale(settings.locale);
    const issue = loaded.error === "invalid-json"
      ? copyFor(locale).invalidSettings
      : loaded.error === "unreadable"
        ? copyFor(locale).unreadableSettings
        : loaded.invalidKeys.length > 0
          ? copyFor(locale).invalidFields(loaded.invalidKeys)
          : undefined;
    if (issue && !warnedInvalid) {
      warnedInvalid = true;
      ctx.ui.notify(issue, "warning");
    }
    return loaded;
  };

  const persist = (ctx: ExtensionContext, next: FooterSettings): boolean => {
    try {
      saveSettings(agentDir(), next);
      settings = next;
      warnedInvalid = false;
      return true;
    } catch {
      ctx.ui.notify(copyFor(resolveLocale(settings.locale)).writeFailed, "error");
      return false;
    }
  };

  const applyFooterSetting = (ctx: ExtensionContext, next: FooterSettings): void => {
    if (next.enabled) {
      installConfiguredFooter(ctx, next);
      return;
    }
    clearLegend(ctx);
    clearConfiguredFooter(ctx);
  };

  return (pi: ExtensionAPI): void => {
    pi.on("message_start", (event, ctx) => handleStream("start", event.message, Date.now(), ctx.sessionManager));
    pi.on("message_update", (event, ctx) => handleStream("update", event.message, Date.now(), ctx.sessionManager));
    pi.on("message_end", (event, ctx) => handleStream("end", event.message, Date.now(), ctx.sessionManager));

    // session_start 覆盖会话替换和 reload。enabled=false 时不装 footer，使 off 能活过 reload。
    pi.on("session_start", async (_event, ctx) => {
      resetStreamState(ctx.sessionManager);
      if (!footerSupported) {
        warnUnsupportedHost(ctx);
        return;
      }
      const current = applyLoaded(ctx).settings;
      if (current.enabled) installConfiguredFooter(ctx, current);
      else {
        clearLegend(ctx);
        clearConfiguredFooter(ctx);
      }
    });

    pi.on("session_shutdown", async (_event, ctx) => {
      resetStreamState(ctx.sessionManager);
      if (!footerSupported) return;
      clearLegend(ctx);
      clearConfiguredFooter(ctx);
    });

    pi.registerCommand("signal-footer", {
      description: "Show the status legend or toggle the readable footer (off/on persist)",
      handler: async (args, ctx) => {
        if (!footerSupported) {
          warnUnsupportedHost(ctx);
          return;
        }
        const parts = args.trim().split(/\s+/).filter(Boolean);
        const action = (parts[0] ?? "").toLowerCase();
        const loaded = applyLoaded(ctx);
        const current = loaded.settings;
        const text = copyFor(resolveLocale(current.locale));

        if (action === "" || action === "legend") {
          showLegend(ctx, resolveLocale(current.locale));
          return;
        }

        if (action === "help") {
          ctx.ui.notify(text.usage(SHOW_ITEM_TOKENS), "info");
          return;
        }

        if (action === "hide") {
          clearLegend(ctx);
          return;
        }

        if (action === "off") {
          if (!persist(ctx, { ...current, enabled: false })) return;
          clearLegend(ctx);
          clearConfiguredFooter(ctx);
          ctx.ui.notify(text.off, "info");
          return;
        }

        if (action === "on") {
          if (!persist(ctx, { ...current, enabled: true })) return;
          installConfiguredFooter(ctx, { ...current, enabled: true });
          ctx.ui.notify(text.on, "info");
          return;
        }

        if (action === "status") {
          const error = loaded.error ?? "none";
          const invalid = loaded.invalidKeys.join(", ") || "none";
          const items = SHOW_KEYS
            .map((key) => text.status.item(SHOW_TOKENS[key], text.status.value(current[key])))
            .join(" | ");
          ctx.ui.notify(
            join(agentDir(), SETTINGS_FILE)
              + " | " + text.status.enabled(text.status.value(current.enabled))
              + " | " + items
              + " | " + text.status.locale(resolveLocale(current.locale))
              + " | " + text.status.error(error)
              + " | " + text.status.invalid(invalid),
            "info",
          );
          return;
        }

        if (action === "locale") {
          const localeArg = parts[1]?.toLowerCase();
          if (localeArg !== "auto" && localeArg !== "zh" && localeArg !== "en") {
            ctx.ui.notify(text.localeUsage, "warning");
            return;
          }
          const locale: FooterLocale = localeArg;
          const next = { ...current, locale };
          const wasLegendVisible = legendVisible;
          if (!persist(ctx, next)) return;
          applyFooterSetting(ctx, next);
          if (wasLegendVisible) showLegend(ctx, resolveLocale(next.locale));
          ctx.ui.notify(copyFor(resolveLocale(next.locale)).localeChanged(resolveLocale(next.locale)), "info");
          return;
        }

        const chip = Object.hasOwn(CHIP_COMMANDS, action) ? CHIP_COMMANDS[action] : undefined;
        if (chip) {
          const raw = parts[1]?.toLowerCase();
          const value = raw === undefined ? undefined : parseToggle(raw);
          if (raw !== undefined && value === undefined) {
            ctx.ui.notify(text.itemUsage(SHOW_ITEM_TOKENS), "warning");
            return;
          }
          const next = { ...current, [chip]: value ?? !current[chip] };
          if (!persist(ctx, next)) return;
          applyFooterSetting(ctx, next);
          ctx.ui.notify(
            text.itemToggled(itemDisplayName(chip, resolveLocale(next.locale)), next[chip]),
            "info",
          );
          return;
        }

        ctx.ui.notify(text.usage(SHOW_ITEM_TOKENS), "warning");
      },
    });
  };
}

export default createExtension();
