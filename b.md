# Polymarket Live Strategy Specification: CT4 and Active Signal Slots

> Configuration snapshot: 2026-10-22 00:11 CST
> Scope: Polymarket only, excluding Predict.fun
> Purpose: exact implementation specification for reproduction on another platform

## Executive Summary

The current Polymarket deployment has two enabled accounts:

| ***\*Item\****                | ***\*Current value\****                                      |
| ----------------------------- | ------------------------------------------------------------ |
| Accounts                      | Two live accounts with identical strategy configuration      |
| Account state                 | Both `enabled=true`, `engine_running=true`                   |
| Order strategy                | `checkpoint_taker_v4` on both accounts                       |
| Slots                         | 20 per account, 40 configured slot instances total           |
| Slot composition              | 11 × 15m, 9 × 5m                                             |
| Unique signal strategy names  | 16                                                           |
| Position mode                 | Fixed 15 shares per slot                                     |
| Slot-level execution override | None; all slots inherit account-level CT4                    |
| Legacy risk flags             | `risk_enabled=true`, but all L1/L3 limits are zero           |
| Breakout guard                | Disabled on every slot                                       |
| 3-hour circuit breaker        | Disabled on every slot                                       |
| Active V6 risk manager        | Disabled                                                     |
| Account `max_daily_loss`      | 50, but the old account risk manager is not part of the active per-signal decision path |

Both accounts have the same 20 slot definitions.

## Data Contract

### 2.1 Market and bar sources

The signal engine uses OKX perpetual-swap OHLCV data:

| ***\*Data\****                | ***\*Symbol format\****                                      | ***\*Purpose\****                                       |
| ----------------------------- | ------------------------------------------------------------ | ------------------------------------------------------- |
| 5m or 15m OHLCV               | `BTC-USDT-SWAP`, `ETH-USDT-SWAP`, `SOL-USDT-SWAP`, `DOGE-USDT-SWAP` | Primary signal bars                                     |
| 1m OHLCV                      | Same symbols                                                 | Microstructure for 5m/15m signals and A-version filters |
| 15m OHLCV                     | Same symbols                                                 | Context for 5m strategies                               |
| 1H OHLCV                      | Same symbols                                                 | Context and gates for 15m strategies                    |
| BTC 15m OHLCV                 | `BTC-USDT-SWAP`                                              | Extreme-market reversal context for selected strategies |
| Polymarket YES/NO order books | Up token and Down token                                      | CT4 execution                                           |

The live loader uses 60 calendar days of K-line history and requires at least 200

rows for the primary timeframe. A local 2-second cache is used for the same

`symbol + timeframe` snapshot.

### 2.2 Closed-bar rule

For a window starting at timestamp `W`:

1. The signal bar must satisfy `bar.timestamp + bar_duration <= W`.
2. The live service waits for the just-closed bar to appear in the database.
3. Any unclosed tail is discarded.
4. A 1H context bar is usable only when

`h1.timestamp + 1h <= primary_bar.timestamp`.

1. The five or fifteen 1m bars must exactly match:

```
5m context : W, W+1m, W+2m, W+3m, W+4m
15m context: W, W+1m, ..., W+14m
```

Missing or non-contiguous 1m data causes fail-closed behavior, not fallback.

### 2.3 Freshness and continuity checks

Before generating a signal:

```
minimum primary rows = 50
allowed lag          = max(10 × bar duration, 5 minutes)
tail gap tolerance   = 1.5 × bar duration
maximum gaps         = 2 among the latest 50 bars
```

The service waits up to:

```
max(3s, 120s - elapsed_seconds_since_window_open)
```

for the expected closed bar. If the expected tail bar is unavailable, the

window is skipped.

## Reproducible Common Indicator Set

Use the following formulas and periods exactly. All calculations are causal:

the value at bar `i` uses only bars `0..i`.

| ***\*Feature\**** | ***\*Definition\****                                         |
| ----------------- | ------------------------------------------------------------ |
| `o,h,l,c,v`       | Open, high, low, close, volume of the current closed bar     |
| `EMA_n`           | Exponential MA, seed = SMA of first `n` values, `alpha=2/(n+1)` |
| `RSI_14`          | Wilder RSI                                                   |
| `ATR_14`          | Wilder ATR using true range                                  |
| `ATR_PCT`         | `100 × ATR_14 / close`                                       |
| `BB_mid`          | SMA20(close)                                                 |
| `BB_upper/lower`  | `SMA20 ± 2.0 × population_std20`                             |
| `BB_POS`          | `(close-BB_lower)/(BB_upper-BB_lower)`                       |
| `BB_WIDTH_PCT`    | `100 × (BB_upper-BB_lower)/BB_mid`                           |
| `KC_mid`          | EMA20(close)                                                 |
| `KC_upper/lower`  | `EMA20 ± 1.5 × ATR_14`                                       |
| `KC_POS`          | `(close-KC_lower)/(KC_upper-KC_lower)`                       |
| `MACD_hist`       | MACD(12,26,9), histogram = MACD line - signal line           |
| `ADX_14`          | Wilder ADX                                                   |
| `StochRSI_K/D`    | RSI14, 14-bar StochRSI, K=SMA3(rawK), D=SMA3(K)              |
| `Williams_R_14`   | `-100 × (HH14-close)/(HH14-LL14)`                            |
| `CMF_20`          | 20-bar Chaikin Money Flow                                    |
| `VWAP_DEV_20`     | `100 × (close - TP_VWAP20)/TP_VWAP20`, TP=`(h+l+c)/3`        |
| `ROC_10`          | `100 × (close-close[-10])/close[-10]`                        |

Important implementation detail: the volume average named `AvgVol20` is

***\*EMA20(volume)\****, not SMA20.

### 3.1 Bar-shape and path features

```
range         = high - low
body_ratio    = abs(close-open) / range
upper_wick    = (high-max(open,close)) / range
lower_wick    = (min(open,close)-low) / range
buy_pressure  = (close-low) / range
avg_buy_pressure_5 = mean(buy_pressure over current and previous 4 bars)
vol_ratio     = volume / EMA20(volume)
price_dev_ema20_pct = 100 × (close/EMA20-1)
price_dev_ema50_pct = 100 × (close/EMA50-1)
```

### 3.2 Continuity and range features

`ConsecCount` is signed:

```
close >= open => positive/up bar
close <  open => negative/down bar
```

Consecutive bars with the same sign produce `+N` or `-N`.

```
high_low_position_20 = (close-min(low,20))/(max(high,20)-min(low,20))
up_ratio_20          = count(close >= open, last 20) / 20
win_rate_recent_50   = count(close >= open, last 50) / 50
```

### 3.3 Volatility regime

```
vol_regime = mean(ATR_14, last 20) / mean(ATR_14, last 50)
```

### 3.4 TTM Squeeze momentum

TTM delta at bar `i`:

```
sma20    = SMA20(close)
highest20 = max(high, 20 bars)
lowest20  = min(low, 20 bars)
delta_i   = close_i - ( (highest20+lowest20)/2 + sma20 ) / 2
```

`squeeze_momentum` is an OLS linear-regression end value over the latest 20

`delta` values using the standard LazyBear/Pine `linreg(...,20,0)` convention.

### 3.5 Composite overbought score

```
ob = 0
ob += (RSI-50)/50
ob += sign(BB_POS-0.5) × abs(BB_POS-0.5)×2×0.5
ob += (StochRSI_K-50)/50 × 0.4
if Williams_R > -50:
    ob += (-Williams_R-50)/50 × 0.3
else:
    ob += (Williams_R+50)/50 × 0.3
overbought_score = clamp(ob,-1,1)
```

### 3.6 V8 confirmation count

For a proposed direction `up`:

```
confirm = 0
confirm += StochRSI_K < 30
confirm += Williams_R < -70
confirm += CMF_20 < -0.03
confirm += VWAP_DEV_20 < -0.04
confirm += overbought_score < -0.15
```

For a proposed direction `down`, replace the comparisons with:

