import { applyIsotonic, fitIsotonic } from './isotonic';
import { ewmaStd } from './labeler';
import { auc, baseRate, brier, evaluate } from './metrics';
import { QuantileNormalizer } from './quantile';
import { coerceNumber, parseJudgment, rawScoreOf } from '../analysis/prompt-v2';

describe('coerceNumber — chống bug "85%" → 0 của v1', () => {
  it('bóc ký tự % thay vì trả 0', () => {
    expect(coerceNumber('85%')).toBe(85);
    expect(coerceNumber('0.72')).toBeCloseTo(0.72);
    expect(coerceNumber('  3 ')).toBe(3);
    expect(coerceNumber('0,5')).toBeCloseTo(0.5); // dấu phẩy thập phân
  });
  it('trả null (không phải 0) khi thực sự không có số', () => {
    expect(coerceNumber('abc')).toBeNull();
    expect(coerceNumber(undefined)).toBeNull();
    expect(coerceNumber(NaN)).toBeNull();
  });
});

describe('parseJudgment — parse chặt, thiếu trường thì null', () => {
  const valid = {
    reasoning: 'x',
    summary: 'y',
    topics: ['tariffs'],
    actionable: true,
    novel: true,
    beatsAnchor: [true, true, false, false, false, false],
    bucket: 3,
    direction: 'increase',
    directionConfidence: 0.8,
  };
  it('parse được phán đoán hợp lệ', () => {
    const j = parseJudgment(valid)!;
    expect(j.bucket).toBe(3);
    expect(j.beatsAnchor).toHaveLength(6);
    expect(j.direction).toBe('increase');
  });
  it('null khi beatsAnchor sai độ dài', () => {
    expect(parseJudgment({ ...valid, beatsAnchor: [true, false] })).toBeNull();
  });
  it('null khi bucket ngoài [0,5]', () => {
    expect(parseJudgment({ ...valid, bucket: 9 })).toBeNull();
  });
  it('direction lạ → neutral, confidence kẹp về [0.5,1]', () => {
    const j = parseJudgment({ ...valid, direction: 'sideways', directionConfidence: 0.1 })!;
    expect(j.direction).toBe('neutral');
    expect(j.directionConfidence).toBe(0.5);
  });
});

describe('rawScoreOf — anchorRank chi phối', () => {
  const base = {
    reasoning: '', summary: '', topics: [], actionable: false, novel: false,
    bucket: 0, direction: 'neutral' as const, directionConfidence: 0.5,
  };
  it('beat nhiều neo hơn → điểm cao hơn', () => {
    const few = rawScoreOf({ ...base, beatsAnchor: [true, false, false, false, false, false] }, 0);
    const many = rawScoreOf({ ...base, beatsAnchor: [true, true, true, true, true, false] }, 0);
    expect(many).toBeGreaterThan(few);
  });
  it('điểm nằm trong [0,1]', () => {
    const max = rawScoreOf({ ...base, bucket: 5, beatsAnchor: new Array(6).fill(true) }, 1);
    expect(max).toBeLessThanOrEqual(1);
    expect(max).toBeGreaterThanOrEqual(0);
  });
});

describe('ewmaStd', () => {
  it('trả về std dương cho chuỗi có biến động', () => {
    const returns = Array.from({ length: 200 }, (_, i) => Math.sin(i) * 0.01);
    expect(ewmaStd(returns)).toBeGreaterThan(0);
  });
  it('chuỗi biến động lớn → σ lớn hơn chuỗi biến động nhỏ', () => {
    const small = Array.from({ length: 200 }, (_, i) => (i % 2 ? 0.001 : -0.001));
    const big = Array.from({ length: 200 }, (_, i) => (i % 2 ? 0.02 : -0.02));
    expect(ewmaStd(big)).toBeGreaterThan(ewmaStd(small));
  });
});

