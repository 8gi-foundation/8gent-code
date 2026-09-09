#!/bin/sh
# Test double for afplay: records the wav path it was asked to play, then
# pretends to play for FAKE_PLAYER_SLEEP seconds (default 0.1).
if [ -n "$FAKE_PLAYER_LOG" ]; then
	echo "$1" >> "$FAKE_PLAYER_LOG"
fi
sleep "${FAKE_PLAYER_SLEEP:-0.1}"