```
StochRSI_K > 70
Williams_R > -30
CMF_20 > 0.03
VWAP_DEV_20 > 0.04
overbought_score > 0.15
```

### 3.7 5m micro-context

For the five 1m bars inside a closed 5m bar:

```
o  = open of first 1m
c  = close of last 1m
hi = max high
lo = min low

ret_last_1 = last1m.return × 100
up_ratio   = count(1m.close >= 1m.open) / 5
vol_centroid = Σ(i × volume_i) / Σ(volume_i) / 5
path_efficiency = ((c-o)/o) / Σ(abs((bar.close-bar.open)/bar.open))

micro_vwap = Σ(TP_i × volume_i) / Σ(volume_i)
micro_vwap_dev = 100 × (c/micro_vwap-1)

acceleration = 100 × (return(last 2.5m) - return(first 2.5m))
reversal_shape = ((c-lo)-(hi-c))/(hi-lo)
last_body = abs(last1m.close-last1m.open)/(last1m.high-last1m.low)

last1m_ohlc4 = (last1m.o+last1m.h+last1m.l+last1m.c)/4
head_pct = 100 × (last1m.c/last1m_ohlc4-1)
last_pos = (last1m.c-last1m.l)/(last1m.h-last1m.l)
```

Quantization used by production:

```
ret_last_1     5 decimals
up_ratio       4 decimals
vol_centroid   4 decimals
path_efficiency 4 decimals
micro_vwap_dev 4 decimals
acceleration   5 decimals
reversal_shape 4 decimals
last_body      3 decimals
head_pct       6 decimals
last_pos       4 decimals
```

### 3.8 15m micro-context

For the fifteen 1m bars inside a closed 15m bar:

```
last1_up = last1m.close >= last1m.open
last2_up = last1m.close >= last1m.open
           and previous1m.close >= previous1m.open
```

The strict 15-bar timestamp sequence is required.

### 3.9 1H context

For a primary bar starting at `t`:

1. Select the latest 1H bar satisfying `h1.timestamp + 1h <= t`.
2. Require at least 50 completed 1H bars.
3. Define:

```
H1_TREND = sign(H1_EMA20 - H1_EMA50)
H1_SPREAD_PCT = 100 × (H1_EMA20-H1_EMA50)/H1_EMA50
H1_RSI = H1_RSI14
H1_ADX = H1_ADX14
H1_Z20 = H1_PRICE_DEV_EMA20_PCT / H1_ATR_PCT
```

### 3.10 15m context for 5m strategies

The 5m path also receives the latest closed 15m context satisfying

`m15.timestamp + 15m <= primary_5m.timestamp`.

```
M15_RSI
M15_PRICE_DEV_EMA20_PCT
M15_ATR_PCT
M15_CONSEC_COUNT
M15_ADX
```

At least 50 completed 15m bars are required.

### 3.11 Legacy HTF fields

The deployed binary has:

```
HTFConfAdjustEnabled = false
```

Therefore legacy `HTFRSI`, `HTFTrend`, `HTFADX`, and related fields are not

injected in the live signal path. All HTF-dependent modifiers in V8/V10/V14

are inactive unless a reproduction explicitly enables equivalent HTF fields.

The context fields used by V18/V19 are independent and are populated as

described in sections 3.9 and 3.10.

## Per-Symbol Tuning Profiles

These parameters are used by the symbol-tuned V7/V8 and V9 gate strategies.

### 4.1 Common defaults

| ***\*Parameter\****   | ***\*Value\**** |
| --------------------- | --------------- |
| `HTFRSIPenaltyLo`     | 38              |
| `HTFRSIPenHi`         | 1.25            |
| `HTFRSIPenMid`        | 0.80            |
| `HTFRSIPenStrong`     | 0.65            |
| `VolHighBonus`        | 1.5             |
| `VolLowPenalty`       | 0.7             |
| `RSIConfirmHi/Lo`     | 65 / 25         |
| `StochContraHi/Lo`    | 70 / 30         |
| `WRMidLo/Hi`          | -60 / -40       |
| `WRMidPenalty`        | 0.75            |
| `OBNeutralRange`      | 0.10            |
| `OBNeutralPenalty`    | 0.92            |
| `ADXHighThresh`       | 35              |
| `ADXHighPenalty`      | 0.90            |
| `ConsensusMinSubConf` | 0.15            |
| `UCMinTotal`          | 3.0             |
| `UCDevThresh`         | 1.0             |
| `UCRSIHi/Lo`          | 70 / 30         |
| `UCBBHi/Lo`           | 0.90 / 0.10     |
| `UCKCHi/Lo`           | 0.92 / 0.08     |
| `UCHLHi/Lo`           | 0.92 / 0.08     |

### 4.2 Symbol overrides

| ***\*Parameter\****     | ***\*BTC\**** | ***\*ETH\**** | ***\*DOGE\**** | ***\*SOL\**** |
| ----------------------- | ------------- | ------------- | -------------- | ------------- |
| `HTFRSIPenStrong`       | 0.55          | 0.60          | 0.60           | 0.45          |
| `HTFRSIPenaltyLo`       | 40            | 30            | 33             | 36            |
| `HTFRSIPenHi`           | 1.25          | 1.05          | 1.25           | 1.15          |
| `HTFRSIPenMid`          | 0.80          | 0.80          | 0.80           | 0.75          |
| `VolHighBonus`          | 1.8           | 1.3           | 2.0            | 2.5           |
| `VolLowPenalty`         | 0.70          | 0.70          | 0.80           | 0.70          |
| `RSIConfirmHi`          | 65            | 60            | 65             | 65            |
| `StochContraHi/Lo`      | 70/30         | 70/30         | 65/35          | 70/20         |
| `WRMidLo/Hi`            | -60/-25       | -45/-30       | -60/-40        | -60/-25       |
| `WRMidPenalty`          | 0.70          | 0.75          | 0.75           | 0.70          |
| `OBNeutralPenalty`      | 0.92          | 0.88          | 0.92           | 0.92          |
| `ADXHighThresh/Penalty` | 35/0.90       | 40/0.80       | 25/0.80        | 32/0.82       |
| `ConsensusMinSubConf`   | 0.15          | 0.15          | 0.15           | 0.22          |
| `UCMinTotal`            | 4.0           | 3.0           | 4.0            | 4.0           |
| `UCRSIHi/Lo`            | 70/30         | 70/30         | 78/30          | 75/35         |
| `UCBBHi/Lo`             | 0.90/0.10     | 0.90/0.10     | 0.92/0.10      | 0.92/0.10     |
| `UCKCHi/Lo`             | 0.92/0.08     | 0.92/0.08     | 0.92/0.08      | 0.92/0.08     |
| `UCHLHi/Lo`             | 0.92/0.08     | 0.92/0.08     | 0.92/0.08      | 0.92/0.20     |

All 1H hard-gate thresholds are zero in the current deployment, so

`applyH1ExtremeGate` is inactive for the following tuned V8/V9 strategies.

## Reusable Strategy Building Blocks

### 5.1 Base anti-momentum/mean-reversion primitive

```
AM0(snapshot):
    if close <= 0 or open <= 0 or ATR_PCT <= 0:
        return direction=up, confidence=0.10

    chg = 100 × (close-open)/open
    z = abs(chg) / ATR_PCT

    if z < 0.30:
        return direction=close>open, confidence=0.05

    direction = up if chg < 0 else down
    confidence = min(z/2, 1.0)

    # V7 RSI adjustment
    if up and RSI < 25 or down and RSI > 65:
        confidence = min(confidence×1.20, 0.99)
    if up and RSI > 65 or down and RSI < 25:
        confidence = confidence×0.50

    return direction, confidence
```

### 5.2 Base Bollinger-band bounce primitive

