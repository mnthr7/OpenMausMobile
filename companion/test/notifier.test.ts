// Notifier contract: forward notify frames from the harness's own SSE
// stream to the relay as {deviceTokens, kind, botName}, and nothing else.
import { createServer } from "node:http";
import { afterEach, expect, it } from "vitest";

import { startNotifier } from "../src/notifier.ts";

const servers: Array<{ close: () => void }> = [];
afterEach(() => { for (const s of servers.splice(0)) s.close(); });

function fakeHarness(frames: string[]) {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const f of frames) res.write(`data: ${f}\n\n`);
    // hold the stream open; the notifier owns reconnects
  });
  servers.push(server);
  return new Promise<number>((r) => server.listen(0, "127.0.0.1", () => r((server.address() as any).port)));
}

function fakeRelay(received: unknown[]) {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => { received.push(JSON.parse(body)); res.writeHead(202); res.end("{}"); });
  });
  servers.push(server);
  return new Promise<number>((r) => server.listen(0, "127.0.0.1", () => r((server.address() as any).port)));
}

it("forwards notify frames as {deviceTokens, kind, botName} and ignores everything else", async () => {
  const received: any[] = [];
  const harnessPort = await fakeHarness([
    JSON.stringify({ kind: "message", message: { id: "m1" } }),
    JSON.stringify({
      kind: "notify",
      notification: {
        kind: "approval",
        botId: "b1",
        botName: "Reviewer",
        threadId: "t1",
        title: "Reviewer needs approval",
        body: "rm -rf?",
      },
    }),
  ]);
  const relayPort = await fakeRelay(received);
  const notifier = startNotifier({
    harnessPort, relayUrl: `http://127.0.0.1:${relayPort}`,
    pushTokens: () => ["ab".repeat(32)],
  });
  await expect.poll(() => received.length).toBe(1);
  notifier.stop();
  expect(received[0]).toEqual({ deviceTokens: ["ab".repeat(32)], kind: "approval", botName: "Reviewer" });
});

it("sends nothing when no device has a push token", async () => {
  const received: any[] = [];
  const harnessPort = await fakeHarness([
    JSON.stringify({
      kind: "notify",
      notification: { kind: "done", botId: "b1", botName: "Coder", threadId: "t1", title: "Coder finished", body: "" },
    }),
  ]);
  const relayPort = await fakeRelay(received);
  const notifier = startNotifier({ harnessPort, relayUrl: `http://127.0.0.1:${relayPort}`, pushTokens: () => [] });
  await new Promise((r) => setTimeout(r, 300));
  notifier.stop();
  expect(received).toEqual([]);
});
