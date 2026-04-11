#!/bin/bash
# Plugin test sweep — edit TEST_CASES and re-run
HOST="$PRODUCTION_SERVER"
API_KEY="${LANAGENT_API_KEY:-your-api-key}"

call_plugin() {
  local label="$1"
  local payload="$2"
  echo ""
  echo "=== $label ==="
  result=$(curl -s --max-time 20 -X POST "http://$HOST/api/plugin" \
    -H 'Content-Type: application/json' \
    -H "X-API-Key: $API_KEY" \
    -d "$payload")

  success=$(echo "$result" | python3 -c "import sys,json; print(json.load(sys.stdin).get('success',''))" 2>/dev/null)
  summary=$(echo "$result" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('result','')[:200] if d.get('result') else d.get('error','NO RESULT'))" 2>/dev/null)

  if [ "$success" = "True" ]; then
    echo "  PASS: $summary"
  else
    echo "  FAIL: $summary"
  fi
}

echo "========================================="
echo " LANAgent Plugin Test Sweep"
echo "========================================="

# --- Calibre ---
call_plugin "Calibre: search_books (Dune)" \
  '{"plugin":"calibre","action":"search_books","query":"Dune"}'

call_plugin "Calibre: books_by_author (Asimov)" \
  '{"plugin":"calibre","action":"books_by_author","author":"Asimov"}'

call_plugin "Calibre: books_by_tag (Fiction)" \
  '{"plugin":"calibre","action":"books_by_tag","tag":"Fiction"}'

call_plugin "Calibre: library_stats" \
  '{"plugin":"calibre","action":"library_stats"}'

call_plugin "Calibre: browse_categories" \
  '{"plugin":"calibre","action":"browse_categories"}'

call_plugin "Calibre: recent_books" \
  '{"plugin":"calibre","action":"recent_books","limit":5}'

# --- Jellyfin ---
call_plugin "Jellyfin: get_server_info" \
  '{"plugin":"jellyfin","action":"get_server_info"}'

call_plugin "Jellyfin: get_libraries" \
  '{"plugin":"jellyfin","action":"get_libraries"}'

call_plugin "Jellyfin: search_media (Batman)" \
  '{"plugin":"jellyfin","action":"search_media","query":"Batman"}'

call_plugin "Jellyfin: get_seasons by name (These Woods are Haunted)" \
  '{"plugin":"jellyfin","action":"get_seasons","name":"These Woods are Haunted"}'

call_plugin "Jellyfin: get_users" \
  '{"plugin":"jellyfin","action":"get_users"}'

call_plugin "Jellyfin: get_sessions" \
  '{"plugin":"jellyfin","action":"get_sessions"}'

# --- Radarr ---
call_plugin "Radarr: get_movies (limit 5)" \
  '{"plugin":"radarr","action":"get_movies","limit":5}'

call_plugin "Radarr: search_movie (Inception)" \
  '{"plugin":"radarr","action":"search_movie","query":"Inception"}'

# --- Sonarr ---
call_plugin "Sonarr: get_series (limit 5)" \
  '{"plugin":"sonarr","action":"get_series","limit":5}'

call_plugin "Sonarr: search_series (Game of Thrones)" \
  '{"plugin":"sonarr","action":"search_series","query":"Game of Thrones"}'

# --- Lidarr ---
call_plugin "Lidarr: get_artists (limit 5)" \
  '{"plugin":"lidarr","action":"get_artists","limit":5}'

call_plugin "Lidarr: search_artist (Metallica)" \
  '{"plugin":"lidarr","action":"search_artist","query":"Metallica"}'

# --- Readarr ---
call_plugin "Readarr: get_books (limit 5)" \
  '{"plugin":"readarr","action":"get_books","limit":5}'

call_plugin "Readarr: search_author (King)" \
  '{"plugin":"readarr","action":"search_author","query":"King"}'

# --- Prowlarr ---
call_plugin "Prowlarr: get_indexers" \
  '{"plugin":"prowlarr","action":"get_indexers"}'

call_plugin "Prowlarr: search (linux)" \
  '{"plugin":"prowlarr","action":"search","query":"linux"}'

echo ""
echo "========================================="
echo " Test sweep complete"
echo "========================================="
