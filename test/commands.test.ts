import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { handleStream } from "../footer.ts";
import { loadSettings, SETTINGS_FILE } from "../settings.ts";

import {
  createApi,
  createContext,
  pinLocale,
  renderLines,
  setField,
  startSession,
  tempAgentDir,
} from "./harness.ts";

test("handles legend, hide, and invalid command arguments", async () => {
  const { handlers, commands } = createApi();
  const context = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });
  await startSession(handlers, context);
  const command = commands.get("signal-footer")!;

  await command("legend", context.ctx);
  assert.equal(context.widgetCalls.at(-1)?.key, "pi-signal-footer-legend");
  assert.ok((context.widgetCalls.at(-1)?.content?.length ?? 0) > 0);

  await command("hide", context.ctx);
  assert.equal(context.widgetCalls.at(-1)?.content, undefined);

  await command("unknown", context.ctx);
  assert.equal(context.notifications.at(-1)?.level, "warning");
});

test("item commands toggle, flip, and reject bad values", async () => {
  const { handlers, commands, agentDir } = createApi();
  pinLocale(agentDir, "zh");
  const context = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });
  await startSession(handlers, context);
  const command = commands.get("signal-footer")!;

  await command("path off", context.ctx);
  assert.equal(context.notifications.at(-1)?.message, "路径已隐藏");
  assert.doesNotMatch(renderLines(context, 160).join("\n"), /C:\/work\/demo/);

  await command("path", context.ctx);
  assert.equal(context.notifications.at(-1)?.message, "路径已显示");
  assert.match(renderLines(context, 160).join("\n"), /C:\/work\/demo/);

  await command("path banana", context.ctx);
  assert.equal(context.notifications.at(-1)?.level, "warning");
  assert.match(renderLines(context, 160).join("\n"), /C:\/work\/demo/, "an invalid value must not change state");

  await command("path true", context.ctx);
  assert.equal(context.notifications.at(-1)?.level, "warning");
  assert.match(renderLines(context, 160).join("\n"), /C:\/work\/demo/, "true/false/1/0 are not toggle values");
});

test("rejects undocumented setting-key command aliases", async () => {
  const { handlers, commands, agentDir } = createApi();
  const context = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });
  await startSession(handlers, context);

  await commands.get("signal-footer")!("showproject off", context.ctx);
  assert.equal(context.notifications.at(-1)?.level, "warning");
  assert.match(renderLines(context, 160).join("\n"), /C:\/work\/demo/);
  assert.equal(existsSync(join(agentDir, SETTINGS_FILE)), false);
});

test("reserved object-property commands warn without changing settings", async () => {
  const agentDir = tempAgentDir();
  const { handlers, commands } = createApi(agentDir);
  const context = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });
  await startSession(handlers, context);
  const command = commands.get("signal-footer")!;

  for (const action of ["constructor", "__proto__", "toString"]) {
    await command(action, context.ctx);
    assert.equal(context.notifications.at(-1)?.level, "warning", `${action} must be rejected`);
  }

  assert.equal(existsSync(join(agentDir, SETTINGS_FILE)), false, "rejected commands must not persist settings");
});

test("help prints the command surface instead of the legend", async () => {
  const { handlers, commands, agentDir } = createApi();
  pinLocale(agentDir, "en");
  const context = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });
  await startSession(handlers, context);

  await commands.get("signal-footer")!("help", context.ctx);
  const note = context.notifications.at(-1);
  assert.equal(note?.level, "info");
  assert.match(note?.message ?? "", /Usage: .*path\|session/);
  assert.ok(context.widgetCalls.every((call) => call.key !== "pi-signal-footer-legend"));
});

test("off clears the legend and shutdown clears both", async () => {
  const { handlers, commands } = createApi();
  const context = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });
  await startSession(handlers, context);
  const command = commands.get("signal-footer")!;

  await command("legend", context.ctx);
  await command("off", context.ctx);
  assert.equal(context.widgetCalls.at(-1)?.content, undefined, "off must also drop the legend");
  assert.equal(context.footerCalls.at(-1), undefined);

  await command("legend", context.ctx);
  await handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "new" }, context.ctx);
  assert.equal(context.widgetCalls.at(-1)?.content, undefined);
  assert.equal(context.footerCalls.at(-1), undefined);
});

