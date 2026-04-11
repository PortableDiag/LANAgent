/**
 * Strategy Evolution Service
 * Analyzes crypto strategy performance and proposes improvements through self-mod system
 */
import { logger as baseLogger } from '../../utils/logger.js';
import { strategyRegistry } from './strategies/StrategyRegistry.js';

const logger = baseLogger.child({ service: 'strategy-evolution' });

// Performance thresholds for triggering improvements
const THRESHOLDS = {
    minWinRate: 0.50,           // Below this triggers improvement
    minSharpeRatio: 0.5,        // Minimum acceptable Sharpe ratio
    maxDrawdown: 0.15,          // 15% max drawdown
    minConfidenceCorrelation: 0.3, // Correlation between confidence and actual results
    minTradesForAnalysis: 5,    // Need at least this many trades to analyze
    improvementCooldownHours: 24 // Wait between improvements
};

// Improvement types that can be proposed
const IMPROVEMENT_TYPES = {
    THRESHOLD_ADJUSTMENT: 'threshold_adjustment',
    CONFIDENCE_CALIBRATION: 'confidence_calibration',
    TIMING_OPTIMIZATION: 'timing_optimization',
    RISK_MANAGEMENT: 'risk_management',
    NEW_INDICATOR: 'new_indicator',
    STRATEGY_SWITCH: 'strategy_switch'
};

class StrategyEvolutionService {
    constructor() {
        this.lastAnalysis = null;
        this.lastImprovementTime = null;
        this.proposedImprovements = [];
        this.appliedImprovements = [];
        this.analysisHistory = [];
    }

    /**
     * Analyze all strategy performance and generate recommendations
     */
    async analyzePerformance() {
        logger.info('Starting strategy performance analysis');

        const analysis = {
            timestamp: new Date(),
            strategies: {},
            recommendations: [],
            overallHealth: 'good'
        };

        try {
            // Get performance data from all strategies
            const strategies = strategyRegistry.list();

            for (const strategyInfo of strategies) {
                const strategy = strategyRegistry.get(strategyInfo.name);
                if (!strategy) continue;

                const metrics = this.calculateMetrics(strategy);
                const issues = this.identifyIssues(metrics, strategy);
                const recommendations = this.generateRecommendations(issues, strategy);

                analysis.strategies[strategyInfo.name] = {
                    metrics,
                    issues,
                    recommendations,
                    isActive: strategyInfo.isActive
                };

                // Add to overall recommendations
                analysis.recommendations.push(...recommendations);
            }

            // Determine overall health
            const criticalIssues = analysis.recommendations.filter(r => r.priority === 'high');
            if (criticalIssues.length > 0) {
                analysis.overallHealth = 'needs_attention';
            }

            this.lastAnalysis = analysis;
            this.analysisHistory.push(analysis);

            // Keep only last 100 analyses
            if (this.analysisHistory.length > 100) {
                this.analysisHistory = this.analysisHistory.slice(-100);
            }

            logger.info(`Analysis complete: ${analysis.recommendations.length} recommendations`);
            return analysis;

        } catch (error) {
            logger.error('Failed to analyze strategy performance:', error);
            throw error;
        }
    }

