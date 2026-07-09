import { useId, type SVGProps } from 'react';

/**
 * STN custom icon set — original geometry drawn for this app, not an icon
 * library. The language: machined optics. Angular, faceted silhouettes with
 * slanted edges (echoing the parallelogram surfaces), a translucent duotone
 * body, a gradient stroke in the icon's jewel tone, and a small champagne-gold
 * "signal" detail that catches the eye. Feature icons carry their own hue;
 * utility glyphs (plus, x, check…) stay `currentColor` so they inherit button
 * ink correctly. High-contrast mode strips color, glow, and facets via base.css.
 *
 * Every glyph is built from up to five layers, drawn in this order:
 *   dim    — translucent tone fill silhouette (depth)
 *   detail — interior/secondary linework at ~0.63× weight (recedes)
 *   base   — primary structure at full weight (the silhouette)
 *   facet  — short catch-light glints in the light tone along lit edges
 *   spark  — the champagne-gold signal detail
 *
 * Size with `size` (px, default 20). Override hue with `tone`, or force
 * monochrome with tone="mono". `glow` adds the subtle halo (defaults on for
 * toned icons, off for mono).
 */
export type IconName =
  | 'map'
  | 'mail'
  | 'file-text'
  | 'scale'
  | 'download'
  | 'users'
  | 'shield'
  | 'code'
  | 'bell'
  | 'plus'
  | 'check'
  | 'chevron-down'
  | 'locate'
  | 'map-pin'
  | 'volume-2'
  | 'volume-x'
  | 'camera'
  | 'flag'
  | 'car'
  | 'footprints'
  | 'bike'
  | 'arrow-up-down'
  | 'x'
  | 'alert-triangle'
  | 'zap'
  | 'play'
  | 'external-link'
  | 'navigation'
  | 'filter'
  | 'layers'
  | 'target'
  | 'star'
  | 'link'
  | 'trash'
  | 'image'
  | 'loader'
  | 'edit'
  | 'eye'
  | 'eye-off'
  | 'wifi-off'
  | 'compass'
  | 'life-buoy';

export type IconTone = 'gold' | 'violet' | 'cyan' | 'rose' | 'ember' | 'jade' | 'crimson' | 'silver' | 'mono';

/** Jewel palette — mirrors tokens.css (contrast-audited there). */
const TONES: Record<Exclude<IconTone, 'mono'>, { light: string; base: string; halo: string }> = {
  gold:    { light: '#F7E3B0', base: '#E9C46A', halo: 'rgba(233,196,106,0.45)' },
  violet:  { light: '#C9BEFF', base: '#A18FFF', halo: 'rgba(161,143,255,0.45)' },
  cyan:    { light: '#8CE4F2', base: '#3FC9DE', halo: 'rgba(63,201,222,0.45)' },
  rose:    { light: '#F9A2C2', base: '#F0699C', halo: 'rgba(240,105,156,0.45)' },
  ember:   { light: '#FFBD95', base: '#FF8E4D', halo: 'rgba(255,142,77,0.45)' },
  jade:    { light: '#8FE9BC', base: '#46D68C', halo: 'rgba(70,214,140,0.45)' },
  crimson: { light: '#FF9B9B', base: '#FF5C5C', halo: 'rgba(255,92,92,0.45)' },
  silver:  { light: '#D6DAE4', base: '#9BA3B5', halo: 'rgba(155,163,181,0.40)' },
};

const GOLD = 'var(--color-accent, #E9C46A)';

/* Weight system: structure carries the silhouette; detail linework recedes
   at ~0.63× (1.75 → ~1.1); facet glints sit lighter still, rounded. */
const DETAIL_RATIO = 0.63;
const FACET_RATIO = 0.52;

interface Glyph {
  tone: IconTone;
  /** Primary structure — gradient-stroked at full weight. */
  base: JSX.Element;
  /** Interior/secondary linework — same ink, lighter weight. */
  detail?: JSX.Element;
  /** Translucent duotone body (filled silhouette). */
  dim?: JSX.Element;
  /** Catch-light glints along lit edges — light tone, rounded caps. */
  facet?: JSX.Element;
  /** Champagne-gold signal detail. */
  spark?: JSX.Element;
}

