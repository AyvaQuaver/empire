import express from "express";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { openDb, closeDb, type DB } from "./db.js";
import { buildRouter } from "./api.js";
import { sessionMiddleware, csrfCheck } from "./middleware.js";
import { config } from "./config.js";
import { runCleanup } from "./services/cleanup.js";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));

export interface AppHandle {
  db: DB;
  listen: () => Promise<number>;
  close: () => Promise<void>;
}

export function createApp(overrides?: { dbFile?: string; port?: number }): AppHandle {
  const dbFile = overrides?.dbFile ?? config.dbFile;
  const db = openDb(dbFile);
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);

  // Body limits: game APIs take small JSON payloads only.
  app.use(express.json({ limit: "16kb" }));

  // Basic security headers (no heavy middleware dependency).
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    // Room/snapshot/reading responses contain private, session-scoped data:
    // never cache them in browsers, proxies, or service workers.
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Robots-Tag", "noindex");
    if (config.isProduction) {
      res.setHeader("Strict-Transport-Security", "max-age=15552000");
      if (!config.sessionSecret || config.sessionSecret === "dev-only-change-me") {
        console.error("[empire] CONFIG PROBLEM: SESSION_SECRET is not set. Password hashes use no pepper until it is set.");
      }
      if (!config.smtp.host) {
        console.error("[empire] CONFIG PROBLEM: SMTP is not configured. Email verification and password reset are unavailable until SMTP_HOST, SMTP_USER, SMTP_PASSWORD and EMAIL_FROM are set.");
      }
    }
    next();
  });

  // CORS: only configured frontend origins, no credentials via wildcard.
  app.use((req, res, next) => {
    const origin = req.get("origin");
    if (origin && config.corsOrigins.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Empire-With, X-Empire-Lease, X-Cleanup-Token");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    }
    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });

  app.use("/api", sessionMiddleware(db), csrfCheck, buildRouter(db));

  // Health at root path level (for platform health checks).
  app.get("/healthz", (_req, res) => {
    try {
      db.prepare("SELECT 1").get();
      res.json({ ok: true });
    } catch {
      res.status(500).json({ ok: false });
    }
  });

  // In production the built frontend is served from dist/ with SPA fallback.
  const distDir = path.resolve(__dirname, "../../dist");
  if (fs.existsSync(distDir)) {
    app.use(express.static(distDir, { index: false }));
    app.get(/^\/(?!api|healthz).*/, (_req, res, next) => {
      const indexFile = path.join(distDir, "index.html");
      if (fs.existsSync(indexFile)) {
        res.sendFile(indexFile);
        return;
      }
      next();
    });
  }

  // Scheduled cleanup: inactive/abandoned rounds purged within the inactivity window.
  const cleanupTimer = setInterval(() => {
    try {
      runCleanup(db);
    } catch (err) {
      console.error("[cleanup] failed:", err instanceof Error ? err.message : err);
    }
  }, 60 * 60 * 1000);
  cleanupTimer.unref?.();

  let server: import("node:http").Server | null = null;
  return {
    db,
    listen: () =>
      new Promise<number>((resolve, reject) => {
        server = app.listen(overrides?.port ?? config.port, () => {
          const address = server?.address();
          const port = typeof address === "object" && address ? address.port : (overrides?.port ?? config.port);
          resolve(port);
        });
        server?.on("error", reject);
      }),
    close: async () => {
      await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
      clearInterval(cleanupTimer);
      closeDb(db);
    },
  };
}