    /**
     * Calculate performance metrics for a strategy
     */
    calculateMetrics(strategy) {
        const state = strategy.state;
        const history = state.performanceHistory || [];

        const metrics = {
            totalTrades: state.tradesExecuted || 0,
            proposedTrades: state.tradesProposed || 0,
            executionRate: 0,
            winRate: 0,
            totalPnL: state.totalPnL || 0,
            dailyPnL: state.dailyPnL || 0,
            averagePnLPerTrade: 0,
            maxDrawdown: 0,
            sharpeRatio: 0,
            confidenceAccuracy: 0,
            averageConfidence: 0,
            positionsHeld: Object.keys(state.positions || {}).length
        };

        if (metrics.proposedTrades > 0) {
            metrics.executionRate = metrics.totalTrades / metrics.proposedTrades;
        }

        if (history.length >= THRESHOLDS.minTradesForAnalysis) {
            // Calculate win rate
            const wins = history.filter(t => (t.pnl || 0) > 0).length;
            metrics.winRate = wins / history.length;

            // Calculate average PnL per trade
            const totalHistoryPnL = history.reduce((sum, t) => sum + (t.pnl || 0), 0);
            metrics.averagePnLPerTrade = totalHistoryPnL / history.length;

            // Calculate max drawdown
            let peak = 0;
            let maxDrawdown = 0;
            let runningPnL = 0;

            for (const trade of history) {
                runningPnL += trade.pnl || 0;
                if (runningPnL > peak) peak = runningPnL;
                const drawdown = peak > 0 ? (peak - runningPnL) / peak : 0;
                if (drawdown > maxDrawdown) maxDrawdown = drawdown;
            }
            metrics.maxDrawdown = maxDrawdown;

            // Calculate Sharpe ratio (simplified - using daily returns)
            const returns = history.map(t => t.pnl || 0);
            const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
            const variance = returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / returns.length;
            const stdDev = Math.sqrt(variance);
            metrics.sharpeRatio = stdDev > 0 ? avgReturn / stdDev : 0;

            // Calculate confidence accuracy (if confidence data exists)
            const tradesWithConfidence = history.filter(t => t.confidence !== undefined);
            if (tradesWithConfidence.length > 0) {
                metrics.averageConfidence = tradesWithConfidence.reduce((sum, t) => sum + t.confidence, 0) / tradesWithConfidence.length;

                // High confidence should correlate with wins
                const highConfidenceTrades = tradesWithConfidence.filter(t => t.confidence > 70);
                const highConfidenceWins = highConfidenceTrades.filter(t => (t.pnl || 0) > 0).length;
                metrics.confidenceAccuracy = highConfidenceTrades.length > 0
                    ? highConfidenceWins / highConfidenceTrades.length
                    : 0;
            }
        }

        return metrics;
    }

    /**
     * Identify performance issues based on metrics
     */
    identifyIssues(metrics, strategy) {
        const issues = [];

        if (metrics.totalTrades < THRESHOLDS.minTradesForAnalysis) {
            issues.push({
                type: 'insufficient_data',
                severity: 'info',
                message: `Only ${metrics.totalTrades} trades executed. Need ${THRESHOLDS.minTradesForAnalysis} for meaningful analysis.`
            });
            return issues; // Can't analyze further without enough data
        }

        // Win rate check
        if (metrics.winRate < THRESHOLDS.minWinRate) {
            issues.push({
                type: 'low_win_rate',
                severity: 'high',
                value: metrics.winRate,
                threshold: THRESHOLDS.minWinRate,
                message: `Win rate ${(metrics.winRate * 100).toFixed(1)}% is below threshold ${(THRESHOLDS.minWinRate * 100)}%`
            });
        }

        // Sharpe ratio check
        if (metrics.sharpeRatio < THRESHOLDS.minSharpeRatio) {
            issues.push({
                type: 'poor_risk_adjusted_returns',
                severity: 'medium',
                value: metrics.sharpeRatio,
                threshold: THRESHOLDS.minSharpeRatio,
                message: `Sharpe ratio ${metrics.sharpeRatio.toFixed(2)} is below threshold ${THRESHOLDS.minSharpeRatio}`
            });
        }

        // Drawdown check
        if (metrics.maxDrawdown > THRESHOLDS.maxDrawdown) {
            issues.push({
                type: 'excessive_drawdown',
                severity: 'high',
                value: metrics.maxDrawdown,
                threshold: THRESHOLDS.maxDrawdown,
                message: `Max drawdown ${(metrics.maxDrawdown * 100).toFixed(1)}% exceeds threshold ${(THRESHOLDS.maxDrawdown * 100)}%`
            });
        }

        // Confidence calibration check
        if (metrics.averageConfidence > 0 && metrics.confidenceAccuracy < THRESHOLDS.minConfidenceCorrelation) {
            issues.push({
                type: 'poor_confidence_calibration',
                severity: 'medium',
                value: metrics.confidenceAccuracy,
                threshold: THRESHOLDS.minConfidenceCorrelation,
                message: `High-confidence trades only win ${(metrics.confidenceAccuracy * 100).toFixed(1)}% of the time`
            });
        }

        // Execution rate check
        if (metrics.executionRate < 0.5) {
            issues.push({
                type: 'low_execution_rate',
                severity: 'low',
                value: metrics.executionRate,
                message: `Only ${(metrics.executionRate * 100).toFixed(1)}% of proposed trades are being executed`
            });
        }

        // Negative P&L trend
        if (metrics.totalPnL < 0 && metrics.totalTrades > 10) {
            issues.push({
                type: 'negative_pnl',
                severity: 'high',
                value: metrics.totalPnL,
                message: `Total P&L is negative ($${metrics.totalPnL.toFixed(2)}) after ${metrics.totalTrades} trades`
            });
        }

        return issues;
    }

