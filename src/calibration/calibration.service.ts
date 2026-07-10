import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { BinanceHistory } from './binance-history';
import { applyIsotonic, fitIsotonic, IsotonicModel, MIN_FIT_SAMPLES } from './isotonic';
import { dedupeByCluster, labelPosts } from './labeler';
import { brier } from './metrics';
import { QuantileNormalizer, QuantileState } from './quantile';
import { Label, VOL_LOOKBACK_DAYS, Z_THRESHOLD } from './types';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** Base rate khởi đầu trước khi có nhãn thật. Cố tình đặt thấp: hầu hết bài không làm gì cả. */
const BOOTSTRAP_BASE_RATE = 0.05;
const BOOTSTRAP_UP_RATE = 0.5;

/** Trần xác suất. Không có bằng chứng nào từ một bài đăng đủ mạnh để chắc chắn hơn mức này. */
const P_MOVE_CAP = 0.85;

/**
 * Độ dốc của hàm likelihood ratio khi chưa đủ dữ liệu để fit isotonic.
 * K = 4.6 cho LR ≈ 20× khi điểm thô đạt mức cao nhất so với điểm trung vị.
 */
const EVIDENCE_SLOPE = 4.6;

/** Số bản ghi lịch sử tối đa giữ lại. */
const MAX_HISTORY = 5000;

/** Pseudo-count kéo pUp về tần suất nền khi số mẫu `moved` còn ít. */
const UP_SHRINK_K = 10;

export interface PredictionRecord {
  postId: string;
  /** thời điểm Trump đăng bài, epoch ms */
  t0: number;
  model: string;
  /** điểm thô [0,1] do rawScoreOf() sinh ra */
  rawScore: number;
  /** xác suất đã hiệu chuẩn tại thời điểm dự đoán, để chấm Brier về sau */
  pMove: number;
  /** phiếu hướng [0,1]; 1 = chắc chắn tăng */
  rawUp: number;
  // ── điền vào sau, khi mốc 1h đã trôi qua ──
  moved?: boolean;
  up?: boolean;
  z?: number;
}

interface CalibrationState {
  version: string;
  updatedAt: string;
  baseRate: number;
  upRateGivenMove: number;
  /** số bài (đã khử cluster) dùng để ước lượng baseRate */
  labeledPosts: number;
  quantile: QuantileState[];
  /** đường hiệu chuẩn riêng cho từng model */
  isotonic: Record<string, IsotonicModel>;
  /** Brier score gần nhất của từng model, dùng làm trọng số ensemble */
  brierByModel: Record<string, number>;
  history: PredictionRecord[];
}

export interface CalibratedScore {
  pMove: number;
  /** true khi con số đến từ isotonic đã fit trên nhãn thật; false = đang dùng prior + bằng chứng */
  calibrated: boolean;
  /** phân vị của điểm thô trong phân phối lịch sử của chính model đó, null khi chưa đủ mẫu */
  percentile: number | null;
}

export interface RefitReport {
  newlyLabeled: number;
  totalLabeled: number;
  baseRate: number;
  upRateGivenMove: number;
  perModel: Array<{ model: string; n: number; brier: number; fitted: boolean }>;
}

/**
 * Tầng hiệu chuẩn — nơi điểm thô của LLM biến thành xác suất thật.
 *
 * Ba chế độ, tự động chuyển khi dữ liệu tích lũy đủ:
 *
 *   1. Lạnh   (0 nhãn)          : prior = base rate, điểm thô chỉ dịch chuyển log-odds.
 *   2. Ấm     (>= 40 điểm thô)  : chuẩn hóa phân vị theo từng model rồi mới áp prior.
 *   3. Nóng   (>= 30 nhãn/model): isotonic regression fit trên nhãn thật.
 *
 * Ở cả ba chế độ, con số trả về đều tôn trọng base rate. Đây là thứ chấm dứt tình
 * trạng mọi bài đều được 40-70%.
 */
@Injectable()
export class CalibrationService implements OnModuleInit {
  private readonly logger = new Logger(CalibrationService.name);
  private readonly stateFile = path.join(process.cwd(), 'data', 'calibration.json');
  private readonly quantile = new QuantileNormalizer(200);

  private state: CalibrationState = {
    version: '1.0',
    updatedAt: new Date().toISOString(),
    baseRate: BOOTSTRAP_BASE_RATE,
    upRateGivenMove: BOOTSTRAP_UP_RATE,
    labeledPosts: 0,
    quantile: [],
    isotonic: {},
    brierByModel: {},
    history: [],
  };

  onModuleInit(): void {
    this.load();
  }

  getBaseRate(): number {
    return this.state.baseRate;
  }

  getUpRateGivenMove(): number {
    return this.state.upRateGivenMove;
  }

  /** Brier gần nhất của model; undefined khi chưa chấm được. Dùng làm trọng số ensemble. */
  getBrier(model: string): number | undefined {
    return this.state.brierByModel[model];
  }

