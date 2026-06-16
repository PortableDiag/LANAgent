import axios from 'axios';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { logger } from '../../utils/logger.js';
import { safePromiseAll } from '../../utils/errorHandlers.js';

/**
 * AIML Music provider via AIML API (api.aimlapi.com)
 * Tries models in order of cost: stable-audio (cheapest), then minimax/music-2.0
 * Suno endpoint was deprecated by AIML API
 */
export class SunoProvider {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.baseUrl = 'https://api.aimlapi.com/v2/generate/audio';
    // Models ordered by credit cost (cheapest first)
    this.models = ['stable-audio', 'minimax/music-2.0'];
  }

  async generate(params) {
    const { prompt, genre, mood, style, instrumental = false, duration } = params;

    // Build style prompt from genre/mood/style
    const styleParts = [];
    if (genre) styleParts.push(genre);
    if (mood) styleParts.push(mood);
    if (style) styleParts.push(style);
    if (instrumental) styleParts.push('instrumental, no vocals');
    const stylePrompt = styleParts.length > 0
      ? styleParts.join(', ') + '. ' + prompt
      : prompt;

    // Try models in order until one works
    let lastError = null;
    for (const model of this.models) {
      try {
        logger.info(`Trying music model: ${model}`);
        const result = await this._generateWithModel(model, stylePrompt, prompt, instrumental, duration);
        return result;
      } catch (err) {
        logger.warn(`Model ${model} failed: ${err.message}`);
        lastError = err;
      }
    }
    throw lastError;
  }

  async _generateWithModel(model, stylePrompt, originalPrompt, instrumental, duration) {
    const body = { model, prompt: stylePrompt };

    // Model-specific params
    if (model === 'stable-audio') {
      body.seconds_total = Math.min(duration || 30, 47);
    } else if (model.includes('music-2.0')) {
      if (!instrumental) {
        body.lyrics = `[Verse]\n${originalPrompt}\n\n[Chorus]\n${originalPrompt}`;
      }
    }

    try {
      const response = await axios.post(this.baseUrl, body, {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        },
        timeout: 30000
      });

      const data = response.data;

      return {
        success: true,
        taskId: data.id || data.generation_id || null,
        status: data.status === 'completed' ? 'completed' : 'pending',
        title: `Song: ${originalPrompt.substring(0, 50)}`,
        audioUrl: data.audio_url || data.url || null,
        lyrics: originalPrompt,
        duration: data.duration || null,
        metadata: { ...data, model }
      };

    } catch (error) {
      const errDetail = error.response?.data;
      const errMsg = typeof errDetail?.error === 'string' ? errDetail.error
        : errDetail?.detail || errDetail?.message
        || (typeof errDetail === 'object' && errDetail ? JSON.stringify(errDetail) : null)
        || error.message;
      throw new Error(`${model}: ${errMsg}`);
    }
  }

  async generateBatch(prompts) {
    const results = await safePromiseAll(prompts.map(prompt => this.generate({ prompt })));
    return results;
  }

  async checkStatus(taskId) {
    try {
      const response = await axios.get(this.baseUrl, {
        params: { generation_id: taskId },
        headers: {
          'Authorization': `Bearer ${this.apiKey}`
        },
        timeout: 15000
      });

      const data = response.data;

      // AIML API returns status and audio URL when complete
      const status = data.status || 'unknown';
      let audioUrl = null;
      if (status === 'completed') {
        // Audio URL may be in various fields depending on model
        audioUrl = data.audio_url || data.url || data.audio_file?.url || null;
        // Some models return audio in a results array
        if (!audioUrl && Array.isArray(data.results) && data.results.length > 0) {
          audioUrl = data.results[0].audio_url || data.results[0].url || null;
        }
      }

      return {
        success: true,
        taskId: taskId,
        status: status,
        audioUrl: audioUrl,
        title: data.title || 'Generated Song',
        lyrics: data.lyrics || null,
        duration: data.duration || null,
        metadata: data
      };
    } catch (error) {
      const errDetail = error.response?.data;
      const errMsg = typeof errDetail?.error === 'string' ? errDetail.error
        : errDetail?.detail || errDetail?.message
        || (typeof errDetail === 'object' && errDetail ? JSON.stringify(errDetail) : null)
        || error.message;
      logger.error(`Music status check failed: ${errMsg}`, errDetail || error.message);
      throw new Error(`Music status check failed: ${errMsg}`);
    }
  }
}

/**
 * Mubert provider - real-time ambient/streaming music generation
 * Direct API integration
 */
