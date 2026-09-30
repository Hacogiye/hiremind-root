// scripts/shot.js — Tự chụp màn hình đánh giá UI (Playwright + Chromium).
// Chạy: node scripts/shot.js <sessionId> [prefix]   (server phải đang chạy ở BASE)
// Kết quả: docs/screenshots/<prefix>*.png (landing, overview, tab CV viết lại, dark, mobile)
const { chromium } = require('playwright');
const path = require('path');

const SESSION_ID = process.argv[2] || 'f603f88665dd';
const PREFIX = process.argv[3] || 'v15-';
const BASE = process.env.BASE || 'http://localhost:3111';
const OUT = path.join(__dirname, '..', 'docs', 'screenshots');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const shot = name => page.screenshot({ path: path.join(OUT, name), fullPage: true });
  const shotVp = name => page.screenshot({ path: path.join(OUT, name), fullPage: false });

  // Landing (regression): light + dark
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  await shotVp(PREFIX + 'landing-light.png');
  await page.click('[data-theme-toggle]');
  await page.waitForTimeout(400);
  await shotVp(PREFIX + 'landing-dark.png');
  // về light + clear localStorage theme để session render light mặc định
  await page.click('[data-theme-toggle]');
  await page.evaluate(() => localStorage.removeItem('hm-theme'));
  await page.waitForTimeout(200);

  // Session: overview (light)
  await page.goto(`${BASE}/s/${SESSION_ID}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.result-hero', { timeout: 25000 });
  await page.waitForTimeout(1500); // chờ count-up + compare panel fetch
  await shot(PREFIX + 'overview-light.png');

  // Tab CV viết lại (light) — phiên có thể đã có rewrite (.rw-cv) hoặc chưa (#rwGen)
  await page.click('[data-tab="rewrite"]');
  await page.waitForSelector('#rwResult .rw-cv, #rwGen', { timeout: 25000 });
  await page.waitForTimeout(400);
  await shot(PREFIX + 'rewrite-light.png');

  // Tab CV viết lại (dark)
  await page.click('[data-theme-toggle]');
  await page.waitForTimeout(500);
  await shot(PREFIX + 'rewrite-dark.png');
  await page.click('[data-theme-toggle]');
  await page.waitForTimeout(300);

  // Mobile (viewport nhỏ)
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(500);
  await shot(PREFIX + 'rewrite-mobile.png');

  await browser.close();
  console.log('OK — shots saved: docs/screenshots/' + PREFIX + '*.png');
})().catch(e => { console.error('SHOT FAILED:', e.message); process.exit(1); });