  /**
   * Biến điểm thô của một model thành xác suất.
   *
   * Ưu tiên isotonic (đã học từ nhãn thật). Nếu chưa đủ nhãn, lui về phân vị theo
   * model rồi hợp nhất Bayes với base rate — điểm thô đóng vai trò bằng chứng
   * (likelihood ratio), không phải posterior.
   */
  calibrate(model: string, rawScore: number): CalibratedScore {
    const percentile = this.quantile.percentile(model, rawScore);

    const iso = this.state.isotonic[model];
    if (iso && iso.n >= MIN_FIT_SAMPLES) {
      return { pMove: clamp(applyIsotonic(iso, rawScore), 0, P_MOVE_CAP), calibrated: true, percentile };
    }

    // Chưa đủ nhãn → dùng base rate làm prior, điểm thô làm bằng chứng.
    // Khi có phân vị, dùng phân vị (đã khử bias thang đo của model) thay cho điểm thô.
    const x = percentile ?? rawScore;
    const pivot = percentile !== null ? 0.5 : 0.35;

    const base = this.state.baseRate;
    const priorOdds = base / Math.max(1e-6, 1 - base);
    const lr = Math.exp(EVIDENCE_SLOPE * (x - pivot));
    const posteriorOdds = priorOdds * lr;

    return {
      pMove: clamp(posteriorOdds / (1 + posteriorOdds), 0, P_MOVE_CAP),
      calibrated: false,
      percentile,
    };
  }

  /**
   * Hướng, có điều kiện trên việc đã có biến động.
   * Co về tần suất nền khi số mẫu `moved` còn ít — với 5 quan sát thì phiếu của
   * model không đáng tin hơn tần suất lịch sử là bao.
   */
  calibrateUp(rawUp: number): number {
    const movedCount = this.state.history.filter(h => h.moved === true).length;
    const w = movedCount;
    const prior = this.state.upRateGivenMove;
    return (w * rawUp + UP_SHRINK_K * prior) / (w + UP_SHRINK_K);
  }

  /** Ghi nhận một dự đoán để chấm điểm về sau. Cũng nuôi bộ đệm phân vị của model. */
  record(rec: PredictionRecord): void {
    this.quantile.push(rec.model, rec.rawScore);
    this.state.history.push(rec);
    if (this.state.history.length > MAX_HISTORY) {
      this.state.history = this.state.history.slice(-MAX_HISTORY);
    }
    this.persist();
  }

