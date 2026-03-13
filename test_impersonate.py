
from curl_cffi import requests as creqs
import json, re, html as h

TOKEN = "DdEKLNo5HI_U2uFiBaa9kY7oRmLIUcIyz0cRJmkAnR8"
URL = "https://truthsocial.com/api/v1/accounts/107780257626128497/statuses"

for browser in ["chrome124", "chrome123", "safari17_2_1", "chrome116"]:
    try:
        r = creqs.get(URL, impersonate=browser, params={"limit":5},
            headers={"Authorization": f"Bearer {TOKEN}"},
            timeout=10)
        print(f"{browser}: {r.status_code} ({len(r.text)} bytes)")
        if r.status_code == 200:
            posts = r.json()
            if posts:
                print(f"  -> {len(posts)} posts! Latest: {posts[0]['id']}")
                content = h.unescape(re.sub("<[^>]+>","", posts[0].get("content",""))).strip()
                print(f"  -> Content: {content[:150]}")
            break
    except Exception as e:
        print(f"{browser}: ERROR {e}")
