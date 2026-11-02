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
  const title = verify ? "Your empire starts here." : "Reset your password.";
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
  // Exported from HomeHero (original SVG + Baloo wordmark), not a substitute logo.
  // A versioned first-party PNG is compatible with clients that reject inline SVG/fonts.
  const brandUrl = escapeHtml(`${parsed.origin}/email/empire-compact-light-v3.png`);
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark"><style>:root{color-scheme:light dark;supported-color-schemes:light dark}.logo-dark{display:none;max-height:0;overflow:hidden}
@media(prefers-color-scheme:dark){body,.email-bg{background-color:#21182d!important}.email-copy{color:#fff9ed!important}.email-muted{color:#d7cce8!important}.logo-light{display:none!important}.logo-dark{display:block!important;max-height:none!important;overflow:visible!important}.email-divider{border-color:#6f548d!important}.email-cta{background-color:#f0503b!important;color:#fff!important}}
</style><title>${escapeHtml(subject)}</title></head>
<body class="email-bg" bgcolor="#fff9ed" style="margin:0;padding:0;background-color:#fff9ed;color:#29143f;font-family:'Nunito Sans',Arial,Helvetica,sans-serif;color-scheme:light dark;">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${intro}</div>
<table class="email-bg" role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#fff9ed" style="background-color:#fff9ed;"><tr><td align="center" style="padding:28px 20px 28px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;text-align:center;color:#29143f;">
<tr><td align="center" style="padding:0 0 24px;"><img class="logo-light" src="${brandUrl}" width="208" height="48" alt="EMPIRE" style="display:block;width:208px;max-width:100%;height:auto;border:0;margin:0 auto;">
<!--[if !mso]><!--><img class="logo-dark" src="${escapeHtml(`${parsed.origin}/email/empire-compact-dark-v3.png`)}" width="208" height="48" alt="EMPIRE" style="display:none;max-height:0;overflow:hidden;width:208px;height:auto;border:0;margin:0 auto;"><!--<![endif]-->${staging ? '<p class="email-muted" style="font-size:12px;font-weight:bold;color:#4a3563;margin:8px 0 0;">Empire — Test environment</p>' : ''}</td></tr>
<tr><td align="center" style="padding:0 8px;text-align:center;">
<h1 class="email-copy" style="font-family:'Baloo 2','Arial Rounded MT Bold',Arial,Helvetica,sans-serif;font-size:24px;font-weight:800;line-height:1.25;margin:0 0 16px;text-align:center;color:#29143f;">${title}</h1>
<p class="email-copy" style="font-size:16px;line-height:1.6;margin:0 0 24px;text-align:center;color:#29143f;">${intro}</p>
<table role="presentation" align="center" cellpadding="0" cellspacing="0" style="margin:0 auto;"><tr><td class="email-cta" align="center" bgcolor="#f0503b" style="background-color:#f0503b;border-radius:28px;text-align:center;"><a class="email-cta" href="${safeUrl}" style="display:inline-block;padding:15px 28px;color:#ffffff;font-size:19px;line-height:24px;font-weight:bold;text-decoration:none;border-radius:28px;text-align:center;">${action}</a></td></tr></table>
<p class="email-muted" style="font-size:14px;line-height:1.6;color:#4a3563;margin:16px 0 24px;text-align:center;">${expiry}</p>
</td></tr>
<tr><td class="email-divider" align="center" style="border-top:2px solid #c7adff;padding:20px 8px 0;text-align:center;">
<p class="email-muted" style="font-size:12px;line-height:1.6;color:#4a3563;margin:0 0 16px;text-align:center;">Button not working? Copy and paste this link into your browser:<br><a class="email-copy" href="${safeUrl}" style="color:#29143f;text-decoration:underline;word-break:break-all;overflow-wrap:anywhere;">${safeUrl}</a></p>
<p class="email-muted" style="font-size:12px;line-height:1.6;color:#4a3563;margin:0;text-align:center;">${ignore}</p>
</td></tr></table></td></tr></table></body></html>`;
  return { subject, body, html };
}

export function verificationEmailContent(url: string, env = config.deploymentEnv): EmailContent {
  return render("verify", url, env);
}
export function passwordResetEmailContent(url: string, env = config.deploymentEnv): EmailContent {
  return render("reset", url, env);
}
