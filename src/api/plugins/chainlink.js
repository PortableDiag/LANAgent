import { BasePlugin } from '../core/basePlugin.js';
import { logger } from '../../utils/logger.js';
import contractService from '../../services/crypto/contractService.js';
import faucetService from '../../services/crypto/faucetService.js';
import walletService from '../../services/crypto/walletService.js';
import axios from 'axios';

// Symbol → CoinGecko ID mapping for common tokens
const SYMBOL_TO_COINGECKO = {
    BTC: 'bitcoin', ETH: 'ethereum', BNB: 'binancecoin', SOL: 'solana',
    ADA: 'cardano', XRP: 'ripple', DOGE: 'dogecoin', DOT: 'polkadot',
    LINK: 'chainlink', AVAX: 'avalanche-2', MATIC: 'matic-network',
    UNI: 'uniswap', AAVE: 'aave', ATOM: 'cosmos', LTC: 'litecoin',
    FIL: 'filecoin', NEAR: 'near', ARB: 'arbitrum', OP: 'optimism',
    MKR: 'maker', COMP: 'compound-governance-token', CRV: 'curve-dao-token',
    SNX: 'havven', SUSHI: 'sushi', YFI: 'yearn-finance', CAKE: 'pancakeswap-token',
    SHIB: 'shiba-inu', PEPE: 'pepe', USDT: 'tether', USDC: 'usd-coin',
    DAI: 'dai', WBTC: 'wrapped-bitcoin', STETH: 'staked-ether',
    APE: 'apecoin', SAND: 'the-sandbox', MANA: 'decentraland',
    AXS: 'axie-infinity', ENS: 'ethereum-name-service', LDO: 'lido-dao',
    IMX: 'immutable-x', RNDR: 'render-token', INJ: 'injective-protocol',
    FTM: 'fantom', ALGO: 'algorand', HBAR: 'hedera-hashgraph',
    VET: 'vechain', XLM: 'stellar', EOS: 'eos', THETA: 'theta-token',
    ICP: 'internet-computer', FLR: 'flare-networks', EGLD: 'elrond-erd-2',
    TRX: 'tron', TON: 'the-open-network', SUI: 'sui', SEI: 'sei-network',
    APT: 'aptos', TIA: 'celestia', JUP: 'jupiter-exchange-solana',
    WIF: 'dogwifcoin', BONK: 'bonk', FLOKI: 'floki', WLD: 'worldcoin-wld',
    PYTH: 'pyth-network', JTO: 'jito-governance-token', STRK: 'starknet',
    ONDO: 'ondo-finance', PENDLE: 'pendle', W: 'wormhole',
    GALA: 'gala', BLUR: 'blur', FET: 'fetch-ai', OCEAN: 'ocean-protocol',
    GRT: 'the-graph', AR: 'arweave', ROSE: 'oasis-network',
    KAS: 'kaspa', RUNE: 'thorchain', CKB: 'nervos-network',
    MINA: 'mina-protocol', ZK: 'zksync', BOME: 'book-of-meme',
    SKYNET: 'skynet-token'  // Our token
};

