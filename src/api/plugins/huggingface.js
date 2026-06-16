import { BasePlugin } from '../core/basePlugin.js';
import { PluginSettings } from '../../models/PluginSettings.js';
import axios from 'axios';
import { logger } from '../../utils/logger.js';

// Default models per task — popular, reliable, serverless-ready
const DEFAULT_MODELS = {
  textGeneration:     'google/gemma-2-2b-it',
  textClassification: 'distilbert/distilbert-base-uncased-finetuned-sst-2-english',
  questionAnswering:  'deepset/roberta-base-squad2',
  textSummarization:  'facebook/bart-large-cnn',
  translation:        'Helsinki-NLP/opus-mt-en-fr',
  fillMask:           'google-bert/bert-base-uncased',
  sentimentAnalysis:  'distilbert/distilbert-base-uncased-finetuned-sst-2-english',
  zeroShotClassification: 'facebook/bart-large-mnli',
  featureExtraction:  'thenlper/gte-small',
  imageToText:        'Salesforce/blip-image-captioning-base',
  namedEntityRecognition: 'dslim/bert-base-NER',
  languageDetection:  'papluca/xlm-roberta-base-language-detection',
  textSimilarity:     'sentence-transformers/all-MiniLM-L6-v2',
  spamDetection:      'mrm8488/bert-tiny-finetuned-sms-spam-detection'
};

