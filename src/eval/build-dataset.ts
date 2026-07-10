/**
 * CLI: dựng tập dữ liệu có nhãn từ data/posts.json + nến 1 phút của Binance.
 *
 *   npx ts-node src/eval/build-dataset.ts [--posts data/posts.json] [--out data/labeled.json]
 *
 * Không tốn API call của LLM. Chạy lại rẻ vì nến được cache theo tháng.
 */
import * as fs from 'fs';
import * as path from 'path';
import { BinanceHistory } from '../calibration/binance-history';
import { dedupeByCluster, labelPosts } from '../calibration/labeler';
import {
  Dataset,
  EWMA_LAMBDA,
  VOL_LOOKBACK_DAYS,
  Z_THRESHOLD,
} from '../calibration/types';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main() {
  const postsFile = path.resolve(arg('posts', path.join('data', 'posts.json')));
  const outFile = path.resolve(arg('out', path.join('data', 'labeled.json')));

  if (!fs.existsSync(postsFile)) {
    console.error(`Không tìm thấy ${postsFile}. Copy posts.json từ server về trước.`);
    process.exit(1);
  }

  const raw = JSON.parse(fs.readFileSync(postsFile, 'utf-8'));
  const posts: Array<{ id: string; createdAt: string }> = raw.posts ?? [];
  if (!posts.length) {
    console.error('posts.json rỗng.');
    process.exit(1);
  }

  const t0s = posts.map(p => Date.parse(p.createdAt)).filter(t => !Number.isNaN(t));
  const minT0 = Math.min(...t0s);
  const maxT0 = Math.max(...t0s);

  console.log(`Bài viết: ${posts.length}`);
  console.log(`Khoảng thời gian: ${new Date(minT0).toISOString()} → ${new Date(maxT0).toISOString()}`);

  const history = new BinanceHistory('BTCUSDT', path.join(process.cwd(), 'data', 'klines'), msg =>
    console.log(msg),
  );
  // Cần thêm VOL_LOOKBACK_DAYS trước bài sớm nhất (để tính σ) và 1h sau bài muộn nhất (để có kết quả)
  await history.load(minT0 - (VOL_LOOKBACK_DAYS + 1) * DAY_MS, maxT0 + 2 * HOUR_MS);

  const { labels, unlabeled } = labelPosts(posts, history);
  const deduped = dedupeByCluster(labels);

  const moved = deduped.filter(l => l.moved);
  const dataset: Dataset = {
    builtAt: new Date().toISOString(),
    symbol: 'BTCUSDT',
    zThreshold: Z_THRESHOLD,
    ewmaLambda: EWMA_LAMBDA,
    volLookbackDays: VOL_LOOKBACK_DAYS,
    labels,
    unlabeled,
    baseRate: deduped.length ? moved.length / deduped.length : NaN,
    upRateGivenMove: moved.length ? moved.filter(l => l.up).length / moved.length : NaN,
  };

  fs.writeFileSync(outFile, JSON.stringify(dataset, null, 2), 'utf-8');

  const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
  console.log('');
  console.log('─'.repeat(64));
  console.log(`Đã gắn nhãn      : ${labels.length}`);
  console.log(`Không gắn được   : ${unlabeled.length}`);
  console.log(`Sau khử cluster  : ${deduped.length}  (mỗi cửa sổ 1h chỉ giữ 1 bài đại diện)`);
  console.log('');
  console.log(`BASE RATE        : ${pct(dataset.baseRate)}  ← P(|z| >= ${Z_THRESHOLD})`);
  console.log(`P(up | moved)    : ${pct(dataset.upRateGivenMove)}`);
  console.log('');
  console.log(`Đây là con số mà mọi dự đoán phải tôn trọng. Một hệ hiệu chuẩn đúng`);
  console.log(`sẽ trả về khoảng ${pct(dataset.baseRate)} cho phần lớn bài, không phải 40-70%.`);
  console.log('─'.repeat(64));

  if (unlabeled.length) {
    const reasons = new Map<string, number>();
    for (const u of unlabeled) {
      const key = u.reason.replace(/\d+/g, 'N');
      reasons.set(key, (reasons.get(key) ?? 0) + 1);
    }
    console.log('\nLý do không gắn nhãn được:');
    for (const [r, c] of [...reasons].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(c).padStart(5)}  ${r}`);
    }
  }

  console.log(`\nĐã ghi ${outFile}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
