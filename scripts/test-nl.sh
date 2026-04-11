#!/bin/bash
# Get full error with stack trace
sshpass -p "$PRODUCTION_PASS" ssh "$PRODUCTION_USER@$PRODUCTION_SERVER" "grep -a -A10 '18:03:47.*fal-ai video generation failed' $PRODUCTION_PATH/logs/all-activity.log | head -15"
echo "---"
sshpass -p "$PRODUCTION_PASS" ssh "$PRODUCTION_USER@$PRODUCTION_SERVER" "grep -a -A10 '18:03:47.*fal-ai video generation failed' $PRODUCTION_PATH/logs/errors.log | head -15"
