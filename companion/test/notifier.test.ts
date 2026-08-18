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

it("drains a non-200 response and reconnects instead of reading it as a stream", async () => {
  const received: any[] = [];
  let connections = 0;
  const notifyFrame = JSON.stringify({
    kind: "notify",
    notification: { kind: "done", botId: "b1", botName: "Coder", threadId: "t1", title: "Coder finished", body: "shipped it" },
  });
  const server = createServer((_req, res) => {
    connections++;
    if (connections === 1) {
      // The harness mid-restart, or a proxy's 502 — not a stream to read.
      res.writeHead(503);
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${notifyFrame}\n\n`);
    // hold the stream open; the notifier owns reconnects
  });
  servers.push(server);
  const harnessPort = await new Promise<number>((r) => server.listen(0, "127.0.0.1", () => r((server.address() as any).port)));
  const relayPort = await fakeRelay(received);
  const notifier = startNotifier({
    harnessPort,
    relayUrl: `http://127.0.0.1:${relayPort}`,
    pushTokens: () => ["ab".repeat(32)],
    backoffMinMs: 20,
  });
  await expect.poll(() => received.length).toBe(1);
  notifier.stop();
  expect(connections).toBeGreaterThanOrEqual(2);
  expect(received[0]).toEqual({ deviceTokens: ["ab".repeat(32)], kind: "done", botName: "Coder" });
});

it("delivers a notify frame whose JSON is split across two chunks", async () => {
  const received: any[] = [];
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {"kind":"noti');
    setTimeout(() => {
      res.write(
        'fy","notification":{"kind":"approval","botId":"b1","botName":"Reviewer","threadId":"t1","title":"x","body":"rm -rf?"}}\n\n',
      );
      // hold the stream open; the notifier owns reconnects
    }, 20);
  });
  servers.push(server);
  const harnessPort = await new Promise<number>((r) => server.listen(0, "127.0.0.1", () => r((server.address() as any).port)));
  const relayPort = await fakeRelay(received);
  const notifier = startNotifier({
    harnessPort,
    relayUrl: `http://127.0.0.1:${relayPort}`,
    pushTokens: () => ["ab".repeat(32)],
  });
  await expect.poll(() => received.length).toBe(1);
  notifier.stop();
  expect(received[0]).toEqual({ deviceTokens: ["ab".repeat(32)], kind: "approval", botName: "Reviewer" });
});

it("stops retrying once stop() is called, even with a retry timer pending", async () => {
  let connections = 0;
  const server = createServer((_req, res) => {
    connections++;
    res.destroy(); // kill the connection immediately, forcing a retry
  });
  servers.push(server);
  const harnessPort = await new Promise<number>((r) => server.listen(0, "127.0.0.1", () => r((server.address() as any).port)));
  const relayPort = await fakeRelay([]);
  const notifier = startNotifier({
    harnessPort,
    relayUrl: `http://127.0.0.1:${relayPort}`,
    pushTokens: () => [],
    backoffMinMs: 20,
  });
  await expect.poll(() => connections).toBeGreaterThanOrEqual(1);
  notifier.stop();
  const countAtStop = connections;
  // Longer than several backoff intervals — if stop() only stopped the
  // in-flight request and not the pending retry timer, this would catch it.
  await new Promise((r) => setTimeout(r, 300));
  expect(connections).toBe(countAtStop);
});
