# Design review handoff — 2 November 2026

## User feedback and approval status

The home screen remains the approved visual reference. The user likes its crown and theme. The new email design is NOT visually approved: the user says its colours are way off, the original crown/theme are missing, and alignment feels inconsistent. Review and preview corrections before treating the email design as final. Do not redesign the home screen to match the emails.

The initial email implementation (893ae35) was already deployed to staging and production before this feedback arrived. No subsequent visual corrections have been deployed. Account flows, SMTP configuration and plain-text alternatives work; preserve those.

## Findings from source and live screens

- Home uses the custom rounded coral SVG crown in `web/src/components/decor.tsx`, with lavender shadow and sparse confetti. Email substitutes a small chess-queen glyph. This is a different mark and should be removed.
- Home wordmark is uppercase EMPIRE, Baloo 2 weight 800, letter-spacing 0.04em. Email uses lowercase empire with Arial Rounded/Arial and negative spacing. It is not the same wordmark.
- App headings use Baloo 2; body and controls use Nunito Sans. Email uses Arial throughout. Email-client font support needs a fallback, but does not justify inventing another logo.
- Home background is #fff9ed and ink #29143f. These are already the same literal values in email. The overall appearance still differs: the email's large #f4ecdf panel dominates, lavender is absent, and button foreground/background differ.
- App primary CTA uses #f0503b with white text; email uses #ff684f with dark-purple text. These are different token roles. Match the visual role and validate contrast at the actual font size/weight rather than blindly copying existing accessibility comments.
- Home secondary CTA/confetti use #c7adff; the crown gradient is #FF7A61 to #F5543C with #ff9d8d highlights. Preserve the source artwork rather than approximate these by hand.
- Email centres its header and footer but left-aligns heading, paragraph and button. Home centres its hero, with left-aligned action labels and right arrows. Sign-in uses left-aligned wordmark/title/labels, centred button labels and forgot-password link, and left-aligned account helper copy. Some differences serve form usability, but the alignment rules are not explicit.

## Recommended direction for the coding AI

1. Treat `HomeHero`, `Crown`, `Wordmark` and `web/src/styles.css` as the visual source of truth. Do not create a new visual identity or change the approved home screen.
2. Reuse the exact crown and uppercase wordmark. For email, export the existing artwork/wordmark into a high-resolution email-compatible PNG with explicit dimensions and useful alt text; retain live text for the message and actions. Use a stable first-party asset URL or appropriately tested inline attachment. Do not depend on external fonts, inline SVG, emoji or chess glyphs rendering consistently in inboxes.
3. Restore the home screen's cream-led composition and coral/lavender balance. Remove or reduce the dominant beige card. Use the established primary CTA colour role. Sparse decoration can accompany the brand header; no people, cards, tagline or promotional content.
4. Propose one centred composition for these short transactional emails: brand, heading, short message and CTA share a centre line. Keep long fallback URLs readable in a clearly separated utility area. For app forms, retain left-aligned input labels and entered text; centre hero/celebration content. Document these deliberate rules instead of centring everything indiscriminately.
5. Inspect the affected screens together: home, register, sign-in, forgot/reset, verification success, both emails, and result celebration. Capture consistent 375px comparisons, then check 320/390px for clipping. Do not claim the whole app has been visually audited from home and sign-in alone.
6. Preview light and dark inbox modes where available, blocked images, long fallback links, and common mobile email clients. Same hex values do not guarantee identical perceived colour or email-client rendering. Do not claim inbox compatibility based only on a browser screenshot.
7. Keep multipart HTML/plain text, escaped URLs, correct shared token expiry, staging labels, and memory-only deployed email content. No auth, retention, SMTP or account behaviour changes are needed for this design correction.
8. Present the corrected verification and reset previews alongside the current home reference for user review before rolling out the new visual revision. Send previews only to the already approved test inbox, Quaver@quaver.me.

## Scope of this review

Source reviewed: homepage, crown/wordmark components, design tokens and buttons, email templates. Live home and sign-in inspected; browser-rendered email previews inspected. User inbox colour mismatch is user-reported; its exact mail-client cause has not been diagnosed. Other gameplay screens and physical email-client rendering were not reviewed in this pass.

## Implemented revision

The user explicitly requested implementation after reviewing the unchanged previews. The revised templates now reuse a PNG exported from the existing HomeHero component with the bundled Baloo font, use #fff9ed without a beige card, restore #f0503b/white CTAs and #c7adff accents, and centre the composition throughout. Browser previews checked at 375px; real inbox rendering still needs user review. No app/homepage UI was changed. Revision is staged for preview before production rollout.
