// src/bot/handlers.js
const { Markup } = require('telegraf');
const { v4: uuidv4 } = require('uuid');
const { userQueries, tradeQueries, txQueries } = require('../db/database');
const { createEmbeddedWallet, getOnChainUSDCBalance, transferUSDC, shortAddress, getMATICBalance } = require('../wallet/walletManager');
const { runTradingCycle } = require('../trading/tradeEngine');
const logger = require('../utils/logger');

const MASTER_WALLET = process.env.MASTER_WALLET_ADDRESS;
const PLATFORM_FEE = parseFloat(process.env.PLATFORM_FEE_PERCENT || 5);
const REFERRAL_FEE = parseFloat(process.env.REFERRAL_FEE_PERCENT || 5);

function generateReferralCode(telegramId) {
  return 'PM' + telegramId.toString().slice(-4) + Math.random().toString(36).substring(2, 6).toUpperCase();
}

// ─── /start ───────────────────────────────────────────────────────────────────
async function handleStart(ctx) {
  const telegramId = ctx.from.id.toString();
  const username = ctx.from.username || '';
  const firstName = ctx.from.first_name || 'Trader';
  const args = ctx.message?.text?.split(' ');
  const referralCode = args?.[1] || null;

  let user = userQueries.getById.get(telegramId);

  if (!user) {
    // New user — create account
    const myReferralCode = generateReferralCode(telegramId);
    let referredBy = null;

    if (referralCode) {
      const referrer = userQueries.getByReferralCode.get(referralCode);
      if (referrer && referrer.telegram_id !== telegramId) {
        referredBy = referralCode;
      }
    }

    userQueries.create.run(telegramId, username, firstName, myReferralCode, referredBy);

    // Create embedded wallet
    await createEmbeddedWallet(telegramId);
    user = userQueries.getById.get(telegramId);

    const welcomeMsg =
      `🚀 *Welcome to PolyTrader Bot, ${firstName}!*\n\n` +
      `Your account has been created with an *embedded wallet* — no external wallet needed.\n\n` +
      `🔐 *Your Wallet Address:*\n\`${user.wallet_address}\`\n\n` +
      `📌 *This wallet runs on Polygon network. Fund it with USDC to start trading.*\n\n` +
      `⚡ The bot will automatically trade Polymarket prediction markets using:\n` +
      `• Technical Analysis (RSI, MACD, Bollinger Bands, EMA)\n` +
      `• Fundamental Market Analysis\n` +
      `• Order Flow & Liquidity Analysis\n\n` +
      `💸 *Fee Structure:*\n` +
      `• ${PLATFORM_FEE}% platform fee on wins\n` +
      `• ${REFERRAL_FEE}% referral bonus on wins\n\n` +
      (referredBy ? `👥 You were referred! Your referrer earns ${REFERRAL_FEE}% of your wins.\n\n` : '') +
      `📲 Use /menu to get started.`;

    await ctx.replyWithMarkdown(welcomeMsg);
  } else {
    await ctx.replyWithMarkdown(
      `👋 *Welcome back, ${firstName}!*\n\n💰 Balance: $${user.balance.toFixed(2)}\n\nUse /menu to continue.`
    );
  }
}

// ─── /menu ────────────────────────────────────────────────────────────────────
async function handleMenu(ctx) {
  const telegramId = ctx.from.id.toString();
  const user = userQueries.getById.get(telegramId);
  if (!user) return ctx.reply('Please use /start first.');

  const isTrading = user.is_trading_active === 1;

  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback('💰 Balance & Wallet', 'wallet'),
      Markup.button.callback('📊 My Stats', 'stats')
    ],
    [
      Markup.button.callback(isTrading ? '🛑 Stop Trading' : '▶️ Start Trading', isTrading ? 'stop_trading' : 'start_trading'),
      Markup.button.callback('📜 Trade History', 'history')
    ],
    [
      Markup.button.callback('💸 Withdraw', 'withdraw'),
      Markup.button.callback('👥 Referral Program', 'referral')
    ],
    [
      Markup.button.callback('⚙️ Trading Mode', 'settings'),
      Markup.button.callback('ℹ️ Help', 'help')
    ]
  ]);

  await ctx.replyWithMarkdown(
    `🤖 *PolyTrader Bot Menu*\n\n` +
    `💰 Balance: *$${user.balance.toFixed(2)}*\n` +
    `📈 Status: ${isTrading ? '🟢 Trading Active' : '🔴 Trading Stopped'}\n` +
    `🏆 Total Won: $${user.total_won.toFixed(2)}\n` +
    `📉 Total Lost: $${user.total_lost.toFixed(2)}`,
    keyboard
  );
}

