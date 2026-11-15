// evaluate3.mjs: the comps-5 (v4) candidate verdict, under a protocol fixed before any candidate ran.
//
// The question comps-4 leaves open: v3 slipped out of the top-12 playoff band, so the shipped
// model needs a successor that is *provably* better, not merely different. Candidates (fixed in
// V4-NOTES.md before this script ran) are each comps-4 plus one change:
//   F1 trimlog estimator on top of comps-4 (evaluate2 tested C only against comps-3).
//   F2 exclude zero-cap peers: 15 tokenized protocols record mcap_usd === 0 — dead records that
//      sit in the peer set with ratio 0 and drag category medians toward zero.
//   F3 F1+F2 combined (a candidate only if F1 or F2 individually beats the baseline on set 1).
//   F4 thin_neighbor_blend 0.5 -> 0.65.  F5 thin_neighbors 8 -> 12.
//   F6 size_beta 0.25 -> 0.30.           F7 shrink_k 6 -> 4.
//
// Protocol, fixed in advance: leave-one-out blind prices of the snapshot's 128 tokenized
// protocols with a positive cap; per-split score = median |log10 error| on the held-out half of
// 24 seeded 50/50 splits, plus Spearman rank correlation. A candidate ships only if it beats
// the pinned comps-4 baseline's mean error on ALL THREE sets — selection (seeds 1000..1023),
// confirmation (seeds 5000..5023), and a FRESH set nobody has ever selected against (seeds
// 9000..9023) — wins >=14/24 then >=13/24 then >=13/24 splits head-to-head, and gives up no
// more than 0.01 of mean rank correlation on any set. Anything less is noise wearing a lab coat.
//
//   node tools/evaluate3.mjs [snapshot.json]

import { readFileSync } from 'node:fs';
import { PARAMS, looPredictions, parseSnapshot, summarizeLoo } from '../lib/model.ts';

const input = process.argv[2] ?? new URL('../../../token-radar-01-kit/token-radar-01-kit/input/snapshot.json', import.meta.url).pathname;
const snapshot = parseSnapshot(readFileSync(input, 'utf8'));

// The comps-4 baseline is pinned explicitly, not spread from PARAMS: if a winner ships, PARAMS
// becomes that winner, and a baseline that moves with the shipping setting would grade the new
// model against itself. COMPS4 below is the comps-4 setting exactly as it shipped (a8f44a04).
const COMPS4 = {
  ...PARAMS,
  size_beta: 0.25,
  size_ref: 'category',
  thin_neighbors: 8,
  thin_neighbor_blend: 0.5,
  estimator: 'median',
  exclude_zero_cap_peers: false,
  shrink_k: 6,
  min_peers: 3,
  smooth: false,
};

const CANDIDATES = {
  'C4 comps-4 baseline': { ...COMPS4 },
  'F1 trimlog': { ...COMPS4, estimator: 'trimlog' },
  'F2 no-zero-peers': { ...COMPS4, exclude_zero_cap_peers: true },
  'F3 trimlog+no-zero': { ...COMPS4, estimator: 'trimlog', exclude_zero_cap_peers: true },
  'F4 blend 0.65': { ...COMPS4, thin_neighbor_blend: 0.65 },
  'F5 neighbours 12': { ...COMPS4, thin_neighbors: 12 },
  'F6 beta 0.30': { ...COMPS4, size_beta: 0.3 },
  'F7 shrink 4': { ...COMPS4, shrink_k: 4 },
};

/** A small deterministic PRNG (mulberry32) so the splits are reproducible. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const names = Object.keys(CANDIDATES);
const base = names[0];
const preds = {};
for (const name of names) preds[name] = looPredictions(snapshot, CANDIDATES[name]);
const slugs = preds[base].map((p) => p.slug);

function runSet(seedBase, label) {
  const SPLITS = 24;
  const testErr = Object.fromEntries(names.map((n) => [n, []]));
  const testRho = Object.fromEntries(names.map((n) => [n, []]));
  const wins = Object.fromEntries(names.map((n) => [n, 0]));
  for (let s = 0; s < SPLITS; s++) {
    const rand = rng(seedBase + s);
    const testSet = new Set(slugs.filter(() => rand() < 0.5));
    const errs = {};
    for (const name of names) {
      const sum = summarizeLoo(preds[name].filter((p) => testSet.has(p.slug)));
      errs[name] = sum.median_abs_log10_error;
      testErr[name].push(sum.median_abs_log10_error);
      testRho[name].push(sum.spearman);
    }
    for (const name of names) if (name !== base && errs[name] < errs[base]) wins[name]++;
  }
  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  console.log(`\n== ${label} (seeds ${seedBase}..${seedBase + SPLITS - 1}) ==`);
  console.log('candidate                 meanErr  medErr  meanRho  splits beating C4');
  for (const name of names) {
    console.log(
      `${name.padEnd(24)} ${mean(testErr[name]).toFixed(4)}  ${med(testErr[name]).toFixed(4)}  ${mean(testRho[name]).toFixed(4)}   ${name === base ? '—' : `${wins[name]}/${SPLITS}`}`,
    );
  }
  return { meanErr: Object.fromEntries(names.map((n) => [n, mean(testErr[n])])), meanRho: Object.fromEntries(names.map((n) => [n, mean(testRho[n])])), wins };
}

const sel = runSet(1000, 'selection set');
const conf = runSet(5000, 'confirmation set');
const fresh = runSet(9000, 'fresh set (never selected against)');

console.log('\nfull-sample (all 128, leave-one-out):');
for (const name of names) console.log(`${name}:`, JSON.stringify(summarizeLoo(preds[name])));

console.log('\nverdicts (ship = beats C4 meanErr on all 3 sets, wins >=14/24, >=13/24, >=13/24, rho within 0.01 on all):');
for (const name of names.slice(1)) {
  let ok =
    sel.meanErr[name] < sel.meanErr[base] && conf.meanErr[name] < conf.meanErr[base] && fresh.meanErr[name] < fresh.meanErr[base] &&
    sel.wins[name] >= 14 && conf.wins[name] >= 13 && fresh.wins[name] >= 13 &&
    sel.meanRho[name] >= sel.meanRho[base] - 0.01 && conf.meanRho[name] >= conf.meanRho[base] - 0.01 && fresh.meanRho[name] >= fresh.meanRho[base] - 0.01;
  let note = '';
  if (name.startsWith('F3')) {
    const f1orF2 = sel.meanErr['F1 trimlog'] < sel.meanErr[base] || sel.meanErr['F2 no-zero-peers'] < sel.meanErr[base];
    if (!f1orF2) {
      ok = false;
      note = ' [not a candidate: neither F1 nor F2 beat C4 on set 1]';
    }
  }
  console.log(
    `${name}: ${ok ? 'SHIP' : 'hold'} (err sel ${sel.meanErr[name].toFixed(4)} / conf ${conf.meanErr[name].toFixed(4)} / fresh ${fresh.meanErr[name].toFixed(4)} vs C4 ${sel.meanErr[base].toFixed(4)} / ${conf.meanErr[base].toFixed(4)} / ${fresh.meanErr[base].toFixed(4)}, wins ${sel.wins[name]}/${conf.wins[name]}/${fresh.wins[name]}, rho ${sel.meanRho[name].toFixed(3)}/${conf.meanRho[name].toFixed(3)}/${fresh.meanRho[name].toFixed(3)} vs ${sel.meanRho[base].toFixed(3)}/${conf.meanRho[base].toFixed(3)}/${fresh.meanRho[base].toFixed(3)})${note}`,
  );
}
