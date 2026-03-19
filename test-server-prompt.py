import json, os, sys
from dotenv import load_dotenv
import requests

load_dotenv('/root/trump-btc/.env')
GROK_API_KEY = os.environ.get('GROK_API_KEY', '')
print('Key prefix:', GROK_API_KEY[:12] + '...' if GROK_API_KEY else 'MISSING')

CONTENT = (
    'Israel, out of anger for what has taken place in the Middle East, has violently '
    'lashed out at a major facility known as South Pars Gas Field in Iran. A relatively '
    'small section of the whole has been hit. The United States knew nothing about this '
    'particular attack, and the country of Qatar was warned strongly by Trump not to be '
    'attacked, or the US will respond with great force.'
)

system_msg = """Bạn là chuyên gia phân tích tài chính cấp cao chuyên về Bitcoin (BTC).

KIẾN THỨC NỀN:
1. BTC có bản chất kép: risk-asset (giảm cùng chứng khoán khi risk-off) và safe-haven (tăng khi mất niềm tin vào fiat/ngân hàng)
2. Địa chính trị thông thường -> tâm lý risk-off -> BTC thường giảm ngắn hạn
3. Tuy nhiên nếu xung đột đe dọa nguồn cung năng lượng toàn cầu: giá dầu tăng -> lạm phát -> Fed giữ lãi cao -> BTC giảm
4. Tiền lệ: Căng thẳng Trung Đông 2019-2024: BTC không có trend rõ ràng. Ukraine 2022: BTC giảm với cổ phiếu rồi phục hồi.

CHỈ trả về JSON."""

prompt = f"""Phân tích bài đăng của Trump:
"{CONTENT}"

THỰC HIỆN 3 BƯỚC (viết vào "reasoning"):
Bước 1: Phân loại (A=crypto trực tiếp/B=kinh tế vĩ mô/C=địa chính trị/D=không liên quan) và lý do
Bước 2: Con đường BTC TĂNG (cơ chế cụ thể) + Con đường BTC GIẢM (cơ chế cụ thể) + Tiền lệ lịch sử
Bước 3: Hướng nào trội hơn và tại sao -> xác suất

JSON format:
{{
  "summary": "tóm tắt tiếng Việt 2-3 câu",
  "btcInfluenceProbability": <int 0-100>,
  "btcDirection": "<increase|decrease|neutral>",
  "reasoning": "phân tích 3 bước đầy đủ, tối thiểu 5-6 câu, cụ thể"
}}"""

r = requests.post(
    'https://api.x.ai/v1/chat/completions',
    json={
        'messages': [
            {'role': 'system', 'content': system_msg},
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
    print('HTTP ERROR', r.status_code, json.dumps(data, ensure_ascii=False))
    sys.exit(1)

msg = data['choices'][0]['message']['content']
try:
    p = json.loads(msg)
    print(json.dumps(p, ensure_ascii=False, indent=2))
except Exception as e:
    print('Parse error:', e)
    print('RAW:', msg)
