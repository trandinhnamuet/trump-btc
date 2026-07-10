import { Injectable, Logger } from '@nestjs/common';
import { CalibrationService } from '../calibration/calibration.service';
import { MarketContextResult } from '../market-signal/market-signal.service';
import { extractJson, OpenRouterClient, OpenRouterError } from './openrouter.client';
import {
  buildAnalysisPrompt,
  ModelJudgment,
  parseJudgment,
  PROMPT_VERSION,
  rawScoreOf,
} from './prompt-v2';

/**
 * Ensemble đa model + self-consistency.
 *
 * Khác biệt căn bản so với v1: KHÔNG có fallback chain âm thầm đổi model. Mỗi
 * model trong ensemble được gọi độc lập; model nào chết thì bị bỏ khỏi lần chấm
 * này và bị ghi log. Con số cuối cùng luôn biết mình đến từ những model nào.
 *
 * Ở v1, fallback chain khiến bài A được nemotron chấm, bài B được llama chấm.
 * Ba thang đo khác nhau trộn vào cùng một chuỗi số rồi đem so với một ngưỡng cố
 * định. Backtest đo được thiệt hại này: AUC gộp tụt hẳn so với AUC từng model.
 */

const SYSTEM_PROMPT =
  'Bạn là chuyên gia phân tích thị trường Bitcoin. Bạn suy luận từ bản chất sự việc, ' +
  'không theo template. Bạn biết rằng phần lớn tin tức chính trị KHÔNG làm giá BTC ' +
  'biến động bất thường, và bạn không nhầm lẫn giữa "quan trọng về chính trị" với ' +
  '"làm dịch chuyển thị trường". Chỉ trả về JSON hợp lệ, không kèm văn bản nào khác.';

/**
 * Pool ứng viên cho ensemble, theo thứ tự ưu tiên. Ensemble lấy K model ĐẦU TIÊN
 * cho ra ít nhất một mẫu hợp lệ; model chết bị bỏ qua và thay bằng model kế tiếp.
 *
 * Lý do dùng pool thay vì danh sách cố định: free tier của OpenRouter biến động
 * mạnh — một model đang chạy có thể 429 hoặc 404 vài phút sau. Danh sách cố định
 * sẽ khiến ensemble lặng lẽ suy biến còn 1 model (đo được trong lần verify đầu:
 * owl-alpha 404, gpt-oss-120b 429, chỉ nemotron sống). Model thay thế vẫn được
 * ghi dưới ĐÚNG tên của nó, nên đường hiệu chuẩn theo từng model không bị lẫn.
 *
 * Thứ tự ưu tiên đa dạng nhà cung cấp/kiến trúc để ensemble thật sự có tính đa
 * dạng, không phải ba biến thể của cùng một họ model.
 */
export const ENSEMBLE_POOL = [
  'nvidia/nemotron-nano-12b-v2-vl:free', // vision, nhanh
  'openai/gpt-oss-20b:free',
  'nvidia/nemotron-3-super-120b-a12b:free', // lớn nhất, suy luận tốt
  'nvidia/nemotron-3-nano-30b-a3b:free',
  'openai/gpt-oss-120b:free',
  'meta-llama/llama-3.3-70b-instruct:free',
  'qwen/qwen3-next-80b-a3b-instruct:free',
  'google/gemma-4-31b-it:free', // vision
];

/** Giữ tên cũ cho tương thích: 3 model đầu pool là ensemble "danh nghĩa". */
export const ENSEMBLE_MODELS = ENSEMBLE_POOL.slice(0, 3);

/** Số model cần chấm thành công cho mỗi bài. */
const TARGET_MODELS = 3;

/**
 * Trần số model được thử trước khi bỏ cuộc. Khi cả free tier đang sập (đo được:
 * mọi provider trả lỗi tức thì), duyệt hết pool chỉ tổ đốt call vô ích. Dừng sớm
 * sau ngần này model liên tiếp thất bại và chấp nhận chấm bằng ít model hơn.
 */
const MAX_MODEL_ATTEMPTS = 5;

/** Số mẫu mỗi model. Độ tán xạ giữa các mẫu chính là độ bất định nội tại của model. */
const SAMPLES_PER_MODEL = 3;

/**
 * Nhiệt độ > 0 là bắt buộc cho self-consistency. Ở v1, temperature=0.1 làm giảm
 * variance nhưng khóa chặt bias — nhất quán không phải là chính xác, nó chỉ khiến
 * model sai một cách ổn định hơn.
 */
const TEMPERATURE = 0.6;

/** Đủ cho reasoning + summary tiếng Việt + mảng so sánh neo, kể cả với model dài dòng. */
const MAX_TOKENS = 1200;

/** Nâng token rồi thử lại đúng model đó khi bị cắt — không đổi sang model khác. */
const MAX_TOKENS_RETRY = 2000;

