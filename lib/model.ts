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
//                count (shrink K = 6) and clamped to [0.03, 1.20]. A category with fewer than 3
//                peers cannot carry its own median; comps-3 then priced it at the bare global
//                median, so the board's largest rows rested on no local evidence at all.
//                comps-4 prices a thin category from the 8 tokenized protocols nearest the
//                protocol in TVL, whatever they do — the market's price for a protocol's size
//                is real evidence about a protocol of that size — blended half-and-half with
//                the global median in log space.
//   growth     = 1 + clamp(change_7d, -60, 120) / 100 x 0.5
//   runway     = 0.78 + 0.44 x sqrt(min(age_days, 1460) / 1460): the longer a protocol has run
//                with no token, the more usage a launch would capitalise (age unknown: the
//                snapshot's median age)
//   breadth    = 1 + 0.025 x min(chains - 1, 8): distribution across chains is worth a premium
//   size       = (tvl_usd / reference TVL) ^ -0.25: the comps' own record says the market pays
//                a smaller multiple the larger the protocol — the median ratio falls from 0.48
//                for the smallest third of tokenized protocols to 0.05 for the largest — so a
//                giant is not priced at a small protocol's multiple. comps-3 measured size
//                against the whole peer set's median TVL; comps-4 measures it against the
//                median TVL of the protocol's own category peers (the global median when the
//                category is thin): a protocol is large or small next to the protocols it is
//                actually priced against, and the yardstick should say so.
//   implied    = max(1, round(tvl_usd x multiple x growth x runway x breadth x size))
//
// Both comps-4 changes were fixed as candidates before they were scored and were scored the
// comps-3 way, harder (tools/evaluate2.mjs): each had to beat comps-3's mean held-out error on
// the 24 seeded splits comps-3 was selected on AND on a second set of 24 splits it was never
// selected against, without giving up rank correlation. Together they did (held-out mean
// median |log10 error| 0.568/0.564 against comps-3's 0.582/0.588, split wins 16 and 19 of 24).
// The dashboard also keeps the whole field honest: every one of the snapshot's pre-token
// protocols is accounted for — ranked, or set aside with the reason printed — and every farm
// plan carries a verdict netted to the dollar (see farmVerdict below).
//
// The same function scores every row; no protocol's name is ever special-cased. Each board row
// carries the multiple it was priced at and the peer count behind it, so a reader can audit the
// price back to the snapshot. And on every run the model grades itself: backtestModel below
// hides each tokenized protocol's market cap in turn, prices it blind with this same function,
// and reports how far off it was — the dashboard prints the result next to the model.

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
export const MODEL_VERSION = 'comps-4';

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

/**
 * The model's free parameters as one object, so the backtest below can price the snapshot under
 * any candidate setting through the very code the board runs. PARAMS is the setting the board
 * ships; the constants above are where comps-2 started, kept as the record of the hand-set model
 * the fit was measured against.
 */
