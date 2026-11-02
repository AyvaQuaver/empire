# Account email branding

Verification, resend-verification and password reset now send multipart HTML/plain text. Templates live in `server/src/emailTemplates.ts`; token issuance imports the same 24-hour verification and one-hour reset constants. Staging subjects have `[Test]` and both alternatives identify the test environment.

Cream/purple/coral palette, inline styles, table layout, system-font fallback, a versioned first-party PNG exported directly from HomeHero (original crown, confetti and uppercase Baloo wordmark), and no tracking pixels. Asset: `web/public/email/empire-home-brand-v2.png`, 720×720 displayed at 240×240. The surrounding email uses the same cream background. Alt text remains if images are blocked. Links are escaped in HTML and remain readable in plain text. Primary CTA matches the app: #f0503b with bold 20px white text. Beige panels and substitute glyphs are removed; all message/CTA/footer content is centred. SMTP content remains memory-only in deployed environments; delivery metadata policy is unchanged.

Validation: template tests cover environment labels, expiry, HTML escaping and unsafe URL schemes. Existing auth tests cover the token flows. Physical inbox rendering in Outlook/iOS/Gmail still needs manual review.