```
BB0(snapshot):
    if BB_upper <= BB_lower or BB_mid <= 0:
        return direction=up, confidence=0

    width = BB_upper-BB_lower
    d_lower = close-BB_lower
    d_upper = BB_upper-close

    if d_lower < 0.15×width:
        return direction=up,
               confidence=min((0.15×width-d_lower)/(0.15×width),1)

    if d_upper < 0.15×width:
        return direction=down,
               confidence=min((0.15×width-d_upper)/(0.15×width),1)

    return direction=close<BB_mid, confidence=0.05

BB_V7(snapshot):
    direction, confidence = BB0(snapshot)
    if confidence <= 0.05:
        return direction, confidence
    if ADX > 35:
        confidence *= 0.85
    if direction=up and RSI < 30 or direction=down and RSI > 70:
        confidence = min(confidence×1.20,0.99)
    if direction=up and RSI > 70 or direction=down and RSI < 30:
        confidence *= 0.50
    return direction, confidence
```

### 5.3 Base consecutive-reversal primitive

```
CR0(snapshot):
    n = ConsecCount
    a = abs(n)

    if a >= 4:
        direction = up if n < 0 else down
        confidence = min((a-3)×0.20+0.60, 0.95)
        if n>0 and RSI>65 or n<0 and RSI<35:
            confidence = min(confidence+0.10,0.95)
        if n>0 and BB_POS>0.80 or n<0 and BB_POS<0.20:
            confidence = min(confidence+0.10,0.95)
        return direction, confidence

    if a == 3:
        direction = up if n < 0 else down
        confidence = 0.45
        if n>0 and RSI>60 or n<0 and RSI<40:
            confidence = 0.60
        return direction, confidence

    return direction=close>=open, confidence=0.01

CR_V7(snapshot):
    direction, confidence = CR0(snapshot)
    if confidence <= 0.05:
        return direction, confidence
    if direction=up and RSI < 35 or direction=down and RSI > 58:
        confidence = min(confidence×1.20,0.99)
    if direction=up and RSI > 58 or direction=down and RSI < 35:
        confidence *= 0.50
    return direction, confidence
```

### 5.4 Symbol-tuned V7 full-factor voting primitive

This is used by `v7_ultra_conf_a` on SOL. It is ***\*not\**** the base used by

`v8_ultra_conf`.

Call the following block `T7_FULL_FACTOR(symbol)`.

```
up_score = 0
down_score = 0

if EMA5-EMA20 normalized by ATR > 0.30: up_score += 1.0
elif < -0.30:                          down_score += 1.0

if RSI > UCRSIHi: down_score += (RSI-50)/30
elif RSI < UCRSILo: up_score += (50-RSI)/30

if BB_POS > UCBBHi: down_score += 0.7
elif BB_POS < UCBBLo: up_score += 0.7

if KC_POS > UCKCHi: down_score += 0.6
elif KC_POS < UCKCLo: up_score += 0.6

if HL_POS20 > UCHLHi: down_score += 0.5
elif HL_POS20 < UCHLLo: up_score += 0.5

if ConsecCount >= 3: down_score += 0.5
elif ConsecCount <= -3: up_score += 0.5

if AvgBuyPressure5 > 0.65: down_score += 0.4
elif AvgBuyPressure5 < 0.35: up_score += 0.4

dev_z = PriceDevEMA20 / ATR_PCT
if dev_z > UCDevThresh: down_score += 0.6
elif dev_z < -UCDevThresh: up_score += 0.6

bar_z = abs(100×(close-open)/open) / ATR_PCT
if bar_z > 1.2:
    if close>open: down_score += 0.5
    else:          up_score += 0.5

if squeeze_momentum>0 and squeeze_momentum>prev_squeeze_momentum:
    up_score += 0.4
elif squeeze_momentum<0 and squeeze_momentum<prev_squeeze_momentum:
    down_score += 0.4

total = up_score+down_score
if total < UCMinTotal:
    return direction=close>=open, confidence=0.01

direction = up if up_score>down_score else down
confidence = min(max(up_score,down_score)/4,0.90)
```

Legacy HTF post-processing is a no-op in the current deployment.

### 5.5 Symbol-tuned V8 anti-momentum

This is the base of `v8_anti_momentum_a` and

`v8_anti_momentum_a_m2`.

```
T8_AM(symbol):
    d, c = AM0(snapshot)
    if c <= 0.05:
        return d,c

    contradictions = 0
    contradictions += (up and StochRSI_K > t.StochContraHi)
                   or (down and StochRSI_K < t.StochContraLo)
    contradictions += (up and Williams_R > -10)
                   or (down and Williams_R < -90)
    contradictions += (up and overbought_score > 0.20)
                   or (down and overbought_score < -0.20)

    if contradictions >= 2: c *= 0.30
    elif contradictions == 1: c *= 0.70

    if t.WRMidLo < Williams_R < t.WRMidHi:
        c *= t.WRMidPenalty
    if -t.OBNeutralRange < overbought_score < t.OBNeutralRange:
        c *= t.OBNeutralPenalty

    supports = 0
    supports += (up and StochRSI_K < t.StochContraLo)
             or (down and StochRSI_K > t.StochContraHi)
    supports += (up and Williams_R < -70)
             or (down and Williams_R > -30)
    supports += (up and overbought_score < -0.15)
             or (down and overbought_score > 0.15)
    supports += (up and CMF < -0.03)
             or (down and CMF > 0.03)

    if supports >= 3: c = min(c×1.20,0.95)
    elif supports >= 2: c = min(c×1.10,0.95)

    c = confirm_adjust(c,d)

    if VolRatio > t.VolHighBonus: c = min(c×1.08,0.95)
    elif VolRatio < t.VolLowPenalty: c *= 0.92

    return d,c
```

`confirm_adjust`:

```
n = V8_CONFIRM_COUNT(direction)
if n <= 1: c *= 0.50
elif n == 3: c = min(c×1.10,0.95)
elif n >= 4: c = min(c×1.18,0.95)
```

### 5.6 Symbol-tuned V8 Bollinger bounce

```
T8_BB(symbol):
    d,c = BB_V7(snapshot)
    if c <= 0.10:
        return d,0.02

    contradictions = 0
    contradictions += (up and StochRSI_K > 75)
                   or (down and StochRSI_K < 25)
    contradictions += (up and Williams_R > -15)
                   or (down and Williams_R < -85)
    contradictions += (up and overbought_score > 0.25)
                   or (down and overbought_score < -0.25)

    if contradictions >= 2: c *= 0.25
    elif contradictions == 1: c *= 0.75

    if t.WRMidLo < Williams_R < t.WRMidHi: c *= 0.80
    if -t.OBNeutralRange < overbought_score < t.OBNeutralRange:
        c *= t.OBNeutralPenalty
    if ADX > t.ADXHighThresh: c *= t.ADXHighPenalty

    if up and BB_POS > 0.38: c *= 0.90
    if down and BB_POS < 0.62: c *= 0.90

    if c > 0.10 and
       ((up and KC_POS<0.10) or (down and KC_POS>0.90)):
        c = min(c×1.12,0.95)

    supports = 0
    supports += (up and StochRSI_K<30) or (down and StochRSI_K>70)
    supports += (up and overbought_score<-0.15)
             or (down and overbought_score>0.15)
    supports += (up and CMF<-0.03) or (down and CMF>0.03)
    if supports >= 2: c = min(c×1.12,0.95)

    c = confirm_adjust(c,d)

    if VolRatio > t.VolHighBonus+0.30: c = min(c×1.08,0.95)
    elif VolRatio < t.VolLowPenalty: c *= 0.88

    return d,c
```

### 5.7 Symbol-tuned V8 consecutive reversal