// Chainlink Price Feed addresses for different networks
const CHAINLINK_FEEDS = {
    // Mainnet feeds — Ethereum
    ethereum: {
        'ETH/USD': '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419',
        'BTC/USD': '0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c',
        'LINK/USD': '0x2c1d072e956AFFC0D435Cb7AC38EF18d24d9127c',
        'USDC/USD': '0x8fFfFfd4AfB6115b954Bd326cbe7B4BA576818f6',
        'DAI/USD': '0xAed0c38402a5d19df6E4c03F4E2DceD6e29c1ee9',
        'MATIC/USD': '0x7bAC85A8a13A4BcD8abb3eB7d6b4d632c5a57676',
        'BNB/USD': '0x14e613AC84a31f709eadbdF89C6CC390fDc9540A',
        'AVAX/USD': '0xFF3EEb22B5E3dE6e705b44749C2559d704923FD7',
        'SOL/USD': '0x4ffC43a60e009B551865A93d232E33Fce9f01507',
        'DOT/USD': '0x1C07AFb8E2B827c5A4739C6d59Ae3A5035f28734',
        'AAVE/USD': '0x547a514d5e3769680Ce22B2361c10Ea13619e8a9',
        'UNI/USD': '0x553303d460EE0afB37EdFf9bE42922D8FF63220e',
        'DOGE/USD': '0x2465CefD3b488BE410b941b1d4b2767088e2A028',
        'SHIB/USD': '0x8dD1CD88F43aF196ae478e91b9F5E4Ac69A97C61',
        'XRP/USD': '0xCed2660c6Dd1Ffd856A5A82C67f3482d88C50b12',
        'ADA/USD': '0xAE48c91dF1fE419994FFDa27da09D5aC69c30f55',
        'ATOM/USD': '0xDC4BDB458C6361093069Ca2aD30D74cc152EdC75',
        'LTC/USD': '0x6AF09DF7563C363B5763b9de2B36e3e1e838945f',
        'FIL/USD': '0x1A31D42149e82Eb99777f903C08A2E41A00085d3',
        'ARB/USD': '0x31D0852CAd55F3a5C57Ea0216fF1A85e4a4e0c01',
        'NEAR/USD': '0xC12A6d1D827e23318266Ef16Ba6F397F2F91dA9b',
        'CRV/USD': '0xCd627aA160A6fA45Eb793D19Ef54f5062F20f33f',
        'MKR/USD': '0xec1D1B3b0443256cc3860e24a46F108e699484Aa',
        'COMP/USD': '0xdbd020CAeF83eFd542f4De03e3cF0C28A4428bd5',
        'SUSHI/USD': '0xCc70F09A6CC17553b2E31954cD36E4A2d89501f7',
        'SNX/USD': '0xDC3EA94CD0AC27d9A86C180091e7f78C683d3699',
        'YFI/USD': '0xA027702dbb89fbd58938e4324ac03B58d812b0E1',
        'USDT/USD': '0x3E7d1eAB13ad0104d2750B8863b489D65364e32D',
        'WBTC/USD': '0xfdFD9C85aD200c506Cf9e21F1FD8dd01932FBB23',
        'STETH/USD': '0xCfE54B5cD566aB89272946F602D76Ea879CAb4a8'
    },
    // Polygon
    polygon: {
        'MATIC/USD': '0xAB594600376Ec9fD91F8e885dADF0CE036862dE0',
        'ETH/USD': '0xF9680D99D6C9589e2a93a78A04A279e509205945',
        'BTC/USD': '0xc907E116054Ad103354f2D350FD2514433D57F6f',
        'LINK/USD': '0xd9FFdb71EbE7496cC440152d43986Aae0AB76665',
        'USDC/USD': '0xfE4A8cc5b5B2366C1B58Bea3858e81843581b2F7',
        'DAI/USD': '0x4746DeC9e833A82EC7C2C1356372CcF2cfcD2F3D',
        'AAVE/USD': '0x72484B12719E23115761D5DA1646945632979bB6',
        'SOL/USD': '0x10C8264C0935b3B9870013e36ce8e923d7828301',
        'AVAX/USD': '0xe01eA2fbd8D76ee323FbEd03eB9a8625EC981A10',
        'DOGE/USD': '0xbaf9327b6564454F4a3364C33eFeEf032b4b4444',
        'UNI/USD': '0xdf0Fb4e4F928d2dCB76f438575fDD8682386e13C',
        'SUSHI/USD': '0x49B0c695039243BBfEb8EcD054EB70061fd54aa0',
        'CRV/USD': '0x336584C8E6Dc19637A5b36206B1c79923111b405',
        'SNX/USD': '0xbF90A5D9B6EE9019028dbFDaCA530D57B6019600'
    },
    // BSC (Binance Smart Chain)
    bsc: {
        'BNB/USD': '0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE',
        'ETH/USD': '0x9ef1B8c0E4F7dc8bF5719Ea496883DC6401d5b2e',
        'BTC/USD': '0x264990fbd0A4796A3E3d8E37C4d5F87a3aCa5Ebf',
        'LINK/USD': '0xca236E327F629f9Fc2c30A4E95775EbF0B89fac8',
        'USDC/USD': '0x51597f405303C4377E36123cBc172b13269EA163',
        'DOGE/USD': '0x3AB0A0d137D4F946fBB19eecc6e92E64660231C8',
        'DOT/USD': '0xC333eb0086309a16aa7c8308DfD32c8BBA0a2592',
        'ADA/USD': '0xa767f745331D267c7751297D982b050c93985627',
        'XRP/USD': '0x93A67D414896A280bF8FFB3b389fE3686E014fda',
        'SOL/USD': '0x0E8a53DD9c13589df6382F13dA6B3Ec8F919B323',
        'AVAX/USD': '0x5974855ce31EE8E1fff2e76591CbF83D7110F151',
        'UNI/USD': '0xb57f259E7C24e56a1dA00F66b55A5640d9f9E7e4',
        'AAVE/USD': '0xA8357BF572460fC40f4B0aCacbB2a6A61c89f475',
        'LTC/USD': '0x74E72F37A8c415c8f1a98Ed42E78Ff997435791D',
        'FIL/USD': '0xE5dbFD9003bFf9dF5feB2f4F445Ca00fb121fb83',
        'ATOM/USD': '0xb056B7C804297279A9a673289264c17E6Dc6055d',
        'CAKE/USD': '0xB6064eD41d4f67e353768aA239cA86f4F73665a1',
        'DAI/USD': '0x132d3C0B1D2cEa0BC552588063bdBb210FDeecfA',
        'USDT/USD': '0xB97Ad0E74fa7d920791E90258A6E2085088b4320',
        'NEAR/USD': '0x0Fe4D87883005fCAFaF56B81d09473D9A29dCDC3'
    },
    // Base
    base: {
        'ETH/USD': '0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70',
        'BTC/USD': '0xCCADC697c55bbB68dc5bCdf8d3CBe83CdD4E071E',
        'LINK/USD': '0x17CAb8FE31cA45e4B3F1e75c5F17B920dAbF3965',
        'USDC/USD': '0x7e860098F58bBFC8648a4311b374B1D669a2bc6B',
        'DAI/USD': '0x591e79239a7d679378eC8c847e5038150364C78F',
        'COMP/USD': '0x9DDa783DE64A9d1A60c49ca761EbE528C35BA428',
        'OP/USD': '0x3c693E7b2AdCC3A01375017b8C28e83c2e34Eed6'
    },
    // Arbitrum
    arbitrum: {
        'ETH/USD': '0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612',
        'BTC/USD': '0x6ce185860a4963106506C203335A2910413708e9',
        'LINK/USD': '0x86E53CF1B870786351Da77A57575e79CB55812CB',
        'ARB/USD': '0xb2A824043730FE05F3DA2efaFa1CBbe83fa548D6',
        'USDC/USD': '0x50834F3163758fcC1Df9973b6e91f0F0F0434aD3',
        'USDT/USD': '0x3f3f5dF88dC9F13eac63DF89EC16ef6e7E25DdE7',
        'DAI/USD': '0xc5C8E77B397E531B8EC06BFb0048328B30E9eCfB',
        'SOL/USD': '0x24ceA4b8ce57cdA5058b924B9B9987992450590c',
        'AAVE/USD': '0xaD1d5344AaDE45F43E596773Bcc4c423EAbdD034',
        'UNI/USD': '0x9C917083fDb403ab5ADbEC26Ee294f6EcAda2720',
        'COMP/USD': '0xe7C53FFd03Eb6ceF7d208bC4C13446c76d1E5884',
        'MKR/USD': '0xdE9f0894670c4EFcacF370426F10C3AD2Cdf147e',
        'OP/USD': '0x205aaD468a11fd5D34fA7211bC6Bad5b3deB9b98',
        'PEPE/USD': '0x02DEd5a7EDDA750E3Eb240b54437a54d57b74dBE'
    },
    // Optimism
    optimism: {
        'ETH/USD': '0x13e3Ee699D1909E989722E753853AE30b17e08c5',
        'BTC/USD': '0xD702DD976Fb76Fffc2D3963D037dfDae5b04E593',
        'USDC/USD': '0x16a9FA2FDa030272Ce99B29CF780dFA30361E0f3',
        'DAI/USD': '0x8dBa75e83DA73cc766A7e5a0ee71F656BAb470d6',
        'SOL/USD': '0xC663315f7aF904fbbB0F785c32046dFA03e85270',
        'SNX/USD': '0x2FCF37343e916eAEd1f1DdaaF84458a359b53877',
        'AAVE/USD': '0x338ed6787f463394D24813b297401B9F05a8C9d1',
        'UNI/USD': '0x11429eE838cC01071402f21C219870cbAc0a59A0'
    },

    // Testnet feeds
    sepolia: {
        'ETH/USD': '0x694AA1769357215DE4FAC081bf1f309aDC325306',
        'BTC/USD': '0x1b44F3514812d835EB1BDB0acB33d3fA3351Ee43',
        'LINK/USD': '0xc59E3633BAAC79493d908e63626716e204A45EdF',
        'USDC/USD': '0xA2F78ab2355fe2f984D808B5CeE7FD0A93D5270E',
        'DAI/USD': '0x14866185B1962B63C3Ea9E03Bc1da838bab34C19'
    },
    amoy: {
        'MATIC/USD': '0xd0D5e3DB44DE05E9F294BB0a3bEEaF030DE24Ada',
        'ETH/USD': '0x0715A7794a1dc8e42615F059dD6e406A6594651A',
        'BTC/USD': '0x007A22900a3B98143368Bd5906f8E17e9867581b',
        'LINK/USD': '0x1C2252aeeD50e0c9B64bDfF2735Ee3C932F5C408',
        'USDC/USD': '0x572dDec9087154dC5dfBB1546Bb62713147e0Ab0'
    },
    'bsc-testnet': {
        'BNB/USD': '0x2514895c72f50D8bd4B4F9b1110F0D6bD2c97526',
        'ETH/USD': '0x143db3CEEfbdfe5631aDD3E50f7614B6ba708BA7',
        'BTC/USD': '0x5741306c21795FdCBb9b265Ea0255F499DFe515C',
        'LINK/USD': '0x1B329402Cb1825C6F30A0d92aB9E2862BE47333f'
    },
    'base-sepolia': {
        'ETH/USD': '0x4aDC67696bA383F43DD60A9e78F2C97fbbFC748',
        'BTC/USD': '0x0FB99723Aee6f420beAD13e6bBB79b7E6F034298'
    }
};