export default class HuggingFacePlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'huggingface';
    this.version = '2.0.0';
    this.description = 'HuggingFace AI inference — text generation, classification, summarization, translation, Q&A';

    this.requiredCredentials = [
      { key: 'apiKey', label: 'API Key', envVar: 'HUGGINGFACE_TOKEN', altEnvVars: ['HUGGING_FACE_API_KEY', 'HF_TOKEN'], required: true }
    ];

    this.commands = [
      {
        command: 'textGeneration',
        description: 'Generate text from a prompt (requires HF Pro — not available on free tier)',
        usage: 'textGeneration({ inputs: "Once upon a time", model: "gpt2" })',
        offerAsService: false
      },
      {
        command: 'textClassification',
        description: 'Classify text sentiment/category (default: DistilBERT SST-2)',
        usage: 'textClassification({ inputs: "I love this product" })',
        offerAsService: true
      },
      {
        command: 'questionAnswering',
        description: 'Answer a question given context (default: RoBERTa SQuAD2)',
        usage: 'questionAnswering({ question: "What is AI?", context: "AI stands for..." })',
        offerAsService: true
      },
      {
        command: 'textSummarization',
        description: 'Summarize long text (default: BART-large-CNN)',
        usage: 'textSummarization({ inputs: "Long article text..." })',
        offerAsService: true
      },
      {
        command: 'translation',
        description: 'Translate text between languages',
        usage: 'translation({ inputs: "Hello world", model: "Helsinki-NLP/opus-mt-en-fr" })',
        offerAsService: true
      },
      {
        command: 'fillMask',
        description: 'Fill in masked words in text (default: BERT)',
        usage: 'fillMask({ inputs: "The capital of France is [MASK]." })',
        offerAsService: true
      },
      {
        command: 'sentimentAnalysis',
        description: 'Analyze sentiment of text (positive/negative)',
        usage: 'sentimentAnalysis({ inputs: "I had a great day" })',
        offerAsService: true
      },
      {
        command: 'zeroShotClassification',
        description: 'Classify text into custom categories without training',
        usage: 'zeroShotClassification({ inputs: "I want to buy a car", candidate_labels: ["shopping","travel","finance"] })',
        offerAsService: true
      },
      {
        command: 'featureExtraction',
        description: 'Get text embeddings/vectors (default: all-MiniLM-L6-v2)',
        usage: 'featureExtraction({ inputs: "Some text to embed" })',
        offerAsService: true
      },
      {
        command: 'imageCaption',
        description: 'Generate a caption for an image (default: BLIP)',
        usage: 'imageCaption({ url: "https://example.com/image.jpg" })',
        examples: ['imageCaption({ url: "https://example.com/photo.jpg" })', 'imageCaption({ imageBase64: "<base64-string>" })'],
        offerAsService: true
      },
      {
        command: 'namedEntityRecognition',
        description: 'Extract named entities (persons, organizations, locations) from text (default: dslim/bert-base-NER)',
        usage: 'namedEntityRecognition({ text: "Hugging Face is based in New York City" })',
        examples: ['namedEntityRecognition({ text: "Apple was founded by Steve Jobs in California" })'],
        offerAsService: true
      },
      {
        command: 'languageDetection',
        description: 'Detect the language of a text (default: xlm-roberta-base-language-detection)',
        usage: 'languageDetection({ text: "Bonjour le monde" })',
        examples: ['languageDetection({ text: "Hola, ¿cómo estás?" })'],
        offerAsService: true
      },
      {
        command: 'textSimilarity',
        description: 'Compare two texts and return a cosine similarity score 0-1 (default: all-MiniLM-L6-v2)',
        usage: 'textSimilarity({ text1: "The cat sat on the mat", text2: "A cat is sitting on a rug" })',
        examples: ['textSimilarity({ text1: "I love dogs", text2: "I adore puppies" })'],
        offerAsService: true
      },
      {
        command: 'spamDetection',
        description: 'Classify text as spam or not spam (default: bert-tiny-finetuned-sms-spam-detection)',
        usage: 'spamDetection({ text: "Congratulations! You won a free iPhone" })',
        examples: ['spamDetection({ text: "Hey, are we still meeting for lunch?" })'],
        offerAsService: true
      },
      {
        command: 'listModels',
        description: 'Search HuggingFace model hub',
        usage: 'listModels({ search: "text-generation", limit: 10 })',
        offerAsService: false
      }
    ];

    this.config = {
      apiKey: null,
      inferenceUrl: 'https://router.huggingface.co/hf-inference/models',
      hubUrl: 'https://huggingface.co/api'
    };

    this.initialized = false;
  }

  async initialize() {
    try {
      const credentials = await this.loadCredentials(this.requiredCredentials);
      this.config.apiKey = credentials.apiKey;

      if (!this.config.apiKey) {
        logger.warn('HuggingFace: API key not configured');
        return;
      }

      this.initialized = true;
      logger.info('HuggingFace plugin v2.0 initialized');
    } catch (error) {
      logger.error('HuggingFace init failed:', error.message || error);
      throw error;
    }
  }

  async execute(params) {
    // Support both new-style execute({action, ...params}) and old-style execute(action, params)
    let action, data;
    if (typeof params === 'string') {
      action = params;
      data = arguments[1] || {};
    } else {
      ({ action, ...data } = params);
    }

    if (!action) {
      return { success: false, error: 'Action is required. Available: ' + this.commands.map(c => c.command).join(', ') };
    }

    // Lazy-load credentials if initialize() wasn't called
    if (!this.config.apiKey) {
      try {
        const credentials = await this.loadCredentials(this.requiredCredentials);
        this.config.apiKey = credentials.apiKey;
      } catch (e) {
        // Also try direct env var
        this.config.apiKey = process.env.HUGGINGFACE_TOKEN || process.env.HF_TOKEN || process.env.HUGGING_FACE_API_KEY;
      }
    }

    if (!this.config.apiKey) {
      return { success: false, error: 'HuggingFace API key not configured' };
    }

    try {
      switch (action) {
        case 'textGeneration':
          return await this.textGeneration(data);
        case 'textClassification':
        case 'sentimentAnalysis':
          return await this.runInference(data, action === 'sentimentAnalysis' ? 'sentimentAnalysis' : 'textClassification');
        case 'questionAnswering':
          return await this.questionAnswering(data);
        case 'textSummarization':
          return await this.runInference(data, 'textSummarization');
        case 'translation':
          return await this.runInference(data, 'translation');
        case 'fillMask':
          return await this.runInference(data, 'fillMask');
        case 'zeroShotClassification':
          return await this.zeroShotClassification(data);
        case 'featureExtraction':
          return await this.featureExtraction(data);
        case 'imageCaption':
          return await this.imageCaption(data);
        case 'namedEntityRecognition':
          return await this.namedEntityRecognition(data);
        case 'languageDetection':
          return await this.languageDetection(data);
        case 'textSimilarity':
          return await this.textSimilarity(data);
        case 'spamDetection':
          return await this.spamDetection(data);
        case 'listModels':
          return await this.listModels(data);
        default:
          return { success: false, error: `Unknown action: ${action}. Available: ${this.commands.map(c => c.command).join(', ')}` };
      }
    } catch (error) {
      logger.error(`HuggingFace ${action} failed:`, error.message || error);
      return { success: false, error: error.message || String(error) };
    }
  }

  /**
   * Call HuggingFace Inference API
   */
  async callInference(model, payload, options = {}) {
    const url = `${this.config.inferenceUrl}/${model}`;
    const timeout = options.timeout || 30000;

    try {
      const response = await axios.post(url, payload, {
        headers: {
          'Authorization': `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json'
        },
        timeout,
        // Don't throw on model loading (503)
        validateStatus: (status) => status < 500 || status === 503
      });

      // Model is loading — wait and retry once
      if (response.status === 503 && response.data?.estimated_time) {
        const waitTime = Math.min(response.data.estimated_time * 1000, 30000);
        logger.info(`HuggingFace model ${model} loading, waiting ${(waitTime/1000).toFixed(0)}s...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));

        const retry = await axios.post(url, payload, {
          headers: {
            'Authorization': `Bearer ${this.config.apiKey}`,
            'Content-Type': 'application/json'
          },
          timeout: timeout + waitTime
        });
        return retry.data;
      }

      if (response.status === 503) {
        throw new Error(`Model ${model} is loading. Try again in a few seconds.`);
      }

      if (response.status >= 400) {
        const errMsg = response.data?.error || response.data?.message || `HTTP ${response.status}`;
        throw new Error(errMsg);
      }

      return response.data;
    } catch (error) {
      if (error.response?.status === 404) {
        throw new Error(`Model "${model}" not found on HuggingFace`);
      }
      if (error.response?.status === 401) {
        throw new Error('Invalid HuggingFace API key');
      }
      throw error;
    }
  }

  /**
   * Generic inference runner for simple input→output tasks
   */
  async runInference(data, taskType) {
    const { inputs, model, ...rest } = data;
    if (!inputs) {
      return { success: false, error: `"inputs" is required for ${taskType}` };
    }

    const modelToUse = model || DEFAULT_MODELS[taskType];
    if (!modelToUse) {
      return { success: false, error: `No default model for ${taskType}. Please specify a model.` };
    }

    const result = await this.callInference(modelToUse, { inputs, ...rest });

    return {
      success: true,
      result: this.formatResult(result, taskType),
      data: result,
      model: modelToUse,
      task: taskType
    };
  }

  async textGeneration(data) {
    const { inputs, model, max_new_tokens, temperature, top_p, ...rest } = data;
    if (!inputs) {
      return { success: false, error: '"inputs" (prompt) is required for textGeneration' };
    }

    const modelToUse = model || DEFAULT_MODELS.textGeneration;
    const parameters = {};
    if (max_new_tokens) parameters.max_new_tokens = max_new_tokens;
    else parameters.max_new_tokens = 256;
    if (temperature) parameters.temperature = temperature;
    if (top_p) parameters.top_p = top_p;

    const result = await this.callInference(modelToUse, {
      inputs,
      parameters,
      ...rest
    });

    // Extract generated text
    const generated = Array.isArray(result) ? result[0]?.generated_text : result?.generated_text || result;

    return {
      success: true,
      result: typeof generated === 'string' ? generated : JSON.stringify(generated),
      data: result,
      model: modelToUse,
      task: 'textGeneration'
    };
  }

  async questionAnswering(data) {
    const { question, context, model } = data;
    if (!question) {
      return { success: false, error: '"question" is required for questionAnswering' };
    }
    if (!context) {
      return { success: false, error: '"context" is required for questionAnswering (the text to search for answers)' };
    }

    const modelToUse = model || DEFAULT_MODELS.questionAnswering;
    const result = await this.callInference(modelToUse, {
      inputs: { question, context }
    });

    return {
      success: true,
      result: `Answer: ${result.answer} (confidence: ${(result.score * 100).toFixed(1)}%)`,
      data: result,
      model: modelToUse,
      task: 'questionAnswering'
    };
  }

  async zeroShotClassification(data) {
    const { inputs, candidate_labels, labels, model, multi_label } = data;
    if (!inputs) {
      return { success: false, error: '"inputs" is required for zeroShotClassification' };
    }
    const labelList = candidate_labels || labels;
    if (!labelList || !Array.isArray(labelList) || labelList.length === 0) {
      return { success: false, error: '"candidate_labels" array is required (e.g., ["positive","negative","neutral"])' };
    }

    const modelToUse = model || DEFAULT_MODELS.zeroShotClassification;
    const payload = {
      inputs,
      parameters: {
        candidate_labels: labelList,
        multi_label: multi_label || false
      }
    };

    const result = await this.callInference(modelToUse, payload);

    // Result can be {labels:[], scores:[]} or {label, score} or [{label, score}]
    const parsed = Array.isArray(result) ? result[0] : result;
    let topLabel, topScore, ranking;

    if (parsed?.labels && Array.isArray(parsed.labels)) {
      topLabel = parsed.labels[0];
      topScore = parsed.scores?.[0];
      ranking = parsed.labels.map((l, i) => `${l}: ${((parsed.scores?.[i] || 0) * 100).toFixed(1)}%`).join(', ');
    } else if (parsed?.label) {
      topLabel = parsed.label;
      topScore = parsed.score;
      ranking = `${parsed.label}: ${((parsed.score || 0) * 100).toFixed(1)}%`;
    } else {
      topLabel = 'unknown';
      topScore = null;
      ranking = '';
    }
    const scoreStr = topScore != null ? ` (${(topScore * 100).toFixed(1)}%)` : '';

    return {
      success: true,
      result: `Classification: ${topLabel}${scoreStr}` + (ranking ? ` — Full: ${ranking}` : ''),
      data: parsed,
      model: modelToUse,
      task: 'zeroShotClassification'
    };
  }

  async featureExtraction(data) {
    const { inputs, model } = data;
    if (!inputs) {
      return { success: false, error: '"inputs" is required for featureExtraction' };
    }

    const modelToUse = model || DEFAULT_MODELS.featureExtraction;

    // Sentence-transformer models on HF router need source_sentence + sentences format
    const payload = {
      inputs: {
        source_sentence: typeof inputs === 'string' ? inputs : inputs[0],
        sentences: typeof inputs === 'string' ? [inputs] : inputs
      }
    };

    try {
      const result = await this.callInference(modelToUse, payload);
      return {
        success: true,
        result: `Similarity scores: ${Array.isArray(result) ? result.map(s => s.toFixed(4)).join(', ') : 'computed'}`,
        data: result,
        model: modelToUse,
        task: 'featureExtraction'
      };
    } catch (e) {
      // Fallback: try plain inputs format
      try {
        const result = await this.callInference(modelToUse, { inputs });
        return {
          success: true,
          result: `Embedding vector (${Array.isArray(result) ? result.length : '?'} dimensions)`,
          data: result,
          model: modelToUse,
          task: 'featureExtraction'
        };
      } catch (e2) {
        return { success: false, error: e2.message || String(e2) };
      }
    }
  }

  async imageCaption(data) {
    const { url, imageBase64, model } = data;
    if (!url && !imageBase64) {
      return { success: false, error: '"url" or "imageBase64" is required for imageCaption' };
    }

    const modelToUse = model || DEFAULT_MODELS.imageToText;

    try {
      let imageData;
      if (imageBase64) {
        imageData = Buffer.from(imageBase64, 'base64');
      } else {
        const response = await axios.get(url, { responseType: 'arraybuffer', timeout: 15000 });
        imageData = response.data;
      }

      const result = await axios.post(
        `${this.config.inferenceUrl}/${modelToUse}`,
        imageData,
        {
          headers: {
            'Authorization': `Bearer ${this.config.apiKey}`,
            'Content-Type': 'application/octet-stream'
          },
          timeout: 30000,
          validateStatus: (status) => status < 500 || status === 503
        }
      );

      if (result.status === 503) {
        throw new Error(`Model ${modelToUse} is loading. Try again in a few seconds.`);
      }
      if (result.status >= 400) {
        throw new Error(result.data?.error || `HTTP ${result.status}`);
      }

      const caption = Array.isArray(result.data)
        ? result.data[0]?.generated_text
        : result.data?.generated_text || result.data;

      return {
        success: true,
        result: typeof caption === 'string' ? caption : JSON.stringify(caption),
        data: result.data,
        model: modelToUse,
        task: 'imageCaption'
      };
    } catch (error) {
      logger.error('HuggingFace imageCaption failed:', error.message || error);
      return { success: false, error: error.message || String(error) };
    }
  }

  async namedEntityRecognition(data) {
    const { text, inputs, model } = data;
    const input = text || inputs;
    if (!input) {
      return { success: false, error: '"text" is required for namedEntityRecognition' };
    }

    const modelToUse = model || DEFAULT_MODELS.namedEntityRecognition;
    const result = await this.callInference(modelToUse, { inputs: input });

    const entities = Array.isArray(result) ? result : [];
    const summary = entities.length > 0
      ? entities.map(e => `${e.word} [${e.entity_group || e.entity}]`).join(', ')
      : 'No entities found';

    return {
      success: true,
      result: `Entities: ${summary}`,
      data: entities,
      model: modelToUse,
      task: 'namedEntityRecognition'
    };
  }

  async languageDetection(data) {
    const { text, inputs, model } = data;
    const input = text || inputs;
    if (!input) {
      return { success: false, error: '"text" is required for languageDetection' };
    }

    const modelToUse = model || DEFAULT_MODELS.languageDetection;
    const result = await this.callInference(modelToUse, { inputs: input });

    const scores = Array.isArray(result) ? (Array.isArray(result[0]) ? result[0] : result) : [result];
    const top = scores[0];
    const topLabel = top?.label || 'unknown';
    const topScore = top?.score;
    const scoreStr = topScore != null ? ` (${(topScore * 100).toFixed(1)}%)` : '';
    const ranking = scores.slice(0, 5).map(s => `${s.label}: ${((s.score || 0) * 100).toFixed(1)}%`).join(', ');

    return {
      success: true,
      result: `Language: ${topLabel}${scoreStr} — Top 5: ${ranking}`,
      data: scores,
      model: modelToUse,
      task: 'languageDetection'
    };
  }

  async textSimilarity(data) {
    const { text1, text2, model } = data;
    if (!text1 || !text2) {
      return { success: false, error: '"text1" and "text2" are both required for textSimilarity' };
    }

    const modelToUse = model || DEFAULT_MODELS.textSimilarity;

    // Use sentence-similarity format: source_sentence + sentences
    const payload = {
      inputs: {
        source_sentence: text1,
        sentences: [text2]
      }
    };

    try {
      const result = await this.callInference(modelToUse, payload);

      // Result is an array of similarity scores
      const similarity = Array.isArray(result) ? result[0] : result;
      const score = typeof similarity === 'number' ? similarity : parseFloat(similarity) || 0;
      const clampedScore = Math.max(0, Math.min(1, score));

      let verdict;
      if (clampedScore >= 0.95) verdict = 'identical';
      else if (clampedScore >= 0.8) verdict = 'very_similar';
      else if (clampedScore >= 0.6) verdict = 'similar';
      else if (clampedScore >= 0.4) verdict = 'somewhat_similar';
      else verdict = 'different';

      return {
        success: true,
        result: `Similarity: ${clampedScore.toFixed(4)} (${verdict})`,
        data: { similarity: clampedScore, verdict },
        model: modelToUse,
        task: 'textSimilarity'
      };
    } catch (error) {
      // Fallback: get raw embeddings and compute cosine similarity manually
      try {
        const [emb1, emb2] = await Promise.all([
          this.callInference(modelToUse, { inputs: text1 }),
          this.callInference(modelToUse, { inputs: text2 })
        ]);

        const vec1 = Array.isArray(emb1[0]) ? emb1[0] : emb1;
        const vec2 = Array.isArray(emb2[0]) ? emb2[0] : emb2;

        const similarity = this.cosineSimilarity(vec1, vec2);
        const clampedScore = Math.max(0, Math.min(1, similarity));

        let verdict;
        if (clampedScore >= 0.95) verdict = 'identical';
        else if (clampedScore >= 0.8) verdict = 'very_similar';
        else if (clampedScore >= 0.6) verdict = 'similar';
        else if (clampedScore >= 0.4) verdict = 'somewhat_similar';
        else verdict = 'different';

        return {
          success: true,
          result: `Similarity: ${clampedScore.toFixed(4)} (${verdict})`,
          data: { similarity: clampedScore, verdict },
          model: modelToUse,
          task: 'textSimilarity'
        };
      } catch (e2) {
        return { success: false, error: e2.message || String(e2) };
      }
    }
  }

  /**
   * Compute cosine similarity between two vectors
   */
  cosineSimilarity(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return 0;
    let dotProduct = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    return denominator === 0 ? 0 : dotProduct / denominator;
  }

  async spamDetection(data) {
    const { text, inputs, model } = data;
    const input = text || inputs;
    if (!input) {
      return { success: false, error: '"text" is required for spamDetection' };
    }

    const modelToUse = model || DEFAULT_MODELS.spamDetection;
    const result = await this.callInference(modelToUse, { inputs: input });

    const scores = Array.isArray(result) ? (Array.isArray(result[0]) ? result[0] : result) : [result];
    const top = scores[0];
    const label = top?.label || 'unknown';
    const score = top?.score;
    const scoreStr = score != null ? ` (${(score * 100).toFixed(1)}%)` : '';
    const isSpam = label.toLowerCase().includes('spam') && !label.toLowerCase().includes('not');

    return {
      success: true,
      result: `${isSpam ? 'SPAM' : 'Not spam'}: ${label}${scoreStr}`,
      data: { label, score, isSpam, allScores: scores },
      model: modelToUse,
      task: 'spamDetection'
    };
  }

  async listModels(data = {}) {
    const { search, task, limit } = data;
    const params = {
      limit: limit || 10,
      sort: 'downloads',
      direction: -1
    };
    if (search) params.search = search;
    if (task) params.pipeline_tag = task;

    try {
      const response = await axios.get(`${this.config.hubUrl}/models`, {
        params,
        headers: { 'Authorization': `Bearer ${this.config.apiKey}` },
        timeout: 10000
      });

      const models = response.data.map(m => ({
        id: m.modelId || m.id,
        task: m.pipeline_tag,
        downloads: m.downloads,
        likes: m.likes
      }));

      return {
        success: true,
        result: `Found ${models.length} models` + (search ? ` matching "${search}"` : ''),
        data: models,
        task: 'listModels'
      };
    } catch (error) {
      logger.error('HuggingFace listModels failed:', error.message || error);
      return { success: false, error: `Failed to list models: ${error.message}` };
    }
  }

  formatResult(result, taskType) {
    if (!result) return 'No result';

    switch (taskType) {
      case 'textClassification':
      case 'sentimentAnalysis': {
        const top = Array.isArray(result) ? (Array.isArray(result[0]) ? result[0][0] : result[0]) : result;
        return `${top.label}: ${(top.score * 100).toFixed(1)}%`;
      }
      case 'textSummarization': {
        const text = Array.isArray(result) ? result[0]?.summary_text : result?.summary_text;
        return text || JSON.stringify(result);
      }
      case 'translation': {
        const text = Array.isArray(result) ? result[0]?.translation_text : result?.translation_text;
        return text || JSON.stringify(result);
      }
      case 'fillMask': {
        if (Array.isArray(result)) {
          return result.slice(0, 5).map(r => `${r.token_str}: ${(r.score * 100).toFixed(1)}%`).join(', ');
        }
        return JSON.stringify(result);
      }
      case 'featureExtraction':
        return `Embedding vector (${Array.isArray(result) ? result.length : '?'} dimensions)`;
      default:
        return typeof result === 'string' ? result : JSON.stringify(result).substring(0, 500);
    }
  }

  async cleanup() {
    this.initialized = false;
  }
}
