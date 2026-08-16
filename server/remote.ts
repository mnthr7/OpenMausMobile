// The companion listener — a second HTTP socket, off by default, that a
// paired phone can reach. It runs the same request handler as the loopback
// server; the only difference is the `remote` flag the handler gets, which
// is what turns on authentication and turns off the routes a phone has no
// business calling.
//
// Two listeners rather than one bind on 0.0.0.0, deliberately. A single
// socket cannot tell "the desktop app on this machine" from "something else
// on the coffee-shop wifi" — `req.socket.localAddress` is 127.0.0.1 for both
// when a 0.0.0.0 listener is reached over loopback. Separate sockets make
// the distinction structural instead of a guess, so the trusted path stays
// exactly as trusted as it was before this file existed.
import { createServer, type RequestListener, type Server } from "node:http";
import { networkInterfaces } from "node:os";

/** Every IPv4 address a phone on the same network could dial. Link-local
 * (169.254/16) is dropped: it means DHCP failed and nothing will reach us. */
export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      if (entry.address.startsWith("169.254.")) continue;
      out.push(entry.address);
    }
  }
  return out;
}

export interface RemoteState {
  enabled: boolean;
  port: number;
  addresses: string[];
  /** Why the listener is not up despite being enabled (e.g. port in use). */
  error?: string;
}

export class RemoteListener {
  private server: Server | null = null;
  private lastError: string | undefined;
  private readonly handler: RequestListener;
  readonly port: number;

  // Plain assignments, not constructor parameter properties: the harness
  // runs straight off .ts through Node's strip-only type stripping, which
  // rejects any TypeScript syntax that emits code.
  constructor(handler: RequestListener, port: number) {
    this.handler = handler;
    this.port = port;
  }

  get running(): boolean {
    return this.server !== null;
  }

  state(): RemoteState {
    return {
      enabled: this.running,
      port: this.port,
      addresses: this.running ? lanAddresses() : [],
      ...(this.lastError ? { error: this.lastError } : {}),
    };
  }

  /** Bind 0.0.0.0:port. Resolves with the new state either way — a port
   * conflict is a message the user can act on, never a crashed harness. */
  async enable(): Promise<RemoteState> {
    if (this.server) return this.state();
    const server = createServer(this.handler);
    this.lastError = undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: NodeJS.ErrnoException) => {
          server.removeListener("listening", onListening);
          reject(err);
        };
        const onListening = () => {
          server.removeListener("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(this.port, "0.0.0.0");
      });
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      this.lastError =
        err.code === "EADDRINUSE"
          ? `port ${this.port} is already in use — close whatever is using it and try again`
          : err.message;
      try {
        server.close();
      } catch {
        /* never bound */
      }
      return this.state();
    }
    // A listener whose sockets keep the process alive would stop the harness
    // from exiting on SIGTERM while a phone holds an SSE stream open.
    server.unref();
    this.server = server;
    return this.state();
  }

  async disable(): Promise<RemoteState> {
    const server = this.server;
    this.server = null;
    this.lastError = undefined;
    if (!server) return this.state();
    // close() waits for open connections, and an SSE stream never ends on
    // its own — drop the sockets so "turn it off" means off, now.
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return this.state();
  }
}
