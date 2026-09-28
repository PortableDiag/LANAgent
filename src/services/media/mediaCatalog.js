import axios from 'axios';
import NodeCache from 'node-cache';
import { logger } from '../../utils/logger.js';

/**
 * Live model catalogs for the media settings (image, video, speech, transcription).
 *
 * Both sources are public and need no key, so the settings UI can offer every
 * model a provider currently serves instead of a hardcoded shortlist that goes
 * stale. OpenRouter lists what it routes; HuggingFace lists Hub models that have
 * at least one live inference provider, ranked by likes.
 */

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';
const HF_MODELS_URL = 'https://huggingface.co/api/models';
const CACHE_TTL_SECONDS = 6 * 60 * 60;
const TIMEOUT_MS = 15000;

export const MEDIA_TYPES = ['image', 'video', 'speech', 'transcription'];

const HF_PIPELINE_TAGS = {
    image: 'text-to-image',
    video: 'text-to-video',
    speech: 'text-to-speech',
    transcription: 'automatic-speech-recognition'
};

const cache = new NodeCache({ stdTTL: CACHE_TTL_SECONDS, checkperiod: 600, useClones: false });

async function cached(key, loader) {
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const value = await loader();
    cache.set(key, value);
    return value;
}

function enumValues(descriptor) {
    return descriptor?.type === 'enum' && Array.isArray(descriptor.values) ? descriptor.values : null;
}

async function loadOpenRouter(type) {
    if (type === 'image') {
        const { data } = await axios.get(`${OPENROUTER_BASE}/images/models`, { timeout: TIMEOUT_MS });
        return (data?.data || []).map(m => ({
            id: m.id,
            name: m.name || m.id,
            aspectRatios: enumValues(m.supported_parameters?.aspect_ratio),
            resolutions: enumValues(m.supported_parameters?.resolution),
            qualities: enumValues(m.supported_parameters?.quality)
        }));
    }
    if (type === 'video') {
        const { data } = await axios.get(`${OPENROUTER_BASE}/videos/models`, { timeout: TIMEOUT_MS });
        return (data?.data || []).map(m => ({
            id: m.id,
            name: m.name || m.id,
            durations: m.supported_durations || null,
            resolutions: m.supported_resolutions || null,
            aspectRatios: m.supported_aspect_ratios || null,
            generateAudio: m.generate_audio === true,
            pricing: m.pricing_skus || null
        }));
    }
    // speech / transcription only appear in the general catalog, filtered by modality
    const { data } = await axios.get(`${OPENROUTER_BASE}/models`, {
        params: { output_modalities: type },
        timeout: TIMEOUT_MS
    });
    return (data?.data || []).map(m => ({
        id: m.id,
        name: m.name || m.id,
        ...(type === 'speech' ? { voices: m.supported_voices || [] } : {}),
        pricing: m.pricing || null
    }));
}

async function loadHuggingFace(type) {
    const { data } = await axios.get(HF_MODELS_URL, {
        params: {
            pipeline_tag: HF_PIPELINE_TAGS[type],
            inference_provider: 'all',
            sort: 'likes',
            direction: -1,
            limit: 50
        },
        timeout: TIMEOUT_MS
    });
    return (Array.isArray(data) ? data : []).map(m => ({ id: m.id, name: m.id, likes: m.likes }));
}

/**
 * Models one source serves for one media type. Never throws: a catalog that
 * cannot be reached returns an empty list, and the UI keeps the saved value.
 */
export async function getMediaModels(source, type) {
    if (!MEDIA_TYPES.includes(type)) throw new Error(`Unknown media type: ${type}`);
    const loader = source === 'openrouter' ? loadOpenRouter
        : source === 'huggingface' ? loadHuggingFace
        : null;
    if (!loader) throw new Error(`Unknown catalog source: ${source}`);

    try {
        return await cached(`${source}:${type}`, () => loader(type));
    } catch (error) {
        logger.warn(`Media catalog ${source}/${type} unavailable: ${error.message}`);
        return [];
    }
}

/** Voices an OpenRouter speech model accepts; empty when unknown. */
export async function getOpenRouterVoices(model) {
    const models = await getMediaModels('openrouter', 'speech');
    return models.find(m => m.id === model)?.voices || [];
}

export default { getMediaModels, getOpenRouterVoices, MEDIA_TYPES };
