// The sidecar, as one command.
//
//   node companion/src/index.ts
//
// Three sockets, and the split between them is the whole security model:
//
//   :8800  0.0.0.0    devices     token required, allowlisted, scrubbed
//   :8801  127.0.0.1  you         pairing and revocation — never off-machine
//   :8799  127.0.0.1  the harness spoken to as this machine, unmodified
//
// Running this process *is* the opt-in. There is no toggle, because a toggle
// inside a process you chose to start would be ceremony: stopping it is the
// off switch, and it is a more honest one than a flag in a file.
import { createServer } from "node:http";

import { createControlServer } from "./control.ts";
import { DeviceRegistry } from "./devices.ts";
import { lanAddresses, refreshTailnetName, tailnetName, tailscaleAddress } from "./listener.ts";
import { advertisableAddresses, defaultHostName, dnsLabel, MdnsResponder, type ServiceInfo } from "./mdns.ts";
import { createProxyHandler } from "./proxy.ts";

const num = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : fallback;
};

const HARNESS_PORT = num(process.env.OMB_PORT, 8799);
const COMPANION_PORT = num(process.env.OMB_COMPANION_PORT, 8800);
const CONTROL_PORT = num(process.env.OMB_CONTROL_PORT, 8801);
const SERVICE_TYPE = "_openmausbot._tcp";

/** What the phone sees this computer called.
 *
 * Asked of the harness rather than invented here: it already knows whose
 * computer this is, from the profile collected during onboarding, and the
 * built-in companion used exactly this. A phone that paired before the move
 * should not suddenly find a differently-named computer in its list.
 *
 * Read once at startup and cached. An override wins, and a harness that is
 * not up or has no profile falls back rather than blocking — the name is a
 * label, and no part of pairing depends on it. */
let cachedName = process.env.OMB_COMPANION_NAME?.trim() || "";

const machineName = (): string => cachedName || "OpenMausBot";

async function refreshMachineName(): Promise<void> {
  if (cachedName) return; // an explicit override is not ours to second-guess
  try {
    const res = await fetch(`http://127.0.0.1:${HARNESS_PORT}/api/config`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return;
    const config = (await res.json()) as { profile?: { name?: string } };
    const owner = config.profile?.name?.trim();
    if (owner) cachedName = `${owner}'s computer`;
  } catch {
    /* not up, or no profile — "OpenMausBot" is a fine thing to be called */
  }
}

const devices = new DeviceRegistry();
const mdns = new MdnsResponder();

const service = (): ServiceInfo => ({
  // one DNS label: no dots, and inside the 63-byte limit
  name: dnsLabel(machineName()),
  type: SERVICE_TYPE,
  port: COMPANION_PORT,
  host: defaultHostName(),
  addresses: advertisableAddresses(),
  // TXT entries cap at 255 bytes, and this one is user-supplied
  txt: ["v=1", `name=${machineName().slice(0, 200)}`],
});

const companion = createServer(
  createProxyHandler({
    harnessPort: HARNESS_PORT,
    // `authenticate` also stamps lastSeenAt, which is what makes the control
    // page able to say when a phone was last heard from.
    authenticate: (token) => Boolean(devices.authenticate(token ?? undefined)),
    redeem: (code, deviceName) => devices.redeem(code, deviceName),
    serverName: machineName,
  }),
);

const control = createControlServer({
  devices,
  companionPort: COMPANION_PORT,
  discovery: () => ({ advertising: mdns.advertising, name: service().name }),
});

const listen = (server: ReturnType<typeof createServer>, port: number, host: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.removeListener("listening", onListening);
      // The overwhelmingly likely cause on the companion port, for as long
      // as both exist, is the harness's own built-in companion listener —
      // it defaults to the same port and is on if it was ever switched on.
      // Saying "close whatever is using it" sends someone hunting through
      // `lsof` for a thing that is one toggle away in an app they have open.
      const hint =
        port === COMPANION_PORT
          ? ` — if OpenMausBot's built-in companion is on, turn it off in Settings → Companion; it uses this port too`
          : "";
      reject(
        error.code === "EADDRINUSE"
          ? new Error(`port ${port} is already in use${hint}`)
          : error,
      );
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });

async function main(): Promise<void> {
  await listen(control, CONTROL_PORT, "127.0.0.1");
  await listen(companion, COMPANION_PORT, "0.0.0.0");

  // Before advertising: the service name goes into the Bonjour record, and
  // re-advertising under a new name later would show the phone two computers.
  await refreshMachineName();

  // Asking Tailscale costs a subprocess, so it happens once, here, rather
  // than per request. Silent on every failure: not installed, not logged in,
  // not running all just mean "no name", and the address still works.
  const tailscaleTried: string[] = [];
  await refreshTailnetName((cli, outcome) => tailscaleTried.push(`  ${cli} — ${outcome}`)).catch(() => {});

  // Discovery failing is not an error anyone has to fix — port 5353 taken by
  // another responder, multicast off, a guest network that isolates its
  // clients. Pairing by typed address still works, and the control page says
  // so rather than pretending the list will fill in.
  await mdns.advertise(service()).catch((error: unknown) => {
    console.warn(`bonjour unavailable: ${error instanceof Error ? error.message : String(error)}`);
  });

  const addresses = lanAddresses();
  const tailscale = tailscaleAddress(addresses);
  const reach = tailnetName() ?? tailscale ?? addresses[0];
  console.log(`companion  http://0.0.0.0:${COMPANION_PORT}  →  harness 127.0.0.1:${HARNESS_PORT}`);
  console.log(`pair here  http://127.0.0.1:${CONTROL_PORT}`);
  if (reach) console.log(`on your phone, enter  ${reach}:${COMPANION_PORT}`);
  if (tailscale && !tailnetName()) {
    // Do not tell someone to turn on MagicDNS when they may well have it on
    // already — say what was actually tried, so the difference between "off"
    // and "we could not find the CLI" is visible instead of guessed at.
    console.log("no MagicDNS name found. Tailscale CLI attempts:");
    for (const line of tailscaleTried) console.log(line);
  }
}

const shutdown = async (signal: string): Promise<void> => {
  console.log(`\n${signal} — stopping`);
  await mdns.stop().catch(() => {});
  // close() waits for open connections, and an SSE stream never ends on its
  // own — drop the sockets so "stop" means stopped, now.
  companion.closeAllConnections?.();
  control.closeAllConnections?.();
  await Promise.all([
    new Promise<void>((r) => companion.close(() => r())),
    new Promise<void>((r) => control.close(() => r())),
  ]);
  process.exit(0);
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