```
T8_CR(symbol):
    d,c = CR_V7(snapshot)
    if c <= 0.05:
        return d,c

    if ADX > t.ADXHighThresh:
        c *= t.ADXHighPenalty

    contradictions = 0
    contradictions += (up and StochRSI_K > 75)
                   or (down and StochRSI_K < 25)
    contradictions += (up and Williams_R > -15)
                   or (down and Williams_R < -85)
    contradictions += (up and overbought_score > 0.25)
                   or (down and overbought_score < -0.25)

    if contradictions >= 2: c *= 0.15
    elif contradictions == 1: c *= 0.65

    if t.WRMidLo < Williams_R < t.WRMidHi: c *= 0.70
    if -t.OBNeutralRange < overbought_score < t.OBNeutralRange:
        c *= 0.85

    supports = 0
    supports += (up and StochRSI_K < 40) or (down and StochRSI_K > 60)
    supports += (up and overbought_score < -0.15)
             or (down and overbought_score > 0.15)
    if supports >= 2: c = min(c×1.12,0.95)

    c = confirm_adjust(c,d)

    if VolRatio > t.VolHighBonus+0.30: c = min(c×1.08,0.95)
    elif VolRatio < t.VolLowPenalty: c *= 0.88

    return d,c
```

### 5.8 Symbol-tuned V9 consensus

```
T9(symbol):
    sub = [T8_AM(symbol), T8_BB(symbol), T8_CR(symbol)]
    keep subresults with confidence >= t.ConsensusMinSubConf

    if len(kept) < 2:
        return direction=close>open, confidence=0.03

    majority direction = up if up-votes > down-votes else down
    agreement = number of votes in majority direction

    if agreement < 2:
        return majority direction, confidence=0.05

    avg_conf = mean(confidence of all kept subresults)
    multiplier = 0.70 + 0.15×agreement
    if agreement == 3:
        multiplier = 0.88

    return majority direction,
           min(avg_conf×multiplier,0.95)
```

### 5.9 Legacy global V8/V9 functions used by `v14_signal_reclaim`

`v14_signal_reclaim` does not use the symbol-tuned `T8_*` functions. It uses

the following global fixed modifiers.

Legacy global V8 anti-momentum:

```
d,c = AM0(snapshot)
if c<=0.05: return d,c

contradictions =
    (up and StochRSI_K>70) or (down and StochRSI_K<30)
  + (up and Williams_R>-10) or (down and Williams_R<-90)
  + (up and overbought_score>0.20) or (down and overbought_score<-0.20)

if contradictions>=2: c*=0.30
elif contradictions==1: c*=0.70
if -60<Williams_R<-40: c*=0.75
if -0.10<overbought_score<0.10: c*=0.92

supports =
    (up and StochRSI_K<30) or (down and StochRSI_K>70)
  + (up and Williams_R<-70) or (down and Williams_R>-30)
  + (up and overbought_score<-0.15)
    or (down and overbought_score>0.15)
  + (up and CMF<-0.03) or (down and CMF>0.03)

if supports>=3: c=min(c×1.20,0.95)
elif supports>=2: c=min(c×1.10,0.95)
if VolRatio>1.5: c=min(c×1.08,0.95)
elif VolRatio<0.7: c*=0.92
```

Legacy global V8 Bollinger bounce:

```
d,c = BB_V7(snapshot)
if c<=0.05: return d,c

contradictions =
    (up and StochRSI_K>75) or (down and StochRSI_K<25)
  + (up and Williams_R>-15) or (down and Williams_R<-85)
  + (up and overbought_score>0.25) or (down and overbought_score<-0.25)

if contradictions>=2: c*=0.25
elif contradictions==1: c*=0.75
if -60<Williams_R<-40: c*=0.80
if -0.10<overbought_score<0.10: c*=0.92
if ADX>43: c*=0.95

if c>0.10 and ((up and KC_POS<0.10) or (down and KC_POS>0.90)):
    c=min(c×1.12,0.95)

supports =
    (up and StochRSI_K<30) or (down and StochRSI_K>70)
  + (up and overbought_score<-0.15)
    or (down and overbought_score>0.15)
  + (up and CMF<-0.03) or (down and CMF>0.03)

if supports>=2: c=min(c×1.12,0.95)
if VolRatio>1.8: c=min(c×1.08,0.95)
elif VolRatio<0.6: c*=0.88
```

Legacy global V8 consecutive reversal:

```
d,c = CR_V7(snapshot)
if c<=0.05: return d,c
if ADX>35: c*=0.90

contradictions =
    (up and StochRSI_K>75) or (down and StochRSI_K<25)
  + (up and Williams_R>-15) or (down and Williams_R<-85)
  + (up and overbought_score>0.25) or (down and overbought_score<-0.25)

if contradictions>=2: c*=0.15
elif contradictions==1: c*=0.65
if -60<Williams_R<-40: c*=0.70
if -0.10<overbought_score<0.10: c*=0.85

supports =
    (up and StochRSI_K<40) or (down and StochRSI_K>60)
  + (up and overbought_score<-0.15)
    or (down and overbought_score>0.15)

if supports>=2: c=min(c×1.12,0.95)
if VolRatio>1.8: c=min(c×1.08,0.95)
elif VolRatio<0.6: c*=0.88
```

Legacy global V9 consensus:

```
subresults = [
    legacy_global_V8_AM,
    legacy_global_V8_BB,
    legacy_global_V8_CR
]
keep only subresults with confidence > 0.15

if len(kept)<2:
    return direction=close>open, confidence=0.03

majority = up if up-votes>down-votes else down
agreement = majority vote count
if agreement<2:
    return majority,0.05

avg = mean(confidence of all kept subresults)
confidence = min(avg×(0.70+0.15×agreement),0.95)
```

HTF corrections inside these legacy functions are inactive in the current

deployment because `HTFConfAdjustEnabled=false`.

## Exact Active Signal Strategies

### 6.1 `regime_adaptive`

Used on BTC 15m and ETH 5m.

```
if ADX<=0 or BB values invalid:
    return up,0.10

bb_width = 100 × (BB_upper-BB_lower)/BB_mid
trending = ADX > 25
volatile = bb_width > 3.0

if trending and volatile:
    return up if EMA20>EMA50 else down,
           min(ADX/50,1)

if not trending and not volatile:
    direction = up if RSI<50 else down
    return direction, min(abs(RSI-50)/25,1)

if trending and not volatile:
    return up if EMA20>EMA50 else down, 0.30

if volatile and not trending:
    direction = up if close<BB_mid else down
    distance = abs(close-BB_mid)/(BB_upper-BB_lower)
    return direction, min(distance×2,1)
```

### 6.2 `macd_crossover`

Used on SOL 15m.

```
if previous_MACD_hist == 0:
    return up,0

if previous_MACD_hist < 0 and MACD_hist > 0:
    return up,0.70

if previous_MACD_hist > 0 and MACD_hist < 0:
    return down,0.70

return direction=MACD_hist>0, confidence=0.10
```

The active slot threshold is `0.60`, so only a fresh crossing qualifies.

### 6.3 `v2_pin_bar`

Used on SOL 15m and SOL 5m.

```
hammer:
    lower_wick > 0.55
    body_ratio < 0.30
    upper_wick < 0.15

shooting_star:
    upper_wick > 0.55
    body_ratio < 0.30
    lower_wick < 0.15

hammer:
    confidence = 0.50
    +0.15 if BB_POS < 0.30
    +0.10 if RSI < 40
    return up,min(confidence,0.90)

shooting_star:
    confidence = 0.50
    +0.15 if BB_POS > 0.70
    +0.10 if RSI > 60
    return down,min(confidence,0.90)

otherwise:
    return direction=close>=open, confidence=0.02
```

### 6.4 `v2_rsi_shift`

Used on ETH 15m.

```
if RSI<=0 or previous_RSI<=0:
    return up,0.02

delta = RSI-previous_RSI

if abs(delta)<5:
    return direction=RSI>50, confidence=0.02

if delta>0 and previous_RSI<40:
    return up,min(delta/15+0.30,0.90)

if delta<0 and previous_RSI>60:
    return down,min(abs(delta)/15+0.30,0.90)

return direction=delta>0,
       confidence=min(abs(delta)/20+0.15,0.70)
```

### 6.5 `v5_vol_regime`

Used on BTC 5m.

