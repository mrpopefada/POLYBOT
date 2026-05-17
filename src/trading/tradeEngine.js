// src/trading/tradeEngine.js
const { userQueries, tradeQueries, txQueries, feeQueries } = require('../db/database');
const { getShortTermMarkets, getMarketDetail, getPriceHistory, analyzeOrderbook, placeCLOBOrder } = require('./polymarketClient');
const { analyzePriceHistory, analyzeFundamentals, analyzeOrderFlow, makeTradingDecision } = require('./technicalAnalysis');
const { getWalletSigner, transferUSDC } = require('../wallet/walletManager');
const logger = require('../utils/logger');

const PLATFORM_FEE = parseFloat(process.env.PLATFORM_FEE_PERCENT || 5) / 100;
const REFERRAL_FEE = parseFloat(process.env.REFERRAL_FEE_PERCENT || 5) / 100;
const MASTER_WALLET = process.env.MASTER_WALLET_ADDRESS;

// Aggressive position sizing for $10→$100 goal
// Uses Kelly Criterion variant
function calculatePositionSize(balance, confidence, mode = 'aggressive') {
  const minBet = 0.5;
  const maxBetPercent = mode === 'aggressive' ? 0.30 : 0.15;
  
  // Kelly fraction: f = (bp - q) / b
  // b = odds-1, p = win prob, q = 1-p
  const winProb = 0.5 + (confidence * 0.35); // confidence maps to win probability
  const odds = 1 / (0.5 - (confidence * 0.1)); // rough odds calc
  const kellyFraction = Math.max(0, ((odds * winProb) - (1 - winProb)) / odds);
  const halfKelly = kellyFraction * 0.5; // Use half-Kelly for safety
  
  const betPercent = Math.min(maxBetPercent, Math.max(0.08, halfKelly));
  const rawAmount = balance * betPercent;
  
  return Math.max(minBet, Math.min(rawAmount, balance * maxBetPercent));
}

/**
 * Main trading loop for a single user
 */
async function runTradingCycle(user, botInstance) {
  const telegramId = user.telegram_id;
  logger.info(`Starting trade cycle for user ${telegramId}, balance: $${user.balance}`);

  try {
    // Check if user has enough balance
    if (user.balance < 0.5) {
      logger.info(`User ${telegramId} balance too low: $${user.balance}`);
      return;
    }

    // Check active trades count
    const activeTrades = tradeQueries.getActiveTrades.all(telegramId);
    if (activeTrades.length >= parseInt(process.env.MAX_CONCURRENT_TRADES || 3)) {
      logger.info(`User ${telegramId} has max concurrent trades`);
      return;
    }

    // Get markets
    const markets = await getShortTermMarkets();
    if (!markets.length) {
      logger.warn('No short-term markets available');
      return;
    }

    // Analyze each market and find best opportunity
    let bestOpportunity = null;
    let bestScore = 0;

    for (const market of markets.slice(0, 10)) {
      try {
        const [marketDetail, priceHistory] = await Promise.all([
          getMarketDetail(market.conditionId || market.id),
          getPriceHistory(market.conditionId || market.id)
        ]);

        if (!marketDetail) continue;

        const orderbookAnalysis = analyzeOrderbook(marketDetail.orderbook);
        const taSignal = analyzePriceHistory(priceHistory);
        const fundamentalSignal = analyzeFundamentals(market);
        const orderFlowSignal = analyzeOrderFlow(orderbookAnalysis);
        
        const decision = makeTradingDecision(taSignal, fundamentalSignal, orderFlowSignal);

        logger.info(`Market: "${market.question?.slice(0, 50)}" | Score: ${decision.combinedScore.toFixed(3)} | Outcome: ${decision.outcome}`);

        if (decision.shouldTrade && decision.confidence > bestScore) {
          bestScore = decision.confidence;
          bestOpportunity = {
            market,
            decision,
            taSignal,
            fundamentalSignal,
            orderbookAnalysis
          };
        }
      } catch (err) {
        logger.error(`Market analysis error: ${err.message}`);
        continue;
      }
    }

    if (!bestOpportunity) {
      logger.info(`No good opportunities found for user ${telegramId}`);
      return null;
    }

    // Place the trade
    return await executeTrade(user, bestOpportunity, botInstance);

  } catch (err) {
    logger.error(`Trade cycle error for ${telegramId}: ${err.message}`);
    return null;
  }
}

