// src/db/database.js
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const logger = require('../utils/logger');

const DB_PATH = process.env.DB_PATH || '/tmp/bot.db';

// Ensure data directory exists
const dir = path.dirname(DB_PATH);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

const db = new Database(DB_PATH);

// Enable WAL mode for performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function initDatabase() {
  db.exec(`
    -- Users table
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id TEXT UNIQUE NOT NULL,
      username TEXT,
      first_name TEXT,
      wallet_address TEXT UNIQUE,
      encrypted_private_key TEXT,
      balance REAL DEFAULT 0,
      total_deposited REAL DEFAULT 0,
      total_withdrawn REAL DEFAULT 0,
      total_won REAL DEFAULT 0,
      total_lost REAL DEFAULT 0,
      referral_code TEXT UNIQUE,
      referred_by TEXT,
      referral_earnings REAL DEFAULT 0,
      is_trading_active INTEGER DEFAULT 0,
      trading_mode TEXT DEFAULT 'balanced',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_active DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Trades table
    CREATE TABLE IF NOT EXISTS trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      market_id TEXT NOT NULL,
      market_question TEXT,
      outcome TEXT NOT NULL,
      amount REAL NOT NULL,
      potential_payout REAL,
      polymarket_order_id TEXT,
      status TEXT DEFAULT 'pending',
      entry_price REAL,
      exit_price REAL,
      profit_loss REAL DEFAULT 0,
      strategy_used TEXT,
      confidence_score REAL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      resolved_at DATETIME,
      FOREIGN KEY (user_id) REFERENCES users(telegram_id)
    );

    -- Transactions table
    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      type TEXT NOT NULL,
      amount REAL NOT NULL,
      fee_amount REAL DEFAULT 0,
      referral_amount REAL DEFAULT 0,
      tx_hash TEXT,
      status TEXT DEFAULT 'pending',
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(telegram_id)
    );

    -- Platform fees table (master wallet tracking)
    CREATE TABLE IF NOT EXISTS platform_fees (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_user_id TEXT,
      trade_id INTEGER,
      fee_type TEXT,
      amount REAL NOT NULL,
      tx_hash TEXT,
      collected_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Market cache table
    CREATE TABLE IF NOT EXISTS market_cache (
      market_id TEXT PRIMARY KEY,
      question TEXT,
      end_date TEXT,
      yes_price REAL,
      no_price REAL,
      volume REAL,
      liquidity REAL,
      last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Bot settings
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Initialize default settings
  const insertSetting = db.prepare(`
    INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)
  `);
  insertSetting.run('total_platform_fees', '0');
  insertSetting.run('total_trades_executed', '0');
  insertSetting.run('bot_active', 'true');

  logger.info('Database initialized successfully');
}

// User queries
const userQueries = {
  create: db.prepare(`
    INSERT INTO users (telegram_id, username, first_name, referral_code, referred_by)
    VALUES (?, ?, ?, ?, ?)
  `),
  
  getById: db.prepare(`SELECT * FROM users WHERE telegram_id = ?`),
  
  updateWallet: db.prepare(`
    UPDATE users SET wallet_address = ?, encrypted_private_key = ? WHERE telegram_id = ?
  `),
  
  updateBalance: db.prepare(`
    UPDATE users SET balance = ?, last_active = CURRENT_TIMESTAMP WHERE telegram_id = ?
  `),

  addBalance: db.prepare(`
    UPDATE users SET balance = balance + ?, last_active = CURRENT_TIMESTAMP WHERE telegram_id = ?
  `),

  deductBalance: db.prepare(`
    UPDATE users SET balance = balance - ? WHERE telegram_id = ? AND balance >= ?
  `),

  setTradingActive: db.prepare(`
    UPDATE users SET is_trading_active = ? WHERE telegram_id = ?
  `),

  getByReferralCode: db.prepare(`SELECT * FROM users WHERE referral_code = ?`),

  addReferralEarning: db.prepare(`
    UPDATE users SET referral_earnings = referral_earnings + ?, balance = balance + ? WHERE telegram_id = ?
  `),

  updateStats: db.prepare(`
    UPDATE users SET total_won = total_won + ?, total_lost = total_lost + ? WHERE telegram_id = ?
  `),

  getAllActiveTraders: db.prepare(`
    SELECT * FROM users WHERE is_trading_active = 1 AND balance > 0.5
  `)
};

// Trade queries
const tradeQueries = {
  create: db.prepare(`
    INSERT INTO trades (user_id, market_id, market_question, outcome, amount, potential_payout, strategy_used, confidence_score, entry_price)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),

  updateStatus: db.prepare(`
    UPDATE trades SET status = ?, resolved_at = CURRENT_TIMESTAMP, profit_loss = ?, exit_price = ?
    WHERE id = ?
  `),

  getActiveTrades: db.prepare(`
    SELECT * FROM trades WHERE user_id = ? AND status = 'open'
  `),

  getRecentTrades: db.prepare(`
    SELECT * FROM trades WHERE user_id = ? ORDER BY created_at DESC LIMIT 10
  `),

  updateOrderId: db.prepare(`
    UPDATE trades SET polymarket_order_id = ?, status = 'open' WHERE id = ?
  `)
};

// Transaction queries
const txQueries = {
  create: db.prepare(`
    INSERT INTO transactions (user_id, type, amount, fee_amount, referral_amount, tx_hash, status, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `),

  getHistory: db.prepare(`
    SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 20
  `)
};

// Fee queries
const feeQueries = {
  record: db.prepare(`
    INSERT INTO platform_fees (source_user_id, trade_id, fee_type, amount)
    VALUES (?, ?, ?, ?)
  `),

  getTotalFees: db.prepare(`SELECT SUM(amount) as total FROM platform_fees`)
};

module.exports = {
  db,
  initDatabase,
  userQueries,
  tradeQueries,
  txQueries,
  feeQueries
};
