import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { AnalysisResult } from '../common/interfaces';

/**
 * AnalysisService: Phân tích bài viết của Trump bằng OpenAI GPT-4o-mini.
 *
 * Prompt được thiết kế để:
 * 1. Tóm tắt nội dung bài viết
 * 2. Đánh giá % khả năng ảnh hưởng đến giá BTC
 * 3. Xác định hướng ảnh hưởng (tăng/giảm/trung lập)
 */
@Injectable()
export class AnalysisService {
  private readonly logger = new Logger(AnalysisService.name);
  private readonly openai: OpenAI;

  constructor(private readonly configService: ConfigService) {
    const apiKey = this.configService.get<string>('OPENAI_API_KEY');
    if (!apiKey) {
      this.logger.warn('OPENAI_API_KEY chưa được cấu hình trong .env!');
    }
    // Khởi tạo OpenAI client
    this.openai = new OpenAI({ apiKey: apiKey || '' });
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

      const response = await this.openai.chat.completions.create({
        // gpt-4o-mini: model rẻ nhất, đủ chất lượng cho task này
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: `Bạn là chuyên gia phân tích tài chính cryptocurrency, chuyên đánh giá tác động của các sự kiện chính trị/kinh tế đến giá Bitcoin. 
            Hãy phân tích khách quan và chỉ trả về JSON theo đúng format yêu cầu.`,
          },
          {
            role: 'user',
            content: prompt,
          },
        ],
        // Yêu cầu response dạng JSON để parse dễ dàng
        response_format: { type: 'json_object' },
        temperature: 0.3, // Thấp để kết quả ổn định, ít ngẫu nhiên
        max_tokens: 500,
      });

      // OpenAI SDK v4: response có trực tiếp .choices[0].message.content
      const messageContent = response.choices[0]?.message?.content ?? '';

      if (!messageContent) {
        this.logger.error('OpenAI trả về response rỗng');
        throw new Error('OpenAI trả về response rỗng');
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
        this.logger.error('Không thể parse JSON từ OpenAI response. Raw content:');
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
      this.logger.error('Lỗi khi gọi OpenAI API:', error.message);
      throw error;
    }
  }

  /**
   * Xây dựng prompt phân tích.
   * Yêu cầu OpenAI trả về JSON với format cụ thể.
   */
  private buildPrompt(content: string): string {
    return `Phân tích bài đăng sau của Donald Trump trên Truth Social và đánh giá tác động lên giá Bitcoin (BTC):

BÀI VIẾT:
"${content}"

Hãy trả về JSON với format sau (KHÔNG thêm bất kỳ text nào khác):
{
  "summary": "Tóm tắt ngắn gọn nội dung bài viết bằng tiếng Việt (2-3 câu)",
  "btcInfluenceProbability": <số nguyên từ 0 đến 100, là % khả năng bài viết này ảnh hưởng đến giá BTC>,
  "btcDirection": <"increase" nếu có khả năng tăng, "decrease" nếu có khả năng giảm, "neutral" nếu trung lập>,
  "reasoning": "Giải thích ngắn gọn lý do đánh giá (tiếng Việt, 1-2 câu)"
}

Hướng dẫn đánh giá:
- Xác suất cao (70-100%): Bài liên quan trực tiếp đến crypto/BTC, USD, chính sách tiền tệ, thuế, quan hệ Mỹ-Trung, chiến tranh thương mại, hoặc chính sách tài chính lớn
- Xác suất trung bình (30-70%): Bài về kinh tế Mỹ, thị trường chứng khoán, lãi suất Fed, địa chính trị có thể ảnh hưởng gián tiếp
- Xác suất thấp (0-30%): Bài về chính trị nội địa, xã hội, thể thao, giải trí không liên quan đến tài chính`;
  }

  /** Normalize giá trị direction từ OpenAI response */
  private normalizeDirection(direction?: string): 'increase' | 'decrease' | 'neutral' {
    const normalized = (direction || '').toLowerCase().trim();
    if (normalized === 'increase' || normalized === 'up') return 'increase';
    if (normalized === 'decrease' || normalized === 'down') return 'decrease';
    return 'neutral';
  }
}
