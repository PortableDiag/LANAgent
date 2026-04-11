import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Project root is two levels up from src/utils/
const PROJECT_ROOT = path.resolve(__dirname, '../..');

export const DEPLOY_PATH = process.env.DEPLOY_PATH || PROJECT_ROOT;
export const DATA_PATH = process.env.DATA_PATH || path.join(DEPLOY_PATH, 'data');
export const LOGS_PATH = process.env.LOGS_PATH || path.join(DEPLOY_PATH, 'logs');
export const WORKSPACE_PATH = process.env.WORKSPACE_PATH || path.join(DEPLOY_PATH, 'workspace');
export const TEMP_PATH = process.env.TEMP_PATH || path.join(DEPLOY_PATH, 'temp');
export const UPLOADS_PATH = process.env.UPLOADS_PATH || path.join(DEPLOY_PATH, 'uploads');
export const REPO_PATH = process.env.AGENT_REPO_PATH || process.env.REPO_PATH || DEPLOY_PATH;
export const VENV_PATH = process.env.VENV_PATH || path.join(DEPLOY_PATH, 'venv-wakeword');
export const SCRIPTS_PATH = path.join(DEPLOY_PATH, 'scripts');
export const WAKE_WORD_MODELS_PATH = process.env.WAKE_WORD_MODEL_DIR || path.join(DEPLOY_PATH, 'wake_word_models');
export const WAKE_WORD_SAMPLES_PATH = process.env.WAKE_WORD_SAMPLE_DIR || path.join(DEPLOY_PATH, 'wake_word_samples');
