import type { Request, RequestHandler } from "express";

function pathnameCandidates(req: Request): string[] {
  const out = new Set<string>();
  const trim = (s: string) => (s.replace(/\/+$/, "") || "/") as string;
  if (typeof req.path === "string" && req.path.length > 0) {
    out.add(trim(req.path));
  }
  try {
    const u = new URL(req.originalUrl, "http://healthcheck.local");
    out.add(trim(u.pathname));
  } catch {
    const q = req.originalUrl.split("?")[0] ?? "";
    if (q) out.add(trim(q));
  }
  return Array.from(out);
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function extractHostname(req: Request): string | null {
  const forwardedHost = req.header("x-forwarded-host")?.split(",")[0]?.trim();
  const hostHeader = req.header("host")?.trim();
  const raw = forwardedHost || hostHeader;
  if (!raw) return null;

  try {
    return new URL(`http://${raw}`).hostname.trim().toLowerCase();
  } catch {
    return raw.trim().toLowerCase();
  }
}

function normalizeAllowedHostnames(values: string[]): string[] {
  const unique = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim().toLowerCase();
    if (!trimmed) continue;
    unique.add(trimmed);
  }
  return Array.from(unique);
}

export function resolvePrivateHostnameAllowSet(opts: { allowedHostnames: string[]; bindHost: string }): Set<string> {
  const configuredAllow = normalizeAllowedHostnames(opts.allowedHostnames);
  const bindHost = opts.bindHost.trim().toLowerCase();
  const allowSet = new Set<string>(configuredAllow);

  if (bindHost && bindHost !== "0.0.0.0") {
    allowSet.add(bindHost);
  }
  allowSet.add("localhost");
  allowSet.add("127.0.0.1");
  allowSet.add("::1");
  // Railway health probes send Host: healthcheck.railway.app (see Railway healthcheck docs).
  allowSet.add("healthcheck.railway.app");
  return allowSet;
}

function blockedHostnameMessage(hostname: string): string {
  return (
    `Hostname '${hostname}' is not allowed for this Paperclip instance. ` +
    `If you want to allow this hostname, please run pnpm paperclipai allowed-hostname ${hostname}`
  );
}

/** PaaS / LB liveness (no DB); must not require allowed-hostname wiring for deploy probes. */
function isInfrastructureLivenessRequest(req: Request): boolean {
  return pathnameCandidates(req).some((p) => p === "/api/health/live");
}

export function privateHostnameGuard(opts: {
  enabled: boolean;
  allowedHostnames: string[];
  bindHost: string;
}): RequestHandler {
  if (!opts.enabled) {
    return (_req, _res, next) => next();
  }

  const allowSet = resolvePrivateHostnameAllowSet({
    allowedHostnames: opts.allowedHostnames,
    bindHost: opts.bindHost,
  });

  return (req, res, next) => {
    if (isInfrastructureLivenessRequest(req)) {
      next();
      return;
    }

    const hostname = extractHostname(req);
    const wantsJson = req.path.startsWith("/api") || req.accepts(["json", "html", "text"]) === "json";

    if (!hostname) {
      const error = "Missing Host header. If you want to allow a hostname, run pnpm paperclipai allowed-hostname <host>.";
      if (wantsJson) {
        res.status(403).json({ error });
      } else {
        res.status(403).type("text/plain").send(error);
      }
      return;
    }

    if (isLoopbackHostname(hostname) || allowSet.has(hostname)) {
      next();
      return;
    }

    const error = blockedHostnameMessage(hostname);
    if (wantsJson) {
      res.status(403).json({ error });
    } else {
      res.status(403).type("text/plain").send(error);
    }
  };
}
