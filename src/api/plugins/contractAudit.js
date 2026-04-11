import { BasePlugin } from '../core/basePlugin.js';
import NodeCache from 'node-cache';

const sourceCache = new NodeCache({ stdTTL: 600, checkperiod: 120 }); // 10 min TTL

// ── Vulnerability patterns ──────────────────────────────────────────────────

const CRITICAL_PATTERNS = [
  {
    id: 'selfdestruct',
    regex: /\b(selfdestruct|suicide)\s*\(/g,
    description: 'Contract uses selfdestruct/suicide — can permanently destroy the contract and send remaining Ether to an arbitrary address'
  },
  {
    id: 'delegatecall-user-input',
    regex: /\.delegatecall\s*\(/g,
    description: 'delegatecall usage detected — if the target address is user-controlled, an attacker can execute arbitrary code in this contract\'s context'
  },
  {
    id: 'tx-origin-auth',
    regex: /require\s*\(\s*tx\.origin\s*==|tx\.origin\s*==\s*owner|if\s*\(\s*tx\.origin/g,
    description: 'tx.origin used for authorization — vulnerable to phishing attacks where a malicious contract relays transactions'
  },
  {
    id: 'unchecked-call',
    regex: /\.call\s*[\({][\s\S]*?[}\)]\s*;(?!\s*(?:require|if|bool|assert|\())/gm,
    description: 'Return value of low-level call is not checked — may silently fail, leading to lost funds'
  }
];

const HIGH_PATTERNS = [
  {
    id: 'reentrancy',
    regex: /\.call\s*\{.*value.*\}\s*\([\s\S]*?\)\s*;[\s\S]*?(?:balances|balance|_balances)\s*\[/gm,
    description: 'Potential reentrancy — external call is made before state update. An attacker can recursively call back into the function'
  },
  {
    id: 'unprotected-mint',
    regex: /function\s+mint\s*\([^)]*\)\s*(?:public|external)(?!\s+(?:onlyOwner|onlyRole|onlyMinter|whenNotPaused))/gm,
    description: 'Unprotected mint function — any address can call mint without access control, allowing unlimited token creation'
  },
  {
    id: 'unprotected-burn',
    regex: /function\s+burn\s*\([^)]*\)\s*(?:public|external)(?!\s+(?:onlyOwner|onlyRole|onlyBurner|whenNotPaused))/gm,
    description: 'Unprotected burn function — lacks access control modifier'
  },
  {
    id: 'no-access-control',
    regex: /function\s+(?:withdraw|pause|unpause|setOwner|transferOwnership|upgrade|setAdmin|kill|destroy)\s*\([^)]*\)\s*(?:public|external)(?!\s+(?:onlyOwner|onlyRole|onlyAdmin|whenNotPaused|auth|restricted))/gm,
    description: 'Sensitive function lacks access control — could be called by any address'
  },
  {
    id: 'integer-overflow-pre-0.8',
    regex: null, // Handled in code — depends on pragma version
    description: 'Contract uses Solidity <0.8.0 without SafeMath — arithmetic operations may overflow/underflow silently'
  }
];

const MEDIUM_PATTERNS = [
  {
    id: 'missing-zero-check',
    regex: /function\s+\w+\s*\([^)]*address\s+\w+[^)]*\)[\s\S]*?\{(?:(?!require\s*\(\s*\w+\s*!=\s*address\s*\(\s*0\s*\))[\s\S])*?\}/gm,
    description: 'Function accepts address parameter without zero-address validation — tokens or ownership could be sent to the burn address accidentally'
  },
  {
    id: 'no-event-emission',
    regex: /function\s+(?:set|update|change|transfer|withdraw|deposit|mint|burn)\w*\s*\([^)]*\)[^{]*\{(?:(?!emit\s)[\s\S])*?\}/gm,
    description: 'State-changing function does not emit an event — off-chain services and UIs cannot track changes'
  },
  {
    id: 'floating-pragma',
    regex: /pragma\s+solidity\s*\^/gm,
    description: 'Floating pragma version (^) — contract may be compiled with an untested compiler version. Pin to a specific version for production'
  },
  {
    id: 'unlocked-compiler',
    regex: /pragma\s+solidity\s*>=?\s*\d+\.\d+\.\d+\s*<?/gm,
    description: 'Unlocked compiler version range — may introduce unexpected behavior from newer compiler versions'
  },
  {
    id: 'missing-input-validation',
    regex: /function\s+\w+\s*\(\s*uint\d*\s+\w+[^)]*\)[^{]*\{(?:(?!require|assert)[\s\S])*?\}/gm,
    description: 'Function with numeric input lacks validation — could accept unexpected values (zero, overflow, etc.)'
  }
];

const LOW_PATTERNS = [
  {
    id: 'missing-natspec',
    regex: /(?<!\/{3}[^\n]*\n|\*\/\s*\n)\s*function\s+\w+/gm,
    description: 'Function is missing NatSpec documentation comments'
  },
  {
    id: 'public-could-be-external',
    regex: /function\s+\w+\s*\([^)]*\)\s*public\b(?!.*\boverride\b)/gm,
    description: 'Public function that is not called internally could be declared external to save gas'
  },
  {
    id: 'magic-numbers',
    regex: /(?:==|!=|>=?|<=?|\+|-|\*|\/|%)\s*(?:1000+|[2-9]\d{2,}|0x[0-9a-fA-F]{3,})(?!\s*(?:ether|gwei|wei|seconds|minutes|hours|days|weeks))/gm,
    description: 'Magic number in code — use named constants for clarity and maintainability'
  }
];

// ── Contract type identification ────────────────────────────────────────────

const CONTRACT_TYPE_PATTERNS = [
  { type: 'ERC20', regex: /function\s+totalSupply|function\s+balanceOf|function\s+transfer\b|function\s+approve\b|function\s+allowance\b/g, minMatches: 3 },
  { type: 'ERC721', regex: /function\s+ownerOf|function\s+safeTransferFrom|function\s+tokenURI|ERC721/g, minMatches: 2 },
  { type: 'ERC1155', regex: /function\s+balanceOfBatch|function\s+safeTransferFrom|ERC1155/g, minMatches: 2 },
  { type: 'ERC2535 Diamond', regex: /IDiamondCut|DiamondCut|facetAddress|LibDiamond/g, minMatches: 2 },
  { type: 'Governor/DAO', regex: /function\s+propose|function\s+castVote|function\s+execute.*Proposal|quorum/g, minMatches: 2 },
  { type: 'DEX/AMM', regex: /function\s+swap|function\s+addLiquidity|function\s+removeLiquidity|getAmountOut/g, minMatches: 2 },
  { type: 'Staking', regex: /function\s+stake|function\s+unstake|function\s+claimReward|rewardPerToken/g, minMatches: 2 },
  { type: 'Proxy (Upgradeable)', regex: /function\s+upgradeTo|implementation\s*\(\)|_setImplementation|ERC1967|TransparentUpgradeable/g, minMatches: 1 },
  { type: 'Multisig', regex: /function\s+submitTransaction|function\s+confirmTransaction|isConfirmed|required\s*>/g, minMatches: 2 },
  { type: 'Timelock', regex: /function\s+schedule|function\s+execute|getTimestamp|minDelay/g, minMatches: 2 }
];

// ── Explorer config ─────────────────────────────────────────────────────────

const EXPLORER_CONFIG = {
  bsc: {
    url: 'https://api.bscscan.com/api',
    envKey: 'BSCSCAN_API_KEY'
  },
  eth: {
    url: 'https://api.etherscan.io/api',
    envKey: 'ETHERSCAN_API_KEY'
  },
  ethereum: {
    url: 'https://api.etherscan.io/api',
    envKey: 'ETHERSCAN_API_KEY'
  }
};

// ── Helper functions ────────────────────────────────────────────────────────

function getLineNumber(code, index) {
  return code.substring(0, index).split('\n').length;
}

function getSolidityVersion(code) {
  const match = code.match(/pragma\s+solidity\s*[\^>=<]*\s*(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return { major: parseInt(match[1]), minor: parseInt(match[2]), patch: parseInt(match[3]) };
}

function isPre080(code) {
  const ver = getSolidityVersion(code);
  if (!ver) return false;
  return ver.major === 0 && ver.minor < 8;
}

function hasSafeMath(code) {
  return /using\s+SafeMath\s+for/i.test(code);
}

function runPatterns(code, patterns, severity) {
  const findings = [];
  for (const pattern of patterns) {
    if (!pattern.regex) continue;
    // Reset lastIndex for global regexes
    pattern.regex.lastIndex = 0;
    let match;
    const seen = new Set();
    while ((match = pattern.regex.exec(code)) !== null) {
      const line = getLineNumber(code, match.index);
      const key = `${pattern.id}:${line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push({
        id: pattern.id,
        severity,
        description: pattern.description,
        line,
        snippet: match[0].substring(0, 120)
      });
    }
  }
  return findings;
}

function calculateRiskScore(findings) {
  const weights = { critical: 25, high: 15, medium: 8, low: 3, info: 0 };
  let score = 0;
  for (const f of findings) {
    score += weights[f.severity] || 0;
  }
  return Math.min(100, score);
}

function gatherInfoFindings(code) {
  const findings = [];
  const lines = code.split('\n');

  // Contract size
  findings.push({
    id: 'contract-size',
    severity: 'info',
    description: `Contract source is ${lines.length} lines, ${code.length} characters`,
    line: null
  });

  // Function count
  const funcMatches = code.match(/function\s+\w+/g);
  if (funcMatches) {
    findings.push({
      id: 'function-count',
      severity: 'info',
      description: `Contract contains ${funcMatches.length} functions`,
      line: null
    });
  }

  // Proxy pattern
  if (/delegatecall|implementation\s*\(\)|_setImplementation|ERC1967Proxy|TransparentUpgradeable/i.test(code)) {
    findings.push({
      id: 'uses-proxy',
      severity: 'info',
      description: 'Contract appears to use a proxy/upgradeable pattern',
      line: null
    });
  }

  // Upgradeable pattern
  if (/Initializable|initializer\b|__.*_init\b|upgradeTo\b/i.test(code)) {
    findings.push({
      id: 'upgradeable-pattern',
      severity: 'info',
      description: 'Contract uses upgradeable/initializer pattern (OpenZeppelin style)',
      line: null
    });
  }

  // Solidity version
  const ver = getSolidityVersion(code);
  if (ver) {
    findings.push({
      id: 'solidity-version',
      severity: 'info',
      description: `Solidity version: ${ver.major}.${ver.minor}.${ver.patch}`,
      line: null
    });
  }

  return findings;
}

function identifyContractTypes(code) {
  const types = [];
  for (const ct of CONTRACT_TYPE_PATTERNS) {
    ct.regex.lastIndex = 0;
    const matches = code.match(ct.regex);
    if (matches && matches.length >= ct.minMatches) {
      types.push(ct.type);
    }
  }
  return types;
}

function identifyKeyFunctions(code) {
  const functions = [];
  const funcRegex = /function\s+(\w+)\s*\(([^)]*)\)\s*((?:public|external|internal|private|view|pure|payable|virtual|override|returns\s*\([^)]*\)|\s)*)/g;
  let match;
  while ((match = funcRegex.exec(code)) !== null) {
    const name = match[1];
    const params = match[2].trim();
    const modifiers = match[3].trim();
    const line = getLineNumber(code, match.index);
    functions.push({ name, params, modifiers, line });
  }
  return functions;
}

// ── Plugin ──────────────────────────────────────────────────────────────────

export default class ContractAuditPlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'contractAudit';
    this.version = '1.0.0';
    this.description = 'Smart contract security auditing for Solidity source code';
    this.commands = [
      {
        command: 'audit',
        description: 'Full security audit of Solidity source code',
        usage: 'audit({ code: "pragma solidity..." }) or audit({ address: "0x...", network: "bsc" })'
      },
      {
        command: 'quickCheck',
        description: 'Fast check for critical and high severity issues only',
        usage: 'quickCheck({ code: "pragma solidity..." })'
      },
      {
        command: 'explain',
        description: 'Explain what a contract does in plain English',
        usage: 'explain({ code: "pragma solidity..." })'
      }
    ];
  }

  async initialize() {
    this.logger.info('ContractAudit plugin initialized');
  }

  async execute(params) {
    const { action, ...data } = params;

    switch (action) {
      case 'audit':
        return await this.audit(data);
      case 'quickCheck':
        return await this.quickCheck(data);
      case 'explain':
        return await this.explain(data);
      default:
        return {
          success: false,
          error: `Unknown action: ${action}. Available actions: audit, quickCheck, explain`
        };
    }
  }

  // ── Commands ────────────────────────────────────────────────────────────

  async audit(data) {
    try {
      const code = await this._resolveSource(data);
      if (!code) {
        return { success: false, error: 'No Solidity source code provided. Supply { code } or { address, network }.' };
      }

      const findings = [];

      // Critical
      findings.push(...runPatterns(code, CRITICAL_PATTERNS, 'critical'));

      // High — including conditional integer overflow check
      findings.push(...runPatterns(code, HIGH_PATTERNS.filter(p => p.regex), 'high'));
      if (isPre080(code) && !hasSafeMath(code)) {
        findings.push({
          id: 'integer-overflow-pre-0.8',
          severity: 'high',
          description: HIGH_PATTERNS.find(p => p.id === 'integer-overflow-pre-0.8').description,
          line: 1
        });
      }

      // Medium
      findings.push(...runPatterns(code, MEDIUM_PATTERNS, 'medium'));

      // Low
      findings.push(...runPatterns(code, LOW_PATTERNS, 'low'));

      // Info
      findings.push(...gatherInfoFindings(code));

      const riskScore = calculateRiskScore(findings);

      const summary = {
        critical: findings.filter(f => f.severity === 'critical').length,
        high: findings.filter(f => f.severity === 'high').length,
        medium: findings.filter(f => f.severity === 'medium').length,
        low: findings.filter(f => f.severity === 'low').length,
        info: findings.filter(f => f.severity === 'info').length
      };

      return {
        success: true,
        riskScore,
        riskLevel: riskScore >= 75 ? 'CRITICAL' : riskScore >= 50 ? 'HIGH' : riskScore >= 25 ? 'MEDIUM' : 'LOW',
        summary,
        findings,
        contractTypes: identifyContractTypes(code),
        solidityVersion: getSolidityVersion(code),
        analyzedAt: new Date().toISOString()
      };
    } catch (error) {
      this.logger.error(`Audit failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  async quickCheck(data) {
    try {
      const code = await this._resolveSource(data);
      if (!code) {
        return { success: false, error: 'No Solidity source code provided. Supply { code }.' };
      }

      const findings = [];

      // Critical only
      findings.push(...runPatterns(code, CRITICAL_PATTERNS, 'critical'));

      // High only
      findings.push(...runPatterns(code, HIGH_PATTERNS.filter(p => p.regex), 'high'));
      if (isPre080(code) && !hasSafeMath(code)) {
        findings.push({
          id: 'integer-overflow-pre-0.8',
          severity: 'high',
          description: HIGH_PATTERNS.find(p => p.id === 'integer-overflow-pre-0.8').description,
          line: 1
        });
      }

      const riskScore = calculateRiskScore(findings);

      return {
        success: true,
        riskScore,
        issuesFound: findings.length,
        findings,
        note: 'Quick check only covers critical and high severity patterns. Run a full audit for comprehensive analysis.',
        analyzedAt: new Date().toISOString()
      };
    } catch (error) {
      this.logger.error(`Quick check failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  async explain(data) {
    try {
      const code = await this._resolveSource(data);
      if (!code) {
        return { success: false, error: 'No Solidity source code provided. Supply { code }.' };
      }

      const types = identifyContractTypes(code);
      const functions = identifyKeyFunctions(code);
      const ver = getSolidityVersion(code);

      // Extract contract names
      const contractNames = [];
      const contractRegex = /(?:contract|interface|library)\s+(\w+)/g;
      let cm;
      while ((cm = contractRegex.exec(code)) !== null) {
        contractNames.push(cm[1]);
      }

      // Detect inheritance
      const inheritance = [];
      const inheritRegex = /contract\s+\w+\s+is\s+([^{]+)/g;
      let im;
      while ((im = inheritRegex.exec(code)) !== null) {
        inheritance.push(...im[1].split(',').map(s => s.trim()));
      }

      // Detect modifiers
      const modifiers = [];
      const modRegex = /modifier\s+(\w+)/g;
      let mm;
      while ((mm = modRegex.exec(code)) !== null) {
        modifiers.push(mm[1]);
      }

      // Detect events
      const events = [];
      const eventRegex = /event\s+(\w+)\s*\(/g;
      let em;
      while ((em = eventRegex.exec(code)) !== null) {
        events.push(em[1]);
      }

      // Build plain-English description
      const parts = [];

      if (contractNames.length > 0) {
        parts.push(`This file defines: ${contractNames.join(', ')}.`);
      }

      if (types.length > 0) {
        parts.push(`It implements the following standard(s): ${types.join(', ')}.`);
      } else {
        parts.push('It does not appear to implement a recognized token or governance standard.');
      }

      if (inheritance.length > 0) {
        parts.push(`It inherits from: ${inheritance.join(', ')}.`);
      }

      if (ver) {
        parts.push(`Compiled with Solidity ${ver.major}.${ver.minor}.${ver.patch}.`);
      }

      const publicFuncs = functions.filter(f => /public|external/.test(f.modifiers));
      if (publicFuncs.length > 0) {
        const funcList = publicFuncs.slice(0, 15).map(f => f.name);
        parts.push(`Key public/external functions (${publicFuncs.length} total): ${funcList.join(', ')}${publicFuncs.length > 15 ? '...' : ''}.`);
      }

      if (modifiers.length > 0) {
        parts.push(`Custom modifiers: ${modifiers.join(', ')}.`);
      }

      if (events.length > 0) {
        parts.push(`Events emitted: ${events.join(', ')}.`);
      }

      // Detect payable functions (accepts ETH)
      if (/payable/i.test(code)) {
        parts.push('The contract can receive native currency (has payable functions).');
      }

      // Proxy/upgradeable
      if (/delegatecall|implementation\s*\(\)|ERC1967|TransparentUpgradeable/i.test(code)) {
        parts.push('It uses a proxy/upgradeable pattern, meaning the logic can be changed after deployment.');
      }

      return {
        success: true,
        contractNames,
        types,
        solidityVersion: ver,
        functionCount: functions.length,
        publicFunctionCount: publicFuncs.length,
        modifiers,
        events,
        inheritance,
        explanation: parts.join(' '),
        functions: functions.slice(0, 30).map(f => ({
          name: f.name,
          params: f.params,
          visibility: f.modifiers,
          line: f.line
        }))
      };
    } catch (error) {
      this.logger.error(`Explain failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  // ── Source resolution ───────────────────────────────────────────────────

  async _resolveSource(data) {
    if (data.code && typeof data.code === 'string' && data.code.trim().length > 0) {
      return data.code;
    }

    if (data.address) {
      return await this._fetchFromExplorer(data.address, data.network || 'eth');
    }

    return null;
  }

  async _fetchFromExplorer(address, network) {
    const cacheKey = `source:${network}:${address}`;
    const cached = sourceCache.get(cacheKey);
    if (cached) {
      this.logger.info(`Using cached source for ${address} on ${network}`);
      return cached;
    }

    const config = EXPLORER_CONFIG[network.toLowerCase()];
    if (!config) {
      throw new Error(`Unsupported network: ${network}. Supported: ${Object.keys(EXPLORER_CONFIG).join(', ')}`);
    }

    const apiKey = process.env[config.envKey] || '';

    const url = `${config.url}?module=contract&action=getsourcecode&address=${encodeURIComponent(address)}${apiKey ? '&apikey=' + encodeURIComponent(apiKey) : ''}`;

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Explorer API returned HTTP ${response.status}`);
    }

    const json = await response.json();

    if (json.status !== '1' || !json.result || !json.result[0]) {
      const hint = apiKey ? '' : ' (no API key configured — get a free one from bscscan.com/etherscan.io)';
      throw new Error(`Could not fetch source from explorer: ${json.message || json.result || 'Unknown error'}${hint}`);
    }

    const sourceCode = json.result[0].SourceCode;
    if (!sourceCode || sourceCode.trim().length === 0) {
      throw new Error(`Contract ${address} is not verified on ${network} explorer`);
    }

    // Handle multi-file JSON source format (some explorers wrap sources in JSON)
    let resolvedSource = sourceCode;
    if (sourceCode.startsWith('{{') || sourceCode.startsWith('{')) {
      try {
        let parsed = sourceCode;
        // Double-braced format used by Etherscan for multi-file
        if (sourceCode.startsWith('{{')) {
          parsed = JSON.parse(sourceCode.slice(1, -1));
        } else {
          parsed = JSON.parse(sourceCode);
        }

        if (parsed.sources) {
          // Concatenate all source files
          resolvedSource = Object.values(parsed.sources)
            .map(s => s.content)
            .join('\n\n');
        }
      } catch {
        // Not JSON, use as-is
        resolvedSource = sourceCode;
      }
    }

    sourceCache.set(cacheKey, resolvedSource);
    this.logger.info(`Fetched and cached source for ${address} on ${network} (${resolvedSource.length} chars)`);
    return resolvedSource;
  }

  async cleanup() {
    sourceCache.flushAll();
    this.logger.info('ContractAudit plugin cleaned up');
  }
}