/**
 * Execute a specific trade
 */
async function executeTrade(user, opportunity, botInstance) {
  const { market, decision, taSignal, fundamentalSignal } = opportunity;
  const telegramId = user.telegram_id;

  // Re-fetch latest user state
  const freshUser = userQueries.getById.get(telegramId);
  if (!freshUser || freshUser.balance < 0.5) return null;

  const tradeAmount = calculatePositionSize(
    freshUser.balance,
    decision.confidence,
    user.trading_mode || 'aggressive'
  );

  const yesPrice = fundamentalSignal.yesPrice;
  const noPrice = 1 - yesPrice;
  
  const isYesBet = decision.outcome === 'YES';
  const betPrice = isYesBet ? yesPrice : noPrice;
  const potentialPayout = tradeAmount / betPrice;
  const potentialProfit = potentialPayout - tradeAmount;

  logger.info(`Placing ${decision.outcome} trade: $${tradeAmount.toFixed(2)} @ ${betPrice.toFixed(3)} | Payout: $${potentialPayout.toFixed(2)}`);

  // Deduct from user balance immediately (optimistic)
  const deducted = userQueries.deductBalance.run(tradeAmount, telegramId, tradeAmount);
  if (deducted.changes === 0) {
    logger.error(`Failed to deduct balance for ${telegramId}`);
    return null;
  }

  // Create trade record
  const tradeRecord = tradeQueries.create.run(
    telegramId,
    market.conditionId || market.id,
    market.question,
    decision.outcome,
    tradeAmount,
    potentialPayout,
    decision.reasons.slice(0, 3).join(' | '),
    decision.confidence,
    betPrice
  );
  const tradeId = tradeRecord.lastInsertRowid;

  // Attempt on-chain order (if wallet is set up for CLOB)
  let orderId = null;
  try {
    if (freshUser.encrypted_private_key) {
      const signer = getWalletSigner(freshUser.encrypted_private_key);
      const tokenId = isYesBet
        ? (market.clobTokenIds?.[0] || market.conditionId)
        : (market.clobTokenIds?.[1] || market.conditionId);
        
      const orderResult = await placeCLOBOrder(
        signer,
        tokenId,
        'BUY',
        betPrice,
        tradeAmount
      );
      
      if (orderResult.success) {
        orderId = orderResult.orderId;
        tradeQueries.updateOrderId.run(orderId, tradeId);
      }
    }
  } catch (err) {
    logger.error(`On-chain order error: ${err.message}`);
    // Continue — simulated resolution below
  }

  // Notify user
  if (botInstance) {
    const msg = `🤖 *Trade Placed!*\n\n` +
      `📋 *Market:* ${market.question?.slice(0, 80)}...\n` +
      `🎯 *Betting:* ${decision.outcome} @ ${(betPrice * 100).toFixed(1)}¢\n` +
      `💵 *Amount:* $${tradeAmount.toFixed(2)}\n` +
      `💰 *Potential win:* $${potentialPayout.toFixed(2)} (+$${potentialProfit.toFixed(2)})\n` +
      `📊 *Confidence:* ${(decision.confidence * 100).toFixed(0)}%\n` +
      `🧠 *Analysis:* ${decision.reasons.slice(0, 2).join(', ')}\n\n` +
      `_Your balance: $${(freshUser.balance - tradeAmount).toFixed(2)}_`;

    try {
      await botInstance.telegram.sendMessage(telegramId, msg, { parse_mode: 'Markdown' });
    } catch {}
  }

  return { tradeId, orderId, tradeAmount, potentialPayout, decision };
}

