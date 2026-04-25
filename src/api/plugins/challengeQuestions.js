import { BasePlugin } from '../core/basePlugin.js';
import crypto from 'crypto';
import NodeCache from 'node-cache';

export default class ChallengeQuestionsPlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'challengeQuestions';
    this.version = '1.0.0';
    this.description = 'Bot-filtering challenge questions — humans and AI pass, scripts fail';

    this.commands = [
      {
        command: 'generate',
        description: 'Generate challenge questions with a verification token (answers returned separately via verify)',
        usage: 'generate({ count: 3 })',
        examples: [
          'generate 5 challenge questions',
          'get bot filter questions'
        ]
      },
      {
        command: 'generateWithAnswers',
        description: 'Generate challenge questions with answers included (single request, self-hosted verification)',
        usage: 'generateWithAnswers({ count: 3 })',
        examples: [
          'generate challenge questions with answers',
          'get questions and answers for my registration form'
        ]
      },
      {
        command: 'verify',
        description: 'Verify answers to a previously generated challenge set',
        usage: 'verify({ token: "chq_...", answers: [{ id: 1, answer: "42" }] })',
        examples: [
          'verify challenge answers'
        ]
      },
      {
        command: 'types',
        description: 'List available question types and configuration',
        usage: 'types()',
        examples: [
          'what types of challenge questions are available'
        ]
      },
      {
        command: 'trackPerformance',
        description: 'Record verification results and get accuracy stats for adaptive difficulty',
        usage: 'trackPerformance({ userId: "user1", correct: 4, total: 5, questionTypes: ["arithmetic","logic"] })',
        examples: [
          'track challenge performance',
          'get challenge accuracy stats'
        ]
      }
    ];

    this.requiredCredentials = [];

    // Token store for server-side verification flow
    this.tokenStore = new NodeCache({ stdTTL: 600, checkperiod: 60 }); // 10 min TTL

    // Performance tracking store (24h TTL per user)
    this.performanceStore = new NodeCache({ stdTTL: 86400, checkperiod: 600 });
  }

  async initialize() {
    this.logger.info('ChallengeQuestions plugin initialized');
  }

  async execute(params) {
    const { action, ...data } = params;

    switch (action) {
      case 'generate':
        return this.generate(data);
      case 'generateWithAnswers':
        return this.generateWithAnswers(data);
      case 'verify':
        return this.verify(data);
      case 'types':
        return this.getTypes();
      case 'trackPerformance':
        return this.trackPerformance(data);
      default:
        return { success: false, error: `Unknown action: ${action}` };
    }
  }

  // ─── Actions ──────────────────────────────────────────────────────────

  /**
   * Generate questions + token. Answers held server-side for verify().
   */
  generate({ count }) {
    count = Math.min(Math.max(parseInt(count) || 3, 1), 20);
    const { questions, answers } = this.buildChallengeSet(count);

    const token = `chq_${crypto.randomBytes(24).toString('hex')}`;
    this.tokenStore.set(token, { answers, attempts: 0, maxAttempts: 3 });

    return {
      success: true,
      data: {
        token,
        expiresIn: 600,
        count: questions.length,
        questions
      }
    };
  }

  /**
   * Generate questions + answers in one shot.
   * Client handles verification themselves — no second request needed.
   */
  generateWithAnswers({ count }) {
    count = Math.min(Math.max(parseInt(count) || 3, 1), 20);
    const { questions, answers } = this.buildChallengeSet(count);

    // Merge answers into questions
    const questionsWithAnswers = questions.map(q => {
      const ans = answers.find(a => a.id === q.id);
      return {
        ...q,
        answer: ans.answer,
        acceptableAnswers: ans.acceptableAnswers
      };
    });

    return {
      success: true,
      data: {
        count: questionsWithAnswers.length,
        passThreshold: 0.7,
        questions: questionsWithAnswers
      }
    };
  }

  /**
   * Verify submitted answers against a stored token.
   */
  verify({ token, answers: submittedAnswers }) {
    if (!token || !submittedAnswers || !Array.isArray(submittedAnswers)) {
      return { success: false, error: 'token and answers[] are required' };
    }

    const challenge = this.tokenStore.get(token);
    if (!challenge) {
      return { success: false, error: 'Invalid or expired challenge token' };
    }

    challenge.attempts++;
    if (challenge.attempts > challenge.maxAttempts) {
      this.tokenStore.del(token);
      return { success: false, error: 'Max verification attempts exceeded' };
    }
    this.tokenStore.set(token, challenge);

    const results = challenge.answers.map(expected => {
      const submitted = submittedAnswers.find(a => a.id === expected.id);
      const userAnswer = String(submitted?.answer || '').toLowerCase().trim();
      const correct = expected.acceptableAnswers.some(acc => userAnswer === acc);
      return { id: expected.id, correct };
    });

    const correctCount = results.filter(r => r.correct).length;
    const total = challenge.answers.length;
    const passed = correctCount >= Math.ceil(total * 0.7);

    if (passed) this.tokenStore.del(token);

    return {
      success: true,
      data: {
        passed,
        score: correctCount,
        total,
        receipt: passed ? `cvr_${crypto.randomBytes(24).toString('hex')}` : null,
        results
      }
    };
  }

  getTypes() {
    return {
      success: true,
      data: {
        types: [
          { type: 'arithmetic', description: 'Math with written-out numbers (e.g., "What is twelve plus seven?")' },
          { type: 'sequence', description: 'Complete a number sequence' },
          { type: 'letter-count', description: 'Count letters in a word' },
          { type: 'odd-one-out', description: 'Identify the item that doesn\'t belong' },
          { type: 'reverse', description: 'Spell a word backwards' },
          { type: 'logic', description: 'Simple logic puzzles and trick questions' },
          { type: 'geography', description: 'Capital cities and basic geography' },
          { type: 'knowledge', description: 'General knowledge (science, nature, etc.)' }
        ],
        passThreshold: '70%',
        maxQuestions: 20,
        tokenExpiry: '10 minutes',
        maxVerifyAttempts: 3
      }
    };
  }

  // ─── Performance Tracking ─────────────────────────────────────────────

  trackPerformance({ userId, correct, total, questionTypes }) {
    if (!userId) return { success: false, error: 'userId is required' };
    if (correct == null || total == null) return { success: false, error: 'correct and total are required' };

    const key = `perf:${userId}`;
    const existing = this.performanceStore.get(key) || { attempts: 0, totalCorrect: 0, totalQuestions: 0, typeAccuracy: {} };

    existing.attempts++;
    existing.totalCorrect += Number(correct);
    existing.totalQuestions += Number(total);

    // Track per-type accuracy
    if (Array.isArray(questionTypes)) {
      for (const type of questionTypes) {
        if (!existing.typeAccuracy[type]) existing.typeAccuracy[type] = { correct: 0, total: 0 };
        existing.typeAccuracy[type].total++;
      }
    }

    this.performanceStore.set(key, existing);

    const accuracy = existing.totalQuestions > 0 ? existing.totalCorrect / existing.totalQuestions : 0;
    const difficulty = accuracy > 0.9 ? 'hard' : accuracy > 0.6 ? 'medium' : 'easy';

    return {
      success: true,
      data: {
        userId,
        attempts: existing.attempts,
        totalCorrect: existing.totalCorrect,
        totalQuestions: existing.totalQuestions,
        accuracy: Math.round(accuracy * 100) / 100,
        recommendedDifficulty: difficulty,
        typeAccuracy: existing.typeAccuracy
      }
    };
  }

  /**
   * Get recommended question types based on user performance.
   * Avoids types the user always gets right (too easy), biases toward weaker areas.
   */
  getAdaptiveWeights(userId) {
    if (!userId) return null;
    const stats = this.performanceStore.get(`perf:${userId}`);
    if (!stats || stats.attempts < 3) return null; // not enough data
    return stats.typeAccuracy;
  }

  // ─── Question Generators ──────────────────────────────────────────────

  buildChallengeSet(count) {
    const questions = [];
    const answers = [];
    const usedIndices = new Set();

    for (let i = 0; i < count; i++) {
      const available = this.generators.map((_, i) => i).filter(i => !usedIndices.has(i));
      const idx = available.length > 0
        ? available[Math.floor(Math.random() * available.length)]
        : Math.floor(Math.random() * this.generators.length);
      usedIndices.add(idx);

      const qa = this.generators[idx]();
      const types = ['arithmetic', 'sequence', 'letter-count', 'odd-one-out',
        'reverse', 'logic', 'geography', 'knowledge'];

      questions.push({ id: i + 1, question: qa.question, type: types[idx] || 'general' });
      const acceptable = (qa.acceptableAnswers || [qa.answer]).map(a => String(a).toLowerCase().trim());
      answers.push({ id: i + 1, answer: String(qa.answer).toLowerCase().trim(), acceptableAnswers: acceptable });
    }

    return { questions, answers };
  }

  get generators() {
    return [
      // 0: Arithmetic with words
      () => {
        const wordMap = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
          nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
          seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20 };
        const words = Object.keys(wordMap);
        const ops = [
          { sym: 'plus', fn: (a, b) => a + b },
          { sym: 'minus', fn: (a, b) => a - b },
          { sym: 'times', fn: (a, b) => a * b }
        ];
        const aWord = words[Math.floor(Math.random() * words.length)];
        const bWord = words[Math.floor(Math.random() * words.length)];
        const op = ops[Math.floor(Math.random() * ops.length)];
        return { question: `What is ${aWord} ${op.sym} ${bWord}?`, answer: String(op.fn(wordMap[aWord], wordMap[bWord])) };
      },

      // 1: Sequence completion
      () => {
        const start = Math.floor(Math.random() * 20) + 1;
        const step = Math.floor(Math.random() * 5) + 2;
        const seq = Array.from({ length: 4 }, (_, i) => start + i * step);
        return { question: `What comes next in the sequence: ${seq.join(', ')}, ?`, answer: String(start + 4 * step) };
      },

      // 2: Letter counting
      () => {
        const words = ['elephant', 'strawberry', 'computer', 'javascript', 'algorithm', 'umbrella',
          'beautiful', 'chocolate', 'adventure', 'pineapple', 'dinosaur', 'telescope', 'butterfly',
          'waterfall', 'moonlight'];
        const word = words[Math.floor(Math.random() * words.length)];
        return { question: `How many letters are in the word "${word}"?`, answer: String(word.length) };
      },

      // 3: Odd one out
      () => {
        const groups = [
          { items: ['dog', 'cat', 'hammer', 'rabbit'], odd: 'hammer' },
          { items: ['red', 'blue', 'piano', 'green'], odd: 'piano' },
          { items: ['Mars', 'Venus', 'London', 'Jupiter'], odd: 'London' },
          { items: ['Python', 'Java', 'banana', 'Rust'], odd: 'banana' },
          { items: ['guitar', 'violin', 'table', 'drums'], odd: 'table' },
          { items: ['circle', 'square', 'happiness', 'triangle'], odd: 'happiness' },
          { items: ['Monday', 'Friday', 'potato', 'Wednesday'], odd: 'potato' },
          { items: ['oxygen', 'gold', 'courage', 'helium'], odd: 'courage' }
        ];
        const group = groups[Math.floor(Math.random() * groups.length)];
        const shuffled = [...group.items].sort(() => Math.random() - 0.5);
        return { question: `Which word does not belong: ${shuffled.join(', ')}?`, answer: group.odd };
      },

      // 4: Reverse string
      () => {
        const words = ['hello', 'world', 'agent', 'crypto', 'pixel', 'solar', 'river', 'flame', 'storm', 'quest'];
        const word = words[Math.floor(Math.random() * words.length)];
        return { question: `What is "${word}" spelled backwards?`, answer: word.split('').reverse().join('') };
      },

      // 5: Simple logic
      () => {
        const scenarios = [
          { question: 'If all roses are flowers and some flowers fade quickly, can we say all roses fade quickly?', answer: 'no' },
          { question: 'If a box contains only red and blue balls, and you remove all the red ones, what color are the remaining balls?', answer: 'blue' },
          { question: 'A farmer has 17 sheep. All but 9 run away. How many sheep does the farmer have left?', answer: '9' },
          { question: 'If you have a bowl with six apples and you take away four, how many do you have?', answer: '4' },
          { question: 'Which is heavier: a pound of feathers or a pound of bricks?', answer: 'neither', acceptableAnswers: ['neither', 'same', 'they weigh the same', 'equal'] },
          { question: 'If there are 3 apples and you take away 2, how many apples do you have?', answer: '2' },
          { question: 'How many months have 28 days?', answer: '12', acceptableAnswers: ['12', 'all', 'all of them'] }
        ];
        return scenarios[Math.floor(Math.random() * scenarios.length)];
      },

      // 6: Capital cities
      () => {
        const capitals = [
          { country: 'France', capital: 'Paris' }, { country: 'Japan', capital: 'Tokyo' },
          { country: 'Brazil', capital: 'Brasilia' }, { country: 'Australia', capital: 'Canberra' },
          { country: 'Canada', capital: 'Ottawa' }, { country: 'Egypt', capital: 'Cairo' },
          { country: 'Germany', capital: 'Berlin' }, { country: 'Thailand', capital: 'Bangkok' },
          { country: 'South Korea', capital: 'Seoul' }, { country: 'Argentina', capital: 'Buenos Aires' }
        ];
        const c = capitals[Math.floor(Math.random() * capitals.length)];
        return { question: `What is the capital of ${c.country}?`, answer: c.capital };
      },

      // 7: General knowledge
      () => {
        const items = [
          { question: 'Name a color of the rainbow that starts with "R".', answer: 'red' },
          { question: 'What season comes after winter?', answer: 'spring' },
          { question: 'What planet is known as the Red Planet?', answer: 'mars' },
          { question: 'What is the boiling point of water in Celsius?', answer: '100' },
          { question: 'How many sides does a hexagon have?', answer: '6' },
          { question: 'What is the chemical symbol for water?', answer: 'h2o' },
          { question: 'What is the largest ocean on Earth?', answer: 'pacific', acceptableAnswers: ['pacific', 'pacific ocean'] },
          { question: 'How many continents are there?', answer: '7' }
        ];
        return items[Math.floor(Math.random() * items.length)];
      }
    ];
  }

  async getAICapabilities() {
    return {
      enabled: true,
      examples: this.commands.flatMap(cmd => cmd.examples || [])
    };
  }

  getCommands() {
    return this.commands.reduce((acc, cmd) => {
      acc[cmd.command] = cmd.description;
      return acc;
    }, {});
  }
}
