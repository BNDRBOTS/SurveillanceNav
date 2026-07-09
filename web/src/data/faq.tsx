import { Link } from 'react-router-dom';

/**
 * Answers to the questions the public actually asks — shared verbatim between
 * the Help page and the marketing landing so the two can never drift apart.
 * Written for journalists, organizers, and neighbors — not engineers. Every
 * claim here is checked against actual behavior; keep it that way.
 */
export const FAQ: Array<{ q: string; a: JSX.Element | string }> = [
  {
    q: 'Where does the map data come from?',
    a: (
      <>
        Three places: community members documenting devices from public space, imported open datasets (Will
        Freeman's <a href="https://deflock.me" target="_blank" rel="noopener noreferrer">DeFlock</a> /
        OpenStreetMap, clearly labeled and ODbL-licensed), and public records — procurement documents and FOIA
        responses. Every record shows its sources, and the confidence score tells you how well-corroborated it is.
        Tap any score to see exactly why it is what it is.
      </>
    ),
  },
  {
    q: 'A record about my street is wrong. How do I fix it?',
    a: (
      <>
        Open the record on the <Link to="/map">map</Link> and use <strong>Dispute</strong>. Attach whatever you can —
        a photo of the empty pole, a decommission notice. Curators are required to respond, and the resolution becomes
        permanent public history on that record.
      </>
    ),
  },
  {
    q: 'Is camera avoidance guaranteed?',
    a: (
      <>
        Honesty matters here: it depends on the routing engine available, and the label on your route tells you which
        you got. <strong>Guaranteed</strong> means the engine hard-excluded known camera zones.{' '}
        <strong>Best effort</strong> means the route was steered away where possible but not strictly. And it only
        covers cameras <em>we know about</em> — an empty database means an uncovered street, not a safe one.
      </>
    ),
  },
  {
    q: 'Does it work offline?',
    a: (
      <>
        Yes. The basemap is bundled with the app, data you have seen is cached with integrity checks, and anything you
        submit while offline is queued and synced automatically when you reconnect. Install it from your browser menu
        (&ldquo;Add to Home Screen&rdquo;) for the full experience.
      </>
    ),
  },
  {
    q: 'What do you collect about me?',
    a: (
      <>
        As little as a working account needs: email (a pseudonym is fine), a password we only store as a hash, and your
        contributions. No trackers, no ad IDs, no selling data, no AI training on your content. The complete inventory
        is on the <Link to="/privacy">privacy page</Link>, and you can download or delete everything from{' '}
        <Link to="/settings">Settings</Link>.
      </>
    ),
  },
  {
    q: 'Can I use this data in my reporting?',
    a: (
      <>
        That is what it is for. Use <Link to="/reports">Reports &amp; exports</Link> to pull CSV for analysis, GeoJSON
        for your graphics desk, or a finished PDF/HTML report with methodology and provenance notes you can cite.
        Imported open data keeps its original license — exports label it.
      </>
    ),
  },
];
