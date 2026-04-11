#!/bin/bash
# Quick comprehensive crypto system check
SERVER="$PRODUCTION_SERVER"
PASS="$PRODUCTION_PASS"
KEY="${LANAGENT_API_KEY:-your-api-key}"
LOGDIR="$PRODUCTION_PATH/logs"

ssh_cmd() { sshpass -p "$PASS" ssh -o StrictHostKeyChecking=no root@$SERVER "$1" 2>/dev/null; }
api_get() { curl -s "http://$SERVER$1" -H "x-api-key: $KEY" 2>/dev/null; }

echo "========================================="
echo "  CRYPTO SYSTEM CHECKUP - $(date '+%Y-%m-%d %H:%M')"
echo "========================================="

# 1. Process health
echo ""
echo "--- PM2 Process ---"
ssh_cmd "pm2 list 2>/dev/null | grep lan-agent"

# 2. Strategy status summary
echo ""
echo "--- Strategy Positions ---"
api_get "/api/crypto/strategy/status" | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
    dm = d.get("strategyInfo", {}).get("state", {}).get("positions", {})
    print("DOLLAR MAXIMIZER:")
    for net, pos in dm.items():
        stable = pos.get("stablecoinAmount", 0)
        native = pos.get("nativeAmount", 0)
        inStable = pos.get("inStablecoin")
        print(f"  {net}: inStable={inStable}, stable=${stable:.2f}, native={native:.6f}")
    tt = d.get("tokenTraderStatus", {})
    sym = tt.get("token", {}).get("symbol", "?")
    pos2 = tt.get("position", {})
    pnl2 = tt.get("pnl", {})
    cb = tt.get("circuitBreaker", {})
    print(f"\nTOKEN TRADER ({sym}):")
    print(f"  Balance: {pos2.get(chr(116)+chr(111)+chr(107)+chr(101)+chr(110)+chr(66)+chr(97)+chr(108)+chr(97)+chr(110)+chr(99)+chr(101),0):.4f} tokens")
    tb = pos2.get("tokenBalance", 0)
    sr = pos2.get("stablecoinReserve", 0)
    ae = pos2.get("averageEntryPrice", 0)
    cp = tt.get("currentPrice", 0)
    print(f"  Tokens: {tb:.4f}, Reserve: ${sr:.2f}")
    print(f"  Entry: ${ae:.6f}, Current: ${cp:.6f}")
    chg = ((cp - ae) / ae * 100) if ae > 0 else 0
    print(f"  Position change: {chg:+.2f}%")
    print(f"  Regime: {tt.get(chr(114)+chr(101)+chr(103)+chr(105)+chr(109)+chr(101))}")
    print(f"  Unrealized: ${pnl2.get(chr(117)+chr(110)+chr(114)+chr(101)+chr(97)+chr(108)+chr(105)+chr(122)+chr(101)+chr(100),0):.2f}")
    print(f"  Lifetime realized: ${pnl2.get(chr(108)+chr(105)+chr(102)+chr(101)+chr(116)+chr(105)+chr(109)+chr(101)+chr(82)+chr(101)+chr(97)+chr(108)+chr(105)+chr(122)+chr(101)+chr(100),0):.2f}")
    print(f"  Circuit breaker: tripped={cb.get(chr(116)+chr(114)+chr(105)+chr(112)+chr(112)+chr(101)+chr(100))}, stops={cb.get(chr(99)+chr(111)+chr(110)+chr(115)+chr(101)+chr(99)+chr(117)+chr(116)+chr(105)+chr(118)+chr(101)+chr(83)+chr(116)+chr(111)+chr(112)+chr(76)+chr(111)+chr(115)+chr(115)+chr(101)+chr(115),0)}/{cb.get(chr(109)+chr(97)+chr(120)+chr(65)+chr(108)+chr(108)+chr(111)+chr(119)+chr(101)+chr(100),3)}")
    print(f"\nOVERALL:")
    state = d.get("state", {})
    print(f"  Trades executed: {state.get(chr(116)+chr(114)+chr(97)+chr(100)+chr(101)+chr(115)+chr(69)+chr(120)+chr(101)+chr(99)+chr(117)+chr(116)+chr(101)+chr(100),0)}")
    print(f"  Active: {d.get(chr(105)+chr(115)+chr(65)+chr(99)+chr(116)+chr(105)+chr(118)+chr(101))}")
    ts = d.get("lastSuccessfulExecution", "unknown")
    print(f"  Last execution: {ts}")
