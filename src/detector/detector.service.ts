import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { DetectionResult } from '../common/interfaces';
import { gate } from './gate';
import { extractJson, OpenRouterClient } from './openrouter.client';
import { assessNovelty, jaccard, REPEAT_THRESHOLD, tokenize, topSimilar } from './novelty';
import { EVENT_CLASSES, EventClass, runTripwires } from './taxonomy';

/**
 * Máy phát hiện sự kiện lớp A — trái tim duy nhất của hệ thống.
 *
 * Nhiệm vụ: phát hiện ~0.1% bài đăng gần như chắc chắn gây biến động mạnh giá
 * BTC (lập crypto reserve, thuế toàn cầu, không kích...). Đây là bài PHÂN LOẠI
 * vào danh sách đóng — không phải ước lượng xác suất.
 *
 * Vì sao không có kênh chấm điểm %: đã thử (v2) và đo được rằng free model
 * gần như không xếp hạng được các bài vùng giữa (AUC 0.529 ≈ ngẫu nhiên trên
 * 502 bài), và tầng hiệu chuẩn chỉ sửa được thang đo chứ không tạo ra tín hiệu.
 * Với mục đích thật của hệ thống — bắt các sự kiện lớn hiếm — phân loại thuần
 * chính xác hơn, nhanh hơn và rẻ hơn. Xem SCORING.md.
 *
 * Luồng: gate → novelty → tripwire (0ms, 0 call) → nếu tripwire im lặng:
 * LLM checklist (5 model song song, đồng thuận ≥2) → dedup → ALERT.
 *
 * Triết lý: recall tuyệt đối. Sự kiện thật ~1 lần/quý; vài báo giả/tháng là
 * rẻ; miss một sự kiện thật là mất toàn bộ lý do tồn tại của hệ thống.
 */

interface ChecklistVote {
  model: string;
  eventClass: EventClass | 'NONE';
  confirmed: boolean;
  newAction: boolean;
  reasoning: string;
}

/**
 * Model free của OpenRouter dùng cho checklist, theo thứ tự ưu tiên.
 * Gọi song song tất cả — model chết bị loại êm, cần ≥2 phiếu hợp lệ đồng thuận.
 */
const CHECKLIST_MODELS = [
  'nvidia/nemotron-nano-12b-v2-vl:free',
  'openai/gpt-oss-20b:free',
  'nvidia/nemotron-3-super-120b-a12b:free',
  'nvidia/nemotron-3-nano-30b-a3b:free',
  'openai/gpt-oss-120b:free',
];

/** Số phiếu tối thiểu đồng thuận (cùng lớp + confirmed + newAction) để alert. */
const MIN_CONSENSUS = 2;

/** Nhiệt độ thấp — phân loại cần ổn định, không cần đa dạng. */
const CHECKLIST_TEMPERATURE = 0.2;

const CHECKLIST_MAX_TOKENS = 700;
const CHECKLIST_TIMEOUT_MS = 40_000;

/** Cửa sổ khử trùng lặp alert cùng lớp. */
const DEDUP_WINDOW_MS = 24 * 3_600_000;
/** Trong cửa sổ dedup, chỉ chặn khi nội dung đủ giống lần alert trước. */
const DEDUP_SIMILARITY = 0.35;

export interface DetectOptions {
  /** true = bỏ kiểm tra dedup (dùng cho eval và lệnh /detect thủ công) */
  skipDedup?: boolean;
  /** true = chỉ chạy tripwire + novelty, không gọi LLM (eval nhanh, 0 call) */
  rulesOnly?: boolean;
}

@Injectable()
export class DetectorService {
  private readonly logger = new Logger(DetectorService.name);
  private readonly client: OpenRouterClient;
  private readonly apiKey: string;

  /** Giới hạn API call/ngày (phòng ngừa), reset lúc 0:00 giờ server. */
  private readonly DAILY_LIMIT = 500;
  private dailyCallCount = 0;
  private dailyCallDate = '';
  /** true = đã vượt hạn mức và chưa ai lấy cờ cảnh báo (gửi Telegram 1 lần/ngày) */
  private pendingLimitAlert = false;

  /**
   * Alert gần nhất theo lớp — chống bắn lặp khi Trump đăng follow-up trong ngày.
   * In-memory: restart xoá trạng thái, tệ nhất là một alert trùng sau restart —
   * chấp nhận được với triết lý recall-first.
   */
  private lastAlerts = new Map<EventClass, { tokens: Set<string>; at: number }>();

