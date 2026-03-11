"""SSH helper script to run commands on remote server."""
import paramiko
import sys

HOST = "160.22.161.44"
USER = "root"
PASS = "qcP7TXJHpG4Yu9hErxqt"

def run(ssh, cmd, timeout=60):
    print(f"\n$ {cmd}")
    stdin, stdout, stderr = ssh.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode()
    err = stderr.read().decode()
    if out:
        print(out, end="")
    if err:
        print("[stderr]", err, end="")
    return out, err

def main():
    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    ssh.connect(HOST, username=USER, password=PASS, timeout=10)
    print(f"✓ Connected to {HOST}")

    commands = sys.argv[1:]
    if not commands:
        commands = ["ls", "ls trump-btc/", "python3 --version", "pip3 show truthbrush | head -2"]

    for cmd in commands:
        run(ssh, cmd)

    ssh.close()

if __name__ == "__main__":
    main()
