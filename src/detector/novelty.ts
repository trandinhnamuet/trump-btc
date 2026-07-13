/**
 * Kiểm tra tính mới — mảnh ghép mà pipeline chấm điểm thiếu hoàn toàn.
 *
 * Trump nói về thuế và crypto LIÊN TỤC. Bài làm thị trường rung chuyển hầu như
 * luôn là bài ĐẦU TIÊN công bố một hành động; các bài nhắc lại/ca ngợi sau đó
 * không còn thông tin mới và thị trường đã định giá xong. So bài mới với các
 * bài N ngày gần nhất bằng Jaccard trên tập token: đủ tốt cho văn bản ngắn,
 * 0 API call, chạy trong micro-giây.
 */

/** Stopword tiếng Anh tối thiểu — đủ để khử nhiễu, không cần danh sách đầy đủ. */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'will', 'are', 'was', 'were',
  'have', 'has', 'had', 'our', 'your', 'their', 'they', 'them', 'you', 'his',
  'her', 'its', 'not', 'but', 'all', 'any', 'can', 'could', 'would', 'should',
  'been', 'being', 'from', 'into', 'onto', 'over', 'under', 'about', 'than',
  'then', 'when', 'where', 'which', 'who', 'whom', 'what', 'why', 'how',
  'very', 'just', 'also', 'only', 'more', 'most', 'much', 'many', 'some',
  'such', 'now', 'out', 'off', 'too', 'again', 'because', 'while', 'after',
  'before', 'there', 'here', 'these', 'those', 'a', 'an', 'is', 'it', 'in',
  'on', 'at', 'to', 'of', 'by', 'as', 'be', 'or', 'we', 'i', 'my', 'me', 'do',
  'does', 'did', 'no', 'so', 'if', 'up', 'am',
]);

/** Token hoá: bỏ URL, chữ thường, chỉ giữ từ ≥3 ký tự không phải stopword. */
export function tokenize(text: string): Set<string> {
  const cleaned = text
    .replace(/https?:\/\/\S+/g, ' ')
    .toLowerCase()
    .replace(/[^a-z0-9%]+/g, ' ');
  const out = new Set<string>();
  for (const tok of cleaned.split(/\s+/)) {
    if (tok.length >= 3 && !STOPWORDS.has(tok)) out.add(tok);
  }
  return out;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

export interface NoveltyResult {
  /** 1 = hoàn toàn mới so với các bài gần đây, 0 = trùng lặp */
  novelty: number;
  /** độ giống lớn nhất với một bài gần đây */
  maxSimilarity: number;
}

/** Trên ngưỡng này coi là bài lặp lại — không alert. */
export const REPEAT_THRESHOLD = 0.5;

export function assessNovelty(content: string, recentPosts: string[]): NoveltyResult {
  const target = tokenize(content);
  let maxSim = 0;
  for (const prev of recentPosts) {
    const sim = jaccard(target, tokenize(prev));
    if (sim > maxSim) maxSim = sim;
  }
  return { novelty: 1 - maxSim, maxSimilarity: maxSim };
}

/**
 * Chọn ra tối đa `k` bài gần đây giống bài mới nhất — làm ngữ cảnh cho LLM
 * checklist ("bài mới có công bố gì MỚI so với những bài này không?").
 */
export function topSimilar(content: string, recentPosts: string[], k = 8): Array<{ text: string; sim: number }> {
  const target = tokenize(content);
  return recentPosts
    .map(text => ({ text, sim: jaccard(target, tokenize(text)) }))
    .filter(x => x.sim > 0.05)
    .sort((a, b) => b.sim - a.sim)
    .slice(0, k);
}
