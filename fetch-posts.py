"""
Helper script: Lấy bài viết của Trump từ Truth Social.
Sử dụng curl_cffi để bypass Cloudflare (giống project Python chính).

Usage:
  python fetch-posts.py              # Lấy 20 bài mới nhất
  python fetch-posts.py <since_id>   # Lấy bài mới hơn since_id

Output: JSON array to stdout, errors to stderr
"""
import sys
import os
import json
import re
import html as html_module

# Thêm đường dẫn đến truthbrush library
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
TRUTHBRUSH_DIR = os.path.join(SCRIPT_DIR, 'main', 'main')
sys.path.insert(0, TRUTHBRUSH_DIR)

from truthbrush.api import Api

def strip_html(raw_html):
    """Xóa HTML tags và decode entities."""
    if not raw_html:
        return ''
    text = re.sub(r'<br\s*/?>', '\n', raw_html, flags=re.IGNORECASE)
    text = re.sub(r'<[^>]+>', '', text)
    text = html_module.unescape(text)
    return text.strip()

def main():
    since_id = sys.argv[1] if len(sys.argv) > 1 and sys.argv[1] != 'null' else None

    # Lấy credentials từ .env (truthbrush tự load .env)
    username = os.getenv('TRUTHSOCIAL_USERNAME')
    password = os.getenv('TRUTHSOCIAL_PASSWORD')
    token = os.getenv('TRUTH_SOCIAL_ACCESS_TOKEN') or os.getenv('TRUTHSOCIAL_TOKEN')

    if not token and (not username or not password):
        print(json.dumps({'error': 'Thiếu TRUTHSOCIAL_USERNAME/PASSWORD hoặc TRUTH_SOCIAL_ACCESS_TOKEN trong .env'}))
        sys.exit(1)

    try:
        api = Api(username=username, password=password, token=token)
        raw_posts = list(api.pull_statuses(
            username='realDonaldTrump',
            replies=False,
            verbose=False,
            since_id=since_id
        ))

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
    except Exception as e:
        print(json.dumps({'error': str(e)}), file=sys.stderr)
        sys.exit(1)

if __name__ == '__main__':
    # Load .env từ thư mục project
    try:
        from dotenv import load_dotenv
        env_path = os.path.join(SCRIPT_DIR, '.env')
        load_dotenv(env_path)
    except ImportError:
        pass  # dotenv không bắt buộc nếu env đã được set

    main()
