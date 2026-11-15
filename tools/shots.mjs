// shots.mjs: retake the entry's four screenshots against the freshly built out/ dashboard.
// Board, one full-evidence detail view (OnRe: a top-ten row priced from nine tokenized peers,
// its three nearest comparables all carrying real market caps — and, since the v3 rebuild,
// the verdict strip and the farm plan above the fold), the Dexs filtered view, and the model
// view with the audit register's head. 1440 wide (the gate's long-side cap) by 1300 tall, so a
// shot carries the price workings AND the plan instead of cutting off between them; served
// locally because the page reads ../data.js.
//
//   node tools/shots.mjs

import { createRequire } from 'node:module';

const { chromium } = createRequire('/tmp/pwtest/package.json')('playwright-core');

const base = process.env.RADAR_BASE ?? 'http://127.0.0.1:8901';
const out = new URL('../screenshots/', import.meta.url).pathname;

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 1250 } });
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

await page.setViewportSize({ width: 1440, height: 1000 });
await page.goto(`${base}/dashboard/#model`, { waitUntil: 'load' });
await page.waitForSelector('#auditregister tbody tr', { timeout: 15000 });
await page.waitForTimeout(400);
// Frame the audit section itself: the coverage claim, its counts, and the head of the register.
await page.evaluate(() => document.getElementById('audithead').scrollIntoView());
await page.waitForTimeout(300);
await page.screenshot({ path: `${out}4-model.png` });
console.log('shot 4: model (audit section)');

await browser.close();
