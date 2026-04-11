#!/bin/bash
# Quick syntax check and deploy for development iteration
# Usage: ./scripts/dev-check-deploy.sh [file1 file2 ...]
# If no files specified, uses deploy-quick.sh auto-detection

set -e
cd "$(dirname "$0")/.."

source ~/.nvm/nvm.sh 2>/dev/null
nvm use 20 2>/dev/null

# Collect JS files to check
FILES=("$@")

if [ ${#FILES[@]} -eq 0 ]; then
    echo "No files specified - running deploy-quick.sh (auto-detect)..."
    echo ""
    # Syntax check all recently modified JS files
    MODIFIED=$(find src/ -name "*.js" -newer scripts/deployment/.last-deploy -type f 2>/dev/null)
    if [ -n "$MODIFIED" ]; then
        echo "Syntax checking modified files..."
        FAIL=0
        while IFS= read -r f; do
            if node --check "$f" 2>/dev/null; then
                echo "  OK: $f"
            else
                echo "  FAIL: $f"
                FAIL=1
            fi
        done <<< "$MODIFIED"
        if [ "$FAIL" -eq 1 ]; then
            echo "Syntax errors found! Aborting deploy."
            exit 1
        fi
        echo ""
    fi
    exec ./scripts/deployment/deploy-quick.sh
else
    echo "Syntax checking specified files..."
    FAIL=0
    for f in "${FILES[@]}"; do
        if [[ "$f" == *.js ]]; then
            if node --check "$f" 2>/dev/null; then
                echo "  OK: $f"
            else
                echo "  FAIL: $f"
                FAIL=1
            fi
        fi
    done
    if [ "$FAIL" -eq 1 ]; then
        echo "Syntax errors found! Aborting deploy."
        exit 1
    fi
    echo ""
    exec ./scripts/deployment/deploy-files.sh "${FILES[@]}"
fi