// ─── Wallet info ──────────────────────────────────────────────────────────────
async function handleWallet(ctx) {
  const telegramId = ctx.from.id.toString();
  const user = userQueries.getById.get(telegramId);
  if (!user) return ctx.reply('Use /start first.');

  await ctx.answerCbQuery?.();

  // Fetch on-chain balance
  const onChainBalance = await getOnChainUSDCBalance(user.wallet_address);
  const maticBalance = await getMATICBalance(user.wallet_address);

  // Sync if on-chain > bot balance (deposit detected)
  if (onChainBalance > user.balance) {
    const deposit = onChainBalance - user.balance;
    userQueries.addBalance.run(deposit, telegramId);
    txQueries.create.run(telegramId, 'deposit', deposit, 0, 0, null, 'confirmed', 'On-chain deposit detected');
    
    await ctx.replyWithMarkdown(
      `✅ *Deposit Detected!*\n+$${deposit.toFixed(2)} USDC added to your balance.`
    );
  }

  const freshUser = userQueries.getById.get(telegramId);

  const msg =
    `💳 *Your Embedded Wallet*\n\n` +
    `🔗 *Address:*\n\`${user.wallet_address}\`\n\n` +
    `💵 *Bot Balance:* $${freshUser.balance.toFixed(2)} USDC\n` +
    `🔗 *On-Chain USDC:* $${onChainBalance.toFixed(2)}\n` +
    `⛽ *MATIC (gas):* ${maticBalance.toFixed(4)} MATIC\n\n` +
    `📌 *Network:* Polygon (MATIC)\n` +
    `📌 *Token:* USDC\n\n` +
    `💡 Send USDC to your wallet address above to deposit.\n` +
    `⚠️ You need a small amount of MATIC for gas fees (~0.1 MATIC).`;

  await ctx.replyWithMarkdown(msg, Markup.inlineKeyboard([
    [Markup.button.callback('🔄 Refresh Balance', 'wallet')],
    [Markup.button.callback('💸 Withdraw Funds', 'withdraw')],
    [Markup.button.callback('« Back', 'menu')]
  ]));
}

// ─── Start Trading ────────────────────────────────────────────────────────────
async function handleStartTrading(ctx) {
  const telegramId = ctx.from.id.toString();
  const user = userQueries.getById.get(telegramId);
  await ctx.answerCbQuery?.();

  if (!user) return ctx.reply('Use /start first.');
  if (user.balance < 1) {
    return ctx.replyWithMarkdown(
      `❌ *Insufficient balance!*\n\nYou need at least $1.00 USDC to start trading.\n\nDeposit USDC to your wallet:\n\`${user.wallet_address}\``
    );
  }

  userQueries.setTradingActive.run(1, telegramId);

  await ctx.replyWithMarkdown(
    `✅ *Trading Activated!*\n\n` +
    `The bot will now automatically scan Polymarket for high-confidence trades every 2 minutes.\n\n` +
    `💰 Starting balance: *$${user.balance.toFixed(2)}*\n` +
    `🎯 Mode: *${user.trading_mode || 'aggressive'}*\n\n` +
    `You'll receive notifications for every trade placed and resolved.\n\n` +
    `Use /menu → Stop Trading to pause at any time.`
  );
}