```
up_score = 0
down_score = 0

if win_rate_recent_50 > 0.56:
    down_score += (win_rate_recent_50-0.50)×4
elif win_rate_recent_50 < 0.44:
    up_score += (0.50-win_rate_recent_50)×4

if RSI > 65: down_score += (RSI-50)/30
elif RSI < 35: up_score += (50-RSI)/30

if BB_POS > 0.82: down_score += 0.6
elif BB_POS < 0.18: up_score += 0.6

if AvgBuyPressure5 > 0.65: down_score += 0.4
elif AvgBuyPressure5 < 0.35: up_score += 0.4

if up_score+down_score < 0.8:
    return direction=close>=open, confidence=0.01

direction = up if up_score>down_score else down
confidence = min(max(up_score,down_score)/3,0.90)

if VolRegime > 1.15:
    confidence = min(confidence×1.20,0.90)
elif VolRegime < 0.85:
    confidence *= 0.70
```

### 6.6 `v3_precision`

Used on SOL 5m.

```
signals = []

if abs(ConsecCount)>=3:
    add (up if ConsecCount<0, weight=3.0)

if abs(bar_return_pct)/ATR_PCT > 1.3:
    add (up if bar_return_pct<0, weight=2.5)

if BB_POS < 0.12: add (up,2.0)
elif BB_POS > 0.88: add (down,2.0)

if RSI > 72: add (down,1.8)
elif RSI < 28: add (up,1.8)

if upper_wick>0.50 and body_ratio<0.30: add (down,1.5)
elif lower_wick>0.50 and body_ratio<0.30: add (up,1.5)

if body_ratio>0.55 and
   VolRatio < previous_VolRatio×0.60 and VolRatio<0.70:
    add (opposite of current bar direction,1.2)

if len(signals)<2:
    return direction=close>=open, confidence=0.01

up_weight = sum(weights where direction=up)
down_weight = sum(weights where direction=down)
total = up_weight+down_weight
dominant = max(up_weight,down_weight)
minority = min(up_weight,down_weight)

if minority > dominant×0.40:
    return majority direction, confidence=0.05

agreement = dominant/total
confidence = agreement × min(dominant/4,1)
return majority direction, min(confidence,0.95)
```

### 6.7 `v8_ultra_conf`

Used on ETH 5m.

Unlike `v7_ultra_conf_a`, this strategy is not replaced by a symbol-tuned

wrapper. Its base is the global fixed V4/V7 full-factor model:

```
if EMA5-EMA20 normalized by ATR > 0.20: up_score += 1.0
elif < -0.20:                           down_score += 1.0

if RSI > 65: down_score += (RSI-50)/30
elif RSI < 35: up_score += (50-RSI)/30

if BB_POS > 0.82: down_score += 0.7
elif BB_POS < 0.18: up_score += 0.7

if KC_POS > 0.85: down_score += 0.6
elif KC_POS < 0.15: up_score += 0.6

if HL_POS20 > 0.85: down_score += 0.5
elif HL_POS20 < 0.15: up_score += 0.5

if ConsecCount >= 3: down_score += 0.5
elif ConsecCount <= -3: up_score += 0.5

if AvgBuyPressure5 > 0.65: down_score += 0.4
elif AvgBuyPressure5 < 0.35: up_score += 0.4

dev_z = PriceDevEMA20/ATR_PCT
if dev_z > 0.8: down_score += 0.6
elif dev_z < -0.8: up_score += 0.6

bar_z = abs(100×(close-open)/open)/ATR_PCT
if bar_z > 0.8:
    if close>open: down_score += 0.5
    else:          up_score += 0.5

if squeeze_momentum>0 and squeeze_momentum>prev_squeeze_momentum:
    up_score += 0.4
elif squeeze_momentum<0 and squeeze_momentum<prev_squeeze_momentum:
    down_score += 0.4

if up_score+down_score < 4.0:
    return direction=close>=open, confidence=0.01

d = up if up_score>down_score else down
c = min(max(up_score,down_score)/4,0.90)
```

Then:

```
if c <= 0.05:
    return d,c

contradictions = 0
contradictions += (up and StochRSI_K>75) or (down and StochRSI_K<25)
contradictions += (up and Williams_R>-15) or (down and Williams_R<-85)
contradictions += (up and overbought_score>0.25)
               or (down and overbought_score<-0.25)

if contradictions>=2: c *= 0.20
elif contradictions==1: c *= 0.75

supports = 0
supports += (up and StochRSI_K<30) or (down and StochRSI_K>70)
supports += (up and overbought_score<-0.15)
         or (down and overbought_score>0.15)
supports += (up and CMF<-0.03) or (down and CMF>0.03)

if supports>=2:
    c = min(c×1.12,0.95)

if VolRatio>1.5: c = min(c×1.08,0.95)
elif VolRatio<0.3: c *= 0.70
```

### 6.8 `v8_anti_momentum_a`

Used on ETH 15m.

```
d,c = T8_AM(ETH)

if c <= 0.05:
    return d,c

if not Micro15mValid:
    return d,0.02

if Micro15mLast1Up != (d==up):
    return d,0.02

return d,c
```

### 6.9 `v8_anti_momentum_a_m2`

Used on SOL 15m.

```
d,c = T8_AM(SOL)

if c <= 0.05:
    return d,c

if not Micro15mValid:
    return d,0.02

if Micro15mLast2Up != (d==up):
    return d,0.02

return d,c
```

### 6.10 `v9_consensus_gate`

Used on DOGE 15m.

The base is `T9(DOGE)` from section 5.8.

```
d,c = T9(DOGE)

hits = 0
hits += DayEfficiencySoFar < 0.06255
hits += directional_z20 >= -0.96806
hits += directional_RSI >= 41.64978
hits += body_ratio < 0.47422
hits += HTF_ADX >= 31.87669

if hits >= 3:
    return d,0.02

return d,c
```

Definitions:

```
directional_z20 =
    (PriceDevEMA20/ATR_PCT)     if direction=up
    -(PriceDevEMA20/ATR_PCT)    if direction=down

directional_RSI =
    RSI                         if direction=up
    100-RSI                     if direction=down
```

In the current deployment, legacy `HTF_ADX` is not injected. Set

`HTF_ADX=0`, so the effective gate is “3 hits among the other four

conditions.”

### 6.11 `v14_signal_reclaim`

Used on BTC, ETH, and DOGE 15m.

Collect the following sub-signals:

| ***\*Sub-strategy\****    | ***\*Accepted confidence interval\**** |
| ------------------------- | -------------------------------------- |
| legacy `v8_anti_momentum` | `[0.30,0.65)`                          |
| legacy `v8_bb_bounce`     | `[0.30,0.70)`                          |
| legacy `v8_consec_rev`    | `[0.50,0.70)`                          |
| legacy `v9_consensus`     | `[0.40,0.55)`                          |

The legacy V8 functions use the global formulas from sections 5.1-5.3 plus

their fixed global modifiers. HTF modifiers are inactive in the current build.

```
if no accepted sub-signals:
    return direction=close>=open, confidence=0.01

majority = up if up_count > down_count else down
agreement = vote count for majority

if len(signals)>1 and agreement <= floor(len(signals)/2):
    return majority,0.03

c = mean(confidence of accepted sub-signals)

if agreement>=3: c = min(c×1.25,0.90)
elif agreement==2: c = min(c×1.15,0.85)

contradictions = 0
contradictions += (up and StochRSI_K>80) or (down and StochRSI_K<20)
contradictions += (up and Williams_R>-5) or (down and Williams_R<-95)

if contradictions>=2: c *= 0.30
elif contradictions==1: c *= 0.70

supports = 0
supports += (up and CMF>0.03) or (down and CMF<-0.03)
supports += (up and BuyPressure>0.55)
         or (down and BuyPressure<0.45)
supports += VolRatio>1.2

if supports>=2: c = min(c×1.12,0.90)

return majority,c
```

### 6.12 `v10_apex`

Used on DOGE 15m.

