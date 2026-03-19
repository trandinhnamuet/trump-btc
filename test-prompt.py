import json, os, sys
from dotenv import load_dotenv
import requests

load_dotenv(r'C:\ics\trump-btc\.env')
GROK_API_KEY = os.environ.get('GROK_API_KEY')

CONTENT = (
    'Israel, out of anger for what has taken place in the Middle East, has violently '
    'lashed out at a major facility known as South Pars Gas Field in Iran. A relatively '
    'small section of the whole has been hit. The United States knew nothing about this '
    'particular attack, and the country of Qatar was in danger of being attacked as well. '
    'I have strongly warned Iran not to attack Qatar\'s LNG facilities. If they do, '
    'the United States will have no choice but to respond with great force.'
)

system = """Bạn là chuyên gia phân tích tài chính cấp cao chuyên về Bitcoin (BTC) với hiểu biết sâu về mối quan hệ giữa sự kiện vĩ mô và biến động giá crypto.

KIẾN THỨC NỀN BẮT BUỘC ÁP DỤNG:

1. BẢN CHẤT KÉP CỦA BTC:
   - BTC là "risk asset": khi thị trường sợ hãi (risk-off), nhà đầu tư bán BTC cùng chứng khoán để giữ tiền mặt
   - BTC là "safe haven / digital gold": khi mất niềm tin vào tiền tệ fiat hoặc hệ thống ngân hàng, dòng tiền chạy vào BTC
   - PHÂN BIỆT: địa chính trị thông thường → risk-off → BTC giảm; khủng hoảng USD/ngân hàng/fiat → safe haven → BTC tăng

2. CÁC NHÂN TỐ MẠNH NHẤT TÁC ĐỘNG BTC:
   - Fed lãi suất / chính sách tiền tệ: tăng → BTC giảm; cắt → BTC tăng
   - USD (DXY index): USD mạnh → BTC giảm; USD yếu → BTC tăng
   - Giá dầu tăng đột biến → lạm phát → Fed hawkish → BTC giảm

3. TIỀN LỆ LỊCH SỬ QUAN TRỌNG:
   - Xung đột Ukraine 2022: BTC ban đầu giảm mạnh (risk-off), sau phục hồi
   - Căng thẳng Trung Đông thông thường: tác động BTC rất nhỏ, không ổn định
   - COVID crash 3/2020: BTC rơi -50% (risk-off tuyệt đối)

CHỈ trả về JSON theo format yêu cầu. KHÔNG thêm bất kỳ text nào khác."""

prompt = f"""Phân tích bài đăng sau của Donald Trump trên Truth Social và đánh giá tác động lên giá Bitcoin (BTC).

BÀI VIẾT:
"{CONTENT}"

---
THỰC HIỆN PHÂN TÍCH THEO 3 BƯỚC (thể hiện trong trường "reasoning"):

BƯỚC 1 - PHÂN LOẠI SỰ KIỆN:
Xác định bài viết thuộc loại nào và tại sao:
• Loại A – Crypto trực tiếp (70-100%)
• Loại B – Kinh tế vĩ mô (40-70%)
• Loại C – Địa chính trị (15-50%) — phải phân tích: risk-off hay USD-crisis?
• Loại D – Không liên quan (0-15%)

BƯỚC 2 - CƠ CHẾ TÁC ĐỘNG (bắt buộc xét CẢ HAI chiều):
• Con đường BTC TĂNG: cơ chế cụ thể?
• Con đường BTC GIẢM: cơ chế cụ thể?
• Tiền lệ lịch sử tương tự?

BƯỚC 3 - KẾT LUẬN:
• So sánh sức nặng hai chiều → hướng trội hơn là gì?
• Xác suất 0-100% dựa trên mức độ liên quan thực sự

---
Trả về JSON (KHÔNG thêm text nào khác ngoài JSON):
{{
  "summary": "Tóm tắt nội dung bài viết bằng tiếng Việt (2-3 câu)",
  "btcInfluenceProbability": <số nguyên 0-100>,
  "btcDirection": <"increase" | "decrease" | "neutral">,
  "reasoning": "Phân tích đầy đủ 3 bước. Tối thiểu 5-6 câu, không được viết chung chung."
}}"""

print("Calling Grok API...")
r = requests.post(
    'https://api.x.ai/v1/chat/completions',
    json={
        'messages': [
            {'role': 'system', 'content': system},
            {'role': 'user', 'content': prompt},
        ],
        'model': 'grok-3',
        'temperature': 0.2,
        'max_tokens': 900,
    },
    headers={'Authorization': f'Bearer {GROK_API_KEY}', 'Content-Type': 'application/json'},
    timeout=40,
)

data = r.json()
if r.status_code != 200:
    print("ERROR:", r.status_code, data)
    sys.exit(1)

msg = data['choices'][0]['message']['content']
print("\n=== RAW RESPONSE ===")
print(msg)

try:
    parsed = json.loads(msg)
    print("\n=== PARSED ===")
    print(f"Summary: {parsed.get('summary')}")
    print(f"Probability: {parsed.get('btcInfluenceProbability')}%")
    print(f"Direction: {parsed.get('btcDirection')}")
    print(f"\nReasoning:\n{parsed.get('reasoning')}")
except Exception as e:
    print("Parse error:", e)
