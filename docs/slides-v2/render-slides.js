// render-slides.js — slides-v2/proposal.html → PDF (8 slides, 1280x720 each)
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto('file:///C:/Users/nydia/Downloads/hackathon/docs/slides-v2/proposal.html', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500); // fonts + reveal animations settle
  await page.pdf({
    path: 'C:/Users/nydia/Downloads/hackathon/docs/slides-v2/HireMind-Proposal-v2.pdf',
    width: '1280px',
    height: '720px',
    printBackground: true,
    margin: { top: 0, bottom: 0, left: 0, right: 0 },
  });
  // Screenshot each slide for self-review
  const slides = await page.$$('.slide');
  for (let i = 0; i < slides.length; i++) {
    await slides[i].scrollIntoViewIfNeeded();
    await page.waitForTimeout(1600); // let reveal animation finish
    await slides[i].screenshot({ path: `C:/Users/nydia/Downloads/hackathon/docs/slides-v2/preview-${String(i + 1).padStart(2, '0')}.png` });
  }
  await browser.close();
  console.log(`PDF saved + ${slides.length} slide previews`);
})();