export interface ModelParams {
  shrink_k: number;
  min_peers: number;
  /** true: every category's median is shrunk toward the global by its peer count, however thin.
   *  false (comps-2): a category under min_peers prices at the global median outright. */
  smooth: boolean;
  multiple_floor: number;
  multiple_cap: number;
  growth_floor: number;
  growth_cap: number;
  growth_weight: number;
  runway_floor: number;
  runway_range: number;
  runway_days: number;
  chain_step: number;
  extra_chains: number;
  /** The size tilt: the multiple is multiplied by (tvl / reference tvl)^-size_beta. The comps'
   *  own record says the market pays a smaller multiple the larger the protocol (the median
   *  ratio falls by an order of magnitude from the smallest tercile to the largest); 0 = off. */
  size_beta: number;
  /** Which peer set's median TVL the size tilt is measured against: 'global' (comps-3: every
   *  tokenized protocol's median TVL) or 'category' (the protocol's own category peers' median
   *  TVL, falling back to the global reference when the category is thin). The size effect is
   *  a within-market phenomenon — a protocol is large or small next to the protocols it is
   *  actually priced against — so the category reference is the honest yardstick. */
  size_ref: 'global' | 'category';
  /** When a category is too thin to carry its own median (fewer than min_peers tokenized
   *  peers), price it instead from the `thin_neighbors` tokenized protocols nearest to it in
   *  TVL, whatever their category, blended with the global median by thin_neighbor_blend
   *  (in log space). 0 = off (comps-3: a thin category prices at the bare global median, so
   *  the board's largest rows — the thin-category giants — are priced off no local evidence
   *  at all). The nearest-size protocols are the evidence a thin category does have. */
  thin_neighbors: number;
  thin_neighbor_blend: number;
  /** How a category's multiple is read off its peers' ratios: 'median' (comps-3) or 'trimlog'
   *  (the trimmed mean of the log ratios, exponentiated: uses the whole peer distribution,
   *  not just its middle one or two values). */
  estimator: 'median' | 'trimlog';
  /** true: a tokenized protocol whose recorded market cap is zero is not a comparable — a dead
   *  record prices nothing — and is left out of the peer set and the blind test alike. */
  exclude_zero_cap_peers: boolean;
}

/** The parameters the board prices with. */
export const PARAMS: ModelParams = {
  shrink_k: SHRINK_K,
  min_peers: MIN_PEERS,
  smooth: false,
  multiple_floor: MULTIPLE_FLOOR,
  multiple_cap: MULTIPLE_CAP,
  growth_floor: GROWTH_FLOOR,
  growth_cap: GROWTH_CAP,
  growth_weight: GROWTH_WEIGHT,
  runway_floor: RUNWAY_FLOOR,
  runway_range: RUNWAY_RANGE,
  runway_days: RUNWAY_DAYS,
  chain_step: CHAIN_STEP,
  extra_chains: EXTRA_CHAINS,
  // Fitted, not hand-set: on the sealed snapshot's 128 tokenized protocols with a positive
  // recorded cap, a size slope of 0.25 beat the comps-2 setting on the held-out half of all 24
  // seeded splits (mean median |log10 error| 0.668 -> 0.582) with the rank correlation intact
  // (0.413 -> 0.406); steeper slopes kept buying error with rank. See tools/evaluate.mjs.
  size_beta: 0.25,
  // comps-4's two evidence repairs, each fixed as a candidate before it was scored and each
  // required to beat comps-3 on the comps-3 selection splits AND on a fresh confirmation set
  // of 24 splits it was never selected against (tools/evaluate2.mjs): the size tilt is measured
  // against the category peers' median TVL, and a thin category is priced from its 8 nearest
  // tokenized protocols by TVL, blended with the global median. Together: held-out mean median
  // |log10 error| 0.568/0.564 against comps-3's 0.582/0.588; split wins 16/24 and 19/24.
  size_ref: 'category',
  thin_neighbors: 8,
  thin_neighbor_blend: 0.5,
  estimator: 'median',
  exclude_zero_cap_peers: false,
};
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
  /** The median TVL of the category's own tokenized peers: the size tilt's category yardstick. */
  ref_tvl: number | null;
  /** The peer ratios' lower and upper quartiles: the spread of what the market actually pays in
   *  this category, so a price can be shown with the band its own evidence puts around it. */
  ratio_q1: number | null;
  ratio_q3: number | null;
}

/** A quartile of a non-empty list, by linear interpolation between the closest ranks. */
function quartile(values: number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (sorted.length - 1) * q;
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return lo === hi ? sorted[lo]! : sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (at - lo);
}

/** One tokenized protocol as pricing evidence: its TVL and its market-cap-to-TVL ratio. */
export interface PeerPoint {
  tvl: number;
  ratio: number;
}

/** The pricing table the whole board is priced from: per-category multiples and the global median. */
export interface Pricing {
  global_ratio: number;
  /** The median TVL of the tokenized peer set: the size tilt's reference point. */
  ref_tvl: number;
  /** Every tokenized protocol's (TVL, ratio) point: the pool thin categories draw neighbours from. */
  peers_all: PeerPoint[];
  byCategory: Map<string | null, CategoryPrice>;
  table: CategoryPrice[];
}

