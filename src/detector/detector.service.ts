import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ENSEMBLE_POOL } from '../analysis/ensemble.service';
import { gate } from '../analysis/gate';
import { extractJson, OpenRouterClient } from '../analysis/openrouter.client';
import { DetectionResult } from '../common/interfaces';
import { assessNovelty, jaccard, REPEAT_THRESHOLD, tokenize, topSimilar } from './novelty';
import { EVENT_CLASSES, EventClass, runTripwires } from './taxonomy';

/**
 * Máy phát hiện sự kiện lớp A — kênh cảnh báo rời rạc, recall-first, chạy TRƯỚC
 * pipeline chấm điểm vì với sự kiện thật, từng phút đều có giá.
 *
 * Luồng: gate → novelty → tripwire (0ms, 0 call) → nếu chưa nổ: LLM checklist
 * (5 model song song, 1 call/model, cần ≥2 phiếu đồng thuận) → dedup → ALERT.
 *
 * Khác pipeline chấm điểm ở ba điểm cốt lõi:
 * 1. Hỏi model PHÂN LOẠI vào danh sách đóng (việc model yếu vẫn làm ổn),
 *    không hỏi xác suất (việc model yếu làm rất tồi — đo được AUC 0.53).
 * 2. Đầu ra là ALERT nhị phân, không phải con số % giả vờ đã hiệu chuẩn.
 * 3. Nghiêng hẳn về recall: sự kiện thật ~1 lần/quý, vài báo giả/tháng là rẻ;
 *    miss một sự kiện thật là mất toàn bộ lý do tồn tại của hệ thống.
 */

interface ChecklistVote {
  model: string;
  eventClass: EventClass | 'NONE';
  confirmed: boolean;
  newAction: boolean;
  reasoning: string;
}

/** Số model gọi song song cho checklist. */
const CHECKLIST_MODELS = 5;

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
  /** true = bỏ kiểm tra dedup (dùng cho eval, nơi các case cùng lớp chạy liên tiếp) */
  skipDedup?: boolean;
  /** true = chỉ chạy tripwire + novelty, không gọi LLM (eval nhanh, 0 call) */
  rulesOnly?: boolean;
}

@Injectable()
export class DetectorService {
  private readonly logger = new Logger(DetectorService.name);
  private readonly client: OpenRouterClient;

  /**
   * Alert gần nhất theo lớp — chống bắn lặp khi Trump đăng follow-up trong ngày.
   * In-memory: restart xoá trạng thái, tệ nhất là một alert trùng sau restart —
   * chấp nhận được với triết lý recall-first.
   */
  private lastAlerts = new Map<EventClass, { tokens: Set<string>; at: number }>();

  constructor(configService: ConfigService) {
    this.client = new OpenRouterClient(configService.get<string>('OPENROUTER_API_KEY') || '');
  }

  async detect(
    content: string,
    recentPosts: string[],
    countCall: () => void,
    opts: DetectOptions = {},
  ): Promise<DetectionResult> {
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

    const votes = await this.runChecklist(content, recentPosts, countCall);
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

  /** Gọi checklist trên CHECKLIST_MODELS model đầu pool, song song, 1 call/model. */
  private async runChecklist(
    content: string,
    recentPosts: string[],
    countCall: () => void,
  ): Promise<ChecklistVote[]> {
    const prompt = this.buildChecklistPrompt(content, recentPosts);
    const models = ENSEMBLE_POOL.slice(0, CHECKLIST_MODELS);

    const results = await Promise.all(
      models.map(async model => {
        try {
          countCall();
        } catch (err) {
          // Hết hạn mức ngày — detector không được phép làm sập luồng chính
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