const GLYPHS: Record<IconName, Glyph> = {
  /* Folded field map: slanted panels, receding fold seams, a surveyed route
     crossing the sheets, gold locator diamond. */
  map: {
    tone: 'gold',
    dim: <path d="M4 6.5 10 3.5l4 2 6-3v15l-6 3-4-2-6 3Z" />,
    base: <path d="M4 6.5 10 3.5l4 2 6-3v15l-6 3-4-2-6 3Z" />,
    detail: (
      <>
        <path d="M10 3.5v15M14 5.5v15" />
        <path d="M6.3 14.6l2.6-1.8 2.9 1.5 3.2-2.2 2.7 1.4" />
      </>
    ),
    facet: <path d="M4.8 6.1 8.6 4.2" />,
    spark: <path d="M12 8.6 14 10.6 12 12.6 10 10.6Z" fill={GOLD} stroke="none" />,
  },
  /* Envelope with clipped corner: the flap and corner seam recede; gold seal
     where the fold lines meet. */
  mail: {
    tone: 'cyan',
    dim: <path d="M3 6h15l3 3v9H3Z" />,
    base: <path d="M3 6h15l3 3v9H3Z" />,
    detail: (
      <>
        <path d="m3 6.5 9 6.5 9-4" />
        <path d="M18 6v3h3" />
      </>
    ),
    facet: <path d="M3.8 6h5.4" />,
    spark: <circle cx="12" cy="13" r="1.3" fill={GOLD} stroke="none" />,
  },
  /* Document with a deep slant-cut corner: text rules recede, one gold
     redaction bar holds the eye. */
  'file-text': {
    tone: 'violet',
    dim: <path d="M6 3h8.5L19 7.5V21H6Z" />,
    base: (
      <>
        <path d="M6 3h8.5L19 7.5V21H6Z" />
        <path d="M14.5 3v4.5H19" />
      </>
    ),
    detail: <path d="M9 12.2h7M9 15.6h4.5M9 18.4h6" />,
    facet: <path d="M6 3.8v3.6" />,
    spark: <path d="M9 8.6h2.6" stroke={GOLD} strokeWidth="2.2" />,
  },
  /* Balance: slanted beam, open triangle pans hung on fine links, plinth. */
  scale: {
    tone: 'rose',
    base: (
      <>
        <path d="M12 4.5v15.5M8.5 20h7" />
        <path d="M5 7.6 19 6.2" />
        <path d="M2.8 13 5 8.6l2.2 4.4H2.8ZM16.8 11.6 19 7.2l2.2 4.4h-4.4Z" />
      </>
    ),
    detail: <path d="M5 7.7v.9M19 6.3v.9M10.3 18.3h3.4" />,
    facet: <path d="M5.8 7.45l3.2-.32" />,
    spark: <path d="M12 5.5 13.5 7 12 8.5 10.5 7Z" fill={GOLD} stroke="none" />,
  },
  /* Delivery tray with chamfered arrowhead; inner lip recedes, gold landing
     dot marks the catch. */
  download: {
    tone: 'ember',
    base: (
      <>
        <path d="M4 16.5V21h16v-4.5" />
        <path d="M12 3v10.5M7.5 9 12 13.5 16.5 9" />
      </>
    ),
    detail: <path d="M6.4 19.4h11.2" />,
    facet: <path d="M8.3 9.8 10.6 12.1" />,
    spark: <circle cx="12" cy="17.2" r="1.25" fill={GOLD} stroke="none" />,
  },
  /* Two angular busts — hex heads, squared shoulders; the companion figure
     recedes behind the primary. */
  users: {
    tone: 'jade',
    dim: (
      <>
        <path d="M9 5 11.2 6.3v2.6L9 10.2 6.8 8.9V6.3Z" />
        <path d="M3.5 19v-2.2L6 13.8h6l2.5 3V19Z" />
      </>
    ),
    base: (
      <>
        <path d="M9 5 11.2 6.3v2.6L9 10.2 6.8 8.9V6.3Z" />
        <path d="M3.5 19v-2.2L6 13.8h6l2.5 3V19" />
      </>
    ),
    detail: <path d="M15.8 13.8h2.8l2 2.6V19M15.9 5.7l1.8 1.1v2.2l-1.8 1.1" />,
    facet: <path d="M7.3 6 8.6 5.25" />,
  },
  /* Angular ward shield: machined inner bevel recedes, gold optic slit. */
  shield: {
    tone: 'crimson',
    dim: <path d="M12 3l8 3v6l-2.5 5.5L12 21l-5.5-3.5L4 12V6Z" />,
    base: <path d="M12 3l8 3v6l-2.5 5.5L12 21l-5.5-3.5L4 12V6Z" />,
    detail: <path d="M12 5.3 18 7.55v4.15L16.1 16 12 18.6l-4.1-2.6L6 11.7V7.55Z" />,
    facet: <path d="M5.4 5.5 9.3 4" />,
    spark: (
      <>
        <path d="M9.2 11h5.6" stroke={GOLD} />
        <circle cx="12" cy="11" r="1.1" fill={GOLD} stroke="none" />
      </>
    ),
  },
  /* Slanted brackets; the slash is the gold beam. */
  code: {
    tone: 'violet',
    base: <path d="M8.5 7 3.5 12l5 5M15.5 7l5 5-5 5" />,
    spark: <path d="M13.6 4.5 10.4 19.5" stroke={GOLD} />,
  },
  /* Faceted bell: shoulder seam and clapper recede; sharp gold ring ticks. */
  bell: {
    tone: 'gold',
    dim: <path d="M12 3.5 14.8 5.2l1 4.3 1.7 4.5 2 2.5H4.5l2-2.5 1.7-4.5 1-4.3Z" />,
    base: <path d="M12 3.5 14.8 5.2l1 4.3 1.7 4.5 2 2.5H4.5l2-2.5 1.7-4.5 1-4.3Z" />,
    detail: (
      <>
        <path d="M10.2 19.5 12 21l1.8-1.5" />
        <path d="M8.8 9.5h6.4" />
      </>
    ),
    facet: <path d="M9.7 4.9 11.5 3.75" />,
    spark: <path d="M18.6 5.4 20.2 3.8M19.9 8.6l2.2-.6" stroke={GOLD} />,
  },
  plus: { tone: 'mono', base: <path d="M12 5v14M5 12h14" /> },
  check: { tone: 'mono', base: <path d="M4.5 12.5 10 18 19.5 7" /> },
  'chevron-down': { tone: 'mono', base: <path d="M6 9.5 12 15.5 18 9.5" /> },
  /* Registration-mark crosshair: corner brackets + receding ticks + gold core. */
  locate: {
    tone: 'cyan',
    base: <path d="M4 8V4h4M16 4h4v4M20 16v4h-4M8 20H4v-4" />,
    detail: <path d="M12 7.5v3M12 13.5v3M7.5 12h3M13.5 12h3" />,
    facet: <path d="M4.6 6.8V4.6h2.2" />,
    spark: <circle cx="12" cy="12" r="1.4" fill={GOLD} stroke="none" />,
  },
  /* Faceted diamond pin; shoulder seam recedes. */
  'map-pin': {
    tone: 'gold',
    dim: <path d="M12 21.5 6.5 13.5V9L9 5.5h6L17.5 9v4.5Z" />,
    base: <path d="M12 21.5 6.5 13.5V9L9 5.5h6L17.5 9v4.5Z" />,
    detail: <path d="M6.5 9h11" />,
    facet: <path d="M7.2 8.2 8.6 6.2" />,
    spark: <path d="M12 10.2 13.6 11.8 12 13.4 10.4 11.8Z" fill={GOLD} stroke="none" />,
  },
  /* Angular horn; mouth seam recedes, gold beams radiate. */
  'volume-2': {
    tone: 'cyan',
    dim: <path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4Z" />,
    base: <path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4Z" />,
    detail: <path d="M7.5 9.9v4.2" />,
    facet: <path d="M8.4 8.8 10.6 6.85" />,
    spark: <path d="M15.5 9.5 18 8M15.5 14.5 18 16M16.5 12h3" stroke={GOLD} />,
  },
  'volume-x': {
    tone: 'crimson',
    dim: <path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4Z" />,
    base: <path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4Z" />,
    detail: <path d="M7.5 9.9v4.2" />,
    spark: <path d="m16 9.5 5 5M21 9.5l-5 5" stroke={GOLD} />,
  },
  /* Bullet surveillance camera on a mount — the subject of the whole app.
     Lens seam and mount recede; gold detection beams. */
  camera: {
    tone: 'crimson',
    dim: <path d="M3 7.5 14.5 4.5 16.2 9 4.7 12Z" />,
    base: <path d="M3 7.5 14.5 4.5 16.2 9 4.7 12Z" />,
    detail: (
      <>
        <path d="M12.6 5 14.3 9.5" />
        <path d="M9 12v4.5M6.5 16.5h5" />
      </>
    ),
    facet: <path d="M4.4 7.1 8.9 6" />,
    spark: <path d="M18 8.2 20.8 7.5M17.8 10.6 20.2 11.4" stroke={GOLD} />,
  },
  /* Notched pennant. */
  flag: {
    tone: 'jade',
    dim: <path d="M5 4.5h14.5L16.5 8l3 3.5H5Z" />,
    base: (
      <>
        <path d="M5 3v18" />
        <path d="M5 4.5h14.5L16.5 8l3 3.5H5" />
      </>
    ),
    facet: <path d="M5.8 4.5h5.4" />,
  },
  /* Angular sedan profile: beltline and rocker recede, gold hubs. */
  car: {
    tone: 'cyan',
    base: (
      <>
        <path d="M3.5 16.5v-4L6 8.5h9l3.5 3.5 2 .6v3.9h-2.1" />
        <circle cx="7.5" cy="16.8" r="1.8" />
        <circle cx="16.5" cy="16.8" r="1.8" />
      </>
    ),
    detail: <path d="M6.8 12.3H16M9.5 16.5h5" />,
    facet: <path d="M7 8.5h4" />,
    spark: (
      <>
        <circle cx="7.5" cy="16.8" r="0.7" fill={GOLD} stroke="none" />
        <circle cx="16.5" cy="16.8" r="0.7" fill={GOLD} stroke="none" />
      </>
    ),
  },
  /* Single boot print, from above: wide ball of foot, arch taper, offset
     heel block, gold tread bar across the ball. */
  footprints: {
    tone: 'jade',
    dim: <path d="M9.2 4.2 13.8 4.7 14.9 6.8 14.2 10.6 13 12 9.6 11.4 8.8 7.2Z" />,
    base: (
      <>
        <path d="M9.2 4.2 13.8 4.7 14.9 6.8 14.2 10.6 13 12 9.6 11.4 8.8 7.2Z" />
        <path d="M10.1 14.8 14 15.4 13.6 18.7 10.3 18.2Z" />
      </>
    ),
    facet: <path d="M9.9 4.55 12.6 4.9" />,
    spark: <path d="M10 8.4l3.5.5" stroke={GOLD} />,
  },
  /* Diamond-frame bicycle: stem recedes, gold hubs. */
  bike: {
    tone: 'ember',
    base: (
      <>
        <circle cx="5.6" cy="17" r="3.4" />
        <circle cx="18.4" cy="17" r="3.4" />
        <path d="M5.6 17 9.8 9.5h5.5L18.4 17M12.3 17 9.8 9.5" />
      </>
    ),
    detail: <path d="M15.3 9.5 14.1 6.5h2.6" />,
    facet: <path d="M10.7 9.5h2.6" />,
    spark: (
      <>
        <circle cx="5.6" cy="17" r="0.9" fill={GOLD} stroke="none" />
        <circle cx="18.4" cy="17" r="0.9" fill={GOLD} stroke="none" />
      </>
    ),
  },
  'arrow-up-down': {
    tone: 'mono',
    base: <path d="M8 4.5v15M4.5 8 8 4.5 11.5 8M16 19.5v-15M12.5 16 16 19.5 19.5 16" />,
  },
  x: { tone: 'mono', base: <path d="M18 6 6 18M6 6l12 12" /> },
  /* Flat-top hazard wedge; gold strike bar. */
  'alert-triangle': {
    tone: 'ember',
    dim: <path d="M10.8 4.5h2.4L21 19.5H3Z" />,
    base: <path d="M10.8 4.5h2.4L21 19.5H3Z" />,
    facet: <path d="M9.9 6.2 8.4 9.2" />,
    spark: (
      <>
        <path d="M12 9.5V14" stroke={GOLD} />
        <circle cx="12" cy="16.6" r="1.1" fill={GOLD} stroke="none" />
      </>
    ),
  },
  /* Faceted bolt. */
  zap: {
    tone: 'ember',
    dim: <path d="M13.5 2.5 5.5 13.5H11L10 21.5 18.5 10.5H13Z" />,
    base: <path d="M13.5 2.5 5.5 13.5H11L10 21.5 18.5 10.5H13Z" />,
    facet: <path d="M12.6 3.9 10.9 6.2" />,
  },
  /* Chamfered play wedge — mono so it inherits button ink. */
  play: { tone: 'mono', base: <path d="M7 4.5 18.5 11v2L7 19.5Z" /> },
  /* Outbound arrow leads; the frame recedes behind it. */
  'external-link': {
    tone: 'mono',
    base: <path d="M14 3.5h6.5V10M20.5 3.5l-9 9" />,
    detail: <path d="M10 5H5.5v13.5H19V14" />,
  },
  /* Machined compass needle: center seam recedes, gold pivot. */
  navigation: {
    tone: 'gold',
    dim: <path d="M12 2.5 18.5 21 12 16.5Z" />,
    base: <path d="M12 2.5 18.5 21 12 16.5 5.5 21Z" />,
    detail: <path d="M12 2.5v14" />,
    facet: <path d="M11.3 4.5 10.3 7.4" />,
    spark: <circle cx="12" cy="14.4" r="1.05" fill={GOLD} stroke="none" />,
  },
  /* Sharp funnel: rim seam recedes, gold flow tick in the stem. */
  filter: {
    tone: 'violet',
    dim: <path d="M3.5 4.5h17L14.5 11.5V19l-5 2.5V11.5Z" />,
    base: <path d="M3.5 4.5h17L14.5 11.5V19l-5 2.5V11.5Z" />,
    detail: <path d="M5.9 6.4h12.2" />,
    facet: <path d="M4.3 4.5h4.6" />,
    spark: <path d="M12 13.6v2.6" stroke={GOLD} />,
  },
  /* Stacked slanted sheets: lower sheets recede, gold marks the active one. */
  layers: {
    tone: 'cyan',
    dim: <path d="M4.5 8 12 4.2 19.5 8 12 11.8Z" />,
    base: <path d="M4.5 8 12 4.2 19.5 8 12 11.8Z" />,
    detail: <path d="M6.7 11.9 4.5 13 12 16.8 19.5 13l-2.2-1.1M6.7 16.7 4.5 17.8 12 21.6l7.5-3.8-2.2-1.1" />,
    facet: <path d="M6.4 7 9.6 5.4" />,
    spark: <path d="M12 6.8 13.3 8 12 9.2 10.7 8Z" fill={GOLD} stroke="none" />,
  },
  /* Concentric diamonds — a reticle, not a bullseye; inner ring recedes. */
  target: {
    tone: 'ember',
    base: <path d="M12 3.5 20.5 12 12 20.5 3.5 12Z" />,
    detail: <path d="M12 7.5 16.5 12 12 16.5 7.5 12Z" />,
    facet: <path d="M10.4 5.1 8 7.5" />,
    spark: <circle cx="12" cy="12" r="1.2" fill={GOLD} stroke="none" />,
  },
  /* Four-point compass sparkle. */
  star: {
    tone: 'gold',
    dim: <path d="M12 2.5 14.2 9.8 21.5 12 14.2 14.2 12 21.5 9.8 14.2 2.5 12 9.8 9.8Z" />,
    base: <path d="M12 2.5 14.2 9.8 21.5 12 14.2 14.2 12 21.5 9.8 14.2 2.5 12 9.8 9.8Z" />,
    facet: <path d="M11.3 4.8 10.6 7.2" />,
  },
  /* Chamfered chain plates. */
  link: {
    tone: 'cyan',
    base: (
      <>
        <path d="M9.5 7H6L3.5 9.5v5L6 17h3.5M14.5 7H18l2.5 2.5v5L18 17h-3.5" />
        <path d="M8.5 12h7" />
      </>
    ),
    facet: <path d="M6.6 7h2.4" />,
  },
  trash: {
    tone: 'mono',
    base: (
      <>
        <path d="M4.5 7h15M9 7l.8-3h4.4L15 7" />
        <path d="M6 7l1 13.5h10L18 7" />
      </>
    ),
    detail: <path d="M10.2 10.5l.3 6.5M13.8 10.5l-.3 6.5" />,
  },
  /* Cut-corner frame: ridgeline recedes, gold sun diamond. */
  image: {
    tone: 'violet',
    base: <path d="M4 4.5h13l3 3v12H4Z" />,
    detail: <path d="M4 16.5 9.5 11l3.5 3.5 3-3 4 4" />,
    facet: <path d="M4.7 4.5h4.2" />,
    spark: <path d="M8.3 6.7 9.6 8 8.3 9.3 7 8Z" fill={GOLD} stroke="none" />,
  },
  loader: { tone: 'mono', base: <path d="M21 12a9 9 0 1 1-6.2-8.6" /> },
  edit: {
    tone: 'mono',
    base: <path d="M4 20l1.5-5L16.5 4 20 7.5 9 18.5Z" />,
    detail: <path d="M14.5 6 18 9.5" />,
  },
  /* Angular lens-eye with faceted iris — the brand mark motif. */
  eye: {
    tone: 'mono',
    base: (
      <>
        <path d="M2.5 12 8 6.5h8L21.5 12 16 17.5H8Z" />
        <path d="M12 8.8 15.2 12 12 15.2 8.8 12Z" />
      </>
    ),
  },
  'eye-off': {
    tone: 'mono',
    base: (
      <>
        <path d="M2.5 12 8 6.5h8L21.5 12 16 17.5H8Z" />
        <path d="M4 20 20 4" />
      </>
    ),
  },
  /* Chevron signal, struck through. */
  'wifi-off': {
    tone: 'ember',
    base: (
      <>
        <path d="M5 10.5 12 5.5l7 5M8 13.7 12 10.7l4 3" />
        <circle cx="12" cy="17.3" r="1.1" fill="currentColor" stroke="none" />
      </>
    ),
    spark: <path d="M4.5 19.5 19.5 4.5" stroke={GOLD} />,
  },
  /* Faceted compass rose — Help wayfinding. */
  compass: {
    tone: 'gold',
    base: (
      <>
        <path d="M12 2.5 21.5 12 12 21.5 2.5 12Z" />
        <path d="M14.8 9.2 13 14.2 9.2 14.8 11 9.8Z" />
      </>
    ),
    facet: <path d="M10.4 4.1 8.3 6.2" />,
    spark: <circle cx="12" cy="12" r="1" fill={GOLD} stroke="none" />,
  },
  /* Ring with cardinal spokes — support/help; spokes recede. */
  'life-buoy': {
    tone: 'jade',
    base: (
      <>
        <circle cx="12" cy="12" r="9" />
        <circle cx="12" cy="12" r="3.6" />
      </>
    ),
    detail: <path d="M12 3v5.4M12 15.6V21M3 12h5.4M15.6 12H21" />,
    spark: <circle cx="12" cy="12" r="1" fill={GOLD} stroke="none" />,
  },
};

