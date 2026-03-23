import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { AnalysisResult } from '../common/interfaces';
import { SeverityService } from '../severity/severity.service';
import { MarketSignalService } from '../market-signal/market-signal.service';

/**
 * AnalysisService: Phân tích bài viết Trump bằng Grok AI + Ensemble Scoring.
 *
 * Pipeline mới (3 tầng):
 * 1. Rule-based Severity (SeverityService) → severityScore + hardRule
 * 2. Grok AI (LLM) → modelProb + direction + reasoning
 * 3. Market Signal (MarketSignalService) → marketSignalScore
 *
 * Ensemble combiner:
 *   ensembleProb = 0.50 * modelProb + 0.35 * severity*100 + 0.15 * market*100
 *   → Nếu hardRule = true → override: ensembleProb = max(ensembleProb, MIN_HARD_PROB)
 *
 * Trọng số có thể cập nhật sau khi có dữ liệu backtest.
 */
@Injectable()
export class AnalysisService {
  private readonly logger = new Logger(AnalysisService.name);
  private readonly grokApiKey: string;
  private readonly grokApiUrl = 'https://api.x.ai/v1/chat/completions';

  // Trọng số ensemble (tổng = 1.0)
  private readonly W_MODEL    = 0.50;
  private readonly W_SEVERITY = 0.35;
  private readonly W_MARKET   = 0.15;

  constructor(
    private readonly configService: ConfigService,
    private readonly severityService: SeverityService,
    private readonly marketSignalService: MarketSignalService,
  ) {
    const apiKey = this.configService.get<string>('GROK_API_KEY');
    if (!apiKey) {
      this.logger.warn('GROK_API_KEY chưa được cấu hình trong .env!');
    }
    this.grokApiKey = apiKey || '';
  }

  /**
   * Phân tích một bài viết của Trump — pipeline hybrid 3 tầng.
   */
  async analyzePost(content: string): Promise<AnalysisResult> {
    this.logger.log(`Bắt đầu phân tích bài viết (len=${content.length})`);

    // Tầng 1 + 3 chạy song song với Tầng 2 để tiết kiệm thời gian
    const [severityResult, marketSignal, modelResult] = await Promise.all([
      Promise.resolve(this.severityService.evaluate(content)),
      this.marketSignalService.getMarketSignal(),
      this.callGrok(content),
    ]);

    // Ensemble combiner
    const rawEnsemble =
      this.W_MODEL    * modelResult.btcInfluenceProbability +
      this.W_SEVERITY * severityResult.severityScore * 100 +
      this.W_MARKET   * marketSignal.marketSignalScore * 100;

    let ensembleProbability = Math.round(Math.min(100, Math.max(0, rawEnsemble)));

    // Hard-rule override: nếu rule mạnh kích hoạt → ép probability tối thiểu
    if (severityResult.hardRule) {
      const minHard = this.severityService.getMinHardProb();
      if (ensembleProbability < minHard) {
        this.logger.warn(
          `Hard rule override: ensemble ${ensembleProbability}% → ${minHard}% (rules: ${severityResult.matchedRules.join(', ')})`,
        );
        ensembleProbability = minHard;
      }
    }

    // Hướng ưu tiên: hard rule direction > model direction
    const finalDirection = severityResult.hardRule
      ? severityResult.hardDirection
      : modelResult.btcDirection;

    const result: AnalysisResult = {
      ...modelResult,
      btcDirection: finalDirection,
      ensembleProbability,
      severityScore: severityResult.severityScore,
      marketSignalScore: marketSignal.marketSignalScore,
      hardRule: severityResult.hardRule,
      matchedRules: severityResult.matchedRules,
    };

    this.logger.log(
      `Phân tích xong: model=${modelResult.btcInfluenceProbability}% | ` +
      `severity=${(severityResult.severityScore * 100).toFixed(0)}% | ` +
      `market=${(marketSignal.marketSignalScore * 100).toFixed(0)}% | ` +
      `ensemble=${ensembleProbability}% (${finalDirection})` +
      (severityResult.hardRule ? ` ⚠️ HARD RULE` : ''),
    );

    return result;
  }