test("showSessionName works independently of showProject", async () => {
  const { handlers, commands } = createApi();
  const context = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });
  context.ctx.sessionManager.getSessionName = () => "fix-context-bar";
  await startSession(handlers, context);

  await setField(commands, context.ctx, "path", "off");
  await setField(commands, context.ctx, "session", "on");
  {
    const output = renderLines(context, 160).join("\n");
    assert.ok(output.includes("fix-context-bar"), "session name must survive with the project path disabled");
    assert.ok(!output.includes("C:/work/demo"), "project path itself stays hidden");
  }

  await setField(commands, context.ctx, "path", "on");
  await setField(commands, context.ctx, "session", "off");
  {
    const output = renderLines(context, 160).join("\n");
    assert.ok(output.includes("demo"));
    assert.ok(!output.includes("fix-context-bar"));
  }

  await setField(commands, context.ctx, "path", "off");
  await setField(commands, context.ctx, "session", "off");
  {
    const output = renderLines(context, 160).join("\n");
    assert.ok(!output.includes("fix-context-bar"));
    assert.ok(!output.includes("demo"));
  }
});

test("showBranch and showTurns toggles take effect", async () => {
  const { handlers, commands, agentDir } = createApi();
  const context = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });
  context.footerData.getGitBranch = () => "main";
  context.entries.push({ type: "message", timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user" } });
  await startSession(handlers, context);

  await setField(commands, context.ctx, "branch", "on");
  assert.match(renderLines(context, 160).join("\n"), /⎇ main/);
  await setField(commands, context.ctx, "branch", "off");
  assert.doesNotMatch(renderLines(context, 160).join("\n"), /⎇ main/);
  assert.equal(loadSettings(agentDir).settings.showBranch, false);
  await setField(commands, context.ctx, "turns", "off");
  assert.doesNotMatch(renderLines(context, 160).join("\n"), /1轮/);
});

test("showDuration, showSpeed and showCacheRatio toggles take effect", async () => {
  const { handlers, commands } = createApi();
  const context = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });
  context.entries.push(
    { type: "message", timestamp: "2026-01-01T00:01:00.000Z", message: { role: "user" } },
    {
      type: "message",
      timestamp: "2026-01-01T00:02:00.000Z",
      message: { role: "assistant", usage: { input: 10, output: 50, cacheRead: 900, cacheWrite: 100, cost: { total: 0.01 } } },
    },
  );
  const originalNow = Date.now;
  await startSession(handlers, context);
  handleStream("start", { role: "assistant" }, 0, context.ctx.sessionManager);
  handleStream("update", { role: "assistant" }, 1000, context.ctx.sessionManager);
  handleStream("end", { role: "assistant", usage: { output: 100 } }, 3000, context.ctx.sessionManager);
  assert.equal(Date.now, originalNow);

  const all = renderLines(context, 160).join("\n");
  assert.match(all, /◷ 1m/);
  assert.match(all, /↻ 900 \(90%\)/);
  assert.match(all, /50 tok\/s/);

  await setField(commands, context.ctx, "time", "off");
  {
    const out = renderLines(context, 160).join("\n");
    assert.doesNotMatch(out, /◷ 1m/);
    assert.match(out, /50 tok\/s/, "turning off the span must not drop the rate");
  }
  await setField(commands, context.ctx, "time", "on");
  await setField(commands, context.ctx, "speed", "off");
  {
    const out = renderLines(context, 160).join("\n");
    assert.doesNotMatch(out, /tok\/s/);
    assert.match(out, /◷ 1m/, "turning off the rate must not drop the span");
  }
  await setField(commands, context.ctx, "speed", "on");
  await setField(commands, context.ctx, "cache", "off");
  {
    const out = renderLines(context, 160).join("\n");
    assert.doesNotMatch(out, /\(90%\)/);
    assert.match(out, /↻ 900/, "the read count itself must stay visible");
  }
});

test("configuration changes clear an active footer when the loaded settings disable it", async () => {
  const agentDir = tempAgentDir();
  const { handlers, commands } = createApi(agentDir);
  const context = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });

  await startSession(handlers, context);
  assert.equal(typeof context.footerCalls.at(-1), "function");

  writeFileSync(join(agentDir, SETTINGS_FILE), JSON.stringify({ enabled: false }), "utf8");
  await commands.get("signal-footer")!("branch off", context.ctx);

  assert.equal(context.footerCalls.at(-1), undefined);
});

test("disabling loaded settings also clears a visible legend", async () => {
  const agentDir = tempAgentDir();
  const { handlers, commands } = createApi(agentDir);
  const context = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });

  await startSession(handlers, context);
  await commands.get("signal-footer")!("legend", context.ctx);
  writeFileSync(join(agentDir, SETTINGS_FILE), JSON.stringify({ enabled: false }), "utf8");
  await commands.get("signal-footer")!("branch off", context.ctx);

  assert.equal(context.footerCalls.at(-1), undefined);
  assert.equal(context.widgetCalls.at(-1)?.content, undefined);
});

