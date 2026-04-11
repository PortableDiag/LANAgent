#!/bin/bash
# Dry.AI Plugin Test Suite
# Tests all plugin operations against production
set -euo pipefail

HOST="${LANAGENT_HOST:-http://localhost:3000}"
API_KEY="<api_key>"
PASS=0
FAIL=0
SPACE_ID=""
ITEM_ID=""
FOLDER_ID=""

api() {
  local action="$1"
  shift
  # Build JSON body from action + extra key=value pairs
  local body="{\"plugin\":\"dry-ai\",\"action\":\"$action\""
  for kv in "$@"; do
    local key="${kv%%=*}"
    local val="${kv#*=}"
    body="$body,\"$key\":\"$val\""
  done
  body="$body}"

  curl -s --max-time 120 -X POST "$HOST/api/plugin" \
    -H 'Content-Type: application/json' \
    -H "X-API-Key: $API_KEY" \
    -d "$body"
}

check() {
  local result="$1"
  local label="$2"
  local success
  success=$(echo "$result" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('success',''))" 2>/dev/null || echo "")

  if [ "$success" = "True" ] || [ "$success" = "true" ]; then
    echo "  [PASS] $label"
    PASS=$((PASS+1))
  else
    echo "  [FAIL] $label"
    echo "    Response: $(echo "$result" | head -c 200)"
    FAIL=$((FAIL+1))
  fi
}

extract() {
  echo "$1" | python3 -c "
import sys, json
d = json.load(sys.stdin)
path = '$2'.split('.')
for p in path:
    if isinstance(d, dict):
        d = d.get(p, {})
    elif isinstance(d, list) and p.isdigit():
        d = d[int(p)]
    else:
        d = ''
        break
print(d if isinstance(d, str) else json.dumps(d))
" 2>/dev/null
}

echo "=== Dry.AI Plugin Test Suite ==="
echo ""

# --- Auth ---
echo "--- Auth ---"
result=$(api status)
check "$result" "status"

# --- Help (no auth needed) ---
echo ""
echo "--- Help ---"
result=$(api help "query=what are spaces")
check "$result" "help"

# --- List Spaces ---
echo ""
echo "--- List Spaces ---"
result=$(api listSpaces)
check "$result" "listSpaces"
# Try to get the space ID from the result
SPACE_ID=$(extract "$result" "spaces.items.0.ID" 2>/dev/null || echo "")
if [ -z "$SPACE_ID" ]; then
  # Create a space first
  echo "  (No spaces found, creating one...)"
  result=$(api createSpace "query=Test Space for Plugin Validation")
  check "$result" "createSpace"
  SPACE_ID=$(extract "$result" "items.0.ID" 2>/dev/null || echo "")
fi
echo "  Using space: $SPACE_ID"

# --- Create Folder ---
echo ""
echo "--- Create Folder ---"
result=$(api createFolder "query=Test Subfolder" "folder=$SPACE_ID")
check "$result" "createFolder"
FOLDER_ID=$(extract "$result" "items.0.ID" 2>/dev/null || echo "")
echo "  Created folder: $FOLDER_ID"

# --- Create Item ---
echo ""
echo "--- Create Item ---"
result=$(api createItem "query=Test note from LANAgent plugin validation" "folder=$SPACE_ID")
check "$result" "createItem"
ITEM_ID=$(extract "$result" "items.0.ID" 2>/dev/null || echo "")
echo "  Created item: $ITEM_ID"

# --- Create Type ---
echo ""
echo "--- Create Type ---"
result=$(api createType "query=TestBug with fields title severity status" "folder=$SPACE_ID")
check "$result" "createType"

# --- Import Items (batch) ---
echo ""
echo "--- Import Items ---"
result=$(api importItems "query=Save these notes: First note about apples. Second note about bananas. Third note about cherries." "folder=$SPACE_ID")
check "$result" "importItems"

# --- Search ---
echo ""
echo "--- Search ---"
result=$(api search "query=test note" "folder=$SPACE_ID")
check "$result" "search"

# --- List Items ---
echo ""
echo "--- List Items ---"
result=$(api listItems "folder=$SPACE_ID")
check "$result" "listItems"

# --- Get Item ---
echo ""
echo "--- Get Item ---"
if [ -n "$ITEM_ID" ] && [ "$ITEM_ID" != "{}" ]; then
  result=$(api getItem "itemId=$ITEM_ID")
  check "$result" "getItem"
else
  echo "  [SKIP] getItem (no item ID)"
fi

# --- Update Item ---
echo ""
echo "--- Update Item ---"
if [ -n "$ITEM_ID" ] && [ "$ITEM_ID" != "{}" ]; then
  result=$(api updateItem "itemId=$ITEM_ID" "query=Updated title to Plugin Test Complete")
  check "$result" "updateItem"
else
  echo "  [SKIP] updateItem (no item ID)"
fi

# --- Update Space ---
echo ""
echo "--- Update Space ---"
if [ -n "$SPACE_ID" ] && [ "$SPACE_ID" != "{}" ]; then
  result=$(api updateSpace "itemId=$SPACE_ID" "query=Update description to Plugin test space")
  check "$result" "updateSpace"
else
  echo "  [SKIP] updateSpace (no space ID)"
fi

# --- Update Folder ---
echo ""
echo "--- Update Folder ---"
if [ -n "$FOLDER_ID" ] && [ "$FOLDER_ID" != "{}" ]; then
  result=$(api updateFolder "itemId=$FOLDER_ID" "query=Rename to Archived Items")
  check "$result" "updateFolder"
else
  echo "  [SKIP] updateFolder (no folder ID)"
fi

# --- Share Item ---
echo ""
echo "--- Share Item ---"
if [ -n "$ITEM_ID" ] && [ "$ITEM_ID" != "{}" ]; then
  result=$(api shareItem "itemId=$ITEM_ID" "query=share this item")
  check "$result" "shareItem"
else
  echo "  [SKIP] shareItem (no item ID)"
fi

# --- Prompt ---
echo ""
echo "--- Prompt ---"
result=$(api prompt "query=summarize items" "folder=$SPACE_ID")
check "$result" "prompt"

# --- Report ---
echo ""
echo "--- Report ---"
result=$(api report "query=list all items" "folder=$SPACE_ID")
check "$result" "report"

# --- Create App Space ---
echo ""
echo "--- Create App Space ---"
result=$(api createAppSpace "name=Test Fitness Tracker" "prompt=Track workouts with exercises sets reps and weight")
check "$result" "createAppSpace"

# --- Delete Item ---
echo ""
echo "--- Delete Item ---"
if [ -n "$ITEM_ID" ] && [ "$ITEM_ID" != "{}" ]; then
  result=$(api deleteItem "itemId=$ITEM_ID")
  check "$result" "deleteItem"
else
  echo "  [SKIP] deleteItem (no item ID)"
fi

# --- Summary ---
echo ""
echo "================================"
echo "Results: $PASS passed, $FAIL failed"
echo "================================"

exit $FAIL
