import { Link } from "react-router-dom";
import { HomeHero } from "../components/decor";
import { CtaButton } from "../components/ui";
import { useSession } from "../App";
import { PageLinks } from "./StaticPages";

/** Home: EMPIRE wordmark, crown/confetti decoration, two stacked CTAs and a
 * discreet sign-in/profile link — as approved in the reference image.
 * No people, cards or taglines. Guests can play without an account. */
export default function HomePage() {
  const session = useSession();
  return (
    <main className="page">
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
          <Link to="/profile" className="btn-ghost" style={{ minHeight: 44 }}>
            {session.username}
          </Link>
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