describe('isotonic — biến điểm thô thành tần suất thực nghiệm', () => {
  it('đơn điệu không giảm', () => {
    const n = 300;
    const x = Array.from({ length: n }, (_, i) => i / n);
    const y = x.map(xi => Math.random() < xi); // xác suất tăng theo x
    const model = fitIsotonic(x, y);
    let prev = -Infinity;
    for (let s = 0; s <= 1; s += 0.05) {
      const p = applyIsotonic(model, s);
      expect(p).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = p;
    }
  });

  it('KHỬ BIAS THANG ĐO: hai model xếp hạng giống nhau cho cùng đường hiệu chuẩn', () => {
    // Đây là bài test cho triệu chứng gốc: model A luôn chấm cao, B luôn thấp,
    // nhưng THỨ TỰ giống nhau → sau hiệu chuẩn phải cho xác suất tương đương.
    const n = 400;
    const rank = Array.from({ length: n }, (_, i) => i / n);
    const labels = rank.map(r => (i => i)(Math.random() < 0.05 + 0.4 * r));

    const highBiased = rank.map(r => 0.55 + 0.4 * r); // [0.55, 0.95]
    const lowBiased = rank.map(r => 0.02 + 0.15 * r); // [0.02, 0.17]

    const mHigh = fitIsotonic(highBiased, labels);
    const mLow = fitIsotonic(lowBiased, labels);

    // Tại cùng một thứ hạng (ví dụ top), hai model phải cho xác suất gần nhau
    const pHigh = applyIsotonic(mHigh, highBiased[Math.floor(n * 0.9)]);
    const pLow = applyIsotonic(mLow, lowBiased[Math.floor(n * 0.9)]);
    expect(Math.abs(pHigh - pLow)).toBeLessThan(0.15);
  });

  it('chưa đủ mẫu → trả về base rate', () => {
    const model = fitIsotonic([0.1, 0.2, 0.3], [true, false, true]);
    expect(applyIsotonic(model, 0.9)).toBeCloseTo(2 / 3);
  });
});

describe('metrics — skill score là thước đo trung thực', () => {
  it('predictor hằng số = base rate → skill score = 0', () => {
    const labels = [true, false, false, false, false, true, false, false, false, false];
    const br = baseRate(labels);
    const preds = new Array(labels.length).fill(br);
    const r = evaluate(preds, labels);
    expect(r.skillScore).toBeCloseTo(0, 5);
  });
  it('dự đoán hoàn hảo → Brier = 0, skill = 1', () => {
    const labels = [true, false, true, false, true, false];
    const preds = labels.map(l => (l ? 1 : 0));
    expect(brier(preds, labels)).toBeCloseTo(0);
    expect(evaluate(preds, labels).skillScore).toBeCloseTo(1);
  });
  it('AUC = 1 khi tách hoàn hảo, ~0.5 khi ngẫu nhiên', () => {
    const labels = [false, false, false, true, true, true];
    const perfect = [0.1, 0.2, 0.3, 0.7, 0.8, 0.9];
    expect(auc(perfect, labels)).toBeCloseTo(1);
    const tied = new Array(6).fill(0.5);
    expect(auc(tied, labels)).toBeCloseTo(0.5);
  });
});

describe('QuantileNormalizer — chuẩn hóa theo từng model', () => {
  it('trả null khi chưa đủ mẫu, rồi trả phân vị hợp lệ', () => {
    const q = new QuantileNormalizer(200);
    q.push('m', 0.5);
    expect(q.percentile('m', 0.5)).toBeNull(); // < MIN_BUFFER
    for (let i = 0; i < 100; i++) q.push('m', i / 100);
    const p = q.percentile('m', 0.5)!;
    expect(p).toBeGreaterThan(0.4);
    expect(p).toBeLessThan(0.6);
  });
  it('điểm cao nhất → phân vị gần 1', () => {
    const q = new QuantileNormalizer(200);
    for (let i = 0; i < 100; i++) q.push('m', i / 100);
    expect(q.percentile('m', 0.99)!).toBeGreaterThan(0.9);
  });
});
