/**
 * CLI: đo độ chính xác thực tế của các dự đoán đã lưu trong data/posts.json.
 *
 *   npx ts-node src/eval/backtest.ts [--posts data/posts.json] [--labeled data/labeled.json]
 *
 * In ra:
 *   1. Brier skill score so với baseline hằng số  → hệ thống có giá trị hay không
 *   2. AUC                                        → model có xếp hạng đúng không
 *   3. Bias từng model                            → model nào luôn chấm cao/thấp
 *   4. Reliability diagram                        → nói 70% thì thực tế bao nhiêu
 *   5. Isotonic out-of-fold                       → hiệu chuẩn sẽ cứu được bao nhiêu
 */
import * as fs from 'fs';
import * as path from 'path';
import { applyIsotonic, fitIsotonic, MIN_FIT_SAMPLES } from '../calibration/isotonic';
import { dedupeByCluster } from '../calibration/labeler';
import { evaluate, Report } from '../calibration/metrics';
import { Dataset, Label } from '../calibration/types';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const pct = (v: number) => (Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : '  n/a');
const num = (v: number, d = 4) => (Number.isFinite(v) ? v.toFixed(d) : 'n/a');

interface Joined {
  postId: string;
  pred: number; // xác suất dự đoán, [0,1]
  direction: string;
  model: string;
  label: Label;
}