  /** Gọi Grok API và trả về kết quả model thuần. */
  private async callGrok(content: string): Promise<Omit<AnalysisResult, 'ensembleProbability' | 'severityScore' | 'marketSignalScore' | 'hardRule' | 'matchedRules'>> {
    const prompt = this.buildPrompt(content);
    this.logger.debug(`Prompt length: ${prompt.length}`);

    try {
      const response = await axios.post(
        this.grokApiUrl,
        {
          messages: [
            {
              role: 'system',
              content: `Bạn là chuyên gia phân tích tài chính cấp cao chuyên về Bitcoin (BTC) với hiểu biết sâu về mối quan hệ giữa sự kiện vĩ mô và biến động giá crypto.

KIẾN THỨC NỀN BẮT BUỘC ÁP DỤNG:

1. BẢN CHẤT KÉP CỦA BTC:
   - BTC là "risk asset": khi thị trường sợ hãi (risk-off), nhà đầu tư bán BTC cùng chứng khoán để giữ tiền mặt
   - BTC là "safe haven / digital gold": khi mất niềm tin vào tiền tệ fiat hoặc hệ thống ngân hàng, dòng tiền chạy vào BTC
   - PHÂN BIỆT: địa chính trị thông thường → risk-off → BTC giảm; khủng hoảng USD/ngân hàng/fiat → safe haven → BTC tăng

2. CÁC NHÂN TỐ MẠNH NHẤT TÁC ĐỘNG BTC:
   - Fed lãi suất / chính sách tiền tệ: tăng → thanh khoản rút → BTC giảm; cắt → bơm tiền → BTC tăng
   - USD (DXY index): USD mạnh → BTC giảm; USD yếu → BTC tăng (tương quan nghịch)
   - Quy định/thuế crypto trực tiếp: rất nhạy cảm, hướng rõ ràng theo nội dung
   - Chiến tranh thương mại / thuế quan: ảnh hưởng gián tiếp qua triển vọng tăng trưởng và USD
   - Giá dầu tăng đột biến → lạm phát → Fed hawkish → BTC giảm

3. TIỀN LỆ LỊCH SỬ QUAN TRỌNG:
   - Xung đột Ukraine 2022: BTC ban đầu giảm mạnh cùng cổ phiếu (risk-off), sau phục hồi nhanh
   - Căng thẳng Trung Đông thông thường: tác động BTC rất nhỏ, không ổn định
   - COVID crash 3/2020: BTC rơi -50% trong 2 ngày (risk-off tuyệt đối), sau tăng vọt do stimulus
   - SVB bank collapse 3/2023: BTC TĂNG (safe haven khi ngân hàng sụp đổ)
   - Announcement thuế Trump 4/2025: BTC giảm cùng cổ phiếu (global recession fear)

4. NGUYÊN TẮC ĐỌC HƯỚNG TÁC ĐỘNG:
   - Sự kiện làm suy yếu USD / tăng cung tiền / chống lại hệ thống tài chính truyền thống → BTC tăng
   - Sự kiện làm tăng lo ngại suy thoái / thắt chặt thanh khoản / giảm appetite rủi ro → BTC giảm
   - Sự kiện địa chính trị: đánh giá qua lăng kính "liệu có khiến Fed phải phản ứng không?" và "mức độ shock toàn cầu?"

CHỈ trả về JSON theo format yêu cầu. KHÔNG thêm bất kỳ text nào khác.`,
            },
            {
              role: 'user',
              content: prompt,
            },
          ],
          model: 'grok-3',
          temperature: 0.2,
          max_tokens: 900,
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.grokApiKey}`,
          },
        },
      );

      const messageContent = response.data?.choices?.[0]?.message?.content ?? '';
      if (!messageContent) throw new Error('Grok trả về response rỗng');

      let parsed: any = null;
      try {
        parsed = JSON.parse(messageContent);
      } catch (parseErr) {
        this.logger.error('Không thể parse JSON từ Grok. Raw:\n' + messageContent);
        throw parseErr;
      }

      return {
        summary: parsed.summary || 'Không thể tóm tắt',
        btcInfluenceProbability: Math.min(100, Math.max(0, Number(parsed.btcInfluenceProbability) || 0)),
        btcDirection: this.normalizeDirection(parsed.btcDirection),
        reasoning: parsed.reasoning || '',
      };
    } catch (error) {
      this.logger.error('Lỗi khi gọi Grok API:', error.message);
      throw error;
    }
  }

  private buildPrompt(content: string): string {
    return `Phân tích bài đăng sau của Donald Trump trên Truth Social và đánh giá tác động lên giá Bitcoin (BTC).

BÀI VIẾT:
"${content}"

---
THỰC HIỆN PHÂN TÍCH THEO 3 BƯỚC (thể hiện trong trường "reasoning"):

BƯỚC 1 - PHÂN LOẠI SỰ KIỆN:
Xác định bài viết thuộc loại nào và tại sao:
• Loại A – Crypto trực tiếp (70-100%): đề cập BTC/crypto, USD, Fed, lạm phát, quy định tài chính số, stablecoin
• Loại B – Kinh tế vĩ mô (40-70%): thuế quan, chiến tranh thương mại Mỹ-Trung, chính sách tài khóa lớn, dầu mỏ/năng lượng có thể gây lạm phát
• Loại C – Địa chính trị (15-50%): xung đột, căng thẳng quân sự — phải phân tích riêng: risk-off hay USD-crisis?
• Loại D – Không liên quan (0-15%): chính trị nội địa, xã hội, thể thao

BƯỚC 2 - CƠ CHẾ TÁC ĐỘNG (bắt buộc xét CẢ HAI chiều):
• Con đường BTC TĂNG: sự kiện này có thể dẫn đến BTC tăng qua cơ chế nào cụ thể?
• Con đường BTC GIẢM: sự kiện này có thể dẫn đến BTC giảm qua cơ chế nào cụ thể?
• Tiền lệ: có sự kiện tương tự nào trong lịch sử? BTC đã phản ứng thế nào?

BƯỚC 3 - KẾT LUẬN:
• So sánh sức nặng của hai chiều trên → xác định hướng TRỘI HƠN
• Xác định xác suất (0-100%) dựa trên mức độ liên quan thực sự tới thị trường tài chính/BTC
• Giải thích tại sao hướng này được chọn thay vì hướng kia

---
Trả về JSON (KHÔNG thêm text nào khác ngoài JSON):
{
  "summary": "Tóm tắt nội dung bài viết bằng tiếng Việt (2-3 câu)",
  "btcInfluenceProbability": <số nguyên 0-100>,
  "btcDirection": <"increase" | "decrease" | "neutral">,
  "reasoning": "Phân tích đầy đủ 3 bước: loại sự kiện → cơ chế tác động cụ thể cả hai chiều tăng/giảm có tiền lệ → kết luận rõ lý do chọn hướng này. Tối thiểu 5-6 câu, không được viết chung chung."
}`;
  }

  private normalizeDirection(direction?: string): 'increase' | 'decrease' | 'neutral' {
    const normalized = (direction || '').toLowerCase().trim();
    if (normalized === 'increase' || normalized === 'up') return 'increase';
    if (normalized === 'decrease' || normalized === 'down') return 'decrease';
    return 'neutral';
  }
}

 *
 * Prompt được thiết kế để:
 * 1. Tóm tắt nội dung bài viết
 * 2. Đánh giá % khả năng ảnh hưởng đến giá BTC
 * 3. Xác định hướng ảnh hưởng (tăng/giảm/trung lập)
 */
@Injectable()
export class AnalysisService {
  private readonly logger = new Logger(AnalysisService.name);
  private readonly grokApiKey: string;
  private readonly grokApiUrl = 'https://api.x.ai/v1/chat/completions';

  constructor(private readonly configService: ConfigService) {
    const apiKey = this.configService.get<string>('GROK_API_KEY');
    if (!apiKey) {
      this.logger.warn('GROK_API_KEY chưa được cấu hình trong .env!');
    }
    this.grokApiKey = apiKey || '';
  }

  /**
   * Phân tích một bài viết của Trump.
   * @param content Nội dung bài viết (đã strip HTML)
   * @returns Kết quả phân tích với xác suất ảnh hưởng BTC
   */
  async analyzePost(content: string): Promise<AnalysisResult> {
    const prompt = this.buildPrompt(content);

    try {
      this.logger.log(`Bắt đầu phân tích bài viết (len=${content.length})`);
      this.logger.debug(`Prompt length: ${prompt.length}`);

      const response = await axios.post(
        this.grokApiUrl,
        {
          messages: [
            {
              role: 'system',
              content: `Bạn là chuyên gia phân tích tài chính cấp cao chuyên về Bitcoin (BTC) với hiểu biết sâu về mối quan hệ giữa sự kiện vĩ mô và biến động giá crypto.

KIẾN THỨC NỀN BẮT BUỘC ÁP DỤNG:

1. BẢN CHẤT KÉP CỦA BTC:
   - BTC là "risk asset": khi thị trường sợ hãi (risk-off), nhà đầu tư bán BTC cùng chứng khoán để giữ tiền mặt
   - BTC là "safe haven / digital gold": khi mất niềm tin vào tiền tệ fiat hoặc hệ thống ngân hàng, dòng tiền chạy vào BTC
   - PHÂN BIỆT: địa chính trị thông thường → risk-off → BTC giảm; khủng hoảng USD/ngân hàng/fiat → safe haven → BTC tăng

2. CÁC NHÂN TỐ MẠNH NHẤT TÁC ĐỘNG BTC:
   - Fed lãi suất / chính sách tiền tệ: tăng → thanh khoản rút → BTC giảm; cắt → bơm tiền → BTC tăng
   - USD (DXY index): USD mạnh → BTC giảm; USD yếu → BTC tăng (tương quan nghịch)
   - Quy định/thuế crypto trực tiếp: rất nhạy cảm, hướng rõ ràng theo nội dung
   - Chiến tranh thương mại / thuế quan: ảnh hưởng gián tiếp qua triển vọng tăng trưởng và USD
   - Giá dầu tăng đột biến → lạm phát → Fed hawkish → BTC giảm

3. TIỀN LỆ LỊCH SỬ QUAN TRỌNG:
   - Xung đột Ukraine 2022: BTC ban đầu giảm mạnh cùng cổ phiếu (risk-off), sau phục hồi nhanh
   - Căng thẳng Trung Đông thông thường: tác động BTC rất nhỏ, không ổn định
   - COVID crash 3/2020: BTC rơi -50% trong 2 ngày (risk-off tuyệt đối), sau tăng vọt do stimulus
   - SVB bank collapse 3/2023: BTC TĂNG (safe haven khi ngân hàng sụp đổ)
   - Announcement thuế Trump 4/2025: BTC giảm cùng cổ phiếu (global recession fear)

4. NGUYÊN TẮC ĐỌC HƯỚNG TÁC ĐỘNG:
   - Sự kiện làm suy yếu USD / tăng cung tiền / chống lại hệ thống tài chính truyền thống → BTC tăng
   - Sự kiện làm tăng lo ngại suy thoái / thắt chặt thanh khoản / giảm appetite rủi ro → BTC giảm
   - Sự kiện địa chính trị: đánh giá qua lăng kính "liệu có khiến Fed phải phản ứng không?" và "mức độ shock toàn cầu?"

CHỈ trả về JSON theo format yêu cầu. KHÔNG thêm bất kỳ text nào khác.`,
            },
            {
              role: 'user',
              content: prompt,
            },
          ],
          model: 'grok-3',
          temperature: 0.2,
          max_tokens: 900,
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.grokApiKey}`,
          },
        },
      );

