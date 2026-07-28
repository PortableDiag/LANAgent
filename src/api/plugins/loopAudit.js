import { BasePlugin } from '../core/basePlugin.js';
import { auditProject } from '@cobusgreyling/loop-audit/dist/auditor.js';
import NodeCache from 'node-cache';

export default class LoopAuditPlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'loopAudit';
    this.version = '1.0.0';
    this.description = 'Audit a project for Loop Readiness (L0-L3), cost observability, governance, and harness runtime signals';
    this.commands = [
      {
        command: 'auditScore',
        description: 'Audit the current project for Loop Readiness (L0-L3), cost observability, governance, and harness runtime signals',
        usage: 'auditScore [targetDirectory]'
      }
    ];
    this.cache = new NodeCache({ stdTTL: 1800 });
  }

  async execute(params) {
    const { action, target } = params;

    try {
      switch (action) {
        case 'auditScore':
          return await this.getAuditScore(target);

        default:
          return {
            success: false,
            error: 'Unknown action. Supported actions: auditScore'
          };
      }
    } catch (error) {
      this.logger.error(`Error executing ${action}:`, error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  async getAuditScore(targetDir = '.') {
    const cacheKey = `audit_${targetDir}`;
    const cached = this.cache.get(cacheKey);
    if (cached) {
      this.logger.debug('Returning cached audit result');
      return cached;
    }

    try {
      const result = await auditProject(targetDir);
      const lines = [
        `## Loop Readiness: ${result.score}/100 (${result.level})`,
        result.assessment,
        ''
      ];

      for (const f of result.findings) {
        const icon = f.level === 'ok' ? '✅' : f.level === 'warn' ? '⚠️' : '❌';
        lines.push(`- ${icon} ${f.message}`);
      }

      if (result.recommendations.length > 0) {
        lines.push('', '## Recommendations');
        for (const r of result.recommendations) lines.push(`- ${r}`);
      }

      const response = {
        success: true,
        score: result.score,
        level: result.level,
        findings: result.findings,
        recommendations: result.recommendations,
        details: lines.join('\n')
      };

      this.cache.set(cacheKey, response);
      return response;
    } catch (err) {
      throw new Error(`Error running loop-audit: ${err.message}`);
    }
  }
}
