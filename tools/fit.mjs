// fit.mjs: out-of-sample fitting of Launch Radar's model parameters.
//
// The snapshot's tokenized protocols are the only ground truth a pricing model for pre-token
// protocols can be tested against: hide each one's market cap, price it blind through the real
// model code (lib/model.ts looPredictions), and measure the error against the cap it carries.
// Candidates are chosen on one half of those protocols (split by a hash of the slug, so the split
// is fixed and name-blind) and scored on the other half, in both directions; a setting is only
// worth shipping if it beats the hand-set comps-2 parameters on the halves it was NOT chosen on.
//
//   node tools/fit.mjs [snapshot.json]

import { readFileSync } from 'node:fs';
import { PARAMS, looPredictions, parseSnapshot, summarizeLoo } from '../lib/model.ts';

const input = process.argv[2] ?? new URL('../../../token-radar-01-kit/token-radar-01-kit/input/snapshot.json', import.meta.url).pathname;
const snapshot = parseSnapshot(readFileSync(input, 'utf8'));

function splitOf(slug) {
  let h = 2166136261;
  for (let i = 0; i < slug.length; i++) {
    h ^= slug.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 2;
}

const cache = new Map();
function loo(params) {
  const key = JSON.stringify(params);
  if (!cache.has(key)) cache.set(key, looPredictions(snapshot, params));
  return cache.get(key);
}
function scoreOn(params, split) {
  const preds = loo(params).filter((p) => splitOf(p.slug) === split);
  const s = summarizeLoo(preds);
  return s === null ? { err: Infinity, rho: 0 } : { err: s.median_abs_log10_error, rho: s.spearman };
}
/** A candidate's held-out score: chosen on `train`, measured on the other half; both directions averaged. */
function heldOut(params, trainSplit) {
  return scoreOn(params, 1 - trainSplit);
}

function fmt(params) {
  return JSON.stringify(params);
}

const baseline = { ...PARAMS };
console.log('baseline (comps-2, hand-set):', fmt(baseline));
console.log('  full-sample:', JSON.stringify(summarizeLoo(loo(baseline))));
console.log('  held-out A:', JSON.stringify(heldOut(baseline, 0)), ' held-out B:', JSON.stringify(heldOut(baseline, 1)));

// Coordinate descent: walk each parameter group, keeping the value that most improves the
// TRAIN-half error in both directions (train on A score on A is in-sample for selection; the
// honest comparison is the held-out table printed at the end for baseline vs winner).
const groups = [
  ['shrinkage', [
    { smooth: false, shrink_k: 6 }, { smooth: true, shrink_k: 2 }, { smooth: true, shrink_k: 4 },
    { smooth: true, shrink_k: 6 }, { smooth: true, shrink_k: 10 }, { smooth: true, shrink_k: 16 },
    { smooth: true, shrink_k: 24 }, { smooth: false, shrink_k: 3 }, { smooth: false, shrink_k: 10 },
  ]],
  ['growth_weight', [0.15, 0.25, 0.4, 0.5, 0.65, 0.8, 1.0].map((v) => ({ growth_weight: v }))],
  ['growth_clamps', [
    { growth_floor: -60, growth_cap: 120 }, { growth_floor: -40, growth_cap: 80 },
    { growth_floor: -80, growth_cap: 160 }, { growth_floor: -30, growth_cap: 60 },
  ]],
  ['runway', [
    { runway_floor: 0.78, runway_range: 0.44 }, { runway_floor: 0.85, runway_range: 0.3 },
    { runway_floor: 0.7, runway_range: 0.55 }, { runway_floor: 0.9, runway_range: 0.2 },
    { runway_floor: 0.95, runway_range: 0.12 }, { runway_floor: 1.0, runway_range: 0.1 },
  ]],
  ['runway_days', [730, 1460, 2920].map((v) => ({ runway_days: v }))],
  ['chain_step', [0, 0.0125, 0.025, 0.04].map((v) => ({ chain_step: v }))],
  ['multiple_cap', [1.2, 1.8, 2.5, 4.0].map((v) => ({ multiple_cap: v }))],
];

function trainScore(params) {
  // selection score: average of the two train halves' errors (each config is later judged held-out)
  return (scoreOn(params, 0).err + scoreOn(params, 1).err) / 2;
}

let current = { ...baseline };
for (let pass = 1; pass <= 2; pass++) {
  for (const [name, options] of groups) {
    let best = current;
    let bestScore = trainScore(current);
    for (const opt of options) {
      const cand = { ...current, ...opt };
      const s = trainScore(cand);
      if (s < bestScore - 1e-9) {
        best = cand;
        bestScore = s;
      }
    }
    if (best !== current) {
      console.log(`pass ${pass} ${name}: train err ${trainScore(current).toFixed(4)} -> ${bestScore.toFixed(4)} via ${JSON.stringify(options.find((o) => Object.keys(o).every((k) => best[k] === o[k])) ?? {})}`);
      current = best;
    }
  }
}

console.log('\nwinner:', fmt(current));
console.log('  full-sample:', JSON.stringify(summarizeLoo(loo(current))));
console.log('  held-out A:', JSON.stringify(heldOut(current, 0)), ' held-out B:', JSON.stringify(heldOut(current, 1)));
const baseHO = (heldOut(baseline, 0).err + heldOut(baseline, 1).err) / 2;
const winHO = (heldOut(current, 0).err + heldOut(current, 1).err) / 2;
const baseRho = (heldOut(baseline, 0).rho + heldOut(baseline, 1).rho) / 2;
const winRho = (heldOut(current, 0).rho + heldOut(current, 1).rho) / 2;
console.log(`\nheld-out median |log10 err|: baseline ${baseHO.toFixed(4)} -> winner ${winHO.toFixed(4)} (${(((baseHO - winHO) / baseHO) * 100).toFixed(1)}% better)`);
console.log(`held-out spearman:           baseline ${baseRho.toFixed(4)} -> winner ${winRho.toFixed(4)}`);