      const messageContent = response.data?.choices?.[0]?.message?.content ?? '';

      if (!messageContent) {
        this.logger.error('Grok trả về response rỗng');
        throw new Error('Grok trả về response rỗng');
      }

      // Parse JSON từ response (ghi log nội dung thô nếu parse lỗi để debug)
      let parsed: {
        summary?: string;
        btcInfluenceProbability?: number;
        btcDirection?: string;
        reasoning?: string;
      } | null = null;
      try {
        parsed = JSON.parse(messageContent) as any;
      } catch (parseErr) {
        this.logger.error('Không thể parse JSON từ Grok response. Raw content:');
        this.logger.error(messageContent);
        throw parseErr;
      }
      if (!parsed) {
        this.logger.error('Parsed object is null after JSON.parse');
        throw new Error('Parsed object null');
      }

      // Validate và normalize kết quả
      const result: AnalysisResult = {
        summary: parsed.summary || 'Không thể tóm tắt',
        btcInfluenceProbability: Math.min(100, Math.max(0, Number(parsed.btcInfluenceProbability) || 0)),
        btcDirection: this.normalizeDirection(parsed.btcDirection),
        reasoning: parsed.reasoning || '',
      };

      this.logger.log(`Phân tích xong: xác suất ảnh hưởng BTC = ${result.btcInfluenceProbability}% (${result.btcDirection})`);

