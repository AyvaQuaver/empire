import { config, type DeploymentEnv } from "./config.js";

// Shared with token issuance so email copy cannot drift from real expiry.
export const VERIFY_TTL_MS = 24 * 3600 * 1000;
export const RESET_TTL_MS = 3600 * 1000;

export interface EmailContent { subject: string; body: string; html: string }
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, c => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[c]!));

function render(kind: "verify" | "reset", url: string, env: DeploymentEnv): EmailContent {
  const parsed = new URL(url);
  if (!["https:", "http:"].includes(parsed.protocol)) throw new Error("Invalid email link protocol");
  const verify = kind === "verify";
  const staging = env === "staging";
  const label = staging ? "Empire — Test environment" : "Empire";
  const title = verify ? "Your empire starts here." : "Back to building your empire.";
  const intro = verify
    ? "Confirm your email address to finish creating your account and start building your win history."
    : "We received a request to reset your password. Choose a new one using the button below.";
  const action = verify ? "Confirm my email" : "Reset my password";
  const hours = (verify ? VERIFY_TTL_MS : RESET_TTL_MS) / 3600000;
  const expiry = `This link expires in ${hours} ${hours === 1 ? "hour" : "hours"}.`;
  const ignore = verify ? "If you didn’t create an Empire account, you can ignore this email."
    : "If you didn’t request this, you can ignore this email. Your password will stay unchanged.";
  const subject = `${staging ? "[Test] " : ""}${verify ? "One more step to join Empire 👑" : "Reset your Empire password"}`;
  const safeUrl = escapeHtml(url);
  const body = `${label}\n\n${title}\n\n${intro}\n\n${action}:\n${url}\n\n${expiry}\n\n${ignore}`;
  // Table layout and inline CSS work without web fonts, external images or scripts.
  // Dark text on coral preserves contrast even when rounded corners are unsupported.
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:#fff9ed;color:#29143f;font-family:Arial,Helvetica,sans-serif;">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${intro}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fff9ed;"><tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;">
<tr><td align="center" style="padding:0 0 24px;"><div aria-hidden="true" style="color:#ff684f;font-size:42px;line-height:1;">♛</div><div style="font-family:'Arial Rounded MT Bold',Arial,Helvetica,sans-serif;font-size:40px;font-weight:900;letter-spacing:-2px;">empire</div>${staging ? '<p style="font-size:14px;font-weight:bold;color:#4a3563;">Empire — Test environment</p>' : ''}</td></tr>
<tr><td style="background:#f4ecdf;border-radius:24px;padding:28px 24px;">
<h1 style="font-size:28px;line-height:1.2;margin:0 0 20px;">${title}</h1>
<p style="font-size:16px;line-height:1.6;margin:0 0 24px;">${intro}</p>
<table role="presentation" cellpadding="0" cellspacing="0"><tr><td bgcolor="#ff684f" style="border-radius:28px;text-align:center;"><a href="${safeUrl}" style="display:inline-block;padding:17px 26px;color:#29143f;font-size:16px;font-weight:bold;text-decoration:none;border-radius:28px;">${action}</a></td></tr></table>
<p style="font-size:14px;line-height:1.6;color:#4a3563;margin:20px 0;">${expiry}</p>
<p style="font-size:13px;line-height:1.6;color:#4a3563;margin:0;">Button not working? Copy and paste this link into your browser:<br><a href="${safeUrl}" style="color:#29143f;text-decoration:underline;word-break:break-all;overflow-wrap:anywhere;">${safeUrl}</a></p>
</td></tr><tr><td style="padding:24px 12px;font-size:13px;line-height:1.6;color:#4a3563;text-align:center;">${ignore}</td></tr>
</table></td></tr></table></body></html>`;
  return { subject, body, html };
}

export function verificationEmailContent(url: string, env = config.deploymentEnv): EmailContent {
  return render("verify", url, env);
}
export function passwordResetEmailContent(url: string, env = config.deploymentEnv): EmailContent {
  return render("reset", url, env);
}
