#!/usr/bin/env bash
# Harden the Hetzner vessel at james.8gentos.com.
# Idempotent. Runs in this order:
#   1. Create non-root user 'james' with NOPASSWD sudo + the existing SSH key
#   2. Verify james SSH key works in a fresh session
#   3. Install fail2ban (sshd jail enabled by default)
#   4. Confirm UFW state (22/80/443 only)
#   5. Lock down sshd: PasswordAuthentication no, PermitRootLogin no
#   6. Reload sshd and verify james can still SSH in
#
# Designed to NEVER lock you out: all destructive sshd changes happen only
# after the james SSH key is verified working in a parallel session.

set -euo pipefail

SSH_KEY="${SSH_KEY:-$HOME/.ssh/hetzner_8gi_ed25519}"
HOST="${HOST:-78.47.98.218}"
SSH_OPTS_BASE="-i $SSH_KEY -o StrictHostKeyChecking=no"
SSH_ROOT="ssh $SSH_OPTS_BASE root@$HOST"
SSH_JAMES="ssh $SSH_OPTS_BASE james@$HOST"

echo "[harden] (1/6) creating james user with NOPASSWD sudo + SSH key..."
$SSH_ROOT 'set -e
  id -u james >/dev/null 2>&1 || useradd -m -s /bin/bash james
  install -d -o james -g james -m 0700 /home/james/.ssh
  if ! grep -qf /root/.ssh/authorized_keys /home/james/.ssh/authorized_keys 2>/dev/null; then
    cat /root/.ssh/authorized_keys >> /home/james/.ssh/authorized_keys
  fi
  chown james:james /home/james/.ssh/authorized_keys
  chmod 600 /home/james/.ssh/authorized_keys
  echo "james ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/james
  chmod 440 /etc/sudoers.d/james
  visudo -c -f /etc/sudoers.d/james >/dev/null
  passwd -l james >/dev/null  # disable password auth for sudo (key only)
'

echo "[harden] (2/6) verifying james SSH + sudo work..."
$SSH_JAMES 'whoami && sudo -n id'

echo "[harden] (3/6) installing fail2ban..."
$SSH_ROOT 'set -e
  if ! command -v fail2ban-client >/dev/null 2>&1; then
    DEBIAN_FRONTEND=noninteractive apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq fail2ban
  fi
  cat > /etc/fail2ban/jail.d/sshd.local <<JAIL
[sshd]
enabled = true
port = ssh
filter = sshd
logpath = /var/log/auth.log
maxretry = 5
findtime = 600
bantime = 3600
JAIL
  systemctl enable fail2ban >/dev/null 2>&1
  systemctl restart fail2ban
  sleep 2
  fail2ban-client status sshd | head -10
'

echo "[harden] (4/6) confirming UFW state..."
$SSH_ROOT 'ufw status verbose | head -20'

echo "[harden] (5/6) locking down sshd..."
$SSH_ROOT 'set -e
  install -d -m 0755 /etc/ssh/sshd_config.d
  cat > /etc/ssh/sshd_config.d/99-vessel-lockdown.conf <<CFG
# vessel lockdown - applied $(date -u +%FT%TZ)
PermitRootLogin no
PasswordAuthentication no
ChallengeResponseAuthentication no
KbdInteractiveAuthentication no
UsePAM yes
PubkeyAuthentication yes
PermitEmptyPasswords no
X11Forwarding no
MaxAuthTries 3
LoginGraceTime 30
AllowUsers james
CFG
  sshd -t  # syntax check before restart
  # Ubuntu ssh.socket activation requires restart, not reload, to pick up drop-ins.
  systemctl restart ssh.socket ssh.service 2>/dev/null || systemctl restart sshd
'

echo "[harden] (6/6) verifying james SSH still works after lockdown..."
$SSH_JAMES 'echo "[harden] james SSH ok: $(whoami)@$(hostname)"'

# As a final paranoia check, confirm root SSH is now refused.
echo "[harden] verifying root SSH is now denied..."
if ssh $SSH_OPTS_BASE -o BatchMode=yes -o ConnectTimeout=5 root@$HOST 'true' 2>&1 | grep -qE "Permission denied|Connection closed|Could not"; then
  echo "[harden]   root SSH: denied (expected)"
else
  echo "[harden]   WARNING: root SSH still works - investigate"
fi

echo "[harden] done."
echo "[harden] from now on use: ssh -i $SSH_KEY james@$HOST"
