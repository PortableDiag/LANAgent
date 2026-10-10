import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateExample, schemas } from '../../src/services/outputSchemas.js';
import { logger } from '../../src/utils/logger.js';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

const originalError = logger.error;

before(() => {
  logger.error = () => {}; // suppress error logging during tests
});

after(() => {
  logger.error = originalError;
});

describe('generateExample', () => {
  it('should generate a valid example for intent schema', () => {
    const example = generateExample('intent');
    assert.ok(example && typeof example === 'object');
    assert.strictEqual(typeof example.plugin, 'string');
    assert.strictEqual(typeof example.action, 'string');
    assert.strictEqual(typeof example.params, 'object');
    assert.strictEqual(typeof example.confidence, 'number');
    assert.strictEqual(typeof example.reasoning, 'string');
  });

  it('should apply overrides to generated example', () => {
    const example = generateExample('intent', { plugin: 'testPlugin', action: 'testAction' });
    assert.strictEqual(example.plugin, 'testPlugin');
    assert.strictEqual(example.action, 'testAction');
    // other fields remain generated
    assert.strictEqual(typeof example.params, 'object');
  });

  it('should throw for unknown schema name', () => {
    assert.throws(() => generateExample('nonexistent'), /Schema nonexistent not found/);
  });

  it('should generate example for chainAnalysis with nested steps', () => {
    const example = generateExample('chainAnalysis');
    assert.strictEqual(typeof example.isMultiStep, 'boolean');
    assert.ok(Array.isArray(example.steps));
    assert.ok(example.steps.length > 0);
    const step = example.steps[0];
    assert.strictEqual(typeof step.stepNumber, 'number');
    assert.strictEqual(typeof step.description, 'string');
    assert.strictEqual(typeof step.plugin, 'string');
    assert.strictEqual(typeof step.action, 'string');
    assert.strictEqual(typeof example.summary, 'string');
  });

  it('should use default values from schema when present', () => {
    const example = generateExample('reminder');
    assert.strictEqual(example.notificationMethod, 'telegram'); // default
    assert.strictEqual(example.minutes, 1); // honours minimum: 1
  });

  it('should use first enum value for enum properties', () => {
    const example = generateExample('search');
    assert.strictEqual(example.type, 'web'); // first enum value
  });

  it('should generate array with one item for array properties', () => {
    const example = generateExample('task');
    assert.ok(Array.isArray(example.tags));
    assert.strictEqual(example.tags.length, 1);
    assert.strictEqual(typeof example.tags[0], 'string');
  });

  it('should generate nested objects recursively', () => {
    const example = generateExample('reactThought');
    assert.ok(example.action && typeof example.action === 'object');
    assert.strictEqual(typeof example.action.tool, 'string');
    assert.ok(example.action.input && typeof example.action.input === 'object');
  });

  const ajv = new Ajv({ strict: false });
  addFormats(ajv);

  it('every schema yields an example that passes its own validation', () => {
    for (const name of Object.keys(schemas)) {
      // full JSON-schema validation (formats, integer, min/max)
      const validate = ajv.compile(schemas[name]);
      assert.ok(validate(generateExample(name)), `${name}: ${JSON.stringify(validate.errors)}`);
    }
  });

  it('honours format and minimum constraints', () => {
    assert.strictEqual(generateExample('email').to, 'user@example.com');
    assert.ok(generateExample('chainAnalysis').steps[0].stepNumber >= 1);
  });

  it('ignores prototype-polluting override keys and non-object overrides', () => {
    const ex = generateExample('intent', JSON.parse('{"__proto__": {"polluted": true}}'));
    assert.strictEqual(({}).polluted, undefined);
    assert.strictEqual(ex.polluted, undefined);
    assert.strictEqual(typeof generateExample('intent', null).plugin, 'string');
  });

  it('returns fresh objects (defaults are not shared references)', () => {
    const a = generateExample('intent');
    a.params.mutated = true;
    assert.strictEqual(generateExample('intent').params.mutated, undefined);
  });
});

it('validateData reads the error array validateJsonSchema returns', async () => {
  const { validateData, generateExample } = await import('../../src/services/outputSchemas.js');
  assert.equal(validateData('intent', generateExample('intent'), {}), true, 'a valid example passes');
  assert.equal(validateData('intent', 'not an object', {}), false, 'an invalid value fails');
});
