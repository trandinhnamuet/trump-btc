/**
 * Backfill Script — TÀN DƯ CỦA v1, ĐÃ NGỪNG DÙNG.
 *
 * ⚠️ Script này viết điểm số theo thang v1 (chưa hiệu chuẩn, không có `modelUsed`,
 * không có `scoring`) trở lại data/posts.json. Kể từ v2, posts.json là tập dữ liệu
 * dùng để backtest và fit đường hiệu chuẩn — ghi điểm v1 vào đó sẽ trộn hai thang
 * đo khác nhau và làm hỏng mọi kết luận rút ra từ `npm run backtest`.
 *
 * Ngoài ra prompt bên dưới chứa đúng lỗi thiết kế mà v2 loại bỏ:
 * "Xác suất cao (70-100%)..." — hướng dẫn model rải điểm khắp thang 0-100, trong
 * khi tần suất nền thực tế của một biến động bất thường chỉ khoảng 5%.
 *
 * Việc backfill giờ do PollingService.reprocessUnanalyzed() đảm nhiệm, dùng đúng
 * pipeline production (ensemble + hiệu chuẩn).
 *
 * Chạy có chủ đích: `npm run backfill:analysis -- --force-legacy`
 */

import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import { PostRecord, StorageData, AnalysisResult } from '../common/interfaces';

// Simple function to analyze post (copy of AnalysisService.analyzePost logic)
function buildAnalysisPrompt(content: string): string {
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

function normalizeDirection(direction?: string): 'increase' | 'decrease' | 'neutral' {
  const normalized = (direction || '').toLowerCase().trim();
  if (normalized === 'increase' || normalized === 'up') return 'increase';
  if (normalized === 'decrease' || normalized === 'down') return 'decrease';
  return 'neutral';
}

function loadEnv(): Record<string, string> {
  const envPath = path.join(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) {
    throw new Error('Không tìm thấy file .env');
  }

  const env: Record<string, string> = {};
  const content = fs.readFileSync(envPath, 'utf-8');
  content.split('\n').forEach((line) => {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      const [key, ...valueParts] = trimmed.split('=');
      if (key) env[key.trim()] = valueParts.join('=').trim();
    }
  });
  return env;
}

async function analyzePost(apiKey: string, content: string): Promise<AnalysisResult> {
  const prompt = buildAnalysisPrompt(content);
  const response = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    {
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
      model: 'gpt-4o-mini',
      temperature: 0.3,
      max_tokens: 500,
    },
    {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
    },
  );

  const messageContent = response.data?.choices?.[0]?.message?.content ?? '';
  if (!messageContent) throw new Error('Grok trả về response rỗng');

  const parsed = JSON.parse(messageContent) as any;
  const modelProb = Math.min(100, Math.max(0, Number(parsed.btcInfluenceProbability) || 0));
  return {
    summary: parsed.summary || 'Không thể tóm tắt',
    btcInfluenceProbability: modelProb,
    btcDirection: normalizeDirection(parsed.btcDirection),
    reasoning: parsed.reasoning || '',
    ensembleProbability: modelProb,
    severityScore: 0,
    marketSignalScore: 0,
    hardRule: false,
    matchedRules: [],
  };
}

async function backfillAnalysis() {
  try {
    if (!process.argv.includes('--force-legacy')) {
      console.log('⛔ Script backfill v1 đã ngừng dùng — nó ghi điểm chưa hiệu chuẩn vào posts.json');
      console.log('   và sẽ làm hỏng tập dữ liệu backtest của hệ thống v2.');
      console.log('');
      console.log('   Backfill giờ chạy tự động qua PollingService khi khởi động app,');
      console.log('   dùng đúng pipeline ensemble + hiệu chuẩn.');
      console.log('');
      console.log('   Nếu thực sự cần chạy bản cũ: npm run backfill:analysis -- --force-legacy');
      process.exit(1);
    }

    // Load .env
    const env = loadEnv();
    const apiKey = env.OPENAI_API_KEY;
    if (!apiKey) {
      console.log('❌ OPENAI_API_KEY chưa được cấu hình trong .env');
      process.exit(1);
    }

    const postsFile = path.join(process.cwd(), 'data', 'posts.json');
    if (!fs.existsSync(postsFile)) {
      console.log('❌ Không tìm thấy data/posts.json');
      process.exit(1);
    }

    // Read current posts
    const data: StorageData = JSON.parse(fs.readFileSync(postsFile, 'utf-8'));
    const postsNeedingAnalysis = data.posts.filter(
      (p) => p.btcInfluenceProbability == null && p.content
    );

    if (postsNeedingAnalysis.length === 0) {
      console.log('✅ Tất cả bài viết đã có phân tích. Không có gì phải làm.');
      process.exit(0);
    }

    console.log(`\n📊 Tìm thấy ${postsNeedingAnalysis.length} bài viết chưa được phân tích.`);
    console.log(`💡 Sử dụng model: gpt-4o-mini | ước tính chi phí: ~$${(postsNeedingAnalysis.length * 0.0002).toFixed(4)}`);
    if (postsNeedingAnalysis.length > 50) {
      console.log(`⚠️  CảNH BÁO: ${postsNeedingAnalysis.length} bài > 50! Kiểm tra filter trước khi chạy.`);
      console.log(`   Bài đầu tiên: id=${postsNeedingAnalysis[0].id}, score=${postsNeedingAnalysis[0].btcInfluenceProbability ?? 'null'}`);
      console.log(`   Nếu thấy nhiều bài score=null nhưng đã phân tích, hãy Ctrl+C ngay!`);
    }
    console.log();

    let successCount = 0;
    let errorCount = 0;

    for (const [idx, post] of postsNeedingAnalysis.entries()) {
      try {
        console.log(`[${idx + 1}/${postsNeedingAnalysis.length}] ⏳ Bài ${post.id}: "${post.content.substring(0, 60)}..."`);
        
        const analysis = await analyzePost(apiKey, post.content);
        
        // Update the post with analysis
        post.summary = analysis.summary;
        post.btcInfluenceProbability = analysis.btcInfluenceProbability;
        post.btcDirection = analysis.btcDirection;
        post.reasoning = analysis.reasoning;

        // Format direction with arrow and color
        let directionIndicator = '';
        let colorCode = '\x1b[0m'; // Reset color

        if (analysis.btcDirection === 'increase') {
          directionIndicator = '↑';
          colorCode = '\x1b[32m'; // Green for increase
        } else if (analysis.btcDirection === 'decrease') {
          directionIndicator = '↓';
          colorCode = '\x1b[31m'; // Red for decrease
        } else {
          directionIndicator = '─';
          colorCode = '\x1b[90m'; // Gray for neutral
        }

        const percentageDisplay = `${colorCode}${analysis.btcInfluenceProbability}%${directionIndicator}\x1b[0m`;
        console.log(`✅ Xác suất: ${percentageDisplay}\n`);
        successCount++;
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        console.error(
          `❌ Lỗi phân tích bài ${post.id}: ${errMsg}\n`
        );
        errorCount++;
      }

      // Rate limit: 1 second between requests
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    // Save updated data
    fs.writeFileSync(postsFile, JSON.stringify(data, null, 2), 'utf-8');

    console.log(`\n${'='.repeat(60)}`);
    console.log(`✅ Hoàn thành! ${successCount} thành công, ${errorCount} lỗi`);
    console.log(`${'='.repeat(60)}\n`);

    process.exit(errorCount > 0 ? 1 : 0);
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error('❌ Lỗi:', errMsg);
    process.exit(1);
  }
}

backfillAnalysis();

