import { config } from "./config.js";
import type { DB } from "./db.js";

// Email delivery. With SMTP configured, sends via nodemailer. Without it,
// messages are stored in the local `email_outbox` table and the dev preview
// endpoint (ALLOW_DEV_EMAIL_PREVIEW=true, local only) can show them. This is a
// labelled development fixture, never a substitute for a real mail provider.
export interface QueuedEmail {
  to: string;
  subject: string;
  body: string;
}

export async function deliverEmail(db: DB, mail: QueuedEmail): Promise<void> {
  const now = Date.now();
  const inserted = db
    .prepare("INSERT INTO email_outbox (to_email, subject, body, created_at) VALUES (?, ?, ?, ?)")
    .run(mail.to, mail.subject, mail.body, now);

  if (!config.smtp.host) {
    console.log(
      `[email:outbox] to=${mail.to} subject="${mail.subject}" (SMTP not configured; stored locally, dev preview only)`,
    );
    return;
  }
  try {
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
    });
    db.prepare("UPDATE email_outbox SET sent_at = ? WHERE id = ?").run(Date.now(), Number(inserted.lastInsertRowid));
  } catch (err) {
    db.prepare("UPDATE email_outbox SET error = ? WHERE id = ?")
      .run(err instanceof Error ? err.message : String(err), Number(inserted.lastInsertRowid));
    throw err; // surfaces MAIL delivery problems to the caller; UI shows a friendly retry
  }
}

export function verificationEmailContent(verifyUrl: string): { subject: string; body: string } {
  return {
    subject: "Confirm your Empire account",
    body: `Welcome to Empire!\n\nConfirm your email address:\n${verifyUrl}\n\nIf you didn't create an Empire account, you can ignore this email.`,
  };
}

export function passwordResetEmailContent(resetUrl: string): { subject: string; body: string } {
  return {
    subject: "Reset your Empire password",
    body: `A password reset was requested for your Empire account.\n\nReset your password:\n${resetUrl}\n\nIf you didn't request this, you can ignore this email. The link expires in one hour.`,
  };
}