// ─── Stop Trading ─────────────────────────────────────────────────────────────
async function handleStopTrading(ctx) {
  const telegramId = ctx.from.id.toString();
  await ctx.answerCbQuery?.();
  userQueries.setTradingActive.run(0, telegramId);
  const user = userQueries.getById.get(telegramId);

  await ctx.replyWithMarkdown(
    `🛑 *Trading Stopped*\n\n` +
    `Current balance: *$${user.balance.toFixed(2)}*\n\n` +
    `Any open trades will still resolve. Use /menu to restart.`
  );
}

// ─── Stats ────────────────────────────────────────────────────────────────────
async function handleStats(ctx) {
  const telegramId = ctx.from.id.toString();
  const user = userQueries.getById.get(telegramId);
  await ctx.answerCbQuery?.();
  if (!user) return;

  const trades = tradeQueries.getRecentTrades.all(telegramId);
  const wonTrades = trades.filter(t => t.status === 'won').length;
  const lostTrades = trades.filter(t => t.status === 'lost').length;
  const totalTrades = wonTrades + lostTrades;
  const winRate = totalTrades > 0 ? ((wonTrades / totalTrades) * 100).toFixed(1) : '0';
  const roi = user.total_deposited > 0
    ? (((user.balance - user.total_deposited) / user.total_deposited) * 100).toFixed(1)
    : '0';

  const msg =
    `📊 *Your Trading Stats*\n\n` +
    `💰 Current Balance: *$${user.balance.toFixed(2)}*\n` +
    `📥 Total Deposited: $${user.total_deposited.toFixed(2)}\n` +
    `📤 Total Withdrawn: $${user.total_withdrawn.toFixed(2)}\n\n` +
    `✅ Total Won: $${user.total_won.toFixed(2)}\n` +
    `❌ Total Lost: $${user.total_lost.toFixed(2)}\n` +
    `📈 ROI: ${roi}%\n\n` +
    `🎯 Win Rate: ${winRate}% (${wonTrades}W / ${lostTrades}L)\n` +
    `🔢 Total Trades: ${totalTrades}\n` +
    `👥 Referral Earnings: $${user.referral_earnings.toFixed(2)}\n`;

  await ctx.replyWithMarkdown(msg, Markup.inlineKeyboard([
    [Markup.button.callback('« Back to Menu', 'menu')]
  ]));
}

// ─── Trade History ────────────────────────────────────────────────────────────
async function handleHistory(ctx) {
  const telegramId = ctx.from.id.toString();
  await ctx.answerCbQuery?.();
  const trades = tradeQueries.getRecentTrades.all(telegramId);

  if (!trades.length) {
    return ctx.replyWithMarkdown('No trades yet. Start trading to see history here!');
  }

  let msg = `📜 *Recent Trades*\n\n`;
  trades.slice(0, 8).forEach((t, i) => {
    const statusIcon = t.status === 'won' ? '✅' : t.status === 'lost' ? '❌' : '⏳';
    const pl = t.profit_loss >= 0 ? `+$${t.profit_loss.toFixed(2)}` : `-$${Math.abs(t.profit_loss).toFixed(2)}`;
    const date = new Date(t.created_at).toLocaleDateString();
    msg += `${statusIcon} *${t.outcome}* $${t.amount.toFixed(2)} → ${pl} | ${date}\n`;
    msg += `   _${t.market_question?.slice(0, 45) || 'Market'}..._\n\n`;
  });

  await ctx.replyWithMarkdown(msg, Markup.inlineKeyboard([
    [Markup.button.callback('« Back', 'menu')]
  ]));
}

