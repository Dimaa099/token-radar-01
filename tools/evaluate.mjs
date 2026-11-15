// evaluate.mjs: repeated-split verdict on a handful of candidate parameter settings.
//
// fit.mjs's coordinate descent selects on the same protocols it is scored on, so its winner can
// be an artifact of one lucky split. Here the candidates are fixed in advance and each is scored
// on the held-out half of 24 seeded random splits of the snapshot's tokenized protocols: the
// question is not "which setting can be made to look best" but "which setting keeps winning on
// protocols it was never tuned against".
//
//   node tools/evaluate.mjs [snapshot.json]

import { readFileSync } from 'node:fs';
import { PARAMS, looPredictions, parseSnapshot, summarizeLoo } from '../lib/model.ts';

const input = process.argv[2] ?? new URL('../../../token-radar-01-kit/token-radar-01-kit/input/snapshot.json', import.meta.url).pathname;
const snapshot = parseSnapshot(readFileSync(input, 'utf8'));

const CANDIDATES = {
  'C0 comps-2 baseline': { ...PARAMS },
  'T1 beta 0.15': { ...PARAMS, size_beta: 0.15 },
  'T2 beta 0.25': { ...PARAMS, size_beta: 0.25 },
  'T3 beta 0.35': { ...PARAMS, size_beta: 0.35 },
  'T4 beta 0.45': { ...PARAMS, size_beta: 0.45 },
  'T5 T3 + smooth K=6': { ...PARAMS, size_beta: 0.35, smooth: true, shrink_k: 6 },
  'T6 T3 + growth 0.25': { ...PARAMS, size_beta: 0.35, growth_weight: 0.25 },
  'T7 T3 + runway 0.20': { ...PARAMS, size_beta: 0.35, runway_range: 0.2 },
  'T8 T3 + both mild': { ...PARAMS, size_beta: 0.35, growth_weight: 0.35, runway_range: 0.3 },
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

const SPLITS = 24;
const names = Object.keys(CANDIDATES);
const preds = {};
for (const name of names) preds[name] = looPredictions(snapshot, CANDIDATES[name]);
const slugs = preds[names[0]].map((p) => p.slug);

const testErr = Object.fromEntries(names.map((n) => [n, []]));
const testRho = Object.fromEntries(names.map((n) => [n, []]));
const winsVsBase = Object.fromEntries(names.map((n) => [n, 0]));

for (let s = 0; s < SPLITS; s++) {
  const rand = rng(1000 + s);
  const testSet = new Set(slugs.filter(() => rand() < 0.5));
  const errs = {};
  for (const name of names) {
    const sub = preds[name].filter((p) => testSet.has(p.slug));
    const sum = summarizeLoo(sub);
    errs[name] = sum.median_abs_log10_error;
    testErr[name].push(sum.median_abs_log10_error);
    testRho[name].push(sum.spearman);
  }
  for (const name of names) if (name !== names[0] && errs[name] < errs[names[0]]) winsVsBase[name]++;
}

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

console.log(`${SPLITS} seeded 50/50 splits, ${slugs.length} tokenized protocols; test-half scores:`);
console.log('candidate                 meanErr  medErr  meanRho  splits beating C0');
for (const name of names) {
  console.log(
    `${name.padEnd(24)} ${mean(testErr[name]).toFixed(4)}  ${med(testErr[name]).toFixed(4)}  ${mean(testRho[name]).toFixed(4)}   ${name === names[0] ? '—' : `${winsVsBase[name]}/${SPLITS}`}`,
  );
}
for (const name of names) {
  console.log(`${name} full-sample:`, JSON.stringify(summarizeLoo(preds[name])));
}
