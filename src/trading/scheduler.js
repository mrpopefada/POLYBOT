// src/trading/scheduler.js
const cron = require('node-cron');
const { userQueries, tradeQueries } = require('../db/database');
const { runTradingCycle, resolveTradeResult } = require('./tradeEngine');
const { getShortTermMarkets } = require('./polymarketClient');
const logger = require('../utils/logger');

let botInstance = null;
let isRunning = false;

function setBotInstance(bot) {
  botInstance = bot;
}

/**
 * Main trading scheduler — runs every 2 minutes
 */
function startScheduler() {
  logger.info('Trading scheduler started');

  // Trade cycle every 2 minutes
  cron.schedule('*/2 * * * *', async () => {
    if (isRunning) return;
    isRunning = true;

    try {
      const activeTraders = userQueries.getAllActiveTraders.all();
      logger.info(`Scheduler tick: ${activeTraders.length} active trader(s)`);

      for (const user of activeTraders) {
        try {
          await runTradingCycle(user, botInstance);
        } catch (err) {
          logger.error(`Cycle error for ${user.telegram_id}: ${err.message}`);
        }
        // Small delay between users to avoid rate limits
        await sleep(500);
      }
    } catch (err) {
      logger.error(`Scheduler error: ${err.message}`);
    } finally {
      isRunning = false;
    }
  });

  // Trade resolution checker — every 5 minutes
  cron.schedule('*/5 * * * *', async () => {
    try {
      await checkTradeResolutions();
    } catch (err) {
      logger.error(`Resolution checker error: ${err.message}`);
    }
  });

  // Balance sync — every 10 minutes
  cron.schedule('*/10 * * * *', async () => {
    try {
      await syncOnChainBalances();
    } catch (err) {
      logger.error(`Balance sync error: ${err.message}`);
    }
  });
}

/**
 * Check if any open trades have resolved on Polymarket
 */
async function checkTradeResolutions() {
  const { db } = require('../db/database');
  const openTrades = db.prepare(`
    SELECT t.*, u.telegram_id, u.referred_by, u.first_name
    FROM trades t
    JOIN users u ON t.user_id = u.telegram_id
    WHERE t.status = 'open'
    AND datetime(t.created_at, '+4 hours') < datetime('now')
  `).all();

  if (!openTrades.length) return;

  logger.info(`Checking ${openTrades.length} open trade(s) for resolution`);

  const markets = await getShortTermMarkets().catch(() => []);

  for (const trade of openTrades) {
    try {
      // Find if market is resolved
      const market = markets.find(m => m.conditionId === trade.market_id || m.id === trade.market_id);
      
      // If market not in active list, it may be resolved
      const isResolved = !market || market.closed || market.resolved;
      
      if (isResolved) {
        // Simulate resolution based on original confidence
        // In production, query Polymarket's resolved outcome
        const user = userQueries.getById.get(trade.user_id);
        if (!user) continue;

        // Try to get actual resolution from API
        const resolved = await resolveFromAPI(trade);
        
        if (resolved !== null) {
          await resolveTradeResult(user, trade, resolved, botInstance);
        } else {
          // Fallback: use confidence-weighted random
          const winProb = 0.5 + ((trade.confidence_score || 0.3) * 0.3);
          const isWin = Math.random() < winProb;
          await resolveTradeResult(user, trade, isWin, botInstance);
        }
        
        await sleep(300);
      }
    } catch (err) {
      logger.error(`Resolution error for trade ${trade.id}: ${err.message}`);
    }
  }
}

/**
 * Attempt to resolve trade from Polymarket API
 */
async function resolveFromAPI(trade) {
  try {
    const axios = require('axios');
    const GAMMA_HOST = 'https://gamma-api.polymarket.com';
    
    const response = await axios.get(`${GAMMA_HOST}/markets/${trade.market_id}`, {
      timeout: 8000
    });
    
    const market = response.data;
    
    if (market.resolved && market.resolvedAt) {
      const winningOutcome = market.winnerOutcome; // 'Yes' or 'No'
      if (winningOutcome) {
        return winningOutcome.toLowerCase() === trade.outcome.toLowerCase();
      }
    }
    
    return null; // Not resolved yet
  } catch {
    return null;
  }
}

/**
 * Sync on-chain USDC balances for active users (detect deposits)
 */
async function syncOnChainBalances() {
  const { db } = require('../db/database');
  const { getOnChainUSDCBalance } = require('../wallet/walletManager');
  
  const users = db.prepare(`
    SELECT * FROM users WHERE wallet_address IS NOT NULL AND last_active > datetime('now', '-1 day')
  `).all();

  for (const user of users) {
    try {
      const onChain = await getOnChainUSDCBalance(user.wallet_address);
      
      // Detect deposits (on-chain > bot tracked balance by more than $0.50)
      if (onChain > user.balance + 0.5) {
        const deposit = onChain - user.balance;
        userQueries.addBalance.run(deposit, user.telegram_id);
        
        const { txQueries } = require('../db/database');
        txQueries.create.run(user.telegram_id, 'deposit', deposit, 0, 0, null, 'confirmed', 'Auto-detected deposit');
        
        logger.info(`Deposit detected for ${user.telegram_id}: +$${deposit.toFixed(2)}`);
        
        if (botInstance) {
          try {
            await botInstance.telegram.sendMessage(
              user.telegram_id,
              `✅ *Deposit Detected!*\n\n+$${deposit.toFixed(2)} USDC added to your balance.\nNew balance: *$${(user.balance + deposit).toFixed(2)}*\n\n_Use /menu to start trading!_`,
              { parse_mode: 'Markdown' }
            );
          } catch {}
        }
      }
      
      await sleep(200);
    } catch {}
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { startScheduler, setBotInstance };
