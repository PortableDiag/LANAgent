import { test } from 'node:test';
import assert from 'node:assert/strict';
import AgenticCommerceJob from '../../src/models/AgenticCommerceJob.js';

/**
 * Stub AgenticCommerceJob.aggregate to capture the pipeline passed to it.
 * Returns a restore function and a getter for the captured pipeline.
 */
function stubAggregate(result = []) {
    const original = AgenticCommerceJob.aggregate;
    let captured = null;
    AgenticCommerceJob.aggregate = function (pipeline) {
        captured = pipeline;
        return Promise.resolve(result);
    };
    return {
        getPipeline: () => captured,
        restore: () => { AgenticCommerceJob.aggregate = original; }
    };
}

function findStage(pipeline, op) {
    return pipeline.find((stage) => Object.prototype.hasOwnProperty.call(stage, op));
}

test('getExecutionPerformanceStats builds the expected aggregation pipeline', async () => {
    const stub = stubAggregate([]);
    try {
        await AgenticCommerceJob.getExecutionPerformanceStats();
        const pipeline = stub.getPipeline();

        assert.ok(Array.isArray(pipeline), 'pipeline should be an array');

        // $match filters on completed/rejected status with execution timestamps present
        const match = findStage(pipeline, '$match');
        assert.ok(match, 'pipeline has a $match stage');
        assert.deepEqual(match.$match.status, { $in: ['Completed', 'Rejected'] });
        assert.deepEqual(match.$match.executionStarted, { $exists: true });
        assert.deepEqual(match.$match.executionCompleted, { $exists: true });

        // $addFields computes executionTime = executionCompleted - executionStarted
        const addFields = findStage(pipeline, '$addFields');
        assert.ok(addFields, 'pipeline has an $addFields stage');
        assert.deepEqual(
            addFields.$addFields.executionTime,
            { $subtract: ['$executionCompleted', '$executionStarted'] }
        );

        // $group keys by serviceType and computes the stats
        const group = findStage(pipeline, '$group');
        assert.ok(group, 'pipeline has a $group stage');
        assert.equal(group.$group._id, '$serviceType');
        assert.ok(group.$group.avgExecutionTime, 'group computes avgExecutionTime');
        assert.ok(group.$group.minExecutionTime, 'group computes minExecutionTime');
        assert.ok(group.$group.maxExecutionTime, 'group computes maxExecutionTime');
        assert.ok(group.$group.successRate, 'group computes successRate');

        // $project surfaces serviceType and rounds successRate
        const project = findStage(pipeline, '$project');
        assert.ok(project, 'pipeline has a $project stage');
        assert.equal(project.$project.serviceType, '$_id');
        assert.equal(project.$project._id, 0);
        assert.deepEqual(project.$project.successRate, { $round: ['$successRate', 2] });
    } finally {
        stub.restore();
    }
});

test('getCompletionTrends builds the expected aggregation pipeline with day window', async () => {
    const stub = stubAggregate([]);
    try {
        const days = 7;
        const before = Date.now();
        await AgenticCommerceJob.getCompletionTrends({ days });
        const after = Date.now();
        const pipeline = stub.getPipeline();

        assert.ok(Array.isArray(pipeline), 'pipeline should be an array');

        // $match filters completed/rejected since startDate ~= now - days
        const match = findStage(pipeline, '$match');
        assert.ok(match, 'pipeline has a $match stage');
        assert.deepEqual(match.$match.status, { $in: ['Completed', 'Rejected'] });
        assert.ok(match.$match.createdAt && match.$match.createdAt.$gte instanceof Date,
            'createdAt.$gte is a Date');
        const expectedMin = before - days * 86400000;
        const expectedMax = after - days * 86400000;
        const actual = match.$match.createdAt.$gte.getTime();
        assert.ok(actual >= expectedMin - 1000 && actual <= expectedMax + 1000,
            'startDate is ~days before now');

        // Two $group stages: first by {date,status}, second by date
        const groups = pipeline.filter((s) => Object.prototype.hasOwnProperty.call(s, '$group'));
        assert.equal(groups.length, 2, 'pipeline has two $group stages');
        assert.deepEqual(groups[0].$group._id, {
            date: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
            status: '$status'
        });
        assert.equal(groups[1].$group._id, '$_id.date');

        // $addFields reduces completed/rejected counts
        const addFields = findStage(pipeline, '$addFields');
        assert.ok(addFields, 'pipeline has an $addFields stage');
        assert.ok(addFields.$addFields.completed && addFields.$addFields.completed.$reduce,
            'completed uses $reduce');
        assert.ok(addFields.$addFields.rejected && addFields.$addFields.rejected.$reduce,
            'rejected uses $reduce');

        // $project computes completionRate; $sort by date ascending
        const project = findStage(pipeline, '$project');
        assert.ok(project, 'pipeline has a $project stage');
        assert.equal(project.$project.date, '$_id');
        assert.ok(project.$project.completionRate, 'project computes completionRate');

        const sort = findStage(pipeline, '$sort');
        assert.ok(sort, 'pipeline has a $sort stage');
        assert.deepEqual(sort.$sort, { date: 1 });
    } finally {
        stub.restore();
    }
});

test('getCompletionTrends defaults to a 30 day window when called with no args', async () => {
    const stub = stubAggregate([]);
    try {
        const before = Date.now();
        await AgenticCommerceJob.getCompletionTrends();
        const after = Date.now();
        const pipeline = stub.getPipeline();
        const match = findStage(pipeline, '$match');
        const actual = match.$match.createdAt.$gte.getTime();
        const expectedMin = before - 30 * 86400000;
        const expectedMax = after - 30 * 86400000;
        assert.ok(actual >= expectedMin - 1000 && actual <= expectedMax + 1000,
            'defaults to 30 days');
    } finally {
        stub.restore();
    }
});
