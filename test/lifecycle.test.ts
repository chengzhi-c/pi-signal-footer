import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { handleStream, resolveHome } from "../footer.ts";
import { hostVersionTooOld } from "../index.ts";
import { SETTINGS_FILE } from "../settings.ts";

import {
  createApi,
  createContext,
  openFooter,
  pinLocale,
  renderLines,
  startSession,
  tempAgentDir,
  type FooterFactory,
} from "./harness.ts";

test("installs the footer exactly once per session start", async () => {
  const { handlers } = createApi();
  const context = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });
  await startSession(handlers, context);

  assert.equal(context.footerCalls.length, 1);
  // 分支监听在工厂被 pi 调用时才注册，这里先实例化一次
  openFooter(context);
  assert.equal(context.branchListeners.size, 1);

  // resources_discover 紧随 session_start，不能触发第二次安装。
  await handlers.get("resources_discover")?.({ type: "resources_discover", cwd: "C:\\work", reason: "startup" }, context.ctx);
  assert.equal(context.footerCalls.length, 1);
});

test("off stays off across session start in the same process", async () => {
  const { handlers, commands } = createApi();
  const context = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });
  await startSession(handlers, context);

  await commands.get("signal-footer")!("off", context.ctx);
  assert.equal(context.footerCalls.at(-1), undefined);

  await handlers.get("resources_discover")?.({ type: "resources_discover", cwd: "C:\\work", reason: "reload" }, context.ctx);
  assert.equal(context.footerCalls.at(-1), undefined, "resources_discover must not resurrect a footer the user turned off");

  await handlers.get("session_start")?.({ type: "session_start", reason: "new" }, context.ctx);
  assert.equal(context.footerCalls.at(-1), undefined, "persisted off must survive session_start");
});

test("unsubscribes the branch listener when the footer is disposed", async () => {
  const { handlers } = createApi();
  const context = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });
  await startSession(handlers, context);

  const footer = openFooter(context);
  assert.equal(context.branchListeners.size, 1);
  footer.dispose?.();
  assert.equal(context.branchListeners.size, 0);
});

test("reinstalls the footer when a replacement session starts", async () => {
  const { handlers } = createApi();
  const first = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });
  const second = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });

  await startSession(handlers, first);
  assert.equal(first.footerCalls.length, 1);

  await handlers.get("session_start")?.({ type: "session_start", reason: "resume" }, second.ctx);
  assert.equal(second.footerCalls.length, 1);
  assert.equal(typeof second.footerCalls.at(-1), "function");
  // 新 ctx 渲染出的仍是可用内容
  assert.match(renderLines(second).join("\n"), /gpt-test/);
});

test("hostVersionTooOld compares major.minor.patch without a semver library", () => {
  assert.equal(hostVersionTooOld("0.84.3"), true);
  assert.equal(hostVersionTooOld("0.84.4"), false);
  assert.equal(hostVersionTooOld("0.85.0"), false);
  assert.equal(hostVersionTooOld("1.0.0"), false);
  assert.equal(hostVersionTooOld("0.84.4-beta.1"), true);
  assert.equal(hostVersionTooOld("0.84.4+build.1"), false);
  assert.equal(hostVersionTooOld("0.84"), true);
  assert.equal(hostVersionTooOld("0.85"), false);
  assert.equal(hostVersionTooOld("not-a-version"), true);
});

test("unsupported hosts keep the native footer and avoid custom footer APIs", async () => {
  const { handlers, commands } = createApi(tempAgentDir(), "0.84.3");
  const context = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });

  await startSession(handlers, context);
  await startSession(handlers, context);
  assert.equal(context.footerCalls.length, 0);
  assert.equal(context.notifications.filter((item) => item.level === "warning").length, 1);

  await handlers.get("session_start")?.({ type: "session_start", reason: "reload" }, context.ctx);
  await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, context.ctx);
  await commands.get("signal-footer")?.("legend", context.ctx);
  await commands.get("signal-footer")!("on", context.ctx);
  await commands.get("signal-footer")!("locale en", context.ctx);
  await commands.get("signal-footer")!("branch off", context.ctx);
  assert.equal(context.notifications.filter((item) => item.level === "warning").length, 1);
  await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, context.ctx);
  assert.equal(context.footerCalls.length, 0);
  assert.equal(context.widgetCalls.length, 0);
});

