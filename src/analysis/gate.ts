/**
 * Tầng lọc rẻ — chạy trước mọi API call.
 *
 * Phần lớn bài Trump đăng là reblog, link trần, khẩu hiệu, hoặc lời chúc mừng.
 * Đưa chúng qua pipeline 9 lần gọi LLM là lãng phí, và tệ hơn: nó buộc model
 * phải chấm điểm cho thứ hiển nhiên không có tín hiệu, kéo phân phối điểm lên.
 *
 * Gate ở đây thuần heuristic, không tốn call nào. Nó chỉ loại những gì CHẮC CHẮN
 * không có nội dung để phân tích — không cố đoán mức tác động.
 */

export type GateVerdict =
  | { pass: true }
  | { pass: false; reason: string; summary: string };

/** URL trần, hoặc RT + URL, không có văn bản thật. */
function isUrlOnly(content: string): boolean {
  return /^(RT:\s+)?https?:\/\/\S+(\s+https?:\/\/\S+)*\s*$/.test(content.trim());
}

/** Chỉ gồm emoji, dấu câu, khoảng trắng. */
function isSymbolOnly(content: string): boolean {
  const stripped = content.replace(/\s/g, '');
  if (!stripped) return true;
  return !/[\p{L}\p{N}]/u.test(stripped);
}

export function gate(content: string, mediaUrls?: string[]): GateVerdict {
  const text = (content ?? '').trim();
  const hasMedia = (mediaUrls?.length ?? 0) > 0;

  if (!text && !hasMedia) {
    return {
      pass: false,
      reason: 'rỗng',
      summary: 'Bài đăng không có nội dung văn bản hay hình ảnh để phân tích.',
    };
  }

  if (isUrlOnly(text) && !hasMedia) {
    return {
      pass: false,
      reason: 'chỉ có URL',
      summary: 'Bài đăng chỉ là một đường dẫn, không có nội dung để phân tích.',
    };
  }

  if (isSymbolOnly(text) && !hasMedia) {
    return {
      pass: false,
      reason: 'chỉ có ký hiệu',
      summary: 'Bài đăng chỉ gồm emoji hoặc dấu câu, không có nội dung để phân tích.',
    };
  }

  return { pass: true };
}
