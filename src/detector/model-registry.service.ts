import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Sổ đăng ký model free của OpenRouter — tự cập nhật, tự kiểm tra sức khỏe.
 *
 * Vấn đề nó giải quyết: danh sách model free của OpenRouter biến động liên tục
 * (model bị rút khỏi free tier, provider 429 triền miên, model mới xuất hiện).
 * Đo thực tế 2026-07-14: pool hardcode cũ chết 4/5 model — gpt-oss-120b không
 * còn free, nemotron-vl timeout 122 giây, llama/qwen 429.
 *
 * Cơ chế: mỗi 6 giờ (và khi khởi động nếu dữ liệu cũ >12h hoặc không đủ ngưỡng):
 *   1. GET /api/v1/models → lọc model free thuần text-output, context ≥16k,
 *      loại meta-router / moderation / audio (EXCLUDE)
 *   2. PROBE từng ứng viên theo LÔ NHỎ, có nghỉ giữa các lô, có retry-1-lần
 *      khi gặp 429 (OpenRouter giới hạn request/phút CHUNG CHO CẢ TÀI KHOẢN
 *      trên model free — bắn cả danh sách đồng thời gây bùng nổ 429 giả, đo
 *      thực tế: 18/19 model "chết" oan trong một đợt probe không giãn cách)
 *   3. Sắp theo độ trễ, persist xuống data/free-models.json (sống sót qua restart)
 *
 * Checklist lấy top-5 theo độ trễ với trần 3 model/nhà cung cấp (đa dạng phiếu
 * bầu). Khi sổ trống HOẶC dưới MIN_VIABLE_MODELS → lui về SEED đã xác minh tay
 * — không bao giờ để checklist chạy với số model ít hơn ngưỡng đồng thuận.
 */

export interface RegisteredModel {
  id: string;
  latencyMs: number;
  probedAt: string;
}

interface RegistryFile {
  updatedAt: string;
  models: RegisteredModel[];
}

/**
 * Danh sách dự phòng — đã probe thành công thủ công ngày 2026-07-14.
 * Chỉ dùng khi sổ đăng ký trống; sẽ tự bị thay bằng kết quả probe mới nhất.
 */
export const SEED_MODELS = [
  'nvidia/nemotron-3-super-120b-a12b:free',
  'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  'openai/gpt-oss-20b:free',
  'google/gemma-4-26b-a4b-it:free',
];

/** Meta-router, moderation, model sinh audio — không dùng làm phiếu phân loại. */
const EXCLUDE = /content-safety|lyria|guard|^openrouter\//i;

/** Số model tối đa cho checklist. */
const CHECKLIST_SIZE = 5;
/** Trần model cùng một nhà cung cấp trong checklist — giữ tính đa dạng phiếu. */
const MAX_PER_PROVIDER = 3;

const PROBE_TIMEOUT_MS = 45_000;
const PROBE_MAX_TOKENS = 120;
/** Trần probe/ngày — độc lập với bộ đếm 500 của detector (probe rất rẻ, tự giới hạn). */
const PROBE_BUDGET_PER_DAY = 200;
/** Dữ liệu cũ hơn ngưỡng này khi khởi động → refresh ngay. */
const STALE_MS = 12 * 3_600_000;

/**
 * Số model sống tối thiểu để CHẤP NHẬN kết quả probe mới.
 *
 * Bắt buộc vì MIN_CONSENSUS (bên detector.service.ts) = 2: nếu registry ghi
 * đè bằng danh sách chỉ 1 model, tầng checklist trở thành CẤU TRÚC KHÔNG THỂ
 * đạt đồng thuận — tệ hơn hẳn không có registry (trước đây luôn thử 5 model
 * cố định). Đo thực tế trên server 2026-07-14: gọi 19 probe đồng thời gây bùng
 * nổ 429 (thundering herd trên free tier dùng chung), chỉ 1/19 sống sót dù
 * cùng thời điểm máy khác probe tuần tự thấy 11/19 sống. Ngưỡng này + probe
 * theo lô (xem BATCH_SIZE) là hai lớp phòng thủ cho đúng một sự cố.
 */
const MIN_VIABLE_MODELS = 3;

/** Số probe chạy đồng thời mỗi lô — giảm bùng nổ 429 khi probe cả danh sách. */
const PROBE_BATCH_SIZE = 3;
/** Nghỉ giữa các lô probe. */
const PROBE_BATCH_DELAY_MS = 4000;
/** Backoff khi một probe gặp 429 — thử lại đúng 1 lần. */
const PROBE_RETRY_DELAY_MS = 5000;

@Injectable()
export class ModelRegistryService implements OnModuleInit {
  private readonly logger = new Logger(ModelRegistryService.name);
  private readonly registryFile = path.join(process.cwd(), 'data', 'free-models.json');
  private readonly apiKey: string;

