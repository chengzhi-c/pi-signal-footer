import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import test from "node:test";

import {
  discoverAndLoadExtensions,
  SessionManager,
  type ExtensionContext,
  type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";

import { createTheme, type FooterFactory } from "./harness.ts";

const EXTENSION_PATH = fileURLToPath(new URL("../index.ts", import.meta.url));

test("loads through Pi's official extension loader and runs the footer lifecycle", async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-signal-footer-loader-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;

  try {
    const loaded = await discoverAndLoadExtensions([EXTENSION_PATH], agentDir, agentDir);
    assert.deepEqual(loaded.errors, []);
    const extension = loaded.extensions[0];
    assert.ok(extension);
    assert.ok(extension.commands.has("signal-footer"));

    const sessionManager = SessionManager.inMemory(agentDir);
    loaded.runtime.appendEntry = (customType, data) => { sessionManager.appendCustomEntry(customType, data); };
    const footerCalls: unknown[] = [];
    const widgetCalls: Array<{ key: string; content: string[] | undefined }> = [];
    const notifications: unknown[] = [];
    const ui = {
      setFooter: (factory: unknown) => footerCalls.push(factory),
      setWidget: (key: string, content: string[] | undefined) => widgetCalls.push({ key, content }),
      notify: (message: string, level: string) => notifications.push({ message, level }),
    } as unknown as ExtensionUIContext;
    const ctx = {
      ui, sessionManager, isIdle: () => true,
      model: { provider: "test", id: "gpt-test", contextWindow: 1000 },
      getContextUsage: () => ({ tokens: 0, contextWindow: 1000, percent: 0 }),
    } as unknown as ExtensionContext;

    const startHandlers = extension.handlers.get("session_start") ?? [];
    const shutdownHandlers = extension.handlers.get("session_shutdown") ?? [];
    assert.equal(startHandlers.length, 1);
    assert.equal(shutdownHandlers.length, 1);

    await startHandlers[0]!({ type: "session_start", reason: "startup" }, ctx);
    assert.equal(footerCalls.length, 1);
    assert.equal(notifications.length, 0);
    await extension.handlers.get("agent_start")![0]!({ type: "agent_start" }, ctx);
    assert.equal(sessionManager.getEntries().filter((entry) => entry.type === "custom").length, 1);
    assert.deepEqual(sessionManager.buildSessionContext().messages, [], "work boundary does not enter model context");
    assert.notEqual(sessionManager.getEntries(), sessionManager.getEntries(), "SDK returns shallow array copies");
    const factory = footerCalls[0] as FooterFactory;
    const footer = factory({ requestRender() {} }, createTheme(), {
      getGitBranch: () => null, getExtensionStatuses: () => new Map(), onBranchChange: () => () => {},
    });
    const read = () => footer.render(160).join("\n");
    const message: Parameters<SessionManager["appendMessage"]>[0] = {
      role: "assistant", api: "openai-completions", provider: "test", model: "gpt-test", timestamp: Date.now(),
      stopReason: "stop", content: [{ type: "text", text: "abcd" }],
      usage: { input: 10, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 110,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    await extension.handlers.get("message_start")![0]!({ type: "message_start", message }, ctx);
    await extension.handlers.get("message_update")![0]!({ type: "message_update", message } as never, ctx);
    await extension.handlers.get("message_end")![0]!({ type: "message_end", message }, ctx);
    assert.match(read(), /↑ 0 \+100/);
    sessionManager.appendCustomEntry("unrelated-extension");
    assert.match(read(), /↑ 0 \+100/);
    sessionManager.appendMessage(message);
    const landed = sessionManager.getEntries().at(-1);
    assert.ok(landed?.type === "message");
    assert.equal(landed.message, message, "SDK keeps the final message reference");
    assert.match(read(), /↑ 100/);
    assert.doesNotMatch(read(), /≈?\+100/);
    footer.dispose?.();

    await shutdownHandlers[0]!({ type: "session_shutdown" }, ctx);
    assert.equal(footerCalls.at(-1), undefined);
    assert.deepEqual(widgetCalls, [{ key: "pi-signal-footer-legend", content: undefined }]);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(agentDir, { recursive: true, force: true });
  }
});
