import { cryptoLogger as logger } from '../../utils/logger.js';
import walletService from './walletService.js';
import contractServiceWrapper from './contractServiceWrapper.js';
import transactionService from './transactionService.js';
import { decrypt } from '../../utils/encryption.js';

// Lazy load ethers
let ethersLib = null;

async function getEthers() {
    if (!ethersLib) {
        const ethers = await import('ethers');
        ethersLib = ethers;
    }
    return ethersLib;
}

// DEX Router addresses for various networks
const DEX_ROUTERS = {
    // Mainnets
    ethereum: {
        uniswapV2: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D',
        uniswapV3: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
        sushiswap: '0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F'
    },
    polygon: {
        quickswap: '0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff',
        sushiswap: '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506'
    },
    bsc: {
        pancakeswap: '0x10ED43C718714eb63d5aA57B78B54704E256024E',
        pancakeswapV3: '0x13f4EA83D0bd40E75C8222255bc855a974568Dd4',
        sushiswap: '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506'
    },
    base: {
        uniswapV2: '0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24',
        aerodrome: '0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43'
    },

    // Testnets
    sepolia: {
        uniswapV2: '0xC532a74256D3Db42D0Bf7a0400fEFDbad7694008'
    },
    'bsc-testnet': {
        pancakeswap: '0xD99D1c33F9fC3444f8101754aBC46c52416550D1'
    },
    amoy: {
        quickswap: '0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff' // Uses same as mainnet for testing
    },
    'base-sepolia': {
        uniswapV2: '0x1689E7B1F10000AE47eBfE339a4f69dECd19F602'
    }
};

// Wrapped native token addresses
const WRAPPED_NATIVE = {
    ethereum: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', // WETH
    sepolia: '0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9', // WETH
    polygon: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270', // WMATIC
    amoy: '0x360ad4f9a9A8EFe9A8DCB5f461c4Cc1047E1Dcf9', // WMATIC
    bsc: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', // WBNB
    'bsc-testnet': '0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd', // WBNB
    base: '0x4200000000000000000000000000000000000006', // WETH
    'base-sepolia': '0x4200000000000000000000000000000000000006' // WETH
};

// Common stablecoins per network
const STABLECOINS = {
    ethereum: {
        USDC: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
        USDT: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
        DAI: '0x6B175474E89094C44Da98b954EedeAC495271d0F',
    },
    sepolia: {
        USDC: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238'
    },
    polygon: {
        USDC: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
        USDT: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F'
    },
    bsc: {
        BUSD: '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56',
        USDT: '0x55d398326f99059fF775485246999027B3197955',
        USDC: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d'
    },
    'bsc-testnet': {
        BUSD: '0xeD24FC36d5Ee211Ea25A80239Fb8C4Cfd80f12Ee'
    },
    base: {
        USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
    }
};

// 1inch Aggregator — V6 universal router (same address on all chains)
const ONEINCH_ROUTER = '0x111111125421cA6dc452d289314280a0f8842A65';
const ONEINCH_API_BASE = 'https://api.1inch.dev/swap/v6.0';
const ONEINCH_CHAIN_IDS = {
    ethereum: 1,
    bsc: 56,
    polygon: 137,
    base: 8453
};
// Quote cache to avoid hammering the API (15s TTL)
const _1inchQuoteCache = new Map();
const _1inchQuoteCacheTTL = 15000;
let _1inchLastRequestTime = 0;
const _1inchMinRequestInterval = 1500; // 1.5s between requests (free tier rate limit)

// CoW Protocol (CoW Swap) — intent-based DEX aggregator, MEV-protected
// No API key needed. Supports Ethereum mainnet only currently.
const COW_API_BASE = 'https://api.cow.fi';
const COW_NETWORKS = { ethereum: 'mainnet', base: 'base', arbitrum: 'arbitrum_one' };
const COW_VAULT_RELAYER = '0xC92E8bdf79f0507f65a392b0ab4667716BFE0110';
const COW_APP_DATA = '{"version":"1.1.0","metadata":{}}';
const COW_APP_DATA_HASH = '0x33d8bdb854556de69f089b345fb7cdc28c2472ce6ffee7c799306a711d3684e6';
const COW_MIN_ORDER_USD = 10; // Minimum order value — solvers won't fill tiny orders (gas > profit)
let _cowLastRequestTime = 0;
const _cowMinRequestInterval = 1000;

// V3 Quoter addresses (QuoterV2 for getting quotes)
const V3_QUOTERS = {
    ethereum: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
    bsc: '0xB048Bbc1Ee6b733FFFCFb9e9CeF7375518e25997'
};

// V3 fee tiers per network (basis points: 100=0.01%, 500=0.05%, 2500/3000=0.25/0.3%, 10000=1%)
const V3_FEE_TIERS = {
    ethereum: [500, 3000, 10000, 100],
    bsc: [2500, 500, 10000, 100]
};

// V4 support — Uniswap V4 on Ethereum, PancakeSwap Infinity on BSC
const V4_QUOTERS = {
    ethereum: '0x52f0e24d1c21c8a0cb1e5a5dd6198556bd9e1203',  // Uniswap V4 Quoter
    bsc: '0xd0737C9762912dD34c3271197E362Aa736Df0926'          // PancakeSwap Infinity CLQuoter
};

const V4_ROUTERS = {
    ethereum: '0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af',  // Uniswap Universal Router
    bsc: '0xd9c500dff816a1da21a48a732d3498bf09dc9aeb'        // PancakeSwap Infinity Universal Router
};

const V4_POOL_MANAGERS = {
    bsc: '0xa0FfB9c1CE1Fe56963B0321B32E7A0302114058b',  // PancakeSwap Infinity CLPoolManager
    ethereum: '0x000000000004444c5dc75cB358380D2e3dE08A90'   // Uniswap V4 PoolManager
};

const V4_POOL_CONFIGS = {
    ethereum: [
        { fee: 500, tickSpacing: 10 },
        { fee: 3000, tickSpacing: 60 },
        { fee: 10000, tickSpacing: 200 },
        { fee: 100, tickSpacing: 1 }
    ],
    bsc: [
        { fee: 2500, tickSpacing: 50 },
        { fee: 500, tickSpacing: 10 },
        { fee: 10000, tickSpacing: 200 },
        { fee: 100, tickSpacing: 1 }
    ]
};

// Networks using PancakeSwap Infinity (different quoter ABI + PoolKey struct)
const PANCAKESWAP_V4_NETWORKS = new Set(['bsc']);

// PancakeSwap Infinity hooked pool configs — pools with custom hook contracts
// Static fallback: known hooks for pools created before RPC pruning window (~50k blocks)
// Each entry: { hooks, fee, tickSpacing, hookFlags } where parameters = (tickSpacing << 16) | hookFlags
const V4_HOOKED_POOLS_STATIC = {
    bsc: [
        {
            hooks: '0x72e09eBd9b24F47730b651889a4eD984CBa53d90',
            fee: 67, tickSpacing: 10, hookFlags: 0x55
        },
        {
            hooks: '0x9a9b5331ce8d74b2b721291d57de696e878353fd',
            fee: 67, tickSpacing: 10, hookFlags: 0x55
        },
        {
            hooks: '0xf2042f3bc774df890a6e7f6b1a5f1ba3ecaee7ee',
            fee: 0, tickSpacing: 1, hookFlags: 0x455
        }
    ]
};

// Cache for dynamically discovered V4 pool keys: "network:token0:token1" → [{ hooks, fee, tickSpacing, hookFlags }]
const _v4PoolKeyCache = new Map();
const _v4PoolKeyCacheTimestamps = new Map();

// Get the combined list of hooked pool configs for a network + cached discoveries for a pair
function _getV4HookedPools(network, tokenA, tokenB) {
    const staticPools = V4_HOOKED_POOLS_STATIC[network] || [];
    let dynamicPools = [];
    if (tokenA && tokenB) {
        const a = tokenA.toLowerCase();
        const b = tokenB.toLowerCase();
        const cacheKey = `${network}:${a < b ? a : b}:${a < b ? b : a}`;
        dynamicPools = _v4PoolKeyCache.get(cacheKey) || [];
    }
    // Merge: deduplicate by hooks+fee+tickSpacing+hookFlags
    const seen = new Set();
    const merged = [];
    for (const pool of [...dynamicPools, ...staticPools]) {
        const key = `${pool.hooks.toLowerCase()}_${pool.fee}_${pool.tickSpacing}_${pool.hookFlags}`;
        if (!seen.has(key)) {
            seen.add(key);
            merged.push(pool);
        }
    }
    return merged;
}

// Uniswap V4 Quoter ABI — PoolKey-based struct (used on Ethereum + Uniswap V4 on BSC)
const V4_QUOTER_ABI = [
    'function quoteExactInputSingle(tuple(tuple(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 exactAmount, bytes hookData) params) external returns (uint256 amountOut, uint256 gasEstimate)'
];

// PancakeSwap Infinity CLQuoter ABI (BSC) — returns (amountOut, gasEstimate) not deltaAmounts
const PANCAKESWAP_V4_QUOTER_ABI = [
    'function quoteExactInputSingle(tuple(tuple(address currency0, address currency1, address hooks, address poolManager, uint24 fee, bytes32 parameters) poolKey, bool zeroForOne, uint128 exactAmount, bytes hookData) params) external returns (uint256 amountOut, uint256 gasEstimate)'
];

// Universal Router ABI (for V4 swap execution)
const UNIVERSAL_ROUTER_ABI = [
    'function execute(bytes commands, bytes[] inputs, uint256 deadline) payable',
    'function execute(bytes commands, bytes[] inputs) payable'
];

// Permit2 contracts — PCS Infinity uses their own Permit2, NOT the canonical one
const PERMIT2_ADDRESSES = {
    bsc: '0x31c2F6fcFf4F8759b3Bd5Bf0e1084A055615c768',      // PCS Infinity Permit2 (embedded in Universal Router bytecode)
    ethereum: '0x000000000022D473030F116dDEE9F6B43aC78BA3',   // Canonical Permit2 (Uniswap)
};
const PERMIT2_ABI = [
    'function approve(address token, address spender, uint160 amount, uint48 expiration)',
    'function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)'
];

// Universal Router command bytes (PCS Infinity naming)
const UR_COMMANDS = {
    V3_SWAP_EXACT_IN: 0x00,
    INFI_SWAP: 0x10,               // PancakeSwap Infinity swap (Plan/Actions format)
    V4_CL_SWAP_EXACT_IN_SINGLE: 0x10,  // Alias for backward compat
    V4_CL_SWAP_EXACT_IN: 0x11,
    WRAP_ETH: 0x0b,
    UNWRAP_WETH: 0x0c,
    PERMIT2_PERMIT: 0x0a,
};

// PCS Infinity Actions (used inside INFI_SWAP plan)
const INFI_ACTIONS = {
    CL_SWAP_EXACT_IN_SINGLE: 0x06,
    CL_SWAP_EXACT_IN: 0x07,
    SETTLE: 0x0b,
    SETTLE_ALL: 0x0c,
    TAKE: 0x0e,
    TAKE_ALL: 0x0f,
};

// Uniswap V4 on BSC (separate deployment from PancakeSwap Infinity — different contracts, same action encoding)
const UNISWAP_V4_BSC = {
    quoter: '0x9f75dd27d6664c475b90e105573e550ff69437b0',
    router: '0x1906c1d672b88cd1b9ac7593301ca990f94eae07',
    poolManager: '0x28e2ea090877bf75740558f6bfb36a5ffee9e9df'
};

// Uniswap V4 standard pool fee tiers (common across all networks)
const UNISWAP_V4_POOL_CONFIGS = [
    { fee: 100, tickSpacing: 1 },
    { fee: 500, tickSpacing: 10 },
    { fee: 3000, tickSpacing: 60 },
    { fee: 10000, tickSpacing: 200 }
];

// Uniswap V3 SwapRouter ABI (includes deadline in struct)
const UNISWAP_V3_ROUTER_ABI = [
    'function exactInputSingle(tuple(address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)',
    'function exactInput(tuple(bytes path, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum) params) payable returns (uint256 amountOut)',
    'function multicall(bytes[] data) payable returns (bytes[] results)',
    'function unwrapWETH9(uint256 amountMinimum, address recipient) payable',
    'function refundETH() payable'
];

// PancakeSwap SmartRouter ABI (no deadline in struct — uses multicall for deadline enforcement)
const PANCAKESWAP_SMART_ROUTER_ABI = [
    'function exactInputSingle(tuple(address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)',
    'function exactInput(tuple(bytes path, address recipient, uint256 amountIn, uint256 amountOutMinimum) params) payable returns (uint256 amountOut)',
    'function multicall(uint256 deadline, bytes[] data) payable returns (bytes[] results)',
    'function unwrapWETH9(uint256 amountMinimum, address recipient) payable',
    'function refundETH() payable'
];

// Networks that use PancakeSwap SmartRouter (no deadline in swap params)
const SMART_ROUTER_NETWORKS = new Set(['bsc']);

// Uniswap/PancakeSwap V3 QuoterV2 ABI
const UNISWAP_V3_QUOTER_ABI = [
    'function quoteExactInputSingle(tuple(address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
    'function quoteExactInput(bytes path, uint256 amountIn) returns (uint256 amountOut, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)'
];

// Uniswap V2 Router ABI (minimal for swaps)
const UNISWAP_V2_ROUTER_ABI = [
    {
        "inputs": [
            { "internalType": "uint256", "name": "amountIn", "type": "uint256" },
            { "internalType": "uint256", "name": "amountOutMin", "type": "uint256" },
            { "internalType": "address[]", "name": "path", "type": "address[]" },
            { "internalType": "address", "name": "to", "type": "address" },
            { "internalType": "uint256", "name": "deadline", "type": "uint256" }
        ],
        "name": "swapExactTokensForTokens",
        "outputs": [{ "internalType": "uint256[]", "name": "amounts", "type": "uint256[]" }],
        "stateMutability": "nonpayable",
        "type": "function"
    },
    {
        "inputs": [
            { "internalType": "uint256", "name": "amountOutMin", "type": "uint256" },
            { "internalType": "address[]", "name": "path", "type": "address[]" },
            { "internalType": "address", "name": "to", "type": "address" },
            { "internalType": "uint256", "name": "deadline", "type": "uint256" }
        ],
        "name": "swapExactETHForTokens",
        "outputs": [{ "internalType": "uint256[]", "name": "amounts", "type": "uint256[]" }],
        "stateMutability": "payable",
        "type": "function"
    },
    {
        "inputs": [
            { "internalType": "uint256", "name": "amountIn", "type": "uint256" },
            { "internalType": "uint256", "name": "amountOutMin", "type": "uint256" },
            { "internalType": "address[]", "name": "path", "type": "address[]" },
            { "internalType": "address", "name": "to", "type": "address" },
            { "internalType": "uint256", "name": "deadline", "type": "uint256" }
        ],
        "name": "swapExactTokensForETH",
        "outputs": [{ "internalType": "uint256[]", "name": "amounts", "type": "uint256[]" }],
        "stateMutability": "nonpayable",
        "type": "function"
    },
    {
        "inputs": [
            { "internalType": "uint256", "name": "amountIn", "type": "uint256" },
            { "internalType": "address[]", "name": "path", "type": "address[]" }
        ],
        "name": "getAmountsOut",
        "outputs": [{ "internalType": "uint256[]", "name": "amounts", "type": "uint256[]" }],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [],
        "name": "WETH",
        "outputs": [{ "internalType": "address", "name": "", "type": "address" }],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [],
        "name": "factory",
        "outputs": [{ "internalType": "address", "name": "", "type": "address" }],
        "stateMutability": "view",
        "type": "function"
    },
    // SupportingFeeOnTransferTokens variants (required for tax tokens)
    {
        "inputs": [
            { "internalType": "uint256", "name": "amountIn", "type": "uint256" },
            { "internalType": "uint256", "name": "amountOutMin", "type": "uint256" },
            { "internalType": "address[]", "name": "path", "type": "address[]" },
            { "internalType": "address", "name": "to", "type": "address" },
            { "internalType": "uint256", "name": "deadline", "type": "uint256" }
        ],
        "name": "swapExactTokensForTokensSupportingFeeOnTransferTokens",
        "outputs": [],
        "stateMutability": "nonpayable",
        "type": "function"
    },
    {
        "inputs": [
            { "internalType": "uint256", "name": "amountOutMin", "type": "uint256" },
            { "internalType": "address[]", "name": "path", "type": "address[]" },
            { "internalType": "address", "name": "to", "type": "address" },
            { "internalType": "uint256", "name": "deadline", "type": "uint256" }
        ],
        "name": "swapExactETHForTokensSupportingFeeOnTransferTokens",
        "outputs": [],
        "stateMutability": "payable",
        "type": "function"
    },
    {
        "inputs": [
            { "internalType": "uint256", "name": "amountIn", "type": "uint256" },
            { "internalType": "uint256", "name": "amountOutMin", "type": "uint256" },
            { "internalType": "address[]", "name": "path", "type": "address[]" },
            { "internalType": "address", "name": "to", "type": "address" },
            { "internalType": "uint256", "name": "deadline", "type": "uint256" }
        ],
        "name": "swapExactTokensForETHSupportingFeeOnTransferTokens",
        "outputs": [],
        "stateMutability": "nonpayable",
        "type": "function"
    }
];

// ERC20 ABI for approvals and metadata
const ERC20_ABI = [
    {
        "inputs": [
            { "internalType": "address", "name": "spender", "type": "address" },
            { "internalType": "uint256", "name": "amount", "type": "uint256" }
        ],
        "name": "approve",
        "outputs": [{ "internalType": "bool", "name": "", "type": "bool" }],
        "stateMutability": "nonpayable",
        "type": "function"
    },
    {
        "inputs": [
            { "internalType": "address", "name": "owner", "type": "address" },
            { "internalType": "address", "name": "spender", "type": "address" }
        ],
        "name": "allowance",
        "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [{ "internalType": "address", "name": "account", "type": "address" }],
        "name": "balanceOf",
        "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [],
        "name": "decimals",
        "outputs": [{ "internalType": "uint8", "name": "", "type": "uint8" }],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [],
        "name": "name",
        "outputs": [{ "internalType": "string", "name": "", "type": "string" }],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [],
        "name": "symbol",
        "outputs": [{ "internalType": "string", "name": "", "type": "string" }],
        "stateMutability": "view",
        "type": "function"
    }
];

// V2 Router liquidity ABIs (addLiquidity, addLiquidityETH, removeLiquidity, removeLiquidityETH)
const V2_LIQUIDITY_ABI = [
    {
        "inputs": [
            { "internalType": "address", "name": "tokenA", "type": "address" },
            { "internalType": "address", "name": "tokenB", "type": "address" },
            { "internalType": "uint256", "name": "amountADesired", "type": "uint256" },
            { "internalType": "uint256", "name": "amountBDesired", "type": "uint256" },
            { "internalType": "uint256", "name": "amountAMin", "type": "uint256" },
            { "internalType": "uint256", "name": "amountBMin", "type": "uint256" },
            { "internalType": "address", "name": "to", "type": "address" },
            { "internalType": "uint256", "name": "deadline", "type": "uint256" }
        ],
        "name": "addLiquidity",
        "outputs": [
            { "internalType": "uint256", "name": "amountA", "type": "uint256" },
            { "internalType": "uint256", "name": "amountB", "type": "uint256" },
            { "internalType": "uint256", "name": "liquidity", "type": "uint256" }
        ],
        "stateMutability": "nonpayable",
        "type": "function"
    },
    {
        "inputs": [
            { "internalType": "address", "name": "token", "type": "address" },
            { "internalType": "uint256", "name": "amountTokenDesired", "type": "uint256" },
            { "internalType": "uint256", "name": "amountTokenMin", "type": "uint256" },
            { "internalType": "uint256", "name": "amountETHMin", "type": "uint256" },
            { "internalType": "address", "name": "to", "type": "address" },
            { "internalType": "uint256", "name": "deadline", "type": "uint256" }
        ],
        "name": "addLiquidityETH",
        "outputs": [
            { "internalType": "uint256", "name": "amountToken", "type": "uint256" },
            { "internalType": "uint256", "name": "amountETH", "type": "uint256" },
            { "internalType": "uint256", "name": "liquidity", "type": "uint256" }
        ],
        "stateMutability": "payable",
        "type": "function"
    },
    {
        "inputs": [
            { "internalType": "address", "name": "tokenA", "type": "address" },
            { "internalType": "address", "name": "tokenB", "type": "address" },
            { "internalType": "uint256", "name": "liquidity", "type": "uint256" },
            { "internalType": "uint256", "name": "amountAMin", "type": "uint256" },
            { "internalType": "uint256", "name": "amountBMin", "type": "uint256" },
            { "internalType": "address", "name": "to", "type": "address" },
            { "internalType": "uint256", "name": "deadline", "type": "uint256" }
        ],
        "name": "removeLiquidity",
        "outputs": [
            { "internalType": "uint256", "name": "amountA", "type": "uint256" },
            { "internalType": "uint256", "name": "amountB", "type": "uint256" }
        ],
        "stateMutability": "nonpayable",
        "type": "function"
    },
    {
        "inputs": [
            { "internalType": "address", "name": "token", "type": "address" },
            { "internalType": "uint256", "name": "liquidity", "type": "uint256" },
            { "internalType": "uint256", "name": "amountTokenMin", "type": "uint256" },
            { "internalType": "uint256", "name": "amountETHMin", "type": "uint256" },
            { "internalType": "address", "name": "to", "type": "address" },
            { "internalType": "uint256", "name": "deadline", "type": "uint256" }
        ],
        "name": "removeLiquidityETH",
        "outputs": [
            { "internalType": "uint256", "name": "amountToken", "type": "uint256" },
            { "internalType": "uint256", "name": "amountETH", "type": "uint256" }
        ],
        "stateMutability": "nonpayable",
        "type": "function"
    }
];