// Chainlink Price Feed ABI (minimal)
const PRICE_FEED_ABI = [
    {
        "inputs": [],
        "name": "latestRoundData",
        "outputs": [
            { "internalType": "uint80", "name": "roundId", "type": "uint80" },
            { "internalType": "int256", "name": "answer", "type": "int256" },
            { "internalType": "uint256", "name": "startedAt", "type": "uint256" },
            { "internalType": "uint256", "name": "updatedAt", "type": "uint256" },
            { "internalType": "uint80", "name": "answeredInRound", "type": "uint80" }
        ],
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
        "name": "description",
        "outputs": [{ "internalType": "string", "name": "", "type": "string" }],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [],
        "name": "version",
        "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [{ "internalType": "uint80", "name": "_roundId", "type": "uint80" }],
        "name": "getRoundData",
        "outputs": [
            { "internalType": "uint80", "name": "roundId", "type": "uint80" },
            { "internalType": "int256", "name": "answer", "type": "int256" },
            { "internalType": "uint256", "name": "startedAt", "type": "uint256" },
            { "internalType": "uint256", "name": "updatedAt", "type": "uint256" },
            { "internalType": "uint80", "name": "answeredInRound", "type": "uint80" }
        ],
        "stateMutability": "view",
        "type": "function"
    }
];

