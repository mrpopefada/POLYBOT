// src/index.js
require('dotenv').config();
const { Telegraf } = require('telegraf');
const express = require('express');
const logger = require('./utils/logger');
const { initDatabase } = require('./db/database');
const { startScheduler, setBotInstance } = require('./trading/scheduler');
const {
  handleStart, handleMenu, handleWallet,
  handleStartTrading, handleStopTrading,
  handleStats, handleHistory, handleWithdraw,
  handleWithdrawCommand, handleReferral,
  handleSettings, handleModeChange, handleHelp,
  handleAdmin
} = require('./bot/handlers');

// ─── Validate env vars ────────────────────────────────────────────────────────
const required = ['TELEGRAM_BOT_TOKEN', 'WALLET_ENCRYPTION_KEY', 'MASTER_WALLET_ADDRESS'];
for (const key of required) {
  if (!process.env[key]) {
    logger.error(`Missing required env var: ${key}`);
    process.exit(1);
  }
}

// ─── Init DB ──────────────────────────────────────────────────────────────────
initDatabase();

// ─── Create bot ───────────────────────────────────────────────────────────────
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

// ─── Commands ─────────────────────────────────────────────────────────────────
bot.start(handleStart);
bot.command('menu', handleMenu);
bot.command('withdraw', handleWithdrawCommand);
bot.command('admin', handleAdmin);
bot.command('balance', async (ctx) => {
  const user = require('./db/database').userQueries.getById.get(ctx.from.id.toString());
  if (!user) return ctx.reply('Use /start first.');
  ctx.replyWithMarkdown(`💰 Balance: *$${user.balance.toFixed(2)} USDC*`);
});

// ─── Callback queries ─────────────────────────────────────────────────────────
bot.action('menu', handleMenu);
bot.action('wallet', handleWallet);
bot.action('start_trading', handleStartTrading);
bot.action('stop_trading', handleStopTrading);
bot.action('stats', handleStats);
bot.action('history', handleHistory);
bot.action('withdraw', handleWithdraw);
bot.action('referral', handleReferral);
bot.action('settings', handleSettings);
bot.action('help', handleHelp);
bot.action('mode_aggressive', (ctx) => handleModeChange(ctx, 'aggressive'));
bot.action('mode_balanced', (ctx) => handleModeChange(ctx, 'balanced'));
bot.action('mode_conservative', (ctx) => handleModeChange(ctx, 'conservative'));

// ─── Error handler ────────────────────────────────────────────────────────────
bot.catch((err, ctx) => {
  logger.error(`Bot error for ${ctx.from?.id}: ${err.message}`);
  ctx.reply('⚠️ Something went wrong. Please try again.').catch(() => {});
});

// ─── Health check server ──────────────────────────────────────────────────────
const app = express();
app.get('/health', (req, res) => res.json({
  status: 'ok',
  uptime: process.uptime(),
  timestamp: new Date().toISOString()
}));
app.listen(process.env.PORT || 3000, () => {
  logger.info(`Health server on port ${process.env.PORT || 3000}`);
});

// ─── Start scheduler ──────────────────────────────────────────────────────────
setBotInstance(bot);
startScheduler();

// ─── Launch bot ───────────────────────────────────────────────────────────────
bot.launch().then(() => {
  logger.info('🤖 PolyTrader Bot is running!');
}).catch(err => {
  logger.error(`Failed to launch bot: ${err.message}`);
  process.exit(1);
});

// Graceful shutdown
process.once('SIGINT', () => { bot.stop('SIGINT'); process.exit(0); });
process.once('SIGTERM', () => { bot.stop('SIGTERM'); process.exit(0); });
