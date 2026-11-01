#!/bin/bash
# Nightly backup: tars $BACKUP_SRC into $BACKUP_DEST/backup-YYYY-MM-DD.tar.gz and prunes old ones.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=/dev/null
source config/backup.env
[ -d "$BACKUP_SRC" ] || { echo "backup: source dir '$BACKUP_SRC' not found" >&2; exit 1; }
[ -d "$BACKUP_DEST" ] || { echo "backup: destination dir '$BACKUP_DEST' not found" >&2; exit 1; }
out="$BACKUP_DEST/backup-$(date +%F).tar.gz"
tar -czf "$out" "$BACKUP_SRC"
find "$BACKUP_DEST" -name 'backup-*.tar.gz' -mtime +"$BACKUP_KEEP_DAYS" -print | while read -r old; do
	echo "backup: pruning $old"
	rm -f -- "$old"
done
echo "backup: wrote $out"
