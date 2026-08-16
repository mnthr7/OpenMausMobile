// What a paired device is allowed to ask for.
//
// The default is deny. This answers with an explicit allowance per route
// family, so a route that appears in the harness later is closed to phones
// until someone decides otherwise. That direction matters: the sidecar sits
// in front of an API it does not own and cannot see the future of, and a
// permissive default would silently expose whatever upstream adds next.

/** A refusal to send back, or null to let the request through. */
export interface Denial {
  status: number;
  error: string;
}

export interface RouteRequest {
  path: string;
  method: string;
  /** Whether the bearer token on the request matched a paired device. */
  authenticated: boolean;
}

export function denyReason({ path, method, authenticated }: RouteRequest): Denial | null {
  // Pairing is the one thing a device does before it has a credential.
  if (method === "POST" && path === "/api/pair") return null;

  if (!authenticated) {
    return { status: 401, error: "pair this device from the OpenMausBot companion on your computer" };
  }

  // The peer-agent comms endpoints are for a proxy running inside an agent
  // process on this machine, authenticated with a token generated at boot
  // that the sidecar does not have and should not have. Off-machine they
  // simply do not exist.
  if (path.startsWith("/api/internal/")) {
    return { status: 404, error: `no route: ${method} ${path}` };
  }

  // A device may not manage the companion itself: not enabling it, not
  // opening a pairing window, and not revoking the other paired devices.
  // Losing the phone must not mean losing the ability to lock it out.
  if (path === "/api/companion" || path.startsWith("/api/companion/") || path.startsWith("/api/devices")) {
    return { status: 403, error: "companion settings are managed on your computer" };
  }

  // Credentials stay on the machine that holds them. Reading the
  // configured-or-not booleans is fine; writing keys is not.
  if ((method === "PUT" || method === "PATCH") && path === "/api/config") {
    return { status: 403, error: "API keys can only be changed on your computer" };
  }

  // Local VM lifecycle is a host operation — pulling images, starting
  // containers — and its own guard assumes a loopback caller.
  if (path.startsWith("/api/local-computer/")) {
    return { status: 403, error: "the Local VM is set up on your computer" };
  }

  // The packaged desktop UI is served to the desktop window. A phone asking
  // for it is asking for the wrong thing, and serving HTML over this socket
  // would make the sidecar a web server, which it is deliberately not.
  if (!path.startsWith("/api/")) {
    return { status: 404, error: `no route: ${method} ${path}` };
  }

  return null;
}