/**
 * Process trade resolution (win/loss)
 */
async function resolveTradeResult(user, trade, isWin, botInstance) {
  const telegramId = user.telegram_id;
  const freshUser = userQueries.getById.get(telegramId);

  let profitLoss = 0;
  let grossPayout = 0;

  if (isWin) {
    grossPayout = trade.potential_payout || trade.amount * 1.8;
    profitLoss = grossPayout - trade.amount;

    // Calculate fees
    const platformFeeAmount = grossPayout * PLATFORM_FEE;
    const referralFeeAmount = freshUser.referred_by ? grossPayout * REFERRAL_FEE : 0;
    const totalFees = platformFeeAmount + referralFeeAmount;
    const netPayout = grossPayout - totalFees;

    // Credit user with net payout
    userQueries.addBalance.run(netPayout, telegramId);
    userQueries.updateStats.run(profitLoss, 0, telegramId);

    // Record platform fee
    feeQueries.record.run(telegramId, trade.id, 'platform', platformFeeAmount);

    // Pay referral
    if (freshUser.referred_by && referralFeeAmount > 0) {
      const referrer = userQueries.getByReferralCode.get(freshUser.referred_by);
      if (referrer) {
        userQueries.addReferralEarning.run(referralFeeAmount, referralFeeAmount, referrer.telegram_id);
        feeQueries.record.run(telegramId, trade.id, 'referral', referralFeeAmount);
        
        // Notify referrer
        if (botInstance) {
          try {
            await botInstance.telegram.sendMessage(
              referrer.telegram_id,
              `💸 *Referral Bonus!* Your referral ${freshUser.first_name || 'user'} won! You earned $${referralFeeAmount.toFixed(3)} 🎉`,
              { parse_mode: 'Markdown' }
            );
          } catch {}
        }
      }
    }

    tradeQueries.updateStatus.run('won', profitLoss, grossPayout > 0 ? grossPayout / trade.amount : 1, trade.id);

    // Notify user of win
    if (botInstance) {
      const currentBalance = userQueries.getById.get(telegramId);
      const msg = `✅ *Trade WON!*\n\n` +
        `📋 ${trade.market_question?.slice(0, 60)}\n` +
        `💵 Bet: $${trade.amount.toFixed(2)} → $${netPayout.toFixed(2)}\n` +
        `📈 Profit: +$${(netPayout - trade.amount).toFixed(2)}\n` +
        `🏦 Fee: $${platformFeeAmount.toFixed(3)} (5%)\n` +
        (referralFeeAmount > 0 ? `👥 Referral: $${referralFeeAmount.toFixed(3)} paid\n` : '') +
        `\n💰 *New Balance: $${currentBalance.balance.toFixed(2)}*`;

      try {
        await botInstance.telegram.sendMessage(telegramId, msg, { parse_mode: 'Markdown' });
      } catch {}
    }

  } else {
    // Loss
    profitLoss = -trade.amount;
    userQueries.updateStats.run(0, trade.amount, telegramId);
    tradeQueries.updateStatus.run('lost', profitLoss, 0, trade.id);

    if (botInstance) {
      const currentBalance = userQueries.getById.get(telegramId);
      const msg = `❌ *Trade Lost*\n\n` +
        `📋 ${trade.market_question?.slice(0, 60)}\n` +
        `💵 Lost: $${trade.amount.toFixed(2)}\n` +
        `💰 *Balance: $${currentBalance.balance.toFixed(2)}*\n\n` +
        `_The bot will find the next opportunity..._`;

      try {
        await botInstance.telegram.sendMessage(telegramId, msg, { parse_mode: 'Markdown' });
      } catch {}
    }
  }

  return { isWin, profitLoss, grossPayout };
}

module.exports = {
  runTradingCycle,
  executeTrade,
  resolveTradeResult,
  calculatePositionSize
};
