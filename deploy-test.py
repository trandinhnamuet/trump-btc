import paramiko

HOST = "160.22.161.44"
USER = "root"
PASS = "qcP7TXJHpG4Yu9hErxqt"

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(HOST, username=USER, password=PASS, timeout=10)
print(f"Connected to {HOST}")

# Upload fetch-posts.py
sftp = ssh.open_sftp()
sftp.put(r'C:\ics\trump-btc\fetch-posts.py', '/root/trump-btc/fetch-posts.py')
sftp.close()
print("Uploaded fetch-posts.py")

def run(cmd, timeout=30):
    stdin, stdout, stderr = ssh.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode().strip()
    err = stderr.read().decode().strip()
    return out, err

# Tạo .env trên server
env_content = (
    "TRUTHSOCIAL_USERNAME=trandinhnamz\n"
    "TRUTHSOCIAL_PASSWORD=Meik9occod@\n"
)
_, _ = run(f"echo '{env_content}' > /root/trump-btc/.env")
print("Created .env")

# Test truthbrush
out, err = run("python3 -c 'import truthbrush; print(truthbrush.__version__)'")
print(f"truthbrush: {out} {err}")

# Sửa fetch-posts.py để dùng đúng path (trên server không có main/main)
patch = r"""
import sys
sys.path.insert(0, '/root/trump-btc')
"""
run(r"sed -i 's|TRUTHBRUSH_DIR = os.path.join.*|TRUTHBRUSH_DIR = \"/usr/local/lib/python3.10/dist-packages\"|' /root/trump-btc/fetch-posts.py")

# Test thực sự lấy bài Trump
print("\nTest lấy bài từ Truth Social...")
out, err = run(
    "cd /root/trump-btc && TRUTHSOCIAL_USERNAME=trandinhnamz TRUTHSOCIAL_PASSWORD='Meik9occod@' python3 -c "
    "'from truthbrush.api import Api; api = Api(); posts = list(api.pull_statuses(username=\"realDonaldTrump\", replies=False, verbose=False)); print(len(posts), \"posts\"); print(posts[0][\"id\"] if posts else \"no posts\")'",
    timeout=30
)
print("OUT:", out[:300] if out else "(empty)")
print("ERR:", err[:300] if err else "(empty)")

ssh.close()
print("\nDone!")
