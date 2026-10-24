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
        usage: 'auditScore [targetDirectory] [--level=fail|warn|ok]'
      },
      {
        command: 'getAuditLevels',
        description: 'Get the finding levels the auditor emits, most severe first',
        usage: 'getAuditLevels'
      },
      {
        command: 'clearAuditCache',
        description: 'Clear cached audit results to force a fresh audit',
        usage: 'clearAuditCache [targetDirectory]'
      }
    ];
    this.cache = new NodeCache({ stdTTL: 1800 });
  }

  async execute(params) {
    const { action, target, level } = params;

    try {
      switch (action) {
        case 'auditScore':
          return await this.getAuditScore(target, level);

        case 'getAuditLevels':
          return this.getAuditLevels();

        case 'clearAuditCache':
          return await this.clearAuditCache(target);

        default:
          return {
            success: false,
            error: 'Unknown action. Supported actions: auditScore, getAuditLevels, clearAuditCache'
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

  /**
   * The levels `auditProject` actually emits, ordered most severe first.
   *
   * Taken from the auditor's own output rather than invented: every finding it pushes
   * carries one of exactly these three. A filter offered against any other vocabulary
   * matches nothing at all, which is indistinguishable from a clean audit.
   */
  static LEVEL_RANK = { fail: 3, warn: 2, ok: 1 };

  getAuditLevels() {
    return {
      success: true,
      levels: {
        fail: 'A required signal is missing — this is what drags the score down',
        warn: 'Present but incomplete, or a recommended signal is absent',
        ok: 'Satisfied'
      },
      order: ['fail', 'warn', 'ok']
    };
  }

  async getAuditScore(targetDir = '.', levelFilter = null) {
    const cacheKey = `audit_${targetDir}_${levelFilter || 'all'}`;
    const cached = this.cache.get(cacheKey);
    if (cached) {
      this.logger.debug('Returning cached audit result');
      return cached;
    }

    try {
      const result = await auditProject(targetDir);

      // Show findings at or above the requested level. An unrecognised level is refused
      // rather than silently returning everything (or nothing): a filter that quietly
      // ignores its own argument reports a clean audit for a typo.
      const findings = Array.isArray(result.findings) ? result.findings : [];
      let filteredFindings = findings;
      if (levelFilter) {
        const floor = LoopAuditPlugin.LEVEL_RANK[levelFilter];
        if (!floor) {
          return {
            success: false,
            error: `Unknown level '${levelFilter}'. Supported: ${Object.keys(LoopAuditPlugin.LEVEL_RANK).join(', ')}`
          };
        }
        filteredFindings = findings.filter(f => (LoopAuditPlugin.LEVEL_RANK[f.level] || 0) >= floor);
      }

      const lines = [
        `## Loop Readiness: ${result.score}/100 (${result.level})`,
        result.assessment,
        ''
      ];
      if (levelFilter) {
        // Say what was hidden. The score is computed over ALL findings, so a filtered
        // list beside an unfiltered score reads as a contradiction without this line.
        lines.push(`_showing ${filteredFindings.length} of ${findings.length} findings at level ${levelFilter} or above_`, '');
      }

      for (const f of filteredFindings) {
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
        findings: filteredFindings,
        recommendations: result.recommendations,
        details: lines.join('\n')
      };

      this.cache.set(cacheKey, response);
      return response;
    } catch (err) {
      throw new Error(`Error running loop-audit: ${err.message}`);
    }
  }

  /**
   * Clear cached audit results, optionally scoped to a specific target directory.
   * Without a targetDir, all cached audit entries are flushed.
   * @param {string} [targetDir] - Optional directory to clear cache for
   * @returns {object} Success status and count of cleared entries
   */
  async clearAuditCache(targetDir = null) {
    try {
      if (targetDir) {
        // Delete the exact keys getAuditScore writes for this directory. A prefix
        // match on `audit_${targetDir}_` would also hit a sibling directory whose
        // name merely starts with this one plus an underscore (foo vs foo_bar).
        const suffixes = ['all', ...Object.keys(LoopAuditPlugin.LEVEL_RANK)];
        const cleared = this.cache.del(suffixes.map(s => `audit_${targetDir}_${s}`));
        this.logger.info(`Cleared ${cleared} cached audit entries for directory: ${targetDir}`);
        return {
          success: true,
          cleared,
          message: `Cleared ${cleared} cached audit entries for directory: ${targetDir}`
        };
      } else {
        // Flush entire cache
        const count = this.cache.getStats().keys;
        this.cache.flushAll();
        this.logger.info(`Cleared all ${count} cached audit entries`);
        return {
          success: true,
          cleared: count,
          message: `Cleared all ${count} cached audit entries`
        };
      }
    } catch (error) {
      this.logger.error('Error clearing audit cache:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }
}