    /**
     * Generate improvement recommendations based on identified issues
     */
    generateRecommendations(issues, strategy) {
        const recommendations = [];

        for (const issue of issues) {
            const rec = this.issueToRecommendation(issue, strategy);
            if (rec) {
                recommendations.push(rec);
            }
        }

        return recommendations;
    }

    /**
     * Convert an issue to a specific recommendation
     */
    issueToRecommendation(issue, strategy) {
        const strategyName = strategy.name;

        switch (issue.type) {
            case 'low_win_rate':
                return {
                    type: IMPROVEMENT_TYPES.THRESHOLD_ADJUSTMENT,
                    priority: 'high',
                    strategy: strategyName,
                    issue: issue.type,
                    title: `Adjust ${strategyName} thresholds for better win rate`,
                    description: `Win rate is ${(issue.value * 100).toFixed(1)}%. Consider tightening entry conditions or adjusting sell/buy thresholds.`,
                    suggestedChanges: {
                        sellThreshold: strategy.config.sellThreshold * 1.2, // Increase by 20%
                        buyThreshold: strategy.config.buyThreshold * 0.8   // Make less aggressive
                    },
                    estimatedImpact: 'major'
                };

            case 'poor_risk_adjusted_returns':
                return {
                    type: IMPROVEMENT_TYPES.RISK_MANAGEMENT,
                    priority: 'medium',
                    strategy: strategyName,
                    issue: issue.type,
                    title: `Improve risk management for ${strategyName}`,
                    description: `Sharpe ratio is ${issue.value.toFixed(2)}. Consider reducing position sizes or adding stop-loss mechanisms.`,
                    suggestedChanges: {
                        maxTradePercentage: Math.max(10, strategy.config.maxTradePercentage * 0.8)
                    },
                    estimatedImpact: 'moderate'
                };

            case 'excessive_drawdown':
                return {
                    type: IMPROVEMENT_TYPES.RISK_MANAGEMENT,
                    priority: 'high',
                    strategy: strategyName,
                    issue: issue.type,
                    title: `Reduce drawdown risk for ${strategyName}`,
                    description: `Max drawdown of ${(issue.value * 100).toFixed(1)}% is too high. Implement tighter risk controls.`,
                    suggestedChanges: {
                        dailyLossLimit: 5, // Reduce from default 10%
                        maxTradePercentage: 15 // Reduce from default 20%
                    },
                    estimatedImpact: 'major'
                };

            case 'poor_confidence_calibration':
                return {
                    type: IMPROVEMENT_TYPES.CONFIDENCE_CALIBRATION,
                    priority: 'medium',
                    strategy: strategyName,
                    issue: issue.type,
                    title: `Recalibrate confidence scoring for ${strategyName}`,
                    description: `High-confidence trades only succeed ${(issue.value * 100).toFixed(1)}% of the time. Confidence model needs adjustment.`,
                    suggestedChanges: {
                        minConfidenceThreshold: 75 // Require higher confidence
                    },
                    estimatedImpact: 'moderate'
                };

            case 'negative_pnl':
                // This is a critical issue - might need strategy switch
                if (Math.abs(issue.value) > 100) { // Lost more than $100
                    return {
                        type: IMPROVEMENT_TYPES.STRATEGY_SWITCH,
                        priority: 'high',
                        strategy: strategyName,
                        issue: issue.type,
                        title: `Consider switching from ${strategyName} strategy`,
                        description: `Cumulative P&L is significantly negative ($${issue.value.toFixed(2)}). Consider trying DCA or pausing trading.`,
                        suggestedChanges: {
                            switchTo: strategyName === 'native_maximizer' ? 'dca' : 'native_maximizer'
                        },
                        estimatedImpact: 'major'
                    };
                }
                return null;

            default:
                return null;
        }
    }

