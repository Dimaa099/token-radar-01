// shots.mjs: retake the entry's three screenshots against the freshly built out/ dashboard.
// Board, one full-evidence detail view (OnRe: a top-ten row priced from nine tokenized peers,
// its three nearest comparables all carrying real market caps), and the Dexs filtered view.
// 1440x900, the gate's long-side cap, served locally because the page reads ../data.js.
//
//   node tools/shots.mjs

import { createRequire } from 'node:module';

const { chromium } = createRequire('/tmp/pwtest/package.json')('playwright-core');

const base = process.env.RADAR_BASE ?? 'http://127.0.0.1:8901';
const out = new URL('../screenshots/', import.meta.url).pathname;

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (e) => {
  console.error('page error:', e.message);
  process.exitCode = 1;
});

await page.goto(`${base}/dashboard/`, { waitUntil: 'load' });
await page.waitForSelector('#rows tr', { timeout: 15000 });
await page.waitForTimeout(400);
await page.screenshot({ path: `${out}1-board.png` });
console.log('shot 1: board');

await page.goto(`${base}/dashboard/#p/onre`, { waitUntil: 'load' });
await page.waitForSelector('#detail .panelbox', { timeout: 15000 });
await page.waitForTimeout(400);
await page.screenshot({ path: `${out}2-detail.png` });
console.log('shot 2: detail (onre)');

await page.goto(`${base}/dashboard/#board?cat=Dexs`, { waitUntil: 'load' });
await page.waitForSelector('#rows tr', { timeout: 15000 });
await page.waitForTimeout(400);
await page.screenshot({ path: `${out}3-filtered.png` });
console.log('shot 3: filtered (Dexs)');

await browser.close();
