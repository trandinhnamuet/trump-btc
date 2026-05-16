const fs = require('fs');
const https = require('https');
const path = require('path');

(async () => {
  try {
    const envPath = path.resolve(__dirname, '..', '.env');
    if (!fs.existsSync(envPath)) {
      console.error('NO_ENV_FILE');
      process.exit(2);
    }
    const content = fs.readFileSync(envPath, 'utf8');
    const m = content.match(/^OPENAI_API_KEY\s*=\s*(.+)$/m);
    if (!m) {
      console.error('NO_KEY_IN_ENV');
      process.exit(2);
    }
    const key = m[1].trim();

    const options = {
      hostname: 'api.openai.com',
      path: '/v1/models',
      method: 'GET',
      headers: {
        'Authorization': 'Bearer ' + key,
        'User-Agent': 'repo-fetch-models-script/1.0'
      },
      timeout: 15000,
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const outPath = path.resolve(__dirname, 'models.json');
          fs.writeFileSync(outPath, data, 'utf8');
          console.log('OK');
        } catch (err) {
          console.error('WRITE_ERROR', err.toString());
          process.exit(1);
        }
      });
    });

    req.on('error', (err) => {
      console.error('REQUEST_ERROR', err.toString());
      process.exit(1);
    });

    req.end();
  } catch (err) {
    console.error('ERROR', err && err.stack ? err.stack : String(err));
    process.exit(1);
  }
})();
