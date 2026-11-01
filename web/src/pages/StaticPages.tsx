import { Link } from "react-router-dom";
import { Page } from "../App";
import { Panel } from "../components/ui";

export function PageLinks() {
  return (
    <nav className="footer-links" aria-label="Information pages" style={{ paddingTop: 24 }}>
      <Link to="/how-to-play" className="btn-ghost" style={{ minHeight: 44 }}>
        How to play
      </Link>
      <Link to="/privacy" className="btn-ghost" style={{ minHeight: 44 }}>
        Privacy
      </Link>
    </nav>
  );
}

export function HowToPlayPage() {
  return (
    <Page>
      <h1 style={{ fontSize: 28 }}>How to play Empire</h1>
      <ol className="manual-list" style={{ paddingLeft: 20 }}>
        <li>Pick a genre everyone can think of words for.</li>
        <li>Each player secretly picks ONE word (or short phrase) that fits the genre. Keep it hush-hush — even from the organiser!</li>
        <li>Empire reads the whole list out loud three times, in a different shuffled order each time.</li>
        <li>Empire picks a random player to go first.</li>
        <li>
          On your turn, try to guess another player's word. Note that the game plays verbally, no screens needed from
          here.
        </li>
        <li>Correct guess: that player joins your empire (you're now an empire of 2).</li>
        <li>
          Wrong guess: nothing happens except the turn passes to the player who was guessed.
        </li>
        <li>An empire's followers guess on their own turns too, and join your empire if they guess right — if someone's empire entries are captured, house rules apply and Empire doesn't adjudicate that.</li>
        <li>When everyone might be conquered, the organiser records the winner. Empires win games — biggest empire wins!</li>
      </ol>
      <p className="status-text">
        Ties and turn-order details are family choices; Empire sets up the words and shuffles only.
      </p>
      <Link to="/" className="btn-ghost">
        Back home
      </Link>
    </Page>
  );
}

export function PrivacyPage() {
  return (
    <Page>
      <h1 style={{ fontSize: 28 }}>Privacy in plain words</h1>
      <Panel heading="Words are private by design">
        <p>
          Your secret word is stored only server-side. It is never displayed to — or fetchable by — any other player,
          including the organiser's screen. During readings, the shuffled word list goes only to the one device that's
          speaking, and carries no clues about who submitted what.
        </p>
        <p>
          Honest limits: text-to-speech runs in the browser, so a technically-savvy speaker could inspect the word text
          on their device. And the operator of the server can technically access stored records — we don't claim
          end-to-end encryption.
        </p>
      </Panel>
      <Panel heading="Guests & accounts">
        <p>
          You can always play as a guest: a temporary session cookie keeps your identity across refreshes. Accounts add
          history and friends. Account emails are private and never shown through friend search or anywhere else.
        </p>
      </Panel>
      <Panel heading="What's kept, and for how long">
        <p>
          Words and reading lists are deleted as soon as a round finishes, is cancelled, or after roughly 24 hours of
          inactivity. Result history (genre, date, winner's name) is kept to power your profile. Decorative art, no
          ads, no trackers, no analytics on words.
        </p>
      </Panel>
      <Panel heading="Deleting your account">
        <p>
          Deleting your account removes your username, email, hashed password and social connections. Shared game
          history keeps results (with display names) but no longer points to your account.
        </p>
      </Panel>
      <Link to="/" className="btn-ghost">
        Back home
      </Link>
    </Page>
  );
}

export function NotFoundPage() {
  return (
    <Page>
      <h1 style={{ fontSize: 28 }}>Page not found</h1>
      <p>That page doesn't exist. Try the home screen.</p>
      <Link to="/" className="btn btn-secondary btn-cta">
        Back home
      </Link>
    </Page>
  );
}
