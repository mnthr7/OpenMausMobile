// Watches the harness's own SSE stream for notify frames and forwards the
// bare minimum to the Qurelay relay: which devices, what kind, which bot.
// Content never leaves the box. Env-gated: no relay URL, no process.
import { get } from "node:http";

/** Shape of `server/notify.ts`'s `Notification`, as it arrives over the
 * harness's SSE stream inside a `{kind: "notify", notification}` frame. Only
 * `kind` and `botName` make the trip to the relay — `title`/`body` are the
 * content this exists to keep off the wire. */
interface HarnessNotification {
  kind?: string;
  botName?: string;
}

export interface NotifierOptions {
  harnessPort: number;
  relayUrl: string;
  pushTokens: () => string[];
}

const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

export function startNotifier({ harnessPort, relayUrl, pushTokens }: NotifierOptions): { stop(): void } {
  let stopped = false;
  let backoff = BACKOFF_MIN_MS;
  let request: ReturnType<typeof get> | null = null;

  const deliver = (notification: HarnessNotification) => {
    const deviceTokens = pushTokens();
    if (deviceTokens.length === 0) return;
    fetch(`${relayUrl}/notify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        deviceTokens,
        kind: notification.kind ?? "notify",
        botName: notification.botName ?? "",
      }),
    }).catch(() => { /* relay down: push degrades, nothing else does */ });
  };

  const connect = () => {
    if (stopped) return;
    request = get(
      { host: "127.0.0.1", port: harnessPort, path: "/api/events?screens=off" },
      (res) => {
        backoff = BACKOFF_MIN_MS;
        let buffer = "";
        res.on("data", (chunk: Buffer) => {
          buffer += chunk.toString("utf8");
          let split;
          while ((split = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, split); buffer = buffer.slice(split + 1);
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).startsWith(" ") ? line.slice(6) : line.slice(5);
            try {
              const frame = JSON.parse(payload);
              if (frame?.kind === "notify" && frame.notification) deliver(frame.notification);
            } catch { /* partial or non-JSON data line — not ours to fix */ }
          }
        });
        res.on("end", retry);
        res.on("error", retry);
      },
    );
    request.on("error", retry);
  };

  const retry = () => {
    if (stopped) return;
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
  };

  connect();
  return { stop() { stopped = true; request?.destroy(); } };
}