      return result;
    } catch (error) {
      this.logger.error('Lỗi khi gọi Grok API:', error.message);
      throw error;
    }
  }

  /**
   * Xây dựng prompt phân tích.
   * Yêu cầu OpenAI trả về JSON với format cụ thể.
   */
  private buildPrompt(content: string): string {
    return `Phân tích bài đăng sau của Donald Trump trên Truth Social và đánh giá tác động lên giá Bitcoin (BTC).

BÀI VIẾT:
"${content}"

---
THỰC HIỆN PHÂN TÍCH THEO 3 BƯỚC (thể hiện trong trường "reasoning"):

BƯỚC 1 - PHÂN LOẠI SỰ KIỆN:
Xác định bài viết thuộc loại nào và tại sao:
• Loại A – Crypto trực tiếp (70-100%): đề cập BTC/crypto, USD, Fed, lạm phát, quy định tài chính số, stablecoin
• Loại B – Kinh tế vĩ mô (40-70%): thuế quan, chiến tranh thương mại Mỹ-Trung, chính sách tài khóa lớn, dầu mỏ/năng lượng có thể gây lạm phát
• Loại C – Địa chính trị (15-50%): xung đột, căng thẳng quân sự — phải phân tích riêng: risk-off hay USD-crisis?
• Loại D – Không liên quan (0-15%): chính trị nội địa, xã hội, thể thao

BƯỚC 2 - CƠ CHẾ TÁC ĐỘNG (bắt buộc xét CẢ HAI chiều):
• Con đường BTC TĂNG: sự kiện này có thể dẫn đến BTC tăng qua cơ chế nào cụ thể?
• Con đường BTC GIẢM: sự kiện này có thể dẫn đến BTC giảm qua cơ chế nào cụ thể?
• Tiền lệ: có sự kiện tương tự nào trong lịch sử? BTC đã phản ứng thế nào?

BƯỚC 3 - KẾT LUẬN:
• So sánh sức nặng của hai chiều trên → xác định hướng TRỘI HƠN
• Xác định xác suất (0-100%) dựa trên mức độ liên quan thực sự tới thị trường tài chính/BTC
• Giải thích tại sao hướng này được chọn thay vì hướng kia

---
Trả về JSON (KHÔNG thêm text nào khác ngoài JSON):
{
  "summary": "Tóm tắt nội dung bài viết bằng tiếng Việt (2-3 câu)",
  "btcInfluenceProbability": <số nguyên 0-100>,
  "btcDirection": <"increase" | "decrease" | "neutral">,
  "reasoning": "Phân tích đầy đủ 3 bước: loại sự kiện → cơ chế tác động cụ thể cả hai chiều tăng/giảm có tiền lệ → kết luận rõ lý do chọn hướng này. Tối thiểu 5-6 câu, không được viết chung chung."
}`;
  }

  /** Normalize giá trị direction từ OpenAI response */
  private normalizeDirection(direction?: string): 'increase' | 'decrease' | 'neutral' {
    const normalized = (direction || '').toLowerCase().trim();
    if (normalized === 'increase' || normalized === 'up') return 'increase';
    if (normalized === 'decrease' || normalized === 'down') return 'decrease';
    return 'neutral';
  }
}
