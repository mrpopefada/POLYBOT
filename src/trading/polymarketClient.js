// src/trading/polymarketClient.js
const axios = require('axios');
const { ethers } = require('ethers');
const logger = require('../utils/logger');
const NodeCache = require('node-cache');

const cache = new NodeCache({ stdTTL: 30 }); // 30 second cache
const CLOB_HOST = process.env.POLYMARKET_HOST || 'https://clob.polymarket.com';
const GAMMA_HOST = 'https://gamma-api.polymarket.com';

/**
 * Fetch active 5-minute resolution markets
 * Polymarket doesn't have "5 min" markets per se — we target
 * markets ending within the next 60-180 minutes for fast resolution
 */
async function getShortTermMarkets() {
  const cached = cache.get('short_markets');
  if (cached) return cached;

  try {
    const now = Math.floor(Date.now() / 1000);
    const cutoff = now + (3 * 60 * 60); // markets ending in next 3 hours
    const minCutoff = now + (5 * 60); // at least 5 mins from now

    const response = await axios.get(`${GAMMA_HOST}/markets`, {
      params: {
        active: true,
        closed: false,
        limit: 100,
        order: 'volume24hr',
        ascending: false
      },
      timeout: 10000
    });

    const markets = response.data || [];
    
    // Filter for soon-expiring, high-liquidity markets
    const shortTermMarkets = markets.filter(m => {
      const endTime = new Date(m.endDate).getTime() / 1000;
      const hasLiquidity = parseFloat(m.liquidity || 0) > 500;
      const hasVolume = parseFloat(m.volume24hr || 0) > 100;
      const endsSoon = endTime > minCutoff && endTime < cutoff;
      return hasLiquidity && hasVolume && (endsSoon || m.volume24hr > 5000);
    });

    // Sort by liquidity × volume score
    shortTermMarkets.sort((a, b) => {
      const scoreA = parseFloat(a.liquidity || 0) * parseFloat(a.volume24hr || 0);
      const scoreB = parseFloat(b.liquidity || 0) * parseFloat(b.volume24hr || 0);
      return scoreB - scoreA;
    });

    cache.set('short_markets', shortTermMarkets.slice(0, 20));
    return shortTermMarkets.slice(0, 20);
  } catch (err) {
    logger.error(`Failed to fetch markets: ${err.message}`);
    return [];
  }
}

/**
 * Get detailed market data including orderbook
 */
async function getMarketDetail(conditionId) {
  try {
    const [marketRes, orderbookRes] = await Promise.all([
      axios.get(`${GAMMA_HOST}/markets/${conditionId}`, { timeout: 8000 }),
      axios.get(`${CLOB_HOST}/book`, {
        params: { token_id: conditionId },
        timeout: 8000
      }).catch(() => ({ data: null }))
    ]);

    const market = marketRes.data;
    const orderbook = orderbookRes.data;

    return { market, orderbook };
  } catch (err) {
    logger.error(`Failed to get market detail ${conditionId}: ${err.message}`);
    return null;
  }
}

/**
 * Get price history for a market token (for TA)
 */
async function getPriceHistory(marketId, interval = '1m', limit = 60) {
  try {
    const response = await axios.get(`${GAMMA_HOST}/prices-history`, {
      params: {
        market: marketId,
        interval,
        fidelity: 1,
        startTs: Math.floor(Date.now() / 1000) - (limit * 60)
      },
      timeout: 8000
    });

    return response.data?.history || [];
  } catch (err) {
    logger.error(`Price history error: ${err.message}`);
    return [];
  }
}

/**
 * Get order book depth analysis
 */
function analyzeOrderbook(orderbook) {
  if (!orderbook || !orderbook.bids || !orderbook.asks) {
    return { bidPressure: 0.5, askPressure: 0.5, spread: 0.1, imbalance: 0 };
  }

  const bids = orderbook.bids || [];
  const asks = orderbook.asks || [];

  const totalBidSize = bids.reduce((sum, b) => sum + parseFloat(b.size || 0), 0);
  const totalAskSize = asks.reduce((sum, a) => sum + parseFloat(a.size || 0), 0);
  const totalSize = totalBidSize + totalAskSize;

  const bidPressure = totalSize > 0 ? totalBidSize / totalSize : 0.5;
  const bestBid = bids[0] ? parseFloat(bids[0].price) : 0;
  const bestAsk = asks[0] ? parseFloat(asks[0].price) : 1;
  const spread = bestAsk - bestBid;
  const imbalance = bidPressure - 0.5; // positive = buy pressure

  return {
    bidPressure,
    askPressure: 1 - bidPressure,
    spread,
    imbalance,
    bestBid,
    bestAsk,
    totalBidSize,
    totalAskSize
  };
}

/**
 * Place order on Polymarket CLOB
 */
async function placeCLOBOrder(walletSigner, tokenId, side, price, size) {
  try {
    // Build the order signature for Polymarket
    const nonce = Date.now();
    const orderData = {
      salt: nonce,
      maker: await walletSigner.getAddress(),
      signer: await walletSigner.getAddress(),
      taker: '0x0000000000000000000000000000000000000000',
      tokenId: tokenId,
      makerAmount: side === 'BUY' ? Math.floor(size * price * 1e6) : Math.floor(size * 1e6),
      takerAmount: side === 'BUY' ? Math.floor(size * 1e6) : Math.floor(size * price * 1e6),
      expiration: Math.floor(Date.now() / 1000) + 3600,
      nonce: nonce,
      feeRateBps: 0,
      side: side === 'BUY' ? 0 : 1,
      signatureType: 0
    };

    // Sign the order
    const msgHash = ethers.solidityPackedKeccak256(
      ['uint256', 'address', 'address', 'uint256', 'uint256', 'uint256', 'uint256', 'uint256', 'uint256', 'uint8'],
      [orderData.salt, orderData.maker, orderData.taker, BigInt(orderData.tokenId),
       BigInt(orderData.makerAmount), BigInt(orderData.takerAmount),
       BigInt(orderData.expiration), BigInt(orderData.nonce),
       BigInt(orderData.feeRateBps), orderData.side]
    );

    const signature = await walletSigner.signMessage(ethers.getBytes(msgHash));

    const orderPayload = {
      ...orderData,
      signature,
      orderType: 'GTC'
    };

    const response = await axios.post(
      `${CLOB_HOST}/order`,
      { order: orderPayload, owner: await walletSigner.getAddress() },
      {
        headers: {
          'Content-Type': 'application/json',
          'POLY_ADDRESS': await walletSigner.getAddress()
        },
        timeout: 15000
      }
    );

    return { success: true, orderId: response.data?.orderID, data: response.data };
  } catch (err) {
    logger.error(`Order placement failed: ${err.message}`);
    return { success: false, error: err.message };
  }
}

/**
 * Check if an order/position is resolved
 */
async function checkOrderStatus(orderId) {
  try {
    const response = await axios.get(`${CLOB_HOST}/order/${orderId}`, {
      timeout: 8000
    });
    return response.data;
  } catch {
    return null;
  }
}

module.exports = {
  getShortTermMarkets,
  getMarketDetail,
  getPriceHistory,
  analyzeOrderbook,
  placeCLOBOrder,
  checkOrderStatus
};
