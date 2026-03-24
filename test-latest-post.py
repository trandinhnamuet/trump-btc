"""
Test script: Chạy trực tiếp trên server để phân tích post mới nhất
với exact prompt của analysis.service.ts hiện tại.
Usage: python3 test-latest-post.py
"""
import json, os, sys, re
import requests

# Load .env
env = {}
env_path = '/root/trump-btc/.env'
if os.path.exists(env_path):
    for line in open(env_path):
        line = line.strip()
        if line and not line.startswith('#') and '=' in line:
            k, v = line.split('=', 1)
            env[k.strip()] = v.strip()

GROK_KEY = env.get('GROK_API_KEY', '')
if not GROK_KEY:
    print('ERROR: GROK_API_KEY not found in .env')
    sys.exit(1)
print(f'Key: {GROK_KEY[:10]}...')

# Đọc bài viết mới nhất từ posts.json
posts_file = '/root/trump-btc/data/posts.json'
with open(posts_file) as f:
    data = json.load(f)

posts = sorted(data['posts'], key=lambda x: x['createdAt'])
last = posts[-1]
print(f"\n=== BÀI VIẾT MỚI NHẤT ===")
print(f"ID: {last['id']}")
print(f"CreatedAt: {last['createdAt']}")
print(f"Content ({len(last['content'])} chars): {last['content']}")
print(f"URL: {last['url']}")
print()

content = last['content']

# Exact prompt from analysis.service.ts
def build_prompt(content):
    return f"""Phan tich bai dang sau cua Donald Trump tren Truth Social.

BAI VIET:
"{content}"

(Khong co du lieu thi truong)

HUONG DAN PHAN TICH - suy nghi theo cac goc do lien quan nhat:

1. TAC DONG TAM LY: Tin nay gay cam xuc gi cho nha dau tu? Hung khoi, so hai, hay tho o?
2. CO CHE TAC DONG DEN BTC: Dong tien dich chuyen qua kenh nao?
3. DO MOI: Thi truong da dinh gia thong tin nay chua?
4. THUC TE: Day la hanh dong cu the hay chi tuyen bo y dinh?
5. BOI CANH: Xu huong "ranging sideways".

CALIBRATION XAC SUAT:
- 0-10%: Khong lien quan kinh te/tai chinh
- 10-30%: Tac dong gian tiep, yeu
- 30-55%: Kinh te vi mo ro rang (thue quan, thuong chien, suy thoai, Fed)
- 55-75%: TRUC TIEP lien quan crypto/Bitcoin/USD (EO ve crypto, chinh sach quy dinh)
- 75-90%: Su kien dot pha bat ngo (My chinh thuc Bitcoin reserve, SEC approve ETF)
- 90-100%: Su kien lich su cuc hiem

LU Y: Khong duoc danh gia thap tin crypto truc tiep. EO cua Trump ve Crypto Strategic Reserve phai >= 70%.

Tra ve ONLY valid JSON:
{{
  "summary": "2-3 cau tom tat CHINH XAC NOI DUNG BAI VIET (Trump dang noi/viet/dang gi? Chu de chinh la gi?). KHONG duoc viet ve tac dong BTC o day.",
  "btcInfluenceProbability": <so nguyen 0-100>,
  "btcDirection": <"increase" | "decrease" | "neutral">,
  "reasoning": "Phan tich cu the, giai thich chuoi tac dong tu noi dung -> tam ly -> gia BTC. Toi thieu 4-5 cau. BAT BUOC VIET BANG TIENG VIET."
}}"""

print("=== GỌI GROK API ===")
r = requests.post(
    'https://api.x.ai/v1/chat/completions',
    json={
        'messages': [
            {
                'role': 'system',
                'content': (
                    'Ban la chuyen gia phan tich thi truong Bitcoin hang dau, am hieu sau ve cach tin tuc, '
                    'chinh tri, va su kien vi mo tac dong den tam ly thi truong va gia BTC. '
                    'Ban suy luan tu ban chat su viec, khong theo template. Moi phan tich phai dac thu cho post do va trang thai thi truong hien tai. '
                    'QUAN TRONG: Toan bo phan "reasoning" va "summary" phai viet bang TIENG VIET.'
                )
            },
            {'role': 'user', 'content': build_prompt(content)},
        ],
        'model': 'grok-3',
        'temperature': 0.3,
        'max_tokens': 1000,
    },
    headers={
        'Content-Type': 'application/json',
        'Authorization': f'Bearer {GROK_KEY}',
    },
    timeout=60,
)

if r.status_code != 200:
    print(f'HTTP {r.status_code}: {r.text[:300]}')
    sys.exit(1)

raw = r.json()['choices'][0]['message']['content']
print(f"\n=== RAW RESPONSE ===\n{raw}\n")

try:
    parsed = json.loads(raw)
    print("=== PARSED ===")
    print(f"summary: {parsed.get('summary')}")
    print(f"btcInfluenceProbability: {parsed.get('btcInfluenceProbability')}")
    print(f"btcDirection: {parsed.get('btcDirection')}")
    print(f"reasoning: {parsed.get('reasoning')[:300]}...")
except Exception as e:
    print(f"JSON parse error: {e}")