test("unsupported hosts do not require notify to remain safe", async () => {
  const { handlers, commands } = createApi(tempAgentDir(), "0.84.3");
  const context = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });
  (context.ctx.ui as unknown as { notify?: unknown }).notify = undefined;

  await assert.doesNotReject(() => startSession(handlers, context));
  await assert.doesNotReject(async () => {
    await commands.get("signal-footer")!("legend", context.ctx);
  });
  assert.equal(context.footerCalls.length, 0);
  assert.equal(context.widgetCalls.length, 0);
});

test("minimum supported host installs and removes the custom footer", async () => {
  const { handlers } = createApi(tempAgentDir(), "0.84.4");
  const context = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });

  await startSession(handlers, context);
  assert.equal(context.footerCalls.length, 1);
  assert.equal(context.notifications.filter((item) => item.level === "warning").length, 0);

  await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, context.ctx);
  assert.equal(context.footerCalls.at(-1), undefined);
});

test("resolveHome survives homedir throwing without abbreviating to ~", () => {
  const savedHome = process.env.HOME;
  const savedProfile = process.env.USERPROFILE;
  process.env.USERPROFILE = "";
  delete process.env.HOME;
  try {
    const boom = () => {
      throw Object.assign(new Error("x"), { code: "ERR_SYSTEM_ERROR" });
    };
    assert.equal(resolveHome(boom), "");
  } finally {
    if (savedProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedProfile;
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  }
});

test("resolveHome falls back to USERPROFILE when HOME is empty", () => {
  const savedHome = process.env.HOME;
  const savedProfile = process.env.USERPROFILE;
  process.env.HOME = "";
  process.env.USERPROFILE = "C:\\Users\\dev";
  try {
    assert.equal(resolveHome(() => {
      throw new Error("home lookup failed");
    }), "C:\\Users\\dev");
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedProfile;
  }
});

test("keeps streaming rates isolated by session context", async () => {
  const { handlers } = createApi();
  const first = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });
  const second = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });
  await startSession(handlers, first);
  await startSession(handlers, second);

  const originalNow = Date.now;
  let now = 0;
  Date.now = () => now;
  try {
    await handlers.get("message_start")?.({ type: "message_start", message: { role: "assistant" } }, first.ctx);
    now = 100;
    await handlers.get("message_start")?.({ type: "message_start", message: { role: "assistant" } }, second.ctx);
    now = 1000;
    await handlers.get("message_update")?.({ type: "message_update", message: { role: "assistant" } }, first.ctx);
    now = 500;
    await handlers.get("message_update")?.({ type: "message_update", message: { role: "assistant" } }, second.ctx);
    now = 3000;
    await handlers.get("message_end")?.(
      { type: "message_end", message: { role: "assistant", usage: { output: 100 } } },
      first.ctx,
    );
    now = 2500;
    await handlers.get("message_end")?.(
      { type: "message_end", message: { role: "assistant", usage: { output: 200 } } },
      second.ctx,
    );
  } finally {
    Date.now = originalNow;
  }

  assert.match(renderLines(first, 160).join("\n"), /50 tok\/s/);
  assert.match(renderLines(second, 160).join("\n"), /100 tok\/s/);

  await handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "new" }, first.ctx);
  assert.match(renderLines(second, 160).join("\n"), /100 tok\/s/);
});

test("clears the previous response speed when a session shuts down", async () => {
  const { handlers } = createApi();
  const first = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });
  const originalNow = Date.now;
  await startSession(handlers, first);
  handleStream("start", { role: "assistant" }, 0, first.ctx.sessionManager);
  handleStream("update", { role: "assistant" }, 1000, first.ctx.sessionManager);
  handleStream("end", { role: "assistant", usage: { output: 100 } }, 3000, first.ctx.sessionManager);
  assert.equal(Date.now, originalNow);

  assert.match(renderLines(first).join("\n"), /50 tok\/s/);

  await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, first.ctx);

  const second = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });
  await startSession(handlers, second);
  assert.doesNotMatch(renderLines(second).join("\n"), /tok\/s/);
});