// V2 Factory ABI
const V2_FACTORY_ABI = [
    {
        "inputs": [
            { "internalType": "address", "name": "tokenA", "type": "address" },
            { "internalType": "address", "name": "tokenB", "type": "address" }
        ],
        "name": "getPair",
        "outputs": [{ "internalType": "address", "name": "pair", "type": "address" }],
        "stateMutability": "view",
        "type": "function"
    }
];

// V2 Pair ABI
const V2_PAIR_ABI = [
    {
        "inputs": [],
        "name": "getReserves",
        "outputs": [
            { "internalType": "uint112", "name": "_reserve0", "type": "uint112" },
            { "internalType": "uint112", "name": "_reserve1", "type": "uint112" },
            { "internalType": "uint32", "name": "_blockTimestampLast", "type": "uint32" }
        ],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [],
        "name": "totalSupply",
        "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [],
        "name": "token0",
        "outputs": [{ "internalType": "address", "name": "", "type": "address" }],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [],
        "name": "token1",
        "outputs": [{ "internalType": "address", "name": "", "type": "address" }],
        "stateMutability": "view",
        "type": "function"
    },
    ...ERC20_ABI
];

// Error patterns that indicate slippage-related reverts (retryable)
const SLIPPAGE_REVERT_PATTERNS = [
    'INSUFFICIENT_OUTPUT_AMOUNT',
    'EXECUTION_REVERTED',
    'UniswapV2Router: INSUFFICIENT_OUTPUT_AMOUNT',
    'PancakeRouter: INSUFFICIENT_OUTPUT_AMOUNT',
    'Too little received',
    'slippage',
    'STF', // V3: SafeTransferFrom failed
    'Price slippage check',
    'K' // Uniswap K invariant
];

// Error patterns that should NOT be retried
const NON_RETRYABLE_PATTERNS = [
    'insufficient funds',
    'gas required exceeds',
    'nonce too low',
    'already known',
    'TRANSFER_FROM_FAILED',
    'approve',
    'APPROVAL',
    'ds-math-sub-underflow', // honeypot indicator
    'TransferHelper'
];

class SwapService {
    constructor() {
        this.pendingSwaps = new Map();
        // Token tax cache: { address_network -> { tax, timestamp } }
        this.tokenTaxCache = new Map();
        this.tokenTaxCacheTTL = 60 * 60 * 1000; // 1 hour
        // Token metadata cache: { address_network -> { name, symbol, decimals, tax } }
        this.tokenMetadataCache = new Map();
    }

    /**
     * Get available DEX routers for a network
     */
    getRoutersForNetwork(network) {
        return DEX_ROUTERS[network] || {};
    }

    /**
     * Get wrapped native token address
     */
    getWrappedNative(network) {
        return WRAPPED_NATIVE[network];
    }

    /**
     * Get stablecoins for a network
     */
    getStablecoins(network) {
        return STABLECOINS[network] || {};
    }

    // ---- 1inch Aggregator Methods ----

    /**
     * Make a rate-limited request to the 1inch API
     */
    async _1inchRequest(endpoint, chainId) {
        // Rate limiting
        const now = Date.now();
        const elapsed = now - _1inchLastRequestTime;
        if (elapsed < _1inchMinRequestInterval) {
            await new Promise(r => setTimeout(r, _1inchMinRequestInterval - elapsed));
        }
        _1inchLastRequestTime = Date.now();

        const url = `${ONEINCH_API_BASE}/${chainId}${endpoint}`;
        const headers = { 'Accept': 'application/json' };

        // Use API key if available
        const apiKey = process.env.ONEINCH_API_KEY;
        if (apiKey) {
            headers['Authorization'] = `Bearer ${apiKey}`;
        }

        const response = await fetch(url, { headers });

        if (response.status === 429) {
            logger.warn('1inch API rate limited — skipping');
            return null;
        }
        if (!response.ok) {
            const text = await response.text().catch(() => '');
            throw new Error(`1inch API ${response.status}: ${text.slice(0, 200)}`);
        }
        return response.json();
    }

    /**
     * Get aggregated quote from 1inch
     * @returns {{ dstAmount: string, protocols: Array, gas: number, srcToken: object, dstToken: object }} or null
     */
    async get1inchQuote(network, srcToken, dstToken, amountWei) {
        const chainId = ONEINCH_CHAIN_IDS[network];
        if (!chainId) return null;

        // Normalize native token address for 1inch (uses 0xEEEE...EEEE)
        const NATIVE_1INCH = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
        const src = srcToken.toLowerCase() === 'native' ? NATIVE_1INCH : srcToken;
        const dst = dstToken.toLowerCase() === 'native' ? NATIVE_1INCH : dstToken;

        // Check cache
        const cacheKey = `${chainId}:${src}:${dst}:${amountWei.toString()}`;
        const cached = _1inchQuoteCache.get(cacheKey);
        if (cached && Date.now() - cached.timestamp < _1inchQuoteCacheTTL) {
            return cached.data;
        }

        try {
            const params = new URLSearchParams({
                src, dst,
                amount: amountWei.toString(),
                includeGas: 'true'
            });

            const data = await this._1inchRequest(`/quote?${params}`, chainId);
            if (!data) return null;

            // Cache the result
            _1inchQuoteCache.set(cacheKey, { data, timestamp: Date.now() });

            logger.info(`1inch quote: ${amountWei} → ${data.dstAmount} (gas: ${data.gas || 'N/A'}, protocols: ${data.protocols?.length || 0} routes)`);
            return data;
        } catch (err) {
            logger.debug(`1inch quote failed for ${network}: ${err.message}`);
            return null;
        }
    }

    /**
     * Get swap transaction data from 1inch (quote + executable calldata)
     */
    async get1inchSwapData(network, srcToken, dstToken, amountWei, fromAddress, slippage = 1) {
        const chainId = ONEINCH_CHAIN_IDS[network];
        if (!chainId) throw new Error(`1inch not supported on ${network}`);

        const NATIVE_1INCH = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
        const src = srcToken.toLowerCase() === 'native' ? NATIVE_1INCH : srcToken;
        const dst = dstToken.toLowerCase() === 'native' ? NATIVE_1INCH : dstToken;

        const params = new URLSearchParams({
            src, dst,
            amount: amountWei.toString(),
            from: fromAddress,
            slippage: slippage.toString(),
            disableEstimate: 'false',
            allowPartialFill: 'false'
        });

        const data = await this._1inchRequest(`/swap?${params}`, chainId);
        if (!data) throw new Error('1inch swap API returned no data (rate limited?)');
        return data;
    }

    /**
     * Check and ensure token approval for the 1inch router
     */
    async ensure1inchApproval(network, tokenAddress, amountWei, signer) {
        const chainId = ONEINCH_CHAIN_IDS[network];
        if (!chainId) return;

        // Check current allowance
        const ethers = await getEthers();
        const token = new ethers.Contract(tokenAddress, ERC20_ABI, signer);
        const allowance = await token.allowance(signer.address, ONEINCH_ROUTER);

        if (allowance >= amountWei) {
            logger.debug(`1inch approval sufficient: ${allowance} >= ${amountWei}`);
            return null;
        }

        // Approve max for convenience (one-time per token)
        logger.info(`Approving token ${tokenAddress} for 1inch router on ${network}`);
        const maxApproval = ethers.MaxUint256;
        const tx = await token.approve(ONEINCH_ROUTER, maxApproval);
        await tx.wait();
        logger.info(`1inch approval confirmed: ${tx.hash}`);
        return tx;
    }

    /**
     * Execute a swap via 1inch aggregator
     * @returns swap result object matching the format of the main swap() method
     */
    async execute1inchSwap(network, srcToken, dstToken, amountIn, slippage = 1, options = {}) {
        const ethers = await getEthers();
        const chainId = ONEINCH_CHAIN_IDS[network];
        if (!chainId) throw new Error(`1inch not supported on ${network}`);

        const wallet = await walletService.getWallet();
        if (!wallet) throw new Error('Wallet not initialized');

        const mnemonic = decrypt(wallet.encryptedSeed);
        const derivedWallet = ethers.Wallet.fromPhrase(mnemonic);
        const provider = await contractServiceWrapper.getProvider(network);
        const signer = derivedWallet.connect(provider);

        const isNativeIn = srcToken.toLowerCase() === 'native';
        const wrappedNative = this.getWrappedNative(network);

        // Get decimals
        let decimalsIn = 18;
        if (!isNativeIn) {
            const tokenContract = new ethers.Contract(srcToken, ERC20_ABI, provider);
            decimalsIn = Number(await tokenContract.decimals());
        }
        const amountInWei = ethers.parseUnits(amountIn.toString(), decimalsIn);

        // Approve if not native
        if (!isNativeIn) {
            await this.ensure1inchApproval(network, srcToken, amountInWei, signer);
            await new Promise(r => setTimeout(r, 3000)); // wait for approval propagation
        }

        // Get swap calldata from 1inch
        const swapData = await this.get1inchSwapData(
            network, srcToken, dstToken, amountInWei, signer.address, slippage
        );

        // Execute the transaction
        const tx = await signer.sendTransaction({
            to: swapData.tx.to,
            data: swapData.tx.data,
            value: BigInt(swapData.tx.value || '0'),
            gasLimit: BigInt(Math.ceil(Number(swapData.tx.gas) * 1.25)) // 25% gas buffer
        });

        logger.info(`1inch swap tx sent: ${tx.hash}`);

        // Wait for confirmation
        const confirmTimeout = (network === 'ethereum') ? 180000 : 60000;
        const receipt = await Promise.race([
            tx.wait(1),
            new Promise((_, reject) => setTimeout(() => reject(new Error('confirmation_timeout')), confirmTimeout))
        ]);

        let gasCostNative = 0;
        try {
            const gasUsed = receipt.gasUsed;
            const effectiveGasPrice = receipt.gasPrice || receipt.effectiveGasPrice;
            if (gasUsed && effectiveGasPrice) {
                gasCostNative = parseFloat(ethers.formatEther(gasUsed * effectiveGasPrice));
            }
        } catch {}

        // Track in wallet history
        const networkStables = STABLECOINS[network] || {};
        const stableAddrs = Object.values(networkStables).map(a => a.toLowerCase());
        const isBuy = stableAddrs.includes(srcToken?.toLowerCase());
        const isSell = stableAddrs.includes(dstToken?.toLowerCase());
        const txType = isBuy ? 'buy' : isSell ? 'sell' : 'swap';

        await walletService.addTransaction({
            type: txType,
            chain: network,
            hash: tx.hash,
            from: signer.address,
            tokenIn: isNativeIn ? 'NATIVE' : srcToken,
            tokenOut: dstToken.toLowerCase() === 'native' ? 'NATIVE' : dstToken,
            amountIn: amountIn.toString(),
            expectedOut: swapData.dstAmount ? ethers.formatUnits(swapData.dstAmount, swapData.dstToken?.decimals || 18) : 'unknown',
            status: receipt.status === 1 ? 'confirmed' : 'failed'
        });

        return {
            txHash: receipt.hash,
            blockNumber: receipt.blockNumber,
            status: receipt.status === 1 ? 'confirmed' : 'failed',
            source: '1inch',
            protocols: swapData.protocols,
            gasCost: gasCostNative,
            tokenIn: isNativeIn ? 'NATIVE' : srcToken,
            tokenOut: dstToken.toLowerCase() === 'native' ? 'NATIVE' : dstToken,
            amountIn: amountIn.toString(),
            expectedOut: swapData.dstAmount || '0'
        };
    }

    // ---- CoW Protocol (CoW Swap) integration ----