// ─── Withdraw ─────────────────────────────────────────────────────────────────
async function handleWithdraw(ctx) {
  const telegramId = ctx.from.id.toString();
  const user = userQueries.getById.get(telegramId);
  await ctx.answerCbQuery?.();

  if (!user || user.balance < 1) {
    return ctx.replyWithMarkdown(
      `❌ *Insufficient balance*\n\nMinimum withdrawal is $1.00.\nYour balance: $${user?.balance?.toFixed(2) || '0.00'}`
    );
  }

  await ctx.replyWithMarkdown(
    `💸 *Withdraw Funds*\n\n` +
    `Available balance: *$${user.balance.toFixed(2)} USDC*\n\n` +
    `To withdraw, send the command:\n` +
    `\`/withdraw <amount> <polygon_address>\`\n\n` +
    `Example:\n\`/withdraw 50 0xYourPolygonAddress\`\n\n` +
    `⚠️ Minimum: $1.00 | Funds sent as USDC on Polygon`
  );
}

async function handleWithdrawCommand(ctx) {
  const telegramId = ctx.from.id.toString();
  const user = userQueries.getById.get(telegramId);
  const args = ctx.message.text.split(' ');

  if (args.length < 3) {
    return ctx.replyWithMarkdown('Usage: `/withdraw <amount> <polygon_address>`');
  }

  const amount = parseFloat(args[1]);
  const toAddress = args[2];

  if (isNaN(amount) || amount < 1) {
    return ctx.reply('❌ Invalid amount. Minimum withdrawal is $1.00');
  }

  if (!toAddress.startsWith('0x') || toAddress.length !== 42) {
    return ctx.reply('❌ Invalid Polygon wallet address.');
  }

  if (!user || user.balance < amount) {
    return ctx.replyWithMarkdown(`❌ Insufficient balance. You have $${user?.balance?.toFixed(2) || '0'}`);
  }

  // Stop trading during withdrawal
  userQueries.setTradingActive.run(0, telegramId);

  await ctx.reply('⏳ Processing withdrawal...');

  // Deduct balance
  userQueries.deductBalance.run(amount, telegramId, amount);

  // Transfer USDC on-chain
  const result = await transferUSDC(user.encrypted_private_key, toAddress, amount);

  if (result.success) {
    // Record transaction
    txQueries.create.run(telegramId, 'withdrawal', amount, 0, 0, result.txHash, 'confirmed', `Withdrawal to ${shortAddress(toAddress)}`);

    // Update withdrawn total
    const { db } = require('../db/database');
    db.prepare('UPDATE users SET total_withdrawn = total_withdrawn + ? WHERE telegram_id = ?').run(amount, telegramId);

    await ctx.replyWithMarkdown(
      `✅ *Withdrawal Successful!*\n\n` +
      `💵 Amount: $${amount.toFixed(2)} USDC\n` +
      `📬 To: \`${shortAddress(toAddress)}\`\n` +
      `🔗 TX: \`${result.txHash}\`\n\n` +
      `Check on [Polygonscan](https://polygonscan.com/tx/${result.txHash})`
    );
  } else {
    // Refund on failure
    userQueries.addBalance.run(amount, telegramId);
    await ctx.replyWithMarkdown(
      `❌ *Withdrawal Failed*\n\nError: ${result.error}\n\nYour funds have been returned to your balance.`
    );
  }
}

// ─── Referral Program ─────────────────────────────────────────────────────────
async function handleReferral(ctx) {
  const telegramId = ctx.from.id.toString();
  const user = userQueries.getById.get(telegramId);
  await ctx.answerCbQuery?.();

  const botUsername = ctx.botInfo?.username || 'PolyTraderBot';
  const refLink = `https://t.me/${botUsername}?start=${user.referral_code}`;

  const msg =
    `👥 *Referral Program*\n\n` +
    `Share your link and earn *${REFERRAL_FEE}%* of every win your referrals make — automatically!\n\n` +
    `🔗 *Your referral link:*\n${refLink}\n\n` +
    `📌 *Your referral code:* \`${user.referral_code}\`\n\n` +
    `💸 *Total earned from referrals:* $${user.referral_earnings.toFixed(2)}\n\n` +
    `_Referral bonuses are credited instantly when your referrals win trades._`;

  await ctx.replyWithMarkdown(msg, Markup.inlineKeyboard([
    [Markup.button.callback('« Back', 'menu')]
  ]));
}

