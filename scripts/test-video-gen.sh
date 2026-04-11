#!/bin/bash
# Test video generation via Replicate API
# Usage: ./scripts/test-video-gen.sh [prompt]
# If no prompt given, uses a default test prompt.

set -e

HOST="$PRODUCTION_SERVER"
PASS="$PRODUCTION_PASS"
DEFAULT_PROMPT="a cat playing piano in a jazz club, cinematic lighting"
ACTION="${1:-test}"

# Deploy a file if requested
if [[ "$ACTION" == "deploy" && -n "$2" ]]; then
    FILE="$2"
    PROMPT="${3:-$DEFAULT_PROMPT}"
    echo "=== Deploying $FILE ==="
    sshpass -p "$PASS" scp "$FILE" "root@${HOST}:$PRODUCTION_PATH/$FILE"
    echo "=== Restarting PM2 ==="
    sshpass -p "$PASS" ssh "root@${HOST}" "cd $PRODUCTION_PATH && source ~/.nvm/nvm.sh && nvm use 20 && pm2 restart ecosystem.config.cjs" 2>&1 | tail -3
    echo "=== Waiting for web UI startup (up to 3 min) ==="
    for i in $(seq 1 18); do
        RESP=$(curl -s -o /dev/null -w "%{http_code}" "http://${HOST}/api/auth/login" -X POST -H 'Content-Type: application/json' -d '{"password":"lanagent"}' --max-time 5 2>/dev/null || echo "000")
        if [[ "$RESP" == "200" ]]; then
            echo "Web UI ready after ~$((i*10))s"
            break
        fi
        echo "  Waiting... (${i}/18, status=$RESP)"
        sleep 10
    done
fi

# Set prompt for test-only mode (action=test, prompt=$2)
if [[ "$ACTION" == "test" ]]; then
    PROMPT="${2:-$DEFAULT_PROMPT}"
fi
PROMPT="${PROMPT:-$DEFAULT_PROMPT}"

# Get JWT token
echo "=== Getting auth token ==="
TOKEN=$(curl -s -X POST "http://${HOST}/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d '{"password": "lanagent"}' --max-time 10 | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")
echo "Token: ${TOKEN:0:20}..."

# Test video generation
echo ""
echo "=== Testing video generation ==="
echo "Prompt: $PROMPT"
echo "This may take 3-5 minutes..."
echo ""

RESULT=$(curl -s -X POST "http://${HOST}/api/media/video/generate" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"prompt\": \"$PROMPT\"}" \
  --max-time 600)

echo "$RESULT" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    success = data.get('success')
    print('Success:', success)
    if success:
        # Check if video is base64 data URI
        video = data.get('video', '')
        if isinstance(video, str) and video.startswith('data:video/'):
            # base64 data URI
            import base64
            header, b64data = video.split(',', 1)
            raw = base64.b64decode(b64data)
            size_mb = len(raw) / 1024 / 1024
            print(f'Video: {size_mb:.1f}MB ({header.split(\";\")[0]})')
        elif isinstance(video, dict):
            result = data.get('result', video)
            print('Provider:', result.get('provider'))
            print('Model:', result.get('model'))
            print('Cost: \$' + str(result.get('cost', 'N/A')))
        else:
            print('Video type:', type(video).__name__, str(video)[:100])
        # Also check result key
        result = data.get('result', {})
        if result and isinstance(result, dict):
            print('Provider:', result.get('provider', 'N/A'))
            print('Model:', result.get('model', 'N/A'))
            print('Cost:', result.get('cost', 'N/A'))
    else:
        print('Error:', data.get('error', 'Unknown'))
        print('Detail:', json.dumps(data)[:500])
except Exception as e:
    print('Parse error:', e)
"

echo ""
echo "=== Checking logs ==="
sshpass -p "$PASS" ssh "root@${HOST}" "grep -i 'replicate\|video' $PRODUCTION_PATH/logs/all-activity.log | tail -10"