// Chainlink token addresses
const LINK_TOKEN_ADDRESSES = {
    ethereum: '0x514910771AF9Ca656af840dff83E8264EcF986CA',
    polygon: '0x53E0bca35eC356BD5ddDFebbD1Fc0fD03FaBad39',
    bsc: '0x404460C6A5EdE2D891e8297795264fDe62ADBB75',
    sepolia: '0x779877A7B0D9E8603169DdbD7836e478b4624789',
    amoy: '0x0Fd9e8d3aF1aaee056EB9e802c3A762a667b1904',
    'bsc-testnet': '0x84b9B910527Ad5C03A9Ca831909E21e236EA7b06'
};

export default class ChainlinkPlugin extends BasePlugin {
    constructor(agent) {
        super(agent);
        this.name = 'chainlink';
        this.version = '1.0.0';
        this.description = 'Chainlink oracle integration for decentralized price feeds and data';
        this.commands = [
            {
                command: 'price',
                description: 'Get price from Chainlink oracle',
                usage: 'price <pair> [network]',
                offerAsService: true
            },
            {
                command: 'feeds',
                description: 'List available price feeds for a network',
                usage: 'feeds [network]',
                offerAsService: true
            },
            {
                command: 'historical',
                description: 'Get historical price data',
                usage: 'historical <pair> <roundId> [network]',
                offerAsService: true
            },
            {
                command: 'compare',
                description: 'Compare Chainlink price with other sources',
                usage: 'compare <pair> [network]',
                offerAsService: true
            },
            {
                command: 'faucet',
                description: 'Get information about LINK token faucets',
                usage: 'faucet [network]',
                offerAsService: false
            },
            {
                command: 'balance',
                description: 'Check LINK token balance',
                usage: 'balance [address] [network]',
                offerAsService: false
            },
            {
                command: 'info',
                description: 'Get price feed information',
                usage: 'info <pair> [network]',
                offerAsService: true
            }
        ];
        
        // Cache for price data (5 second TTL)
        this.priceCache = new Map();
        this.cacheTTL = 5000;
    }

    /**
     * Normalize pair input: accepts BTC, btc, BTC/USD, btcusd, btc/usd
     */
    normalizePair(pair) {
        if (!pair) return pair;
        let p = pair.toUpperCase().replace(/[^A-Z/]/g, '');
        // If no slash, assume /USD
        if (!p.includes('/')) p = `${p}/USD`;
        return p;
    }

    async execute(params) {
        const { action, pair, network, roundId, address, symbol, asset, token } = params;
        const normalizedPair = this.normalizePair(pair || symbol || asset || token);

        // Normalize action aliases
        const normalizedAction = {
            'history': 'historical',
            'historic': 'historical',
            'list': 'feeds',
            'list-feeds': 'feeds',
            'listfeeds': 'feeds',
            'pairs': 'feeds',
            'available': 'feeds',
            'get': 'price',
            'quote': 'price',
            'lookup': 'price',
            'detail': 'info',
            'details': 'info',
            'metadata': 'info',
            'diff': 'compare',
            'vs': 'compare'
        }[action] || action;

        try {
            switch(normalizedAction) {
                case 'price':
                    return await this.getPrice(normalizedPair, network);

                case 'feeds':
                    return await this.listFeeds(network);

                case 'historical':
                    return await this.getHistoricalPrice(normalizedPair, roundId, network);

                case 'compare':
                    return await this.comparePrices(normalizedPair, network);

                case 'faucet':
                    return await this.getFaucetInfo(network);

                case 'balance':
                    return await this.checkLINKBalance(address, network);

                case 'info':
                    return await this.getFeedInfo(normalizedPair, network);

                default:
                    return {
                        success: false,
                        error: `Unknown action '${action}'. Use: price, feeds, historical, compare, faucet, balance, info`
                    };
            }
        } catch (error) {
            logger.error('Chainlink plugin error:', error.message || error);
            return { success: false, error: error.message || String(error) };
        }
    }

