import { useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useStore, type WalkthroughStep } from './store';

/**
 * One registry for every guided walkthrough in the app. Each page mounts
 * `useWalkthrough(key)`; the tour auto-plays as a sequence of toast cards on
 * the first visit, can be re-launched any time from the Help page (or by
 * visiting the page with `?tour=1`), and is written for the public — no
 * jargon, verbs first.
 */
export interface TourDef {
  key: string;
  label: string;
  path: string;
  blurb: string;
  steps: WalkthroughStep[];
}

export const TOURS: Record<string, TourDef> = {
  map: {
    key: 'map',
    label: 'The map',
    path: '/map',
    blurb: 'Browse every documented camera and sensor, and see the evidence behind each one.',
    steps: [
      {
        title: 'Every point is a documented device',
        anchor: 'map-legend',
        body: 'Colored dots are cameras, license plate readers, and other surveillance devices. Colors match the legend in the corner. Numbered circles are groups — tap one to zoom in.',
      },
      {
        title: 'Tap any point for its full story',
        body: 'A panel opens with what the device is, who runs it, photos and documents, a confidence score you can tap to see explained, and its full change history.',
      },
      {
        title: 'Filters and Layers narrow the view',
        anchor: 'map-filters',
        body: 'Use Filters for technology, status, or date range. Use Layers to toggle device types or switch to a heat view. Nearby lists everything within a distance of the map center.',
      },
      {
        title: 'Directions can route around cameras',
        anchor: 'map-directions',
        body: 'Tap Directions, set where you are going, and compare the camera-avoiding route against the fastest one. You can send either to Google or Apple Maps with one tap.',
      },
      {
        title: 'See something we do not have?',
        anchor: 'map-add',
        body: 'Sign in and tap Add asset, then tap the spot on the map. Only document what is visible from public space — never people, plates, or private property interiors.',
      },
    ],
  },
  foia: {
    key: 'foia',
    label: 'Public records (FOIA)',
    path: '/foia',
    blurb: 'Request government records about surveillance — the correct law and deadline are handled for you.',
    steps: [
      {
        title: 'Ask the government for its records',
        body: 'Every state has a law requiring agencies to hand over public records. This tracker writes the request, cites the right law for the place you pick, and follows the clock.',
      },
      {
        title: 'The builder writes the letter',
        anchor: 'foia-new',
        body: 'Choose New request, pick the jurisdiction and what you want to know. The correct statute citation and required language are filled in automatically — edit anything you like.',
      },
      {
        title: 'Deadlines are computed, not guessed',
        body: 'Mark a request as sent and the legal response deadline appears. You get a notification before it lapses, so an ignored request never slips by quietly.',
      },
      {
        title: 'Attach what comes back',
        body: 'Upload the response documents to keep the paper trail in one place. Files are scanned automatically, and anything with possible personal information is held for review.',
      },
    ],
  },
  procurement: {
    key: 'procurement',
    label: 'Procurement records',
    path: '/procurement',
    blurb: 'Follow the money: contracts and purchase records reveal surveillance before it is switched on.',
    steps: [
      {
        title: 'Purchases happen before cameras appear',
        body: 'Cities buy surveillance through contracts and purchase orders — public documents. This page collects them so you can see what is coming before it is installed.',
      },
      {
        title: 'Upload a document, get the facts out',
        anchor: 'procurement-upload',
        body: 'Drop in a contract PDF and the parser pulls out the vendor, dollar amount, and technology. Nothing publishes automatically — a person reviews every extraction first.',
      },
      {
        title: 'Search and connect',
        anchor: 'procurement-search',
        body: 'Search by vendor or keyword. Records link back to map assets and policies in the same jurisdiction, so a purchase order can lead you to the exact cameras it paid for.',
      },
    ],
  },
  policies: {
    key: 'policies',
    label: 'Policies & law',
    path: '/policies',
    blurb: 'What is actually allowed here? Track surveillance rules and compare cities side by side.',
    steps: [
      {
        title: 'The rules, on a timeline',
        body: 'Every ordinance, moratorium, and oversight rule we track is laid out in time order for each place — when it passed, what it covers, and what changed.',
      },
      {
        title: 'Compare jurisdictions',
        anchor: 'policies-compare',
        body: 'Add up to four cities or counties and see their rules side by side. Useful for showing a city council what its neighbors already require.',
      },
      {
        title: 'Connected to the map',
        body: 'Policies link to the surveillance assets they govern, so you can go from "this is the law" to "these are the cameras it applies to" in one tap.',
      },
    ],
  },
  reports: {
    key: 'reports',
    label: 'Reports & exports',
    path: '/reports',
    blurb: 'Take the data with you — spreadsheets, map files, or a finished report with methodology.',
    steps: [
      {
        title: 'Pick the data, pick the format',
        anchor: 'reports-picker',
        body: 'Choose what to export — map data, FOIA tracker, procurement, policies — and a format: CSV for spreadsheets, GeoJSON or KML for mapping tools, PDF or HTML for a finished report.',
      },
      {
        title: 'Reports come with receipts',
        body: 'PDF and HTML reports include a map snapshot, the methodology, and provenance notes, so your editor or audience can check where every number came from.',
      },
      {
        title: 'Downloads are signed and short-lived',
        body: 'Generated files download over signed links and expire after 72 hours. Generate a fresh one whenever you need it — the data will be current.',
      },
    ],
  },
  workspaces: {
    key: 'workspaces',
    label: 'Workspaces',
    path: '/workspaces',
    blurb: 'Investigate as a team — shared FOIA tracking, notes, and saved map views.',
    steps: [
      {
        title: 'A shared desk for your team',
        body: 'A workspace groups people working on the same story or campaign. FOIA requests, discussion threads, and saved map views can be shared inside it.',
      },
      {
        title: 'Invite with a link',
        anchor: 'workspaces-create',
        body: 'Create a workspace and send invite links. Members join with their own accounts, and you control who can edit versus just read.',
      },
      {
        title: 'Switch context from the top bar',
        anchor: 'workspace-switcher',
        body: 'The workspace switcher in the top bar changes whose shared items you see everywhere — the map, FOIA tracker, and exports all follow it.',
      },
    ],
  },
  settings: {
    key: 'settings',
    label: 'Settings & privacy',
    path: '/settings',
    blurb: 'Appearance, notifications, and one-click control over every byte we hold about you.',
    steps: [
      {
        title: 'Make it yours',
        anchor: 'settings-appearance',
        body: 'High-contrast mode, reduced motion, and notification preferences live here. Changes apply instantly and stick to this device.',
      },
      {
        title: 'Your data is yours',
        anchor: 'settings-data',
        body: 'Download everything we hold about you with one click, or delete your account — contributions are de-attributed rather than silently rewritten, so the public record stays honest.',
      },
    ],
  },
};

