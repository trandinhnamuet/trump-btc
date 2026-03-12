/**
 * Backfill Script: Analyze existing posts that don't have analysis data yet.
 * Usage: npm run backfill:analysis
 * 
 * This script:
 * 1. Reads data/posts.json
 * 2. Finds posts without analysis data
 * 3. Calls OpenAI to analyze each one
 * 4. Saves the analysis results back
 */

import * as fs from 'fs';
import * as path from 'path';
import OpenAI from 'openai';
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

async function analyzePost(openai: OpenAI, content: string): Promise<AnalysisResult> {
  const prompt = buildAnalysisPrompt(content);
  const response = await openai.chat.completions.create({
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
    response_format: { type: 'json_object' },
    temperature: 0.3,
    max_tokens: 500,
  });

  const messageContent = response.choices[0]?.message?.content ?? '';
  if (!messageContent) throw new Error('OpenAI trả về response rỗng');

  const parsed = JSON.parse(messageContent) as any;
  return {
    summary: parsed.summary || 'Không thể tóm tắt',
    btcInfluenceProbability: Math.min(100, Math.max(0, Number(parsed.btcInfluenceProbability) || 0)),
    btcDirection: normalizeDirection(parsed.btcDirection),
    reasoning: parsed.reasoning || '',
  };
}

async function backfillAnalysis() {
  try {
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
      (p) => !p.btcInfluenceProbability && p.content
    );

    if (postsNeedingAnalysis.length === 0) {
      console.log('✅ Tất cả bài viết đã có phân tích. Không có gì phải làm.');
      process.exit(0);
    }

    console.log(`\n📊 Tìm thấy ${postsNeedingAnalysis.length} bài viết chưa được phân tích.\n`);

    // Initialize OpenAI
    const openai = new OpenAI({ apiKey });

    let successCount = 0;
    let errorCount = 0;

    for (const post of postsNeedingAnalysis) {
      try {
        console.log(`⏳ Phân tích bài ${post.id}: "${post.content.substring(0, 60)}..."`);
        
        const analysis = await analyzePost(openai, post.content);
        
        // Update the post with analysis
        post.summary = analysis.summary;
        post.btcInfluenceProbability = analysis.btcInfluenceProbability;
        post.btcDirection = analysis.btcDirection;
        post.reasoning = analysis.reasoning;

        console.log(
          `✅ Xác suất: ${analysis.btcInfluenceProbability}% (${analysis.btcDirection})\n`
        );
        successCount++;
      } catch (error) {
        console.error(
          `❌ Lỗi phân tích bài ${post.id}: ${error.message}\n`
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
    console.error('❌ Lỗi:', error.message);
    process.exit(1);
  }
}

backfillAnalysis();

