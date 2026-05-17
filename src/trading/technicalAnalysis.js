// src/trading/technicalAnalysis.js
const {
  RSI, MACD, BollingerBands, EMA, SMA, Stochastic
} = require('technicalindicators');
const logger = require('../utils/logger');

/**
 * Run full technical analysis on price history
 * Returns trading signal with confidence score
 */
function analyzePriceHistory(priceHistory) {
  if (!priceHistory || priceHistory.length < 20) {
    return { signal: 'NEUTRAL', confidence: 0, reason: 'Insufficient data' };
  }

  const closes = priceHistory.map(p => parseFloat(p.p || p.price || 0));
  const highs = priceHistory.map(p => parseFloat(p.h || p.high || p.p || 0));
  const lows = priceHistory.map(p => parseFloat(p.l || p.low || p.p || 0));
  const volumes = priceHistory.map(p => parseFloat(p.v || p.volume || 1));

  if (closes.some(isNaN) || closes.length < 14) {
    return { signal: 'NEUTRAL', confidence: 0, reason: 'Bad data' };
  }

  const signals = [];
  let score = 0;
  const reasons = [];

  // ─── 1. RSI ───────────────────────────────────────────────
  try {
    const rsiValues = RSI.calculate({ values: closes, period: 14 });
    const rsi = rsiValues[rsiValues.length - 1];
    const prevRsi = rsiValues[rsiValues.length - 2];

    if (rsi < 30 && rsi > prevRsi) {
      score += 2;
      reasons.push(`RSI oversold+turning(${rsi.toFixed(1)})`);
      signals.push('BUY');
    } else if (rsi > 70 && rsi < prevRsi) {
      score -= 2;
      reasons.push(`RSI overbought+turning(${rsi.toFixed(1)})`);
      signals.push('SELL');
    } else if (rsi > 55) {
      score += 1;
      signals.push('BUY');
    } else if (rsi < 45) {
      score -= 1;
      signals.push('SELL');
    }
  } catch {}

  // ─── 2. MACD ──────────────────────────────────────────────
  try {
    const macdResult = MACD.calculate({
      values: closes,
      fastPeriod: 5,
      slowPeriod: 13,
      signalPeriod: 3,
      SimpleMAOscillator: false,
      SimpleMASignal: false
    });
    
    if (macdResult.length >= 2) {
      const latest = macdResult[macdResult.length - 1];
      const prev = macdResult[macdResult.length - 2];
      
      // Bullish crossover
      if (latest.MACD > latest.signal && prev.MACD <= prev.signal) {
        score += 3;
        reasons.push('MACD bullish crossover');
        signals.push('BUY');
      }
      // Bearish crossover
      else if (latest.MACD < latest.signal && prev.MACD >= prev.signal) {
        score -= 3;
        reasons.push('MACD bearish crossover');
        signals.push('SELL');
      }
      // Histogram trend
      else if (latest.histogram > 0 && latest.histogram > prev.histogram) {
        score += 1;
        signals.push('BUY');
      } else if (latest.histogram < 0 && latest.histogram < prev.histogram) {
        score -= 1;
        signals.push('SELL');
      }
    }
  } catch {}

  // ─── 3. Bollinger Bands ───────────────────────────────────
  try {
    const bbResult = BollingerBands.calculate({
      period: 10,
      values: closes,
      stdDev: 2
    });
    
    if (bbResult.length > 0) {
      const bb = bbResult[bbResult.length - 1];
      const currentPrice = closes[closes.length - 1];
      const bbWidth = bb.upper - bb.lower;
      const positionInBand = (currentPrice - bb.lower) / bbWidth;

      if (positionInBand < 0.15) {
        score += 2;
        reasons.push('BB lower band bounce');
        signals.push('BUY');
      } else if (positionInBand > 0.85) {
        score -= 2;
        reasons.push('BB upper band rejection');
        signals.push('SELL');
      } else if (positionInBand > 0.5) {
        score += 0.5;
      }
    }
  } catch {}

  // ─── 4. EMA Trend ─────────────────────────────────────────
  try {
    const ema8 = EMA.calculate({ period: 8, values: closes });
    const ema21 = EMA.calculate({ period: 21, values: closes });
    
    if (ema8.length > 0 && ema21.length > 0) {
      const e8 = ema8[ema8.length - 1];
      const e21 = ema21[ema21.length - 1];
      const prevE8 = ema8[ema8.length - 2];
      const prevE21 = ema21[ema21.length - 2];

      if (e8 > e21 && prevE8 <= prevE21) {
        score += 2;
        reasons.push('EMA8 crossed above EMA21');
        signals.push('BUY');
      } else if (e8 < e21 && prevE8 >= prevE21) {
        score -= 2;
        reasons.push('EMA8 crossed below EMA21');
        signals.push('SELL');
      } else if (e8 > e21) {
        score += 0.5;
      } else {
        score -= 0.5;
      }
    }
  } catch {}

  // ─── 5. Price momentum (last 5 bars) ──────────────────────
  try {
    const recent = closes.slice(-6);
    const momentum = (recent[5] - recent[0]) / recent[0];
    
    if (momentum > 0.05) {
      score += 2;
      reasons.push(`Strong upward momentum(${(momentum * 100).toFixed(1)}%)`);
      signals.push('BUY');
    } else if (momentum < -0.05) {
      score -= 2;
      reasons.push(`Strong downward momentum(${(momentum * 100).toFixed(1)}%)`);
      signals.push('SELL');
    } else if (momentum > 0.02) {
      score += 1;
    } else if (momentum < -0.02) {
      score -= 1;
    }
  } catch {}

  // ─── 6. Volume analysis ───────────────────────────────────
  try {
    const avgVolume = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
    const recentVolume = volumes[volumes.length - 1];
    const volumeRatio = recentVolume / (avgVolume || 1);
    
    if (volumeRatio > 2 && score > 0) {
      score += 1.5; // High volume confirms uptrend
      reasons.push(`High volume confirmation(${volumeRatio.toFixed(1)}x)`);
    } else if (volumeRatio > 2 && score < 0) {
      score -= 1.5; // High volume confirms downtrend
    }
  } catch {}

  // ─── Compute final signal ─────────────────────────────────
  const totalPossibleScore = 13.5;
  const normalizedScore = Math.max(-1, Math.min(1, score / totalPossibleScore));
  const confidence = Math.abs(normalizedScore);
  
  let signal = 'NEUTRAL';
  if (normalizedScore > 0.2) signal = 'YES'; // Buy YES token
  if (normalizedScore < -0.2) signal = 'NO'; // Buy NO token (bet against)

  return {
    signal,
    confidence: confidence,
    score: normalizedScore,
    reasons,
    currentPrice: closes[closes.length - 1],
    signals
  };
}