    /**
     * Get current price from Chainlink oracle
     */
    async getPrice(pair, network) {
        if (!pair) {
            return { success: false, error: 'Price pair is required (e.g., ETH/USD, BTC, sol)' };
        }

        // Determine network based on testnet mode if not specified
        if (!network) {
            network = await this.getDefaultNetwork();
        }

        const pairUpper = pair.toUpperCase();

        // Check cache first
        const cacheKey = `${network}:${pairUpper}`;
        const cached = this.priceCache.get(cacheKey);
        if (cached && Date.now() - cached.timestamp < this.cacheTTL) {
            return {
                success: true,
                result: `${pairUpper} Price: $${cached.price.toFixed(2)} (cached)`,
                data: cached.data
            };
        }

        // Get feed address — try specified network first, then auto-discover
        let feeds = CHAINLINK_FEEDS[network];
        let feedAddress = feeds?.[pairUpper];
        let resolvedNetwork = network;

        if (!feedAddress) {
            // Auto-discover: search mainnet networks for this pair
            const mainnetNetworks = ['ethereum', 'bsc', 'arbitrum', 'polygon', 'optimism', 'base'];
            for (const net of mainnetNetworks) {
                if (net === network) continue;
                if (CHAINLINK_FEEDS[net]?.[pairUpper]) {
                    feedAddress = CHAINLINK_FEEDS[net][pairUpper];
                    resolvedNetwork = net;
                    break;
                }
            }
        }

        if (!feedAddress) {
            // No Chainlink feed — try CoinGecko as fallback
            const fallback = await this.coingeckoFallback(pairUpper);
            if (fallback) return fallback;

            // Neither source has data
            const allPairs = new Set();
            for (const [net, f] of Object.entries(CHAINLINK_FEEDS)) {
                if (!this.isTestnetNetwork(net)) Object.keys(f).forEach(p => allPairs.add(p));
            }
            return {
                success: false,
                error: `No price feed for ${pairUpper} on Chainlink or CoinGecko`,
                available: Array.from(allPairs).sort().join(', ')
            };
        }
        
        try {
            // Read from contract
            const contract = await contractService.getContract(feedAddress, resolvedNetwork, PRICE_FEED_ABI);
            const [roundId, answer, startedAt, updatedAt, answeredInRound] = await contract.latestRoundData();
            const decimals = await contract.decimals();

            // Calculate price
            const price = Number(answer) / Math.pow(10, Number(decimals));

            // Calculate age and check staleness
            const ageSeconds = Math.floor(Date.now() / 1000) - Number(updatedAt);
            const ageMinutes = Math.floor(ageSeconds / 60);
            const stale = price <= 0 || ageSeconds > 600; // 10 minutes
            if (stale) {
                logger.warn(`Chainlink ${pairUpper}: stale or invalid (price=${price}, age=${ageSeconds}s)`);
            }

            const data = {
                pair: pairUpper,
                price,
                roundId: roundId.toString(),
                timestamp: new Date(Number(updatedAt) * 1000).toISOString(),
                age: ageMinutes < 1 ? `${ageSeconds} seconds` : `${ageMinutes} minutes`,
                ageSeconds,
                stale,
                network: resolvedNetwork,
                feedAddress,
                decimals: Number(decimals)
            };

            // Cache the result
            const resolvedCacheKey = `${resolvedNetwork}:${pairUpper}`;
            this.priceCache.set(resolvedCacheKey, {
                price,
                data,
                timestamp: Date.now()
            });

            return {
                success: true,
                result: `${pairUpper} Price: $${price.toFixed(decimals > 2 ? 2 : decimals)} (${data.age} ago, ${resolvedNetwork})`,
                data
            };
        } catch (error) {
            logger.error(`Failed to get Chainlink price for ${pair}:`, error.message || error);
            return {
                success: false,
                error: `Failed to fetch price: ${error.message || error}`
            };
        }
    }

    /**
     * List available price feeds for a network
     */
    async listFeeds(network) {
        // If network is 'all', return feeds across all networks
        if (network === 'all') {
            const allFeeds = {};
            for (const [net, feeds] of Object.entries(CHAINLINK_FEEDS)) {
                if (!this.isTestnetNetwork(net)) {
                    allFeeds[net] = Object.keys(feeds);
                }
            }
            const totalPairs = Object.values(allFeeds).reduce((n, f) => n + f.length, 0);
            return {
                success: true,
                result: `Available Chainlink Price Feeds across all networks (${totalPairs} total)`,
                feeds: allFeeds,
                totalFeeds: totalPairs,
                networks: Object.keys(allFeeds)
            };
        }

        if (!network) {
            network = await this.getDefaultNetwork();
        }

        const feeds = CHAINLINK_FEEDS[network];
        if (!feeds) {
            return {
                success: false,
                error: `No Chainlink feeds available for network: ${network}`,
                availableNetworks: Object.keys(CHAINLINK_FEEDS).filter(n => !this.isTestnetNetwork(n)).join(', ')
            };
        }

        const feedList = Object.keys(feeds).map(pair => `• ${pair}`).join('\n');

        return {
            success: true,
            result: `Available Chainlink Price Feeds on ${network} (${Object.keys(feeds).length}):\n${feedList}`,
            feeds: Object.keys(feeds),
            network,
            isTestnet: this.isTestnetNetwork(network),
            totalFeeds: Object.keys(feeds).length,
            availableNetworks: Object.keys(CHAINLINK_FEEDS).filter(n => !this.isTestnetNetwork(n))
        };
    }