/** LCG cố định hạt giống để phân fold có thể tái lập. */
function seededShuffle<T>(arr: T[], seed = 42): T[] {
  const a = [...arr];
  let s = seed;
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const j = s % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function printReport(title: string, r: Report): void {
  console.log(`\n${title}`);
  console.log('─'.repeat(72));
  console.log(`  n                 ${r.n}`);
  console.log(`  base rate         ${pct(r.baseRate)}   ← tần suất thực tế của |z| >= 2`);
  console.log(`  mean prediction   ${pct(r.meanPred)}`);
  console.log(
    `  BIAS              ${r.bias >= 0 ? '+' : ''}${pct(r.bias)}   ` +
      `${r.bias > 0.05 ? '← chấm CAO hơn thực tế' : r.bias < -0.05 ? '← chấm THẤP hơn thực tế' : '← lệch nhỏ'}`,
  );
  console.log(`  sd of predictions ${pct(r.sd)}   ${r.sd < 0.02 ? '← gần như không phân biệt được bài nào với bài nào' : ''}`);
  console.log('');
  console.log(`  Brier             ${num(r.brier)}`);
  console.log(`  Brier (baseline)  ${num(r.brierBaseline)}   ← predictor hằng số = base rate`);
  console.log(
    `  SKILL SCORE       ${num(r.skillScore)}   ` +
      `${r.skillScore > 0 ? '✅ tốt hơn baseline' : '❌ KHÔNG tốt hơn việc đoán bừa theo base rate'}`,
  );
  console.log('');
  console.log(`  log loss          ${num(r.logLoss)}  (baseline ${num(r.logLossBaseline)})`);
  console.log(`  ECE               ${num(r.ece)}   ← độ lệch trung bình giữa dự đoán và thực tế`);
  console.log(
    `  AUC               ${num(r.auc, 3)}   ` +
      `${r.auc > 0.6 ? '← xếp hạng có tín hiệu, hiệu chuẩn sẽ cứu được' : r.auc > 0.55 ? '← tín hiệu yếu' : '← gần như ngẫu nhiên'}`,
  );
}

function printReliability(r: Report): void {
  if (!r.bins.length) return;
  console.log('\n  Reliability diagram (bin theo phân vị)');
  console.log('  ' + '─'.repeat(70));
  console.log('    dự đoán    thực tế    n     |  hiệu chuẩn hoàn hảo = hai cột bằng nhau');
  for (const b of r.bins) {
    const bar = (v: number) => '█'.repeat(Math.round(v * 30));
    console.log(
      `    ${pct(b.meanPred).padStart(7)}    ${pct(b.meanObs).padStart(7)}  ${String(b.count).padStart(4)}  |  ` +
        `${bar(b.meanPred).padEnd(30, '·')}\n` +
        `${' '.repeat(31)}|  ${bar(b.meanObs).padEnd(30, '·')}`,
    );
  }
}

/** Isotonic out-of-fold: ước lượng trung thực xem hiệu chuẩn sẽ mang lại gì. */
function isotonicOutOfFold(rows: Joined[], folds = 5): number[] | null {
  if (rows.length < MIN_FIT_SAMPLES * 2) return null;

  const shuffled = seededShuffle(rows.map((_, i) => i));
  const foldOf = new Map<number, number>();
  shuffled.forEach((idx, k) => foldOf.set(idx, k % folds));

  const out = new Array<number>(rows.length);
  for (let f = 0; f < folds; f++) {
    const trainIdx = rows.map((_, i) => i).filter(i => foldOf.get(i) !== f);
    const testIdx = rows.map((_, i) => i).filter(i => foldOf.get(i) === f);
    if (trainIdx.length < MIN_FIT_SAMPLES || !testIdx.length) return null;

    const model = fitIsotonic(
      trainIdx.map(i => rows[i].pred),
      trainIdx.map(i => rows[i].label.moved),
    );
    for (const i of testIdx) out[i] = applyIsotonic(model, rows[i].pred);
  }
  return out;
}

function main() {
  const postsFile = path.resolve(arg('posts', path.join('data', 'posts.json')));
  const labeledFile = path.resolve(arg('labeled', path.join('data', 'labeled.json')));

  for (const f of [postsFile, labeledFile]) {
    if (!fs.existsSync(f)) {
      console.error(`Không tìm thấy ${f}. Chạy build-dataset trước.`);
      process.exit(1);
    }
  }

  const posts = JSON.parse(fs.readFileSync(postsFile, 'utf-8')).posts as Array<Record<string, any>>;
  const dataset = JSON.parse(fs.readFileSync(labeledFile, 'utf-8')) as Dataset;

  const byId = new Map(posts.map(p => [p.id, p]));
  const deduped = dedupeByCluster(dataset.labels);

  const rows: Joined[] = [];
  let missingPred = 0;
  for (const label of deduped) {
    const p = byId.get(label.postId);
    if (!p || p.btcInfluenceProbability == null) {
      missingPred++;
      continue;
    }
    rows.push({
      postId: label.postId,
      pred: Math.min(1, Math.max(0, Number(p.btcInfluenceProbability) / 100)),
      direction: p.btcDirection ?? 'neutral',
      model: p.modelUsed ?? 'unknown',
      label,
    });
  }

  console.log('═'.repeat(72));
  console.log(' BACKTEST — dự đoán đã lưu vs. kết quả thị trường thực tế');
  console.log('═'.repeat(72));
  console.log(`Bài đã gắn nhãn      : ${dataset.labels.length}`);
  console.log(`Sau khử cluster 1h   : ${deduped.length}`);
  console.log(`Có dự đoán để so     : ${rows.length}${missingPred ? `  (${missingPred} bài thiếu dự đoán)` : ''}`);

  if (rows.length < 10) {
    console.error('\nQuá ít dữ liệu để đánh giá. Cần posts.json đầy đủ từ server.');
    process.exit(1);
  }

  const zeroPreds = rows.filter(r => r.pred === 0).length;
  if (zeroPreds) {
    console.log(
      `Dự đoán đúng 0%      : ${zeroPreds} (${pct(zeroPreds / rows.length)})  ` +
        `← gồm cả bài bị bỏ qua lẫn bài trúng bug Number()`,
    );
  }

  const preds = rows.map(r => r.pred);
  const labels = rows.map(r => r.label.moved);
  const overall = evaluate(preds, labels);

  printReport('TOÀN BỘ — hệ thống hiện tại (điểm thô LLM, không hiệu chuẩn)', overall);
  printReliability(overall);

  // ── Bias theo từng model ────────────────────────────────────────────────
  const models = [...new Set(rows.map(r => r.model))].sort();
  const perModel: Array<{ model: string; report: Report }> = [];
  for (const m of models) {
    const sub = rows.filter(r => r.model === m);
    if (sub.length < 5) continue;
    perModel.push({
      model: m,
      report: evaluate(
        sub.map(s => s.pred),
        sub.map(s => s.label.moved),
      ),
    });
  }

  if (perModel.length) {
    console.log('\n\nBIAS THEO TỪNG MODEL');
    console.log('─'.repeat(72));
    console.log('  model                                     n   mean    bias     AUC');
    console.log('  ' + '─'.repeat(68));
    for (const { model, report: r } of perModel) {
      const biasStr = `${r.bias >= 0 ? '+' : ''}${(r.bias * 100).toFixed(1)}%`;
      console.log(
        `  ${model.substring(0, 38).padEnd(38)} ${String(r.n).padStart(4)}  ` +
          `${pct(r.meanPred).padStart(6)}  ${biasStr.padStart(6)}  ${num(r.auc, 3).padStart(6)}`,
      );
    }
    console.log('\n  bias dương lớn = model luôn chấm cao; bias âm lớn = luôn chấm thấp.');
    console.log('  Đây chính là con số định lượng cho triệu chứng bạn quan sát được.');

    // ── Thiệt hại do model roulette ───────────────────────────────────────
    // Mỗi model có thang đo riêng. Khi fallback chain đổi model giữa các bài,
    // các con số bị trộn vào cùng một chuỗi và không còn so sánh được với nhau.
    // AUC gộp tụt xuống dưới AUC của từng model chính là thiệt hại đó.
    const usable = perModel.filter(p => Number.isFinite(p.report.auc) && p.report.n >= 20);
    if (usable.length >= 2) {
      const totalN = usable.reduce((a, p) => a + p.report.n, 0);
      const weightedAuc = usable.reduce((a, p) => a + p.report.auc * p.report.n, 0) / totalN;
      const damage = weightedAuc - overall.auc;

      console.log('\n\nTHIỆT HẠI DO MODEL ROULETTE');
      console.log('─'.repeat(72));
      console.log(`  AUC trung bình trong từng model   ${num(weightedAuc, 3)}`);
      console.log(`  AUC khi gộp chung một chuỗi        ${num(overall.auc, 3)}`);
      console.log(`  mất mát                           ${num(damage, 3)}`);
      if (damage > 0.02) {
        console.log('');
        console.log('  Mỗi model xếp hạng tốt hơn hẳn khi xét riêng. Việc fallback chain đổi');
        console.log('  model giữa các bài đã trộn các thang đo khác nhau vào cùng một chuỗi số,');
        console.log('  phá hỏng khả năng so sánh bài này với bài kia — và do đó phá hỏng mọi');
        console.log('  ngưỡng cảnh báo cố định. Phải chuẩn hóa theo từng model trước khi gộp.');
      }
    }
  }

  // ── Hướng, chỉ tính trên các bài thực sự có biến động ────────────────────
  const movedRows = rows.filter(r => r.label.moved);
  if (movedRows.length >= 10) {
    const withDir = movedRows.filter(r => r.direction === 'increase' || r.direction === 'decrease');
    const correct = withDir.filter(r => (r.direction === 'increase') === r.label.up).length;
    console.log('\n\nHƯỚNG (chỉ tính trên bài có |z| >= 2)');
    console.log('─'.repeat(72));
    console.log(`  n có hướng rõ    ${withDir.length}/${movedRows.length}`);
    console.log(
      `  đúng hướng       ${correct}/${withDir.length} = ${pct(withDir.length ? correct / withDir.length : NaN)}  ` +
        `← 50% là tung đồng xu`,
    );
    console.log(`  P(up | moved)    ${pct(dataset.upRateGivenMove)}  ← tần suất nền của hướng tăng`);
  }

  // ── Isotonic out-of-fold ────────────────────────────────────────────────
  const oof = isotonicOutOfFold(rows);
  if (oof) {
    const calibrated = evaluate(oof, labels);
    printReport('SAU HIỆU CHUẨN ISOTONIC (out-of-fold, 5 folds — trung thực)', calibrated);
    console.log('');
    console.log('─'.repeat(72));
    const delta = calibrated.skillScore - overall.skillScore;
    console.log(
      `  Skill score: ${num(overall.skillScore)} → ${num(calibrated.skillScore)}  ` +
        `(${delta >= 0 ? '+' : ''}${num(delta)})`,
    );
    console.log(`  ECE:         ${num(overall.ece)} → ${num(calibrated.ece)}`);
    console.log('');
    console.log('  Hiệu chuẩn KHÔNG tạo thêm khả năng phân biệt — nó chỉ dịch điểm thô về');
    console.log('  đúng thang xác suất. AUC sau hiệu chuẩn có thể tụt nhẹ vì isotonic gộp');
    console.log('  các điểm vào cùng một bậc (sinh hạng đồng), và vì mỗi fold dùng một');
    console.log('  đường hiệu chuẩn khác nhau. Con số cần nhìn là AUC của điểm THÔ.');
    console.log('');
    console.log(`  AUC thô = ${num(overall.auc, 3)}.`);
    if (overall.auc < 0.55) {
      console.log('  → Gần như không có tín hiệu xếp hạng. Hiệu chuẩn không cứu được.');
      console.log('    Phải sửa model/prompt trước, đừng động vào tầng calibration.');
    } else {
      console.log('  → Có tín hiệu xếp hạng. Toàn bộ vấn đề nằm ở thang đo, không nằm ở');
      console.log('    khả năng của model. Hiệu chuẩn là thứ duy nhất bạn cần.');
    }
    console.log('─'.repeat(72));
  } else {
    console.log(`\n\n(Chưa đủ ${MIN_FIT_SAMPLES * 2} mẫu để chạy isotonic out-of-fold.)`);
  }
}

main();
