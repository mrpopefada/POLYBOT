# 🤖 PolyTrader Bot — Polymarket Automated Trading Bot

A fully automated Telegram trading bot for Polymarket prediction markets with:
- **Embedded wallets** (created per user, no external wallet needed)
- **Auto-trading** using TA + Fundamental + Order Flow analysis
- **Referral program** (5% of wins paid to referrer)
- **Platform fees** (5% of wins to your master wallet)
- **Withdrawal system** (on-chain USDC to any Polygon address)

---

## ⚡ Quick Setup

### 1. Requirements
- Node.js 18+
- A server (VPS, Railway, Render, etc.)
- Polygon wallet with some MATIC (for gas)
- Telegram bot token

### 2. Install
```bash
git clone <your-repo>
cd polymarket-bot
npm install
cp .env.example .env
```

### 3. Configure `.env`

```env
TELEGRAM_BOT_TOKEN=        # From @BotFather on Telegram
MASTER_WALLET_PRIVATE_KEY= # Your personal wallet private key (receives fees)
MASTER_WALLET_ADDRESS=     # Your personal wallet address
WALLET_ENCRYPTION_KEY=     # Any 32+ character random string (encrypts user wallets)
POLYGON_RPC_URL=           # https://polygon-rpc.com (or Alchemy/Infura endpoint)
ADMIN_TELEGRAM_ID=         # Your Telegram numeric ID (get from @userinfobot)
```

### 4. Polymarket API Keys
1. Go to https://polymarket.com
2. Connect a wallet and complete verification
3. Go to Profile → API Keys → Create new key
4. Add `POLYMARKET_API_KEY`, `POLYMARKET_API_SECRET`, `POLYMARKET_API_PASSPHRASE` to `.env`

### 5. Run
```bash
npm start
# Or for development:
npm run dev
```

---

## 🚀 Deploy to Railway (Recommended — Free Tier Available)

1. Push code to GitHub
2. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub
3. Set all environment variables in Railway dashboard
4. Deploy — Railway auto-detects Node.js

---

## 💰 How the Fee System Works

```
User wins $100 trade
├── 5% = $5.00  → Platform fee (auto-sent to your MASTER_WALLET)
├── 5% = $5.00  → Referrer wallet (if user was referred)
└── 90% = $90.00 → User balance
```

All fees are recorded in the database. Use `/admin` command in Telegram to see totals.

---

## 🧠 Trading Strategy

The bot combines 3 analysis layers:

### 1. Technical Analysis (40% weight)
- **RSI (14)** — Oversold/overbought detection
- **MACD (5/13/3)** — Momentum crossovers
- **Bollinger Bands (10)** — Price range extremes
- **EMA 8/21 crossover** — Trend direction
- **Price momentum** — 5-bar rate of change
- **Volume analysis** — Confirmation

### 2. Fundamental Analysis (35% weight)
- Price edge detection (markets mispriced vs fair value)
- Time-to-resolution premium (near-expiry markets)
- Liquidity assessment
- Volume momentum

### 3. Order Flow Analysis (25% weight)
- Bid/ask imbalance detection
- Spread analysis
- Buy/sell pressure ratio

### Position Sizing
Uses **Half-Kelly Criterion** — mathematically optimal bet sizing.
- Aggressive mode: up to 30% of balance per trade
- Balanced: up to 20%
- Conservative: up to 12%

---

## 📊 Bot Commands

| Command | Description |
|---------|-------------|
| `/start` | Create account + embedded wallet |
| `/menu` | Main navigation menu |
| `/balance` | Quick balance check |
| `/withdraw <amount> <address>` | Withdraw USDC to Polygon address |
| `/admin` | Admin stats (bot creator only) |

---

## 🔐 Security Notes

1. **User private keys are AES-encrypted** with your `WALLET_ENCRYPTION_KEY` before being stored in SQLite
2. **Never share** your `.env` file
3. **Back up** `./data/bot.db` regularly
4. The `MASTER_WALLET_PRIVATE_KEY` is only used to receive fees — keep it secure
5. User wallets need MATIC for gas — remind users to add 0.1-0.5 MATIC

---

## ⚠️ Important Disclaimers

1. **Prediction markets are HIGH RISK**. The $10→$100 goal requires roughly 10x returns which demands very high win rates on leveraged positions.
2. **Polymarket CLOB requires approval** — some features may need API key approval from Polymarket.
3. **This is not financial advice**. Only trade with funds you can afford to lose.
4. You are responsible for tax compliance in your jurisdiction.

---

## 📁 File Structure

```
polymarket-bot/
├── src/
│   ├── index.js              # Entry point
│   ├── bot/
│   │   └── handlers.js       # All Telegram bot handlers
│   ├── trading/
│   │   ├── polymarketClient.js  # API + order placement
│   │   ├── technicalAnalysis.js # TA + fundamental + order flow
│   │   ├── tradeEngine.js       # Core trade logic + fees
│   │   └── scheduler.js         # Cron jobs (2-min trade cycle)
│   ├── wallet/
│   │   └── walletManager.js  # Embedded wallet creation + USDC transfers
│   ├── db/
│   │   └── database.js       # SQLite schema + queries
│   └── utils/
│       └── logger.js         # Winston logging
├── data/                     # Auto-created, contains bot.db
├── logs/                     # Auto-created, contains log files
├── .env.example
├── package.json
└── README.md
```

---

## 🔧 Customization

**Change fee percentages:** Edit `.env`
```
PLATFORM_FEE_PERCENT=5    # Your cut
REFERRAL_FEE_PERCENT=5    # Referrer cut
```

**Change trade frequency:** Edit `scheduler.js`
```js
cron.schedule('*/2 * * * *', ...)  // Every 2 mins — change as needed
```

**Adjust confidence threshold:** Edit `technicalAnalysis.js`
```js
if (confidence > 0.25) { ... }  // Lower = more trades, higher = fewer but better
```
