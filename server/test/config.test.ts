import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { resolveDeploymentEnv, validateDeploymentConfig } from "../src/config.js";
import { setEmailTransportForTests, deliverEmailWithConfig } from "../src/email.js";
import { startTestServer, spawnTsx, type TestContext } from "./harness.js";

let t: TestContext;
beforeAll(async () => {
  t = await startTestServer();
});
afterAll(async () => {
  await t.close();
  setEmailTransportForTests(null);
});

/* Environment resolution is strict, and deployed email flows never persist
 * token-bearing content. */

describe("EMPIRE_ENV resolution", () => {
  it("accepts the four documented environments", () => {
    for (const envName of ["development", "test", "staging", "production"] as const) {
      const r = resolveDeploymentEnv(envName, undefined);
      expect(r.decided).toBe(envName);
      expect(r.invalid).toBeUndefined();
    }
    for (const envName of ["PRODUCTION", " Staging "]) {
      expect(resolveDeploymentEnv(envName, undefined).decided).toBe(envName.trim().toLowerCase());
    }
  });

  it("rejects misspelled and blank explicit values instead of falling back", () => {
    for (const bad of ["stagng", "prod", "", "   ", "guest-preview", "DevMode; DROP TABLE users"]) {
      const r = resolveDeploymentEnv(bad, undefined);
      expect(r.decided).toBeNull();
      expect(r.invalid).toBe(bad);
    }
  });

  it("an explicitly invalid NODE_ENV is also rejected", () => {
    const r = resolveDeploymentEnv(undefined, "some-other-mode");
    expect(r.decided).toBeNull();
    expect(r.invalid).toBe("some-other-mode");
  });

  it("falls back to the documented default only when nothing is supplied", () => {
    expect(resolveDeploymentEnv(undefined, undefined)).toEqual({
      decided: "development",
      source: "default",
    });
  });

  it("EMPIRE_ENV takes precedence when both variables are present", () => {
    expect(resolveDeploymentEnv("staging", "development").decided).toBe("staging");
    expect(resolveDeploymentEnv("development", "production").decided).toBe("development");
    // an explicitly invalid EMPIRE_ENV still fails even with a valid NODE_ENV
    const bad = resolveDeploymentEnv("stagng", "production");
    expect(bad.decided).toBeNull();
    expect(bad.invalid).toBe("stagng");
  });

  it("configuration validation fails on invalid environment values", () => {
    const problems = validateDeploymentConfig({
      deploymentEnv: "development",
      envProblems: ['EMPIRE_ENV/NODE_ENV was set to an unsupported value ("stagng")'],
    });
    expect(problems.map((p) => p.area)).toContain("EMPIRE_ENV");
  });

  it("staging with accounts disabled needs a secret but NOT SMTP (guest preview)", () => {
    const ok = validateDeploymentConfig({
      deploymentEnv: "staging",
      authAccountsEnabled: false,
      sessionSecret: "preview-secret-value-0123456789abcdef",
      smtpHost: undefined,
    });
    expect(ok).toEqual([]);
    // same staging with accounts ON still demands SMTP
    const withAccounts = validateDeploymentConfig({
      deploymentEnv: "staging",
      authAccountsEnabled: true,
      sessionSecret: "preview-secret-value-0123456789abcdef",
      smtpHost: undefined,
    });
    expect(withAccounts.map((p) => p.area)).toContain("SMTP_HOST");
  });

  it("a misspelled environment really refuses to boot (spawned process)", async () => {
    const entry = path.resolve("server/src/index.ts");
    const child = spawnTsx([entry], {
      env: {
        ...process.env,
        EMPIRE_ENV: "stagng",
        SESSION_SECRET: "x".repeat(32),
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
    expect(stderr).toContain("EMPIRE_ENV");
  }, 45000);

  it("staging guest-preview boots WITHOUT SMTP spawned process", async () => {
    const entry = path.resolve("server/src/index.ts");
    const dbFile = path.join("/tmp/opencode", `preview-${Date.now()}.db`);
    const child = spawnTsx([entry], {
      env: {
        ...process.env,
        EMPIRE_ENV: "staging",
        AUTH_ACCOUNTS_ENABLED: "false",
        SESSION_SECRET: "preview-secret-value-0123456789abcdef",
        SMTP_HOST: "",
        EMPIRE_DB_FILE: dbFile,
        ALLOW_DEV_EMAIL_PREVIEW: "",
        PORT: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout?.on("data", (d) => (stdout += String(d)));
    const listening = await new Promise<boolean>((resolve) => {
      child.stdout?.on("data", (d: NodeJS.ErrnoException) => {
        if (String(d).includes("API listening")) resolve(true);
      });
      child.on("exit", (code) => {
        void code;
        resolve(false);
      });
      setTimeout(() => resolve(false), 15000);
    });
    child.kill();
    fs.rmSync(dbFile, { force: true });
    fs.rmSync(`${dbFile}-journal`, { force: true });
    fs.rmSync(`${dbFile}-wal`, { force: true });
    fs.rmSync(`${dbFile}-shm`, { force: true });
    expect(listening).toBe(true);
    expect(stdout).toContain("API listening");
  }, 45000);
});

describe("deployed email handling", () => {
  afterEach(() => {
    setEmailTransportForTests(null);
  });

  it("SMTP-configured deployments persist ONLY minimal metadata (no bodies/recipients)", async () => {
    const db = t.handle.db;
    const beforeOutbox = (db.prepare("SELECT COUNT(*) n FROM email_outbox").get() as { n: number }).n;
    const captured: { to: string; subject?: string; body?: string }[] = [];
    setEmailTransportForTests(async (m) => {
      captured.push(m);
    });
    await deliverEmailWithConfig(
      db,
      { to: "someone@example.test", kind: "verify_email", subject: "SUBJECT-WITH-LINK /verify-email?token=abc", body: "BODY /verify-email?token=abc" },
      { env: "staging", smtpHost: "smtp.example.test", smtpUser: "u", smtpPassword: "p", smtpFrom: "e@x.test" },
    );
    expect(captured[0]?.to).toBe("someone@example.test");
    const afterOutbox = (db.prepare("SELECT COUNT(*) n FROM email_outbox").get() as { n: number }).n;
    expect(afterOutbox).toBe(beforeOutbox); // nothing written to the outbox
    const logRow = db
      .prepare("SELECT kind, status, error_code FROM email_delivery_log ORDER BY id DESC LIMIT 1")
      .get() as { kind: string; status: string; error_code: string | null };
    expect(logRow.status).toBe("sent");
    expect(JSON.stringify(logRow)).not.toContain("token");
    expect(JSON.stringify(logRow)).not.toContain("someone@example");
  });

  it("delivery failures log a safe code and never echo tokens", async () => {
    const db = t.handle.db;
    setEmailTransportForTests(async () => {
      const e = new Error("SMTP handshake failed for host secret-host:587 with token=abc");
      e.name = "EAUTH"; // nodemailer-style safe identifier
      throw e;
    });
    await expect(
      deliverEmailWithConfig(
        db,
        { to: "someone@example.test", kind: "password_reset", subject: "S", body: "B token=abc" },
        { env: "production", smtpHost: "smtp.example.test", smtpUser: "u", smtpPassword: "p", smtpFrom: "e@x.test" },
      ),
    ).rejects.toThrow();
    const row = db
      .prepare("SELECT kind, status, error_code FROM email_delivery_log ORDER BY id DESC LIMIT 1")
      .get() as { kind: string; status: string; error_code: string | null };
    expect(row.status).toBe("failed");
    expect(row.error_code).toBe("EAUTH");
    expect(JSON.stringify(row)).not.toContain("token=abc");
    expect(JSON.stringify(row)).not.toContain("secret-host");
  });

  it("the dev outbox fixture only accepts explicit preview mode (development)", async () => {
    beforeOutbox(); // set up cleared counters
    const db = t.handle.db;
    await expect(
      deliverEmailWithConfig(
        db,
        { to: "a@b.test", subject: "S", body: "B" },
        { env: "development", allowDevEmailPreview: false, smtpHost: undefined },
      ),
    ).rejects.toThrow(/ALLOW_DEV_EMAIL_PREVIEW/);
    await deliverEmailWithConfig(
      db,
      { to: "a@b.test", subject: "S", body: "B" },
      { env: "development", allowDevEmailPreview: true, smtpHost: undefined },
    );
    expect(
      (db.prepare("SELECT COUNT(*) n FROM email_outbox WHERE to_email = 'a@b.test'").get() as { n: number }).n,
    ).toBe(1);
  });
});

function beforeOutbox() {
  void t;
}