  constructor(configService: ConfigService) {
    this.apiKey = configService.get<string>('OPENROUTER_API_KEY') || '';
    if (!this.apiKey) this.logger.warn('OPENROUTER_API_KEY chưa được cấu hình trong .env!');
    this.client = new OpenRouterClient(this.apiKey);
    this.logger.log(
      `[CONFIG] Detector | checklist pool: ${CHECKLIST_MODELS.length} model | ` +
        `đồng thuận ≥${MIN_CONSENSUS} | daily limit ${this.DAILY_LIMIT} calls/day`,
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Rate limit (bộ đếm duy nhất của toàn hệ thống — detector là nơi duy nhất gọi LLM)
  // ─────────────────────────────────────────────────────────────────────────

  /** Tăng bộ đếm ngày; throws khi vượt hạn mức. Tự reset khi sang ngày mới. */
  private checkDailyLimit(): void {
    const today = new Date().toLocaleDateString('sv-SE');
    if (this.dailyCallDate !== today) {
      if (this.dailyCallCount > 0) {
        this.logger.log(`[DAILY RESET] Sang ngày ${today}. Calls ngày qua: ${this.dailyCallCount}/${this.DAILY_LIMIT}`);
      }
      this.dailyCallDate = today;
      this.dailyCallCount = 0;
    }

    this.dailyCallCount++;
    if (this.dailyCallCount > this.DAILY_LIMIT) {
      // Chỉ giương cờ cảnh báo đúng một lần cho lần vượt đầu tiên trong ngày
      if (this.dailyCallCount === this.DAILY_LIMIT + 1) this.pendingLimitAlert = true;
      throw new Error(`Đã đạt giới hạn ${this.DAILY_LIMIT} API calls/ngày (call #${this.dailyCallCount}).`);
    }
  }

  getDailyCallStats(): { count: number; limit: number; date: string } {
    return { count: this.dailyCallCount, limit: this.DAILY_LIMIT, date: this.dailyCallDate };
  }

  /**
   * Trả về true ĐÚNG MỘT LẦN khi hạn mức ngày vừa bị vượt — bên gọi dùng để
   * gửi cảnh báo Telegram một lần/ngày rồi thôi.
   */
  consumeLimitAlert(): boolean {
    if (!this.pendingLimitAlert) return false;
    this.pendingLimitAlert = false;
    return true;
  }

  /** Kiểm tra API key OpenRouter + thống kê call — cho lệnh /credit. */
  async getRemainingCredits(): Promise<string> {
    const stats = this.getDailyCallStats();
    const statsStr = `Daily calls hôm nay (${stats.date || 'chưa có call nào'}): ${stats.count}/${stats.limit}`;
    if (!this.apiKey) return `OPENROUTER_API_KEY chưa được cấu hình. Thêm vào .env và restart app.`;

    try {
      const resp = await axios.get('https://openrouter.ai/api/v1/auth/key', {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        timeout: 7000,
      });
      const d = resp.data?.data;
      if (d) {
        const credits = d.usage != null ? ` | Credit đã dùng: $${Number(d.usage).toFixed(4)}` : '';
        return `OpenRouter key hợp lệ ✅ | ${statsStr}${credits}`;
      }
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === 401) return `OpenRouter API key không hợp lệ (HTTP 401) | ${statsStr}`;
      return `Lỗi kiểm tra OpenRouter key: ${err instanceof Error ? err.message : String(err)} | ${statsStr}`;
    }
    return `OpenRouter key OK | ${statsStr}`;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Phát hiện
  // ─────────────────────────────────────────────────────────────────────────

  async detect(content: string, recentPosts: string[], opts: DetectOptions = {}): Promise<DetectionResult> {
    const base: DetectionResult = {
      alert: false,
      eventClass: null,
      eventClassName: null,
      source: null,
      matchedRules: [],
      novelty: 1,
      isRepeat: false,
      suppressedBy: null,
      votes: [],
    };

    const verdict = gate(content ?? '');
    if (!verdict.pass) return base;

    const { novelty, maxSimilarity } = assessNovelty(content, recentPosts);
    base.novelty = novelty;
    base.isRepeat = maxSimilarity >= REPEAT_THRESHOLD;

    // ── Tầng 1: tripwire — tức thì, 0 call ─────────────────────────────────
    const hits = runTripwires(content);
    if (hits.length) {
      base.matchedRules = hits.map(h => h.ruleId);
      const cls = hits[0].cls;
      base.eventClass = cls;
      base.eventClassName = EVENT_CLASSES[cls].vi;
      base.source = 'tripwire';

      if (base.isRepeat) {
        base.suppressedBy = 'repeat';
        this.logger.log(`[DETECTOR] Tripwire ${base.matchedRules.join(',')} khớp nhưng bài LẶP LẠI (sim=${maxSimilarity.toFixed(2)}) → không alert`);
        return base;
      }
      if (!opts.skipDedup && this.isDuplicateAlert(cls, content)) {
        base.suppressedBy = 'dedup';
        this.logger.log(`[DETECTOR] Tripwire khớp nhưng đã alert lớp ${cls} trong 24h với nội dung tương tự → không alert`);
        return base;
      }

      base.alert = true;
      if (!opts.skipDedup) this.rememberAlert(cls, content);
      this.logger.warn(`[DETECTOR] 🚨 TRIPWIRE ${base.matchedRules.join(',')} → ALERT lớp ${cls} (${EVENT_CLASSES[cls].vi})`);
      return base;
    }

    // ── Tầng 2: LLM checklist — chỉ khi tripwire im lặng ──────────────────
    if (opts.rulesOnly) return base;

    const votes = await this.runChecklist(content, recentPosts);
    base.votes = votes.map(v => ({
      model: v.model,
      eventClass: v.eventClass,
      confirmed: v.confirmed,
      newAction: v.newAction,
    }));

    // Đồng thuận: ≥2 phiếu CÙNG lớp, confirmed=true VÀ newAction=true.
    // newAction là hàng rào chống loại decoy khó nhất: bài ca ngợi một hành
    // động đã công bố tuần trước — model vẫn thấy "confirmed" nhưng không MỚI.
    const tally = new Map<EventClass, ChecklistVote[]>();
    for (const v of votes) {
      if (v.eventClass === 'NONE' || !v.confirmed || !v.newAction) continue;
      const arr = tally.get(v.eventClass) ?? [];
      arr.push(v);
      tally.set(v.eventClass, arr);
    }

    let winner: EventClass | null = null;
    let winnerVotes: ChecklistVote[] = [];
    for (const [cls, arr] of tally) {
      if (arr.length > winnerVotes.length) {
        winner = cls;
        winnerVotes = arr;
      }
    }

    if (!winner || winnerVotes.length < MIN_CONSENSUS) {
      if (winner) {
        this.logger.log(`[DETECTOR] Lớp ${winner} chỉ có ${winnerVotes.length}/${MIN_CONSENSUS} phiếu hợp lệ (tổng ${votes.length} model trả lời) → không alert`);
      }
      return base;
    }

    base.eventClass = winner;
    base.eventClassName = EVENT_CLASSES[winner].vi;
    base.source = 'llm_consensus';
    base.reasoning = winnerVotes[0].reasoning;

    if (base.isRepeat) {
      base.suppressedBy = 'repeat';
      this.logger.log(`[DETECTOR] Đồng thuận lớp ${winner} nhưng bài LẶP LẠI (sim=${maxSimilarity.toFixed(2)}) → không alert`);
      return base;
    }
    if (!opts.skipDedup && this.isDuplicateAlert(winner, content)) {
      base.suppressedBy = 'dedup';
      return base;
    }

    base.alert = true;
    if (!opts.skipDedup) this.rememberAlert(winner, content);
    this.logger.warn(
      `[DETECTOR] 🚨 ĐỒNG THUẬN ${winnerVotes.length}/${votes.length} model → ALERT lớp ${winner} (${EVENT_CLASSES[winner].vi})`,
    );
    return base;
  }

  // ─────────────────────────────────────────────────────────────────────────

  /** Gọi checklist trên toàn bộ pool, song song, 1 call/model. */
  private async runChecklist(content: string, recentPosts: string[]): Promise<ChecklistVote[]> {
    const prompt = this.buildChecklistPrompt(content, recentPosts);

    const results = await Promise.all(
      CHECKLIST_MODELS.map(async model => {
        try {
          this.checkDailyLimit();
        } catch (err) {
          // Hết hạn mức ngày — detector không được phép sập; bỏ qua model này
          this.logger.warn(`[DETECTOR] Bỏ qua ${model}: ${err instanceof Error ? err.message : String(err)}`);
          return null;
        }
        try {
          const res = await this.client.chat({
            model,
            system:
              'Bạn là bộ phân loại sự kiện tài chính. Nhiệm vụ của bạn là PHÂN LOẠI, ' +
              'không phải dự đoán giá. Chỉ trả về JSON hợp lệ, không kèm văn bản nào khác.',
            user: prompt,
            temperature: CHECKLIST_TEMPERATURE,
            maxTokens: CHECKLIST_MAX_TOKENS,
            timeoutMs: CHECKLIST_TIMEOUT_MS,
          });
          const vote = this.parseVote(model, extractJson(res.raw));
          if (!vote) {
            this.logger.warn(`[DETECTOR] ${model}: JSON checklist không hợp lệ. Raw: ${res.raw.substring(0, 120).replace(/\n/g, ' ')}`);
          }
          return vote;
        } catch (err) {
          this.logger.warn(`[DETECTOR] ${model} lỗi: ${err instanceof Error ? err.message : String(err)}`);
          return null;
        }
      }),
    );

    return results.filter((v): v is ChecklistVote => v !== null);
  }

  private buildChecklistPrompt(content: string, recentPosts: string[]): string {
    const classList = (Object.entries(EVENT_CLASSES) as Array<[EventClass, { vi: string; prompt: string }]>)
      .map(([cls, info]) => `${cls} — ${info.vi}: ${info.prompt}`)
      .join('\n\n');

    // RAG-lite: đưa các bài gần đây GIỐNG NHẤT vào prompt để model tự thấy
    // bài mới có thực sự công bố điều gì mới không.
    const similar = topSimilar(content, recentPosts, 8);
    const contextSection = similar.length
      ? `# Các bài Trump đã đăng trong 7 ngày gần đây (giống bài mới nhất)\n\n` +
        similar.map((s, i) => `${i + 1}. "${s.text.substring(0, 200)}"`).join('\n') +
        `\n\nNếu bài mới chỉ nhắc lại/ca ngợi điều đã công bố trong các bài trên → newAction = false.\n\n`
      : '';

    return `# Nhiệm vụ

Phân loại bài đăng Truth Social dưới đây của Trump vào đúng MỘT lớp sự kiện, hoặc NONE.
Đây là bài toán PHÂN LOẠI — không phải dự đoán giá hay ước lượng xác suất.

# Bài đăng cần phân loại

"${content}"

${contextSection}# Các lớp sự kiện

${classList}

# Quy tắc nghiêm ngặt

- Gán lớp theo CHỦ ĐỀ nếu bài thuộc một trong các lớp trên; nếu không → NONE.
- "confirmed" = true CHỈ khi bài TUYÊN BỐ hành động đã thực hiện / đã ký / có hiệu lực
  (hoặc kèm mốc thời gian cụ thể). Quan điểm ("Powell nên giảm lãi suất"), lời dọa mơ hồ
  ("sẽ phải trả giá"), lời kêu gọi, bình luận về người khác → confirmed = false.
- "newAction" = true CHỈ khi bài công bố một hành động MỚI tại thời điểm đăng.
  Nhắc lại, ca ngợi, hay cập nhật về hành động ĐÃ công bố trước đó → newAction = false.
- Trump than phiền về Fed/lãi suất và khoe thành tích kinh tế GẦN NHƯ HÀNG TUẦN —
  những bài đó là NONE hoặc confirmed = false.

# Định dạng trả lời — chỉ JSON, suy luận trước, kết luận sau

{
  "reasoning": "1-2 câu tiếng Việt: bài tuyên bố gì, có phải hành động mới không",
  "eventClass": "A1" | "A2" | "A3" | "A4" | "A5" | "NONE",
  "confirmed": true | false,
  "newAction": true | false
}`;
  }

  private parseVote(model: string, parsed: any): ChecklistVote | null {
    if (!parsed || typeof parsed !== 'object') return null;
    const cls = String(parsed.eventClass ?? '').toUpperCase().trim();
    if (!['A1', 'A2', 'A3', 'A4', 'A5', 'NONE'].includes(cls)) return null;
    return {
      model,
      eventClass: cls as EventClass | 'NONE',
      confirmed: Boolean(parsed.confirmed),
      newAction: Boolean(parsed.newAction),
      reasoning: String(parsed.reasoning ?? ''),
    };
  }

  // ─────────────────────────────────────────────────────────────────────────

  private isDuplicateAlert(cls: EventClass, content: string): boolean {
    const prev = this.lastAlerts.get(cls);
    if (!prev) return false;
    if (Date.now() - prev.at > DEDUP_WINDOW_MS) return false;
    // Cùng lớp trong 24h nhưng nội dung khác hẳn (hai sự kiện thật khác nhau)
    // → vẫn cho alert. Chỉ chặn khi nội dung đủ giống lần trước.
    return jaccard(tokenize(content), prev.tokens) >= DEDUP_SIMILARITY;
  }

  private rememberAlert(cls: EventClass, content: string): void {
    this.lastAlerts.set(cls, { tokens: tokenize(content), at: Date.now() });
  }
}
