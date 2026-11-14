// Launch Radar's model: one sealed snapshot of the protocol universe in, one ranked board out.
//
// The board ranks every protocol that records no token yet — the whole watchlist (the floor, never a
// ceiling) plus every other pre-token protocol the snapshot carries, early ones included — by what a
// launch would be worth if the protocol's record stayed as it is. Protocols whose token already
// trades are never ranked: they are set aside as the comparables the model is priced from, and the
// dashboard shows them apart, at the market's own values.
//
// The implied value is priced from the snapshot's own figures, never from a list of names:
//
//   peers      = the tokenized protocols in the same DefiLlama category
//   ratio      = mcap_usd / tvl_usd for each peer
//   multiple   = the category's median ratio, shrunk toward the global median ratio by the peer
//                count (shrink K = 6) and clamped to [0.03, 1.20]; a category with fewer than 3
//                peers prices at the global median
//   growth     = 1 + clamp(change_7d, -60, 120) / 100 x 0.5
//   runway     = 0.78 + 0.44 x sqrt(min(age_days, 1460) / 1460): the longer a protocol has run
//                with no token, the more usage a launch would capitalise (age unknown: the
//                snapshot's median age)
//   breadth    = 1 + 0.025 x min(chains - 1, 8): distribution across chains is worth a premium
//   implied    = max(1, round(tvl_usd x multiple x growth x runway x breadth))
//
// The same function scores every row; no protocol's name is ever special-cased. Each board row
// carries the multiple it was priced at and the peer count behind it, so a reader can audit the
// price back to the snapshot.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's version label: the dashboard names it. */
export const MODEL_VERSION = 'comps-2';

/** How hard a thin category's median is pulled toward the global median. */
export const SHRINK_K = 6;
/** A category needs at least this many tokenized peers before its own median is trusted at all. */
export const MIN_PEERS = 3;
/** The band a category multiple is clamped to. */
export const MULTIPLE_FLOOR = 0.03;
export const MULTIPLE_CAP = 1.2;
/** The seven-day growth input's clamps and weight. */
export const GROWTH_FLOOR = -60;
export const GROWTH_CAP = 120;
export const GROWTH_WEIGHT = 0.5;
/** The runway (age with no token) curve: floor + range x sqrt(min(age, days) / days). */
export const RUNWAY_FLOOR = 0.78;
export const RUNWAY_RANGE = 0.44;
export const RUNWAY_DAYS = 1460;
/** The breadth premium: this much per extra chain, up to EXTRA_CHAINS chains past the first. */
export const CHAIN_STEP = 0.025;
export const EXTRA_CHAINS = 8;
/** How many live-token protocols the dashboard's Already trading view carries, by market cap. */
export const LIVE_ROWS = 40;

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** A whole day count from `from` to `to`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** The median of a non-empty list: the middle value, or the mean of the two middle ones. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;
const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));
const bySlugAsc = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** One category's pricing: how many tokenized peers, their median ratio, and the multiple used. */
export interface CategoryPrice {
  category: string | null;
  peers: number;
  median_ratio: number | null;
  multiple: number;
}

/** The pricing table the whole board is priced from: per-category multiples and the global median. */
export interface Pricing {
  global_ratio: number;
  byCategory: Map<string | null, CategoryPrice>;
  table: CategoryPrice[];
}

/**
 * Price every category from the snapshot's tokenized protocols: the median market-cap-to-TVL ratio
 * of its peers, shrunk toward the global median by the peer count, clamped to the model's band.
 */
export function priceCategories(snapshot: Snapshot): Pricing {
  const ratiosByCategory = new Map<string | null, number[]>();
  const all: number[] = [];
  for (const p of snapshot.protocols) {
    if (p.mcap_usd === null || p.tvl_usd <= 0) continue;
    const ratio = p.mcap_usd / p.tvl_usd;
    all.push(ratio);
    const list = ratiosByCategory.get(p.category) ?? [];
    list.push(ratio);
    ratiosByCategory.set(p.category, list);
  }
  const global = all.length > 0 ? median(all) : 0.17;
  const byCategory = new Map<string | null, CategoryPrice>();
  for (const [category, ratios] of ratiosByCategory) {
    const med = median(ratios);
    const multiple =
      ratios.length >= MIN_PEERS
        ? clamp((ratios.length * med + SHRINK_K * global) / (ratios.length + SHRINK_K), MULTIPLE_FLOOR, MULTIPLE_CAP)
        : global;
    byCategory.set(category, { category, peers: ratios.length, median_ratio: round4(med), multiple: round4(multiple) });
  }
  const table = [...byCategory.values()].sort((a, b) => b.peers - a.peers || bySlugAsc(a.category ?? '', b.category ?? ''));
  return { global_ratio: round4(global), byCategory, table };
}

