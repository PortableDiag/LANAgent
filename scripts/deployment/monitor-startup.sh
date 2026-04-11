#!/bin/bash

# Monitor agent startup in real-time

SERVER_IP="$PRODUCTION_SERVER"
SERVER_USER="root"
SERVER_PASS="$PRODUCTION_PASS"

echo "📊 Monitoring Agent Startup"
echo "=========================="
echo ""

sshpass -p "$SERVER_PASS" ssh $SERVER_USER@$SERVER_IP << 'MONITOR_STARTUP'
#!/bin/bash

echo "→ Restarting agent and monitoring startup..."
echo ""

# Restart and immediately follow logs
pm2 restart lan-agent && pm2 logs lan-agent --lines 0 &
LOG_PID=$!

# Let it run for 10 seconds
sleep 10

# Kill the log process
kill $LOG_PID 2>/dev/null

echo ""
echo "→ Checking final status:"
echo ""

# Check if Web UI is running
echo "Port ${AGENT_PORT:-80} status:"
netstat -tlnp | grep :${AGENT_PORT:-80} || echo "Web UI not listening on port ${AGENT_PORT:-80}"

echo ""
echo "Interfaces started:"
pm2 logs lan-agent --lines 100 --nostream | grep "Starting interface:" | tail -10

echo ""
echo "Web Interface logs:"
pm2 logs lan-agent --lines 100 --nostream | grep -i "web interface" | tail -10

echo ""
echo "PM2 Status:"
pm2 list

MONITOR_STARTUP