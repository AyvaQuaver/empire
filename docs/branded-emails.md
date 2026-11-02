# Account email branding

Verification, resend-verification and password reset now send multipart HTML/plain text. Templates live in `server/src/emailTemplates.ts`; token issuance imports the same 24-hour verification and one-hour reset constants. Staging subjects have `[Test]` and both alternatives identify the test environment.

Cream/purple/coral palette, inline styles, table layout, system-font fallback, no external images or tracking pixels. The crown is a text glyph, so its shape may differ between email clients. Links are escaped in HTML and remain readable in plain text. Dark-purple button text preserves contrast on coral. SMTP content remains memory-only in deployed environments; delivery metadata policy is unchanged.

Validation: template tests cover environment labels, expiry, HTML escaping and unsafe URL schemes. Existing auth tests cover the token flows. Physical inbox rendering in Outlook/iOS/Gmail still needs manual review.