/** The median age in days of the snapshot's dated protocols: the age an undated one is priced with. */
export function medianAgeDays(snapshot: Snapshot): number {
  const ages: number[] = [];
  for (const p of snapshot.protocols) {
    const age = ageDays(snapshot.as_of, p.listed_at);
    if (age !== null) ages.push(age);
  }
  return ages.length > 0 ? Math.round(median(ages)) : 365;
}

/** The four factors and the implied value one protocol gets, priced from the snapshot. */
export interface Scored {
  implied: number;
  multiple: number;
  peers: number;
  growth_pct: number;
  growth_multiplier: number;
  runway_multiplier: number;
  breadth_multiplier: number;
  age_days: number | null;
}

/** Score one pre-token protocol: TVL x its category's peer multiple x growth x runway x breadth. */
export function impliedValue(p: SnapshotProtocol, asOf: string, pricing: Pricing, medianAge: number): Scored {
  const price = pricing.byCategory.get(p.category);
  const multiple = price?.multiple ?? pricing.global_ratio;
  const peers = price?.peers ?? 0;
  const growthPct = clamp(finite(p.change_7d, 0), GROWTH_FLOOR, GROWTH_CAP);
  const growthMult = 1 + (growthPct / 100) * GROWTH_WEIGHT;
  const age = ageDays(asOf, p.listed_at);
  const ageForModel = age ?? medianAge;
  const runwayMult = RUNWAY_FLOOR + RUNWAY_RANGE * Math.sqrt(clamp(ageForModel, 0, RUNWAY_DAYS) / RUNWAY_DAYS);
  const breadthMult = 1 + CHAIN_STEP * Math.min(Math.max(p.chains.length - 1, 0), EXTRA_CHAINS);
  const implied = Math.max(1, Math.round(p.tvl_usd * multiple * growthMult * runwayMult * breadthMult));
  return {
    implied,
    multiple,
    peers,
    growth_pct: growthPct,
    growth_multiplier: round4(growthMult),
    runway_multiplier: round4(runwayMult),
    breadth_multiplier: round4(breadthMult),
    age_days: age,
  };
}

// ---------------------------------------------------------------- farm plans

