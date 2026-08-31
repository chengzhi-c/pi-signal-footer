import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import test from "node:test";

import {
  discoverAndLoadExtensions,
  type ExtensionContext,
  type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";

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

    const footerCalls: unknown[] = [];
    const widgetCalls: Array<{ key: string; content: string[] | undefined }> = [];
    const notifications: unknown[] = [];
    const ui = {
      setFooter: (factory: unknown) => footerCalls.push(factory),
      setWidget: (key: string, content: string[] | undefined) => widgetCalls.push({ key, content }),
      notify: (message: string, level: string) => notifications.push({ message, level }),
    } as unknown as ExtensionUIContext;
    const ctx = { ui } as unknown as ExtensionContext;

    const startHandlers = extension.handlers.get("session_start") ?? [];
    const shutdownHandlers = extension.handlers.get("session_shutdown") ?? [];
    assert.equal(startHandlers.length, 1);
    assert.equal(shutdownHandlers.length, 1);

    await startHandlers[0]!({ type: "session_start", reason: "startup" }, ctx);
    assert.equal(footerCalls.length, 1);
    assert.equal(notifications.length, 0);

    await shutdownHandlers[0]!({ type: "session_shutdown" }, ctx);
    assert.equal(footerCalls.at(-1), undefined);
    assert.deepEqual(widgetCalls, [{ key: "pi-signal-footer-legend", content: undefined }]);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(agentDir, { recursive: true, force: true });
  }
});