    /**
     * Apply a recommended improvement
     */
    async applyImprovement(recommendation) {
        logger.info(`Applying improvement: ${recommendation.title}`);

        try {
            const strategy = strategyRegistry.get(recommendation.strategy);
            if (!strategy) {
                throw new Error(`Strategy not found: ${recommendation.strategy}`);
            }

            // Record before state
            const beforeState = {
                config: { ...strategy.config },
                metrics: this.calculateMetrics(strategy)
            };

            // Apply changes based on type
            if (recommendation.type === IMPROVEMENT_TYPES.STRATEGY_SWITCH) {
                // Switch to recommended strategy
                strategyRegistry.setActive(recommendation.suggestedChanges.switchTo);
            } else {
                // Apply config changes
                for (const [key, value] of Object.entries(recommendation.suggestedChanges)) {
                    if (strategy.config.hasOwnProperty(key)) {
                        strategy.config[key] = value;
                    }
                }
            }

            // Record the improvement
            const improvement = {
                id: `imp_${Date.now()}`,
                recommendation,
                appliedAt: new Date(),
                beforeState,
                status: 'applied'
            };

            this.appliedImprovements.push(improvement);
            this.lastImprovementTime = new Date();

            logger.info(`Improvement applied successfully: ${improvement.id}`);
            return improvement;

        } catch (error) {
            logger.error('Failed to apply improvement:', error);
            throw error;
        }
    }

    /**
     * Create a feature request for a significant improvement
     * This integrates with the self-mod system
     */
    async createFeatureRequest(recommendation) {
        try {
            const FeatureRequest = (await import('../../models/FeatureRequest.js')).default;

            const request = new FeatureRequest({
                title: recommendation.title,
                description: recommendation.description,
                category: 'optimization',
                priority: recommendation.priority === 'high' ? 'high' : 'medium',
                status: 'submitted',
                source: 'auto-generated',
                relatedPlugin: 'cryptoStrategy',
                estimatedEffort: recommendation.estimatedImpact === 'major' ? 'medium' : 'small',
                implementationNotes: JSON.stringify({
                    type: recommendation.type,
                    strategy: recommendation.strategy,
                    suggestedChanges: recommendation.suggestedChanges,
                    issue: recommendation.issue,
                    generatedBy: 'strategy-evolution-service'
                })
            });

            await request.save();

            logger.info(`Created feature request for: ${recommendation.title}`);
            return request;

        } catch (error) {
            logger.error('Failed to create feature request:', error);
            return null;
        }
    }

    /**
     * Evaluate impact of applied improvements
     */
    async evaluateImprovements() {
        const evaluations = [];

        for (const improvement of this.appliedImprovements) {
            if (improvement.status !== 'applied') continue;

            // Skip if applied less than 24 hours ago
            const hoursSinceApplied = (Date.now() - new Date(improvement.appliedAt).getTime()) / (1000 * 60 * 60);
            if (hoursSinceApplied < 24) continue;

            const strategy = strategyRegistry.get(improvement.recommendation.strategy);
            if (!strategy) continue;

            const afterMetrics = this.calculateMetrics(strategy);
            const beforeMetrics = improvement.beforeState.metrics;

            const evaluation = {
                improvementId: improvement.id,
                recommendation: improvement.recommendation.title,
                beforeMetrics,
                afterMetrics,
                changes: {
                    winRateChange: afterMetrics.winRate - beforeMetrics.winRate,
                    pnlChange: afterMetrics.totalPnL - beforeMetrics.totalPnL,
                    sharpeChange: afterMetrics.sharpeRatio - beforeMetrics.sharpeRatio
                },
                outcome: 'neutral'
            };

            // Determine outcome
            if (evaluation.changes.winRateChange > 0.05 || evaluation.changes.sharpeChange > 0.1) {
                evaluation.outcome = 'positive';
            } else if (evaluation.changes.winRateChange < -0.05 || evaluation.changes.sharpeChange < -0.1) {
                evaluation.outcome = 'negative';
                // Consider rolling back
                evaluation.suggestRollback = true;
            }

            evaluations.push(evaluation);
            improvement.evaluation = evaluation;
            improvement.status = 'evaluated';
        }

        return evaluations;
    }

    /**
     * Get service status and summary
     */
    getStatus() {
        return {
            lastAnalysis: this.lastAnalysis?.timestamp,
            lastImprovement: this.lastImprovementTime,
            totalRecommendations: this.lastAnalysis?.recommendations?.length || 0,
            appliedImprovements: this.appliedImprovements.length,
            pendingEvaluations: this.appliedImprovements.filter(i => i.status === 'applied').length,
            analysisHistory: this.analysisHistory.length,
            thresholds: THRESHOLDS
        };
    }

    /**
     * Get detailed analysis report
     */
    getDetailedReport() {
        if (!this.lastAnalysis) {
            return { message: 'No analysis performed yet' };
        }

        return {
            analysis: this.lastAnalysis,
            appliedImprovements: this.appliedImprovements.slice(-10),
            recentHistory: this.analysisHistory.slice(-5)
        };
    }
}

// Export singleton
export const strategyEvolution = new StrategyEvolutionService();
export default strategyEvolution;