export interface PerModelScore {
  model: string;
  /** số mẫu thành công / tổng số mẫu đã thử */
  okSamples: number;
  totalSamples: number;
  /** trung vị điểm thô qua các mẫu */
  rawScore: number;
  /** độ tán xạ giữa các mẫu — độ bất định nội tại của model */
  spread: number;
  /** xác suất sau khi áp đường hiệu chuẩn của chính model này */
  pMove: number;
  calibrated: boolean;
  percentile: number | null;
  /** phiếu hướng [0,1]; 1 = chắc chắn tăng */
  rawUp: number;
  /** phán đoán của mẫu đại diện (trung vị), dùng để hiển thị */
  judgment: ModelJudgment;
}

export interface EnsembleResult {
  promptVersion: string;
  /** xác suất biến động bất thường, đã hiệu chuẩn, [0,1] */
  pMove: number;
  /** P(tăng | có biến động), đã co về tần suất nền, [0,1] */
  pUp: number;
  /** khoảng dao động của pMove giữa các model */
  pMoveLow: number;
  pMoveHigh: number;
  /** 1 = các model hoàn toàn đồng thuận, 0 = phân tán tối đa */
  agreement: number;
  /** true khi ÍT NHẤT một model dùng isotonic đã fit trên nhãn thật */
  calibrated: boolean;
  baseRate: number;
  perModel: PerModelScore[];
  /** phán đoán được chọn để hiển thị (model có trọng số cao nhất) */
  primary: ModelJudgment;
  primaryModel: string;
}

@Injectable()
export class EnsembleService {
  private readonly logger = new Logger(EnsembleService.name);

  constructor(private readonly calibration: CalibrationService) {}

  /**
   * Chấm một bài bằng toàn bộ ensemble.
   * @param countCall được gọi trước mỗi lần gọi API thực sự, để bên ngoài đếm rate limit.
   * @throws khi TẤT CẢ model đều thất bại.
   */
  async score(
    client: OpenRouterClient,
    content: string,
    market: MarketContextResult,
    severityScore: number,
    mediaUrls: string[] | undefined,
    countCall: () => void,
    visionCapable: (model: string) => boolean,
    models?: string[],
  ): Promise<EnsembleResult> {
    const baseRate = this.calibration.getBaseRate();
    const hasImages = (mediaUrls?.length ?? 0) > 0;
    const prompt = buildAnalysisPrompt(content, market, baseRate, hasImages);

    // Chế độ model đơn lẻ (qua /model) chỉ dùng đúng các model được truyền vào.
    // Chế độ ensemble: duyệt pool cho tới khi đủ TARGET_MODELS model cho ra kết quả.
    const isOverride = Array.isArray(models);
    const candidates = isOverride ? models! : ENSEMBLE_POOL;
    const target = isOverride ? candidates.length : TARGET_MODELS;

    const perModel: PerModelScore[] = [];
    let attempts = 0;

    for (const model of candidates) {
      if (perModel.length >= target) break;
      // Circuit breaker: chỉ áp cho chế độ ensemble (pool nhiều model), không áp cho override.
      if (!isOverride && attempts >= MAX_MODEL_ATTEMPTS) {
        this.logger.warn(
          `[ENSEMBLE] Đã thử ${attempts} model, mới có ${perModel.length}/${target} chạy được → dừng sớm để không đốt call khi free tier đang sập`,
        );
        break;
      }
      attempts++;

      const images = hasImages && visionCapable(model) ? mediaUrls : undefined;
      const judgments = await this.sampleModel(client, model, prompt, images, countCall);

      if (!judgments.length) {
        this.logger.warn(
          `[ENSEMBLE] ${model}: 0/${SAMPLES_PER_MODEL} mẫu thành công → bỏ qua, thử model kế tiếp trong pool`,
        );
        continue;
      }

      const raws = judgments.map(j => rawScoreOf(j, severityScore));
      const rawScore = median(raws);
      const spread = raws.length > 1 ? Math.max(...raws) - Math.min(...raws) : 0;

      const { pMove, calibrated, percentile } = this.calibration.calibrate(model, rawScore);
      const rawUp = directionVote(judgments);

      // Mẫu đại diện = mẫu có điểm thô gần trung vị nhất
      const primaryIdx = raws.reduce(
        (best, r, i) => (Math.abs(r - rawScore) < Math.abs(raws[best] - rawScore) ? i : best),
        0,
      );

      perModel.push({
        model,
        okSamples: judgments.length,
        totalSamples: SAMPLES_PER_MODEL,
        rawScore,
        spread,
        pMove,
        calibrated,
        percentile,
        rawUp,
        judgment: judgments[primaryIdx],
      });

      this.logger.log(
        `[ENSEMBLE] ${model}: raw=${rawScore.toFixed(3)} spread=${spread.toFixed(3)} → ` +
          `pMove=${(pMove * 100).toFixed(1)}% ${calibrated ? '(isotonic)' : '(prior+bằng chứng)'} ` +
          `| ${judgments.length}/${SAMPLES_PER_MODEL} mẫu`,
      );
    }

    if (!perModel.length) {
      throw new Error(`Toàn bộ ${candidates.length} model trong ensemble đều thất bại.`);
    }

    return this.aggregate(perModel, baseRate);
  }

