import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { and, eq, gt, isNull } from "drizzle-orm";
import { createDb, instanceUserRoles, invites } from "@paperclipai/db";
import { inferBindModeFromHost } from "@paperclipai/shared";
import { loadPaperclipEnvFile } from "../config/env.js";
import { readConfig, resolveConfigPath } from "../config/store.js";

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function createInviteToken() {
  return `pcp_bootstrap_${randomBytes(24).toString("hex")}`;
}

/** Railway injects these at runtime; `railway ssh` may not inherit Dockerfile-only env vars. */
function isRailwayRuntime(): boolean {
  return Boolean(
    process.env.RAILWAY_ENVIRONMENT ||
      process.env.RAILWAY_PROJECT_ID ||
      process.env.RAILWAY_SERVICE_ID,
  );
}

/**
 * `railway ssh` / similar often start a shell **without** service-linked variables.
 * PID 1 in Linux containers usually retains the full env passed to the container (incl. DATABASE_URL).
 */
function inheritDatabaseUrlFromInitProcess(): void {
  if (process.env.DATABASE_URL?.trim()) return;
  try {
    const raw = fs.readFileSync("/proc/1/environ");
    for (const chunk of raw.toString("binary").split("\0")) {
      if (chunk.startsWith("DATABASE_URL=")) {
        const v = chunk.slice("DATABASE_URL=".length).trim();
        if (v) process.env.DATABASE_URL = v;
        return;
      }
    }
  } catch {
    // Not Linux, no /proc, or unreadable.
  }
}

function resolveDbUrl(configPath?: string, explicitDbUrl?: string) {
  if (explicitDbUrl) return explicitDbUrl;
  if (process.env.DATABASE_URL?.trim()) return process.env.DATABASE_URL.trim();
  const config = readConfig(configPath);
  if (config?.database.mode === "postgres" && config.database.connectionString) {
    return config.database.connectionString;
  }
  if (config?.database.mode === "embedded-postgres") {
    const port = config.database.embeddedPostgresPort ?? 54329;
    return `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`;
  }
  return null;
}

function resolveBaseUrl(configPath?: string, explicitBaseUrl?: string) {
  if (explicitBaseUrl) return explicitBaseUrl.replace(/\/+$/, "");
  const fromEnv =
    process.env.PAPERCLIP_PUBLIC_URL ??
    process.env.PAPERCLIP_AUTH_PUBLIC_BASE_URL ??
    process.env.BETTER_AUTH_URL ??
    process.env.BETTER_AUTH_BASE_URL;
  if (fromEnv?.trim()) return fromEnv.trim().replace(/\/+$/, "");
  const config = readConfig(configPath);
  if (config?.auth.baseUrlMode === "explicit" && config.auth.publicBaseUrl) {
    return config.auth.publicBaseUrl.replace(/\/+$/, "");
  }
  if (!config) {
    const port = Number(process.env.PORT) || 3100;
    return `http://127.0.0.1:${port}`;
  }
  const bind = config.server.bind ?? inferBindModeFromHost(config.server.host);
  const host =
    bind === "custom"
      ? config.server.customBindHost ?? config.server.host ?? "localhost"
      : config.server.host ?? "localhost";
  const port = config.server.port ?? 3100;
  const publicHost = host === "0.0.0.0" || bind === "lan" ? "localhost" : host;
  return `http://${publicHost}:${port}`;
}

