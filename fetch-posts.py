import sys
import os
import json
import re
import time
import random
import html as html_module
from curl_cffi.requests import Session

TRUMP_ID = "107780257626128497"
BASE = "https://truthsocial.com"

# Browser profiles to cycle through on retry
PROFILES = [
    {
        "impersonate": "chrome124",
        "ua": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "sec_ch_ua": '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    },
    {
        "impersonate": "chrome123",
        "ua": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
        "sec_ch_ua": '"Google Chrome";v="123", "Not:A-Brand";v="8", "Chromium";v="123"',
    },
    {
        "impersonate": "chrome116",
        "ua": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36",
        "sec_ch_ua": '"Chromium";v="116", "Not)A;Brand";v="24", "Google Chrome";v="116"',
    },
]


def strip_html(raw):
    if not raw:
        return ""
    t = re.sub(r"<br\s*/?>", "\n", raw, flags=re.IGNORECASE)
    t = re.sub(r"<[^>]+>", "", t)
    t = html_module.unescape(t)
    return re.sub(r"\n{3,}", "\n\n", t).strip()


def build_headers(profile: dict, token: str | None) -> dict:
    h = {
        "User-Agent": profile["ua"],
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        "Referer": BASE + "/@realDonaldTrump",
        "Origin": BASE,
        "DNT": "1",
        "Connection": "keep-alive",
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
    }
    if profile.get("sec_ch_ua"):
        h["sec-ch-ua"] = profile["sec_ch_ua"]
        h["sec-ch-ua-mobile"] = "?0"
        h["sec-ch-ua-platform"] = '"Windows"'
    if token:
        h["Authorization"] = f"Bearer {token}"
    return h


def extract_media_urls(post_obj):
    """Trích xuất danh sách URL ảnh từ media_attachments của một post."""
    return [
        att.get("url") or att.get("preview_url", "")
        for att in post_obj.get("media_attachments", [])
        if att.get("type") in ("image", "gifv") and (att.get("url") or att.get("preview_url"))
    ]


def build_post_record(p, sess, profile, token):
    """
    Xây dựng record từ một status object của API.
    Xử lý: reblog (retweet), RT: URL pattern, ảnh đính kèm.
    Trả về dict hoặc None nếu không có nội dung.
    """
    post_id = str(p.get("id", ""))
    created_at = p.get("created_at", "")
    post_url = p.get("url") or BASE + "/@realDonaldTrump/" + post_id

    # --- Trường hợp 1: reblog/retweet chuẩn Mastodon (trường reblog có giá trị) ---
    reblog = p.get("reblog")
    if reblog:
        content = strip_html(reblog.get("content", ""))
        media_urls = extract_media_urls(reblog)
        source_url = reblog.get("url") or post_url
    else:
        content = strip_html(p.get("content", ""))
        media_urls = extract_media_urls(p)
        source_url = post_url

        # --- Trường hợp 2: content là "RT: https://truthsocial.com/.../statuses/<id>" ---
        rt_match = re.match(
            r'^RT:\s+https://truthsocial\.com/[^\s]+/statuses/(\d+)\s*$',
            content.strip(),
        )
        if rt_match and sess is not None:
            linked_id = rt_match.group(1)
            try:
                r2 = sess.get(
                    BASE + "/api/v1/statuses/" + linked_id,
                    headers=build_headers(profile, token),
                    timeout=15,
                )
                if r2.status_code == 200:
                    orig = r2.json()
                    orig_content = strip_html(orig.get("content", ""))
                    orig_media = extract_media_urls(orig)
                    # Dùng nội dung gốc nếu có text hoặc ảnh
                    if orig_content or orig_media:
                        content = orig_content
                        media_urls = orig_media
                        source_url = orig.get("url") or source_url
            except Exception:
                pass  # Non-fatal — giữ content cũ

    # Bỏ qua nếu không có gì để phân tích
    if not content and not media_urls:
        return None

    record = {
        "id": post_id,
        "content": content,
        "createdAt": created_at,
        "url": source_url,
    }
    if media_urls:
        record["mediaUrls"] = media_urls
    return record


def fetch_with_session(since_id, profile, token):
    """Open a session, visit homepage first to pick up cookies, then fetch API."""
    params = {"limit": 40}
    if since_id:
        params["since_id"] = since_id

    with Session(impersonate=profile["impersonate"]) as sess:
        # Warm-up: visit profile page so Cloudflare sets cookies before API call
        try:
            sess.get(
                BASE + "/@realDonaldTrump",
                headers={"User-Agent": profile["ua"], "Accept": "text/html"},
                timeout=15,
            )
            # Small human-like delay
            time.sleep(random.uniform(1.0, 2.5))
        except Exception:
            pass  # Non-fatal, continue anyway

        r = sess.get(
            BASE + "/api/v1/accounts/" + TRUMP_ID + "/statuses",
            params=params,
            headers=build_headers(profile, token),
            timeout=25,
        )
        # Xử lý từng post ngay trong session để có thể fetch linked posts
        if r.status_code == 200:
            posts = []
            for p in r.json():
                record = build_post_record(p, sess, profile, token)
                if record:
                    posts.append(record)
            # Trả về một wrapper để main() kiểm tra status_code và lấy posts
            r._processed_posts = posts
    return r


def fetch_single_post(post_id, profile, token):
    """Fetch a single post by status ID."""
    with Session(impersonate=profile["impersonate"]) as sess:
        try:
            sess.get(
                BASE + "/@realDonaldTrump",
                headers={"User-Agent": profile["ua"], "Accept": "text/html"},
                timeout=15,
            )
            time.sleep(random.uniform(0.5, 1.5))
        except Exception:
            pass

        r = sess.get(
            BASE + "/api/v1/statuses/" + post_id,
            headers=build_headers(profile, token),
            timeout=25,
        )
        if r.status_code == 200:
            # Dùng build_post_record để xử lý reblog/media nhất quán
            # Nhưng không cần follow RT: URL vì đây đã là bài cụ thể (sess=None)
            p = r.json()
            record = build_post_record(p, sess, profile, token)
            r._single_record = record
    return r


def main():
    argv1 = sys.argv[1] if len(sys.argv) > 1 else ""

    # Mode: --single <id> → fetch một post cụ thể theo ID
    if argv1 == "--single" and len(sys.argv) > 2:
        post_id = sys.argv[2]
        token = os.environ.get("TRUTH_SOCIAL_ACCESS_TOKEN")
        last_error = None
        for i, profile in enumerate(PROFILES):
            try:
                r = fetch_single_post(post_id, profile, token)
                if r.status_code in (429, 403):
                    last_error = f"HTTP {r.status_code}: " + r.text[:200]
                    if i < len(PROFILES) - 1:
                        time.sleep(random.uniform(3.0, 6.0))
                    continue
                if r.status_code != 200:
                    last_error = f"HTTP {r.status_code}: " + r.text[:200]
                    continue
                record = getattr(r, "_single_record", None)
                if not record:
                    last_error = "Post has no content or media"
                    continue
                print(json.dumps([record]))
                return
            except Exception as e:
                last_error = str(e)
                if i < len(PROFILES) - 1:
                    time.sleep(random.uniform(2.0, 4.0))
        print(json.dumps({"error": last_error or "All profiles failed"}), file=sys.stderr)
        sys.exit(1)
        return

    since_id = argv1 if argv1 not in ("", "null", "undefined") else None
    token = os.environ.get("TRUTH_SOCIAL_ACCESS_TOKEN")

    last_error = None
    for i, profile in enumerate(PROFILES):
        try:
            r = fetch_with_session(since_id, profile, token)

            if r.status_code == 429 or r.status_code == 403:
                last_error = f"HTTP {r.status_code}: " + r.text[:200]
                # Wait a bit before retrying with next profile
                if i < len(PROFILES) - 1:
                    time.sleep(random.uniform(3.0, 6.0))
                continue

            if r.status_code != 200:
                last_error = f"HTTP {r.status_code}: " + r.text[:200]
                continue

            # Kết quả đã được xử lý bên trong fetch_with_session (reblog, RT: URL, media)
            posts = getattr(r, "_processed_posts", None)
            if posts is None:
                last_error = "No processed posts found"
                continue
            print(json.dumps(posts))
            return

        except Exception as e:
            last_error = str(e)
            if i < len(PROFILES) - 1:
                time.sleep(random.uniform(2.0, 4.0))

    # All profiles failed
    print(json.dumps({"error": last_error or "All profiles failed"}), file=sys.stderr)
    sys.exit(1)


if __name__ == "__main__":
    main()