export class MubertProvider {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.baseUrl = 'https://api-b2b.mubert.com/v2';
  }

  async generate(params) {
    const { prompt, duration = 30, genre, mood } = params;

    // Build tags from genre, mood, and prompt
    const tags = [];
    if (genre) tags.push(genre);
    if (mood) tags.push(mood);
    // Extract keywords from prompt for tags
    if (prompt) {
      const keywords = prompt.toLowerCase().split(/\s+/).filter(w => w.length > 3);
      tags.push(...keywords.slice(0, 5));
    }

    try {
      // First get available tags/channels
      const response = await axios.post(`${this.baseUrl}/RecordTrackTTM`, {
        method: 'RecordTrackTTM',
        params: {
          pat: this.apiKey,
          duration: Math.min(duration, 180), // Max 3 minutes
          tags: tags,
          mode: 'track',
          bitrate: 320
        }
      }, {
        headers: {
          'Content-Type': 'application/json'
        },
        timeout: 60000
      });

      const data = response.data;

      if (data.status === 1 || data.data?.tasks) {
        const taskId = data.data?.tasks?.[0]?.task_id || data.data?.task_id;
        return {
          success: true,
          taskId: taskId,
          status: 'pending',
          title: `Mubert: ${prompt || genre || 'Generated Track'}`,
          audioUrl: null,
          duration: duration,
          metadata: data.data
        };
      }

      // Direct URL response
      if (data.data?.download_link) {
        return {
          success: true,
          taskId: null,
          status: 'completed',
          title: `Mubert: ${prompt || genre || 'Generated Track'}`,
          audioUrl: data.data.download_link,
          duration: duration,
          metadata: data.data
        };
      }

      throw new Error(data.error?.text || 'Unexpected Mubert response');

    } catch (error) {
      logger.error('Mubert generation failed:', error.response?.data || error.message);
      throw new Error(`Mubert generation failed: ${error.response?.data?.error?.text || error.message}`);
    }
  }

  async generateBatch(prompts) {
    const results = await safePromiseAll(prompts.map(prompt => this.generate({ prompt })));
    return results;
  }

  async checkStatus(taskId) {
    try {
      const response = await axios.post(`${this.baseUrl}/TrackStatus`, {
        method: 'TrackStatus',
        params: {
          pat: this.apiKey,
          task_id: taskId
        }
      }, {
        headers: {
          'Content-Type': 'application/json'
        },
        timeout: 15000
      });

      const data = response.data;
      const task = data.data?.tasks?.[0] || data.data;

      return {
        success: true,
        taskId: taskId,
        status: task?.download_link ? 'completed' : 'pending',
        audioUrl: task?.download_link || null,
        title: `Mubert Track`,
        duration: task?.duration || null,
        metadata: task
      };
    } catch (error) {
      logger.error('Mubert status check failed:', error.response?.data || error.message);
      throw new Error(`Mubert status check failed: ${error.message}`);
    }
  }
}

/**
 * Soundverse provider - AI music with ethical licensing
 * Official API integration
 */
