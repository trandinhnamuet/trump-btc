const fs = require('fs');
const path = require('path');
const https = require('https');

(async () => {
  try {
    const url = 'https://openai.com/api/pricing/';
    const outDir = path.resolve(__dirname);
    const outRaw = path.join(outDir, 'pricing_raw.html');
    const outNext = path.join(outDir, 'pricing_nextdata.json');
    const outExtracted = path.join(outDir, 'pricing_extracted.json');
    const outFinal = path.join(outDir, 'pricing.json');

    const get = (u) => new Promise((resolve, reject) => {
      https.get(u, { headers: { 'User-Agent': 'repo-pricing-fetcher/1.0' } }, (res) => {
        let data = '';
        res.on('data', d => data += d.toString());
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      }).on('error', reject);
    });

    const resp = await get(url);
    if (resp.status !== 200) {
      console.error('HTTP_ERROR', resp.status);
      process.exit(1);
    }

    fs.writeFileSync(outRaw, resp.body, 'utf8');

    // Try to extract __NEXT_DATA__ JSON
    const nextMatch = resp.body.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/i);
    let nextData = null;
    if (nextMatch) {
      try {
        nextData = JSON.parse(nextMatch[1]);
        fs.writeFileSync(outNext, JSON.stringify(nextData, null, 2), 'utf8');
      } catch (e) {
        // ignore
      }
    }

    // Heuristic extraction of price lines from HTML
    // Capture patterns like: "$0.15 / 1M" and context words around them
    const priceRegex = /([A-Za-z0-9\-\.]{2,80})[^\n\r\<]{0,60}?\$\s?([0-9]+(?:\.[0-9]+)?)(?:\s*\/\s*(1M|1K|1000|1000000))?(?:\s*tokens)?/gi;
    const matches = [];
    let m;
    while ((m = priceRegex.exec(resp.body)) !== null) {
      const ctxStart = Math.max(0, m.index - 60);
      const ctx = resp.body.substring(ctxStart, Math.min(resp.body.length, m.index + 120)).replace(/<[^>]+>/g, ' ');
      matches.push({ key: m[1].trim(), price: Number(m[2]), unit: m[3] || null, context: ctx.trim() });
    }
    fs.writeFileSync(outExtracted, JSON.stringify(matches, null, 2), 'utf8');

    // Build final mapping by grouping matches by 'key' and picking first
    const map = {};
    for (const it of matches) {
      const name = it.key;
      if (!map[name]) map[name] = { inputPrice: it.price, outputPrice: it.price, unit: it.unit };
    }

    // Save a final JSON for easy consumption
    fs.writeFileSync(outFinal, JSON.stringify({ ok: true, source: url, map, extractedCount: matches.length }, null, 2), 'utf8');

    console.log('OK');
  } catch (err) {
    console.error('ERROR', err && err.message ? err.message : String(err));
    process.exit(1);
  }
})();
