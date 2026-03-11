import paramiko, time

HOST, USER, PASS = '160.22.161.44', 'root', 'qcP7TXJHpG4Yu9hErxqt'
TOKEN = 'DdEKLNo5HI_U2uFiBaa9kY7oRmLIUcIyz0cRJmkAnR8'

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(HOST, username=USER, password=PASS, timeout=10)
print('Connected', flush=True)

# Upload script test
test_code = '''
from curl_cffi import requests as creqs
import json, re, html as h

TOKEN = "''' + TOKEN + '''"
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
'''

sftp = ssh.open_sftp()
with sftp.file('/root/trump-btc/test_impersonate.py', 'w') as f:
    f.write(test_code)
sftp.close()
print("Script uploaded")

# Chay script voi timeout lon hon
_, stdout, stderr = ssh.exec_command('cd /root/trump-btc && python3 test_impersonate.py', timeout=60)

# Doc ket qua theo streaming
start = time.time()
output = []
while time.time() - start < 55:
    if stdout.channel.exit_status_ready():
        break
    if stdout.channel.recv_ready():
        chunk = stdout.channel.recv(1024).decode()
        print(chunk, end='', flush=True)
        output.append(chunk)
    time.sleep(0.2)

remaining = stdout.read().decode()
if remaining:
    print(remaining, end='', flush=True)

err = stderr.read().decode()
if err:
    print("ERR:", err[:500])

ssh.close()
print("\nDone!")