/** A protocol's farm plan, as board.json carries it and the dashboard shows it. */
export interface FarmPlan {
  steps: string[];
  capital_usd: number;
  gas_usd: number;
  weeks: number;
  weekly_minutes: number;
}

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
export function stepText(text: string, cost: string, time: string): string {
  let s = `${text} Cost: ${cost}. Time: ${time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** A second chain the protocol runs on, when it names one. */
function secondChain(p: SnapshotProtocol): string | null {
  return p.chains.length > 1 ? p.chains[1]! : null;
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 250_000_000) return 100;
  if (p.tvl_usd >= 50_000_000) return 75;
  return 50;
}

/** One transaction's gas in dollars: Ethereum mainnet is priced honestly, everything else cheap. */
function gasUnit(chain: string): number {
  return chain === 'Ethereum' ? 9 : 3;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 45;
  if (age < 180) return 75;
  if (age < 365) return 60;
  if (age < 730) return 45;
  return 30;
}

/** The working context every step of one plan is written from. */
interface PlanCtx {
  chain: string;
  chain2: string | null;
  capital: number;
  gas: number;
  hold: number;
}

/** One category's way of being farmed: the core position, the second move, the weekly routine. */
interface CategoryPlay {
  core: (p: SnapshotProtocol, x: PlanCtx) => string;
  second: (p: SnapshotProtocol, x: PlanCtx) => string;
  weekly: (p: SnapshotProtocol, x: PlanCtx) => string;
  weeklyMinutes: number;
}

const PLAYS: { match: (c: string) => boolean; play: CategoryPlay }[] = [
  {
    match: (c) => c.includes('lend') || c.includes('cdp') || c.includes('collateralized'),
    play: {
      core: (p, x) => `Supply $${x.capital} of USDC to ${p.name} on ${x.chain} and leave the deposit receipt in the wallet.`,
      second: (p, x) =>
        `Borrow about $${Math.round(x.capital * 0.4)} (40% of the deposit) against it and re-supply the borrowed funds, keeping the health factor above 1.8 so the loop cannot be liquidated by a small move.`,
      weekly: (p, x) => `Repay and re-borrow once a week so the position shows continuing use, not a single deposit.`,
      weeklyMinutes: 10,
    },
  },
  {
    match: (c) => c.includes('dex') || c.includes('swap'),
    play: {
      core: (p, x) => `Provide $${x.capital} of liquidity to ${p.name}'s busiest pool on ${x.chain}, choosing a stable pair when one is offered so the position is not an impermanent-loss bet.`,
      second: (p, x) =>
        x.chain2 !== null
          ? `Repeat with $${Math.round(x.capital / 2)} on ${x.chain2}, the protocol's second chain, so the wallet qualifies on both deployments.`
          : `Route one swap of $${Math.round(x.capital / 2)} or more through ${p.name}'s own interface on ${x.chain}, so the wallet is both a liquidity provider and a trader.`,
      weekly: (p, x) => `Make three swaps of $50 or more through ${p.name} each week, on different days.`,
      weeklyMinutes: 15,
    },
  },
  {
    match: (c) => c.includes('derivative') || c.includes('perpetual') || c.includes('options'),
    play: {
      core: (p, x) => `Deposit $${x.capital} of USDC as margin on ${p.name} and open one small position in its most liquid market.`,
      second: (p, x) => `Open a hedged second leg ($100 notional, opposite direction on a different market or a spot hedge) so the account shows real trading, not directional gambling.`,
      weekly: (p, x) => `Open and close two trades a week of about $100 notional each, aiming for steady volume over size.`,
      weeklyMinutes: 25,
    },
  },
  {
    match: (c) => c.includes('bridge'),
    play: {
      core: (p, x) => `Bridge $${x.capital} of USDC through ${p.name} to ${x.chain2 ?? x.chain} and use the bridged funds in one app on the far side.`,
      second: (p, x) => `Bridge a second, smaller amount ($50) by a different route pair a week later, so the wallet is a repeat user rather than a one-off.`,
      weekly: (p, x) => `Bridge $25 to $50 once a month and keep the destination wallet active with one local transaction.`,
      weeklyMinutes: 10,
    },
  },
  {
    match: (c) => c.includes('staking') || c.includes('restak'),
    play: {
      core: (p, x) => `Stake $${x.capital} of the chain's staking asset through ${p.name} on ${x.chain} and keep the receipt token in the wallet.`,
      second: (p, x) => `Put the receipt token to work in one partner the protocol names (a money market or a liquidity pool it serves), so both layers of activity point at the same wallet.`,
      weekly: (p, x) => `Compound the staking rewards once a week, or add a $10 top-up, so the staked balance keeps growing.`,
      weeklyMinutes: 10,
    },
  },
  {
    match: (c) => c.includes('curator') || c.includes('allocator') || c.includes('yield'),
    play: {
      core: (p, x) => `Deposit $${x.capital} into the ${p.name} vault on ${x.chain} with the longest running history, and keep the vault shares in the wallet.`,
      second: (p, x) =>
        x.chain2 !== null
          ? `Open a second $${Math.round(x.capital / 2)} position in the same curator's vault on ${x.chain2} if it runs one there.`
          : `Split the position across two of ${p.name}'s vaults rather than one, so the wallet follows the curator, not a single strategy.`,
      weekly: (p, x) => `Read the vault's weekly allocation or rewards note, and rebalance only when the curator moves the strategy.`,
      weeklyMinutes: 10,
    },
  },
  {
    match: (c) => c.includes('rwa') || c.includes('real world'),
    play: {
      core: (p, x) => `Complete ${p.name}'s own onboarding on ${x.chain} (some issuers ask for identity checks: finish them in the app, never through a link someone sends you), then mint $${x.capital} of its yield asset.`,
      second: (p, x) => `Hold the minted asset in the same wallet and, if the protocol runs a secondary pool, provide $50 of liquidity against it.`,
      weekly: (p, x) => `Check the issuer's attestation or report page once a month and keep the position untouched between checks.`,
      weeklyMinutes: 5,
    },
  },
  {
    match: (c) => c.includes('basis'),
    play: {
      core: (p, x) => `Open the basis pair through ${p.name}: buy $${x.capital} of the spot asset and short the same dollar amount of its perpetual, so the position earns funding either way.`,
      second: (p, x) => `Set a calendar check for the funding rate: if it flips negative for two days, close and reopen on the venue ${p.name} routes to next.`,
      weekly: (p, x) => `Rebalance the two legs once a week whenever their sizes drift more than 5% apart.`,
      weeklyMinutes: 15,
    },
  },
  {
    match: (c) => c === 'chain',
    play: {
      core: (p, x) => `Bridge $${x.capital} to ${p.name} and make it the wallet's home chain for the season: one swap and one contract interaction in its own apps on arrival.`,
      second: (p, x) => `Register for the chain's own testnet or ecosystem tasks if it publishes them, and keep mainnet and task activity in the same wallet.`,
      weekly: (p, x) => `Run one transaction a day for one week in each month (a swap, a mint, a vote), then idle: bursts of daily activity read as farming, steady months read as use.`,
      weeklyMinutes: 20,
    },
  },
  {
    match: (c) => c.includes('prediction'),
    play: {
      core: (p, x) => `Fund $${x.capital} on ${p.name} and take positions in three different markets, $10 to $20 a side.`,
      second: (p, x) => `Add one position in the market category you actually follow, and write down why: conviction positions survive the plan, random ones get skipped.`,
      weekly: (p, x) => `Trade two markets a week at about $10 a side and settle losers promptly instead of letting them expire.`,
      weeklyMinutes: 15,
    },
  },
  {
    match: (c) => c.includes('insurance'),
    play: {
      core: (p, x) => `Buy one cover policy from ${p.name} on ${x.chain} for about $${x.capital} of cover on a protocol you genuinely use.`,
      second: (p, x) => `If ${p.name} lets members stake into its risk pool, stake $50 there so the wallet is on both sides of the product.`,
      weekly: (p, x) => `Hold the policy to expiry; renew once if the covered position is still open.`,
      weeklyMinutes: 5,
    },
  },
];

