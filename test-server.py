import paramiko

HOST = "160.22.161.44"
USER = "root"
PASS = "qcP7TXJHpG4Yu9hErxqt"

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(HOST, username=USER, password=PASS, timeout=10)
print(f"Connected to {HOST}")

def run(cmd, timeout=30):
    stdin, stdout, stderr = ssh.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode().strip()
    err = stderr.read().decode().strip()
    return out, err

# Test dùng token có sẵn thay vì username/password
TOKEN = "DdEKLNo5HI_U2uFiBaa9kY7oRmLIUcIyz0cRJmkAnR8"

print(f"\nTest lấy bài bằng token via truthbrush (server IP sạch)...")
cmd = f"cd /root/trump-btc && TRUTHSOCIAL_TOKEN={TOKEN} python3 -c \"\nimport sys, json\nsys.path.insert(0, '.')\nfrom truthbrush.api import Api\napi = Api(token='{TOKEN}')\nposts = list(api.pull_statuses(username='realDonaldTrump', replies=False, verbose=False))\nprint(len(posts), 'posts')\nif posts: print('Latest ID:', posts[0]['id'])\nif posts: print('Content preview:', posts[0].get('content','')[:100])\n\""
out, err = run(cmd, timeout=30)
print("OUT:", out if out else "(empty)")
print("ERR:", err[:500] if err else "(empty)")

ssh.close()
print("\nDone!")
