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

const nodeEnv = env("NODE_ENV", "development");
const isProduction = nodeEnv === "production" || nodeEnv === "staging";

export const config = {
  nodeEnv,
  isProduction,
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
  allowDevEmailPreview: env("ALLOW_DEV_EMAIL_PREVIEW", "") === "true" && !isProduction,
  purgeInactivityHours: Number(env("PURGE_INACTIVITY_HOURS", "24")),
};

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
