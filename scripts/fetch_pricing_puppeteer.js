const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

(async () => {
  const outPath = path.resolve(__dirname, 'pricing_puppeteer.json');
  try {
    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36',
    );
    await page.goto('https://openai.com/api/pricing/', { waitUntil: 'networkidle2', timeout: 60000 });

    // Try to grab __NEXT_DATA__ if present
    const nextDataRaw = await page.evaluate(() => {
      const el = document.getElementById('__NEXT_DATA__');
      return el ? el.textContent : null;
    }).catch(() => null);

    const bodyText = await page.evaluate(() => document.body.innerText).catch(() => '');

    const results = [];

    // Regex to find price occurrences like $0.15, $0.15/1M, $0.02 / 1k, etc.
    const priceRegex = /\$\s*([0-9]+(?:\.[0-9]+)?)(?:\s*(?:\/|per)\s*(1M|1K|1k|1000|1000000|M|k)?)?/gi;
    let m;
    while ((m = priceRegex.exec(bodyText)) !== null) {
      const priceNum = Number(m[1]);
      let unitRaw = m[2] || null;
      if (unitRaw) unitRaw = unitRaw.toString();
      const idx = m.index;
      const ctxStart = Math.max(0, idx - 200);
      const ctxEnd = Math.min(bodyText.length, idx + 200);
      const ctx = bodyText.substring(ctxStart, ctxEnd).replace(/\s+/g, ' ').trim();

      // try to find nearest gpt model id in context
      const modelMatch = ctx.match(/(gpt[-0-9A-Za-z\.\_]+|gpt[\s-]?[0-9\.]+)/i);
      const modelId = modelMatch ? modelMatch[0].replace(/\s+/g, '') : null;

      // also detect role words (prompt/input vs completion/output)
      const role = /prompt|input|prompt tokens|input tokens/i.test(ctx)
        ? 'input'
        : (/completion|output|response|completion tokens|output tokens/i.test(ctx) ? 'output' : 'unknown');

      results.push({ price: priceNum, unit: unitRaw, context: ctx, modelId, role });
    }

    // Build mapping by grouping by modelId (if none found, group under 'unknown')
    const map = {};
    for (const r of results) {
      const key = r.modelId || 'unknown';
      if (!map[key]) map[key] = [];
      map[key].push(r);
    }

    // Heuristic: convert unit to per-1M tokens; if unit is 1K or 1k or 1000 multiply by 1000
    const normalizeToPer1M = (price, unit) => {
      if (!unit) return price; // assume already per 1M
      const u = unit.toString().toLowerCase();
      if (u.includes('1k') || u.includes('k') || u === '1000') return price * 1000;
      if (u.includes('1m') || u.includes('m') || u === '1000000') return price;
      return price;
    };

    const finalMap = {};
    for (const key of Object.keys(map)) {
      const entries = map[key];
      // Try to find input and output separately
      let inputEntry = entries.find(e => e.role === 'input');
      let outputEntry = entries.find(e => e.role === 'output');

      // fallback heuristics: if multiple entries, pick first as input, second as output
      if (!inputEntry && entries.length >= 1) inputEntry = entries[0];
      if (!outputEntry && entries.length >= 2) outputEntry = entries[1];
      if (!outputEntry && inputEntry) outputEntry = inputEntry;

      const inputPrice = inputEntry ? normalizeToPer1M(inputEntry.price, inputEntry.unit) : 0;
      const outputPrice = outputEntry ? normalizeToPer1M(outputEntry.price, outputEntry.unit) : inputPrice;

      finalMap[key] = { inputPrice, outputPrice, raw: entries };
    }

    const out = { ok: true, source: 'https://openai.com/api/pricing/', extractedCount: results.length, map: finalMap, nextData: null };

    if (nextDataRaw) {
      try {
        out.nextData = JSON.parse(nextDataRaw);
      } catch (e) {
        out.nextData = nextDataRaw;
      }
    }

    fs.writeFileSync(outPath, JSON.stringify(out, null, 2), 'utf8');

    await browser.close();
    console.log('OK');
  } catch (err) {
    console.error('ERROR', err && err.stack ? err.stack : String(err));
    process.exit(1);
  }
})();
