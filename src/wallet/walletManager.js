// src/wallet/walletManager.js
const { ethers } = require('ethers');
const CryptoJS = require('crypto-js');
const { userQueries } = require('../db/database');
const logger = require('../utils/logger');

const ENCRYPTION_KEY = process.env.WALLET_ENCRYPTION_KEY;
const POLYGON_RPC = process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com';
const USDC_ADDRESS = process.env.USDC_CONTRACT || '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';

// USDC ABI (minimal - transfer + balanceOf)
const USDC_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)',
  'event Transfer(address indexed from, address indexed to, uint256 value)'
];

const provider = new ethers.JsonRpcProvider(POLYGON_RPC);

/**
 * Create a new embedded wallet for a user
 */
async function createEmbeddedWallet(telegramId) {
  try {
    const wallet = ethers.Wallet.createRandom();
    const encryptedKey = CryptoJS.AES.encrypt(
      wallet.privateKey,
      ENCRYPTION_KEY
    ).toString();

    userQueries.updateWallet.run(wallet.address, encryptedKey, telegramId);

    logger.info(`Wallet created for user ${telegramId}: ${wallet.address}`);
    
    return {
      address: wallet.address,
      success: true
    };
  } catch (err) {
    logger.error(`Failed to create wallet for ${telegramId}: ${err.message}`);
    throw err;
  }
}

/**
 * Decrypt and get wallet signer for a user
 */
function getWalletSigner(encryptedPrivateKey) {
  const decryptedBytes = CryptoJS.AES.decrypt(encryptedPrivateKey, ENCRYPTION_KEY);
  const privateKey = decryptedBytes.toString(CryptoJS.enc.Utf8);
  const wallet = new ethers.Wallet(privateKey, provider);
  return wallet;
}

/**
 * Get USDC balance for a wallet address (on-chain)
 */
async function getOnChainUSDCBalance(address) {
  try {
    const usdc = new ethers.Contract(USDC_ADDRESS, USDC_ABI, provider);
    const balance = await usdc.balanceOf(address);
    const decimals = await usdc.decimals();
    return parseFloat(ethers.formatUnits(balance, decimals));
  } catch (err) {
    logger.error(`Balance check failed for ${address}: ${err.message}`);
    return 0;
  }
}

/**
 * Transfer USDC from user wallet to destination
 */
async function transferUSDC(encryptedPrivateKey, toAddress, amount) {
  try {
    const signer = getWalletSigner(encryptedPrivateKey);
    const usdc = new ethers.Contract(USDC_ADDRESS, USDC_ABI, signer);
    const decimals = 6; // USDC has 6 decimals on Polygon
    
    const amountWei = ethers.parseUnits(amount.toString(), decimals);
    
    // Estimate gas
    const gasEstimate = await usdc.transfer.estimateGas(toAddress, amountWei);
    
    const tx = await usdc.transfer(toAddress, amountWei, {
      gasLimit: gasEstimate * 120n / 100n // 20% buffer
    });
    
    await tx.wait();
    logger.info(`USDC transfer: ${amount} to ${toAddress} | tx: ${tx.hash}`);
    
    return { success: true, txHash: tx.hash };
  } catch (err) {
    logger.error(`USDC transfer failed: ${err.message}`);
    return { success: false, error: err.message };
  }
}

/**
 * Get MATIC balance (for gas fees)
 */
async function getMATICBalance(address) {
  try {
    const balance = await provider.getBalance(address);
    return parseFloat(ethers.formatEther(balance));
  } catch {
    return 0;
  }
}

/**
 * Format wallet address for display (shortened)
 */
function shortAddress(address) {
  if (!address) return 'N/A';
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

module.exports = {
  createEmbeddedWallet,
  getWalletSigner,
  getOnChainUSDCBalance,
  transferUSDC,
  getMATICBalance,
  shortAddress,
  provider,
  USDC_ADDRESS
};