/** The default play, for a category with no entry of its own in the table. */
const DEFAULT_PLAY: CategoryPlay = {
  core: (p, x) => `Deposit $${x.capital} of USDC into ${p.name} on ${x.chain} through its own app and keep the position open.`,
  second: (p, x) =>
    x.chain2 !== null
      ? `Open a second, smaller position of $${Math.round(x.capital / 2)} on ${x.chain2}, so the wallet is active on two of the protocol's chains.`
      : `Make one more qualifying action the product is built around (a second deposit, a vote, or a referral-free signup inside the app) a few days later.`,
  weekly: (p, x) => `Make one qualifying action a week (a deposit, a swap, a borrow or a vote), whatever the product counts.`,
  weeklyMinutes: 10,
};

/** The play a protocol's category earns it. */
function playFor(p: SnapshotProtocol): CategoryPlay {
  const c = (p.category ?? '').toLowerCase();
  for (const entry of PLAYS) if (entry.match(c)) return entry.play;
  return DEFAULT_PLAY;
}

/**
 * A protocol's farm plan: six steps with a cost and a time each, written from the protocol's own
 * record — its category's play, its chains, a capital tier from its TVL, a hold from its age — and
 * the plan's totals, so the dashboard can say what the whole plan costs before a reader starts.
 */