test("keeps the first-token timestamp when the first update lands at time zero", async () => {
  const { handlers } = createApi();
  const context = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });
  await startSession(handlers, context);

  // 首 token 落在 0ms：0 不能被当作「未记录」哨兵，否则会被后续 update 覆盖，
  // 把全程 2000ms 算成 1000ms（100 tok/s）。
  handleStream("start", { role: "assistant" }, 0, context.ctx.sessionManager);
  handleStream("update", { role: "assistant" }, 0, context.ctx.sessionManager);
  handleStream("update", { role: "assistant" }, 1000, context.ctx.sessionManager);
  handleStream("end", { role: "assistant", usage: { output: 100 } }, 2000, context.ctx.sessionManager);

  assert.match(renderLines(context, 160).join("\n"), /50 tok\/s/);
});

test("locale en uses English turn labels", async () => {
  const { handlers, commands } = createApi();
  const context = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });
  context.entries.push({ type: "message", timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user" } });
  await startSession(handlers, context);
  await commands.get("signal-footer")!("locale en", context.ctx);
  const output = renderLines(context, 160).join("\n");
  assert.match(output, /1 turn/);
  assert.doesNotMatch(output, /轮/);
});

test("refreshes a visible legend immediately when locale changes", async () => {
  const { handlers, commands, agentDir } = createApi();
  // 先固定 zh：默认 locale 跟随宿主环境，en-US 机器上「输入」断言会落空。
  pinLocale(agentDir, "zh");
  const context = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });
  await startSession(handlers, context);
  const command = commands.get("signal-footer")!;

  await command("legend", context.ctx);
  const before = context.widgetCalls.at(-1);
  assert.ok(before?.content?.some((line) => line.includes("输入")));

  await command("locale en", context.ctx);
  const after = context.widgetCalls.at(-1);
  assert.equal(after?.key, before?.key);
  assert.ok(after?.content?.some((line) => line.includes("in") && line.includes("out")));
  assert.ok(!after?.content?.some((line) => line.includes("输入")));
});

test("refreshes an explicitly opened legend when the footer is disabled", async () => {
  const { handlers, commands, agentDir } = createApi();
  pinLocale(agentDir, "zh");
  const context = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });
  await startSession(handlers, context);
  const command = commands.get("signal-footer")!;

  await command("off", context.ctx);
  await command("legend", context.ctx);
  await command("locale en", context.ctx);

  const after = context.widgetCalls.at(-1);
  assert.ok(after?.content?.some((line) => line.includes("in") && line.includes("out")));
  assert.ok(!after?.content?.some((line) => line.includes("输入")));
  assert.equal(context.footerCalls.at(-1), undefined);
});

test("off persists across a fresh extension load", async () => {
  const agentDir = tempAgentDir();
  const first = createApi(agentDir);
  const context = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });
  await startSession(first.handlers, context);
  await first.commands.get("signal-footer")!("off", context.ctx);
  assert.equal(context.footerCalls.at(-1), undefined);
  assert.equal(JSON.parse(readFileSync(join(agentDir, SETTINGS_FILE), "utf8")).enabled, false);

  const reloaded = createApi(agentDir);
  const next = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });
  await startSession(reloaded.handlers, next);
  assert.equal(next.footerCalls.at(-1), undefined, "a new module load must honor enabled:false");
});

test("session_start removes an installed footer when reloaded settings disable it", async () => {
  const agentDir = tempAgentDir();
  const { handlers } = createApi(agentDir);
  const context = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });

  await startSession(handlers, context);
  assert.equal(typeof context.footerCalls.at(-1), "function");

  writeFileSync(join(agentDir, SETTINGS_FILE), JSON.stringify({ enabled: false }), "utf8");
  await startSession(handlers, context);

  assert.equal(context.footerCalls.at(-1), undefined, "reloading disabled settings must restore the native footer");
});

test("does not clear an existing footer when starting disabled", async () => {
  const agentDir = tempAgentDir();
  writeFileSync(join(agentDir, SETTINGS_FILE), JSON.stringify({ enabled: false }), "utf8");
  const { handlers } = createApi(agentDir);
  const context = createContext({ tokens: 0, contextWindow: 1000, percent: 0 });
  const otherFooter = (() => {}) as unknown as FooterFactory;
  context.ctx.ui.setFooter(otherFooter);

  await startSession(handlers, context);

  assert.equal(context.footerCalls.at(-1), otherFooter, "disabled startup must not clear another footer");
});