// ─── Settings ─────────────────────────────────────────────────────────────────
async function handleSettings(ctx) {
  const telegramId = ctx.from.id.toString();
  const user = userQueries.getById.get(telegramId);
  await ctx.answerCbQuery?.();

  await ctx.replyWithMarkdown(
    `⚙️ *Trading Mode*\n\nCurrent: *${user.trading_mode || 'aggressive'}*\n\n` +
    `• *Aggressive* — 25-30% per trade, higher risk, faster growth\n` +
    `• *Balanced* — 15-20% per trade, moderate risk\n` +
    `• *Conservative* — 8-12% per trade, lower risk, slower growth`,
    Markup.inlineKeyboard([
      [
        Markup.button.callback('🔥 Aggressive', 'mode_aggressive'),
        Markup.button.callback('⚖️ Balanced', 'mode_balanced')
      ],
      [
        Markup.button.callback('🛡 Conservative', 'mode_conservative')
      ],
      [Markup.button.callback('« Back', 'menu')]
    ])
  );
}

async function handleModeChange(ctx, mode) {
  const telegramId = ctx.from.id.toString();
  await ctx.answerCbQuery?.();
  const { db } = require('../db/database');
  db.prepare('UPDATE users SET trading_mode = ? WHERE telegram_id = ?').run(mode, telegramId);
  await ctx.replyWithMarkdown(`✅ Trading mode set to *${mode}*`);
}

// ─── Help ─────────────────────────────────────────────────────────────────────
async function handleHelp(ctx) {
  await ctx.answerCbQuery?.();
  await ctx.replyWithMarkdown(
    `ℹ️ *PolyTrader Bot Help*\n\n` +
    `*Commands:*\n` +
    `/start — Create account & wallet\n` +
    `/menu — Main menu\n` +
    `/withdraw <amount> <address> — Withdraw USDC\n\n` +
    `*How it works:*\n` +
    `1. Fund your embedded wallet with USDC on Polygon\n` +
    `2. Press "Start Trading"\n` +
    `3. Bot scans markets every 2 mins\n` +
    `4. Places high-confidence trades automatically\n` +
    `5. Wins credited minus 5% fee\n\n` +
    `*Fees:*\n` +
    `• 5% of gross win → platform\n` +
    `• 5% of gross win → referrer (if applicable)\n\n` +
    `*Risk Warning:* Prediction markets are high-risk. Only trade what you can afford to lose.`
  );
}

// ─── Admin command ────────────────────────────────────────────────────────────
async function handleAdmin(ctx) {
  if (ctx.from.id.toString() !== process.env.ADMIN_TELEGRAM_ID) {
    return ctx.reply('Unauthorized.');
  }

  const { feeQueries, db } = require('../db/database');
  const totalFees = feeQueries.getTotalFees.get();
  const totalUsers = db.prepare('SELECT COUNT(*) as c FROM users').get();
  const activeTraders = db.prepare('SELECT COUNT(*) as c FROM users WHERE is_trading_active = 1').get();
  const totalTrades = db.prepare('SELECT COUNT(*) as c FROM trades').get();

  await ctx.replyWithMarkdown(
    `🔐 *Admin Dashboard*\n\n` +
    `👥 Total Users: ${totalUsers.c}\n` +
    `📈 Active Traders: ${activeTraders.c}\n` +
    `🔢 Total Trades: ${totalTrades.c}\n` +
    `💰 Platform Fees Collected: $${(totalFees.total || 0).toFixed(4)}\n` +
    `🏦 Master Wallet: \`${MASTER_WALLET}\``
  );
}

module.exports = {
  handleStart,
  handleMenu,
  handleWallet,
  handleStartTrading,
  handleStopTrading,
  handleStats,
  handleHistory,
  handleWithdraw,
  handleWithdrawCommand,
  handleReferral,
  handleSettings,
  handleModeChange,
  handleHelp,
  handleAdmin
};
