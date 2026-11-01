// Server configuration, read from environment variables with local-development defaults.
// Never log or return secret values.
import path from "node:path";

function env(name: string, fallback = ""): string {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

// Supports `.env` (git-ignored) loading without extra dependencies.
try {
  if (typeof process !== "undefined" && process.env) {
    const fs = await import("node:fs");
    const envPath = path.resolve(process.cwd(), ".env");
    if (fs.existsSync(envPath)) {
      for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
        if (!m || line.trim().startsWith("#")) continue;
        const key = m[1];
        let value = m[2] ?? "";
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        if (process.env[key] === undefined) process.env[key] = value;
      }
    }
  }
} catch {
  // ignore .env problems; defaults apply
}

export type DeploymentEnv = "development" | "test" | "staging" | "production";
const DEPLOYMENT_ENVS: DeploymentEnv[] = ["development", "test", "staging", "production"];

export interface ResolvedEnv {
  /** null when neither variable was explicitly supplied → documented default. */
  decided: DeploymentEnv | null;
  /** Value that was explicitly supplied but is not a supported environment name. */
  invalid?: string;
  /** Which variable produced the decision/invalid value. */
  source?: "EMPIRE_ENV" | "NODE_ENV" | "default";
}

/**
 * Strict environment resolution:
 *  1. An explicitly supplied EMPIRE_ENV decides — but ONLY if it names a
 *     supported environment. Any other (including blank/whitespace) value is
 *     REJECTED, never silently mapped to development.
 *  2. Otherwise an explicitly supplied NODE_ENV is used under the same rule.
 *  3. If neither variable is supplied, the documented local default
 *     `development` applies.
 */
export function resolveDeploymentEnv(
  empireEnv: string | undefined,
  nodeEnv: string | undefined,
): ResolvedEnv {
  const parse = (raw: string): DeploymentEnv | null =>
    DEPLOYMENT_ENVS.includes(raw.trim().toLowerCase() as DeploymentEnv) ? (raw.trim().toLowerCase() as DeploymentEnv) : null;
  if (empireEnv !== undefined) {
    const v = parse(empireEnv);
    if (v) return { decided: v, source: "EMPIRE_ENV" };
    return { decided: null, invalid: empireEnv, source: "EMPIRE_ENV" };
  }
  if (nodeEnv !== undefined) {
    const v = parse(nodeEnv);
    if (v) return { decided: v, source: "NODE_ENV" };
    return { decided: null, invalid: nodeEnv, source: "NODE_ENV" };
  }
  return { decided: "development", source: "default" };
}

const moduleRootEnv = resolveDeploymentEnv(process.env.EMPIRE_ENV, process.env.NODE_ENV);
// When environment resolution FAILED, boot is refused by validateDeploymentConfig
// (problems include the invalid setting); the placeholder below is never used out
// of the box because index.ts stops before createApp.
export const deploymentEnv: DeploymentEnv = moduleRootEnv.decided ?? "development";
export const envResolutionProblems: string[] =
  moduleRootEnv.invalid !== undefined
    ? [
        `EMPIRE_ENV/NODE_ENV was set to an unsupported value ("${moduleRootEnv.invalid.length > 40 ? moduleRootEnv.invalid.slice(0, 40) + "…" : moduleRootEnv.invalid}") via ${moduleRootEnv.source}; supported values are ${DEPLOYMENT_ENVS.join(", ")}.`,
      ]
    : [];
export const isProductionLike = deploymentEnv === "staging" || deploymentEnv === "production";

// ---- Guest-preview account flag -------------------------------------------
// AUTH_ACCOUNTS_ENABLED=false makes the deployment explicitly guest-only:
// register/sign-in/reset/verification/google-free, account-only social features
// are refused server-side. Guests can play everything. Accounts stay in place
// (nothing is deleted); re-enabling restores the flows.
const rawAccountsFlag = process.env.AUTH_ACCOUNTS_ENABLED;
let accountsFlagProblem: string | null = null;
let authAccountsEnabled = true;
if (rawAccountsFlag === "false") authAccountsEnabled = false;
else if (rawAccountsFlag === "true" || rawAccountsFlag === undefined || rawAccountsFlag === "") authAccountsEnabled = true;
else
  accountsFlagProblem =
    "AUTH_ACCOUNTS_ENABLED must be `true` or `false` (unset means true).";

export const config = {
  nodeEnv: deploymentEnv,
  deploymentEnv, // explicit alias for readability
  isProduction: isProductionLike, // legacy alias: staging shares production hardening
  authAccountsEnabled,
  accountsFlagProblem, // surfaced by validateDeploymentConfig; null when OK
  dbFile: env("EMPIRE_DB_FILE", "./data/empire.db"),
  port: Number(env("PORT", "8787")),
  appBaseUrl: env("APP_BASE_URL", "http://localhost:5173"),
  sessionSecret: env("SESSION_SECRET", "dev-only-change-me"),
  corsOrigins: env("CORS_ORIGINS", "http://localhost:5173")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  smtp: {
    host: env("SMTP_HOST"),
    port: Number(env("SMTP_PORT", "587")),
    user: env("SMTP_USER"),
    password: env("SMTP_PASSWORD"),
    from: env("EMAIL_FROM", "Empire <no-reply@localhost>"),
  },
  allowDevEmailPreview: env("ALLOW_DEV_EMAIL_PREVIEW", "") === "true" && !isProductionLike,
  purgeInactivityHours: Number(env("PURGE_INACTIVITY_HOURS", "24")),
};

