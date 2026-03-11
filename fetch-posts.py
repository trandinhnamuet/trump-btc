"""
Helper script: Lấy bài viết của Trump từ Truth Social.
Sử dụng curl_cffi để bypass Cloudflare (impersonate Chrome).

Usage:
  python3 fetch-posts.py              # Lấy bài mới nhất
  python3 fetch-posts.py <since_id>   # Lấy bài mới hơn since_id

Output: JSON array to stdout, errors to stderr
"""
import sys
import os
import json
import re
import html as html_module

try:
    from curl_cffi import requests
except ImportError:
    print(json.dumps({'error': 'curl_cffi not installed. Run: pip3 install curl_cffi'}), file=sys.stderr)
    sys.exit(1)

try:
    from dotenv import load_dotenv
    load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), '.env'))
except ImportError:
    pass

TRUMP_ACCOUNT_ID = '107780257626128497'
BASE_URL = 'https://truthsocial.com/api/v1'
OAUTH_URL = 'https://truthsocial.com/oauth/token'
CLIENT_ID = '9X1Fdd-pxNsAgEDNi_SfhJWi8T-vLuV2WVzKIbkTCw4'
CLIENT_SECRET = 'ozF8jzI4968oTKFkEnsBC-UbLPCdrSv0MkXGQu2o_-M'

def strip_html(raw_html):
    if not raw_html:
        return ''
    text = re.sub(r'<br\s*/?>', '\n', raw_html, flags=re.IGNORECASE)
    text = re.sub(r'<[^>]+>', '', text)
    text = html_module.unescape(text)
    return text.strip()

def get_token():
    """Lấy access token bằng username/password."""
    token = os.getenv('TRUTH_SOCIAL_ACCESS_TOKEN') or os.getenv('TRUTHSOCIAL_TOKEN')
    if token:
        return token

    username = os.getenv('TRUTHSOCIAL_USERNAME')
    password = os.getenv('TRUTHSOCIAL_PASSWORD')
    if not username or not password:
        return None

    resp = requests.post(
        OAUTH_URL,
        json={
            'client_id': CLIENT_ID,
            'client_secret': CLIENT_SECRET,
            'grant_type': 'password',
            'username': username,
            'password': password,
            'scope': 'read',
        },
        impersonate='chrome123',
        timeout=15,
    )

    if resp.status_code == 200:
        data = resp.json()
        return data.get('access_token')
    else:
        print(f'Login failed: {resp.status_code} {resp.text[:200]}', file=sys.stderr)
        return None

def main():
    since_id = sys.argv[1] if len(sys.argv) > 1 and sys.argv[1] != 'null' else None

    token = get_token()
    headers = {'Authorization': f'Bearer {token}'} if token else {}

    params = {'limit': 40}
    if since_id:
        params['since_id'] = since_id

    resp = requests.get(
        f'{BASE_URL}/accounts/{TRUMP_ACCOUNT_ID}/statuses',
        params=params,
        headers=headers,
        impersonate='chrome123',
        timeout=20,
    )

    if resp.status_code != 200:
        print(json.dumps({'error': f'API returned {resp.status_code}'}), file=sys.stderr)
        sys.exit(1)

    raw_posts = resp.json()
    posts = []
    for post in raw_posts:
        content = strip_html(post.get('content', ''))
        if not content:
            continue
        posts.append({
            'id': post.get('id', ''),
            'content': content,
            'createdAt': post.get('created_at', ''),
            'url': post.get('url') or f"https://truthsocial.com/@realDonaldTrump/{post.get('id', '')}"
        })

    print(json.dumps(posts))

if __name__ == '__main__':
    main()
