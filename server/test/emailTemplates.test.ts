import { describe, expect, it } from "vitest";
import { passwordResetEmailContent, verificationEmailContent, VERIFY_TTL_MS, RESET_TTL_MS } from "../src/emailTemplates.js";

describe("branded account emails", () => {
  it("shares token expiry and includes actionable text and HTML links", () => {
    for (const [render, ttl] of [[verificationEmailContent, VERIFY_TTL_MS], [passwordResetEmailContent, RESET_TTL_MS]] as const) {
      const url = "https://playempire.uk/verify-email?token=fixture";
      const mail = render(url, "production");
      expect(mail.body).toContain(url);
      expect(mail.html.match(/href=/g)).toHaveLength(2);
      expect(mail.body).toContain(`expires in ${ttl / 3600000} hour`);
      expect(mail.html).toContain(`expires in ${ttl / 3600000} hour`);
      expect(mail.html).not.toContain("Test environment");
      expect(mail.html).not.toMatch(/<script|<img|@import/);
    }
  });
  it("labels staging in both MIME alternatives and the subject", () => {
    const mail = passwordResetEmailContent("https://staging.playempire.uk/reset-password?token=test", "staging");
    expect(mail.subject).toMatch(/^\[Test\]/);
    expect(mail.body).toContain("Empire — Test environment");
    expect(mail.html).toContain("Empire — Test environment");
  });
  it("escapes links in HTML without changing the plain-text URL", () => {
    const url = 'https://playempire.uk/verify-email?token=a&x="<test>';
    const mail = verificationEmailContent(url, "production");
    expect(mail.body).toContain(url);
    expect(mail.html).toContain('&amp;x=&quot;&lt;test&gt;');
    expect(() => verificationEmailContent("javascript:alert(1)")).toThrow();
  });
});