export function farmPlan(p: SnapshotProtocol, age: number | null): FarmPlan {
  const x: PlanCtx = { chain: chainOf(p), chain2: secondChain(p), capital: capitalFor(p), gas: gasUnit(chainOf(p)), hold: holdDaysFor(age) };
  const play = playFor(p);
  const weeks = Math.ceil(x.hold / 7);
  const weeklyGas = Math.max(1, Math.round(x.gas / 3));
  const steps = [
    stepText(
      `Use a fresh wallet that holds only the funds you plan to farm, keep its seed phrase offline, and fund it with the gas token of ${x.chain}.`,
      'under $3 to fund and move money in',
      '5 minutes',
    ),
    stepText(play.core(p, x), `$${x.capital} of capital and about $${x.gas} of gas`, '15 minutes to set up'),
    stepText(play.second(p, x), `about $${x.gas} of gas on top of the capital it moves`, '15 minutes'),
    stepText(play.weekly(p, x), `about $${weeklyGas} of gas a week`, `${play.weeklyMinutes} minutes a week`),
    stepText(
      `Hold the position for at least ${x.hold} days so the activity lands in more than one weekly snapshot, then open the protocol's own points or rewards page and claim only from the link it publishes.`,
      `the $${x.capital} stays in the position; never pay anyone to claim`,
      `${x.hold} days, then 10 minutes to check`,
    ),
    stepText(
      `Keep a farm log (wallet, dates, every transaction hash) and, at the end of the hold, either roll the position for another ${x.hold} days or unwind it in one session.`,
      'nothing but the log; unwinding costs one more round of gas',
      '5 minutes a week to keep the log',
    ),
  ];
  return { steps, capital_usd: x.capital, gas_usd: x.gas * 3 + weeklyGas * weeks, weeks, weekly_minutes: play.weeklyMinutes };
}

// ---------------------------------------------------------------- the board

/** A tokenized peer a pre-token row is priced against: the market's own figures for its category. */
export interface Comparable {
  name: string;
  mcap_usd: number;
  tvl_usd: number;
  ratio: number;
}

/** One row of board.json: the ranked board's row, with the price's workings on it. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  watchlist: boolean;
  token_status: 'pre-token';
  implied_value_usd: number;
  category_multiple: number;
  peer_count: number;
  growth_multiplier: number;
  runway_multiplier: number;
  breadth_multiplier: number;
  plan_capital_usd: number;
  plan_gas_usd: number;
  plan_weeks: number;
  plan_weekly_minutes: number;
  comps: Comparable[];
  farm_steps: string[];
}

/** A live-token protocol: it already trades, so the board shows the market's own value, not a model's. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
  ratio: number | null;
}

/** Everything the dashboard renders: the board, the live set, and the pricing table behind it. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model_version: string;
  global_multiple: number;
  median_age_days: number;
  categories: CategoryPrice[];
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  rows: BoardRow[];
  live: LiveRow[];
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** Whether a protocol is one the board may rank: pre-token, not an exchange, not a versioned pool. */
export function isRankable(p: SnapshotProtocol): boolean {
  return isPreToken(p) && p.category !== 'CEX' && !VERSIONED.test(p.name);
}

/** Categories that are a wrapped, staked or bridged product of a token that already trades. */
const PRODUCT_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);
/** The watchlist's name screens: a wrapped or staked product word, or an exchange's name up front. */
const PRODUCT_WORD = /\b(wrapped|staked|staking)\b/i;
const EXCHANGE_PREFIX = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/;

/**
 * The product screen the watchlist itself applies, minus its floor: a protocol in a product
 * category, or named like a product of another token, is not a launch still to come — WBTC is
 * Bitcoin on Ethereum and Binance staked ETH is ETH in a staking wrapper, whatever their TVL.
 * Above the floor the board holds every candidate to this screen; below it, the radar casts the
 * widest net it can, because finding the early ones is its job.
 */
export function passesProductScreen(p: SnapshotProtocol): boolean {
  if (p.category !== null && PRODUCT_CATEGORIES.has(p.category)) return false;
  if (PRODUCT_WORD.test(p.name)) return false;
  if (EXCHANGE_PREFIX.test(p.name)) return false;
  return true;
}