export async function bootstrapCeoInvite(opts: {
  config?: string;
  force?: boolean;
  expiresHours?: number;
  baseUrl?: string;
  dbUrl?: string;
}) {
  const configPath = resolveConfigPath(opts.config);
  loadPaperclipEnvFile(configPath);
  inheritDatabaseUrlFromInitProcess();
  const config = readConfig(configPath);
  const authenticatedFromEnv = process.env.PAPERCLIP_DEPLOYMENT_MODE?.trim() === "authenticated";
  const hasDb =
    Boolean(process.env.DATABASE_URL?.trim()) || Boolean(opts.dbUrl?.trim());
  const publicBaseHint =
    opts.baseUrl?.trim() ||
    process.env.PAPERCLIP_PUBLIC_URL?.trim() ||
    process.env.PAPERCLIP_AUTH_PUBLIC_BASE_URL?.trim() ||
    process.env.BETTER_AUTH_URL?.trim() ||
    process.env.BETTER_AUTH_BASE_URL?.trim();

  // Docker / PaaS SSH often omits RAILWAY_* and PAPERCLIP_DEPLOYMENT_MODE; DATABASE_URL + public URL is enough.
  const allowBootstrapWithoutConfigFile =
    authenticatedFromEnv || (isRailwayRuntime() && hasDb) || (hasDb && Boolean(publicBaseHint));

  if (!config && !allowBootstrapWithoutConfigFile) {
    p.log.error(`No config found at ${configPath}. Run ${pc.cyan("paperclip onboard")} first.`);
    if (!process.env.DATABASE_URL?.trim() && !opts.dbUrl?.trim()) {
      p.log.info(
        "If you are in a PaaS SSH shell: DATABASE_URL may be unset here. Run " +
          `${pc.cyan("printenv DATABASE_URL")} or copy the variable from the dashboard, ` +
          `${pc.cyan("export DATABASE_URL='...'")}, or pass ${pc.cyan("--db-url")}.`,
      );
    }
    return;
  }

  const deploymentAuthenticated =
    config?.server.deploymentMode === "authenticated" ||
    authenticatedFromEnv ||
    (allowBootstrapWithoutConfigFile && !config);
  if (!deploymentAuthenticated) {
    p.log.info("Bootstrap CEO invite is only used in authenticated deployment mode.");
    return;
  }

  const dbUrl = resolveDbUrl(configPath, opts.dbUrl);
  if (!dbUrl) {
    p.log.error(
      "Could not resolve database connection for bootstrap. Set DATABASE_URL or use a config file with database.connectionString.",
    );
    return;
  }

  if (!config && allowBootstrapWithoutConfigFile) {
    const publicBase =
      opts.baseUrl?.trim() ||
      process.env.PAPERCLIP_PUBLIC_URL?.trim() ||
      process.env.PAPERCLIP_AUTH_PUBLIC_BASE_URL?.trim() ||
      process.env.BETTER_AUTH_URL?.trim() ||
      process.env.BETTER_AUTH_BASE_URL?.trim();
    if (!publicBase) {
      p.log.error(
        "No config file: pass --base-url https://<your-public-host> (or set PAPERCLIP_PUBLIC_URL) so the invite link points at this instance.",
      );
      return;
    }
  }

  const db = createDb(dbUrl);
  const closableDb = db as typeof db & {
    $client?: {
      end?: (options?: { timeout?: number }) => Promise<void>;
    };
  };
  try {
    const existingAdminCount = await db
      .select()
      .from(instanceUserRoles)
      .where(eq(instanceUserRoles.role, "instance_admin"))
      .then((rows) => rows.length);

    if (existingAdminCount > 0 && !opts.force) {
      p.log.info("Instance already has an admin user. Use --force to generate a new bootstrap invite.");
      return;
    }

    const now = new Date();
    await db
      .update(invites)
      .set({ revokedAt: now, updatedAt: now })
      .where(
        and(
          eq(invites.inviteType, "bootstrap_ceo"),
          isNull(invites.revokedAt),
          isNull(invites.acceptedAt),
          gt(invites.expiresAt, now),
        ),
      );

    const token = createInviteToken();
    const expiresHours = Math.max(1, Math.min(24 * 30, opts.expiresHours ?? 72));
    const created = await db
      .insert(invites)
      .values({
        inviteType: "bootstrap_ceo",
        tokenHash: hashToken(token),
        allowedJoinTypes: "human",
        expiresAt: new Date(Date.now() + expiresHours * 60 * 60 * 1000),
        invitedByUserId: "system",
      })
      .returning()
      .then((rows) => rows[0]);

    const baseUrl = resolveBaseUrl(configPath, opts.baseUrl);
    const inviteUrl = `${baseUrl}/invite/${token}`;
    p.log.success("Created bootstrap CEO invite.");
    p.log.message(`Invite URL: ${pc.cyan(inviteUrl)}`);
    p.log.message(`Expires: ${pc.dim(created.expiresAt.toISOString())}`);
  } catch (err) {
    p.log.error(`Could not create bootstrap invite: ${err instanceof Error ? err.message : String(err)}`);
    p.log.info("If using embedded-postgres, start the Paperclip server and run this command again.");
  } finally {
    await closableDb.$client?.end?.({ timeout: 5 }).catch(() => undefined);
  }
}
