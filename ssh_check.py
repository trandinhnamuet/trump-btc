import paramiko

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect('160.22.161.44', username='root', password='qcP7TXJHpG4Yu9hErxqt', timeout=15)

print('=== .env hien tai ===')
stdin, stdout, stderr = client.exec_command('cat ~/trump-btc/.env')
print(stdout.read().decode())

print('=== Install curl_cffi ===')
stdin, stdout, stderr = client.exec_command('pip3 install curl_cffi 2>&1 | tail -3', timeout=60)
print(stdout.read().decode())

print('=== Test API (no token) ===')
test_cmd = (
    'python3 -c "'
    'from curl_cffi import requests; '
    'r = requests.get(\'https://truthsocial.com/api/v1/accounts/107780257626128497/statuses\', impersonate=\'chrome123\'); '
    'print(r.status_code); print(r.text[:300])'
    '"'
)
stdin, stdout, stderr = client.exec_command(test_cmd, timeout=30)
out = stdout.read().decode()
err = stderr.read().decode()
print(out or err)

print('=== node version ===')
stdin, stdout, stderr = client.exec_command('node --version; npm --version')
print(stdout.read().decode())

client.close()
print('Done.')
