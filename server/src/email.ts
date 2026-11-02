import { config, type DeploymentEnv } from "./config.js";
import type { DB } from "./db.js";

// Email delivery policy:
//  - SMTP configured (staging/production or local SMTP): send via nodemailer;
//    persist MINIMAL metadata (kind, status, safe error code) — never the body,
//    subject, token-bearing URLs, recipients, or raw SMTP error text.
//  - No SMTP + local development/test with the file/in-memory developer fixture:
//    the full body is stored in email_outbox (local fixture only; the browser
//    preview route was removed — use `npm run email:outbox` locally).
//  - No SMTP + staging/production: configuration error (validated at boot too);
//    callers degrade gracefully without enumeration.
// Same environment rules apply.

export interface QueuedEmail {
  to: string;
  kind: "verify_email" | "password_reset";
  subject: string;
  body: string;
  html?: string;
}

export { verificationEmailContent, passwordResetEmailContent } from "./emailTemplates.js";

// ---- test-only in-memory transport injection ------------------------------
type TestTransport = (mail: QueuedEmail) => Promise<void>;
let testTransport: TestTransport | null = null;

/** Inject an in-memory transport (automated tests only). */
export function setEmailTransportForTests(fn: TestTransport | null): void {
  if (config.deploymentEnv !== "test" && config.deploymentEnv !== "development") {
    throw new Error("setEmailTransportForTests is only available in test/development environments.");
  }
  testTransport = fn;
}

function logDelivery(
  db: DB,
  kind: string,
  status: "sent" | "failed" | "stored",
  errorCode: string | null,
): void {
  db.prepare(
    "INSERT INTO email_delivery_log (kind, status, error_code, created_at) VALUES (?, ?, ?, ?)",
  ).run(kind, status, errorCode, Date.now());
}

async function sendViaSmtpOrError(mail: QueuedEmail): Promise<void> {
  const nodemailer = await import("nodemailer");
  const transport = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.port === 465,
    auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.password } : undefined,
  });
  await transport.sendMail({
    from: config.smtp.from,
    to: mail.to,
    subject: mail.subject,
    text: mail.body,
    html: mail.html,
  });
}

/**
 * Delivers an email WITHOUT persisting its content in deployed environments:
 * token-bearing URLs/subjects/recipients exist in memory only.
 * `env`/`smtpHost` are injectable for automated tests.
 */
export async function deliverEmailWithConfig(
  db: DB,
  mail: { to: string; kind?: string; subject: string; body: string; html?: string },
  opts: { env: DeploymentEnv; smtpHost?: string; smtpUser?: string; smtpPassword?: string; smtpFrom?: string; allowDevEmailPreview?: boolean },
): Promise<void> {
  if (testTransport) {
    try {
      await testTransport({ ...mail, kind: (mail.kind as QueuedEmail["kind"]) ?? "verify_email" });
      logDelivery(db, mail.kind ?? "email", "sent", null);
    } catch (err) {
      const code = err instanceof Error ? err.name : "ERROR";
      logDelivery(db, mail.kind ?? "email", "failed", code || "ERROR");
      throw err;
    }
    return;
  }

  if (opts.smtpHost) {
    try {
      if (opts.env === "test" && !opts.smtpUser) {
        // Tests may point SMTP_HOST at a fake host with an injected transport —
        // handled above; reaching here without credentials is a test config bug.
        throw new Error("TEST-TRANSPORT-MISSING");
      }
      await sendViaSmtpOrError({
        to: mail.to,
        kind: (mail.kind as QueuedEmail["kind"]) ?? "verify_email",
        subject: mail.subject,
        body: mail.body,
        html: mail.html,
      });
      logDelivery(db, mail.kind ?? "email", "sent", null);
      return;
    } catch (err) {
      // Only the error NAME/identifier is persisted — raw SMTP errors can embed
      // credentials/hostnames/addresses, so they are intentionally not stored.
      const code = err instanceof Error ? err.name : "ERROR";
      logDelivery(db, mail.kind ?? "email", "failed", code || "ERROR");
      throw err;
    }
  }

  if (opts.env === "staging" || opts.env === "production") {
    throw new Error(
      "SMTP is not configured: set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD and EMAIL_FROM. Email cannot be delivered.",
    );
  }

  // Explicit development only (staging must never fake delivery locally).
  if (opts.env === "development" && !opts.allowDevEmailPreview) {
    throw new Error(
      "SMTP is not configured and ALLOW_DEV_EMAIL_PREVIEW is not enabled: email cannot be delivered or previewed.",
    );
  }
  if (opts.env === "test" && !opts.allowDevEmailPreview) {
    // Test environments use the email_outbox fixture directly (no route).
    const now = Date.now();
    db.prepare("INSERT INTO email_outbox (to_email, subject, body, created_at) VALUES (?, ?, ?, ?)").run(
      mail.to,
      mail.subject,
      mail.body,
      now,
    );
    logDelivery(db, mail.kind ?? "email", "stored", null);
    return;
  }

  const now = Date.now();
  db.prepare("INSERT INTO email_outbox (to_email, subject, body, created_at) VALUES (?, ?, ?, ?)").run(
    mail.to,
    mail.subject,
    mail.body,
    now,
  );
  console.log(`[email:outbox] to=${mail.to} subject="${mail.subject}" (stored locally; use npm run email:outbox)`);
  logDelivery(db, mail.kind ?? "email", "stored", null);
}

/** Real deployment entrypoint. */
export function deliverEmail(db: DB, mail: { to: string; kind?: string; subject: string; body: string; html?: string }): Promise<void> {
  return deliverEmailWithConfig(db, mail, {
    env: config.deploymentEnv,
    smtpHost: config.smtp.host,
    smtpUser: config.smtp.user,
    smtpPassword: config.smtp.password,
    smtpFrom: config.smtp.from,
    allowDevEmailPreview: config.allowDevEmailPreview,
  });
}