```
ob_score = 0
os_score = 0

if RSI>65:  ob_score += min((RSI-60)/25,1)×1.5
elif RSI<35: os_score += min((35-RSI)/25,1)×1.5

if BB_POS>0.78:  ob_score += (BB_POS-0.5)×2.0
elif BB_POS<0.22: os_score += (0.5-BB_POS)×2.0

if KC_POS>0.78:  ob_score += (KC_POS-0.5)×1.2
elif KC_POS<0.22: os_score += (0.5-KC_POS)×1.2

if ConsecCount>=3:
    ob_score += min((ConsecCount-2)×0.3,0.9)
elif ConsecCount<=-3:
    os_score += min((-ConsecCount-2)×0.3,0.9)

bar_z = 100×(close-open)/open/ATR_PCT
if bar_z>0.9:   ob_score += min((bar_z-0.5)×0.5,0.8)
elif bar_z<-0.9:os_score += min((-bar_z-0.5)×0.5,0.8)

if AvgBuyPressure5>0.65:
    ob_score += (AvgBuyPressure5-0.5)×1.5
elif AvgBuyPressure5<0.35:
    os_score += (0.5-AvgBuyPressure5)×1.5

dev_z = PriceDevEMA20/ATR_PCT
if dev_z>0.5:    ob_score += min(dev_z×0.5,0.8)
elif dev_z<-0.5: os_score += min(-dev_z×0.5,0.8)

dominant=max(ob_score,os_score)
minority=min(ob_score,os_score)
if ob_score>=os_score: direction=down
else:                  direction=up

if dominant<2.0: return bar direction,0.01
if minority>dominant×0.3: return bar direction,0.01
if ADX>33: return bar direction,0.01

if up and RSI>62: return bar direction,0.01
if down and RSI<38: return bar direction,0.01
if up and BB_POS>0.72: return bar direction,0.01
if down and BB_POS<0.28: return bar direction,0.01

c=min(dominant/5+0.20,0.95)

aux=0
aux += (up and StochRSI_K<28) or (down and StochRSI_K>72)
aux += (up and Williams_R<-72) or (down and Williams_R>-28)
aux += (up and CMF<-0.03) or (down and CMF>0.03)
aux += (up and overbought_score<-0.18)
    or (down and overbought_score>0.18)

if aux>=2: c=min(c+0.08,0.95)
if VolRatio>1.3: c=min(c×1.06,0.95)
elif VolRatio<0.35: c*=0.70
```

The legacy HTF bonus is inactive in the current deployment.

### 6.13 `v18_trend_pullback_5m`

Used on BTC 5m.

Trend direction:

```
t = sign(H1_EMA20-H1_EMA50)
require H1_RSI>0 and t != 0
```

Pullback gate:

```
bar_return_pct = 100×(close-open)/open
require bar_return_pct × t < 0
```

Feature definitions:

```
dev20z = clamp((PriceDevEMA20/ATR_PCT) × t, -3, 3)
consec = clamp((ConsecCount/5) × t, -3, 3)
headz  = clamp((Micro5mHeadPct/ATR_PCT) × t, -2, 2)
m1pos  = (2×Micro5mLastPos-1) × t
adx_n  = ADX/50
h1_spread_a = clamp(abs(H1_SPREAD_PCT)/2,0,2)
```

Frozen logistic model:

```
score =
    -0.03
    -0.07×dev20z
    -0.04×consec
    -0.28×headz
    +0.04×m1pos
    +0.03×adx_n
    +0.03×h1_spread_a

p = sigmoid(score)
if p<0.50: return t>0,0.02
return t>0,p
```

The source labels this model as designed for K-line/close-vs-open

settlement. Verify the target platform settlement before reusing it.

### 6.14 `v19_anchor_trend_counter_5m`

Used on BTC 5m.

Direction is the sign of the anchored head:

```
direction = up if Micro5mHeadPct>0 else down
d = +1 for up, -1 for down
```

Counter-trend gate:

```
bar_return_pct = 100×(close-open)/open
require bar_return_pct × d < 0
```

Use the `v19Anchor` coefficients below and compute the score exactly as

specified.

### 6.15 `v19_anchor_trend_5m`

Used on ETH 5m.

```
direction = sign(Micro5mHeadPct)
d = +1 or -1
```

No counter-trend gate is applied.

#### V19 anchor feature vector

```
headz = min(abs(Micro5mHeadPct)/ATR_PCT,2)
barz = clamp(((close-open)/open×100/ATR_PCT)×d,-3,3)
ret3z = clamp((CloseChg3Pct/ATR_PCT)×d,-3,3)
dev20z = clamp((PriceDevEMA20/ATR_PCT)×d,-3,3)
consec = clamp((ConsecCount/5)×d,-3,3)
clpos = (((close-low)/(high-low))×2-1)×d
rsi_c = ((RSI-50)/50)×d
h1rsi_c = ((H1_RSI-50)/50)×d
m1pos = (2×Micro5mLastPos-1)×d
vwapdevz = clamp((Micro5mVWAPDev/ATR_PCT)×d,-3,3)
hlp = (2×HighLowPosition20-1)×d
upr = (2×UpRatio20-1)×d
m15devz = 0 if M15_ATR_PCT<=0 else
          clamp((M15_PRICE_DEV_EMA20_PCT/M15_ATR_PCT)×d,-3,3)
path_eff = clamp(Micro5mPathEff,0,1)
adx_n = ADX/50
atr_n = clamp(ATR_PCT,0,3)
vol_r = clamp(log(1+VolRatio),0,3)
h1_spread_a = clamp(abs(H1_SPREAD_PCT)/2,0,2)
is_us = 1 if 13<=UTC_hour<=20 else 0
```

Frozen `v19Anchor` coefficients:

| ***\*Feature\**** | ***\*Coefficient\**** |
| ----------------- | --------------------- |
| bias              | +0.06                 |
| headz             | +2.10                 |
| barz              | +0.05                 |
| ret3z             | -0.02                 |
| dev20z            | -0.08                 |
| consec            | -0.07                 |
| clpos             | +0.09                 |
| rsi_c             | +0.14                 |
| h1rsi_c           | 0.00                  |
| m1pos             | +0.08                 |
| vwapdevz          | -0.19                 |
| hlp               | +0.04                 |
| upr               | +0.02                 |
| m15devz           | -0.01                 |
| path_eff          | -0.04                 |
| adx_n             | -0.01                 |
| atr_n             | +0.05                 |
| vol_r             | -0.08                 |
| h1_spread_a       | 0.00                  |
| is_us             | 0.00                  |

```
score = bias + Σ(coefficient×feature)
confidence = sigmoid(score)
```

### 6.16 `v7_ultra_conf_a`

Used on SOL 5m.

```
d,c = T7_FULL_FACTOR(SOL)

if c <= 0.05:
    return d,c
if not Micro5mValid:
    return d,0.02

last_up = Micro5mRetLast1 >= 0
if last_up != (d==up):
    return d,0.02

return d,c
```

## Active Slot Map

Every row exists identically on both live accounts.

|      | ***\*Timeframe\**** | ***\*Asset\**** | ***\*Signal strategy\****     | ***\*Effective minimum confidence\**** |
| ---- | ------------------- | --------------- | ----------------------------- | -------------------------------------- |
| 1    | 15m                 | BTC             | `regime_adaptive`             | 0.600                                  |
| 2    | 15m                 | BTC             | `v14_signal_reclaim`          | 0.500                                  |
| 3    | 15m                 | DOGE            | `v10_apex`                    | 0.600                                  |
| 4    | 15m                 | DOGE            | `v14_signal_reclaim`          | 0.500                                  |
| 5    | 15m                 | DOGE            | `v9_consensus_gate`           | 0.450                                  |
| 6    | 15m                 | ETH             | `v14_signal_reclaim`          | 0.500                                  |
| 7    | 15m                 | ETH             | `v2_rsi_shift`                | 0.600                                  |
| 8    | 15m                 | ETH             | `v8_anti_momentum_a`          | 0.550                                  |
| 9    | 15m                 | SOL             | `macd_crossover`              | 0.600                                  |
| 10   | 15m                 | SOL             | `v2_pin_bar`                  | 0.600                                  |
| 11   | 15m                 | SOL             | `v8_anti_momentum_a_m2`       | 0.550                                  |
| 12   | 5m                  | BTC             | `v18_trend_pullback_5m`       | 0.548                                  |
| 13   | 5m                  | BTC             | `v19_anchor_trend_counter_5m` | 0.620                                  |
| 14   | 5m                  | BTC             | `v5_vol_regime`               | 0.600                                  |
| 15   | 5m                  | ETH             | `regime_adaptive`             | 0.600                                  |
| 16   | 5m                  | ETH             | `v19_anchor_trend_5m`         | 0.620                                  |
| 17   | 5m                  | ETH             | `v8_ultra_conf`               | 0.600                                  |
| 18   | 5m                  | SOL             | `v2_pin_bar`                  | 0.600                                  |
| 19   | 5m                  | SOL             | `v3_precision`                | 0.600                                  |
| 20   | 5m                  | SOL             | `v7_ultra_conf_a`             | 0.600                                  |