  /**
   * Vòng lặp đóng: lấy giá thật từ Binance cho các dự đoán đã quá 1 giờ, gắn nhãn,
   * rồi fit lại đường hiệu chuẩn của từng model và cập nhật base rate.
   */
  async refit(): Promise<RefitReport> {
    const pending = this.state.history.filter(h => h.moved === undefined && h.t0 + HOUR_MS < Date.now());

    let newlyLabeled = 0;
    if (pending.length) {
      const byPost = new Map<string, PredictionRecord[]>();
      for (const p of pending) {
        const arr = byPost.get(p.postId) ?? [];
        arr.push(p);
        byPost.set(p.postId, arr);
      }

      const t0s = [...byPost.values()].map(v => v[0].t0);
      const history = new BinanceHistory('BTCUSDT', path.join(process.cwd(), 'data', 'klines'), m =>
        this.logger.debug(m),
      );
      await history.load(Math.min(...t0s) - (VOL_LOOKBACK_DAYS + 1) * DAY_MS, Math.max(...t0s) + 2 * HOUR_MS);

      const posts = [...byPost.keys()].map(id => ({
        id,
        createdAt: new Date(byPost.get(id)![0].t0).toISOString(),
      }));
      const { labels, unlabeled } = labelPosts(posts, history);

      const labelById = new Map(labels.map(l => [l.postId, l]));
      for (const [postId, recs] of byPost) {
        const l = labelById.get(postId);
        if (!l) continue;
        for (const r of recs) {
          r.moved = l.moved;
          r.up = l.up;
          r.z = l.z;
        }
        newlyLabeled++;
      }
      if (unlabeled.length) {
        this.logger.warn(`[REFIT] ${unlabeled.length} bài chưa gắn nhãn được (thiếu dữ liệu giá)`);
      }
    }

    const labeled = this.state.history.filter(h => h.moved !== undefined);

    // Base rate phải tính trên BÀI, không phải trên bản ghi (mỗi bài có nhiều model),
    // và phải khử cluster: các bài trong cùng một cửa sổ 1h chia sẻ đúng một kết quả.
    const postLevel = new Map<string, PredictionRecord>();
    for (const h of labeled) if (!postLevel.has(h.postId)) postLevel.set(h.postId, h);

    const asLabels: Label[] = [...postLevel.values()].map(h => ({
      postId: h.postId,
      t0: h.t0,
      p0: 0,
      p1h: 0,
      r1h: 0,
      sigma: 1,
      z: h.z ?? 0,
      moved: h.moved!,
      up: h.up!,
      clusterId: 0,
    }));
    // clusterId chưa gán ở trên → gán lại theo thời gian
    asLabels.sort((a, b) => a.t0 - b.t0);
    let cluster = 0;
    asLabels.forEach((l, i) => {
      if (i > 0 && l.t0 - asLabels[i - 1].t0 >= HOUR_MS) cluster++;
      l.clusterId = cluster;
    });
    const deduped = dedupeByCluster(asLabels);

    if (deduped.length >= 20) {
      const moved = deduped.filter(l => l.moved);
      this.state.baseRate = moved.length / deduped.length;
      this.state.upRateGivenMove = moved.length ? moved.filter(l => l.up).length / moved.length : BOOTSTRAP_UP_RATE;
      this.state.labeledPosts = deduped.length;
    }

    // Fit isotonic riêng cho từng model, chỉ trên bài đại diện của mỗi cluster
    const keepPostIds = new Set(deduped.map(l => l.postId));
    const perModel: RefitReport['perModel'] = [];
    const models = [...new Set(labeled.map(h => h.model))];

    for (const model of models) {
      const rows = labeled.filter(h => h.model === model && keepPostIds.has(h.postId));
      if (rows.length < MIN_FIT_SAMPLES) {
        perModel.push({ model, n: rows.length, brier: NaN, fitted: false });
        continue;
      }
      const iso = fitIsotonic(rows.map(r => r.rawScore), rows.map(r => r.moved!));
      this.state.isotonic[model] = iso;

      // Chấm Brier bằng chính đường vừa fit (in-sample — chỉ dùng để xếp trọng số
      // tương đối giữa các model, không phải để tuyên bố hiệu năng)
      const b = brier(rows.map(r => applyIsotonic(iso, r.rawScore)), rows.map(r => r.moved!));
      this.state.brierByModel[model] = b;
      perModel.push({ model, n: rows.length, brier: b, fitted: true });
    }

    this.persist();

    const report: RefitReport = {
      newlyLabeled,
      totalLabeled: deduped.length,
      baseRate: this.state.baseRate,
      upRateGivenMove: this.state.upRateGivenMove,
      perModel,
    };
    this.logger.log(
      `[REFIT] +${newlyLabeled} nhãn mới | tổng ${deduped.length} bài (đã khử cluster) | ` +
        `base rate=${(report.baseRate * 100).toFixed(1)}% | ` +
        `models đã fit: ${perModel.filter(p => p.fitted).length}/${perModel.length}`,
    );
    return report;
  }

  /** Tóm tắt trạng thái để hiển thị qua lệnh Telegram. */
  summary(): string {
    const s = this.state;
    const fitted = Object.entries(s.isotonic).filter(([, m]) => m.n >= MIN_FIT_SAMPLES);
    const lines = [
      `Base rate: ${(s.baseRate * 100).toFixed(1)}%  (P(|z| >= ${Z_THRESHOLD}) trong 1h)`,
      `P(up | moved): ${(s.upRateGivenMove * 100).toFixed(1)}%`,
      `Bài đã có nhãn: ${s.labeledPosts}`,
      `Bản ghi dự đoán: ${s.history.length}`,
      `Model đã hiệu chuẩn: ${fitted.length ? fitted.map(([m, i]) => `${m} (n=${i.n})`).join(', ') : 'chưa có'}`,
    ];
    return lines.join('\n');
  }

  private load(): void {
    if (!fs.existsSync(this.stateFile)) {
      this.logger.log(
        `[CALIB] Chưa có ${this.stateFile}. Khởi động lạnh: base rate = ${(BOOTSTRAP_BASE_RATE * 100).toFixed(1)}%`,
      );
      return;
    }
    try {
      const loaded = JSON.parse(fs.readFileSync(this.stateFile, 'utf-8')) as CalibrationState;
      this.state = { ...this.state, ...loaded };
      this.quantile.restore(this.state.quantile ?? []);
      this.logger.log(
        `[CALIB] Đã nạp: base rate=${(this.state.baseRate * 100).toFixed(1)}% | ` +
          `${this.state.history.length} bản ghi | ${Object.keys(this.state.isotonic).length} model có đường hiệu chuẩn`,
      );
    } catch (err) {
      this.logger.error(`[CALIB] Lỗi đọc ${this.stateFile}, dùng trạng thái mặc định: ${(err as Error).message}`);
    }
  }

  private persist(): void {
    this.state.updatedAt = new Date().toISOString();
    this.state.quantile = this.quantile.snapshot();
    try {
      fs.writeFileSync(this.stateFile, JSON.stringify(this.state, null, 2), 'utf-8');
    } catch (err) {
      this.logger.error(`[CALIB] Lỗi ghi ${this.stateFile}: ${(err as Error).message}`);
    }
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