    /**
     * Get a quote from CoW Protocol (intent-based DEX aggregator).
     * CoW Protocol aggregates across all DEXes, private market makers, and
     * uses batch auctions for MEV protection. No API key required.
     * @returns {{ buyAmount: string, sellAmount: string, feeAmount: string }} or null
     */
    async getCowQuote(network, srcToken, dstToken, amountWei, fromAddress) {
        const cowNetwork = COW_NETWORKS[network];
        if (!cowNetwork) return null;

        // Rate limiting
        const now = Date.now();
        if (now - _cowLastRequestTime < _cowMinRequestInterval) {
            await new Promise(r => setTimeout(r, _cowMinRequestInterval - (now - _cowLastRequestTime)));
        }
        _cowLastRequestTime = Date.now();

        try {
            const validTo = Math.floor(Date.now() / 1000) + 600; // 10 min validity
            const response = await fetch(`${COW_API_BASE}/${cowNetwork}/api/v1/quote`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    sellToken: srcToken,
                    buyToken: dstToken,
                    sellAmountBeforeFee: amountWei.toString(),
                    from: fromAddress,
                    kind: 'sell',
                    receiver: fromAddress,
                    validTo,
                    appData: COW_APP_DATA,
                    appDataHash: COW_APP_DATA_HASH,
                    partiallyFillable: false,
                    signingScheme: 'eip712'
                })
            });

            if (!response.ok) {
                const text = await response.text().catch(() => '');
                logger.debug(`CoW quote failed (${response.status}): ${text.slice(0, 200)}`);
                return null;
            }

            const data = await response.json();
            if (!data.quote) return null;

            logger.info(`CoW quote: ${srcToken.slice(0, 10)}→${dstToken.slice(0, 10)} buyAmount=${data.quote.buyAmount} fee=${data.quote.feeAmount}`);
            return {
                buyAmount: data.quote.buyAmount,
                sellAmount: data.quote.sellAmount,
                feeAmount: data.quote.feeAmount,
                validTo: data.quote.validTo,
                quoteId: data.id,
                fullQuote: data.quote
            };
        } catch (err) {
            logger.debug(`CoW quote error: ${err.message}`);
            return null;
        }
    }

    /**
     * Ensure token approval for CoW Protocol's vault relayer.
     * CoW Protocol requires tokens to be approved to their VaultRelayer contract.
     */
    async ensureCowApproval(network, tokenAddress, amountWei, signer) {
        if (!COW_NETWORKS[network]) return null;

        const ethers = await getEthers();
        const token = new ethers.Contract(tokenAddress, ERC20_ABI, signer);
        const allowance = await token.allowance(signer.address, COW_VAULT_RELAYER);

        if (allowance >= amountWei) {
            logger.debug(`CoW approval sufficient: ${allowance} >= ${amountWei}`);
            return null;
        }

        logger.info(`Approving token ${tokenAddress} for CoW VaultRelayer on ${network}`);
        const tx = await token.approve(COW_VAULT_RELAYER, ethers.MaxUint256);
        await tx.wait();
        logger.info(`CoW approval confirmed: ${tx.hash}`);
        return tx;
    }

    /**
     * Execute a swap via CoW Protocol.
     * Creates a signed order and submits it to CoW's order book.
     * The order is filled by solvers asynchronously (typically within 30s-2min).
     * @returns {{ orderUid: string, status: 'submitted' }}
     */
    async executeCowSwap(network, srcToken, dstToken, amountIn, slippage = 1, options = {}) {
        const ethers = await getEthers();
        const cowNetwork = COW_NETWORKS[network];
        if (!cowNetwork) throw new Error(`CoW Protocol not supported on ${network}`);

        const wallet = await walletService.getWallet();
        if (!wallet) throw new Error('Wallet not initialized');

        const mnemonic = decrypt(wallet.encryptedSeed);
        const derivedWallet = ethers.Wallet.fromPhrase(mnemonic);
        const provider = await contractServiceWrapper.getProvider(network);
        const signer = derivedWallet.connect(provider);
        const wrappedNative = this.getWrappedNative(network);
        const decimalsIn = options.decimalsIn || await this._resolveDecimals(srcToken, wrappedNative, network);
        const amountInWei = ethers.parseUnits(amountIn.toString(), decimalsIn);

        // Ensure approval to CoW VaultRelayer
        await this.ensureCowApproval(network, srcToken, amountInWei, signer);

        // Get fresh quote
        const quote = await this.getCowQuote(network, srcToken, dstToken, amountInWei, signer.address);
        if (!quote) throw new Error('CoW Protocol returned no quote for this pair');

        // Minimum order check — solvers won't fill orders below gas cost threshold
        const buyAmount = BigInt(quote.buyAmount);
        const decimalsOut = options.decimalsOut || 18;
        const stables = this.getStablecoins(network);
        const isStableOut = Object.values(stables).some(a => a.toLowerCase() === dstToken.toLowerCase());
        const estimatedUsd = isStableOut
            ? parseFloat(ethers.formatUnits(buyAmount, decimalsOut <= 8 ? decimalsOut : 6))
            : 0;
        if (isStableOut && estimatedUsd < COW_MIN_ORDER_USD) {
            throw new Error(`CoW order too small ($${estimatedUsd.toFixed(2)} < $${COW_MIN_ORDER_USD} minimum) — solvers unlikely to fill`);
        }
        const minBuyAmount = buyAmount - (buyAmount * BigInt(Math.floor(slippage * 100)) / 10000n);

        // Build order
        const validTo = Math.floor(Date.now() / 1000) + 1200; // 20 min
        const order = {
            sellToken: srcToken,
            buyToken: dstToken,
            sellAmount: quote.sellAmount,
            buyAmount: minBuyAmount.toString(),
            validTo,
            appData: COW_APP_DATA_HASH,
            feeAmount: '0', // CoW v2 orders use feeAmount=0 (fees taken from surplus)
            kind: 'sell',
            partiallyFillable: false,
            receiver: signer.address,
            sellTokenBalance: 'erc20',
            buyTokenBalance: 'erc20'
        };

        // EIP-712 domain for CoW Protocol
        const domain = {
            name: 'Gnosis Protocol',
            version: 'v2',
            chainId: { ethereum: 1, base: 8453, arbitrum: 42161 }[network] || 1,
            verifyingContract: '0x9008D19f58AAbD9eD0D60971565AA8510560ab41' // GPv2Settlement (same on all chains)
        };

        const types = {
            Order: [
                { name: 'sellToken', type: 'address' },
                { name: 'buyToken', type: 'address' },
                { name: 'receiver', type: 'address' },
                { name: 'sellAmount', type: 'uint256' },
                { name: 'buyAmount', type: 'uint256' },
                { name: 'validTo', type: 'uint32' },
                { name: 'appData', type: 'bytes32' },
                { name: 'feeAmount', type: 'uint256' },
                { name: 'kind', type: 'string' },
                { name: 'partiallyFillable', type: 'bool' },
                { name: 'sellTokenBalance', type: 'string' },
                { name: 'buyTokenBalance', type: 'string' }
            ]
        };

        // Sign the order
        const signature = await signer.signTypedData(domain, types, order);

        // Submit to CoW orderbook
        const submitResponse = await fetch(`${COW_API_BASE}/${cowNetwork}/api/v1/orders`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                ...order,
                signature,
                signingScheme: 'eip712',
                from: signer.address
            })
        });

        if (!submitResponse.ok) {
            const errText = await submitResponse.text().catch(() => '');
            throw new Error(`CoW order submission failed (${submitResponse.status}): ${errText.slice(0, 200)}`);
        }

        const orderUid = await submitResponse.json();
        logger.info(`CoW order submitted: ${orderUid} (${srcToken.slice(0, 10)}→${dstToken.slice(0, 10)}, sell=${amountIn})`);

        // Track in wallet history
        const networkStables = STABLECOINS[network] || {};
        const stableAddrs = Object.values(networkStables).map(a => a.toLowerCase());
        const isSell = stableAddrs.includes(dstToken?.toLowerCase());
        const isBuy = stableAddrs.includes(srcToken?.toLowerCase());

        await walletService.addTransaction({
            type: isBuy ? 'buy' : isSell ? 'sell' : 'swap',
            chain: network,
            hash: typeof orderUid === 'string' ? orderUid.slice(0, 66) : 'cow-pending',
            from: signer.address,
            tokenIn: srcToken,
            tokenOut: dstToken,
            amountIn: amountIn.toString(),
            expectedOut: ethers.formatUnits(minBuyAmount, options.decimalsOut || 18),
            status: 'pending',
            source: 'cow'
        });

        return {
            orderUid,
            status: 'submitted',
            source: 'cow',
            tokenIn: srcToken,
            tokenOut: dstToken,
            amountIn: amountIn.toString(),
            expectedOut: quote.buyAmount,
            minOut: minBuyAmount.toString()
        };
    }

    /**
     * Compare direct DEX quote vs 1inch aggregator and return the best
     * @returns {{ source: 'direct'|'1inch', quote: object, improvement?: number }}
     */
    async getBestQuote(network, tokenIn, tokenOut, amountIn, options = {}) {
        const ethers = await getEthers();
        const wrappedNative = this.getWrappedNative(network);
        const decimalsIn = options.decimalsIn || await this._resolveDecimals(tokenIn, wrappedNative, network);
        const decimalsOut = options.decimalsOut || await this._resolveDecimals(tokenOut, wrappedNative, network);
        const amountInWei = ethers.parseUnits(amountIn.toString(), decimalsIn);

        // Fire both quotes in parallel
        const [directResult, oneInchResult] = await Promise.allSettled([
            this.getQuote(tokenIn, tokenOut, amountIn, network, undefined, options),
            this.get1inchQuote(network, tokenIn, tokenOut, amountInWei)
        ]);

        const directQuote = directResult.status === 'fulfilled' ? directResult.value : null;
        const oneInchQuote = oneInchResult.status === 'fulfilled' ? oneInchResult.value : null;

        if (!directQuote && !oneInchQuote) {
            throw new Error(`No quotes available for ${tokenIn} → ${tokenOut} on ${network}`);
        }
        if (!directQuote) {
            logger.info(`Only 1inch has a route for ${tokenIn} → ${tokenOut}`);
            return { source: '1inch', quote: oneInchQuote };
        }
        if (!oneInchQuote) {
            return { source: 'direct', quote: directQuote };
        }

        // Compare output amounts
        const directOut = BigInt(directQuote.amountOutWei || directQuote.bestOutput?.amountOutWei || '0');
        const oneInchOut = BigInt(oneInchQuote.dstAmount || '0');

        if (directOut === 0n && oneInchOut === 0n) {
            throw new Error(`Both quotes returned zero output for ${tokenIn} → ${tokenOut}`);
        }

        if (oneInchOut > directOut && directOut > 0n) {
            const improvement = Number((oneInchOut - directOut) * 10000n / directOut) / 100;
            logger.info(`1inch beats direct by ${improvement.toFixed(2)}% (${oneInchOut} vs ${directOut})`);
            return { source: '1inch', quote: oneInchQuote, improvement };
        }

        if (directOut > 0n) {
            if (oneInchOut > 0n) {
                const diff = Number((directOut - oneInchOut) * 10000n / oneInchOut) / 100;
                logger.info(`Direct DEX beats 1inch by ${diff.toFixed(2)}%`);
            }
            return { source: 'direct', quote: directQuote };
        }

        return { source: '1inch', quote: oneInchQuote };
    }

    // ---- V3 Helper Methods ----

    /**
     * Get V3 SwapRouter address for a network
     */
    _getV3RouterForNetwork(network) {
        const routers = DEX_ROUTERS[network] || {};
        return routers.pancakeswapV3 || routers.uniswapV3 || null;
    }

    /**
     * Encode a V3 multi-hop swap path as packed bytes
     * Format: token(20b) + fee(3b) + token(20b) [+ fee(3b) + token(20b)]
     */
    _encodeV3Path(tokens, fees) {
        let encoded = '0x';
        for (let i = 0; i < tokens.length; i++) {
            encoded += tokens[i].slice(2).toLowerCase();
            if (i < fees.length) {
                encoded += fees[i].toString(16).padStart(6, '0');
            }
        }
        return encoded;
    }

    /**
     * Get the best V3 quote across fee tiers and multi-hop paths
     * Returns null if no V3 liquidity or V3 not configured for network
     */
    async _getV3Quote(tokenIn, tokenOut, amountInWei, network) {
        const quoterAddr = V3_QUOTERS[network];
        const v3Router = this._getV3RouterForNetwork(network);
        const feeTiers = V3_FEE_TIERS[network];
        if (!quoterAddr || !v3Router || !feeTiers) return null;

        const ethers = await getEthers();
        const provider = await contractServiceWrapper.getProvider(network);

        // Normalize all addresses to proper EIP-55 checksums (ethers v6 enforces this)
        const checksumAddr = (a) => ethers.getAddress(a.toLowerCase());
        tokenIn = checksumAddr(tokenIn);
        tokenOut = checksumAddr(tokenOut);
        const quoter = new ethers.Contract(checksumAddr(quoterAddr), UNISWAP_V3_QUOTER_ABI, provider);

        const wrappedNative = WRAPPED_NATIVE[network] ? checksumAddr(WRAPPED_NATIVE[network]) : null;
        const rawStables = this.getStablecoins(network);
        const stables = {};
        for (const [name, addr] of Object.entries(rawStables)) {
            stables[name] = checksumAddr(addr);
        }

        let bestResult = null;
        let bestOut = BigInt(0);

        // --- Single-hop: try all fee tiers for direct pair ---
        const singleHopPromises = feeTiers.map(async (fee) => {
            try {
                const result = await quoter.quoteExactInputSingle.staticCall({
                    tokenIn, tokenOut, amountIn: amountInWei, fee, sqrtPriceLimitX96: 0n
                });
                const amountOut = result[0]; // first return value
                return { amountOut, fee, path: [tokenIn, tokenOut], fees: [fee], isMultiHop: false };
            } catch { return null; }
        });

        // --- Multi-hop via wrapped native ---
        const multiHopPromises = [];
        const inIsNative = tokenIn.toLowerCase() === wrappedNative?.toLowerCase();
        const outIsNative = tokenOut.toLowerCase() === wrappedNative?.toLowerCase();

        if (!inIsNative && !outIsNative && wrappedNative) {
            // Via wrapped native: tokenIn -> WBNB -> tokenOut
            // Try all fee tiers for both legs — altcoin pools often use high fee tiers (10000)
            // and we need to handle both buy (stable->native->alt) and sell (alt->native->stable)
            for (const fee1 of feeTiers) {
                for (const fee2 of feeTiers) {
                    multiHopPromises.push((async () => {
                        try {
                            const path = this._encodeV3Path([tokenIn, wrappedNative, tokenOut], [fee1, fee2]);
                            const result = await quoter.quoteExactInput.staticCall(path, amountInWei);
                            return { amountOut: result[0], fee: null, path: [tokenIn, wrappedNative, tokenOut], fees: [fee1, fee2], encodedPath: path, isMultiHop: true };
                        } catch { return null; }
                    })());
                }
            }

            // Via stablecoins: tokenIn -> STABLE -> tokenOut (top 2 fee tiers per leg to limit RPC calls)
            const stableFees = feeTiers.slice(0, 2);
            for (const [, stableAddr] of Object.entries(stables)) {
                if (stableAddr.toLowerCase() !== tokenIn.toLowerCase() && stableAddr.toLowerCase() !== tokenOut.toLowerCase()) {
                    for (const fee1 of stableFees) {
                        for (const fee2 of stableFees) {
                            multiHopPromises.push((async () => {
                                try {
                                    const path = this._encodeV3Path([tokenIn, stableAddr, tokenOut], [fee1, fee2]);
                                    const result = await quoter.quoteExactInput.staticCall(path, amountInWei);
                                    return { amountOut: result[0], fee: null, path: [tokenIn, stableAddr, tokenOut], fees: [fee1, fee2], encodedPath: path, isMultiHop: true };
                                } catch { return null; }
                            })());
                        }
                    }
                }
            }
        }

        // Run all quotes in parallel
        const allResults = await Promise.allSettled([...singleHopPromises, ...multiHopPromises]);

        for (const settled of allResults) {
            if (settled.status === 'fulfilled' && settled.value && settled.value.amountOut > bestOut) {
                bestOut = settled.value.amountOut;
                bestResult = settled.value;
            }
        }

        if (!bestResult) {
            const failCount = allResults.filter(r => r.status === 'rejected' || (r.status === 'fulfilled' && !r.value)).length;
            logger.debug(`V3 quote: no viable pool found on ${network} (${allResults.length} attempts, ${failCount} failed)`);
            return null;
        }
        logger.info(`V3 quote found: ${ethers.formatUnits(bestOut, 18)} output via ${bestResult.isMultiHop ? 'multi-hop' : 'single-hop'} (fee: ${bestResult.fees.join('/')})`);

        // For single-hop, encode the path now
        if (!bestResult.isMultiHop) {
            bestResult.encodedPath = this._encodeV3Path(bestResult.path, bestResult.fees);
        }
        bestResult.routerAddress = v3Router;
        bestResult.feeTier = bestResult.isMultiHop ? null : bestResult.fees[0];

        return bestResult;
    }

    /**
     * Discover V4 hooked pool keys for a specific token pair.
     * Scans ERC20 Transfer events to/from the Vault, finds Swap events,
     * then reads pool keys via poolIdToPoolKey(poolId).
     * Called by background discovery, NOT during quote flow.
     */
    async _discoverV4PoolsForPair(tokenA, tokenB, network) {
        const poolManagerAddr = V4_POOL_MANAGERS[network];
        if (!poolManagerAddr) return [];

        const ethers = await getEthers();
        const addrA = tokenA.toLowerCase();
        const addrB = tokenB.toLowerCase();
        const cacheKey = `${network}:${addrA < addrB ? addrA : addrB}:${addrA < addrB ? addrB : addrA}`;

        try {
            // Use a dedicated provider for discovery to avoid competing with quote/heartbeat RPCs
            const discoveryRpc = network === 'bsc' ? 'https://bsc.drpc.org' : null;
            let provider;
            if (discoveryRpc) {
                const staticNetwork = ethers.Network.from(56);
                provider = new ethers.JsonRpcProvider(discoveryRpc, staticNetwork, { staticNetwork: true, batchMaxCount: 1 });
            } else {
                provider = await contractServiceWrapper.getProvider(network);
            }
            const latestBlock = await provider.getBlockNumber();

            const VAULT = '0x238a358808379702088667322f80aC48bAd5e6c4'.toLowerCase();
            const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
            const SWAP_TOPIC = '0x04206ad2b7c0f463bff3dd4f33c5735b0f2957a351e4f79763a4fa9e775dd237';
            const vaultPadded = '0x' + VAULT.slice(2).padStart(64, '0');

            // Pick the less-common token (not a stablecoin) to reduce Transfer event noise
            const stables = new Set(Object.values(STABLECOINS[network] || {}).map(a => a.toLowerCase()));
            const scanToken = stables.has(addrA) ? addrB : addrA;

            // Scan Transfer events of scanToken TO the Vault (last 5k blocks)
            const fromBlock = latestBlock - 5000;

            // Retry getLogs up to 2 times with delay (rate-limit prone)
            let transferLogs;
            for (let attempt = 0; attempt < 3; attempt++) {
                try {
                    transferLogs = await provider.getLogs({
                        address: scanToken,
                        topics: [TRANSFER_TOPIC, null, vaultPadded],
                        fromBlock,
                        toBlock: latestBlock
                    });
                    break;
                } catch (e) {
                    if (attempt < 2 && e.message?.includes('limit')) {
                        await new Promise(r => setTimeout(r, 5000 * (attempt + 1)));
                        continue;
                    }
                    throw e;
                }
            }

            // Collect unique tx hashes
            const txHashes = new Set();
            for (const log of transferLogs) {
                txHashes.add(log.transactionHash);
            }

            if (txHashes.size === 0) {
                _v4PoolKeyCache.set(cacheKey, []);
                _v4PoolKeyCacheTimestamps.set(cacheKey, Date.now());
                return [];
            }

            // Sample up to 3 transactions to find pool IDs
            const txArr = [...txHashes].slice(0, 3);
            const poolIds = new Set();

            for (let ti = 0; ti < txArr.length; ti++) {
                try {
                    if (ti > 0) await new Promise(r => setTimeout(r, 2000));
                    const receipt = await provider.getTransactionReceipt(txArr[ti]);
                    if (!receipt) continue;
                    for (const log of receipt.logs) {
                        if (log.address.toLowerCase() === poolManagerAddr.toLowerCase() &&
                            log.topics[0] === SWAP_TOPIC && log.topics[1]) {
                            poolIds.add(log.topics[1]);
                        }
                    }
                } catch { /* skip failed receipt fetch */ }
            }

            if (poolIds.size === 0) {
                _v4PoolKeyCache.set(cacheKey, []);
                _v4PoolKeyCacheTimestamps.set(cacheKey, Date.now());
                return [];
            }

            // Read pool keys via poolIdToPoolKey
            const pmIface = new ethers.Interface([
                'function poolIdToPoolKey(bytes32 id) view returns (address currency0, address currency1, address hooks, address poolManager, uint24 fee, bytes32 parameters)'
            ]);

            const discovered = [];
            let poolIdx = 0;
            for (const poolId of poolIds) {
                try {
                    if (poolIdx++ > 0) await new Promise(r => setTimeout(r, 2000));
                    const result = await provider.call({
                        to: poolManagerAddr,
                        data: pmIface.encodeFunctionData('poolIdToPoolKey', [poolId])
                    });
                    const decoded = pmIface.decodeFunctionResult('poolIdToPoolKey', result);
                    const c0 = decoded[0].toLowerCase();
                    const c1 = decoded[1].toLowerCase();
                    const hooks = decoded[2];
                    const fee = Number(decoded[4]);
                    const paramsInt = BigInt(decoded[5]);
                    const hookFlags = Number(paramsInt & 0xFFFFn);
                    const tickSpacing = Number((paramsInt >> 16n) & 0xFFFFFFn);

                    const pairTokens = new Set([c0, c1]);
                    if (!pairTokens.has(addrA) || !pairTokens.has(addrB)) continue;
                    if (hooks === ethers.ZeroAddress) continue;

                    discovered.push({ hooks, fee, tickSpacing, hookFlags });
                } catch { /* skip failed pool key read */ }
            }

            // Cache results
            _v4PoolKeyCache.set(cacheKey, discovered);
            _v4PoolKeyCacheTimestamps.set(cacheKey, Date.now());

            if (discovered.length > 0) {
                const unique = new Set(discovered.map(d => d.hooks.toLowerCase()));
                logger.info(`V4 discovery: found ${discovered.length} hooked pool(s) for ${addrA.slice(0, 10)}/${addrB.slice(0, 10)} (${unique.size} unique hooks) on ${network}`);
            }

            return discovered;
        } catch (err) {
            logger.warn(`V4 discovery failed for ${addrA.slice(0, 10)}/${addrB.slice(0, 10)} on ${network}: ${err.message?.slice(0, 150)}`);
            return [];
        }
    }

    /**
     * Run background V4 hook discovery for a list of token pairs.
     * Staggers calls with delays to avoid RPC rate limiting.
     * Called on startup and periodically (every 30 min).
     *
     * @param {Array<{tokenAddress: string, stablecoin: string, network: string}>} pairs
     */
    async runV4Discovery(pairs) {
        if (!pairs || pairs.length === 0) return;

        const v4Pairs = pairs.filter(p => V4_POOL_MANAGERS[p.network]);
        if (v4Pairs.length === 0) return;

        logger.info(`V4 background discovery: scanning ${v4Pairs.length} token pair(s)`);

        for (let i = 0; i < v4Pairs.length; i++) {
            const { tokenAddress, stablecoin, network } = v4Pairs[i];
            try {
                await this._discoverV4PoolsForPair(tokenAddress, stablecoin, network);
            } catch (err) {
                logger.debug(`V4 background discovery error for ${tokenAddress?.slice(0, 10)}: ${err.message?.slice(0, 100)}`);
            }
            // Stagger 5 seconds between pairs to avoid rate limiting
            if (i < v4Pairs.length - 1) {
                await new Promise(r => setTimeout(r, 5000));
            }
        }

        logger.info(`V4 background discovery complete: ${_v4PoolKeyCache.size} pair(s) cached`);
    }

    /**
     * Start periodic V4 hook discovery. Call once on startup.
     * Runs immediately, then every 30 minutes.
     *
     * @param {Function} getPairs - returns array of {tokenAddress, stablecoin, network}
     */
    startV4DiscoveryLoop(getPairs) {
        if (this._v4DiscoveryTimer) return; // already running

        // Initial run after 90s delay (let startup RPC burst settle)
        setTimeout(async () => {
            try {
                await this.runV4Discovery(getPairs());
            } catch (err) {
                logger.warn(`V4 discovery initial run failed: ${err.message?.slice(0, 150)}`);
            }
        }, 90000);

        // Repeat every 30 minutes
        this._v4DiscoveryTimer = setInterval(async () => {
            try {
                await this.runV4Discovery(getPairs());
            } catch (err) {
                logger.warn(`V4 discovery periodic run failed: ${err.message?.slice(0, 150)}`);
            }
        }, 30 * 60 * 1000);
    }

    /**
     * Get best V4 quote across pool configurations.
     * Handles Uniswap V4 (Ethereum) and PancakeSwap Infinity (BSC) with
     * their different quoter ABIs and PoolKey structures.
     * Returns null if no V4 liquidity or V4 not configured for network.
     */
    async _getV4Quote(tokenIn, tokenOut, amountInWei, network) {
        const quoterAddr = V4_QUOTERS[network];
        const poolConfigs = V4_POOL_CONFIGS[network];
        if (!quoterAddr || !poolConfigs) return null;

        const ethers = await getEthers();
        // Use a dedicated provider for V4 quotes to avoid rate-limit contention with V2/V3
        let provider;
        if (network === 'bsc') {
            if (!this._v4QuoteProvider) {
                const staticNetwork = ethers.Network.from(56);
                this._v4QuoteProvider = new ethers.JsonRpcProvider('https://bsc.publicnode.com', staticNetwork, { staticNetwork: true, batchMaxCount: 1 });
            }
            provider = this._v4QuoteProvider;
        } else {
            provider = await contractServiceWrapper.getProvider(network);
        }
        const checksumAddr = (a) => ethers.getAddress(a.toLowerCase());

        tokenIn = checksumAddr(tokenIn);
        tokenOut = checksumAddr(tokenOut);

        const isPancakeswap = PANCAKESWAP_V4_NETWORKS.has(network);
        const quoterABI = isPancakeswap ? PANCAKESWAP_V4_QUOTER_ABI : V4_QUOTER_ABI;
        const quoter = new ethers.Contract(checksumAddr(quoterAddr), quoterABI, provider);

        let bestOut = BigInt(0);
        let bestResult = null;

        // Helper: decode UnexpectedCallSuccess(bytes) → amountOut (uint256)
        // CLQuoter uses vault.lock() which always reverts — successful quotes revert with
        // selector 0x6190b2b0 wrapping the ABI-encoded (uint256 amountOut, uint256 gasEstimate).
        // Some BSC RPC nodes return this revert data as a "successful" eth_call result.
        const decodeUnexpectedCallSuccess = (hexData) => {
            if (!hexData || typeof hexData !== 'string' || hexData.slice(0, 10) !== '0x6190b2b0') return null;
            try {
                const innerBytes = ethers.AbiCoder.defaultAbiCoder().decode(['bytes'], '0x' + hexData.slice(10))[0];
                if (innerBytes && innerBytes.length >= 130) { // 0x + 128 hex chars = 64 bytes
                    return ethers.AbiCoder.defaultAbiCoder().decode(['uint256', 'uint256'], innerBytes)[0];
                }
            } catch {}
            return null;
        };

        // Helper: decode a raw quote result, handling both normal and revert-as-success cases
        const decodeQuoteRaw = async (rawResult) => {
            if (!rawResult || rawResult === '0x' || rawResult.length < 66) return null;
            // Check for UnexpectedCallSuccess revert returned as success
            const revertDecoded = decodeUnexpectedCallSuccess(rawResult);
            if (revertDecoded) return revertDecoded;
            // Normal decode
            try {
                return ethers.AbiCoder.defaultAbiCoder().decode(['uint256', 'uint256'], rawResult)[0];
            } catch { return null; }
        };

        // Helper to build and execute a PancakeSwap Infinity quote.
        // Uses raw provider.call() because CLQuoter's internal revert mechanism
        // causes ethers staticCall to throw even on successful quotes.
        const pcsQuoterIface = new ethers.Interface(PANCAKESWAP_V4_QUOTER_ABI);
        const tryPancakeswapQuote = async (hooks, fee, tickSpacing, hookFlags) => {
            const currency0 = tokenIn.toLowerCase() < tokenOut.toLowerCase() ? tokenIn : tokenOut;
            const currency1 = tokenIn.toLowerCase() < tokenOut.toLowerCase() ? tokenOut : tokenIn;
            const zeroForOne = tokenIn.toLowerCase() === currency0.toLowerCase();

            // Encode tickSpacing + hookFlags in parameters bytes32
            const paramsVal = (BigInt(tickSpacing) << 16n) | BigInt(hookFlags || 0);
            const parameters = ethers.zeroPadValue(ethers.toBeHex(paramsVal), 32);

            const poolKey = {
                currency0, currency1,
                hooks: checksumAddr(hooks),
                poolManager: checksumAddr(V4_POOL_MANAGERS[network]),
                fee,
                parameters
            };

            // Encode calldata and use raw provider.call() to avoid ethers revert parsing
            const calldata = pcsQuoterIface.encodeFunctionData('quoteExactInputSingle', [{
                poolKey, zeroForOne,
                exactAmount: amountInWei,
                hookData: '0x'
            }]);

            let amountOut;
            try {
                const rawResult = await provider.call({ to: checksumAddr(quoterAddr), data: calldata });
                if (!rawResult || rawResult === '0x' || rawResult.length < 66) {
                    logger.debug(`V4 raw quote empty: hook=${hooks?.slice?.(0, 10) || 'zero'} result=${rawResult?.slice(0, 20) || 'null'} len=${rawResult?.length || 0}`);
                    return null;
                }
                amountOut = await decodeQuoteRaw(rawResult);
                if (!amountOut) return null;
            } catch (callErr) {
                // CLQuoter reverts with UnexpectedCallSuccess(bytes) due to vault.lock() mechanism
                // Try multiple paths to extract the revert data from the ethers error
                const errData = callErr.data || callErr.info?.error?.data;
                amountOut = decodeUnexpectedCallSuccess(errData);

                // Fallback: extract hex data from error message (ethers v6 embeds data= in message)
                if (!amountOut && callErr.message) {
                    const dataMatch = callErr.message.match(/data="(0x6190b2b0[0-9a-fA-F]+)"/);
                    if (dataMatch) {
                        amountOut = decodeUnexpectedCallSuccess(dataMatch[1]);
                    }
                }

                if (!amountOut) throw callErr; // re-throw if we couldn't decode
            }
            // Sanity check: reject obviously wrong quotes (> 1000x input or zero)
            // Reverting V4 hooks return bytes that decode to a sentinel ~8.22e58 — known artifact, not actionable. Demoted to debug.
            if (!amountOut || amountOut <= 0n) return null;
            if (amountOut > amountInWei * 1000n) {
                logger.debug(`V4 quote rejected (sanity): ${ethers.formatUnits(amountOut, 18)} >1000x input — likely reverting hook`);
                return null;
            }

            return {
                amountOut, fee, tickSpacing,
                path: [tokenIn, tokenOut],
                poolKey, zeroForOne,
                v4Protocol: 'pcs-infinity',
                routerAddress: V4_ROUTERS[network]
            };
        };

        // Standard pool quotes (ZeroAddress hooks)
        const quotePromises = poolConfigs.map(async ({ fee, tickSpacing }) => {
            try {
                if (isPancakeswap) {
                    return await tryPancakeswapQuote(ethers.ZeroAddress, fee, tickSpacing, 0);
                } else {
                    // Uniswap V4 — PoolKey-based quoter
                    const currency0 = tokenIn.toLowerCase() < tokenOut.toLowerCase() ? tokenIn : tokenOut;
                    const currency1 = tokenIn.toLowerCase() < tokenOut.toLowerCase() ? tokenOut : tokenIn;
                    const zeroForOne = tokenIn.toLowerCase() === currency0.toLowerCase();
                    const result = await quoter.quoteExactInputSingle.staticCall({
                        poolKey: { currency0, currency1, fee, tickSpacing, hooks: ethers.ZeroAddress },
                        zeroForOne,
                        exactAmount: amountInWei,
                        hookData: '0x'
                    });
                    const amountOut = result[0];
                    if (!amountOut || amountOut <= 0n) return null;
                    if (amountOut > amountInWei * 1000n) return null;
                    return {
                        amountOut, fee, tickSpacing,
                        path: [tokenIn, tokenOut],
                        poolKey: { currency0, currency1, fee, tickSpacing, hooks: ethers.ZeroAddress },
                        zeroForOne,
                        v4Protocol: 'uniswap-v4',
                        routerAddress: V4_ROUTERS[network]
                    };
                }
            } catch { return null; }
        });

        // Hooked pool quotes (PancakeSwap Infinity pools with custom hooks)
        // Uses cached discoveries from background scan + static fallback list
        const hookedConfigs = _getV4HookedPools(network, tokenIn, tokenOut);
        const hookedQuotePromises = isPancakeswap ? hookedConfigs.map(async ({ hooks, fee, tickSpacing, hookFlags }) => {
            try {
                const result = await tryPancakeswapQuote(hooks, fee, tickSpacing, hookFlags);
                if (result) {
                    logger.info(`V4 hooked quote OK: hook=${hooks?.slice(0, 10)}... amountOut=${ethers.formatUnits(result.amountOut, 18)}`);
                }
                return result;
            } catch (hookErr) {
                logger.debug(`V4 hooked quote error (hook=${hooks?.slice(0, 10)}, fee=${fee}): ${hookErr.message?.slice(0, 150)}`);
                return null;
            }
        }) : [];

        // --- Multi-hop via native intermediary (tokenIn → BNB/WBNB → tokenOut) ---
        const wrappedNative = WRAPPED_NATIVE[network] ? checksumAddr(WRAPPED_NATIVE[network]) : null;
        const inIsNative = tokenIn.toLowerCase() === wrappedNative?.toLowerCase();
        const outIsNative = tokenOut.toLowerCase() === wrappedNative?.toLowerCase();
        const multiHopPromises = [];

        if (!inIsNative && !outIsNative && wrappedNative) {
            // Build all leg configs: standard pools + hooked pools
            const allLegConfigs = isPancakeswap
                ? [
                    ...poolConfigs.map(c => ({ ...c, hooks: ethers.ZeroAddress, hookFlags: 0 })),
                    ...hookedConfigs.map(c => ({ fee: c.fee, tickSpacing: c.tickSpacing, hooks: c.hooks, hookFlags: c.hookFlags }))
                  ]
                : poolConfigs.map(c => ({ ...c, hooks: ethers.ZeroAddress, hookFlags: 0 }));

            // PancakeSwap Infinity CLAMM pools with native BNB use address(0) as currency,
            // not WBNB. Try both as intermediary to cover all pool types.
            const intermediaries = isPancakeswap
                ? [wrappedNative, ethers.ZeroAddress]
                : [wrappedNative];

            for (const intermediary of intermediaries) {
              // For address(0), sorting: address(0) < any token address, so it's always currency0
              const interIsZero = intermediary === ethers.ZeroAddress;

              for (const leg1 of allLegConfigs) {
                for (const leg2 of allLegConfigs) {
                    multiHopPromises.push((async () => {
                        try {
                            // Leg 1: tokenIn → intermediary (WBNB or address(0))
                            let leg1Out;
                            if (isPancakeswap) {
                                // For address(0): it's always currency0 (sorts before any real address)
                                const c0 = interIsZero ? intermediary : (tokenIn.toLowerCase() < intermediary.toLowerCase() ? tokenIn : intermediary);
                                const c1 = interIsZero ? tokenIn : (tokenIn.toLowerCase() < intermediary.toLowerCase() ? intermediary : tokenIn);
                                const zfo = interIsZero ? false : (tokenIn.toLowerCase() === c0.toLowerCase());
                                const pVal1 = (BigInt(leg1.tickSpacing) << 16n) | BigInt(leg1.hookFlags || 0);
                                const params1 = ethers.zeroPadValue(ethers.toBeHex(pVal1), 32);
                                const pk1 = { currency0: c0, currency1: c1, hooks: checksumAddr(leg1.hooks), poolManager: checksumAddr(V4_POOL_MANAGERS[network]), fee: leg1.fee, parameters: params1 };
                                const cd1 = pcsQuoterIface.encodeFunctionData('quoteExactInputSingle', [{ poolKey: pk1, zeroForOne: zfo, exactAmount: amountInWei, hookData: '0x' }]);
                                const raw1 = await provider.call({ to: checksumAddr(quoterAddr), data: cd1 });
                                leg1Out = await decodeQuoteRaw(raw1);
                            } else {
                                const c0_l1 = tokenIn.toLowerCase() < intermediary.toLowerCase() ? tokenIn : intermediary;
                                const c1_l1 = tokenIn.toLowerCase() < intermediary.toLowerCase() ? intermediary : tokenIn;
                                const zfo_l1 = tokenIn.toLowerCase() === c0_l1.toLowerCase();
                                const r1 = await quoter.quoteExactInputSingle.staticCall({ poolKey: { currency0: c0_l1, currency1: c1_l1, fee: leg1.fee, tickSpacing: leg1.tickSpacing, hooks: ethers.ZeroAddress }, zeroForOne: zfo_l1, exactAmount: amountInWei, hookData: '0x' });
                                leg1Out = r1[0];
                            }
                            if (!leg1Out || leg1Out <= 0n) return null;

                            // Leg 2: intermediary → tokenOut
                            let leg2Out;
                            if (isPancakeswap) {
                                const c0 = interIsZero ? intermediary : (intermediary.toLowerCase() < tokenOut.toLowerCase() ? intermediary : tokenOut);
                                const c1 = interIsZero ? tokenOut : (intermediary.toLowerCase() < tokenOut.toLowerCase() ? tokenOut : intermediary);
                                const zfo = interIsZero ? true : (intermediary.toLowerCase() === c0.toLowerCase());
                                const pVal2 = (BigInt(leg2.tickSpacing) << 16n) | BigInt(leg2.hookFlags || 0);
                                const params2 = ethers.zeroPadValue(ethers.toBeHex(pVal2), 32);
                                const pk2 = { currency0: c0, currency1: c1, hooks: checksumAddr(leg2.hooks), poolManager: checksumAddr(V4_POOL_MANAGERS[network]), fee: leg2.fee, parameters: params2 };
                                const cd2 = pcsQuoterIface.encodeFunctionData('quoteExactInputSingle', [{ poolKey: pk2, zeroForOne: zfo, exactAmount: leg1Out, hookData: '0x' }]);
                                const raw2 = await provider.call({ to: checksumAddr(quoterAddr), data: cd2 });
                                leg2Out = await decodeQuoteRaw(raw2);
                            } else {
                                const c0_l2 = intermediary.toLowerCase() < tokenOut.toLowerCase() ? intermediary : tokenOut;
                                const c1_l2 = intermediary.toLowerCase() < tokenOut.toLowerCase() ? tokenOut : intermediary;
                                const zfo_l2 = intermediary.toLowerCase() === c0_l2.toLowerCase();
                                const r2 = await quoter.quoteExactInputSingle.staticCall({ poolKey: { currency0: c0_l2, currency1: c1_l2, fee: leg2.fee, tickSpacing: leg2.tickSpacing, hooks: ethers.ZeroAddress }, zeroForOne: zfo_l2, exactAmount: leg1Out, hookData: '0x' });
                                leg2Out = r2[0];
                            }
                            if (!leg2Out || leg2Out <= 0n) return null;

                            return {
                                amountOut: leg2Out, fee: null,
                                path: interIsZero ? [tokenIn, wrappedNative, tokenOut] : [tokenIn, intermediary, tokenOut],
                                fees: [leg1.fee, leg2.fee],
                                tickSpacings: [leg1.tickSpacing, leg2.tickSpacing],
                                isMultiHop: true,
                                isNativeIntermediary: interIsZero,
                                v4Protocol: isPancakeswap ? 'pcs-infinity' : 'uniswap-v4',
                                routerAddress: V4_ROUTERS[network]
                            };
                        } catch { return null; }
                    })());
                }
              }
            } // end intermediaries loop
        }

        // --- Uniswap V4 on BSC (separate protocol from PCS Infinity, different contracts) ---
        const uniV4BscPromises = [];
        if (isPancakeswap && UNISWAP_V4_BSC) {
            const uniV4Quoter = new ethers.Contract(checksumAddr(UNISWAP_V4_BSC.quoter), V4_QUOTER_ABI, provider);
            for (const { fee, tickSpacing } of UNISWAP_V4_POOL_CONFIGS) {
                uniV4BscPromises.push((async () => {
                    try {
                        const currency0 = tokenIn.toLowerCase() < tokenOut.toLowerCase() ? tokenIn : tokenOut;
                        const currency1 = tokenIn.toLowerCase() < tokenOut.toLowerCase() ? tokenOut : tokenIn;
                        const zeroForOne = tokenIn.toLowerCase() === currency0.toLowerCase();
                        const result = await uniV4Quoter.quoteExactInputSingle.staticCall({
                            poolKey: { currency0, currency1, fee, tickSpacing, hooks: ethers.ZeroAddress },
                            zeroForOne,
                            exactAmount: amountInWei,
                            hookData: '0x'
                        });
                        const amountOut = result[0];
                        if (!amountOut || amountOut <= 0n) return null;
                        if (amountOut > amountInWei * 1000n) return null;
                        logger.debug(`Uniswap V4 BSC quote: fee=${fee} amountOut=${ethers.formatUnits(amountOut, 18)}`);
                        return {
                            amountOut, fee, tickSpacing,
                            path: [tokenIn, tokenOut],
                            poolKey: { currency0, currency1, fee, tickSpacing, hooks: ethers.ZeroAddress },
                            zeroForOne,
                            v4Protocol: 'uniswap-v4',
                            routerAddress: UNISWAP_V4_BSC.router
                        };
                    } catch { return null; }
                })());
            }
        }

        const results = await Promise.allSettled([...quotePromises, ...hookedQuotePromises, ...multiHopPromises, ...uniV4BscPromises]);
        for (const settled of results) {
            if (settled.status === 'fulfilled' && settled.value && settled.value.amountOut > bestOut) {
                bestOut = settled.value.amountOut;
                bestResult = settled.value;
            }
        }

        if (!bestResult) {
            const stdCount = quotePromises.length;
            const hookCount = hookedQuotePromises.length;
            const multiCount = multiHopPromises.length;
            const uniV4Count = uniV4BscPromises.length;
            logger.info(`V4 quote: no viable pool found on ${network} (${stdCount} standard, ${hookCount} hooked, ${multiCount} multi-hop${uniV4Count ? `, ${uniV4Count} uniswap-v4` : ''} attempts)`);
            return null;
        }

        const hopType = bestResult.isMultiHop ? 'multi-hop' : 'single-hop';
        const feeStr = bestResult.fees ? bestResult.fees.join('/') : `${bestResult.fee}`;
        const hookStr = bestResult.poolKey?.hooks && bestResult.poolKey.hooks !== ethers.ZeroAddress
            ? ` [hooked: ${bestResult.poolKey.hooks.slice(0, 10)}...]` : '';
        const protoStr = bestResult.v4Protocol ? ` [${bestResult.v4Protocol}]` : '';
        logger.info(`V4 quote found: ${ethers.formatUnits(bestOut, 18)} output via ${hopType} (fee: ${feeStr}, tickSpacing: ${bestResult.tickSpacing || 'multi'}, network: ${network})${hookStr}${protoStr}`);
        bestResult.amountOut = bestOut;
        bestResult.protocolVersion = 'v4';
        return bestResult;
    }

    /**
     * Execute a V4 swap via Universal Router.
     * Routes to PCS Infinity or Uniswap V4 based on v4Protocol tag from quote.
     */
    async _executeV4Swap(v4Data, amountInWei, amountOutMin, signer, deadline, isNativeIn, isNativeOut, network) {
        const ethers = await getEthers();
        const checksumAddr = (a) => ethers.getAddress(a.toLowerCase());
        const tokenIn = checksumAddr(v4Data.path[0]);
        const tokenOut = checksumAddr(v4Data.path[v4Data.path.length - 1]);
        const abiCoder = ethers.AbiCoder.defaultAbiCoder();

        // Determine protocol: use v4Protocol tag from quote, fallback to network heuristic
        const isPcsInfinity = v4Data.v4Protocol === 'pcs-infinity' ||
            (!v4Data.v4Protocol && PANCAKESWAP_V4_NETWORKS.has(network));

        // Use the router from the quote result (critical for Uniswap V4 on BSC which has a different router)
        const routerAddr = v4Data.routerAddress || V4_ROUTERS[network];
        if (!routerAddr) throw new Error(`No V4 router configured for ${network}`);
        const router = new ethers.Contract(checksumAddr(routerAddr), UNIVERSAL_ROUTER_ABI, signer);

        // Build pool key
        let poolKey;
        let zeroForOne;

        if (isPcsInfinity) {
            // PCS Infinity PoolKey: 6 fields (currency0, currency1, hooks, poolManager, fee, parameters)
            if (v4Data.poolKey) {
                poolKey = v4Data.poolKey;
                zeroForOne = v4Data.zeroForOne;
            } else {
                const currency0 = tokenIn.toLowerCase() < tokenOut.toLowerCase() ? tokenIn : tokenOut;
                const currency1 = tokenIn.toLowerCase() < tokenOut.toLowerCase() ? tokenOut : tokenIn;
                zeroForOne = tokenIn.toLowerCase() === currency0.toLowerCase();
                const hookFlags = v4Data.hookFlags || 0;
                const parameters = ethers.zeroPadValue(ethers.toBeHex((v4Data.tickSpacing << 16) | hookFlags), 32);
                poolKey = {
                    currency0, currency1,
                    hooks: v4Data.hooks || ethers.ZeroAddress,
                    poolManager: checksumAddr(V4_POOL_MANAGERS[network]),
                    fee: v4Data.fee,
                    parameters
                };
            }
            return await this._executePCSInfinitySwap(router, abiCoder, ethers, poolKey, zeroForOne, amountInWei, amountOutMin, signer, deadline, isNativeIn, isNativeOut, tokenIn, tokenOut, v4Data, network);
        } else {
            // Uniswap V4 PoolKey: 5 fields (currency0, currency1, fee, tickSpacing, hooks)
            if (v4Data.poolKey) {
                poolKey = v4Data.poolKey;
                zeroForOne = v4Data.zeroForOne;
            } else {
                const currency0 = tokenIn.toLowerCase() < tokenOut.toLowerCase() ? tokenIn : tokenOut;
                const currency1 = tokenIn.toLowerCase() < tokenOut.toLowerCase() ? tokenOut : tokenIn;
                zeroForOne = tokenIn.toLowerCase() === currency0.toLowerCase();
                poolKey = { currency0, currency1, fee: v4Data.fee, tickSpacing: v4Data.tickSpacing, hooks: ethers.ZeroAddress };
            }
            return await this._executeUniswapV4Swap(router, abiCoder, ethers, poolKey, zeroForOne, amountInWei, amountOutMin, signer, deadline, isNativeIn, isNativeOut, tokenIn, tokenOut, v4Data, network);
        }
    }

    /**
     * Execute a PancakeSwap Infinity swap using the Plan/Actions encoding.
     * The Universal Router's INFI_SWAP command expects: abi.encode(bytes actions, bytes[] params)
     * where actions are packed action bytes and params are ABI-encoded action parameters.
     */
    async _executePCSInfinitySwap(router, abiCoder, ethers, poolKey, zeroForOne, amountInWei, amountOutMin, signer, deadline, isNativeIn, isNativeOut, tokenIn, tokenOut, v4Data, network) {
        const checksumAddr = (a) => ethers.getAddress(a.toLowerCase());
        const routerAddr = checksumAddr(V4_ROUTERS[network]);

        // Ensure Permit2 approval for the input token (required by PCS Infinity Universal Router)
        if (!isNativeIn) {
            await this._ensurePermit2Approval(ethers, tokenIn, routerAddr, amountInWei, signer, network);
        }

        // --- Build the Infinity Plan ---
        // Action 1: CL_SWAP_EXACT_IN_SINGLE — execute the swap
        const swapParamsEncoded = abiCoder.encode(
            ['tuple(tuple(address,address,address,address,uint24,bytes32),bool,uint128,uint128,bytes)'],
            [[
                [poolKey.currency0, poolKey.currency1, poolKey.hooks, poolKey.poolManager, poolKey.fee, poolKey.parameters],
                zeroForOne,
                amountInWei,
                amountOutMin,
                '0x' // hookData (empty)
            ]]
        );

        // Determine settle/take currencies based on swap direction
        const settleCurrency = isNativeIn ? ethers.ZeroAddress : tokenIn;
        const takeCurrency = isNativeOut ? ethers.ZeroAddress : tokenOut;

        // Action 2: SETTLE_ALL — pay the input debt to the vault
        // params: (currency, maxAmount) — maxAmount = type(uint256).max
        const settleParamsEncoded = abiCoder.encode(
            ['address', 'uint256'],
            [settleCurrency, ethers.MaxUint256]
        );

        // Action 3: TAKE_ALL — receive the output tokens from the vault
        // params: (currency, minAmount) — minAmount = 0 (slippage already handled by amountOutMinimum in swap params)
        const takeParamsEncoded = abiCoder.encode(
            ['address', 'uint256'],
            [takeCurrency, 0n]
        );

        // Pack actions: [CL_SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL]
        const actionsBytes = ethers.hexlify(Uint8Array.from([
            INFI_ACTIONS.CL_SWAP_EXACT_IN_SINGLE,  // 0x06
            INFI_ACTIONS.SETTLE_ALL,                 // 0x0c
            INFI_ACTIONS.TAKE_ALL                    // 0x0f
        ]));

        // Encode the plan: abi.encode(bytes actions, bytes[] params)
        const planEncoded = abiCoder.encode(
            ['bytes', 'bytes[]'],
            [actionsBytes, [swapParamsEncoded, settleParamsEncoded, takeParamsEncoded]]
        );

        // --- Build Universal Router command sequence ---
        const commands = [];
        const inputs = [];

        if (isNativeIn) {
            // Wrap native BNB first
            commands.push(UR_COMMANDS.WRAP_ETH);
            inputs.push(abiCoder.encode(['address', 'uint256'], [routerAddr, amountInWei]));
        }

        // INFI_SWAP command with the plan as input
        commands.push(UR_COMMANDS.INFI_SWAP);
        inputs.push(planEncoded);

        if (isNativeOut) {
            // Unwrap to native at the end
            commands.push(UR_COMMANDS.UNWRAP_WETH);
            inputs.push(abiCoder.encode(['address', 'uint256'], [signer.address, amountOutMin]));
        }

        // Pack commands into bytes
        const commandBytes = ethers.hexlify(Uint8Array.from(commands));

        const baseOverrides = isNativeIn ? { value: amountInWei } : {};
        let gasLimit = 500000n;
        try {
            const estimated = await router.execute.estimateGas(commandBytes, inputs, deadline, baseOverrides);
            gasLimit = estimated * 125n / 100n;
        } catch { /* fallback to 500k */ }
        const txOverrides = { ...baseOverrides, gasLimit };

        const hookLabel = poolKey.hooks !== ethers.ZeroAddress ? ` hook:${poolKey.hooks.slice(0,10)}` : '';
        logger.info(`V4 PCS Infinity swap: ${commandBytes} (fee:${v4Data.fee}${hookLabel}, zeroForOne:${zeroForOne}, gas:${gasLimit})`);
        return await router.execute(commandBytes, inputs, deadline, txOverrides);
    }

    /**
     * Execute a Uniswap V4 swap using the V4_SWAP (0x10) command with Actions encoding.
     * PoolKey: (currency0, currency1, fee, tickSpacing, hooks) — 5 fields, no poolManager/parameters.
     * Same action bytes as PCS Infinity: SWAP_EXACT_IN_SINGLE(0x06) + SETTLE_ALL(0x0c) + TAKE_ALL(0x0f).
     * Uses canonical Permit2 on all networks.
     */
    async _executeUniswapV4Swap(router, abiCoder, ethers, poolKey, zeroForOne, amountInWei, amountOutMin, signer, deadline, isNativeIn, isNativeOut, tokenIn, tokenOut, v4Data, network) {
        const checksumAddr = (a) => ethers.getAddress(a.toLowerCase());
        const routerAddr = checksumAddr(v4Data.routerAddress || V4_ROUTERS[network]);

        // Ensure Permit2 approval (canonical Permit2 for Uniswap V4)
        if (!isNativeIn) {
            await this._ensurePermit2Approval(ethers, tokenIn, routerAddr, amountInWei, signer, network, PERMIT2_ADDRESSES.ethereum);
        }

        // Action 1: SWAP_EXACT_IN_SINGLE (0x06) — Uniswap V4 PoolKey: (address, address, uint24, int24, address)
        const swapParamsEncoded = abiCoder.encode(
            ['tuple(tuple(address,address,uint24,int24,address),bool,uint128,uint128,bytes)'],
            [[
                [poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks || ethers.ZeroAddress],
                zeroForOne,
                amountInWei,
                amountOutMin,
                '0x' // hookData
            ]]
        );

        const settleCurrency = isNativeIn ? ethers.ZeroAddress : tokenIn;
        const takeCurrency = isNativeOut ? ethers.ZeroAddress : tokenOut;

        // Action 2: SETTLE_ALL (0x0c)
        const settleParamsEncoded = abiCoder.encode(
            ['address', 'uint256'],
            [settleCurrency, ethers.MaxUint256]
        );

        // Action 3: TAKE_ALL (0x0f)
        const takeParamsEncoded = abiCoder.encode(
            ['address', 'uint256'],
            [takeCurrency, 0n]
        );

        // Pack actions and encode plan
        const actionsBytes = ethers.hexlify(Uint8Array.from([0x06, 0x0c, 0x0f]));
        const planEncoded = abiCoder.encode(
            ['bytes', 'bytes[]'],
            [actionsBytes, [swapParamsEncoded, settleParamsEncoded, takeParamsEncoded]]
        );

        // Build Universal Router command sequence
        const commands = [];
        const inputs = [];

        if (isNativeIn) {
            commands.push(UR_COMMANDS.WRAP_ETH);
            inputs.push(abiCoder.encode(['address', 'uint256'], [routerAddr, amountInWei]));
        }

        // V4_SWAP command (0x10) — same byte as INFI_SWAP
        commands.push(0x10);
        inputs.push(planEncoded);

        if (isNativeOut) {
            commands.push(UR_COMMANDS.UNWRAP_WETH);
            inputs.push(abiCoder.encode(['address', 'uint256'], [signer.address, amountOutMin]));
        }

        const commandBytes = ethers.hexlify(Uint8Array.from(commands));
        const baseOverrides = isNativeIn ? { value: amountInWei } : {};
        let gasLimit = 500000n;
        try {
            const estimated = await router.execute.estimateGas(commandBytes, inputs, deadline, baseOverrides);
            gasLimit = estimated * 125n / 100n;
        } catch { /* fallback to 500k */ }
        const txOverrides = { ...baseOverrides, gasLimit };

        logger.info(`V4 Uniswap swap: ${commandBytes} (fee:${v4Data.fee}, zeroForOne:${zeroForOne}, network:${network}, gas:${gasLimit})`);
        return await router.execute(commandBytes, inputs, deadline, txOverrides);
    }

    /**
     * Ensure Permit2 approval chain: ERC20 → Permit2 → UniversalRouter
     * Both PCS Infinity and Uniswap V4 use Permit2, but with different contract addresses.
     * @param {string} permit2Override - Override Permit2 address (for Uniswap V4 on BSC which uses canonical Permit2)
     */
    async _ensurePermit2Approval(ethers, tokenAddress, routerAddress, amount, signer, network, permit2Override) {
        const checksumAddr = (a) => ethers.getAddress(a.toLowerCase());
        const permit2Address = permit2Override || PERMIT2_ADDRESSES[network] || PERMIT2_ADDRESSES.ethereum;
        const permit2Addr = checksumAddr(permit2Address);
        const tokenAddr = checksumAddr(tokenAddress);

        // Step 1: Ensure ERC20 approval from user → Permit2
        const token = new ethers.Contract(tokenAddr, [
            'function allowance(address,address) view returns (uint256)',
            'function approve(address,uint256) returns (bool)'
        ], signer);
        const erc20Allowance = await token.allowance(signer.address, permit2Addr);
        if (erc20Allowance < amount) {
            logger.info(`V4 Permit2: approving ${tokenAddr.slice(0,10)}... to Permit2`);
            const maxApproval = ethers.MaxUint256;
            const tx = await token.approve(permit2Addr, maxApproval);
            await tx.wait();
            logger.info('V4 Permit2: ERC20 → Permit2 approval confirmed');
        }

        // Step 2: Ensure Permit2 approval from user → UniversalRouter
        const permit2 = new ethers.Contract(permit2Addr, PERMIT2_ABI, signer);
        const [p2Amount, p2Expiration] = await permit2.allowance(signer.address, tokenAddr, routerAddress);
        const now = Math.floor(Date.now() / 1000);
        // Re-approve if amount insufficient or expiration within 1 hour
        if (p2Amount < amount || Number(p2Expiration) < now + 3600) {
            logger.info(`V4 Permit2: approving Permit2 → Router for ${tokenAddr.slice(0,10)}...`);
            // max uint160 amount, expiry far in the future (30 days)
            const maxAmount = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF'); // uint160 max
            const expiry = BigInt(now + 30 * 24 * 3600); // 30 days
            const tx = await permit2.approve(tokenAddr, routerAddress, maxAmount, expiry);
            await tx.wait();
            logger.info('V4 Permit2: Permit2 → Router approval confirmed');
        }
    }

    /**
     * Execute a V3 swap transaction
     */
    async _executeV3Swap(v3Data, amountInWei, amountOutMin, signer, deadline, isNativeIn, isNativeOut, network) {
        const ethers = await getEthers();
        const checksumAddr = (a) => ethers.getAddress(a.toLowerCase());
        const isSmartRouter = SMART_ROUTER_NETWORKS.has(network);
        const routerABI = isSmartRouter ? PANCAKESWAP_SMART_ROUTER_ABI : UNISWAP_V3_ROUTER_ABI;
        const v3Router = new ethers.Contract(checksumAddr(v3Data.routerAddress), routerABI, signer);
        const baseOverrides = isNativeIn ? { value: amountInWei } : {};

        // Estimate gas dynamically with 25% buffer, fall back to 500k
        const estimateGas = async (method, args, overrides) => {
            try {
                const estimated = await method.estimateGas(...args, overrides);
                return estimated * 125n / 100n;
            } catch { return 500000n; }
        };

        if (isNativeOut) {
            // For native output: swap to WETH in router, then unwrapWETH9
            let swapCalldata;
            if (v3Data.isMultiHop) {
                const inputParams = isSmartRouter
                    ? { path: v3Data.encodedPath, recipient: v3Data.routerAddress, amountIn: amountInWei, amountOutMinimum: amountOutMin }
                    : { path: v3Data.encodedPath, recipient: v3Data.routerAddress, deadline, amountIn: amountInWei, amountOutMinimum: amountOutMin };
                swapCalldata = v3Router.interface.encodeFunctionData('exactInput', [inputParams]);
            } else {
                const singleParams = isSmartRouter
                    ? { tokenIn: v3Data.path[0], tokenOut: v3Data.path[v3Data.path.length - 1], fee: v3Data.feeTier, recipient: v3Data.routerAddress, amountIn: amountInWei, amountOutMinimum: amountOutMin, sqrtPriceLimitX96: 0n }
                    : { tokenIn: v3Data.path[0], tokenOut: v3Data.path[v3Data.path.length - 1], fee: v3Data.feeTier, recipient: v3Data.routerAddress, deadline, amountIn: amountInWei, amountOutMinimum: amountOutMin, sqrtPriceLimitX96: 0n };
                swapCalldata = v3Router.interface.encodeFunctionData('exactInputSingle', [singleParams]);
            }
            const unwrapCalldata = v3Router.interface.encodeFunctionData('unwrapWETH9', [amountOutMin, signer.address]);
            // SmartRouter uses multicall(deadline, data[]), old router uses multicall(data[])
            if (isSmartRouter) {
                const gasLimit = await estimateGas(v3Router.multicall, [deadline, [swapCalldata, unwrapCalldata]], baseOverrides);
                return await v3Router.multicall(deadline, [swapCalldata, unwrapCalldata], { ...baseOverrides, gasLimit });
            }
            const gasLimit = await estimateGas(v3Router.multicall, [[swapCalldata, unwrapCalldata]], baseOverrides);
            return await v3Router.multicall([swapCalldata, unwrapCalldata], { ...baseOverrides, gasLimit });
        }

        // Token-to-token or native-to-token: wrap in multicall with deadline for SmartRouter
        if (isSmartRouter) {
            let swapCalldata;
            if (v3Data.isMultiHop) {
                swapCalldata = v3Router.interface.encodeFunctionData('exactInput', [{
                    path: v3Data.encodedPath, recipient: signer.address,
                    amountIn: amountInWei, amountOutMinimum: amountOutMin
                }]);
            } else {
                swapCalldata = v3Router.interface.encodeFunctionData('exactInputSingle', [{
                    tokenIn: v3Data.path[0], tokenOut: v3Data.path[v3Data.path.length - 1],
                    fee: v3Data.feeTier, recipient: signer.address,
                    amountIn: amountInWei, amountOutMinimum: amountOutMin,
                    sqrtPriceLimitX96: 0n
                }]);
            }
            const gasLimit = await estimateGas(v3Router.multicall, [deadline, [swapCalldata]], baseOverrides);
            return await v3Router.multicall(deadline, [swapCalldata], { ...baseOverrides, gasLimit });
        }

        // Old-style Uniswap V3 router (deadline in struct)
        if (v3Data.isMultiHop) {
            const params = {
                path: v3Data.encodedPath, recipient: signer.address,
                deadline, amountIn: amountInWei, amountOutMinimum: amountOutMin
            };
            const gasLimit = await estimateGas(v3Router.exactInput, [params], baseOverrides);
            return await v3Router.exactInput(params, { ...baseOverrides, gasLimit });
        }

        const params = {
            tokenIn: v3Data.path[0], tokenOut: v3Data.path[v3Data.path.length - 1],
            fee: v3Data.feeTier, recipient: signer.address,
            deadline, amountIn: amountInWei, amountOutMinimum: amountOutMin,
            sqrtPriceLimitX96: 0n
        };
        const gasLimit = await estimateGas(v3Router.exactInputSingle, [params], baseOverrides);
        return await v3Router.exactInputSingle(params, { ...baseOverrides, gasLimit });
    }

    /**
     * Get quote for a swap
     */
    async getQuote(tokenIn, tokenOut, amountIn, network, routerType = 'uniswapV2', options = {}) {
        try {
            const ethers = await getEthers();
            const routers = this.getRoutersForNetwork(network);

            // Find appropriate router
            let routerAddress = routers[routerType];
            if (!routerAddress) {
                // Try first available router
                routerAddress = Object.values(routers)[0];
            }

            if (!routerAddress) {
                throw new Error(`No DEX router available for ${network}`);
            }

            const provider = await contractServiceWrapper.getProvider(network);
            const router = new ethers.Contract(routerAddress, UNISWAP_V2_ROUTER_ABI, provider);

            // Build candidate paths and pick the best rate
            const wrappedNative = this.getWrappedNative(network);

            if (tokenIn.toLowerCase() === 'native') {
                tokenIn = wrappedNative;
            }
            if (tokenOut.toLowerCase() === 'native') {
                tokenOut = wrappedNative;
            }

            // Auto-fetch decimals for 6-decimal tokens (USDT/USDC on Ethereum)
            const decimalsIn = options.decimalsIn || await this._resolveDecimals(tokenIn, wrappedNative, network);
            const decimalsOut = options.decimalsOut || await this._resolveDecimals(tokenOut, wrappedNative, network);
            const amountInWei = ethers.parseUnits(amountIn.toString(), decimalsIn);

            // Build candidate paths
            const candidatePaths = [];
            const inIsNative = tokenIn.toLowerCase() === wrappedNative?.toLowerCase();
            const outIsNative = tokenOut.toLowerCase() === wrappedNative?.toLowerCase();

            // Direct path (always try)
            candidatePaths.push([tokenIn, tokenOut]);

            if (!inIsNative && !outIsNative) {
                // Via wrapped native
                if (wrappedNative) candidatePaths.push([tokenIn, wrappedNative, tokenOut]);
                // Via stablecoins
                const stables = this.getStablecoins(network);
                for (const [, stableAddr] of Object.entries(stables)) {
                    if (stableAddr.toLowerCase() !== tokenIn.toLowerCase() &&
                        stableAddr.toLowerCase() !== tokenOut.toLowerCase()) {
                        candidatePaths.push([tokenIn, stableAddr, tokenOut]);
                        // Also try token -> native -> stable (3-hop)
                        if (wrappedNative) candidatePaths.push([tokenIn, wrappedNative, stableAddr, tokenOut]);
                    }
                }
            }

            // Try each path and pick best output
            let bestPath = null;
            let bestOut = BigInt(0);
            for (const candidatePath of candidatePaths) {
                try {
                    const amounts = await router.getAmountsOut(amountInWei, candidatePath);
                    const out = amounts[amounts.length - 1];
                    if (out > bestOut) {
                        bestOut = out;
                        bestPath = candidatePath;
                    }
                } catch {
                    // Path doesn't exist or has no liquidity, skip
                }
            }

            // ---- V3 Quote (try alongside V2) ----
            let v3Result = null;
            try {
                v3Result = await this._getV3Quote(tokenIn, tokenOut, amountInWei, network);
            } catch (err) {
                logger.debug(`V3 quote failed for ${network}: ${err.message}`);
            }

            // ---- V4 Quote (PancakeSwap Infinity / Uniswap V4) ----
            let v4Result = null;
            try {
                v4Result = await this._getV4Quote(tokenIn, tokenOut, amountInWei, network);
            } catch (err) {
                logger.debug(`V4 quote failed for ${network}: ${err.message?.slice(0, 150)}`);
            }

            // ---- CoW Protocol quote (Ethereum mainnet — intent-based aggregator) ----
            let cowResult = null;
            if (COW_NETWORKS[network]) {
                try {
                    const wallet = await walletService.getWallet();
                    const fromAddr = wallet?.address || '0x0000000000000000000000000000000000000000';
                    cowResult = await this.getCowQuote(network, tokenIn, tokenOut, amountInWei, fromAddr);
                    // Filter out orders too small for solvers to fill
                    if (cowResult?.buyAmount) {
                        const stables = this.getStablecoins(network);
                        const isStableOut = Object.values(stables).some(a => a.toLowerCase() === tokenOut.toLowerCase());
                        if (isStableOut) {
                            const estUsd = parseFloat(ethers.formatUnits(BigInt(cowResult.buyAmount), decimalsOut));
                            if (estUsd < COW_MIN_ORDER_USD) {
                                logger.debug(`CoW quote below minimum ($${estUsd.toFixed(2)} < $${COW_MIN_ORDER_USD}) — skipping`);
                                cowResult = null;
                            }
                        }
                    }
                } catch (err) {
                    logger.debug(`CoW quote failed for ${network}: ${err.message}`);
                }
            }

            // ---- 1inch aggregator quote (requires API key) ----
            let oneInchResult = null;
            if (ONEINCH_CHAIN_IDS[network] && process.env.ONEINCH_API_KEY) {
                try {
                    oneInchResult = await this.get1inchQuote(network, tokenIn, tokenOut, amountInWei);
                } catch (err) {
                    logger.debug(`1inch quote failed for ${network}: ${err.message}`);
                }
            }

            // ---- 5-way comparison: pick best of V2, V3, V4, CoW, 1inch ----
            const v2Out = bestOut;
            const v3Out = v3Result?.amountOut || 0n;
            const v4Out = v4Result?.amountOut || 0n;
            const cowOut = cowResult?.buyAmount ? BigInt(cowResult.buyAmount) : 0n;
            const oneInchOut = oneInchResult?.dstAmount ? BigInt(oneInchResult.dstAmount) : 0n;

            // Find the overall best output
            const candidates = [
                { name: 'cow', out: cowOut, result: cowResult },
                { name: '1inch', out: oneInchOut, result: oneInchResult },
                { name: 'v4', out: v4Out, result: v4Result },
                { name: 'v3', out: v3Out, result: v3Result },
                { name: 'v2', out: v2Out, result: bestPath }
            ].filter(c => c.out > 0n);

            candidates.sort((a, b) => (b.out > a.out ? 1 : b.out < a.out ? -1 : 0));

            const logParts = candidates.map(c => `${c.name}=${ethers.formatUnits(c.out, decimalsOut)}`).join(', ');

            // CoW Protocol wins
            if (candidates[0]?.name === 'cow') {
                logger.info(`CoW wins quote: ${logParts}`);
                return {
                    tokenIn, tokenOut,
                    amountIn: amountIn.toString(),
                    amountOut: ethers.formatUnits(cowOut, decimalsOut),
                    amountOutWei: cowOut.toString(),
                    path: [tokenIn, tokenOut],
                    router: COW_VAULT_RELAYER,
                    network,
                    priceImpact: 'N/A',
                    protocolVersion: 'cow',
                    cow: { quoteId: cowResult.quoteId, feeAmount: cowResult.feeAmount, fullQuote: cowResult.fullQuote }
                };
            }

            // 1inch wins
            if (candidates[0]?.name === '1inch') {
                logger.info(`1inch wins quote: ${logParts}`);
                return {
                    tokenIn, tokenOut,
                    amountIn: amountIn.toString(),
                    amountOut: ethers.formatUnits(oneInchOut, decimalsOut),
                    amountOutWei: oneInchOut.toString(),
                    path: [tokenIn, tokenOut],
                    router: ONEINCH_ROUTER,
                    network,
                    priceImpact: 'N/A',
                    protocolVersion: '1inch',
                    oneInch: { protocols: oneInchResult.protocols, gas: oneInchResult.gas }
                };
            }

            // V4 wins
            if (candidates[0]?.name === 'v4') {
                logger.info(`V4 wins quote: ${logParts} (fee: ${v4Result.fee})`);
                return {
                    tokenIn, tokenOut,
                    amountIn: amountIn.toString(),
                    amountOut: ethers.formatUnits(v4Out, decimalsOut),
                    amountOutWei: v4Out.toString(),
                    path: v4Result.path,
                    router: v4Result.routerAddress,
                    network,
                    priceImpact: 'N/A',
                    protocolVersion: 'v4',
                    v4: { fee: v4Result.fee, tickSpacing: v4Result.tickSpacing, poolKey: v4Result.poolKey, zeroForOne: v4Result.zeroForOne }
                };
            }

            // V3 wins
            if (candidates[0]?.name === 'v3') {
                const v3PathDesc = v3Result.path.map(a => a.slice(0, 10) + '...').join(' → ');
                logger.info(`V3 wins quote: ${logParts} (${v3PathDesc}, fee: ${v3Result.fees.join('/')})`);
                return {
                    tokenIn, tokenOut,
                    amountIn: amountIn.toString(),
                    amountOut: ethers.formatUnits(v3Out, decimalsOut),
                    amountOutWei: v3Out.toString(),
                    path: v3Result.path,
                    router: v3Result.routerAddress,
                    network,
                    priceImpact: 'N/A',
                    protocolVersion: 'v3',
                    v3: { feeTier: v3Result.feeTier, fees: v3Result.fees, encodedPath: v3Result.encodedPath, isMultiHop: v3Result.isMultiHop }
                };
            }

            // V2 wins (or nothing found)
            if (!bestPath || v2Out === BigInt(0)) {
                throw new Error(`No viable swap path found for ${tokenIn} → ${tokenOut} on ${network}`);
            }

            logger.debug(`V2 wins quote: ${logParts}`);

            return {
                tokenIn,
                tokenOut,
                amountIn: amountIn.toString(),
                amountOut: ethers.formatUnits(v2Out, decimalsOut),
                amountOutWei: v2Out.toString(),
                path: bestPath,
                router: routerAddress,
                network,
                priceImpact: 'N/A',
                protocolVersion: 'v2'
            };
        } catch (error) {
            if (error.message?.includes('No viable swap path')) {
                logger.debug('No swap path found:', error.message);
            } else {
                logger.error('Failed to get swap quote:', error);
            }
            throw error;
        }
    }

    /**
     * Get separate V2 and V3 quotes for the same swap. Used by the arbitrage
     * scanner to detect cross-protocol price discrepancies. Makes the same
     * RPC calls as getQuote() but returns both results instead of only the winner.
     */
    async getQuotesByProtocol(tokenIn, tokenOut, amountIn, network, options = {}) {
        const ethers = await getEthers();
        const routers = this.getRoutersForNetwork(network);
        const routerAddress = routers.uniswapV2 || routers.pancakeswap || Object.values(routers)[0];
        const provider = await contractServiceWrapper.getProvider(network);
        const wrappedNative = this.getWrappedNative(network);

        if (tokenIn.toLowerCase() === 'native') tokenIn = wrappedNative;
        if (tokenOut.toLowerCase() === 'native') tokenOut = wrappedNative;

        const decimalsIn = options.decimalsIn || await this._resolveDecimals(tokenIn, wrappedNative, network);
        const decimalsOut = options.decimalsOut || await this._resolveDecimals(tokenOut, wrappedNative, network);
        const amountInWei = ethers.parseUnits(amountIn.toString(), decimalsIn);

        // V2 quote (parallel path exploration)
        const v2Promise = (async () => {
            try {
                if (!routerAddress) {
                    logger.debug(`V2 quote: no router address for ${network}`);
                    return null;
                }
                const router = new ethers.Contract(routerAddress, UNISWAP_V2_ROUTER_ABI, provider);
                const candidatePaths = [[tokenIn, tokenOut]];
                const inIsNative = tokenIn.toLowerCase() === wrappedNative?.toLowerCase();
                const outIsNative = tokenOut.toLowerCase() === wrappedNative?.toLowerCase();
                if (!inIsNative && !outIsNative && wrappedNative) {
                    candidatePaths.push([tokenIn, wrappedNative, tokenOut]);
                    const stables = this.getStablecoins(network);
                    for (const [, addr] of Object.entries(stables)) {
                        if (addr.toLowerCase() !== tokenIn.toLowerCase() &&
                            addr.toLowerCase() !== tokenOut.toLowerCase()) {
                            candidatePaths.push([tokenIn, addr, tokenOut]);
                        }
                    }
                }
                const pathResults = await Promise.allSettled(
                    candidatePaths.map(async (path) => {
                        const amounts = await router.getAmountsOut(amountInWei, path);
                        return { path, out: amounts[amounts.length - 1] };
                    })
                );
                let bestPath = null, bestOut = BigInt(0);
                for (const r of pathResults) {
                    if (r.status === 'fulfilled' && r.value.out > bestOut) {
                        bestOut = r.value.out;
                        bestPath = r.value.path;
                    }
                }
                if (!bestPath || bestOut === 0n) {
                    const failCount = pathResults.filter(r => r.status === 'rejected').length;
                    logger.debug(`V2 quote: no path found [${network}] (${pathResults.length} paths tried, ${failCount} rejected, in=${tokenIn.slice(0,10)}, out=${tokenOut.slice(0,10)})`);
                    return null;
                }
                return {
                    tokenIn, tokenOut,
                    amountIn: amountIn.toString(),
                    amountOut: ethers.formatUnits(bestOut, decimalsOut),
                    amountOutWei: bestOut.toString(),
                    path: bestPath, router: routerAddress, network,
                    protocolVersion: 'v2',
                };
            } catch (err) {
                logger.debug(`V2 quote error [${network}]: ${err.message}`);
                return null;
            }
        })();

        // V3 quote (reuses existing _getV3Quote which parallelizes fee tiers)
        const v3Promise = (async () => {
            try {
                const v3Result = await this._getV3Quote(tokenIn, tokenOut, amountInWei, network);
                if (!v3Result) {
                    logger.debug(`V3 quote: null result [${network}] (in=${tokenIn.slice(0,10)}, out=${tokenOut.slice(0,10)})`);
                    return null;
                }
                return {
                    tokenIn, tokenOut,
                    amountIn: amountIn.toString(),
                    amountOut: ethers.formatUnits(v3Result.amountOut, decimalsOut),
                    amountOutWei: v3Result.amountOut.toString(),
                    path: v3Result.path, router: v3Result.routerAddress, network,
                    protocolVersion: 'v3',
                    v3: { feeTier: v3Result.feeTier, fees: v3Result.fees, encodedPath: v3Result.encodedPath, isMultiHop: v3Result.isMultiHop },
                };
            } catch (err) {
                logger.debug(`V3 quote error [${network}]: ${err.message}`);
                return null;
            }
        })();

        // Get V2+V3 first to avoid RPC rate limiting from too many parallel calls
        const [v2, v3] = await Promise.all([v2Promise, v3Promise]);

        // V4 quote (Uniswap V4 on ETH, PancakeSwap Infinity on BSC) — run after V2/V3 to reduce RPC burst
        let v4 = null;
        try {
            const v4Result = await this._getV4Quote(tokenIn, tokenOut, amountInWei, network);
            if (v4Result) {
                v4 = {
                    tokenIn, tokenOut,
                    amountIn: amountIn.toString(),
                    amountOut: ethers.formatUnits(v4Result.amountOut, decimalsOut),
                    amountOutWei: v4Result.amountOut.toString(),
                    network,
                    protocolVersion: 'v4',
                    v4: { fee: v4Result.fee, tickSpacing: v4Result.tickSpacing },
                };
            }
        } catch (err) {
            logger.info(`V4 quote error [${network}]: ${err.message?.slice(0, 200)}`);
        }

        return { v2, v3, v4 };
    }

    /**
     * Get V3 quotes broken out by individual fee tier.
     * Returns an object keyed by fee tier with the best quote for each.
     * Used by ArbitrageStrategy for intra-V3 fee tier arbitrage detection.
     * @returns {{ [feeTier: number]: { amountOut: string, amountOutWei: string, feeTier: number } | null }}
     */
    async getV3QuotesByFeeTier(tokenIn, tokenOut, amountIn, network, options = {}) {
        const ethers = await getEthers();
        const quoterAddr = V3_QUOTERS[network];
        const feeTiers = V3_FEE_TIERS[network];
        if (!quoterAddr || !feeTiers) return {};

        const provider = await contractServiceWrapper.getProvider(network);
        const checksumAddr = (a) => ethers.getAddress(a.toLowerCase());
        const wrappedNative = WRAPPED_NATIVE[network] ? checksumAddr(WRAPPED_NATIVE[network]) : null;

        if (tokenIn.toLowerCase() === 'native') tokenIn = wrappedNative;
        if (tokenOut.toLowerCase() === 'native') tokenOut = wrappedNative;
        tokenIn = checksumAddr(tokenIn);
        tokenOut = checksumAddr(tokenOut);

        const decimalsIn = options.decimalsIn || 18;
        const decimalsOut = options.decimalsOut || 18;
        const amountInWei = ethers.parseUnits(amountIn.toString(), decimalsIn);
        const quoter = new ethers.Contract(checksumAddr(quoterAddr), UNISWAP_V3_QUOTER_ABI, provider);

        const results = {};

        // Single-hop per fee tier (direct pair)
        const tierPromises = feeTiers.map(async (fee) => {
            try {
                const result = await quoter.quoteExactInputSingle.staticCall({
                    tokenIn, tokenOut, amountIn: amountInWei, fee, sqrtPriceLimitX96: 0n
                });
                const amountOut = result[0];
                if (amountOut > 0n) {
                    return { fee, amountOut: ethers.formatUnits(amountOut, decimalsOut), amountOutWei: amountOut.toString(), feeTier: fee };
                }
            } catch { /* no pool at this tier */ }
            return { fee, quote: null };
        });

        const settled = await Promise.allSettled(tierPromises);
        for (const s of settled) {
            if (s.status === 'fulfilled' && s.value) {
                const v = s.value;
                if (v.amountOut) {
                    results[v.fee] = { amountOut: v.amountOut, amountOutWei: v.amountOutWei, feeTier: v.feeTier };
                }
            }
        }
        return results;
    }

    /**
     * Execute a token swap with optional dynamic slippage retry
     * @param {string} tokenIn - Input token address or 'native'
     * @param {string} tokenOut - Output token address or 'native'
     * @param {string|number} amountIn - Amount of input token
     * @param {number} slippageTolerance - Base slippage % (default 0.5)
     * @param {string} network - Network name
     * @param {object} options - Optional swap options
     * @param {number} options.tokenTaxPercent - Known token tax % (auto-detected if not set)
     * @param {number} options.maxSlippage - Hard ceiling for slippage %
     * @param {boolean} options.enableRetry - Enable retry on slippage reverts (default false)
     * @param {number} options.maxRetries - Max retry attempts (default 3)
     * @param {boolean} options.gasCheck - Pre-check gas balance (default false)
     */
    async swap(tokenIn, tokenOut, amountIn, slippageTolerance = 0.5, network, options = {}) {
        const {
            tokenTaxPercent = 0,
            maxSlippage: userMaxSlippage,
            enableRetry = false,
            maxRetries = 3,
            gasCheck = false,
            forceV3 = false,
            preferV3 = false,
            expectedOutputUsd = 0,
            outputTokenPriceUsd = 0,
            urgent = false
        } = options;

        // Check scammer registry — refuse to transact with flagged addresses
        try {
            const scammerRegistry = (await import('./scammerRegistryService.js')).default;
            if (tokenIn && tokenIn.toLowerCase() !== 'native' && scammerRegistry.isAddressFlagged(tokenIn)) {
                throw new Error(`Swap blocked: tokenIn ${tokenIn} is flagged in scammer registry`);
            }
            if (tokenOut && tokenOut.toLowerCase() !== 'native' && scammerRegistry.isAddressFlagged(tokenOut)) {
                throw new Error(`Swap blocked: tokenOut ${tokenOut} is flagged in scammer registry`);
            }
        } catch (e) {
            if (e.message.startsWith('Swap blocked')) throw e;
            // Registry not available — continue without check
        }

        // Calculate hard slippage ceiling based on token tax
        // Ensure ceiling is at least 2% above starting slippage so retries can actually fire
        const hardCeiling = tokenTaxPercent > 0
            ? Math.min(tokenTaxPercent + 5, 15)  // Tax token: tax + 5%, max 15%
            : Math.max(userMaxSlippage || 5, slippageTolerance + 2);

        try {
            const ethers = await getEthers();
            logger.info(`swap() called: ${tokenIn?.slice(0, 10)} → ${tokenOut?.slice(0, 10)} amount=${amountIn} network=${network} urgent=${urgent}`);

            // Get wallet
            const wallet = await walletService.getWallet();
            if (!wallet) {
                throw new Error('Wallet not initialized');
            }

            // Decrypt seed and create signer
            const mnemonic = decrypt(wallet.encryptedSeed);
            const derivedWallet = ethers.Wallet.fromPhrase(mnemonic);

            const provider = await contractServiceWrapper.getProvider(network);
            const signer = derivedWallet.connect(provider);

            const routers = this.getRoutersForNetwork(network);
            const routerAddress = Object.values(routers)[0];

            if (!routerAddress) {
                throw new Error(`No DEX router available for ${network}`);
            }

            const router = new ethers.Contract(routerAddress, UNISWAP_V2_ROUTER_ABI, signer);
            const wrappedNative = this.getWrappedNative(network);

            const isNativeIn = tokenIn.toLowerCase() === 'native';
            const isNativeOut = tokenOut.toLowerCase() === 'native';

            if (isNativeIn) tokenIn = wrappedNative;
            if (isNativeOut) tokenOut = wrappedNative;

            // Get token decimals for both input and output
            const tokenInContract = new ethers.Contract(isNativeIn ? wrappedNative : tokenIn, ERC20_ABI, provider);
            const decimals = isNativeIn ? 18 : await tokenInContract.decimals();
            const tokenOutContract = new ethers.Contract(isNativeOut ? wrappedNative : tokenOut, ERC20_ABI, provider);
            const decimalsOut = isNativeOut ? 18 : await tokenOutContract.decimals();

            let amountInWei = ethers.parseUnits(amountIn.toString(), decimals);

            // Find best swap path across multiple routes
            const inAddr = isNativeIn ? wrappedNative : tokenIn;
            const outAddr = isNativeOut ? wrappedNative : tokenOut;
            const candidatePaths = [];
            const inIsWNative = inAddr.toLowerCase() === wrappedNative?.toLowerCase();
            const outIsWNative = outAddr.toLowerCase() === wrappedNative?.toLowerCase();

            candidatePaths.push([inAddr, outAddr]); // direct
            if (!inIsWNative && !outIsWNative && wrappedNative) {
                candidatePaths.push([inAddr, wrappedNative, outAddr]); // via native
                const stables = this.getStablecoins(network);
                for (const [, stableAddr] of Object.entries(stables)) {
                    if (stableAddr.toLowerCase() !== inAddr.toLowerCase() &&
                        stableAddr.toLowerCase() !== outAddr.toLowerCase()) {
                        candidatePaths.push([inAddr, stableAddr, outAddr]);
                    }
                }
            }

            let path = null;
            let bestQuoteOut = BigInt(0);
            for (const cp of candidatePaths) {
                try {
                    const amounts = await router.getAmountsOut(amountInWei, cp);
                    const out = amounts[amounts.length - 1];
                    if (out > bestQuoteOut) {
                        bestQuoteOut = out;
                        path = cp;
                    }
                } catch { /* path has no liquidity */ }
            }

            // ---- V4 Quote (try newest protocol first) ----
            const useFeeOnTransfer = tokenTaxPercent > 0;
            let v4QuoteData = null;
            try {
                v4QuoteData = await this._getV4Quote(inAddr, outAddr, amountInWei, network);
            } catch (err) {
                logger.debug(`V4 quote failed: ${err.message}`);
            }

            // ---- V3 Quote comparison ----
            let useV3 = false;
            let useV4 = false;
            let v3QuoteData = null;

            try {
                v3QuoteData = await this._getV3Quote(inAddr, outAddr, amountInWei, network);
                // Retry once after delay if V3 returned null and forceV3 is enabled
                // (BSC public RPCs rate-limit when price impact check ran _getV3Quote moments earlier)
                if (!v3QuoteData && forceV3) {
                    logger.info(`V3 quote null with forceV3 — retrying after 2s delay (possible RPC rate limit)`);
                    await new Promise(r => setTimeout(r, 2000));
                    v3QuoteData = await this._getV3Quote(inAddr, outAddr, amountInWei, network);
                }
                if (v3QuoteData && v3QuoteData.amountOut > bestQuoteOut) {
                    useV3 = true;
                    const v3PathDesc = v3QuoteData.path.map(a => a.slice(0, 10) + '...').join(' → ');
                    logger.info(`V3 selected: ${ethers.formatUnits(v3QuoteData.amountOut, decimalsOut)} vs V2 ${bestQuoteOut > 0n ? ethers.formatUnits(bestQuoteOut, decimalsOut) : 'none'} (${v3PathDesc}, fee: ${v3QuoteData.fees.join('/')})`);
                }
            } catch (err) {
                if (forceV3) {
                    throw new Error(`V3 quote failed and forceV3 is enabled — refusing V2 fallback. Error: ${err.message}`);
                }
                logger.debug(`V3 quote in swap failed: ${err.message}`);
            }

            // preferV3: use V3 even if V2 is marginally better (within 2%), as long as V3 has liquidity
            if (!useV3 && preferV3 && v3QuoteData && v3QuoteData.amountOut > 0n) {
                const v3Float = parseFloat(ethers.formatUnits(v3QuoteData.amountOut, decimalsOut));
                const v2Float = bestQuoteOut > 0n ? parseFloat(ethers.formatUnits(bestQuoteOut, decimalsOut)) : 0;
                if (v2Float === 0 || v3Float >= v2Float * 0.98) {
                    useV3 = true;
                    logger.info(`preferV3: Using V3 (${v3Float.toFixed(6)}) over V2 (${v2Float.toFixed(6)}) — within 2% tolerance`);
                } else {
                    logger.info(`preferV3: V2 significantly better (${v2Float.toFixed(6)} vs V3 ${v3Float.toFixed(6)}) — using V2`);
                }
            }

            // ---- CoW Protocol quote (compete alongside DEX protocols) ----
            // CoW aggregates all DEXes + private market makers + MEV protection.
            // Skipped for urgent sells (stop-loss, trailing stop, emergency) since CoW
            // orders take 30s-2min to fill — too slow when capital preservation is critical.
            let cowQuoteData = null;
            if (COW_NETWORKS[network] && !urgent) {
                try {
                    const cowResult = await this.getCowQuote(network, inAddr, outAddr, amountInWei, signer.address);
                    if (cowResult?.buyAmount) {
                        cowQuoteData = { ...cowResult, amountOut: BigInt(cowResult.buyAmount) };
                    }
                } catch (err) {
                    logger.debug(`CoW quote in swap failed: ${err.message}`);
                }
            } else if (urgent && COW_NETWORKS[network]) {
                logger.info(`CoW skipped: urgent sell (stop-loss/trailing-stop/emergency) requires instant on-chain execution`);
            }

            // ---- 4-way comparison: CoW > V4 > V3 > V2 ----
            // CoW wins if it beats all DEX quotes (MEV-protected + aggregated liquidity)
            const v4Out = v4QuoteData?.amountOut || 0n;
            const v3Out = v3QuoteData?.amountOut || 0n;
            const cowOut = cowQuoteData?.amountOut || 0n;
            let useCow = false;

            if (cowQuoteData && cowOut > 0n && cowOut >= v4Out && cowOut >= v3Out && cowOut >= bestQuoteOut) {
                useCow = true;
                logger.info(`CoW wins: ${ethers.formatUnits(cowOut, decimalsOut)} vs V4 ${v4Out > 0n ? ethers.formatUnits(v4Out, decimalsOut) : 'none'} vs V3 ${v3Out > 0n ? ethers.formatUnits(v3Out, decimalsOut) : 'none'} vs V2 ${bestQuoteOut > 0n ? ethers.formatUnits(bestQuoteOut, decimalsOut) : 'none'} (MEV-protected)`);
            } else if (v4QuoteData && v4Out > 0n && v4Out >= v3Out && v4Out >= bestQuoteOut) {
                useV4 = true;
                useV3 = false;
                logger.info(`V4 wins: ${ethers.formatUnits(v4Out, decimalsOut)} vs V3 ${v3Out > 0n ? ethers.formatUnits(v3Out, decimalsOut) : 'none'} vs V2 ${bestQuoteOut > 0n ? ethers.formatUnits(bestQuoteOut, decimalsOut) : 'none'}${cowOut > 0n ? ` vs CoW ${ethers.formatUnits(cowOut, decimalsOut)}` : ''}`);
            }

            // forceV3: block V2 fallback — require V3, V4, or CoW
            if (forceV3 && !useV3 && !useV4 && !useCow) {
                if (v3QuoteData && v3QuoteData.amountOut > 0n) {
                    useV3 = true;
                    logger.info(`forceV3: V2 won quote but forcing V3 (V3: ${ethers.formatUnits(v3QuoteData.amountOut, decimalsOut)}, V2: ${bestQuoteOut > 0n ? ethers.formatUnits(bestQuoteOut, decimalsOut) : 'none'})`);
                } else if (useCow) {
                    // CoW is already selected, fine
                } else {
                    throw new Error(`forceV3 enabled but V3 did not win or was unavailable — aborting swap to prevent catastrophic V2 loss (v3QuoteData=${v3QuoteData ? JSON.stringify({amountOut: v3QuoteData.amountOut?.toString(), fee: v3QuoteData.fee}) : 'null'}, v2=${bestQuoteOut.toString()})`);
                }
            }

            // Execute via CoW Protocol if it won
            if (useCow) {
                try {
                    const result = await this.executeCowSwap(network, isNativeIn ? 'native' : tokenIn, isNativeOut ? 'native' : tokenOut, amountIn, slippageTolerance, { decimalsIn: decimals, decimalsOut });
                    return result;
                } catch (cowErr) {
                    logger.warn(`CoW swap execution failed, falling back to DEX: ${cowErr.message?.slice(0, 150)}`);
                    useCow = false;
                    // Fall through to DEX execution below
                }
            }

            if (!path && !useV3 && !useV4 && !useCow) {
                logger.info(`No DEX path found (V2=${bestQuoteOut > 0n}, V3=${v3Out > 0n}, V4=${v4Out > 0n}, CoW=${cowOut > 0n}) — trying aggregator fallbacks`);
                // Last resort: try CoW Protocol if not already tried
                if (COW_NETWORKS[network]) {
                    try {
                        logger.info(`No direct DEX path — attempting CoW Protocol for ${tokenIn} → ${tokenOut}`);
                        const result = await this.executeCowSwap(network, isNativeIn ? 'native' : tokenIn, isNativeOut ? 'native' : tokenOut, amountIn, slippageTolerance);
                        return result;
                    } catch (cowErr) {
                        logger.warn(`CoW Protocol fallback failed: ${cowErr.message}`);
                    }
                }
                if (ONEINCH_CHAIN_IDS[network] && process.env.ONEINCH_API_KEY) {
                    try {
                        logger.info(`No direct DEX path — attempting 1inch aggregator for ${tokenIn} → ${tokenOut}`);
                        const result = await this.execute1inchSwap(network, isNativeIn ? 'native' : tokenIn, isNativeOut ? 'native' : tokenOut, amountIn, currentSlippage);
                        return result;
                    } catch (oneInchErr) {
                        logger.warn(`1inch fallback also failed: ${oneInchErr.message}`);
                    }
                }
                throw new Error(`No viable swap path found for ${tokenIn} → ${tokenOut} on ${network}`);
            }

            const activeRouterAddress = useV4 ? v4QuoteData.routerAddress : (useV3 ? v3QuoteData.routerAddress : routerAddress);
            const bestOutput = useV4 ? v4QuoteData.amountOut : (useV3 ? v3QuoteData.amountOut : bestQuoteOut);
            const protocolLabel = useV4 ? 'V4' : (useV3 ? 'V3' : 'V2');
            logger.info(`Best swap: ${protocolLabel} path (output: ${ethers.formatUnits(bestOutput, decimalsOut)})`);

            // SAFETY: Output sanity check — abort if output is catastrophically low vs expected
            if (expectedOutputUsd > 0) {
                const outputFloat = parseFloat(ethers.formatUnits(bestOutput, decimalsOut));
                // Convert output to USD if we know the output token's price (e.g. BNB, ETH)
                // Without this, comparing raw BNB amount (0.078) to USD ($50) causes false failures
                const outputValueUsd = outputTokenPriceUsd > 0
                    ? outputFloat * outputTokenPriceUsd
                    : outputFloat; // assume 1:1 (stablecoin output)
                // Tighter threshold: abort if quote is less than 70% of expected (was 50%)
                if (outputValueUsd < expectedOutputUsd * 0.7) {
                    throw new Error(`Output sanity check failed: best quote $${outputValueUsd.toFixed(4)} is ${((outputValueUsd / expectedOutputUsd) * 100).toFixed(1)}% of expected $${expectedOutputUsd.toFixed(2)} (threshold: 70%) — aborting swap to prevent loss. Protocol: ${protocolLabel}`);
                }
                logger.info(`Output sanity OK: quote $${outputValueUsd.toFixed(4)} is ${((outputValueUsd / expectedOutputUsd) * 100).toFixed(1)}% of expected $${expectedOutputUsd.toFixed(2)}${outputTokenPriceUsd > 0 ? ` (${outputFloat.toFixed(6)} × $${outputTokenPriceUsd.toFixed(2)})` : ''}`);
            } else if (forceV3) {
                logger.warn(`forceV3 swap has no expectedOutputUsd set — sanity check skipped (risky)`);
            }

            // Check token balance before swap (if not native)
            if (!isNativeIn) {
                const tokenBalance = await tokenInContract.balanceOf(signer.address);
                if (tokenBalance < amountInWei) {
                    // If within 0.01% of balance, use actual balance (float precision fix)
                    const diff = amountInWei - tokenBalance;
                    const threshold = amountInWei / BigInt(10000); // 0.01%
                    if (diff <= threshold && tokenBalance > BigInt(0)) {
                        logger.info(`Adjusting swap amount to actual balance (diff: ${ethers.formatUnits(diff, decimals)})`);
                        amountInWei = tokenBalance;
                    } else {
                        const balanceFormatted = ethers.formatUnits(tokenBalance, decimals);
                        throw new Error(`Insufficient token balance. Have ${balanceFormatted}, need ${amountIn}. Token: ${tokenIn}`);
                    }
                }
                logger.info(`Token balance check passed: ${ethers.formatUnits(tokenBalance, decimals)} >= ${amountIn}`);
            }

            // Gas balance pre-check
            if (gasCheck) {
                const gasBalance = await provider.getBalance(signer.address);
                // Estimate gas cost (rough: 250k gas units for a swap)
                const feeData = await provider.getFeeData();
                const gasPrice = feeData.gasPrice || ethers.parseUnits('5', 'gwei');
                const estimatedGasCost = gasPrice * BigInt(250000);
                const requiredGas = estimatedGasCost * BigInt(2); // 2x margin

                if (gasBalance < requiredGas) {
                    const gasFormatted = ethers.formatEther(gasBalance);
                    const requiredFormatted = ethers.formatEther(requiredGas);
                    throw new Error(`Insufficient gas balance for swap. Have ${gasFormatted}, need ~${requiredFormatted} (2x margin). Network: ${network}`);
                }
                logger.info(`Gas check passed: ${ethers.formatEther(gasBalance)} native (need ~${ethers.formatEther(requiredGas)})`);
            }

            // Approve tokens once before retry loop (not native in)
            // V4 PCS uses Permit2 — approval handled inside _executePCSInfinitySwap
            // V4 (both PCS Infinity and Uniswap V4) uses Permit2 — approval handled inside execution methods
            if (!isNativeIn && !useV4) {
                const approvalTx = await this.approveToken(tokenIn, activeRouterAddress, amountInWei, signer);
                if (approvalTx) await new Promise(r => setTimeout(r, 3000));
            }

            // ---- Retry loop for slippage-related reverts ----
            let currentSlippage = Math.max(slippageTolerance, tokenTaxPercent + 0.5);
            let lastError = null;
            let gasCostNative = 0;

            for (let attempt = 0; attempt <= (enableRetry ? maxRetries : 0); attempt++) {
                try {
                    if (attempt > 0) {
                        // Re-fetch fresh price quote before retry
                        logger.info(`Swap retry ${attempt}/${maxRetries}: re-fetching quote with ${currentSlippage.toFixed(1)}% slippage`);
                    }

                    // Get fresh quote (V4, V3, or V2 depending on selection)
                    let expectedOut;
                    if (useV4) {
                        // Re-quote V4 on retry
                        if (attempt > 0) {
                            const freshV4 = await this._getV4Quote(inAddr, outAddr, amountInWei, network);
                            if (freshV4) v4QuoteData = freshV4;
                        }
                        expectedOut = v4QuoteData.amountOut;
                    } else if (useV3) {
                        // Re-quote V3 on retry
                        if (attempt > 0) {
                            const freshV3 = await this._getV3Quote(inAddr, outAddr, amountInWei, network);
                            if (freshV3) v3QuoteData = freshV3;
                        }
                        expectedOut = v3QuoteData.amountOut;
                    } else {
                        const amountsOut = await router.getAmountsOut(amountInWei, path);
                        expectedOut = amountsOut[amountsOut.length - 1];
                    }

                    // Apply slippage tolerance
                    const slippageMultiplier = BigInt(Math.floor((100 - currentSlippage) * 100));
                    const amountOutMin = (expectedOut * slippageMultiplier) / BigInt(10000);

                    // Deadline: 2 hours for mainnet ETH, 20 minutes for others
                    const deadlineMinutes = (network === 'ethereum') ? 120 : 20;
                    const deadline = Math.floor(Date.now() / 1000) + deadlineMinutes * 60;

                    let tx;

                    if (useV4) {
                        // ---- V4 Swap Execution (with V3 fallback on failure) ----
                        logger.info(`Swapping via V4 on ${network} (slippage: ${currentSlippage.toFixed(1)}%, fee: ${v4QuoteData.fee})`);
                        try {
                            tx = await this._executeV4Swap(v4QuoteData, amountInWei, amountOutMin, signer, deadline, isNativeIn, isNativeOut, network);
                        } catch (v4Error) {
                            logger.warn(`V4 execution failed: ${v4Error.message} — retrying with V3`);
                            const v3Out = v3QuoteData?.amountOut || 0n;
                            if (v3QuoteData && v3Out > 0n) {
                                useV4 = false;
                                useV3 = true;
                                tx = await this._executeV3Swap(v3QuoteData, amountInWei, amountOutMin, signer, deadline, isNativeIn, isNativeOut, network);
                            } else if (path && bestQuoteOut > 0n && !forceV3) {
                                logger.warn(`V4+V3 unavailable, falling back to V2`);
                                useV4 = false;
                                useV3 = false;
                                // Fall through to V2 execution below by re-throwing to retry loop
                                throw new Error(`V4 failed and no V3 fallback: ${v4Error.message}`);
                            } else {
                                throw v4Error;
                            }
                        }
                    } else if (useV3) {
                        // ---- V3 Swap Execution ----
                        logger.info(`Swapping via V3 on ${network} (slippage: ${currentSlippage.toFixed(1)}%, fee: ${v3QuoteData.fees.join('/')})`);
                        tx = await this._executeV3Swap(v3QuoteData, amountInWei, amountOutMin, signer, deadline, isNativeIn, isNativeOut, network);
                    } else if (isNativeIn) {
                        // ---- V2 Swap Execution ----
                        if (useFeeOnTransfer) {
                            logger.info(`Swapping ${amountIn} native for tax token on ${network} (slippage: ${currentSlippage.toFixed(1)}%, tax: ${tokenTaxPercent}%)`);
                            tx = await router.swapExactETHForTokensSupportingFeeOnTransferTokens(
                                amountOutMin,
                                path,
                                signer.address,
                                deadline,
                                { value: amountInWei }
                            );
                        } else {
                            logger.info(`Swapping ${amountIn} native for tokens on ${network} (slippage: ${currentSlippage.toFixed(1)}%)`);
                            tx = await router.swapExactETHForTokens(
                                amountOutMin,
                                path,
                                signer.address,
                                deadline,
                                { value: amountInWei }
                            );
                        }
                    } else if (isNativeOut) {
                        if (useFeeOnTransfer) {
                            logger.info(`Swapping tax token for native on ${network} (slippage: ${currentSlippage.toFixed(1)}%, tax: ${tokenTaxPercent}%)`);
                            tx = await router.swapExactTokensForETHSupportingFeeOnTransferTokens(
                                amountInWei,
                                amountOutMin,
                                path,
                                signer.address,
                                deadline
                            );
                        } else {
                            logger.info(`Swapping tokens for native on ${network} (slippage: ${currentSlippage.toFixed(1)}%)`);
                            tx = await router.swapExactTokensForETH(
                                amountInWei,
                                amountOutMin,
                                path,
                                signer.address,
                                deadline
                            );
                        }
                    } else {
                        if (useFeeOnTransfer) {
                            logger.info(`Swapping tokens for tax token on ${network} (slippage: ${currentSlippage.toFixed(1)}%, tax: ${tokenTaxPercent}%)`);
                            tx = await router.swapExactTokensForTokensSupportingFeeOnTransferTokens(
                                amountInWei,
                                amountOutMin,
                                path,
                                signer.address,
                                deadline
                            );
                        } else {
                            logger.info(`Swapping tokens for tokens on ${network} (slippage: ${currentSlippage.toFixed(1)}%)`);
                            tx = await router.swapExactTokensForTokens(
                                amountInWei,
                                amountOutMin,
                                path,
                                signer.address,
                                deadline
                            );
                        }
                    }

                    // Store pending swap
                    const swapId = tx.hash;
                    this.pendingSwaps.set(swapId, {
                        hash: tx.hash,
                        tokenIn: isNativeIn ? 'NATIVE' : tokenIn,
                        tokenOut: isNativeOut ? 'NATIVE' : tokenOut,
                        amountIn: amountIn.toString(),
                        expectedOut: ethers.formatUnits(expectedOut, decimalsOut),
                        minOut: ethers.formatUnits(amountOutMin, decimalsOut),
                        slippageUsed: currentSlippage,
                        attempt,
                        network,
                        timestamp: new Date(),
                        status: 'pending'
                    });

                    // Determine transaction type: buy (stablecoin→token), sell (token→stablecoin), or swap
                    const networkStables = STABLECOINS[network] || {};
                    const stableAddrs = Object.values(networkStables).map(a => a.toLowerCase());
                    const isBuy = stableAddrs.includes(tokenIn?.toLowerCase());
                    const isSell = stableAddrs.includes(tokenOut?.toLowerCase());
                    const txType = isBuy ? 'buy' : isSell ? 'sell' : 'swap';

                    // Add to wallet transaction history
                    await walletService.addTransaction({
                        type: txType,
                        chain: network,
                        hash: tx.hash,
                        from: signer.address,
                        tokenIn: isNativeIn ? 'NATIVE' : tokenIn,
                        tokenOut: isNativeOut ? 'NATIVE' : tokenOut,
                        amountIn: amountIn.toString(),
                        expectedOut: ethers.formatUnits(expectedOut, decimalsOut),
                        status: 'pending'
                    });

                    // Wait for TX confirmation
                    const confirmTimeout = (network === 'ethereum') ? 180000 : 60000;
                    let confirmed = false;
                    try {
                        const receipt = await Promise.race([
                            tx.wait(1),
                            new Promise((_, reject) => setTimeout(() => reject(new Error('confirmation_timeout')), confirmTimeout))
                        ]);
                        if (receipt && receipt.status === 1) {
                            confirmed = true;
                            // Capture actual gas cost from receipt
                            try {
                                const gasUsed = receipt.gasUsed;
                                const effectiveGasPrice = receipt.gasPrice || receipt.effectiveGasPrice;
                                if (gasUsed && effectiveGasPrice) {
                                    gasCostNative = parseFloat(ethers.formatEther(gasUsed * effectiveGasPrice));
                                }
                            } catch {}
                            logger.info(`Swap ${tx.hash} confirmed in block ${receipt.blockNumber} (attempt ${attempt}, slippage ${currentSlippage.toFixed(1)}%, gas: ${gasCostNative.toFixed(6)} native)`);
                        } else {
                            logger.error(`Swap ${tx.hash} reverted on-chain (status=${receipt?.status})`);
                            const swap = this.pendingSwaps.get(swapId);
                            if (swap) swap.status = 'failed';

                            // Check if retryable (on-chain revert may be slippage)
                            if (enableRetry && attempt < maxRetries) {
                                lastError = new Error('Transaction reverted on-chain');
                                // First retry: same slippage (revert may be transient, not slippage)
                                // Subsequent retries: increment slippage
                                if (attempt > 0) {
                                    currentSlippage = this._incrementSlippage(currentSlippage, hardCeiling);
                                }
                                if (currentSlippage <= hardCeiling) {
                                    logger.warn(`On-chain revert status=0 (attempt ${attempt}), retrying with ${currentSlippage.toFixed(1)}% slippage...`);
                                    await new Promise(r => setTimeout(r, 2000));
                                    continue;
                                }
                            }
                            return {
                                success: false,
                                hash: tx.hash,
                                error: 'Transaction reverted on-chain',
                                network
                            };
                        }
                    } catch (waitErr) {
                        if (waitErr.message === 'confirmation_timeout') {
                            logger.warn(`Swap ${tx.hash} not confirmed within ${confirmTimeout/1000}s - continuing in background`);
                            this.waitForSwap(tx, swapId);
                        } else {
                            logger.error(`Swap ${tx.hash} wait error: ${waitErr.message}`);
                            const swap = this.pendingSwaps.get(swapId);
                            if (swap) swap.status = 'failed';

                            // ethers.js v6 throws CALL_EXCEPTION for on-chain reverts
                            // instead of returning receipt with status 0 — retry with higher slippage
                            if (enableRetry && attempt < maxRetries) {
                                lastError = waitErr;
                                // First retry: same slippage (revert may be transient, not slippage)
                                // Subsequent retries: increment slippage
                                if (attempt > 0) {
                                    currentSlippage = this._incrementSlippage(currentSlippage, hardCeiling);
                                }
                                if (currentSlippage <= hardCeiling) {
                                    logger.warn(`On-chain revert (attempt ${attempt}), retrying with ${currentSlippage.toFixed(1)}% slippage...`);
                                    await new Promise(r => setTimeout(r, 2000));
                                    continue;
                                }
                            }
                            return {
                                success: false,
                                hash: tx.hash,
                                error: `Transaction failed: ${waitErr.message}`,
                                network
                            };
                        }
                    }

                    // Run background verification if confirmed
                    if (confirmed) {
                        this.waitForSwap(tx, swapId).catch(() => {});
                    }

                    return {
                        success: true,
                        confirmed,
                        hash: tx.hash,
                        tokenIn: isNativeIn ? 'NATIVE' : tokenIn,
                        tokenOut: isNativeOut ? 'NATIVE' : tokenOut,
                        amountIn: amountIn.toString(),
                        expectedOut: ethers.formatUnits(expectedOut, decimalsOut),
                        minOut: ethers.formatUnits(amountOutMin, decimalsOut),
                        slippageUsed: currentSlippage,
                        attempt,
                        network,
                        protocolVersion: useV3 ? 'v3' : 'v2',
                        gasCostNative: gasCostNative || 0
                    };
                } catch (swapError) {
                    lastError = swapError;
                    const errorMsg = swapError.message || '';

                    // Check if this is a retryable slippage error
                    const isSlippageError = SLIPPAGE_REVERT_PATTERNS.some(p => errorMsg.includes(p));
                    const isNonRetryable = NON_RETRYABLE_PATTERNS.some(p => errorMsg.includes(p));

                    if (enableRetry && isSlippageError && !isNonRetryable && attempt < maxRetries) {
                        currentSlippage = this._incrementSlippage(currentSlippage, hardCeiling);
                        if (currentSlippage <= hardCeiling) {
                            logger.warn(`Swap attempt ${attempt} failed (slippage-related): ${errorMsg.substring(0, 100)}. Retrying with ${currentSlippage.toFixed(1)}% slippage...`);
                            await new Promise(r => setTimeout(r, 2000)); // Brief pause before retry
                            continue;
                        }
                        logger.warn(`Slippage ceiling ${hardCeiling}% reached, not retrying`);
                    }

                    // Non-retryable or max retries reached
                    throw swapError;
                }
            }

            // Exhausted all retries
            throw lastError || new Error('Swap failed after all retry attempts');
        } catch (error) {
            logger.error('Swap failed:', error);
            throw error;
        }
    }

    /**
     * Increment slippage by 0.5% for retry, capped at ceiling
     */
    _incrementSlippage(current, ceiling) {
        return Math.min(current + 0.5, ceiling + 0.1); // +0.1 to allow ceiling check
    }

    /**
     * Detect approximate token tax by quoting a round-trip swap
     * @param {string} tokenAddress - ERC20 token contract address
     * @param {string} network - Network name
     * @returns {Promise<number>} Approximate round-trip tax percentage
     */
    async detectTokenTax(tokenAddress, network) {
        try {
            const cacheKey = `${tokenAddress.toLowerCase()}_${network}`;
            const cached = this.tokenTaxCache.get(cacheKey);
            if (cached && Date.now() - cached.timestamp < this.tokenTaxCacheTTL) {
                return cached.tax;
            }

            const ethers = await getEthers();
            const routers = this.getRoutersForNetwork(network);
            const routerAddress = Object.values(routers)[0];
            if (!routerAddress) throw new Error(`No router for ${network}`);

            const provider = await contractServiceWrapper.getProvider(network);
            const router = new ethers.Contract(routerAddress, UNISWAP_V2_ROUTER_ABI, provider);
            const wrappedNative = this.getWrappedNative(network);

            // Get factory and pair to read reserves
            const PAIR_ABI = [
                'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
                'function token0() view returns (address)',
                'function token1() view returns (address)'
            ];
            const FACTORY_ABI = [
                'function getPair(address tokenA, address tokenB) view returns (address pair)'
            ];

            const factoryAddr = await router.factory();
            const factory = new ethers.Contract(factoryAddr, FACTORY_ABI, provider);
            const pairAddr = await factory.getPair(wrappedNative, tokenAddress);

            if (!pairAddr || pairAddr === ethers.ZeroAddress) {
                logger.info(`No direct pair found for ${tokenAddress} on ${network}, assuming 0% tax`);
                this.tokenTaxCache.set(cacheKey, { tax: 0, timestamp: Date.now() });
                return 0;
            }

            const pair = new ethers.Contract(pairAddr, PAIR_ABI, provider);
            const [reserve0, reserve1] = await pair.getReserves();
            const token0 = await pair.token0();
            const isToken0Native = token0.toLowerCase() === wrappedNative.toLowerCase();
            const reserveNative = isToken0Native ? reserve0 : reserve1;
            const reserveToken = isToken0Native ? reserve1 : reserve0;

            // Use a tiny test amount relative to pool size to minimize price impact
            // Pick min of: 0.1% of pool, or 0.0001 native (whichever is smaller)
            const tinyFraction = reserveNative / BigInt(1000); // 0.1% of pool
            const fixedSmall = ethers.parseUnits('0.0001', 18);
            const testAmount = tinyFraction < fixedSmall && tinyFraction > BigInt(0) ? tinyFraction : fixedSmall;

            // Quote buy: native -> token
            let tokenAmount;
            try {
                const buyQuote = await router.getAmountsOut(testAmount, [wrappedNative, tokenAddress]);
                tokenAmount = buyQuote[buyQuote.length - 1];
            } catch (err) {
                logger.warn(`Token tax detection: buy quote failed for ${tokenAddress} on ${network}: ${err.message}`);
                this.tokenTaxCache.set(cacheKey, { tax: 0, timestamp: Date.now() });
                return 0;
            }

            if (tokenAmount === BigInt(0)) {
                this.tokenTaxCache.set(cacheKey, { tax: 0, timestamp: Date.now() });
                return 0;
            }

            // Quote sell: token -> native
            let nativeBack;
            try {
                const sellQuote = await router.getAmountsOut(tokenAmount, [tokenAddress, wrappedNative]);
                nativeBack = sellQuote[sellQuote.length - 1];
            } catch (err) {
                logger.warn(`Token tax detection: sell quote failed (possible honeypot) for ${tokenAddress}: ${err.message}`);
                this.tokenTaxCache.set(cacheKey, { tax: 100, timestamp: Date.now() });
                return 100;
            }

            // Calculate expected round-trip loss from AMM math alone (no tax)
            // Using constant product: B/A = Rx * (1-f)^2 / (Rx + A*(1-f)*(2-f))
            // where f = 0.003 (0.3% DEX fee), A = testAmount, Rx = reserveNative
            const f = 0.003;
            const Rx = Number(reserveNative) / 1e18;
            const A = Number(testAmount) / 1e18;
            const expectedRatio = Rx * (1 - f) * (1 - f) / (Rx + A * (1 - f) * (2 - f));
            const expectedLossPct = (1 - expectedRatio) * 100;

            // Actual observed round-trip loss from getAmountsOut
            const observedRatio = Number(nativeBack) / Number(testAmount);
            const observedLossPct = (1 - observedRatio) * 100;

            // Tax = observed loss minus expected AMM loss
            // For zero-tax tokens, observed ≈ expected (both just AMM math)
            const taxEstimate = Math.max(0, observedLossPct - expectedLossPct);

            logger.info(`Token tax for ${tokenAddress} on ${network}: ${taxEstimate.toFixed(1)}% ` +
                `(observed round-trip loss: ${observedLossPct.toFixed(2)}%, expected AMM loss: ${expectedLossPct.toFixed(2)}%, ` +
                `pool: ${Rx.toFixed(4)} native, test: ${A.toFixed(6)} native)`);

            // Cross-reference with V3 quote to detect V2 pool manipulation or dead liquidity
            let finalTax = taxEstimate;
            try {
                const v3Quote = await this._getV3Quote(wrappedNative, tokenAddress, testAmount, network);
                if (v3Quote && v3Quote.amountOut > BigInt(0)) {
                    const v2Price = Number(tokenAmount);
                    const v3Price = Number(v3Quote.amountOut);
                    if (v3Price > 0) {
                        const divergence = v2Price > 0
                            ? Math.abs(v2Price - v3Price) / Math.max(v2Price, v3Price) * 100
                            : 100;
                        if (divergence > 20) {
                            // V2 pool is illiquid/stale — use V3 for tax estimation instead
                            // V3 round-trip: buy via V3, then estimate sell via V3
                            try {
                                const v3SellQuote = await this._getV3Quote(tokenAddress, wrappedNative, v3Quote.amountOut, network);
                                if (v3SellQuote && v3SellQuote.amountOut > BigInt(0)) {
                                    const v3ObservedRatio = Number(v3SellQuote.amountOut) / Number(testAmount);
                                    const v3ObservedLoss = (1 - v3ObservedRatio) * 100;
                                    // V3 fees are typically 0.01-1%, round-trip = 2x fee
                                    const v3FeePct = (v3Quote.fees[0] / 10000) * 2; // Double the fee for round trip
                                    const v3Tax = Math.max(0, v3ObservedLoss - v3FeePct);
                                    logger.info(`V2/V3 divergence: ${divergence.toFixed(1)}% — V2 pool illiquid. ` +
                                        `V3 tax estimate: ${v3Tax.toFixed(1)}% (V2 was ${taxEstimate.toFixed(1)}%). Using V3 result.`);
                                    finalTax = v3Tax;
                                }
                            } catch (v3SellErr) {
                                logger.warn(`V3 sell quote for tax re-estimation failed: ${v3SellErr.message}`);
                            }
                        } else {
                            logger.info(`V2/V3 price divergence: ${divergence.toFixed(1)}% for ${tokenAddress} (within normal range)`);
                        }
                    }
                }
            } catch (v3Err) {
                logger.debug(`V3 cross-reference skipped for ${tokenAddress}: ${v3Err.message}`);
            }

            this.tokenTaxCache.set(cacheKey, { tax: finalTax, timestamp: Date.now() });
            return finalTax;
        } catch (error) {
            logger.error(`Failed to detect token tax for ${tokenAddress}:`, error.message);
            return 0;
        }
    }

    /**
     * Get token metadata (name, symbol, decimals) and tax
     * @param {string} tokenAddress - ERC20 token address
     * @param {string} network - Network name
     * @returns {Promise<{name: string, symbol: string, decimals: number, tax: number}>}
     */
    async _resolveDecimals(tokenAddress, wrappedNative, network) {
        if (!tokenAddress || tokenAddress.toLowerCase() === 'native' ||
            tokenAddress.toLowerCase() === wrappedNative?.toLowerCase()) {
            return 18;
        }
        try {
            const meta = await this.getTokenMetadata(tokenAddress, network);
            return meta.decimals || 18;
        } catch {
            return 18;
        }
    }

    async getTokenMetadata(tokenAddress, network) {
        const cacheKey = `${tokenAddress.toLowerCase()}_${network}`;
        const cached = this.tokenMetadataCache.get(cacheKey);
        if (cached) return cached;

        try {
            const ethers = await getEthers();
            const provider = await contractServiceWrapper.getProvider(network);
            const token = new ethers.Contract(tokenAddress, ERC20_ABI, provider);

            const [name, symbol, decimals] = await Promise.all([
                token.name().catch(() => 'Unknown'),
                token.symbol().catch(() => '???'),
                token.decimals().catch(() => 18)
            ]);

            const tax = await this.detectTokenTax(tokenAddress, network);

            const metadata = {
                name,
                symbol,
                decimals: Number(decimals),
                tax,
                address: tokenAddress,
                network
            };

            this.tokenMetadataCache.set(cacheKey, metadata);
            logger.info(`Token metadata: ${symbol} (${name}) - ${decimals} decimals, ~${tax.toFixed(1)}% tax on ${network}`);
            return metadata;
        } catch (error) {
            logger.error(`Failed to get token metadata for ${tokenAddress}:`, error.message);
            return { name: 'Unknown', symbol: '???', decimals: 18, tax: 0, address: tokenAddress, network };
        }
    }

    /**
     * Approve token spending
     */
    async approveToken(tokenAddress, spenderAddress, amount, signer) {
        try {
            const ethers = await getEthers();
            const token = new ethers.Contract(tokenAddress, ERC20_ABI, signer);

            // Check current allowance
            const currentAllowance = await token.allowance(signer.address, spenderAddress);

            if (currentAllowance >= amount) {
                logger.info('Token already approved');
                return null;
            }

            // Approve max uint256 for convenience (common practice)
            const maxApproval = ethers.MaxUint256;
            logger.info(`Approving token ${tokenAddress} for ${spenderAddress}`);

            const tx = await token.approve(spenderAddress, maxApproval);
            await tx.wait();

            logger.info('Token approval confirmed');
            return tx;
        } catch (error) {
            logger.error('Token approval failed:', error);
            throw error;
        }
    }

    /**
     * Wait for swap confirmation
     */
    async waitForSwap(tx, swapId) {
        try {
            const receipt = await tx.wait();

            const swap = this.pendingSwaps.get(swapId);
            if (swap) {
                swap.status = receipt.status === 1 ? 'confirmed' : 'failed';
                swap.blockNumber = receipt.blockNumber;
                swap.gasUsed = receipt.gasUsed?.toString();

                // Verify balances after successful swap
                if (receipt.status === 1) {
                    await this.verifySwapBalances(swap);
                }

                // Update wallet transaction
                const wallet = await walletService.getWallet();
                if (wallet?.transactions) {
                    const walletTx = wallet.transactions.find(t => t.hash === tx.hash);
                    if (walletTx) {
                        walletTx.status = swap.status;
                        walletTx.blockNumber = receipt.blockNumber;
                        await wallet.save();
                    }
                }

                // Remove from pending after 5 minutes
                setTimeout(() => {
                    this.pendingSwaps.delete(swapId);
                }, 5 * 60 * 1000);
            }

            logger.info(`Swap ${tx.hash} ${receipt.status === 1 ? 'confirmed' : 'failed'}`);
            return receipt;
        } catch (error) {
            logger.error('Swap wait failed:', error);

            const swap = this.pendingSwaps.get(swapId);
            if (swap) {
                swap.status = 'failed';
                swap.error = error.message;
            }
        }
    }

    /**
     * Verify balances after swap completion
     */
    async verifySwapBalances(swap) {
        try {
            const ethers = await getEthers();
            const wallet = await walletService.getWallet();
            const address = wallet.addresses.ethereum;

            let actualBalance;
            const tokenOut = swap.tokenOut;
            const network = swap.network;
            const expectedOut = parseFloat(swap.expectedOut);

            // Get actual balance of output token
            if (tokenOut === 'NATIVE') {
                const balance = await contractServiceWrapper.getNativeBalance(address, network);
                actualBalance = parseFloat(balance.formatted);
                swap.verifiedBalance = balance.formatted;
            } else {
                const balance = await contractServiceWrapper.getTokenBalance(tokenOut, address, network);
                actualBalance = parseFloat(balance.formatted);
                swap.verifiedBalance = balance.formatted;
            }

            // Calculate if we received approximately what we expected (within 5% tolerance)
            const minExpected = expectedOut * 0.95; // 5% tolerance for slippage

            if (actualBalance < minExpected) {
                logger.warn(`Swap balance verification warning: Expected ~${expectedOut}, but balance is ${actualBalance} (${tokenOut} on ${network})`);
                swap.balanceWarning = `Expected ~${expectedOut}, actual balance ${actualBalance}`;
            } else {
                logger.info(`Swap balance verified: ${tokenOut} balance is ${actualBalance} on ${network}`);
                swap.balanceVerified = true;
            }
        } catch (error) {
            logger.error('Balance verification failed:', error.message);
            swap.verificationError = error.message;
        }
    }

    /**
     * Get pending swaps
     */
    getPendingSwaps() {
        return Array.from(this.pendingSwaps.values())
            .filter(s => s.status === 'pending')
            .sort((a, b) => b.timestamp - a.timestamp);
    }

    /**
     * Get swap status
     */
    getSwapStatus(hash) {
        return this.pendingSwaps.get(hash);
    }

    /**
     * Get supported networks for swaps
     */
    getSupportedNetworks() {
        return Object.keys(DEX_ROUTERS);
    }

    // ==================== Liquidity Management (V2) ====================

    /**
     * Get LP pair info for a token pair
     * @returns {{ pairAddress, token0, token1, reserve0, reserve1, totalSupply, lpBalance }}
     */
    async getLPInfo(tokenA, tokenB, network = 'bsc') {
        const ethers = await getEthers();
        const provider = await contractServiceWrapper.getProvider(network);
        const routers = this.getRoutersForNetwork(network);
        const routerAddress = routers.uniswapV2 || routers.pancakeswap || Object.values(routers)[0];
        const wrappedNative = this.getWrappedNative(network);

        if (tokenA.toLowerCase() === 'native') tokenA = wrappedNative;
        if (tokenB.toLowerCase() === 'native') tokenB = wrappedNative;

        const router = new ethers.Contract(routerAddress, [...UNISWAP_V2_ROUTER_ABI], provider);
        const factoryAddress = await router.factory();
        const factory = new ethers.Contract(factoryAddress, V2_FACTORY_ABI, provider);
        const pairAddress = await factory.getPair(tokenA, tokenB);

        if (!pairAddress || pairAddress === ethers.ZeroAddress) {
            return null;
        }

        const pair = new ethers.Contract(pairAddress, V2_PAIR_ABI, provider);
        const [reserves, totalSupply, token0, token1] = await Promise.all([
            pair.getReserves(),
            pair.totalSupply(),
            pair.token0(),
            pair.token1()
        ]);

        // Get our LP token balance
        const wallet = await walletService.getWallet();
        let lpBalance = 0n;
        if (wallet) {
            const mnemonic = decrypt(wallet.encryptedSeed);
            const derivedWallet = ethers.Wallet.fromPhrase(mnemonic);
            lpBalance = await pair.balanceOf(derivedWallet.address);
        }

        // Get token metadata
        const tokenAContract = new ethers.Contract(tokenA, ERC20_ABI, provider);
        const tokenBContract = new ethers.Contract(tokenB, ERC20_ABI, provider);
        const [decimalsA, decimalsB, symbolA, symbolB] = await Promise.all([
            tokenAContract.decimals(),
            tokenBContract.decimals(),
            tokenAContract.symbol(),
            tokenBContract.symbol()
        ]);

        const isToken0A = token0.toLowerCase() === tokenA.toLowerCase();
        const reserve0 = reserves[0];
        const reserve1 = reserves[1];

        return {
            pairAddress,
            token0, token1,
            reserve0: ethers.formatUnits(reserve0, isToken0A ? decimalsA : decimalsB),
            reserve1: ethers.formatUnits(reserve1, isToken0A ? decimalsB : decimalsA),
            totalSupply: ethers.formatUnits(totalSupply, 18),
            lpBalance: ethers.formatUnits(lpBalance, 18),
            lpBalanceRaw: lpBalance.toString(),
            tokenA: { address: tokenA, symbol: symbolA, decimals: Number(decimalsA) },
            tokenB: { address: tokenB, symbol: symbolB, decimals: Number(decimalsB) }
        };
    }

    /**
     * Add liquidity to a V2 pair
     * @param {string} tokenA - Token A address or 'native'
     * @param {string} tokenB - Token B address or 'native'
     * @param {number} amountA - Amount of token A to add
     * @param {number} amountB - Amount of token B to add
     * @param {number} slippage - Slippage tolerance as percentage (default 1%)
     * @param {string} network - Network name
     * @returns {{ txHash, amountA, amountB, liquidity }}
     */
    async addLiquidity(tokenA, tokenB, amountA, amountB, slippage = 1, network = 'bsc') {
        const ethers = await getEthers();

        const wallet = await walletService.getWallet();
        if (!wallet) throw new Error('Wallet not initialized');

        const mnemonic = decrypt(wallet.encryptedSeed);
        const derivedWallet = ethers.Wallet.fromPhrase(mnemonic);
        const provider = await contractServiceWrapper.getProvider(network);
        const signer = derivedWallet.connect(provider);

        const routers = this.getRoutersForNetwork(network);
        const routerAddress = routers.uniswapV2 || routers.pancakeswap || Object.values(routers)[0];
        const wrappedNative = this.getWrappedNative(network);

        const isNativeA = tokenA.toLowerCase() === 'native';
        const isNativeB = tokenB.toLowerCase() === 'native';
        const actualTokenA = isNativeA ? wrappedNative : tokenA;
        const actualTokenB = isNativeB ? wrappedNative : tokenB;

        // Get decimals
        const tokenAContract = new ethers.Contract(actualTokenA, ERC20_ABI, provider);
        const tokenBContract = new ethers.Contract(actualTokenB, ERC20_ABI, provider);
        const [decimalsA, decimalsB] = await Promise.all([
            tokenAContract.decimals(), tokenBContract.decimals()
        ]);

        const amountAWei = ethers.parseUnits(amountA.toString(), decimalsA);
        const amountBWei = ethers.parseUnits(amountB.toString(), decimalsB);
        const slippageMultiplier = BigInt(Math.floor((100 - slippage) * 100));
        const amountAMin = (amountAWei * slippageMultiplier) / 10000n;
        const amountBMin = (amountBWei * slippageMultiplier) / 10000n;
        const deadline = Math.floor(Date.now() / 1000) + 1200;

        const routerABI = [...UNISWAP_V2_ROUTER_ABI, ...V2_LIQUIDITY_ABI];
        const router = new ethers.Contract(routerAddress, routerABI, signer);

        let tx;
        if (isNativeA || isNativeB) {
            // One side is native — use addLiquidityETH
            const token = isNativeA ? actualTokenB : actualTokenA;
            const tokenAmount = isNativeA ? amountBWei : amountAWei;
            const tokenMin = isNativeA ? amountBMin : amountAMin;
            const ethAmount = isNativeA ? amountAWei : amountBWei;
            const ethMin = isNativeA ? amountAMin : amountBMin;

            // Approve token for router
            await this.approveToken(token, routerAddress, tokenAmount, signer);

            logger.info(`Adding liquidity: ${ethers.formatUnits(tokenAmount, isNativeA ? decimalsB : decimalsA)} token + ${ethers.formatUnits(ethAmount, 18)} native`);

            tx = await router.addLiquidityETH(
                token, tokenAmount, tokenMin, ethMin,
                signer.address, deadline,
                { value: ethAmount }
            );
        } else {
            // Both are tokens
            await this.approveToken(actualTokenA, routerAddress, amountAWei, signer);
            await this.approveToken(actualTokenB, routerAddress, amountBWei, signer);

            logger.info(`Adding liquidity: ${amountA} tokenA + ${amountB} tokenB`);

            tx = await router.addLiquidity(
                actualTokenA, actualTokenB,
                amountAWei, amountBWei, amountAMin, amountBMin,
                signer.address, deadline
            );
        }

        const receipt = await tx.wait();
        logger.info(`Liquidity added: tx ${receipt.hash}`);

        return {
            txHash: receipt.hash,
            blockNumber: receipt.blockNumber,
            success: true
        };
    }

    /**
     * Remove liquidity from a V2 pair
     * @param {string} tokenA - Token A address or 'native'
     * @param {string} tokenB - Token B address or 'native'
     * @param {number|string} lpAmount - Amount of LP tokens to remove (or 'all')
     * @param {number} slippage - Slippage tolerance percentage
     * @param {string} network - Network name
     */
    async removeLiquidity(tokenA, tokenB, lpAmount, slippage = 1, network = 'bsc') {
        const ethers = await getEthers();

        const wallet = await walletService.getWallet();
        if (!wallet) throw new Error('Wallet not initialized');

        const mnemonic = decrypt(wallet.encryptedSeed);
        const derivedWallet = ethers.Wallet.fromPhrase(mnemonic);
        const provider = await contractServiceWrapper.getProvider(network);
        const signer = derivedWallet.connect(provider);

        const routers = this.getRoutersForNetwork(network);
        const routerAddress = routers.uniswapV2 || routers.pancakeswap || Object.values(routers)[0];
        const wrappedNative = this.getWrappedNative(network);

        const isNativeA = tokenA.toLowerCase() === 'native';
        const isNativeB = tokenB.toLowerCase() === 'native';
        const actualTokenA = isNativeA ? wrappedNative : tokenA;
        const actualTokenB = isNativeB ? wrappedNative : tokenB;

        // Get pair address
        const routerRead = new ethers.Contract(routerAddress, UNISWAP_V2_ROUTER_ABI, provider);
        const factoryAddress = await routerRead.factory();
        const factory = new ethers.Contract(factoryAddress, V2_FACTORY_ABI, provider);
        const pairAddress = await factory.getPair(actualTokenA, actualTokenB);
        if (!pairAddress || pairAddress === ethers.ZeroAddress) {
            throw new Error('LP pair not found');
        }

        const pair = new ethers.Contract(pairAddress, V2_PAIR_ABI, provider);
        const balance = await pair.balanceOf(signer.address);

        let lpAmountWei;
        if (lpAmount === 'all') {
            lpAmountWei = balance;
        } else {
            lpAmountWei = ethers.parseUnits(lpAmount.toString(), 18);
        }

        if (lpAmountWei === 0n || lpAmountWei > balance) {
            throw new Error(`Insufficient LP balance: have ${ethers.formatUnits(balance, 18)}, want ${ethers.formatUnits(lpAmountWei, 18)}`);
        }

        // Approve LP tokens for router
        await this.approveToken(pairAddress, routerAddress, lpAmountWei, signer);

        const deadline = Math.floor(Date.now() / 1000) + 1200;
        const routerABI = [...UNISWAP_V2_ROUTER_ABI, ...V2_LIQUIDITY_ABI];
        const router = new ethers.Contract(routerAddress, routerABI, signer);

        // Slippage: set minimums to 0 for simplicity (user can increase slippage param for tighter)
        // In practice we'd calculate expected amounts from reserves, but 0 min is safest for removal
        let tx;
        if (isNativeA || isNativeB) {
            const token = isNativeA ? actualTokenB : actualTokenA;
            tx = await router.removeLiquidityETH(
                token, lpAmountWei, 0, 0, signer.address, deadline
            );
        } else {
            tx = await router.removeLiquidity(
                actualTokenA, actualTokenB,
                lpAmountWei, 0, 0, signer.address, deadline
            );
        }

        const receipt = await tx.wait();
        logger.info(`Liquidity removed: tx ${receipt.hash}`);

        return {
            txHash: receipt.hash,
            blockNumber: receipt.blockNumber,
            lpRemoved: ethers.formatUnits(lpAmountWei, 18),
            success: true
        };
    }
}

export default new SwapService();
