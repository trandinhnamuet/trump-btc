import paramiko

HOST, USER, PASS = '160.22.161.44', 'root', 'qcP7TXJHpG4Yu9hErxqt'
TOKEN = 'DdEKLNo5HI_U2uFiBaa9kY7oRmLIUcIyz0cRJmkAnR8'

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(HOST, username=USER, password=PASS, timeout=10)

def run(cmd, timeout=20):
    _, out, err = ssh.exec_command(cmd, timeout=timeout)
    return out.read().decode().strip(), err.read().decode().strip()

# Check impersonation options
out, err = run("grep -n impersonate /usr/local/lib/python3.10/dist-packages/truthbrush/api.py | head -5")
print("Impersonation in truthbrush:", out)

# Check available browser types
script = '''
from curl_cffi.requests import BrowserType
print("\\n".join(e.value for e in BrowserType))
'''
sftp = ssh.open_sftp()
with sftp.file('/tmp/check_impersonation.py', 'w') as f:
    f.write(script)

# Test truc tiep voi curl_cffi va chrome124
test_script = f'''
from curl_cffi import requests as curl_requests
import json

resp = curl_requests.get(
    "https://truthsocial.com/api/v1/accounts/107780257626128497/statuses",
    params={{"limit": 5}},
    impersonate="chrome124",
    headers={{
        "Authorization": "Bearer {TOKEN}",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    }},
    timeout=15,
)
print("Status:", resp.status_code)
if resp.status_code == 200:
    posts = resp.json()
    print(len(posts), "posts found")
    if posts:
        print("Latest ID:", posts[0]["id"])
        import re, html
        c = html.unescape(re.sub("<[^>]+>","", posts[0].get("content",""))).strip()
        print("Content:", c[:200])
else:
    print("Error body:", resp.text[:300])
'''
with sftp.file('/root/trump-btc/test_curl.py', 'w') as f:
    f.write(test_script)
sftp.close()

print("\nTesting curl_cffi chrome124 impersonation with token...")
out, err = run("cd /root/trump-btc && python3 test_curl.py", timeout=30)
print("OUT:", out)
print("ERR:", err[:300] if err else "")

ssh.close()
