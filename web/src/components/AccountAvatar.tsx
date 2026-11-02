import { Link } from "react-router-dom";

/* Curated Empire-compatible palette: must mirror the server-side keys in
 * server/src/services/profile.ts, including the contrasting text colour. */
const PALETTE: Record<string, { bg: string; fg: string }> = {
  coral: { bg: "#F0503B", fg: "#29143F" },
  grape: { bg: "#7B3F9E", fg: "#FFF9ED" },
  lavender: { bg: "#C7ADFF", fg: "#29143F" },
  peach: { bg: "#FF684F", fg: "#29143F" },
  ink: { bg: "#29143F", fg: "#C7ADFF" },
  plum: { bg: "#4B226E", fg: "#FFF9ED" },
};

export function avatarColors(colorKey: string | null | undefined): { bg: string; fg: string } {
  return (colorKey && PALETTE[colorKey]) || PALETTE.coral;
}

/** First user-perceived character (surrogate pairs safe). */
export function initialOf(name: string | null | undefined): string {
  const chars = Array.from((name ?? "").trim());
  for (const ch of chars) {
    if (/\p{L}|\p{N}/u.test(ch)) return ch.toUpperCase();
  }
  return chars[0] ? chars[0].toUpperCase() : "?";
}

/** Small circular avatar; the whole control is a ≥44px touch target. */
export function AccountAvatar({
  displayName,
  avatarColor,
  size = 40,
}: {
  displayName: string | null | undefined;
  avatarColor: string | null | undefined;
  size?: number;
}) {
  const { bg, fg } = avatarColors(avatarColor);
  const px = Math.round(size);
  return (
    <span
      aria-hidden="true"
      style={{
        width: px,
        height: px,
        borderRadius: "50%",
        background: bg,
        color: fg,
        fontSize: Math.round(px * 0.42),
        fontWeight: 800,
        fontFamily: "var(--font-display), system-ui, sans-serif",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        lineHeight: 1,
        letterSpacing: 0.5,
        boxShadow: "0 2px 6px rgba(41, 20, 63, 0.18)",
      }}
    >
      {initialOf(displayName)}
    </span>
  );
}

/** Top-right signed-in avatar control for the home screen. Fits under a safe
 * area inset and points straight to the profile page (simple interaction). */
export function AvatarLinkTo({
  displayName,
  avatarColor,
  to = "/profile",
}: {
  displayName: string | null | undefined;
  avatarColor: string | null | undefined;
  to?: string;
}) {
  return (
    <Link
      to={to}
      aria-label="Open your profile"
      title={displayName ?? "Your profile"}
      style={{
        // Roomier tap target than the visual circle; keeps clear of the crown.
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 48,
        height: 48,
        padding: 4,
        boxSizing: "content-box",
        borderRadius: "50%",
      }}
    >
      <AccountAvatar displayName={displayName} avatarColor={avatarColor} size={40} />
    </Link>
  );
}