/**
 * Fundamental analysis of Polymarket market
 */
function analyzeFundamentals(market) {
  let score = 0;
  const reasons = [];

  const yesPrice = parseFloat(market.outcomePrices?.[0] || market.bestBid || 0.5);
  const noPrice = parseFloat(market.outcomePrices?.[1] || 0.5);
  const liquidity = parseFloat(market.liquidity || 0);
  const volume24h = parseFloat(market.volume24hr || market.volume || 0);
  const endDate = new Date(market.endDate);
  const minsToEnd = (endDate - Date.now()) / (1000 * 60);

  // Price edge detection
  if (yesPrice > 0.6 && yesPrice < 0.85) {
    score += 1.5;
    reasons.push(`YES has edge at ${(yesPrice * 100).toFixed(0)}%`);
  } else if (yesPrice < 0.4 && yesPrice > 0.15) {
    score -= 1.5; // Good NO bet
    reasons.push(`NO has edge at ${((1 - yesPrice) * 100).toFixed(0)}%`);
  }

  // Near resolution with strong lean = less risk
  if (minsToEnd < 60 && minsToEnd > 10) {
    if (yesPrice > 0.7) {
      score += 2;
      reasons.push('Near resolution, strong YES lean');
    } else if (yesPrice < 0.3) {
      score -= 2;
      reasons.push('Near resolution, strong NO lean');
    }
  }

  // Liquidity check
  if (liquidity > 5000) {
    score += 0.5;
    reasons.push('Good liquidity');
  } else if (liquidity < 500) {
    score -= 1;
    reasons.push('Low liquidity risk');
  }

  // Volume momentum
  if (volume24h > 10000) {
    reasons.push('High volume market');
    score += 0.5;
  }

  return {
    score: Math.max(-1, Math.min(1, score / 5)),
    reasons,
    yesPrice,
    noPrice,
    minsToEnd: Math.round(minsToEnd),
    liquidity
  };
}

/**
 * Order flow analysis from orderbook
 */
function analyzeOrderFlow(orderbookData) {
  if (!orderbookData) return { signal: 'NEUTRAL', confidence: 0, reasons: [] };

  const reasons = [];
  let score = 0;

  const { bidPressure, askPressure, spread, imbalance, totalBidSize, totalAskSize } = orderbookData;

  // Order imbalance
  if (imbalance > 0.2) {
    score += 2;
    reasons.push(`Strong buy pressure (${(bidPressure * 100).toFixed(0)}% bids)`);
  } else if (imbalance < -0.2) {
    score -= 2;
    reasons.push(`Strong sell pressure (${(askPressure * 100).toFixed(0)}% asks)`);
  }

  // Tight spread = high confidence market
  if (spread < 0.03) {
    score += 0.5;
    reasons.push('Tight spread');
  } else if (spread > 0.15) {
    score -= 0.5;
    reasons.push('Wide spread - risky');
  }

  return {
    score: Math.max(-1, Math.min(1, score / 2.5)),
    reasons,
    imbalance,
    bidPressure,
    askPressure
  };
}

/**
 * Combine all signals into final trading decision
 */
function makeTradingDecision(taSignal, fundamentalSignal, orderFlowSignal) {
  // Weighted combination
  const weights = { ta: 0.4, fundamental: 0.35, orderFlow: 0.25 };
  
  const combinedScore = 
    (taSignal.score || 0) * weights.ta +
    (fundamentalSignal.score || 0) * weights.fundamental +
    (orderFlowSignal.score || 0) * weights.orderFlow;

  const confidence = Math.abs(combinedScore);
  
  let outcome = 'SKIP';
  let direction = null;

  // Only trade with high confidence
  if (combinedScore > 0.25) {
    outcome = 'YES';
    direction = 'BUY_YES';
  } else if (combinedScore < -0.25) {
    outcome = 'NO';
    direction = 'BUY_NO';
  }

  const allReasons = [
    ...((taSignal.reasons || []).map(r => `📊 ${r}`)),
    ...((fundamentalSignal.reasons || []).map(r => `📰 ${r}`)),
    ...((orderFlowSignal.reasons || []).map(r => `📈 ${r}`))
  ];

  return {
    outcome,
    direction,
    confidence,
    combinedScore,
    reasons: allReasons,
    shouldTrade: confidence > 0.25 && outcome !== 'SKIP',
    riskLevel: confidence < 0.4 ? 'LOW' : confidence < 0.6 ? 'MEDIUM' : 'HIGH'
  };
}

module.exports = {
  analyzePriceHistory,
  analyzeFundamentals,
  analyzeOrderFlow,
  makeTradingDecision
};