The current global `min_confidences` table does not contain exact overrides for

these 20 active strategy names. Therefore the values above are both the stored

slot values and the effective values.

## CT4 Execution Specification

### 8.1 Account-level JSON

Use this exact object as the current account-level `checkpoint_taker` override:

```
{
  "t1_sec_15m": 75,
  "t1_retry_sec": 7,
  "fav_min": 0.72,
  "fav_defer_min": 0.76,
  "ask_min_15m": 0.05,
  "five_min_mode": "ct1",
  "decide_mode_5m": "unanimous",
  "cheap_action_5m": "skip",
  "cheap_action_15m": "skip",
  "extra_legs_5m": "210:0.45:0.90",
  "fixed_shares": 15
}
```

Account settings:

```
{
  "order_strategy": "checkpoint_taker_v4",
  "fixed_shares": 15,
  "prefer_maker": true
}
```

### 8.2 CT4 defaults filled for fields omitted above

| ***\*Parameter\**** | ***\*5m value\****                 | ***\*15m value\**** |
| ------------------- | ---------------------------------- | ------------------- |
| `exec_mode`         | `fak`                              | `fak`               |
| `t1_sec`            | 3                                  | 75                  |
| `t2_sec`            | 60, unused because T2 mode is skip | 120                 |
| `ask_min`           | 0.35                               | 0.05                |
| `ask_max`           | 0.95                               | 0.95                |
| `stall_lo`          | 0.55                               | 0.59                |
| `stall_hi`          | 0.95                               | 0.60                |
| `decide_samples`    | 3                                  | 3                   |
| `sample_gap_sec`    | 1                                  | 1                   |
| `decide_mode`       | `unanimous`                        | `median`            |
| `slip_ticks`        | +1 tick                            | +1 tick             |
| `max_chase`         | 0.03                               | 0.03                |
| `retry_sec`         | 1                                  | 1                   |
| `max_attempts`      | 4                                  | 4                   |
| `late_grace_sec`    | 8                                  | 20                  |
| `t2_mode`           | `skip`                             | `confirm`           |
| `t1_partial_mode`   | `done`                             | `t2`                |
| `full_cost_ratio`   | 0.97                               | 0.97                |
| `cheap_action`      | `skip`                             | `skip`              |
| `fixed_shares`      | 15                                 | 15                  |

### 8.3 Sampling

For a checkpoint at window second `T`, collect three order-book asks at:

```
T-2s, T-1s, T
```

`median` mode uses the median of valid asks. `unanimous` mode requires every

valid sample to be inside the active decision band.

### 8.4 15m state machine

#### T1 at 75 seconds

```
if no valid ask or ask_pct < 0.05:
    go to T2
elif ask_pct < 0.59:
    cheap action = skip
    go to T3
elif ask_pct < 0.60:
    go to T2
elif ask_pct < 0.76:
    direct FAK buy
elif ask_pct < 0.95:
    defer to T2
else:
    hard skip; do not enter T3
```

#### T2 at 120 seconds

```
sample median ask
if 0.72 <= ask_pct < 0.95:
    FAK buy
else:
    go to T3
```

#### T3 at 210 seconds

```
if no prior fill and 0.82 <= ask_pct < 0.92:
    FAK buy
else:
    no fill
```

The 15m `t1_retry_sec=7` is invalid because it is below T1=75 and therefore

normalizes to zero. There is no 15m T1 retry.

### 8.5 5m state machine

#### T1 at 3 seconds and retry at 7 seconds

```
if T1 < 0.35:
    invalid; if a retry exists, evaluate it
elif T1 < 0.55:
    cheap action=skip; immediately schedule the 210s leg
elif T1 < 0.95:
    stall; T2 mode=skip;
    if this is the first checkpoint, evaluate the 7s retry
    otherwise schedule the 210s leg
else:
    hard skip
```

Because `fav` is empty for 5m, there is no early direct-buy band.

#### Extra leg at 210 seconds

```
sample three asks at 208s,209s,210s
require every valid ask in [0.45,0.90)
if true: FAK buy
```

Under the current live settings, the 210-second extra leg is the only 5m

entry path. Early T1/7s decisions are diagnostic/skipped because:

```
cheap_action_5m = skip
t2_mode = skip
fav band is empty
```

### 8.6 FAK order construction

For every attempted buy:

```
tick = market tick size, default 0.01
limit = round_to_tick(ask + slip_ticks×tick)
limit = min(limit, 0.95)
```

If `ask > decision_price + 0.03`, the engine may re-anchor once if the new ask

is still inside that leg's price band. Otherwise it stops chasing.

#### Fixed-share sizing

```
target_shares = 15 × number_of_merged_slots
remaining_shares = target_shares - filled_shares
requested_shares = ceil(remaining_shares)
requested_amount = ceil(requested_shares×limit to cents)
```

The configured slot `bet_size_usd=5` is not the position size in fixed-share

mode.

#### Partial fills

```
after a partial FAK:
    keep the fill
    wait 1 second
    recompute current ask
    retry remaining shares
    maximum 4 attempts
```

15m T1 partial fills can carry their remainder to T2. 5m has no T2 top-up.

#### Exchange minimum

For a limit price `p`, one CLOB order must contain an integer number of shares

and at least $1 notional:

```
minimum_shares = ceil(1/p)
minimum_amount = minimum_shares×p
```

### 8.7 Signal threshold and merge order

Each slot independently computes:

```
signal_confidence >= effective_slot_min_confidence
```

After filtering, signals for the same:

```
account + token_id + direction + execution_strategy
```

are merged within the same window.

Merge rules:

1. Sort members by signal strategy name.
2. The lexicographically first strategy is the execution leader.
3. The leader's signal confidence is used in execution trace and any

confidence-aware execution gate.

1. The merged target is `15 × member_count` shares.
2. The merged fill is allocated across all member records.

Examples:

```
["v14_signal_reclaim","regime_adaptive"] -> leader v14_signal_reclaim
["regime_adaptive","v14_signal_reclaim"] -> same, order is normalized
```

Directional conflicts are not merged:

```
up + up -> one merged order
down + down -> one merged order
up + down -> separate orders
```

### 8.8 Operational rejection checks

A signal is not submitted if any of these checks fails:

1. Primary K-line tail is missing, stale, or has 3+ gaps in the latest 50 bars.
2. The Polymarket market cannot be found for the exact current window.
3. The market slug's window timestamp differs from the signal window.
4. The CLOB token ID is empty.
5. The same slot already has an active order record for the same market.
6. The pending database row cannot be written.
7. The known account balance is below the minimum notional.
8. The platform is in maintenance/trading-disabled state.
9. V6 risk manager blocks the signal. It is currently disabled.

## Replay Results

### 9.1 Existing exact 20-slot replay

This is the closest published replay to the current signal map. It uses:

