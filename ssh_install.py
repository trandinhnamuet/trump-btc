import paramiko

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect('160.22.161.44', username='root', password='qcP7TXJHpG4Yu9hErxqt', timeout=15)

def run(cmd, timeout=60):
    print(f'$ {cmd}')
    stdin, stdout, stderr = client.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode()
    err = stderr.read().decode()
    if out: print(out.rstrip())
    if err: print('ERR:', err.rstrip())
    print()

# Cài pip nếu chưa có
run('apt-get install -y python3-pip 2>&1 | tail -5', timeout=120)
run('pip3 install curl_cffi 2>&1 | tail -5', timeout=120)

# Test API Truth Social
run(
    'python3 -c "'
    'from curl_cffi import requests; '
    'r = requests.get(\'https://truthsocial.com/api/v1/accounts/107780257626128497/statuses\', impersonate=\'chrome123\'); '
    'print(\'STATUS:\', r.status_code); print(r.text[:300])'
    '"'
)

client.close()
print('=== Done ===')