except Exception as e:
    print(f"Parse error: {e}")
' 2>/dev/null

# 3. Staking
echo ""
echo "--- SKYNET Staking ---"
api_get "/api/staking/info" | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin).get("data", {})
    print(f"  Staked: {d.get(\"stakedAmount\",0):,.0f} SKYNET")
    print(f"  Wallet: {d.get(\"walletBalance\",0):,.0f} SKYNET")
    print(f"  Pending rewards: {d.get(\"pendingRewards\",0):,.0f} SKYNET")
    remaining = d.get("timeUntilEnd", 0)
    days = remaining / 86400
    print(f"  Reward epoch ends in: {days:.1f} days")
    print(f"  Reward rate: {d.get(\"rewardRate\",0):.2f} SKYNET/sec")
except Exception as e:
    print(f"Parse error: {e}")
' 2>/dev/null

# 4. Wallet balances
echo ""
echo "--- On-chain Balances ---"
ssh_cmd "grep -a 'Balance \[' $LOGDIR/all-activity.log | tail -6"
ssh_cmd "grep -a 'Stablecoin \[' $LOGDIR/all-activity.log | tail -4"

# 5. Recent trades
echo ""
echo "--- Last 10 Trades ---"
ssh_cmd "grep -aE 'TokenTrader (BUY|SELL)|DollarMaximizer.*(BUY|SELL)|Auto-sold' $LOGDIR/all-activity.log | tail -10"

# 6. Circuit breaker / stop loss history
echo ""
echo "--- Stop Losses (last 24h) ---"
ssh_cmd "grep -a 'Stop-loss\|stop-loss\|STOP-LOSS\|circuit.breaker\|CIRCUIT_BREAKER' $LOGDIR/all-activity.log | tail -10"

# 7. Residual sweep activity (verify SKYNET protection)
echo ""
echo "--- Residual Sweep (last 10) ---"
ssh_cmd "grep -a 'Residual sweep' $LOGDIR/all-activity.log | tail -10"

# 8. Portfolio value estimate
echo ""
echo "--- Portfolio Estimate ---"
api_get "/api/crypto/strategy/status" | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
    dm_pos = d.get("strategyInfo", {}).get("state", {}).get("positions", {})
    total = 0
    for net, pos in dm_pos.items():
        total += pos.get("stablecoinAmount", 0)
        native = pos.get("nativeAmount", 0)
        # Use last known price from state
    tt = d.get("tokenTraderStatus", {})
    tt_pos = tt.get("position", {})
    tb = tt_pos.get("tokenBalance", 0)
    cp = tt.get("currentPrice", 0)
    sr = tt_pos.get("stablecoinReserve", 0)
    token_val = tb * cp
    tt_total = token_val + sr
    dm_stable = sum(p.get("stablecoinAmount", 0) for p in dm_pos.values())
    print(f"  Dollar Maximizer stablecoins: ${dm_stable:.2f}")
    print(f"  Token Trader: {tb:.2f} tokens @ ${cp:.4f} = ${token_val:.2f} + ${sr:.2f} reserve = ${tt_total:.2f}")
    print(f"  Combined (excl. native/SKYNET): ${dm_stable + tt_total:.2f}")
except Exception as e:
    print(f"Parse error: {e}")
' 2>/dev/null

# 9. Fresh errors (crypto-related only)
echo ""
echo "--- Recent Crypto Errors ---"
ssh_cmd "grep -a 'ERROR.*[Cc]rypto\|ERROR.*[Ss]wap\|ERROR.*[Tt]oken\|ERROR.*[Ss]trat' $LOGDIR/errors.log | tail -5"

echo ""
echo "--- Dust Abandonment Loop Check ---"
ssh_cmd "grep -ac 'Abandoning dust position' $LOGDIR/all-activity.log"
ssh_cmd "grep -a 'Abandoning dust position' $LOGDIR/all-activity.log | tail -3"

echo ""
echo "--- Strategy Heartbeat (last 3 cycles) ---"
ssh_cmd "grep -a 'Crypto heartbeat' $LOGDIR/all-activity.log | tail -3"

echo ""
echo "========================================="
echo "  CHECK COMPLETE"
echo "========================================="
