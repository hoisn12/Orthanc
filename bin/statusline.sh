#!/bin/bash
# Claude Code statusline script for orthanc
# Receives JSON from stdin, posts to monitor server, outputs status text
PORT="${ORTHANC_PORT:-7432}"
INPUT=$(cat)

# Post full data to monitor server (background, non-blocking)
curl -s -X POST "http://localhost:${PORT}/api/statusline" \
  -H "Content-Type: application/json" \
  -d "$INPUT" > /dev/null 2>&1 &

# Extract fields for statusline display
MODEL=$(echo "$INPUT" | jq -r '.model.display_name // "?"')
COST=$(echo "$INPUT" | jq -r '.cost.total_cost_usd // 0')
CTX=$(echo "$INPUT" | jq -r '.context_window.used_percentage // 0')
RL5H=$(echo "$INPUT" | jq -r '.rate_limits.five_hour.used_percentage // empty')

if [ -n "$RL5H" ]; then
  printf "[%s] $%.4f | ctx %s%% | rl %s%%" "$MODEL" "$COST" "$CTX" "$RL5H"
else
  printf "[%s] $%.4f | ctx %s%%" "$MODEL" "$COST" "$CTX"
fi
