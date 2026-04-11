# Custom Trading Strategies Guide

This guide explains how to create, import, export, and manage custom trading strategies in LANAgent.

## Table of Contents

1. [Overview](#overview)
2. [Strategy Types](#strategy-types)
3. [Creating Rule-Based Strategies](#creating-rule-based-strategies)
4. [Available Indicators](#available-indicators)
5. [Condition Operators](#condition-operators)
6. [Actions](#actions)
7. [Import/Export](#importexport)
8. [Examples](#examples)
9. [Simulation Mode](#simulation-mode)
10. [Editing Existing Strategies](#editing-existing-strategies)

---

## Overview

LANAgent supports two types of trading strategies:

1. **Built-in Strategies** - Pre-coded strategies like `dollar_maximizer`, `token_trader`, `dca`, etc.
2. **Rule-Based Strategies** - Custom strategies you define using declarative JSON rules

Rule-based strategies let you create custom trading logic without writing code. You define conditions and actions in JSON format, and the system evaluates them automatically.

---

## Strategy Types

### Built-in Strategies

| Strategy | Description |
|----------|-------------|
| `native_maximizer` | Buy low, sell high based on price thresholds |
| `dollar_maximizer` | Maximize USD value with regime detection |
| `token_trader` | Trade any ERC20 token with grid/DCA/trailing stops |
| `dca` | Dollar-cost averaging on schedule |
| `grid_trading` | Grid trading at price levels |
| `mean_reversion` | Trade based on deviation from moving average |
| `momentum` | Follow price momentum trends |
| `volatility_adjusted` | Adjust thresholds based on market volatility |
| `rule_based` | Custom user-defined rules |

### Rule-Based Strategy

The `rule_based` strategy type lets you define your own trading logic using conditions and actions.

---

## Creating Rule-Based Strategies

### Basic Structure

```json
{
  "formatVersion": "1.0.0",
  "metadata": {
    "name": "My Custom Strategy",
    "description": "Description of what this strategy does",
    "author": "Your Name",
    "tags": ["custom", "swing-trading"]
  },
  "strategy": {
    "type": "rule_based",
    "enabled": true,
    "config": {
      "displayName": "My Custom Strategy",
      "networks": ["bsc", "ethereum"],
      "simulation": {
        "enabled": true
      },
      "rules": [
        {
          "id": "rule_1",
          "name": "Example Rule",
          "enabled": true,
          "priority": 1,
          "conditions": {
            "indicator": "price_change_24h",
            "lessThan": -5
          },
          "action": {
            "type": "buy",
            "amount": { "percent": 10 }
          },
          "cooldown": { "hours": 24 }
        }
      ]
    }
  }
}
```

### Rule Structure

Each rule has these fields:

| Field | Required | Description |
|-------|----------|-------------|
| `id` | Yes | Unique identifier for the rule |
| `name` | Yes | Human-readable name |
| `enabled` | No | Set to `false` to disable (default: true) |
| `priority` | No | Lower = higher priority, first match wins |
| `conditions` | Yes | What must be true for rule to trigger |
| `action` | Yes | What to do when conditions match |
| `cooldown` | No | Time to wait before rule can trigger again |
| `filters` | No | Limit rule to specific assets/networks |

---

## Available Indicators

### Price Indicators

| Indicator | Type | Description |
|-----------|------|-------------|
| `price` | number | Current price in USD |
| `price_change_1h` | number | Price change last hour (%) |
| `price_change_24h` | number | Price change last 24 hours (%) |
| `price_change_7d` | number | Price change last 7 days (%) |
| `price_vs_baseline` | number | Change from strategy baseline (%) |
| `high_24h` | number | 24-hour high price |
| `low_24h` | number | 24-hour low price |
| `price_vs_high_24h` | number | Current vs 24h high (%) |
| `price_vs_low_24h` | number | Current vs 24h low (%) |

### Time Indicators

| Indicator | Type | Description |
|-----------|------|-------------|
| `hour_of_day` | number | Hour (0-23, UTC) |
| `day_of_week` | string | monday, tuesday, etc. |
| `day_of_month` | number | Day (1-31) |
| `month` | string | january, february, etc. |
| `is_weekend` | boolean | True on Saturday/Sunday |
| `week_of_year` | number | Week number (1-52) |
| `quarter` | number | Quarter (1-4) |
| `is_us_market_hours` | boolean | Approximate US market hours |
| `is_asian_market_hours` | boolean | Approximate Asian market hours |

### Moon Indicators

| Indicator | Type | Description |
|-----------|------|-------------|
| `moon_phase` | string | new, waxing_crescent, first_quarter, waxing_gibbous, full, waning_gibbous, last_quarter, waning_crescent |
| `moon_illumination` | number | Illumination (0-100%) |
| `days_until_full_moon` | number | Days until next full moon |
| `days_since_full_moon` | number | Days since last full moon |
| `days_until_new_moon` | number | Days until next new moon |
| `is_full_moon` | boolean | True within 1 day of full moon |
| `is_new_moon` | boolean | True within 1 day of new moon |
| `is_moon_waxing` | boolean | Moon is growing |
| `is_moon_waning` | boolean | Moon is shrinking |

### Position Indicators

| Indicator | Type | Description |
|-----------|------|-------------|
| `in_position` | boolean | True if holding native asset |
| `in_stablecoin` | boolean | True if holding stablecoin |
| `position_size` | number | Position in asset units |
| `stablecoin_balance` | number | Stablecoin balance (USD) |
| `entry_price` | number | Entry price of position |
| `unrealized_pnl` | number | Unrealized P&L in USD |
| `unrealized_pnl_percent` | number | Unrealized P&L as % |
| `time_in_position_hours` | number | Hours since entry |
| `minutes_since_last_trade` | number | Minutes since last trade |
| `total_pnl` | number | Total realized P&L |
| `daily_pnl` | number | Today's realized P&L |
| `trades_executed` | number | Number of trades executed |
| `position_value` | number | Current position value in USD |

### Technical Indicators

| Indicator | Type | Description |
|-----------|------|-------------|
| `rsi` | number | 14-period RSI (0-100) |
| `rsi_14` | number | 14-period RSI |
| `rsi_7` | number | 7-period RSI (more sensitive) |
| `ma_20` | number | 20-period Simple Moving Average |
| `ma_50` | number | 50-period SMA |
| `ma_200` | number | 200-period SMA |
| `ema_12` | number | 12-period EMA |
| `ema_26` | number | 26-period EMA |
| `price_vs_ma_20` | number | Price vs MA20 (%) |
| `price_vs_ma_50` | number | Price vs MA50 (%) |
| `macd` | number | MACD line value |
| `macd_histogram` | number | MACD histogram |
| `bollinger_upper` | number | Upper Bollinger Band |
| `bollinger_lower` | number | Lower Bollinger Band |
| `bollinger_middle` | number | Middle BB (20-SMA) |
| `bollinger_position` | number | Position in BB (0-100) |
| `volatility` | number | Price volatility (%) |
| `trend` | string | uptrend, downtrend, sideways |

### Market Indicators

| Indicator | Type | Description |
|-----------|------|-------------|
| `fear_greed_index` | number | Fear & Greed (0-100) |
| `gas_price_gwei` | number | ETH gas price in gwei |
| `gas_price_bsc` | number | BSC gas price in gwei |
| `is_gas_cheap` | boolean | Gas below average |
| `volume_24h` | number | 24h trading volume |
| `volume_change_24h` | number | Volume change (%) |
| `market_regime` | string | bull, bear, sideways, etc. |
| `is_bull_market` | boolean | Apparent bull market |
| `is_bear_market` | boolean | Apparent bear market |
| `network` | string | Current network |
| `asset` | string | Current asset |

---

## Condition Operators

### Comparison Operators

| Operator | Example | Description |
|----------|---------|-------------|
| `equals` | `{ "indicator": "moon_phase", "equals": "full" }` | Exact match |
| `notEquals` | `{ "indicator": "trend", "notEquals": "bear" }` | Not equal |
| `greaterThan` | `{ "indicator": "price", "greaterThan": 700 }` | Greater than |
| `lessThan` | `{ "indicator": "rsi", "lessThan": 30 }` | Less than |
| `greaterOrEqual` | `{ "indicator": "rsi", "greaterOrEqual": 70 }` | Greater or equal |
| `lessOrEqual` | `{ "indicator": "price", "lessOrEqual": 600 }` | Less or equal |
| `between` | `{ "indicator": "rsi", "between": [30, 70] }` | Between range |
| `in` | `{ "indicator": "day_of_week", "in": ["monday", "friday"] }` | In set |
| `notIn` | `{ "indicator": "moon_phase", "notIn": ["new"] }` | Not in set |
| `contains` | `{ "indicator": "tags", "contains": "volatile" }` | Contains value |
| `matches` | `{ "indicator": "asset", "matches": "^BN" }` | Regex match |

### Logical Combinators

**AND (all must be true):**
```json
{
  "all": [
    { "indicator": "price_change_24h", "lessThan": -5 },
    { "indicator": "rsi", "lessThan": 30 }
  ]
}
```

**OR (any can be true):**
```json
{
  "any": [
    { "indicator": "price", "lessThan": 600 },
    { "indicator": "rsi", "lessThan": 25 }
  ]
}
```

**NOT (negate condition):**
```json
{
  "not": { "indicator": "is_bear_market", "equals": true }
}
```

**Nested logic:**
```json
{
  "all": [
    { "indicator": "moon_phase", "equals": "full" },
    {
      "any": [
        { "indicator": "price_change_24h", "lessThan": -5 },
        { "indicator": "fear_greed_index", "lessThan": 25 }
      ]
    }
  ]
}
```

---

## Actions

### Buy Action

```json
{
  "type": "buy",
  "amount": { "percent": 10 },
  "message": "Optional notification message"
}
```

Amount options:
- `{ "percent": 10 }` - 10% of available stablecoins
- `{ "usd": 100 }` - Fixed $100
- `{ "units": 0.1 }` - Fixed asset units

### Sell Action

```json
{
  "type": "sell",
  "amount": { "percent": 50 },
  "message": "Taking profits"
}
```

Amount options:
- `{ "percent": 50 }` - 50% of current position
- `{ "usd": 100 }` - Sell $100 worth
- `{ "all": true }` - Sell entire position

### Alert Action (no trade)

```json
{
  "type": "alert",
  "message": "Price approaching target!"
}
```

### Set Baseline Action

```json
{
  "type": "set_baseline",
  "value": "current"
}
```

Options:
- `"current"` - Set to current price
- `{ "price": 650 }` - Set to specific price
- `{ "offset_percent": -5 }` - Set 5% below current

---

## Import/Export

### Via API

**Export a strategy:**
```bash
curl -X GET "http://localhost:3000/api/crypto/strategy/export/rule_based?type=config" \
  -H "Authorization: Bearer YOUR_TOKEN"
```

**Export all strategies:**
```bash
curl -X GET "http://localhost:3000/api/crypto/strategy/export-all" \
  -H "Authorization: Bearer YOUR_TOKEN"
```

**Import a strategy:**
```bash
curl -X POST "http://localhost:3000/api/crypto/strategy/import" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"strategy": {...}, "options": {"mode": "merge"}}'
```

### Via Telegram

**Export:**
- Ask: "export the rule_based strategy"
- Ask: "backup all my strategies"

**Import:**
- Send a `.strategy.json` file to the bot
- Follow the prompts to confirm import

### File Extensions

- `.strategy.json` - Single strategy
- `.strategies.json` - Multiple strategies (bundle)

---

## Examples

### Example 1: Price Target Strategy

Buy at specific prices, sell at targets:

```json
{
  "formatVersion": "1.0.0",
  "metadata": {
    "name": "BNB Price Targets",
    "description": "Buy at $600, sell at $700"
  },
  "strategy": {
    "type": "rule_based",
    "config": {
      "networks": ["bsc"],
      "simulation": { "enabled": true },
      "rules": [
        {
          "id": "buy_600",
          "name": "Buy at $600",
          "priority": 1,
          "conditions": {
            "all": [
              { "indicator": "price", "lessOrEqual": 600 },
              { "indicator": "in_stablecoin", "equals": true }
            ]
          },
          "action": { "type": "buy", "amount": { "percent": 50 } },
          "cooldown": { "hours": 24 }
        },
        {
          "id": "sell_700",
          "name": "Sell at $700",
          "priority": 2,
          "conditions": {
            "all": [
              { "indicator": "price", "greaterOrEqual": 700 },
              { "indicator": "in_position", "equals": true }
            ]
          },
          "action": { "type": "sell", "amount": { "percent": 100 } },
          "cooldown": { "hours": 24 }
        }
      ]
    }
  }
}
```

### Example 2: Full Moon Strategy

Buy during full moons when market is fearful:

```json
{
  "formatVersion": "1.0.0",
  "metadata": {
    "name": "Lunar Accumulator",
    "description": "Buy on full moons during fear"
  },
  "strategy": {
    "type": "rule_based",
    "config": {
      "simulation": { "enabled": true },
      "rules": [
        {
          "id": "full_moon_fear",
          "name": "Full Moon + Fear",
          "conditions": {
            "all": [
              { "indicator": "is_full_moon", "equals": true },
              { "indicator": "fear_greed_index", "lessThan": 30 },
              { "indicator": "price_change_24h", "lessThan": 0 }
            ]
          },
          "action": {
            "type": "buy",
            "amount": { "percent": 15 },
            "message": "Full moon accumulation"
          },
          "cooldown": { "hours": 48 }
        }
      ]
    }
  }
}
```

### Example 3: RSI Oversold Strategy

Buy when RSI indicates oversold:

```json
{
  "formatVersion": "1.0.0",
  "metadata": {
    "name": "RSI Reversal",
    "description": "Buy oversold, sell overbought"
  },
  "strategy": {
    "type": "rule_based",
    "config": {
      "simulation": { "enabled": true },
      "rules": [
        {
          "id": "oversold_buy",
          "name": "Oversold Buy",
          "priority": 1,
          "conditions": {
            "all": [
              { "indicator": "rsi", "lessThan": 30 },
              { "indicator": "in_stablecoin", "equals": true }
            ]
          },
          "action": { "type": "buy", "amount": { "percent": 25 } },
          "cooldown": { "hours": 12 }
        },
        {
          "id": "overbought_sell",
          "name": "Overbought Sell",
          "priority": 2,
          "conditions": {
            "all": [
              { "indicator": "rsi", "greaterThan": 75 },
              { "indicator": "in_position", "equals": true }
            ]
          },
          "action": { "type": "sell", "amount": { "percent": 50 } },
          "cooldown": { "hours": 6 }
        }
      ]
    }
  }
}
```

### Example 4: Weekend DCA

Dollar-cost average every Sunday:

```json
{
  "formatVersion": "1.0.0",
  "metadata": {
    "name": "Sunday DCA",
    "description": "Buy $50 every Sunday"
  },
  "strategy": {
    "type": "rule_based",
    "config": {
      "simulation": { "enabled": true },
      "rules": [
        {
          "id": "sunday_buy",
          "name": "Sunday DCA",
          "conditions": {
            "all": [
              { "indicator": "day_of_week", "equals": "sunday" },
              { "indicator": "hour_of_day", "between": [12, 14] }
            ]
          },
          "action": { "type": "buy", "amount": { "usd": 50 } },
          "cooldown": { "hours": 48 }
        }
      ]
    }
  }
}
```

---

## Simulation Mode

New strategies start in simulation mode by default. In simulation mode:

- Rules are evaluated normally
- Trades are NOT executed
- "Would have traded" is logged
- You get notified what WOULD happen

### Enable Live Trading

After testing in simulation:

1. **Via API:**
```bash
curl -X POST "http://localhost:3000/api/crypto/strategy/config/rule_based" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"simulation": {"enabled": false}}'
```

2. **Via Telegram:**
- Ask: "enable live trading for rule_based strategy"
- Ask: "turn off simulation mode"

### View Simulation History

```bash
curl -X GET "http://localhost:3000/api/crypto/strategy/info/rule_based" \
  -H "Authorization: Bearer YOUR_TOKEN"
```

---

## Editing Existing Strategies

### Edit Built-in Strategy Config

Update thresholds, percentages, etc. via API:

```bash
curl -X POST "http://localhost:3000/api/crypto/strategy/config/dollar_maximizer" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "thresholds": {
      "buy": -7,
      "sell": 5
    }
  }'
```

### Edit Rule-Based Strategy

1. Export the current strategy
2. Edit the JSON file
3. Re-import with mode "replace"

Or update specific config via API:

```bash
curl -X POST "http://localhost:3000/api/crypto/strategy/config/rule_based" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "rules": [
      {
        "id": "new_rule",
        "name": "New Rule",
        "conditions": {...},
        "action": {...}
      }
    ]
  }'
```

### Add/Remove Rules

To add a rule, include it in the rules array when updating config.

To remove a rule, set `"enabled": false` or omit it from the updated rules array.

---

## Error Handling

Configure how errors are handled:

```json
{
  "config": {
    "errorHandling": {
      "onIndicatorError": "skip_rule",
      "onRuleError": "skip_and_log",
      "onActionError": "retry_then_alert",
      "actionRetries": 3
    }
  }
}
```

Options:
- `onIndicatorError`: `skip_rule`, `use_default`, `alert_and_skip`
- `onRuleError`: `skip_and_log`, `disable_rule`, `halt_strategy`
- `onActionError`: `alert_only`, `retry_then_alert`, `queue_for_retry`

---

## Tips

1. **Start with simulation** - Always test new strategies in simulation mode first

2. **Use cooldowns** - Prevent rapid-fire trading with appropriate cooldowns

3. **Prioritize rules** - Lower priority number = evaluated first. Use priority for if/else chains

4. **Check positions** - Include `in_position` or `in_stablecoin` checks to avoid redundant trades

5. **Combine indicators** - Use `all`/`any` to create robust entry/exit signals

6. **Use filters** - Limit rules to specific networks or assets when needed

7. **Monitor health** - Check strategy health endpoint for error rates

8. **Export backups** - Regularly export your strategies as backups

---

## Getting Help

- View this guide: Ask "show me the strategy guide"
- List indicators: `GET /api/crypto/strategy/capabilities`
- Check strategy health: `GET /api/crypto/strategy/info/rule_based`
- View simulation logs: Ask "show rule_based simulation history"