  private models: RegisteredModel[] = [];
  private updatedAt: Date | null = null;
  private refreshing = false;

  private probesToday = 0;
  private probeDate = '';

  constructor(configService: ConfigService) {
    this.apiKey = configService.get<string>('OPENROUTER_API_KEY') || '';
  }

  onModuleInit(): void {
    this.load();
    // Refresh ngay khi: chưa từng probe, dữ liệu cũ >12h, HOẶC danh sách đã nạp
    // không đủ ngưỡng đồng thuận (vd. file cũ bị ghi bởi một lần probe hỏng —
    // "còn mới" theo thời gian nhưng vô dụng về số lượng). Không kiểm tra số
    // lượng ở đây thì hệ thống có thể kẹt ở 1 model tới 6 giờ.
    const stale = !this.updatedAt || Date.now() - this.updatedAt.getTime() > STALE_MS;
    const tooFew = this.models.length > 0 && this.models.length < MIN_VIABLE_MODELS;
    if (stale || tooFew) {
      if (tooFew) {
        this.logger.warn(`[REGISTRY] Danh sách đã nạp chỉ có ${this.models.length} model (< ${MIN_VIABLE_MODELS}) — refresh ngay`);
      }
      // Chạy nền — không chặn app khởi động; trước khi xong dùng SEED (nếu tooFew, getChecklistModels() cũng lui về SEED)
      void this.refresh().catch(err =>
        this.logger.error(`Refresh model registry lúc khởi động lỗi: ${err instanceof Error ? err.message : String(err)}`),
      );
    }
  }

