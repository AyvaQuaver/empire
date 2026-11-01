import { describe, it, expect, afterAll, afterAll as _afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { validateDeploymentConfig, type DeploymentEnv } from "../src/config.js";
import { createApp, type AppHandle } from "../src/app.js";
import { Client, spawnTsx } from "./harness.js";

/* Startup configuration: staging/production refuse to start without real
 * secrets and SMTP; the dev outbox can never leak into deployed environments. */

const valid = (deploymentEnv: DeploymentEnv, overrides: Record<string, unknown> = {}) => ({
  deploymentEnv,
  sessionSecret: "staging-secret-value-0123456789abcdef",
  smtpHost: "smtp.example.test",
  smtpPort: 587,
  smtpUser: "mailer",
  smtpPassword: "app-password",
  smtpFrom: "Empire <no-reply@example.test>",
  ...overrides,
});

describe("deployment configuration validation", () => {
  it("staging/production fail without a session secret", () => {
    for (const envName of ["staging", "production"] as const) {
      const problems = validateDeploymentConfig(valid(envName, { sessionSecret: undefined }));
      expect(problems.map((p) => p.area)).toContain("SESSION_SECRET");
      // messages never leak secret VALUES
      for (const p of problems) expect(p.message).not.toContain("staging-secret-value");
    }
  });

  it("placeholder secrets are rejected", () => {
    for (const bad of ["", "   ", "dev-only-change-me", "CHANGE-ME", "password", "secret"]) {
      const problems = validateDeploymentConfig(valid("staging", { sessionSecret: bad }));
      expect(problems.map((p) => p.area)).toContain("SESSION_SECRET");
    }
    expect(validateDeploymentConfig(valid("staging")).map((p) => p.area)).not.toContain("SESSION_SECRET");
  });

  it("missing SMTP configuration fails staging/production startup", () => {
    for (const envName of ["staging", "production"] as const) {
      const problems = validateDeploymentConfig(valid(envName, { smtpHost: undefined }));
      expect(problems.map((p) => p.area)).toContain("SMTP_HOST");
    }
    // incomplete SMTP (no credentials / bad from) also fails
    expect(validateDeploymentConfig(valid("staging", { smtpUser: undefined })).map((p) => p.area)).toContain(
      "SMTP_USER/SMTP_PASSWORD",
    );
    expect(validateDeploymentConfig(valid("staging", { smtpFrom: "not-a-mailbox" })).map((p) => p.area)).toContain(
      "EMAIL_FROM",
    );
  });

  it("the dev outbox flag is rejected for staging/production (contradictory config)", () => {
    const problems = validateDeploymentConfig(valid("staging", { allowDevEmailPreview: true }));
    expect(problems.map((p) => p.area)).toContain("ALLOW_DEV_EMAIL_PREVIEW");
    expect(validateDeploymentConfig(valid("development", { allowDevEmailPreview: true })).map((p) => p.area)).not.toContain(
      "ALLOW_DEV_EMAIL_PREVIEW",
    );
  });

  it("development/test keep permissive documented defaults", () => {
    expect(
      validateDeploymentConfig({ deploymentEnv: "development", sessionSecret: "dev-only-change-me" }),
    ).toEqual([]);
    expect(validateDeploymentConfig({ deploymentEnv: "test" })).toEqual([]);
  });

  it("the staging server really refuses to boot without a secret (spawned process)", async () => {
    const entry = path.resolve("server/src/index.ts");
    const child = spawnTsx([entry], {
      env: {
        ...process.env,
        EMPIRE_ENV: "staging",
        SESSION_SECRET: "",
        SMTP_HOST: "smtp.example.test",
        SMTP_USER: "u",
        SMTP_PASSWORD: "p",
        EMAIL_FROM: "Empire <no-reply@example.test>",
        EMPIRE_DB_FILE: ":memory:",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (d) => (stderr += String(d)));
    const exit = await new Promise<number>((resolve) => child.on("exit", (code) => resolve(code ?? 1)));
    child.kill();
    expect(exit).not.toBe(0);
    expect(stderr).toContain("refusing to start");
    expect(stderr).toContain("SESSION_SECRET");
  }, 45000);
});

describe("existing accounts keep authenticating across restarts (same configured secret)", () => {
  let handle: AppHandle | null = null;
  afterAll(async () => {
    if (handle) await handle.close();
  });

  it("register → close → reopen with same DB+secret → sign-in and old session still valid", async () => {
    const dbFile = path.join(".tmp-data", `restart-${Date.now()}.db`);
    fs.mkdirSync(path.dirname(dbFile), { recursive: true });
    try {
      process.on("uncaughtException", (e) => console.log("[startup-test] UNCAUGHT:", String(e)));
      process.on("unhandledRejection", (e) => console.log("[startup-test] UNHANDLED:", String(e)));
      handle = createApp({ dbFile, port: 0 });
      const port = await handle.listen();
      const base = `http://127.0.0.1:${port}`;
      console.log("[startup-test] first app on port", port);
      const c = new Client(base);
      const health = await c.get("/api/health").catch((e) => ({ status: -1, json: { e: String(e) }, headers: {} }));
      console.log("[startup-test] health", health.status);
      const reg = await c.post("/api/auth/register", {
        username: "restart_user",
        email: "restart@example.test",
        password: "long-enough-pass-1",
      }).catch((e) => {
        console.log("[startup-test] register fetch FAILED", String(e));
        return { status: -1, json: { e: String(e) }, headers: {} };
      });
      console.log("[startup-test] register status", reg.status);
      expect(reg.status).toBe(200);
      const me1 = await c.get("/api/me").catch((e) => {
        console.log("[startup-test] me fetch FAILED", String(e));
        return { status: -1, json: { e: String(e) }, headers: {} };
      });
      console.log("[startup-test] me1 status", me1.status);
      expect(me1.json.signedIn).toBe(true);
      // Pre-restart browser cookie (opaque token) for later verification
      const firstCookie = c.cookie;
      await handle.close();
      handle = null;

      // "restart": new instance, same DB file, same secret (the app default pepper)
      handle = createApp({ dbFile, port: 0 });
      const port2 = await handle.listen();
      const base2 = `http://127.0.0.1:${port2}`;
      const c2 = new Client(base2);
      expect((await c2.post("/api/auth/sign-in", { username: "restart_user", password: "long-enough-pass-1" })).status)
        .toBe(200);
      // The OLD cookie still authenticates after the restart (session row persisted)
      const cOld = new Client(base2);
      cOld.cookie = firstCookie;
      expect((await cOld.get("/api/me")).json.signedIn).toBe(true);
    } finally {
      // Windows keeps the pending DatabaseSync handle open: close it before
      // deleting, and treat cleanup failures (in-flight locks) as best effort.
      if (handle) {
        await handle.close();
        handle = null;
      }
      const rmQuiet = (p: string) => {
        try {
          fs.rmSync(p, { force: true });
        } catch {
          // locked directory entry: harmless test residue
        }
      };
      rmQuiet(dbFile);
      rmQuiet(`${dbFile}-journal`);
      rmQuiet(`${dbFile}-wal`);
      rmQuiet(`${dbFile}-shm`);
    }
  });
});