/**
 * Auto-plays a page's walkthrough on first visit, or when the page is opened
 * with `?tour=1` (that is how the Help page re-launches tours). Cleans up
 * after itself if the user navigates away mid-tour.
 */
export function useWalkthrough(key: keyof typeof TOURS): void {
  const start = useStore((s) => s.startWalkthrough);
  const end = useStore((s) => s.endWalkthrough);
  const [params] = useSearchParams();
  const forced = params.get('tour') === '1';

  useEffect(() => {
    const tour = TOURS[key];
    if (!tour) return;
    // A signed-in user who hasn't completed onboarding is about to be
    // redirected to /onboarding by the app shell — this mount lives for one
    // frame. Starting (and flag-consuming) the tour here would burn the
    // first-visit walkthrough without it ever being seen.
    const onboardingPending = !!useStore.getState().user && !localStorage.getItem('stn.onboarded');
    if (onboardingPending && !forced) return;
    const storageKey = `stn.tour.${key}`;
    if (forced || !localStorage.getItem(storageKey)) {
      localStorage.setItem(storageKey, 'seen');
      start(tour.key, tour.steps);
    }
  }, [key, forced, start]);

  // End-of-life is tied to leaving the page, NOT to this effect's deps: pages
  // like the map rewrite their query string (dropping ?tour=1) moments after
  // mount, and ending the tour on that `forced` flip killed it mid-play.
  useEffect(() => () => end(TOURS[key]?.key ?? key), [key, end]);
}