  /** Cron: làm mới sổ đăng ký mỗi 6 giờ. */
  @Cron(CronExpression.EVERY_6_HOURS)
  async scheduledRefresh(): Promise<void> {
    try {
      await this.refresh();
    } catch (err) {
      this.logger.error(`Refresh model registry định kỳ lỗi: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Danh sách model cho checklist: top theo độ trễ, trần 3/nhà cung cấp.
   * Sổ trống HOẶC chưa đủ ngưỡng đồng thuận (§MIN_VIABLE_MODELS) → SEED.
   */
  getChecklistModels(): string[] {
    if (this.models.length < MIN_VIABLE_MODELS) return SEED_MODELS;

    const picked: string[] = [];
    const perProvider = new Map<string, number>();
    for (const m of this.models) {
      if (picked.length >= CHECKLIST_SIZE) break;
      const provider = m.id.split('/')[0];
      const count = perProvider.get(provider) ?? 0;
      if (count >= MAX_PER_PROVIDER) continue;
      perProvider.set(provider, count + 1);
      picked.push(m.id);
    }
    return picked.length ? picked : SEED_MODELS;
  }

  /** Trạng thái để hiển thị qua lệnh /models. */
  status(): { updatedAt: Date | null; alive: RegisteredModel[]; active: string[]; usingSeed: boolean } {
    return {
      updatedAt: this.updatedAt,
      alive: [...this.models],
      active: this.getChecklistModels(),
      usingSeed: this.models.length < MIN_VIABLE_MODELS,
    };
  }

  /** Fetch danh sách free + probe từng ứng viên. Idempotent, chống chạy chồng. */
  async refresh(): Promise<void> {
    if (this.refreshing) {
      this.logger.debug('Registry đang refresh, bỏ qua yêu cầu trùng');
      return;
    }
    if (!this.apiKey) {
      this.logger.warn('Không có OPENROUTER_API_KEY — không probe được, giữ danh sách hiện tại');
      return;
    }
    this.refreshing = true;
    try {
      const candidates = await this.fetchFreeCandidates();
      this.logger.log(`[REGISTRY] ${candidates.length} ứng viên free sau lọc — bắt đầu probe theo lô ${PROBE_BATCH_SIZE}...`);

      const alive: RegisteredModel[] = [];
      for (let i = 0; i < candidates.length; i += PROBE_BATCH_SIZE) {
        const batch = candidates.slice(i, i + PROBE_BATCH_SIZE);
        const batchResults = await Promise.all(batch.map(id => this.probe(id)));
        for (const r of batchResults) if (r) alive.push(r);
        if (i + PROBE_BATCH_SIZE < candidates.length) {
          await new Promise(resolve => setTimeout(resolve, PROBE_BATCH_DELAY_MS));
        }
      }
      alive.sort((a, b) => a.latencyMs - b.latencyMs);

      if (alive.length < MIN_VIABLE_MODELS) {
        // Quá ít model sống — có thể free tier thật sự yếu, hoặc probe đồng
        // thời gây bùng nổ 429 (thấy trên server thật). Dù lý do gì, danh sách
        // cũ (hoặc SEED) vẫn an toàn hơn một danh sách không đủ cho đồng thuận.
        this.logger.warn(
          `[REGISTRY] Chỉ ${alive.length}/${candidates.length} model sống (< ngưỡng ${MIN_VIABLE_MODELS}) ` +
            `— giữ nguyên danh sách cũ để tránh phá đồng thuận`,
        );
        return;
      }

      this.models = alive;
      this.updatedAt = new Date();
      this.persist();
      this.logger.log(
        `[REGISTRY] ${alive.length}/${candidates.length} model sống. ` +
          `Checklist: ${this.getChecklistModels().map(m => m.split('/').pop()).join(', ')}`,
      );
    } finally {
      this.refreshing = false;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────

  private async fetchFreeCandidates(): Promise<string[]> {
    const res = await axios.get('https://openrouter.ai/api/v1/models', { timeout: 30_000 });
    return (res.data?.data ?? [])
      .filter(
        (m: any) =>
          m.pricing?.prompt === '0' &&
          m.pricing?.completion === '0' &&
          !EXCLUDE.test(m.id) &&
          String(m.architecture?.modality ?? '').endsWith('->text') &&
          (m.context_length ?? 0) >= 16_000,
      )
      .map((m: any) => String(m.id));
  }

  /**
   * Một call thật để xác nhận model đang phục vụ. Trả null nếu chết.
   *
   * 429 được thử lại đúng 1 lần sau backoff — trên OpenRouter, 429 của model
   * free thường là giới hạn request/phút CHUNG CHO CẢ TÀI KHOẢN (không phải
   * riêng model đó), nên "429 ở lần đầu" không có nghĩa model đã chết, chỉ có
   * nghĩa cần đợi. Đo thực tế trên server: đánh chết ngay ở 429 khiến 18/19
   * model bị loại oan trong một đợt probe. Các lỗi khác (404, timeout, JSON
   * rỗng) vẫn coi là chết ngay — retry không giúp được gì ở đó.
   */
  private async probe(model: string, isRetry = false): Promise<RegisteredModel | null> {
    const today = new Date().toLocaleDateString('sv-SE');
    if (this.probeDate !== today) {
      this.probeDate = today;
      this.probesToday = 0;
    }
    if (this.probesToday >= PROBE_BUDGET_PER_DAY) {
      this.logger.warn(`[REGISTRY] Đã chạm trần ${PROBE_BUDGET_PER_DAY} probe/ngày — bỏ qua ${model}`);
      return null;
    }
    this.probesToday++;

    const start = Date.now();
    try {
      const res = await axios.post(
        'https://openrouter.ai/api/v1/chat/completions',
        {
          model,
          messages: [{ role: 'user', content: 'Reply with exactly: {"ok":true}' }],
          max_tokens: PROBE_MAX_TOKENS,
          temperature: 0,
        },
        {
          headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
          timeout: PROBE_TIMEOUT_MS,
        },
      );
      if (res.data?.error && !res.data?.choices?.length) return null;
      const msg = res.data?.choices?.[0]?.message;
      const raw = (msg?.content || msg?.reasoning || '').trim();
      if (!raw) return null;
      return { id: model, latencyMs: Date.now() - start, probedAt: new Date().toISOString() };
    } catch (err: any) {
      if (err?.response?.status === 429 && !isRetry) {
        await new Promise(resolve => setTimeout(resolve, PROBE_RETRY_DELAY_MS));
        return this.probe(model, true);
      }
      return null;
    }
  }

  private load(): void {
    if (!fs.existsSync(this.registryFile)) {
      this.logger.log(`[REGISTRY] Chưa có ${this.registryFile} — dùng SEED (${SEED_MODELS.length} model) đến khi probe xong`);
      return;
    }
    try {
      const data = JSON.parse(fs.readFileSync(this.registryFile, 'utf-8')) as RegistryFile;
      this.models = data.models ?? [];
      this.updatedAt = data.updatedAt ? new Date(data.updatedAt) : null;
      this.logger.log(`[REGISTRY] Đã nạp ${this.models.length} model sống (cập nhật ${data.updatedAt})`);
    } catch (err) {
      this.logger.error(`[REGISTRY] Lỗi đọc ${this.registryFile}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private persist(): void {
    try {
      const dataDir = path.dirname(this.registryFile);
      if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
      const data: RegistryFile = { updatedAt: this.updatedAt!.toISOString(), models: this.models };
      fs.writeFileSync(this.registryFile, JSON.stringify(data, null, 2), 'utf-8');
    } catch (err) {
      this.logger.error(`[REGISTRY] Lỗi ghi ${this.registryFile}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
