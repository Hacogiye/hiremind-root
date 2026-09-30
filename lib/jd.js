// lib/jd.js — Fetch job description from URL. 3-tier: direct fetch → jina.ai → Playwright headless Chromium.
// Playwright loads lazily: shared hosts (cPanel) can't run Chromium — the app must
// still boot and serve the other 2 tiers without it.
function getChromium() {
  try {
    return require('playwright').chromium;
  } catch {
    return null; // playwright not installed — browser tier disabled
  }
}

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// Known job boards that need browser rendering (Cloudflare etc.)
const NEEDS_BROWSER = /topcv\.vn|itviec\.com|topcv\.|vietnamworks|glints|careerbuilder|headhunt/i;

function cleanText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .split('\n').map(l => l.trim()).filter(Boolean).join('\n')
    .trim();
}

// Block SSRF: JD fetch must target public web only — never the host itself or internal networks.
function assertPublicUrl(rawUrl) {
  let u;
  try { u = new URL(String(rawUrl)); } catch { throw new Error('Link JD không hợp lệ'); }
  if (!/^https?:$/.test(u.protocol)) throw new Error('Chỉ hỗ trợ link http/https');
  const h = u.hostname.toLowerCase();
  const blocked = h === 'localhost' || h === '0.0.0.0' || h.endsWith('.local')
    || h === 'metadata.google.internal'
    || /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(h);
  if (blocked) throw new Error('Link JD trỏ tới địa chỉ nội bộ — không được phép');
  return u.href;
}

// Tier 1: direct fetch (works for simple sites, company career pages)
async function fetchDirect(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html,application/xhtml+xml,*/*;q=0.8', 'Accept-Language': 'vi-VN,vi;q=0.9,en;q=0.8' },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`direct ${res.status}`);
  const html = await res.text();
  if (html.length < 2000 || /Just a moment|captcha|Attention Required/i.test(html)) throw new Error('direct blocked');
  return cleanText(html);
}

// Tier 2: jina.ai reader (free, handles many sites)
async function fetchJina(url) {
  const res = await fetch(`https://r.jina.ai/${url}`, { headers: { 'User-Agent': BROWSER_UA } });
  if (!res.ok) throw new Error(`jina ${res.status}`);
  const text = await res.text();
  if (text.length < 800 || /Attention Required|captcha/i.test(text)) throw new Error('jina blocked');
  return text;
}

// Tier 3: real headless Chromium — defeats JS/Cloudflare checks on job boards
async function fetchBrowser(url) {
  const chromium = getChromium();
  if (!chromium) throw new Error('browser tier unavailable on this host');
  const browser = await chromium.launch({ headless: true, args: ['--disable-blink-features=AutomationControlled'] });
  try {
    const page = await browser.newPage({ userAgent: BROWSER_UA, viewport: { width: 1366, height: 900 }, locale: 'vi-VN' });
    await page.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => undefined }));
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(4000); // let JS/anti-bot settle
    const html = await page.content();
    const title = await page.title().catch(() => '');
    if (/Just a moment|Attention Required/i.test(title) && html.length < 8000) {
      // one more wait in case the challenge resolves
      await page.waitForTimeout(8000);
      return cleanText(await page.content());
    }
    return cleanText(html);
  } finally {
    await browser.close();
  }
}

async function fetchJD(url) {
  url = assertPublicUrl(url); // SSRF guard — one gate for all 3 tiers
  const tiers = NEEDS_BROWSER.test(url)
    ? [['browser', fetchBrowser], ['jina', fetchJina], ['direct', fetchDirect]]
    : [['direct', fetchDirect], ['jina', fetchJina], ['browser', fetchBrowser]];
  const errors = [];
  for (const [name, fn] of tiers) {
    try {
      const text = await fn(url);
      if (text && text.length > 500) return { text, via: name };
      errors.push(`${name}: too short (${text?.length || 0})`);
    } catch (e) {
      errors.push(`${name}: ${e.message}`);
    }
  }
  throw new Error(`Không tải được tin tuyển dụng (${errors.join('; ')}). Hãy dán nội dung JD thủ công.`);
}

module.exports = { fetchJD, cleanText, assertPublicUrl };