/** The snapshot's protocol by slug. */
function bySlug(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> {
  return new Map(protocols.map((p) => [p.slug, p]));
}

/** Up to three tokenized peers in the protocol's own category, nearest to it in TVL. */
export function comparables(p: SnapshotProtocol, protocols: SnapshotProtocol[]): Comparable[] {
  const peers = protocols.filter((q) => q.mcap_usd !== null && q.tvl_usd > 0 && (p.category === null || q.category === p.category));
  peers.sort((a, b) => {
    const da = Math.abs(Math.log(a.tvl_usd / p.tvl_usd));
    const db = Math.abs(Math.log(b.tvl_usd / p.tvl_usd));
    return da - db || bySlugAsc(a.slug, b.slug);
  });
  return peers.slice(0, 3).map((q) => ({ name: q.name, mcap_usd: q.mcap_usd!, tvl_usd: q.tvl_usd, ratio: round4(q.mcap_usd! / q.tvl_usd) }));
}

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildBoard(snapshot: Snapshot, pricing: Pricing, medianAge: number): BoardRow[] {
  const index = bySlug(snapshot.protocols);
  const watch = new Set(snapshot.watchlist);
  const chosen = new Map<string, SnapshotProtocol>();
  // The watchlist is the floor: every slug on it is ranked, whatever else the model thinks of it.
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  // The radar proper: every other rankable pre-token protocol in the snapshot. The early ones below
  // the floor are the catches a TVL table never shows. Above the floor a candidate must also pass
  // the watchlist's own product screen, so a wrapped or bridged giant (the snapshot's largest
  // pre-token records are exactly those) never poses as a launch still to come.
  for (const p of snapshot.protocols) {
    if (chosen.has(p.slug) || !isRankable(p)) continue;
    if (p.tvl_usd >= snapshot.floor_usd && !passesProductScreen(p)) continue;
    chosen.set(p.slug, p);
  }
  const scored = [...chosen.values()].map((p) => ({ p, s: impliedValue(p, snapshot.as_of, pricing, medianAge) }));
  scored.sort((a, b) => b.s.implied - a.s.implied || b.p.tvl_usd - a.p.tvl_usd || bySlugAsc(a.p.slug, b.p.slug));
  return scored.map(({ p, s }, i) => {
    const plan = farmPlan(p, s.age_days);
    return {
      rank: i + 1,
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      change_7d: p.change_7d,
      listed_at: p.listed_at,
      age_days: s.age_days,
      watchlist: watch.has(p.slug),
      token_status: 'pre-token' as const,
      implied_value_usd: s.implied,
      category_multiple: s.multiple,
      peer_count: s.peers,
      growth_multiplier: s.growth_multiplier,
      runway_multiplier: s.runway_multiplier,
      breadth_multiplier: s.breadth_multiplier,
      plan_capital_usd: plan.capital_usd,
      plan_gas_usd: plan.gas_usd,
      plan_weeks: plan.weeks,
      plan_weekly_minutes: plan.weekly_minutes,
      comps: comparables(p, snapshot.protocols),
      farm_steps: plan.steps,
    };
  });
}

/** The live-token protocols, by market cap, for the dashboard's Already trading view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || bySlugAsc(a.slug, b.slug))
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
      ratio: p.mcap_usd !== null && p.tvl_usd > 0 ? round4(p.mcap_usd / p.tvl_usd) : null,
    }));
}

/** Everything the entry writes, from the snapshot: the priced board and the dashboard's data. */
export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const pricing = priceCategories(snapshot);
  const medianAge = medianAgeDays(snapshot);
  const board = buildBoard(snapshot, pricing, medianAge);
  const live = liveRows(snapshot);
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model_version: MODEL_VERSION,
    global_multiple: pricing.global_ratio,
    median_age_days: medianAge,
    categories: pricing.table,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: board.filter((r) => !r.watchlist).length,
    live_size: live.length,
    rows: board,
    live,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: size, coverage, ranks, order, values, steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 100 || board.length > 4000) return `the board holds ${board.length} rows, outside 100..4000`;
  const slugs = new Set(board.map((r) => r.slug));
  if (slugs.size !== board.length) return 'the board names a protocol twice';
  const known = new Set(snapshot.protocols.map((p) => p.slug));
  for (const r of board) if (!known.has(r.slug)) return `${r.slug} is not one of the snapshot's protocols`;
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  for (let i = 0; i < board.length; i++) if (board[i]!.rank !== i + 1) return `rank ${i + 1} is ${board[i]!.rank}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) if (s.trim().length < 20 || s.trim().length > 600) return `${r.slug} has a farm step of ${s.trim().length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