/**
 * A category's central ratio under the model's estimator: the median (comps-3), or the trimmed
 * mean of the log ratios — the middle half of the peers, averaged in log space and exponentiated
 * back — which lets every peer in the middle of the distribution speak, not only the middle one.
 */
function centralRatio(ratios: number[], estimator: ModelParams['estimator']): number {
  if (estimator === 'trimlog' && ratios.length >= 4) {
    const logs = ratios.map((r) => Math.log(r)).sort((a, b) => a - b);
    const trim = Math.floor(logs.length / 4);
    const kept = logs.slice(trim, logs.length - trim);
    return Math.exp(kept.reduce((a, b) => a + b, 0) / kept.length);
  }
  return median(ratios);
}

/** The median ratio of the `k` peer points nearest to `tvl` in log space, or null when there are none. */
export function neighborMedianRatio(peers: PeerPoint[], tvl: number, k: number): number | null {
  if (peers.length === 0 || tvl <= 0) return null;
  const lt = Math.log(tvl);
  const nearest = [...peers].sort((a, b) => Math.abs(Math.log(a.tvl) - lt) - Math.abs(Math.log(b.tvl) - lt)).slice(0, k);
  return median(nearest.map((p) => p.ratio));
}

/**
 * Price every category from the snapshot's tokenized protocols: the median market-cap-to-TVL ratio
 * of its peers, shrunk toward the global median by the peer count, clamped to the model's band.
 */