| ***\*Item\****        | ***\*Value\****                                           |
| --------------------- | --------------------------------------------------------- |
| Signal slots          | Exact current 20 slots                                    |
| CT4 account overrides | Exact current CT4 path                                    |
| Period                | 2026-07-26 through 2026-10-15 CST                         |
| Sizing                | `$5` target cost per slot, not current fixed 15 shares    |
| Fill model            | same Go CT4 engine, `expected` taker model                |
| Settlement            | rescored below with official Polymarket resolution labels |
| Data                  | historical multi-coin K-line and order-book tape          |

The replay is position-size neutral with respect to signals but not identical

to the current 15-share sizing. It is used here to show signal/execution

quality. A fixed-15-share rerun is a separate verification step.

#### Official Gamma-label results

| ***\*Segment\****      | ***\*Filled\**** | ***\*Resolved fills\**** | ***\*Missing labels\**** | ***\*Cost\**** | ***\*Fees\**** | ***\*Net PnL\****    | ***\*ROI\****    | ***\*Avg entry\**** | ***\*Win rate\**** |
| ---------------------- | ---------------- | ------------------------ | ------------------------ | -------------- | -------------- | -------------------- | ---------------- | ------------------- | ------------------ |
| Train: 7/26–9/23       | 3,235            | 3,007                    | 228                      | $18,319.68     | $395.11        | ***\*+$522.86\****   | ***\*+2.79%\**** | 0.6647              | 72.06%             |
| Validation: 9/24–10/15 | 1,382            | 1,382                    | 0                        | $8,505.31      | $177.35        | ***\*+$700.59\****   | ***\*+8.07%\**** | 0.6817              | 75.25%             |
| Full                   | 4,617            | 4,389                    | 228                      | $26,824.99     | $572.46        | ***\*+$1,223.45\**** | ***\*+4.47%\**** | 0.6700              | 73.07%             |

Daily result:

| ***\*Metric\**** | ***\*Value\**** |
| ---------------- | --------------- |
| Days with fills  | 77              |
| Positive days    | 51              |
| Negative days    | 26              |
| Maximum drawdown | -$130.16        |
| Best day         | +$87.74         |
| Worst day        | -$79.89         |

#### Results by asset and timeframe

| ***\*Group\**** | ***\*Filled\**** | ***\*Resolved fills\**** | ***\*Cost\**** | ***\*Fees\**** | ***\*Official PnL\**** | ***\*ROI\**** | ***\*Win rate\**** |
| --------------- | ---------------- | ------------------------ | -------------- | -------------- | ---------------------- | ------------- | ------------------ |
| 15m BTC         | 339              | 337                      | $1,798.16      | $40.04         | ***\*+$118.77\****     | +6.46%        | 73.59%             |
| 15m DOGE        | 648              | 635                      | $5,250.34      | $109.50        | ***\*+$287.78\****     | +5.37%        | 73.86%             |
| 15m ETH         | 530              | 519                      | $2,891.12      | $62.20         | ***\*+$119.09\****     | +4.03%        | 73.41%             |
| 15m SOL         | 330              | 325                      | $1,647.30      | $34.96         | ***\*+$163.12\****     | +9.70%        | 77.85%             |
| 5m BTC          | 514              | 468                      | $2,707.31      | $58.37         | ***\*+$237.36\****     | +8.58%        | 75.00%             |
| 5m ETH          | 1,327            | 1,245                    | $7,304.39      | $156.99        | ***\*+$64.85\****      | +0.87%        | 71.16%             |
| 5m SOL          | 929              | 860                      | $5,226.37      | $110.40        | ***\*+$232.48\****     | +4.36%        | 71.98%             |

The original engine TWAP-label result for the same files was:

| ***\*Metric\**** | ***\*Value\**** |
| ---------------- | --------------- |
| Filled           | 4,617           |
| Engine PnL       | +$985.22        |
| Engine ROI       | +3.42%          |
| Average entry    | 0.671           |

The difference between TWAP and official Gamma labels is expected and is why

the official-label table above is the primary economic result.

### 9.2 Earlier live-configuration replay

Before the current 20-slot mix, the live CT4 configuration was replayed over

2026-08-14 through 2026-09-29 with:

- seven live signal slots per timeframe group;
- fixed 10 shares per slot;
- only the 5m `210s∈[0.45,0.90)` extra leg;
- official Gamma labels.

Results:

| ***\*Group\**** | ***\*Filled\**** | ***\*Net PnL\****    | ***\*ROI\****    |
| --------------- | ---------------- | -------------------- | ---------------- |
| Poly CT4 total  | 3,013            | ***\*+$3,178.30\**** | ***\*+6.81%\**** |
| 5m              | 2,164            | +$1,865.70           | —                |
| 15m             | 849              | +$1,312.60           | —                |

This is useful evidence for the CT4 execution family, but it is not the

current 20-slot portfolio.

### 9.3 CT4 robustness audit

The CT4 parameter audit used 8/12–9/28, fixed 10 shares per slot, and

signals available at that time.

Key findings:

1. The 15m `t1=75s` point is a sharp optimum:
   - ±5 seconds reduces PnL by roughly 20–32%;
   - ±15 seconds reduces PnL by roughly 55%.
2. Price-band, T2, and T3 perturbations are comparatively flat.
3. Adding 1¢/share execution friction still leaves the historical CT4

sample profitable; adding 2¢/share also remains positive in that sample.

1. The 15m 360-second extra leg was later rolled back because its clean-period

contribution was negative.

1. The 5m 210-second extra leg remained positive in the controlled change

audit, but its gain was concentrated in a small number of weeks. It is

retained in the current live configuration, not treated as proven alpha.

Controlled change audit:

| ***\*Change\****          | ***\*Full-period delta\**** | ***\*Train\**** | ***\*Test\**** | ***\*Clean\****   |
| ------------------------- | --------------------------- | --------------- | -------------- | ----------------- |
| CT3 → CT4 waiting band/T2 | +$254.90                    | -$70.20         | +$229.40       | +$95.70           |
| Add 15m T3                | +$53.10                     | +$28.10         | +$9.90         | +$15.10           |
| Add 15m 360s leg          | +$193.40                    | +$164.30        | +$63.60        | ***\*-$34.50\**** |
| Add 5m 210s leg           | +$460.00                    | +$133.20        | +$206.50       | +$120.30          |

Decision:

```
keep CT4 base
keep 15m T3 210s[0.82,0.92)
remove 15m extra 360s leg
keep 5m extra 210s[0.45,0.90)
```

### 9.4 Replay limitations

- The exact current 20-slot published replay uses `$5` cost per slot.
- The live account uses fixed 15 shares.
- Therefore absolute PnL from the `$5` run must not be presented as the live

account's expected PnL.

- A fixed-15-share replay is required for a sizing-matched result.
- Replay uses the next observable book state and an `expected` taker-fill

model. It cannot prove sub-second queue position or exact live submission

latency.

- Settlement labels are used only after execution.
- Missing official labels are reported separately and are not treated as

losses.

## Reproduction Checklist

To reproduce the system on another platform:

1. Build the four OKX perpetual-swap 5m/15m/1m/1H datasets and BTC 15m

context.

1. Implement the indicator formulas and quantization rules in sections 2–3.
2. Implement the common strategy primitives and tuning profiles in sections 4–5.
3. Register the 16 exact signal strategies in section 6.
4. Enforce the closed-bar and contiguous-1m rules before every signal.
5. Load the 20 slots and their effective thresholds from section 7.
6. Implement CT4 exactly as specified in section 8.
7. Apply fixed-share sizing as `15 × merged slot count`.
8. Sort merged signals lexicographically by strategy name and use the first

strategy as execution leader.

1. Use the target platform's official settlement labels for evaluation.
2. Compare fill status, filled shares, VWAP, cash, fees, and PnL, not only

direction accuracy.

## Self-Contained Scope

This document does not depend on private files, internal paths, account names,

credentials, or local infrastructure. The indicator definitions, model

coefficients, symbol-tuning tables, slot thresholds, execution state machine,

sizing rules, merge rules, and replay methodology above are sufficient to

implement and validate the strategy independently.