export class SoundverseProvider {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.baseUrl = 'https://api.soundverse.ai/v1';
  }

  async generate(params) {
    const { prompt, style, duration = 30, genre, mood } = params;

    const requestBody = {
      prompt: prompt,
      duration: Math.min(duration, 120)
    };
    if (style) requestBody.style = style;
    if (genre) requestBody.genre = genre;
    if (mood) requestBody.mood = mood;

    try {
      const response = await axios.post(`${this.baseUrl}/generate`, requestBody, {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        },
        timeout: 30000
      });

      const data = response.data;

      return {
        success: true,
        taskId: data.id || data.task_id || null,
        status: data.status || (data.audio_url ? 'completed' : 'pending'),
        title: data.title || `Soundverse: ${prompt}`,
        audioUrl: data.audio_url || data.url || null,
        duration: data.duration || duration,
        metadata: data
      };

    } catch (error) {
      logger.error('Soundverse generation failed:', error.response?.data || error.message);
      throw new Error(`Soundverse generation failed: ${error.response?.data?.error || error.message}`);
    }
  }

  async generateBatch(prompts) {
    const results = await safePromiseAll(prompts.map(prompt => this.generate({ prompt })));
    return results;
  }

  async checkStatus(taskId) {
    try {
      const response = await axios.get(`${this.baseUrl}/status/${taskId}`, {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`
        },
        timeout: 15000
      });

      const data = response.data;

      return {
        success: true,
        taskId: taskId,
        status: data.status || 'unknown',
        audioUrl: data.audio_url || data.url || null,
        title: data.title || 'Soundverse Track',
        duration: data.duration || null,
        metadata: data
      };
    } catch (error) {
      logger.error('Soundverse status check failed:', error.response?.data || error.message);
      throw new Error(`Soundverse status check failed: ${error.message}`);
    }
  }
}

/**
 * HuggingFace MusicGen provider - Meta's open-source music generation
 * Uses HF Inference API, returns audio bytes synchronously
 */
export class HuggingFaceProvider {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.baseUrl = 'https://api-inference.huggingface.co/models';
    // Models ordered by size/reliability on free tier
    this.models = ['facebook/musicgen-small', 'facebook/musicgen-medium'];
    this.maxRetries = 3;
  }

  async generate(params) {
    const { prompt, genre, mood, style, duration } = params;

    // Build descriptive prompt
    const parts = [];
    if (genre) parts.push(genre);
    if (mood) parts.push(mood);
    if (style) parts.push(style);
    parts.push(prompt);
    const fullPrompt = parts.join(', ');

    let lastError = null;
    for (const model of this.models) {
      try {
        logger.info(`HuggingFace: trying model ${model}`);
        const audioFile = await this._callModel(model, fullPrompt);
        return {
          success: true,
          taskId: null,
          status: 'completed',
          title: `MusicGen: ${prompt.substring(0, 50)}`,
          audioUrl: null,
          audioFile: audioFile,
          lyrics: null,
          duration: duration || 30,
          metadata: { model, prompt: fullPrompt }
        };
      } catch (err) {
        logger.warn(`HuggingFace model ${model} failed: ${err.message}`);
        lastError = err;
      }
    }
    throw lastError;
  }

  async _callModel(model, prompt) {
    let lastError = null;

    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        const response = await axios.post(
          `${this.baseUrl}/${model}`,
          { inputs: prompt },
          {
            headers: {
              'Authorization': `Bearer ${this.apiKey}`,
              'Content-Type': 'application/json'
            },
            responseType: 'arraybuffer',
            timeout: 120000
          }
        );

        // Check if we got audio bytes back
        const contentType = response.headers['content-type'] || '';
        if (contentType.includes('audio') || response.data.length > 1000) {
          // Save to temp file
          const ext = contentType.includes('flac') ? 'flac' : contentType.includes('wav') ? 'wav' : 'wav';
          const tempFile = path.join(os.tmpdir(), `lanagent-hf-music-${Date.now()}.${ext}`);
          fs.writeFileSync(tempFile, Buffer.from(response.data));
          logger.info(`HuggingFace: saved audio to ${tempFile} (${response.data.length} bytes)`);
          return tempFile;
        }

        // If response is JSON (error), parse it
        const text = Buffer.from(response.data).toString('utf-8');
        const json = JSON.parse(text);
        throw new Error(json.error || 'Unexpected response format');

      } catch (error) {
        if (error.response) {
          const status = error.response.status;
          // Model loading - wait and retry
          if (status === 503) {
            let waitTime = 20;
            try {
              const errData = JSON.parse(Buffer.from(error.response.data).toString('utf-8'));
              waitTime = errData.estimated_time || 20;
              logger.info(`HuggingFace: model loading, waiting ${waitTime}s (attempt ${attempt + 1}/${this.maxRetries})`);
            } catch {
              logger.info(`HuggingFace: model loading, waiting ${waitTime}s`);
            }
            await new Promise(r => setTimeout(r, waitTime * 1000));
            lastError = new Error(`Model still loading after ${this.maxRetries} attempts`);
            continue;
          }
          // Other HTTP errors
          let errMsg = `HTTP ${status}`;
          try {
            const errData = JSON.parse(Buffer.from(error.response.data).toString('utf-8'));
            errMsg = errData.error || errData.message || errMsg;
          } catch { /* ignore parse errors */ }
          lastError = new Error(errMsg);
        } else {
          lastError = error;
        }
        break;
      }
    }
    throw lastError;
  }

  async checkStatus(taskId) {
    // HuggingFace is synchronous - no polling needed
    return {
      success: true,
      taskId: taskId,
      status: 'completed',
      audioUrl: null,
      title: 'MusicGen Track',
      metadata: {}
    };
  }
}

/**
 * Factory to get provider instance
 */
export function getProvider(name, apiKey) {
  switch (name) {
    case 'suno':
      return new SunoProvider(apiKey);
    case 'mubert':
      return new MubertProvider(apiKey);
    case 'soundverse':
      return new SoundverseProvider(apiKey);
    case 'huggingface':
      return new HuggingFaceProvider(apiKey);
    default:
      throw new Error(`Unknown music provider: ${name}`);
  }
}