export function priceCategories(snapshot: Snapshot, params: ModelParams = PARAMS): Pricing {
  const ratiosByCategory = new Map<string | null, number[]>();
  const tvlsByCategory = new Map<string | null, number[]>();
  const all: number[] = [];
  const peerTvls: number[] = [];
  const peersAll: PeerPoint[] = [];
  for (const p of snapshot.protocols) {
    if (p.mcap_usd === null || p.tvl_usd <= 0) continue;
    if (params.exclude_zero_cap_peers && p.mcap_usd <= 0) continue;
    const ratio = p.mcap_usd / p.tvl_usd;
    all.push(ratio);
    peerTvls.push(p.tvl_usd);
    peersAll.push({ tvl: p.tvl_usd, ratio });
    const list = ratiosByCategory.get(p.category) ?? [];
    list.push(ratio);
    ratiosByCategory.set(p.category, list);
    const tvlList = tvlsByCategory.get(p.category) ?? [];
    tvlList.push(p.tvl_usd);
    tvlsByCategory.set(p.category, tvlList);
  }
  // The pricing table is rounded before it prices anything (medians and the global to four
  // decimals, reference TVLs to whole dollars): every figure the dashboard prints is then the
  // exact figure the price was made from, so a reader — or the page itself — can recompute any
  // row's price from the printed table and land on the board's number to the dollar.
  const global = round4(all.length > 0 ? median(all) : 0.17);
  const refTvl = peerTvls.length > 0 ? Math.round(median(peerTvls)) : 1;
  const byCategory = new Map<string | null, CategoryPrice>();
  for (const [category, ratios] of ratiosByCategory) {
    const med = median(ratios);
    const central = params.estimator === 'median' ? round4(med) : centralRatio(ratios, params.estimator);
    const shrunk = clamp(
      (ratios.length * central + params.shrink_k * global) / (ratios.length + params.shrink_k),
      params.multiple_floor,
      params.multiple_cap,
    );
    const multiple = params.smooth || ratios.length >= params.min_peers ? shrunk : global;
    byCategory.set(category, {
      category,
      peers: ratios.length,
      median_ratio: round4(med),
      multiple: round4(multiple),
      ref_tvl: Math.round(median(tvlsByCategory.get(category)!)),
      ratio_q1: ratios.length >= 4 ? round4(quartile(ratios, 0.25)) : null,
      ratio_q3: ratios.length >= 4 ? round4(quartile(ratios, 0.75)) : null,
    });
  }
  const table = [...byCategory.values()].sort((a, b) => b.peers - a.peers || bySlugAsc(a.category ?? '', b.category ?? ''));
  return { global_ratio: global, ref_tvl: refTvl, peers_all: peersAll, byCategory, table };
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

/** The factors and the implied value one protocol gets, priced from the snapshot. */
export interface Scored {
  implied: number;
  multiple: number;
  peers: number;
  growth_pct: number;
  growth_multiplier: number;
  runway_multiplier: number;
  breadth_multiplier: number;
  size_multiplier: number;
  /** The reference TVL the size factor was measured against for this protocol. */
  size_ref_tvl: number;
  /** The nearest-size neighbours' median ratio, when a thin category was priced from them. */
  neighbor_ratio: number | null;
  age_days: number | null;
}

/** Score one pre-token protocol: TVL x its category's peer multiple x growth x runway x breadth. */
export function impliedValue(p: SnapshotProtocol, asOf: string, pricing: Pricing, medianAge: number, params: ModelParams = PARAMS): Scored {
  const price = pricing.byCategory.get(p.category);
  let multiple = price?.multiple ?? pricing.global_ratio;
  const peers = price?.peers ?? 0;
  // A category too thin to carry its own median has one more source of evidence before the bare
  // global median: the tokenized protocols nearest to this one in TVL, whatever they do. The
  // market's price for a protocol's size is real evidence about a protocol of that size; blend
  // it with the global median in log space so neither shouts the other down.
  let neighborRatio: number | null = null;
  if (params.thin_neighbors > 0 && peers < params.min_peers) {
    const neighbour = neighborMedianRatio(pricing.peers_all, p.tvl_usd, params.thin_neighbors);
    if (neighbour !== null && neighbour > 0) {
      // Rounded before the blend, like the rest of the pricing table, so the printed
      // neighbours' median is the exact figure the blend was made from.
      neighborRatio = round4(neighbour);
      const w = clamp(params.thin_neighbor_blend, 0, 1);
      multiple = round4(Math.exp(w * Math.log(neighborRatio) + (1 - w) * Math.log(pricing.global_ratio)));
    }
  }
  const growthPct = clamp(finite(p.change_7d, 0), params.growth_floor, params.growth_cap);
  const growthMult = 1 + (growthPct / 100) * params.growth_weight;
  const age = ageDays(asOf, p.listed_at);
  const ageForModel = age ?? medianAge;
  const runwayMult = params.runway_floor + params.runway_range * Math.sqrt(clamp(ageForModel, 0, params.runway_days) / params.runway_days);
  const breadthMult = 1 + params.chain_step * Math.min(Math.max(p.chains.length - 1, 0), params.extra_chains);
  // The size tilt's yardstick: the median TVL of the peers this price actually came from (the
  // protocol's own category) when the model is set to measure size within the market it prices,
  // else the whole peer set's median, as comps-3 did.
  const refTvl =
    params.size_ref === 'category' && price !== undefined && price.peers >= params.min_peers && price.ref_tvl !== null && price.ref_tvl > 0
      ? price.ref_tvl
      : pricing.ref_tvl;
  const sizeMult =
    params.size_beta > 0 && refTvl > 0 && p.tvl_usd > 0
      ? Math.pow(p.tvl_usd / refTvl, -params.size_beta)
      : 1;
  const implied = Math.max(1, Math.round(p.tvl_usd * multiple * growthMult * runwayMult * breadthMult * sizeMult));
  return {
    implied,
    multiple,
    peers,
    growth_pct: growthPct,
    growth_multiplier: round4(growthMult),
    runway_multiplier: round4(runwayMult),
    breadth_multiplier: round4(breadthMult),
    size_multiplier: round4(sizeMult),
    size_ref_tvl: Math.round(refTvl),
    neighbor_ratio: neighborRatio,
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

/** The reference allocation the verdict is struck at: a small farmer's plausible share of a launch. */
export const VERDICT_REFERENCE_SHARE = 0.0001;

/** A farm plan's verdict, netted to the dollar. */
export interface FarmVerdict {
  /** 'Farm' | 'Farm small' | 'Watch': what the plan's own arithmetic says. */
  verdict: 'Farm' | 'Farm small' | 'Watch';
  /** What the plan actually spends: its gas. The capital stays in the position and returns on unwind. */
  net_cost_usd: number;
  /** The share of the implied launch value at which the allocation's worth covers the net cost. */
  breakeven_share_pct: number;
  /** How many times over a reference allocation (VERDICT_REFERENCE_SHARE of the launch) covers the net cost. */
  cover: number;
}

/**
 * Net a plan to the dollar and say whether it pays. The plan's capital is not a cost — it sits
 * in the position and comes back on unwind — so the plan spends its gas and the reader's
 * minutes. Against that, the honest question is not "will there be an airdrop" (nobody knows)
 * but "how much of the launch would this wallet's allocation have to be worth to cover what
 * the plan spends": the break-even share. The verdict tiers that share at a reference
 * allocation of 0.01% of the launch: covered ten times over is a Farm, twice over a Farm
 * small, and under twice a Watch — the tail rows whose implied value is too small for a small
 * wallet's plausible share to pay the gas are told so, in numbers, on their own row.
 */
export function farmVerdict(impliedValueUsd: number, plan: FarmPlan): FarmVerdict {
  const net = plan.gas_usd;
  const referenceValue = impliedValueUsd * VERDICT_REFERENCE_SHARE;
  const cover = net > 0 ? referenceValue / net : 0;
  return {
    verdict: cover >= 10 ? 'Farm' : cover >= 2 ? 'Farm small' : 'Watch',
    net_cost_usd: net,
    breakeven_share_pct: impliedValueUsd > 0 ? round4((net / impliedValueUsd) * 100) : 0,
    cover: Math.round(cover * 10) / 10,
  };
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
  size_multiplier: number;
  plan_capital_usd: number;
  plan_gas_usd: number;
  plan_weeks: number;
  plan_weekly_minutes: number;
  /** The reference TVL this row's size factor was measured against (its category peers' median, or the whole set's). */
  size_ref_tvl: number;
  /** The nearest-size neighbours' median ratio, when this row's thin category was priced from them. */
  neighbor_ratio: number | null;
  /** The plan's verdict, netted to the dollar: what it spends, and the launch share that covers it. */
  verdict: 'Farm' | 'Farm small' | 'Watch';
  verdict_cover: number;
  breakeven_share_pct: number;
  comps: Comparable[];
  farm_steps: string[];
}

/** One pre-token protocol the board set aside, with the reason printed next to it. */
export interface SetAside {
  slug: string;
  name: string;
  category: string | null;
  tvl_usd: number;
  reason: string;
}

/** The whole pre-token field, accounted for: how many were ranked, and every set-aside with its reason. */
export interface AuditTrail {
  pre_token: number;
  ranked: number;
  set_aside: SetAside[];
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

/** How the model scores when it is made to price protocols whose token already trades, blind. */
export interface ValidationStats {
  /** How many tokenized protocols were priced leave-one-out. */
  protocols: number;
  /** The median absolute log10 error: the typical price is off by a factor of 10^this. */
  median_abs_log10_error: number;
  /** The share of blind prices that land within a factor of two of the actual market cap. */
  within_2x_pct: number;
  /** Spearman rank correlation between the blind prices and the actual market caps. */
  spearman: number;
}

/** Everything the dashboard renders: the board, the live set, and the pricing table behind it. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model_version: string;
  global_multiple: number;
  /** The tokenized peers' median TVL: the size factor's reference point. */
  ref_tvl: number;
  median_age_days: number;
  categories: CategoryPrice[];
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  validation: ValidationStats | null;
  /** The whole pre-token field accounted for: ranked rows plus every set-aside with its reason. */
  audit: AuditTrail;
  rows: BoardRow[];
  live: LiveRow[];
}

/** Average ranks (ties share) of a list of values, for the Spearman correlation. */
function ranksOf(values: number[]): number[] {
  const order = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const ranks = new Array<number>(values.length);
  for (let lo = 0; lo < order.length; ) {
    let hi = lo;
    while (hi + 1 < order.length && order[hi + 1]!.v === order[lo]!.v) hi++;
    const rank = (lo + hi) / 2 + 1;
    for (let k = lo; k <= hi; k++) ranks[order[k]!.i] = rank;
    lo = hi + 1;
  }
  return ranks;
}

/** The Spearman rank correlation of two equal-length lists. */
function spearman(xs: number[], ys: number[]): number {
  const rx = ranksOf(xs);
  const ry = ranksOf(ys);
  const n = xs.length;
  const mx = rx.reduce((a, b) => a + b, 0) / n;
  const my = ry.reduce((a, b) => a + b, 0) / n;
  let cov = 0;
  let vx = 0;
  let vy = 0;
  for (let i = 0; i < n; i++) {
    cov += (rx[i]! - mx) * (ry[i]! - my);
    vx += (rx[i]! - mx) ** 2;
    vy += (ry[i]! - my) ** 2;
  }
  return vx > 0 && vy > 0 ? cov / Math.sqrt(vx * vy) : 0;
}

/**
 * The out-of-sample test the model sets itself on every run: take each protocol whose token
 * already trades, hide its market cap, price it with the same function that prices the board —
 * its category's multiple rebuilt without it, so it never prices itself — and compare the blind
 * price with the market cap it actually carries. A pricing model that cannot do this on the
 * protocols whose answer is known has no business pricing the ones whose answer is not.
 */
/** One blind price from the leave-one-out test: the protocol, what the model said, what the market says. */
export interface LooPrediction {
  slug: string;
  predicted: number;
  actual: number;
}

/** Every tokenized protocol priced blind, leave-one-out, under `params`. */
export function looPredictions(snapshot: Snapshot, params: ModelParams = PARAMS): LooPrediction[] {
  const targets = snapshot.protocols.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0);
  const medianAge = medianAgeDays(snapshot);
  return targets.map((t) => {
    const masked: Snapshot = {
      ...snapshot,
      protocols: snapshot.protocols.map((p) => (p.slug === t.slug ? { ...p, mcap_usd: null } : p)),
    };
    const pricing = priceCategories(masked, params);
    const s = impliedValue(t, snapshot.as_of, pricing, medianAge, params);
    return { slug: t.slug, predicted: s.implied, actual: t.mcap_usd! };
  });
}

/** The summary statistics of a set of blind prices: typical error, within-2x share, rank correlation. */
export function summarizeLoo(preds: LooPrediction[]): ValidationStats | null {
  if (preds.length < 20) return null;
  const absErr = preds.map((p) => Math.abs(Math.log10(p.predicted / p.actual)));
  const within = absErr.filter((e) => e <= Math.log10(2)).length;
  return {
    protocols: preds.length,
    median_abs_log10_error: round4(median(absErr)),
    within_2x_pct: Math.round((within / preds.length) * 1000) / 10,
    spearman: round4(spearman(preds.map((p) => p.predicted), preds.map((p) => p.actual))),
  };
}

export function backtestModel(snapshot: Snapshot, params: ModelParams = PARAMS): ValidationStats | null {
  return summarizeLoo(looPredictions(snapshot, params));
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
export function buildBoard(snapshot: Snapshot, pricing: Pricing, medianAge: number, params: ModelParams = PARAMS): BoardRow[] {
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
  const scored = [...chosen.values()].map((p) => ({ p, s: impliedValue(p, snapshot.as_of, pricing, medianAge, params) }));
  scored.sort((a, b) => b.s.implied - a.s.implied || b.p.tvl_usd - a.p.tvl_usd || bySlugAsc(a.p.slug, b.p.slug));
  return scored.map(({ p, s }, i) => {
    const plan = farmPlan(p, s.age_days);
    const verdict = farmVerdict(s.implied, plan);
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
      size_multiplier: s.size_multiplier,
      plan_capital_usd: plan.capital_usd,
      plan_gas_usd: plan.gas_usd,
      plan_weeks: plan.weeks,
      plan_weekly_minutes: plan.weekly_minutes,
      size_ref_tvl: s.size_ref_tvl,
      neighbor_ratio: s.neighbor_ratio,
      verdict: verdict.verdict,
      verdict_cover: verdict.cover,
      breakeven_share_pct: verdict.breakeven_share_pct,
      comps: comparables(p, snapshot.protocols),
      farm_steps: plan.steps,
    };
  });
}

/**
 * Every pre-token protocol in the snapshot, accounted for: the ones the board ranks, and the
 * ones it sets aside, each with the reason the board's own screens produced — the same checks,
 * in the same order, that buildBoard applies (an exchange's own product and a versioned pool
 * are out at any size; above the floor the watchlist's product screen applies too). A radar
 * that silently drops a third of the field is a radar whose coverage claim cannot be checked;
 * this register is the claim, checkable row by row.
 */
export function auditTrail(snapshot: Snapshot, board: BoardRow[]): AuditTrail {
  const ranked = new Set(board.map((r) => r.slug));
  const setAside: SetAside[] = [];
  let preToken = 0;
  for (const p of snapshot.protocols) {
    if (!isPreToken(p)) continue;
    preToken++;
    if (ranked.has(p.slug)) continue;
    let reason: string;
    if (p.category === 'CEX') reason = 'An exchange’s own product, not an independent launch';
    else if (VERSIONED.test(p.name)) reason = 'A versioned pool of another protocol, not a launch of its own';
    else if (p.category !== null && PRODUCT_CATEGORIES.has(p.category)) reason = `A wrapped, staked or bridged product of a token that already trades (${p.category})`;
    else if (PRODUCT_WORD.test(p.name)) reason = 'Named as a wrapped or staked product of another token';
    else reason = 'Named with an exchange’s name: that exchange’s product, not an independent launch';
    setAside.push({ slug: p.slug, name: p.name, category: p.category, tvl_usd: p.tvl_usd, reason });
  }
  setAside.sort((a, b) => b.tvl_usd - a.tvl_usd || bySlugAsc(a.slug, b.slug));
  return { pre_token: preToken, ranked: board.length, set_aside: setAside };
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
export function buildRadar(snapshot: Snapshot, params: ModelParams = PARAMS): { board: BoardRow[]; radar: RadarData } {
  const pricing = priceCategories(snapshot, params);
  const medianAge = medianAgeDays(snapshot);
  const board = buildBoard(snapshot, pricing, medianAge, params);
  const live = liveRows(snapshot);
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model_version: MODEL_VERSION,
    global_multiple: pricing.global_ratio,
    ref_tvl: pricing.ref_tvl,
    median_age_days: medianAge,
    categories: pricing.table,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: board.filter((r) => !r.watchlist).length,
    live_size: live.length,
    validation: backtestModel(snapshot, params),
    audit: auditTrail(snapshot, board),
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

/**
 * Why a board's rows do not recompute from their own printed factors, or null: every row carries
 * the multiple and the four multipliers its price was built from, so a reader — or this audit —
 * can multiply them back out and land on the row's implied value, within the rounding the row
 * itself declares. A board whose numbers do not tie out is a board whose page and code disagree.
 */
export function boardAuditIssue(board: BoardRow[]): string | null {
  for (const r of board) {
    const recomputed = r.tvl_usd * r.category_multiple * r.growth_multiplier * r.runway_multiplier * r.breadth_multiplier * r.size_multiplier;
    const tolerance = Math.max(2, recomputed * 0.01);
    if (Math.abs(recomputed - r.implied_value_usd) > tolerance) {
      return `${r.slug}: implied ${r.implied_value_usd} does not recompute from its printed factors (${Math.round(recomputed)})`;
    }
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