test("invalid settings JSON falls back to defaults and notifies once", async () => {
  const agentDir = tempAgentDir();
  writeFileSync(join(agentDir, SETTINGS_FILE), "{not json", "utf8");
  const { handlers } = createApi(agentDir);
  const context = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });
  await startSession(handlers, context);
  assert.match(renderLines(context, 160).join("\n"), /gpt-test/);
  assert.equal(context.notifications.filter((item) => item.level === "warning").length, 1);
  renderLines(context, 160);
  assert.equal(context.notifications.filter((item) => item.level === "warning").length, 1);
});

test("status reports file-level settings load errors separately from invalid fields", async () => {
  const agentDir = tempAgentDir();
  writeFileSync(join(agentDir, SETTINGS_FILE), "{not json", "utf8");
  const { handlers, commands } = createApi(agentDir);
  const context = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });

  await startSession(handlers, context);
  await commands.get("signal-footer")!("status", context.ctx);
  const status = context.notifications.at(-1)?.message ?? "";
  assert.match(status, /invalid-json/);
  assert.match(status, /none/);
});

test("status uses the selected locale for its fixed labels", async () => {
  const agentDir = tempAgentDir();
  pinLocale(agentDir, "zh");
  const { handlers, commands } = createApi(agentDir);
  const context = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });

  await startSession(handlers, context);
  await commands.get("signal-footer")!("status", context.ctx);
  const status = context.notifications.at(-1)?.message ?? "";
  assert.match(status, /启用|语言|错误|无效/);
  assert.doesNotMatch(status, /enabled:|locale:|error:|invalid:/);
});

test("reports invalid setting fields and exposes diagnostics in status", async () => {
  const agentDir = tempAgentDir();
  writeFileSync(join(agentDir, SETTINGS_FILE), JSON.stringify({ enabled: "false", locale: "en" }), "utf8");
  const { handlers, commands } = createApi(agentDir);
  const context = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });

  await startSession(handlers, context);
  const warning = context.notifications.find((item) => item.level === "warning");
  assert.ok(warning);
  assert.match(warning.message, /enabled/);
  assert.doesNotMatch(warning.message, /无法解析|Could not parse/);

  await commands.get("signal-footer")!("status", context.ctx);
  const status = context.notifications.at(-1)?.message ?? "";
  assert.match(status, /pi-signal-footer\.json/);
  assert.match(status, /enabled: on/);
  assert.match(status, /locale: en/);
  assert.match(status, /invalid: enabled/);
  assert.match(status, /branch: on/, "status must list per-item switch states");
});

test("a successful settings write clears the prior diagnostic warning state", async () => {
  const agentDir = tempAgentDir();
  writeFileSync(join(agentDir, SETTINGS_FILE), JSON.stringify({ enabled: "false" }), "utf8");
  const { handlers, commands } = createApi(agentDir);
  const context = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });

  await startSession(handlers, context);
  assert.equal(context.notifications.filter((item) => item.level === "warning").length, 1);

  await commands.get("signal-footer")!("branch off", context.ctx);
  writeFileSync(join(agentDir, SETTINGS_FILE), JSON.stringify({ enabled: "false" }), "utf8");
  await commands.get("signal-footer")!("status", context.ctx);
  assert.equal(context.notifications.filter((item) => item.level === "warning").length, 2);
});

test("warns again after a repaired settings file becomes invalid", async () => {
  const agentDir = tempAgentDir();
  writeFileSync(join(agentDir, SETTINGS_FILE), "{not json", "utf8");
  const { handlers, commands } = createApi(agentDir);
  const context = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });
  const command = commands.get("signal-footer")!;
  const warnings = () => context.notifications.filter((item) => item.level === "warning").length;

  await startSession(handlers, context);
  assert.equal(warnings(), 1);

  writeFileSync(join(agentDir, SETTINGS_FILE), JSON.stringify({ enabled: true }), "utf8");
  await command("status", context.ctx);
  assert.equal(warnings(), 1);

  writeFileSync(join(agentDir, SETTINGS_FILE), "{not json", "utf8");
  await command("status", context.ctx);
  assert.equal(warnings(), 2);
});

test("does not claim success or change the footer when settings cannot be written", async () => {
  const parent = tempAgentDir();
  const agentDir = join(parent, "agent-file");
  writeFileSync(agentDir, "original", "utf8");
  const { handlers, commands } = createApi(agentDir);
  const context = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });

  await startSession(handlers, context);
  const installed = context.footerCalls.at(-1);
  await commands.get("signal-footer")!("off", context.ctx);

  assert.equal(context.footerCalls.at(-1), installed);
  assert.equal(readFileSync(agentDir, "utf8"), "original");
  assert.equal(context.notifications.at(-1)?.level, "error");
  assert.doesNotMatch(context.notifications.map((item) => item.message).join("\n"), /已关闭|disabled/);
});