export function Icon({
  name,
  size = 20,
  strokeWidth = 1.75,
  tone,
  glow,
  style,
  ...rest
}: {
  name: IconName;
  size?: number;
  strokeWidth?: number;
  tone?: IconTone;
  glow?: boolean;
} & Omit<SVGProps<SVGSVGElement>, 'name'>): JSX.Element {
  const gid = useId();
  const glyph = GLYPHS[name];
  const activeTone = tone ?? glyph.tone;
  const mono = activeTone === 'mono';
  const palette = mono ? null : TONES[activeTone];
  const wantGlow = glow ?? !mono;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={mono ? 'currentColor' : `url(#${gid})`}
      strokeWidth={strokeWidth}
      strokeLinecap="square"
      strokeLinejoin="miter"
      aria-hidden="true"
      className="icon-duo"
      style={{
        verticalAlign: 'middle',
        flexShrink: 0,
        ...(palette && wantGlow ? { filter: `drop-shadow(0 0 3px ${palette.halo})` } : {}),
        ...style,
      }}
      {...rest}
    >
      {palette ? (
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor={palette.light} />
            <stop offset="1" stopColor={palette.base} />
          </linearGradient>
        </defs>
      ) : null}
      {glyph.dim && palette ? (
        <g data-layer="dim" fill={palette.base} fillOpacity={0.14} stroke="none">
          {glyph.dim}
        </g>
      ) : null}
      {glyph.detail ? (
        <g data-layer="detail" strokeWidth={strokeWidth * DETAIL_RATIO} opacity={mono ? 0.75 : 1}>
          {glyph.detail}
        </g>
      ) : null}
      {glyph.base}
      {glyph.facet && palette ? (
        <g
          data-layer="facet"
          stroke={palette.light}
          strokeWidth={strokeWidth * FACET_RATIO}
          strokeOpacity={0.95}
          strokeLinecap="round"
        >
          {glyph.facet}
        </g>
      ) : null}
      {glyph.spark && !mono ? (
        <g data-layer="spark" stroke={GOLD}>
          {glyph.spark}
        </g>
      ) : null}
    </svg>
  );
}