// ---- Startup configuration validation ------------------------------------
// Staging/production refuse to start without real, stable configuration:
// no defaults, no blanks, no obvious placeholders, no generated-on-boot secrets.
const PLACEHOLDER_SECRETS = new Set([
  "",
  "dev-only-change-me",
  "change-me",
  "changeme",
  "secret",
  "placeholder",
  "replace-me",
  "replace_me",
  "session-secret",
  "12345678",
  "password",
]);

export interface ConfigProblem {
  area: string;
  message: string; // never contains any secret VALUE
}

/**
 * Validates the deployment configuration BEFORE accepting requests.
 * Development/test are intentionally permissive (documented local defaults);
 * staging/production fail closed.
 */
export interface DeploymentConfigInput {
  deploymentEnv: DeploymentEnv;
  /** Pre-resolved environment problems (e.g. an invalid EMPIRE_ENV value). */
  envProblems?: readonly string[];
  /** Invalid AUTH_ACCOUNTS_ENABLED value, surfaced as a config problem. */
  accountsFlagProblem?: string | null;
  sessionSecret?: string;
  smtpHost?: string;
  smtpPort?: number;
  smtpUser?: string;
  smtpPassword?: string;
  smtpFrom?: string;
  allowDevEmailPreview?: boolean;
  /** Guest preview explicitly disables account features (innate SMTP relaxation). */
  authAccountsEnabled?: boolean;
}

/**
 * Validates the deployment configuration BEFORE accepting requests.
 * Development/test are intentionally permissive (documented local defaults);
 * staging/production fail closed.
 */
export function validateDeploymentConfig(env: DeploymentConfigInput): ConfigProblem[] {
  const problems: ConfigProblem[] = [];
  const isProdLike = env.deploymentEnv === "staging" || env.deploymentEnv === "production";

  // Invalid environment names/flags fail the boot outright in any environment.
  for (const msg of env.envProblems ?? []) {
    problems.push({ area: "EMPIRE_ENV", message: msg });
  }
  if (env.accountsFlagProblem) {
    problems.push({ area: "AUTH_ACCOUNTS_ENABLED", message: env.accountsFlagProblem });
  }
  // Public-facing deployments (staging/production) always require a stable secret,
  // even in guest-preview mode with accounts disabled.
  // Contradictory configuration: the dev outbox can never be enabled outside
  // development. (Staging must not be able to opt back in.)
  if (env.allowDevEmailPreview && env.deploymentEnv !== "development") {
    problems.push({
      area: "ALLOW_DEV_EMAIL_PREVIEW",
      message: "ALLOW_DEV_EMAIL_PREVIEW=true is only valid when EMPIRE_ENV=development. Remove it for staging/production.",
    });
  }

  const secret = env.sessionSecret ?? "";
  if (isProdLike) {
    if (!secret || secret.trim() === "") {
      problems.push({
        area: "SESSION_SECRET",
        message: "SESSION_SECRET is required for staging/production and must not be blank.",
      });
    } else if (PLACEHOLDER_SECRETS.has(secret.toLowerCase().trim())) {
      problems.push({
        area: "SESSION_SECRET",
        message: "SESSION_SECRET is set to a placeholder value. Generate a unique secret (e.g. `openssl rand -base64 32`).",
      });
    }
    const accountsEnabled = env.authAccountsEnabled ?? true;
    // Email is REQUIRED for register-verification & password resets whenever
    // accounts are available in a deployed environment. A guest-only preview
    // (accounts disabled) does not need SMTP.
    if (accountsEnabled && !env.smtpHost) {
      problems.push({
        area: "SMTP_HOST",
        message: "SMTP_HOST is required for staging/production with accounts enabled: verification and password reset need real email delivery. Set AUTH_ACCOUNTS_ENABLED=false for a guest-only preview.",
      });
    }
    if (env.smtpHost) {
      const port = env.smtpPort ?? 0;
      if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        problems.push({ area: "SMTP_PORT", message: "SMTP_PORT must be a TCP port between 1 and 65535." });
      }
      if (!env.smtpFrom || !env.smtpFrom.includes("@")) {
        problems.push({
          area: "EMAIL_FROM",
          message: "EMAIL_FROM is required and must be a valid mailbox address (must contain '@').",
        });
      }
      if (!env.smtpUser || !env.smtpPassword) {
        problems.push({
          area: "SMTP_USER/SMTP_PASSWORD",
          message: "SMTP_USER and SMTP_PASSWORD are required for authenticated sending in staging/production.",
        });
      }
    }
  } else {
    // Development/test: the outbox may be turned on explicitly; contrived SMTP
    // setups with a host but no sender are still rejected to avoid silent failures.
    if (env.smtpHost && (!env.smtpFrom || !env.smtpFrom.includes("@"))) {
      problems.push({
        area: "EMAIL_FROM",
        message: "EMAIL_FROM must be a valid mailbox address (must contain '@') when SMTP_HOST is set.",
      });
    }
  }
  return problems;
}

// Game rule constants.
export const GAME = {
  minPlayers: 3,
  maxPlayers: 20,
  displayNameMax: 24,
  displayNameMin: 1,
  genreMax: 60,
  titleMax: 60,
  wordMaxChars: 40,
  readingCount: 3,
  leaseTtlMs: 3 * 60 * 1000,
} as const;

export type GameConfig = typeof config;
