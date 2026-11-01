#!/bin/bash
# Nightly export: total data/orders.csv with the tier prices from config/rates.json.
cd "$(dirname "$0")" || exit 1
LOCK=run/worker.lock
WAIT=${WORKER_WAIT_SECS:-3600}
mkdir -p run out logs
waited=0
while [ -f "$LOCK" ]; do
  echo "$(date '+%F %T') waiting for $LOCK ($(tr '\n' ' ' < "$LOCK"))" >> logs/worker.log
  if [ "$waited" -ge "$WAIT" ]; then echo "worker: gave up waiting for $LOCK" >&2; exit 3; fi
  sleep 1; waited=$((waited + 1))
done
echo "pid=$$" > "$LOCK"
trap 'rm -f "$LOCK"' EXIT
if [ ! -f config/rates.json ]; then echo "worker: config/rates.json not found" >&2; exit 2; fi
awk -F'[:,]' 'NR==FNR { if ($0 ~ /"[a-z]+": *[0-9.]+/) { k=$1; gsub(/[ "{]/,"",k); rate[k]=$2+0 } ; next }
  FNR>1 { t += $2 * rate[$3] } END { printf "total=%.2f\n", t }' config/rates.json data/orders.csv > out/report.txt
echo "$(date '+%F %T') done" >> logs/worker.log