    /**
     * Get historical price data
     */
    /**
     * Resolve feed address with auto-discovery across networks
     */
    async resolveFeed(pair, network) {
        if (!network) network = await this.getDefaultNetwork();
        const pairUpper = pair?.toUpperCase();
        if (!pairUpper) return { error: 'Price pair is required' };

        let feedAddress = CHAINLINK_FEEDS[network]?.[pairUpper];
        let resolvedNetwork = network;

        if (!feedAddress) {
            const mainnetNetworks = ['ethereum', 'bsc', 'arbitrum', 'polygon', 'optimism', 'base'];
            for (const net of mainnetNetworks) {
                if (net === network) continue;
                if (CHAINLINK_FEEDS[net]?.[pairUpper]) {
                    feedAddress = CHAINLINK_FEEDS[net][pairUpper];
                    resolvedNetwork = net;
                    break;
                }
            }
        }

        if (!feedAddress) return { error: `No price feed for ${pairUpper} on any network` };
        return { feedAddress, resolvedNetwork, pairUpper };
    }

    async getHistoricalPrice(pair, roundId, network) {
        if (!pair || !roundId) {
            return { success: false, error: 'Both pair and roundId are required (e.g., pair=BTC/USD, roundId=110680464442257320247)' };
        }

        const resolved = await this.resolveFeed(pair, network);
        if (resolved.error) return { success: false, error: resolved.error };

        try {
            const contract = await contractService.getContract(resolved.feedAddress, resolved.resolvedNetwork, PRICE_FEED_ABI);
            const [rid, answer, startedAt, updatedAt, answeredInRound] = await contract.getRoundData(roundId);
            const decimals = await contract.decimals();

            const price = Number(answer) / Math.pow(10, Number(decimals));

            return {
                success: true,
                result: `Historical ${resolved.pairUpper} Price: $${price.toFixed(2)}`,
                data: {
                    pair: resolved.pairUpper,
                    price,
                    roundId: rid.toString(),
                    timestamp: new Date(Number(updatedAt) * 1000).toISOString(),
                    network: resolved.resolvedNetwork,
                    feedAddress: resolved.feedAddress
                }
            };
        } catch (error) {
            logger.error(`Failed to get historical price:`, error.message || error);
            return {
                success: false,
                error: `Failed to fetch historical price: ${error.message || error}`
            };
        }
    }

    /**
     * Compare Chainlink price with other sources
     */
    async comparePrices(pair, network) {
        if (!pair) {
            return { success: false, error: 'Price pair is required (e.g., BTC/USD, ETH)' };
        }

        // Get Chainlink price
        const chainlinkResult = await this.getPrice(pair, network);
        if (!chainlinkResult.success) {
            return chainlinkResult;
        }
        
        // Try to get CoinGecko price if available
        let coingeckoPrice = null;
        try {
            // Map common pairs to CoinGecko IDs
            const coinMap = {
                'ETH/USD': 'ethereum',
                'BTC/USD': 'bitcoin',
                'LINK/USD': 'chainlink',
                'MATIC/USD': 'matic-network',
                'BNB/USD': 'binancecoin'
            };
            
            const coinId = coinMap[pair.toUpperCase()];
            if (coinId && this.agent.apiManager) {
                const coingeckoPlugin = this.agent.apiManager.getPlugin('coingecko');
                if (coingeckoPlugin) {
                    const cgResult = await coingeckoPlugin.execute({ 
                        action: 'price', 
                        coinIds: coinId 
                    });
                    if (cgResult.success && cgResult.data && cgResult.data[coinId]) {
                        coingeckoPrice = cgResult.data[coinId].usd;
                    }
                }
            }
        } catch (error) {
            logger.warn('Failed to get CoinGecko price for comparison:', error.message);
        }
        
        const chainlinkPrice = chainlinkResult.data.price;
        let comparison = `Chainlink ${pair.toUpperCase()}: $${chainlinkPrice.toFixed(2)}`;
        
        if (coingeckoPrice) {
            const difference = Math.abs(chainlinkPrice - coingeckoPrice);
            const percentDiff = ((difference / coingeckoPrice) * 100).toFixed(2);
            
            comparison += `\nCoinGecko ${pair.toUpperCase()}: $${coingeckoPrice.toFixed(2)}`;
            comparison += `\nDifference: $${difference.toFixed(2)} (${percentDiff}%)`;
            
            return {
                success: true,
                result: comparison,
                data: {
                    pair: pair.toUpperCase(),
                    chainlink: chainlinkPrice,
                    coingecko: coingeckoPrice,
                    difference,
                    percentDifference: parseFloat(percentDiff),
                    network: chainlinkResult.data.network
                }
            };
        }
        
        return {
            success: true,
            result: comparison + '\n(No other sources available for comparison)',
            data: chainlinkResult.data
        };
    }

