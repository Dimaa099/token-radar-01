// evaluate2.mjs: the comps-4 candidate verdict, under a protocol fixed before any candidate ran.
//
// The question comps-3 left open is not a parameter: three structural choices in how the peer
// evidence is read. (A) The size tilt is measured against the whole peer set's median TVL,
// though the size effect lives inside the market a protocol is priced in: candidate A measures
// it against the protocol's own category peers' median TVL. (B) A category too thin to carry
// its own median prices at the bare global median, so the board's biggest rows rest on no
// local evidence: candidate B prices a thin category from the tokenized protocols nearest the
// protocol in TVL, blended with the global median. (C) A category's multiple is its median
// ratio, one or two middle values speaking for the whole peer set: candidate C reads it as the
// trimmed mean of the log ratios. D and E combine A with B and C.
//
// Protocol, fixed in advance: candidates are scored on the held-out half of 24 seeded 50/50
// splits of the snapshot's tokenized protocols (seeds 1000..1023, the comps-3 selection set).
// A candidate ships only if, on that set, it beats the comps-3 baseline's mean test error,
// wins at least 14 of the 24 splits head-to-head, and gives up no more than 0.01 of mean rank
// correlation — AND repeats the verdict on a confirmation set it was never selected against
// (seeds 5000..5023, same bar, at least 13 of 24). Anything less is noise wearing a lab coat.
//
//   node tools/evaluate2.mjs [snapshot.json]

import { readFileSync } from 'node:fs';
import { PARAMS, looPredictions, parseSnapshot, summarizeLoo } from '../lib/model.ts';

const input = process.argv[2] ?? new URL('../../../token-radar-01-kit/token-radar-01-kit/input/snapshot.json', import.meta.url).pathname;
const snapshot = parseSnapshot(readFileSync(input, 'utf8'));

// The comps-3 baseline is pinned explicitly, not spread from PARAMS: once comps-4 shipped,
// PARAMS *is* candidate D, and a baseline that moves with the shipping setting would grade
// the new model against itself. COMPS3 below is the comps-3 setting exactly as it shipped.
const COMPS3 = { ...PARAMS, size_ref: 'global', thin_neighbors: 0, estimator: 'median' };

const CANDIDATES = {
  'C3 comps-3 baseline': { ...COMPS3 },
  'A size-ref category': { ...COMPS3, size_ref: 'category' },
  'B thin neighbours k8': { ...COMPS3, thin_neighbors: 8 },
  'C trimlog estimator': { ...COMPS3, estimator: 'trimlog' },
  'D A+B (comps-4)': { ...COMPS3, size_ref: 'category', thin_neighbors: 8 },
  'E A+C': { ...COMPS3, size_ref: 'category', estimator: 'trimlog' },
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
  console.log('candidate                 meanErr  medErr  meanRho  splits beating C3');
  for (const name of names) {
    console.log(
      `${name.padEnd(24)} ${mean(testErr[name]).toFixed(4)}  ${med(testErr[name]).toFixed(4)}  ${mean(testRho[name]).toFixed(4)}   ${name === base ? '—' : `${wins[name]}/${SPLITS}`}`,
    );
  }
  return { meanErr: Object.fromEntries(names.map((n) => [n, mean(testErr[n])])), meanRho: Object.fromEntries(names.map((n) => [n, mean(testRho[n])])), wins };
}

const sel = runSet(1000, 'selection set');
const conf = runSet(5000, 'confirmation set');

console.log('\nfull-sample (all 128, leave-one-out):');
for (const name of names) console.log(`${name}:`, JSON.stringify(summarizeLoo(preds[name])));

console.log('\nverdicts (ship = beats C3 meanErr on both sets, >=14/24 then >=13/24 split wins, rho within 0.01 on both):');
for (const name of names.slice(1)) {
  const ok =
    sel.meanErr[name] < sel.meanErr[base] && conf.meanErr[name] < conf.meanErr[base] &&
    sel.wins[name] >= 14 && conf.wins[name] >= 13 &&
    sel.meanRho[name] >= sel.meanRho[base] - 0.01 && conf.meanRho[name] >= conf.meanRho[base] - 0.01;
  console.log(`${name}: ${ok ? 'SHIP' : 'hold'} (selErr ${sel.meanErr[name].toFixed(4)} vs ${sel.meanErr[base].toFixed(4)}, confErr ${conf.meanErr[name].toFixed(4)} vs ${conf.meanErr[base].toFixed(4)}, wins ${sel.wins[name]}/${conf.wins[name]}, rho ${sel.meanRho[name].toFixed(3)}/${conf.meanRho[name].toFixed(3)} vs ${sel.meanRho[base].toFixed(3)}/${conf.meanRho[base].toFixed(3)})`);
}
