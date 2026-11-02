import { Link } from "react-router-dom";
import { HomeHero } from "../components/decor";
import { CtaButton } from "../components/ui";
import { AvatarLinkTo } from "../components/AccountAvatar";
import { useSession } from "../App";
import { PageLinks } from "./StaticPages";

/** Home: EMPIRE wordmark, crown/confetti decoration, two stacked CTAs and a
 * discreet sign-in/profile affordance — as approved in the reference image.
 * No people, cards or taglines. Guests can play without an account. Signed-in
 * players get a small circular avatar pinned to the top-right corner. */
export default function HomePage() {
  const session = useSession();
  return (
    <main className="page" style={{ position: "relative" }}>
      {session.signedIn && !session.loading && (
        <div
          style={{
            position: "absolute",
            top: "calc(env(safe-area-inset-top, 0px) + 8px)",
            right: 10,
            zIndex: 5,
          }}
        >
          <AvatarLinkTo displayName={session.displayName ?? session.username} avatarColor={session.avatarColor} />
        </div>
      )}
      <HomeHero />
      <div style={{ display: "flex", flexDirection: "column", gap: 16, width: "100%", maxWidth: 380 }}>
        <CtaButton tone="primary" href="/create">
          Create a game
        </CtaButton>
        <CtaButton tone="secondary" href="/join">
          Join a game
        </CtaButton>
      </div>
      <nav className="footer-links" aria-label="Account">
        {session.loading ? (
          <span className="skeleton" />
        ) : session.accountsEnabled === false ? (
          <p className="status-text" style={{ margin: 0 }} role="status">
            Guest preview — accounts are not available yet.
          </p>
        ) : session.signedIn ? (
          <p className="status-text" style={{ margin: 0 }}>
            Signed in as {session.displayName ?? session.username}.
          </p>
        ) : (
          <Link to="/sign-in" className="btn-ghost">
            Sign in
          </Link>
        )}
      </nav>
      <div style={{ flex: 1 }} />
      <PageLinks />
    </main>
  );
}