    /**
     * Get LINK token faucet information
     */
    async getFaucetInfo(network) {
        if (!network) {
            network = await this.getDefaultNetwork();
        }
        
        // Only testnets have faucets
        if (!this.isTestnetNetwork(network)) {
            return {
                success: false,
                error: 'Faucets are only available on testnet networks'
            };
        }
        
        const linkAddress = LINK_TOKEN_ADDRESSES[network];
        let result = `Chainlink Faucet Information for ${network}:\n\n`;
        
        result += `🚰 Official Chainlink Faucet: https://faucets.chain.link/\n`;
        result += `• Supports: Sepolia, Polygon Amoy, BSC Testnet\n`;
        result += `• Provides: LINK tokens and native tokens (ETH/MATIC/BNB)\n`;
        result += `• Requirements: GitHub account for verification\n`;
        
        if (linkAddress) {
            result += `\n📝 LINK Token Contract: ${linkAddress}`;
        }
        
        // Get wallet address if available
        try {
            const walletInfo = await walletService.getWalletInfo();
            if (walletInfo && walletInfo.initialized && walletInfo.addresses) {
                // Find the appropriate address for this network
                const addressInfo = walletInfo.addresses.find(addr => {
                    if (network.includes('sepolia') || network.includes('ethereum')) return addr.chain === 'eth';
                    if (network.includes('bsc')) return addr.chain === 'bsc';
                    if (network.includes('polygon') || network.includes('amoy')) return addr.chain === 'polygon';
                    return false;
                });
                
                if (addressInfo) {
                    result += `\n\n💰 Your wallet address: ${addressInfo.address}`;
                    
                    // Check LINK balance
                    const balance = await this.checkLINKBalance(addressInfo.address, network);
                    if (balance.success && balance.data) {
                        result += `\n🪙 Current LINK balance: ${balance.data.formatted} LINK`;
                    }
                }
            }
        } catch (error) {
            logger.warn('Could not get wallet info:', error.message);
        }
        
        return {
            success: true,
            result,
            data: {
                faucetUrl: 'https://faucets.chain.link/',
                network,
                linkContract: linkAddress,
                supportedNetworks: ['sepolia', 'amoy', 'bsc-testnet']
            }
        };
    }

    /**
     * Check LINK token balance
     */
    async checkLINKBalance(address, network) {
        if (!network) {
            network = await this.getDefaultNetwork();
        }
        
        // Get wallet address if not provided
        if (!address) {
            try {
                const walletInfo = await walletService.getWalletInfo();
                if (walletInfo && walletInfo.initialized && walletInfo.addresses) {
                    // Find the appropriate address for this network
                    const addressInfo = walletInfo.addresses.find(addr => {
                        if (network.includes('sepolia') || network.includes('ethereum')) return addr.chain === 'eth';
                        if (network.includes('bsc')) return addr.chain === 'bsc';
                        if (network.includes('polygon') || network.includes('amoy')) return addr.chain === 'polygon';
                        return false;
                    });
                    
                    if (addressInfo) {
                        address = addressInfo.address;
                    }
                }
                
                if (!address) {
                    return { success: false, error: 'No address provided and no wallet found for this network' };
                }
            } catch (error) {
                return { success: false, error: 'No address provided and wallet service error: ' + error.message };
            }
        }
        
        const linkAddress = LINK_TOKEN_ADDRESSES[network];
        if (!linkAddress) {
            return {
                success: false,
                error: `No LINK token address for network: ${network}`
            };
        }
        
        try {
            const balance = await contractService.getTokenBalance(linkAddress, address, network);
            
            return {
                success: true,
                result: `LINK Balance: ${balance.formatted} LINK`,
                data: {
                    address,
                    balance: balance.formatted,
                    raw: balance.raw,
                    network,
                    tokenContract: linkAddress
                }
            };
        } catch (error) {
            logger.error('Failed to check LINK balance:', error);
            return {
                success: false,
                error: `Failed to check balance: ${error.message}`
            };
        }
    }