  /** Gọi một model N lần. Trả về các phán đoán parse được; mảng rỗng nếu hỏng hết. */
  private async sampleModel(
    client: OpenRouterClient,
    model: string,
    prompt: string,
    images: string[] | undefined,
    countCall: () => void,
  ): Promise<ModelJudgment[]> {
    const out: ModelJudgment[] = [];

    for (let i = 0; i < SAMPLES_PER_MODEL; i++) {
      let maxTokens = MAX_TOKENS;

      for (let attempt = 0; attempt < 2; attempt++) {
        countCall();
        try {
          const res = await client.chat({
            model,
            system: SYSTEM_PROMPT,
            user: prompt,
            images,
            temperature: TEMPERATURE,
            maxTokens,
          });

          const judgment = parseJudgment(extractJson(res.raw));
          if (!judgment) {
            this.logger.warn(
              `[ENSEMBLE] ${model} mẫu ${i + 1}: JSON không hợp lệ hoặc thiếu trường. ` +
                `Raw (${res.raw.length} ký tự): ${res.raw.substring(0, 160).replace(/\n/g, ' ')}`,
            );
            break; // JSON hỏng — thử lại cũng vậy, sang mẫu tiếp theo
          }
          out.push(judgment);
          break;
        } catch (err) {
          // Hết hạn mức ngày là lỗi của cả tiến trình, không phải của riêng model này.
          // Nuốt nó ở đây sẽ khiến ensemble lặng lẽ chấm bằng 0 model rồi ném ra một
          // thông báo sai lệch.
          if (err instanceof Error && err.name === 'DailyLimitExceededException') throw err;

          if (err instanceof OpenRouterError && err.kind === 'truncated' && attempt === 0) {
            // Bị cắt vì nói dài, không phải vì dở. Nâng token và thử lại CHÍNH model đó.
            this.logger.warn(`[ENSEMBLE] ${err.message} → thử lại với max_tokens=${MAX_TOKENS_RETRY}`);
            maxTokens = MAX_TOKENS_RETRY;
            continue;
          }
          const msg = err instanceof Error ? err.message : String(err);
          this.logger.warn(`[ENSEMBLE] ${model} mẫu ${i + 1} lỗi: ${msg}`);
          break;
        }
      }
    }

    return out;
  }

  /**
   * Gộp các model. Trọng số tỉ lệ nghịch với Brier score đã đo được — model chấm
   * dở tự động bị giảm ảnh hưởng. Model chưa có Brier nhận trọng số trung bình.
   */
  private aggregate(perModel: PerModelScore[], baseRate: number): EnsembleResult {
    const weights = perModel.map(p => {
      const b = this.calibration.getBrier(p.model);
      return b !== undefined && Number.isFinite(b) ? 1 / (b + 0.01) : NaN;
    });

    const known = weights.filter(Number.isFinite);
    const fallbackWeight = known.length ? known.reduce((a, w) => a + w, 0) / known.length : 1;
    const w = weights.map(x => (Number.isFinite(x) ? x : fallbackWeight));
    const wSum = w.reduce((a, v) => a + v, 0);

    const pMove = perModel.reduce((a, p, i) => a + p.pMove * w[i], 0) / wSum;
    const rawUp = perModel.reduce((a, p, i) => a + p.rawUp * w[i], 0) / wSum;
    const pUp = this.calibration.calibrateUp(rawUp);

    const pMoves = perModel.map(p => p.pMove);
    const pMoveLow = Math.min(...pMoves);
    const pMoveHigh = Math.max(...pMoves);

    // Đồng thuận: 1 khi mọi model cho cùng một con số; giảm dần theo độ phân tán,
    // chuẩn hóa theo chính pMove để 5 điểm phần trăm chênh lệch ở mức 60% không bị
    // coi là bất đồng nghiêm trọng như 5 điểm ở mức 5%.
    const scale = Math.max(0.05, pMove);
    const agreement = perModel.length > 1 ? Math.max(0, 1 - (pMoveHigh - pMoveLow) / (2 * scale)) : 1;

    const bestIdx = w.indexOf(Math.max(...w));

    return {
      promptVersion: PROMPT_VERSION,
      pMove,
      pUp,
      pMoveLow,
      pMoveHigh,
      agreement,
      calibrated: perModel.some(p => p.calibrated),
      baseRate,
      perModel,
      primary: perModel[bestIdx].judgment,
      primaryModel: perModel[bestIdx].model,
    };
  }
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Phiếu hướng gộp qua các mẫu của cùng một model, [0,1].
 * `neutral` đóng góp đúng 0.5 — nó là thông tin thật ("tôi không biết"), không
 * phải dữ liệu thiếu. Ở v1, schema JSON cấm neutral nên model buộc phải chọn phe
 * kể cả khi đó là tung đồng xu, sinh ra tín hiệu hướng giả.
 */
function directionVote(judgments: ModelJudgment[]): number {
  const votes = judgments.map(j => {
    if (j.direction === 'neutral') return 0.5;
    const conf = j.directionConfidence; // [0.5, 1]
    return j.direction === 'increase' ? conf : 1 - conf;
  });
  return votes.reduce((a, v) => a + v, 0) / votes.length;
}
