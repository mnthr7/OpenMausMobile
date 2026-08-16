// App Settings → Companion. Turning this on opens a second, authenticated
// port so a phone on the same network can reach the harness; everything
// else in the app keeps talking to 127.0.0.1 exactly as before.
//
// The panel is deliberately blunt about what it does. "Your bots can run
// shell commands" is the honest reason a network switch here deserves a
// sentence of explanation rather than a bare toggle.
import { useCallback, useEffect, useState } from "react";
import { Loader2, Smartphone, Trash2 } from "lucide-react";
import { Card } from "./SettingsPrimitives";

interface Device {
  id: string;
  name: string;
  createdAt: number;
  lastSeenAt: number;
}

interface RemoteState {
  enabled: boolean;
  port: number;
  addresses: string[];
  error?: string;
  pairing: { code: string; expiresAt: number } | null;
  devices: Device[];
  /** Bonjour: when advertising, the phone finds this computer by name. */
  discovery: { advertising: boolean; name: string; type: string };
}

const relative = (at: number) => {
  const seconds = Math.round((Date.now() - at) / 1000);
  if (seconds < 90) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
};

export function CompanionSection() {
  const [state, setState] = useState<RemoteState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    try {
      setState(await (await fetch("/api/remote")).json());
    } catch {
      /* the harness is down; the rest of the app already says so */
    }
  }, []);

  const act = async (path: string, method = "POST") => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(path, { method, headers: { "content-type": "application/json" } });
      const body = await res.json();
      if (!res.ok) setError(body?.error ?? "that didn't work");
      // every one of these routes answers with the whole companion state
      if (body?.devices) setState(body);
      else await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void load();
  }, [load]);

  // While a code is on screen it has to count down — and the same tick is
  // what notices the phone on the other end finishing the handshake.
  useEffect(() => {
    if (!state?.pairing) return;
    const timer = window.setInterval(() => {
      setNow(Date.now());
      void load();
    }, 1000);
    return () => window.clearInterval(timer);
  }, [state?.pairing, load]);

  if (!state) {
    return (
      <Card title="Companion" subtitle="Loading…">
        <Loader2 size={15} className="animate-spin text-ink-secondary" />
      </Card>
    );
  }

  const secondsLeft = state.pairing ? Math.max(0, Math.round((state.pairing.expiresAt - now) / 1000)) : 0;
  const address = state.addresses[0];

  return (
    <div className="flex flex-col gap-4">
      <Card
        title="Companion"
        subtitle="Let a phone on this network open your chats, answer approvals, and send new work. Off by default: your bots run commands on this computer, so only pair a device you trust, on a network you trust."
      >
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="text-[14px] text-ink">{state.enabled ? "On" : "Off"}</div>
            <div className="mt-0.5 text-[13px] text-ink-secondary">
              {!state.enabled
                ? "The harness stays on 127.0.0.1 only."
                : !address
                  ? `Listening on port ${state.port} — no network address yet.`
                  : state.discovery?.advertising
                    ? // The address is shown even when Bonjour is working.
                      // Discovery can be advertising happily and still not
                      // reach the phone — a guest network that isolates its
                      // clients blocks multicast — and when that happens the
                      // typed address is the way out. Hiding it behind a
                      // failure the panel cannot detect is no help at all.
                      `Your phone will find this computer as "${state.discovery.name}", or you can enter ${address}:${state.port}.`
                    : `Listening on ${address}:${state.port} — enter that on your phone.`}
            </div>
          </div>
          <button
            role="switch"
            aria-checked={state.enabled}
            aria-label="Companion"
            disabled={busy}
            onClick={() => void act(state.enabled ? "/api/remote/disable" : "/api/remote/enable")}
            className={cnSwitch(state.enabled)}
          >
            <span className={cnKnob(state.enabled)} />
          </button>
        </div>
        {(error || state.error) && (
          <div className="mt-3 text-[13px] text-danger">{error ?? state.error}</div>
        )}
      </Card>

      {state.enabled && (
        <Card
          title="Pair a phone"
          subtitle={
            state.pairing
              ? state.discovery?.advertising
                ? "Open OpenMausBot on your phone, pick this computer from the list, and enter the code."
                : "Open OpenMausBot on your phone, enter the address below, then the code."
              : "Start pairing, then enter the code on your phone. The code lasts two minutes."
          }
        >
          {state.pairing ? (
            <div className="flex items-center justify-between gap-4">
              <div>
                <div className="font-mono text-[28px] tracking-[0.3em] text-ink">{state.pairing.code}</div>
                <div className="mt-1 text-[13px] text-ink-secondary">
                  Expires in {secondsLeft}s{address ? ` · ${address}:${state.port}` : ""}
                </div>
              </div>
              <button
                disabled={busy}
                onClick={() => void act("/api/remote/pairing", "DELETE")}
                className="rounded-lg border border-hairline/40 px-3 py-1.5 text-[13px] text-ink hover:bg-raised disabled:opacity-40"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              disabled={busy}
              onClick={() => void act("/api/remote/pairing")}
              className="rounded-lg border border-hairline/40 px-3 py-1.5 text-[13px] text-ink hover:bg-raised disabled:opacity-40"
            >
              Start pairing
            </button>
          )}
        </Card>
      )}

      <Card
        title="Paired devices"
        subtitle={
          state.devices.length
            ? "Removing a device signs it out immediately."
            : "No phones are paired yet."
        }
      >
        {state.devices.length > 0 && (
          <ul className="flex flex-col gap-2">
            {state.devices.map((device) => (
              <li key={device.id} className="flex items-center gap-3 rounded-lg bg-inset px-3 py-2">
                <Smartphone size={15} className="shrink-0 text-ink-secondary" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[14px] text-ink">{device.name}</div>
                  <div className="text-[12px] text-ink-secondary">Last seen {relative(device.lastSeenAt)}</div>
                </div>
                <button
                  disabled={busy}
                  onClick={() => void act(`/api/devices/${device.id}`, "DELETE")}
                  aria-label={`Remove ${device.name}`}
                  className="shrink-0 rounded p-1 text-ink-secondary hover:bg-raised hover:text-danger disabled:opacity-40"
                >
                  <Trash2 size={14} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

const cnSwitch = (on: boolean) =>
  `relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-40 ${on ? "bg-accent" : "bg-raised"}`;
const cnKnob = (on: boolean) =>
  `absolute top-[3px] h-[18px] w-[18px] rounded-full bg-white transition-all ${on ? "left-[21px]" : "left-[3px]"}`;