    /**
     * Get detailed price feed information
     */
    async getFeedInfo(pair, network) {
        if (!pair) {
            return { success: false, error: 'Price pair is required (e.g., BTC/USD, ETH)' };
        }

        const resolved = await this.resolveFeed(pair, network);
        if (resolved.error) return { success: false, error: resolved.error };

        try {
            const contract = await contractService.getContract(resolved.feedAddress, resolved.resolvedNetwork, PRICE_FEED_ABI);

            const [description, version, decimals] = await Promise.all([
                contract.description(),
                contract.version(),
                contract.decimals()
            ]);

            // Get latest price data
            const [roundId, answer, startedAt, updatedAt] = await contract.latestRoundData();
            const price = Number(answer) / Math.pow(10, Number(decimals));

            const info = `Chainlink Price Feed Information:

Feed: ${description}
Contract: ${resolved.feedAddress}
Network: ${resolved.resolvedNetwork}
Version: ${version}
Decimals: ${decimals}

Latest Data:
• Price: $${price.toFixed(2)}
• Round ID: ${roundId}
• Last Update: ${new Date(Number(updatedAt) * 1000).toLocaleString()}`;

            return {
                success: true,
                result: info,
                data: {
                    pair: resolved.pairUpper,
                    description,
                    address: resolved.feedAddress,
                    network: resolved.resolvedNetwork,
                    version: version.toString(),
                    decimals: Number(decimals),
                    latestPrice: price,
                    latestRound: roundId.toString(),
                    lastUpdate: new Date(Number(updatedAt) * 1000).toISOString()
                }
            };
        } catch (error) {
            logger.error('Failed to get feed info:', error.message || error);
            return {
                success: false,
                error: `Failed to get feed info: ${error.message || error}`
            };
        }
    }

    /**
     * Get default network based on testnet mode
     */
    async getDefaultNetwork() {
        try {
            const db = this.agent?.db;
            if (db?.Agent) {
                const agent = await db.Agent.findOne({ name: process.env.AGENT_NAME || "LANAgent" });
                if (agent?.config?.cryptoNetworkMode) {
                    const isTestnet = agent.config.cryptoNetworkMode === 'testnet';
                    return isTestnet ? 'bsc-testnet' : 'bsc';
                }
            }
            // Default to BSC mainnet (project is BSC-focused)
            return 'bsc';
        } catch (error) {
            logger.warn('Could not determine network mode, defaulting to bsc:', error.message || error);
            return 'bsc';
        }
    }

    /**
     * Check if network is a testnet
     */
    isTestnetNetwork(network) {
        const testnets = ['sepolia', 'amoy', 'bsc-testnet', 'base-sepolia', 'mumbai', 'goerli'];
        return testnets.includes(network);
    }

    /**
     * CoinGecko fallback — used when Chainlink has no feed for a token.
     * Returns a clearly-labeled fallback response, or null if CoinGecko can't help either.
     */
    async coingeckoFallback(pairUpper) {
        // Extract the base symbol from pair (e.g., "FLOKI/USD" → "FLOKI")
        const symbol = pairUpper.split('/')[0];
        const coinId = SYMBOL_TO_COINGECKO[symbol];

        if (!coinId) {
            // Try CoinGecko search as last resort
            try {
                const searchRes = await axios.get('https://api.coingecko.com/api/v3/search', {
                    params: { query: symbol },
                    timeout: 8000
                });
                const coin = searchRes.data?.coins?.[0];
                if (!coin) return null;
                return await this._fetchCoinGeckoPrice(coin.id, symbol, pairUpper);
            } catch (e) {
                logger.warn('CoinGecko search fallback failed:', e.message || e);
                return null;
            }
        }

        return await this._fetchCoinGeckoPrice(coinId, symbol, pairUpper);
    }

    async _fetchCoinGeckoPrice(coinId, symbol, pairUpper) {
        try {
            const res = await axios.get('https://api.coingecko.com/api/v3/simple/price', {
                params: {
                    ids: coinId,
                    vs_currencies: 'usd',
                    include_market_cap: true,
                    include_24hr_vol: true,
                    include_24hr_change: true
                },
                timeout: 8000
            });

            const data = res.data?.[coinId];
            if (!data?.usd) return null;

            const price = data.usd;
            return {
                success: true,
                result: `${pairUpper} Price: $${price < 1 ? price.toPrecision(4) : price.toFixed(2)} (CoinGecko fallback — no Chainlink oracle available for this token)`,
                data: {
                    pair: pairUpper,
                    price,
                    source: 'coingecko',
                    sourceNote: 'Fallback — no Chainlink decentralized oracle feed exists for this token. This price is from CoinGecko (centralized API).',
                    coinGeckoId: coinId,
                    marketCap: data.usd_market_cap || null,
                    volume24h: data.usd_24h_vol || null,
                    change24h: data.usd_24h_change || null,
                    network: null,
                    feedAddress: null,
                    decimals: null
                }
            };
        } catch (e) {
            logger.warn(`CoinGecko fallback failed for ${coinId}:`, e.message || e);
            return null;
        }
    }
}

/**
 * Usage Examples:
 * - Natural language: "get ETH price from chainlink"
 * - Natural language: "check chainlink oracle for bitcoin price"
 * - Natural language: "list chainlink price feeds on polygon"
 * - Natural language: "get LINK tokens from faucet"
 * - Natural language: "compare chainlink and coingecko prices for ETH"
 * - Command format: api chainlink price ETH/USD
 * - Command format: api chainlink feeds sepolia
 * - Command format: api chainlink faucet
 */