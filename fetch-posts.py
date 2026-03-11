import sys
import os
import json
import re
import html as html_module

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
TRUMP_ID = "107780257626128497"
BASE = "https://truthsocial.com"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"


def strip_html(raw):
    if not raw:
        return ""
    t = re.sub(r"<br\s*/?>", "\n", raw, flags=re.IGNORECASE)
    t = re.sub(r"<[^>]+>", "", t)
    t = html_module.unescape(t)
    return re.sub(r"\n{3,}", "\n\n", t).strip()


def get_posts(sess, since_id):
    params = {"limit": 40}
    if since_id:
        params["since_id"] = since_id
    return sess.get(
        BASE + "/api/v1/accounts/" + TRUMP_ID + "/statuses",
        params=params,
        impersonate="chrome124",
        headers={"User-Agent": UA, "Accept": "application/json"},
        timeout=20,
    )


def main():
    from curl_cffi import requests as sess

    argv1 = sys.argv[1] if len(sys.argv) > 1 else ""
    since_id = argv1 if argv1 not in ("", "null", "undefined") else None

    r = get_posts(sess, since_id)

    if r.status_code != 200:
        print(json.dumps({"error": f"HTTP {r.status_code}: " + r.text[:200]}), file=sys.stderr)
        sys.exit(1)

    posts = []
    for p in r.json():
        content = strip_html(p.get("content", ""))
        if not content:
            continue
        posts.append({
            "id": str(p.get("id", "")),
            "content": content,
            "createdAt": p.get("created_at", ""),
            "url": p.get("url") or BASE + "/@realDonaldTrump/" + str(p.get("id", "")),
        })
    print(json.dumps(posts))


if __name__ == "__main__":
    main()
