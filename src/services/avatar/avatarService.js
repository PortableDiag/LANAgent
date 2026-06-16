import path from 'path';
import fs from 'fs/promises';
import crypto from 'crypto';
import { logger } from '../../utils/logger.js';
import { Avatar } from '../../models/Avatar.js';
import walletService from '../crypto/walletService.js';
import contractServiceWrapper from '../crypto/contractServiceWrapper.js';
import { decrypt } from '../../utils/encryption.js';
import { DATA_PATH } from '../../utils/paths.js';

const AVATAR_NFT_ABI = [
    'function mintAvatar(address to, string tokenURI, uint256 agentId) returns (uint256)',
    'function updateAvatar(uint256 tokenId, string newTokenURI)',
    'function getAvatarByAgent(uint256 agentId) view returns (uint256)'
];

class AvatarService {
    constructor() {
        this.contractAddress = null;
        this.network = 'bsc';
        this._initialized = false;
        this.dataDir = path.join(DATA_PATH, 'avatars');
    }

    async initialize() {
        try {
            const { SystemSettings } = await import('../../models/SystemSettings.js');
            this.contractAddress = await SystemSettings.getSetting(
                'avatar_nft_contract_address',
                process.env.AVATAR_NFT_CONTRACT_ADDRESS || ''
            );

            await fs.mkdir(this.dataDir, { recursive: true });
            await fs.mkdir(path.join(this.dataDir, 'photos'), { recursive: true });
            await fs.mkdir(path.join(this.dataDir, 'models'), { recursive: true });
            await fs.mkdir(path.join(this.dataDir, 'thumbnails'), { recursive: true });

            this._initialized = true;
            logger.info(`AvatarService initialized: dataDir=${this.dataDir}, contract=${this.contractAddress || 'none'}`);
        } catch (err) {
            logger.error(`AvatarService init failed: ${err.message}`);
        }
    }

    // ── Photo → 3D Pipeline ──────────────────────────────────────────

    async createFromPhoto(photoBuffer, options = {}) {
        if (!this._initialized) await this.initialize();

        const agentName = process.env.AGENT_NAME || 'LANAgent';
        const avatarId = crypto.randomUUID();
        const sourceHash = crypto.createHash('sha256').update(photoBuffer).digest('hex');

        // Save source photo
        const photoPath = path.join(this.dataDir, 'photos', `${avatarId}.jpg`);
        await fs.writeFile(photoPath, photoBuffer);

        // Call external 3D generation API — cascades through providers on failure/quota
        const provider = options.provider || this._getDefaultProvider();
        let modelData;
        const inputData = { buffer: photoBuffer, path: photoPath };

        if (provider === 'meshy') {
            modelData = await this._callMeshyAPI(inputData, 'photo');
        } else if (provider === 'tripo') {
            modelData = await this._callTripoAPI(inputData, 'photo');
        } else {
            // HuggingFace Space cascade via Python gradio_client
            // The Python client handles ZeroGPU auth correctly (JS @gradio/client does not)
            // Cascade order: Hunyuan3D-2.1 → Hunyuan3D-2 → TRELLIS
            modelData = await this._callHFPythonBridge(inputData, avatarId);
        }

        // Save model
        const modelPath = path.join(this.dataDir, 'models', `${avatarId}.glb`);
        await fs.writeFile(modelPath, modelData);

        // Generate thumbnail
        const thumbnailPath = path.join(this.dataDir, 'thumbnails', `${avatarId}.png`);
        await this._generateThumbnail(modelPath, thumbnailPath);

        const avatar = await Avatar.create({
            avatarId,
            owner: options.owner || null,
            agentName,
            agentId: options.agentId || 0,
            baseModelPath: modelPath,
            bakedModelPath: modelPath,
            thumbnailPath,
            sourceType: 'photo',
            sourceHash,
            format: 'glb',
            version: 1,
            customizations: options.customizations || {}
        });

        logger.info(`Avatar created from photo: ${avatarId} by ${agentName}`);

        // Pin to IPFS in the background (non-blocking, won't fail the create)
        this.pinAvatarToIPFS(avatarId).catch(err => {
            logger.warn(`Post-create IPFS pinning failed for ${avatarId}: ${err.message}`);
        });

        return avatar;
    }

    async createFromPrompt(textPrompt, options = {}) {
        if (!this._initialized) await this.initialize();

        const agentName = process.env.AGENT_NAME || 'LANAgent';
        const avatarId = crypto.randomUUID();
        const sourceHash = crypto.createHash('sha256').update(textPrompt).digest('hex');

        const provider = options.provider || this._getDefaultProvider();
        let modelData;
        try {
            if (provider === 'trellis') {
                // TRELLIS doesn't support text-to-3D directly; fall back to meshy/tripo if available
                if (process.env.MESHY_API_KEY) {
                    modelData = await this._callMeshyAPI({ prompt: textPrompt }, 'prompt');
                } else if (process.env.TRIPO_API_KEY) {
                    modelData = await this._callTripoAPI({ prompt: textPrompt }, 'prompt');
                } else {
                    throw new Error('Text-to-3D requires MESHY_API_KEY or TRIPO_API_KEY. Use photo upload instead (free via TRELLIS).');
                }
            } else if (provider === 'tripo') {
                modelData = await this._callTripoAPI({ prompt: textPrompt }, 'prompt');
            } else {
                modelData = await this._callMeshyAPI({ prompt: textPrompt }, 'prompt');
            }
        } catch (err) {
            logger.error(`3D generation from prompt failed for avatar ${avatarId}: ${err.message}`);
            throw new Error(`3D model generation failed: ${err.message}`);
        }

        const modelPath = path.join(this.dataDir, 'models', `${avatarId}.glb`);
        await fs.writeFile(modelPath, modelData);

        const thumbnailPath = path.join(this.dataDir, 'thumbnails', `${avatarId}.png`);
        await this._generateThumbnail(modelPath, thumbnailPath);

        const avatar = await Avatar.create({
            avatarId,
            owner: options.owner || null,
            agentName,
            agentId: options.agentId || 0,
            baseModelPath: modelPath,
            bakedModelPath: modelPath,
            thumbnailPath,
            sourceType: 'prompt',
            sourceHash,
            format: 'glb',
            version: 1,
            customizations: options.customizations || {}
        });

        logger.info(`Avatar created from prompt: ${avatarId} by ${agentName}`);

        // Pin to IPFS in the background (non-blocking, won't fail the create)
        this.pinAvatarToIPFS(avatarId).catch(err => {
            logger.warn(`Post-create IPFS pinning failed for ${avatarId}: ${err.message}`);
        });

        return avatar;
    }

    async _callMeshyAPI(inputData, type) {
        const apiKey = process.env.MESHY_API_KEY;
        if (!apiKey) throw new Error('MESHY_API_KEY not configured');

        const baseUrl = 'https://api.meshy.ai/v2';
        let taskId;

        if (type === 'photo') {
            // Image-to-3D
            const formData = new FormData();
            formData.append('image', new Blob([inputData.buffer]), 'avatar.jpg');
            formData.append('enable_pbr', 'true');

            const createRes = await fetch(`${baseUrl}/image-to-3d`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${apiKey}` },
                body: formData
            });

            if (!createRes.ok) {
                const errText = await createRes.text();
                throw new Error(`Meshy API error: ${createRes.status} ${errText}`);
            }
            const createData = await createRes.json();
            taskId = createData.result;
        } else {
            // Text-to-3D
            const createRes = await fetch(`${baseUrl}/text-to-3d`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    prompt: inputData.prompt,
                    art_style: 'realistic',
                    negative_prompt: 'low quality, blurry'
                })
            });

            if (!createRes.ok) {
                const errText = await createRes.text();
                throw new Error(`Meshy API error: ${createRes.status} ${errText}`);
            }
            const createData = await createRes.json();
            taskId = createData.result;
        }

        // Poll for completion
        const maxAttempts = 120;
        for (let i = 0; i < maxAttempts; i++) {
            await new Promise(resolve => setTimeout(resolve, 5000));

            const statusRes = await fetch(`${baseUrl}/text-to-3d/${taskId}`, {
                headers: { 'Authorization': `Bearer ${apiKey}` }
            });

            if (!statusRes.ok) continue;
            const statusData = await statusRes.json();

            if (statusData.status === 'SUCCEEDED') {
                const modelUrl = statusData.model_urls?.glb;
                if (!modelUrl) throw new Error('No GLB URL in Meshy response');

                const modelRes = await fetch(modelUrl);
                if (!modelRes.ok) throw new Error('Failed to download model from Meshy');
                return Buffer.from(await modelRes.arrayBuffer());
            }

            if (statusData.status === 'FAILED') {
                throw new Error(`Meshy task failed: ${statusData.task_error || 'unknown error'}`);
            }
        }

        throw new Error('Meshy task timed out after 10 minutes');
    }

    async _callTripoAPI(inputData, type) {
        const apiKey = process.env.TRIPO_API_KEY;
        if (!apiKey) throw new Error('TRIPO_API_KEY not configured');

        const baseUrl = 'https://api.tripo3d.ai/v2/openapi';
        let taskId;

        if (type === 'photo') {
            // Upload image first
            const formData = new FormData();
            formData.append('file', new Blob([inputData.buffer]), 'avatar.jpg');

            const uploadRes = await fetch(`${baseUrl}/upload`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${apiKey}` },
                body: formData
            });

            if (!uploadRes.ok) {
                const errText = await uploadRes.text();
                throw new Error(`Tripo upload error: ${uploadRes.status} ${errText}`);
            }
            const uploadData = await uploadRes.json();
            const fileToken = uploadData.data?.image_token;

            const createRes = await fetch(`${baseUrl}/task`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    type: 'image_to_model',
                    file: { type: 'jpg', file_token: fileToken }
                })
            });

            if (!createRes.ok) {
                const errText = await createRes.text();
                throw new Error(`Tripo task error: ${createRes.status} ${errText}`);
            }
            const createData = await createRes.json();
            taskId = createData.data?.task_id;
        } else {
            const createRes = await fetch(`${baseUrl}/task`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    type: 'text_to_model',
                    prompt: inputData.prompt
                })
            });

            if (!createRes.ok) {
                const errText = await createRes.text();
                throw new Error(`Tripo task error: ${createRes.status} ${errText}`);
            }
            const createData = await createRes.json();
            taskId = createData.data?.task_id;
        }

        // Poll for completion
        const maxAttempts = 120;
        for (let i = 0; i < maxAttempts; i++) {
            await new Promise(resolve => setTimeout(resolve, 5000));

            const statusRes = await fetch(`${baseUrl}/task/${taskId}`, {
                headers: { 'Authorization': `Bearer ${apiKey}` }
            });

            if (!statusRes.ok) continue;
            const statusData = await statusRes.json();
            const task = statusData.data;

            if (task?.status === 'success') {
                const modelUrl = task.output?.model;
                if (!modelUrl) throw new Error('No model URL in Tripo response');

                const modelRes = await fetch(modelUrl);
                if (!modelRes.ok) throw new Error('Failed to download model from Tripo');
                return Buffer.from(await modelRes.arrayBuffer());
            }

            if (task?.status === 'failed') {
                throw new Error(`Tripo task failed: ${task.error || 'unknown error'}`);
            }
        }

        throw new Error('Tripo task timed out after 10 minutes');
    }

    /**
     * Pick the best available provider. TRELLIS is free (no key), so it's the default.
     */
    _getDefaultProvider() {
        if (process.env.MESHY_API_KEY) return 'meshy';
        if (process.env.TRIPO_API_KEY) return 'tripo';
        return 'trellis'; // free, no API key needed
    }

    /**
     * Bridge to Python gradio_client for HuggingFace Space 3D generation.
     * The Python client handles ZeroGPU auth correctly (JS @gradio/client doesn't
     * properly pass Pro tier credentials to the ZeroGPU quota system).
     * Cascade: Hunyuan3D-2.1 → Hunyuan3D-2 → TRELLIS
     */
    async _callHFPythonBridge(inputData, avatarId) {
        const { execFile } = await import('child_process');
        const { promisify } = await import('util');
        const execFileAsync = promisify(execFile);

        const hfToken = process.env.HUGGINGFACE_TOKEN || process.env.HF_TOKEN;
        if (!hfToken) {
            throw new Error('HuggingFace token required (set HUGGINGFACE_TOKEN)');
        }

        // Write input image to temp file
        const tmpInput = path.join(this.dataDir, `_hf_input_${Date.now()}.png`);
        const tmpOutput = path.join(this.dataDir, `_hf_output_${Date.now()}.glb`);
        await fs.writeFile(tmpInput, inputData.buffer);

        // Find the Python helper script
        const scriptDir = path.resolve(import.meta.dirname || path.dirname(new URL(import.meta.url).pathname), '../../../scripts');
        const scriptPath = path.join(scriptDir, 'hf-3d-generate.py');

        try {
            logger.info(`Avatar ${avatarId}: starting Python 3D generation bridge...`);

            const { stdout, stderr } = await execFileAsync('python3', [scriptPath, tmpInput, tmpOutput], {
                env: { ...process.env, HF_TOKEN: hfToken, HUGGINGFACE_TOKEN: hfToken },
                timeout: 300000, // 5 min max
                maxBuffer: 10 * 1024 * 1024
            });

            // Log stderr (progress messages)
            if (stderr) {
                for (const line of stderr.split('\n').filter(l => l.trim())) {
                    logger.info(`Avatar HF: ${line}`);
                }
            }

            // Parse JSON result from stdout — Gradio/HF may print loading messages before the JSON
            let jsonStr = stdout.trim();
            const jsonStart = jsonStr.indexOf('{');
            if (jsonStart > 0) {
                logger.debug(`Avatar HF: stripping ${jsonStart} bytes of non-JSON prefix from stdout`);
                jsonStr = jsonStr.slice(jsonStart);
            }
            const result = JSON.parse(jsonStr);

            if (!result.success) {
                throw new Error(result.error || '3D generation failed');
            }

            logger.info(`Avatar ${avatarId}: ${result.space} generated GLB in ${result.elapsed}s (${(result.size / 1024).toFixed(0)}KB)`);

            // Read the output GLB file
            const glbBuffer = await fs.readFile(tmpOutput);
            if (glbBuffer.length < 100) {
                throw new Error('Generated GLB file too small');
            }

            return glbBuffer;
        } catch (err) {
            // Handle execFile errors (timeout, exit code, etc.)
            if (err.killed) {
                throw new Error('3D generation timed out (5 min limit)');
            }
            // Try to parse JSON error from stdout if available
            if (err.stdout) {
                try {
                    let errJson = err.stdout.trim();
                    const errJsonStart = errJson.indexOf('{');
                    if (errJsonStart > 0) errJson = errJson.slice(errJsonStart);
                    const result = JSON.parse(errJson);
                    if (!result.success) {
                        const msg = result.error || 'Unknown error';
                        if (msg.includes('quota')) {
                            throw new Error('ZeroGPU daily quota exhausted. Free tier: 4 min/day. Pro ($9/mo): ~25 min/day. Quota resets daily.');
                        }
                        throw new Error(`3D generation failed: ${msg}`);
                    }
                } catch (parseErr) {
                    if (parseErr.message.includes('3D generation')) throw parseErr;
                    if (parseErr.message.includes('quota')) throw parseErr;
                }
            }
            throw err;
        } finally {
            await fs.unlink(tmpInput).catch(() => {});
            await fs.unlink(tmpOutput).catch(() => {});
        }
    }

    /**
     * Auto-rig an avatar mesh using Blender headless.
     * Creates a humanoid armature, applies automatic weights, exports rigged GLB.
     * @param {string} avatarId - Avatar to rig
     * @returns {Promise<object>} Rig result { success, bones, vertices }
     */
    async autoRig(avatarId) {
        const avatar = await Avatar.findOne({ avatarId });
        if (!avatar) throw new Error('Avatar not found');

        const modelPath = avatar.bakedModelPath || avatar.baseModelPath;
        if (!modelPath) throw new Error('Avatar has no model file');

        const riggedPath = modelPath.replace('.glb', '-rigged.glb');
        const scriptPath = path.join(process.cwd(), 'scripts', 'blender-autorig.py');

        const { execFile } = await import('child_process');
        const { promisify } = await import('util');
        const execFileAsync = promisify(execFile);

        logger.info(`Auto-rigging avatar ${avatarId}...`);

        try {
            const { stdout, stderr } = await execFileAsync('blender', [
                '--background', '--python', scriptPath, '--', modelPath, riggedPath
            ], { timeout: 120000, maxBuffer: 5 * 1024 * 1024 });

            if (stderr) {
                for (const line of stderr.split('\n').filter(l => l.trim() && !l.includes('Info'))) {
                    logger.debug(`Blender rig: ${line}`);
                }
            }

            // Parse JSON from stdout (last line)
            const lines = stdout.trim().split('\n');
            const jsonLine = lines.reverse().find(l => l.startsWith('{'));
            const result = JSON.parse(jsonLine || '{}');

            if (!result.success) {
                throw new Error(result.error || 'Auto-rig failed');
            }

            // Update avatar record with rigged model path
            avatar.bakedModelPath = riggedPath;
            avatar.hasRig = true;
            await avatar.save();

            logger.info(`Avatar ${avatarId} rigged: ${result.bones} bones, ${result.vertices} vertices`);
            return result;
        } catch (err) {
            if (err.killed) throw new Error('Auto-rig timed out (2 min limit)');
            throw err;
        }
    }

    /**
     * Call Microsoft TRELLIS via @gradio/client (handles ZeroGPU, sessions, file routing).
     * Uses the community TRELLIS Space on HuggingFace.
     * NOTE: Kept as fallback but the Python bridge (_callHFPythonBridge) is preferred.
     */
    async _callTrellisAPI(inputData, type) {
        if (type !== 'photo') {
            throw new Error('TRELLIS only supports image-to-3D. Use meshy or tripo for text-to-3D.');
        }

        const hfToken = process.env.HUGGINGFACE_TOKEN || process.env.HF_TOKEN || undefined;
        const { Client, handle_file } = await import('@gradio/client');
        let lastError = null;

        // Save image to temp file for handle_file
        const tmpPath = path.join(this.dataDir, `_trellis_input_${Date.now()}.jpg`);
        await fs.writeFile(tmpPath, inputData.buffer);

        try {
            // === Try community TRELLIS first (combined generate_and_extract_glb) ===
            try {
                const spaceId = 'trellis-community/TRELLIS';
                logger.info(`TRELLIS: connecting to ${spaceId}...`);
                const client = await Client.connect(spaceId, {
                    hf_token: hfToken,
                    events: ['status', 'data']
                });
                logger.info(`TRELLIS: connected to ${spaceId}`);

                try {
                    // Pass raw image directly to generate — skip preprocess to avoid
                    // ZeroGPU FileNotFoundError (GPU workers can't access web server files)
                    logger.info('TRELLIS: generating 3D model (GPU allocation + generation, 60-180s)...');
                    const genResult = await client.predict('/generate_and_extract_glb', {
                        image: handle_file(tmpPath),
                        multiimages: [],
                        seed: 0,
                        ss_guidance_strength: 7.5,
                        ss_sampling_steps: 12,
                        slat_guidance_strength: 3.0,
                        slat_sampling_steps: 12,
                        multiimage_algo: 'stochastic',
                        mesh_simplify: 0.95,
                        texture_size: '1024'
                    });

                    return await this._extractGLBFromResult(genResult.data);
                } finally {
                    client.close?.();
                }
            } catch (err) {
                lastError = err;
                logger.warn(`TRELLIS community failed: ${err.message}`);
            }

            // === Fallback: Microsoft TRELLIS.2 (split image_to_3d + extract_glb) ===
            try {
                const spaceId = 'microsoft/TRELLIS.2';
                logger.info(`TRELLIS: connecting to ${spaceId}...`);
                const client = await Client.connect(spaceId, {
                    hf_token: hfToken,
                    events: ['status', 'data']
                });
                logger.info(`TRELLIS: connected to ${spaceId}`);

                try {
                    // TRELLIS.2 preprocess param is "input" not "image"
                    logger.info('TRELLIS.2: preprocessing image...');
                    const ppResult = await client.predict('/preprocess_image', {
                        input: handle_file(tmpPath)
                    });
                    const preprocessedImage = ppResult.data[0];
                    logger.info('TRELLIS.2: image preprocessed');

                    // image_to_3d — generates the 3D representation (no GLB yet)
                    logger.info('TRELLIS.2: generating 3D model (GPU allocation + generation, 60-180s)...');
                    await client.predict('/image_to_3d', {
                        image: preprocessedImage,
                        seed: 0,
                        resolution: '1024',
                        ss_guidance_strength: 7.5,
                        ss_guidance_rescale: 0.7,
                        ss_sampling_steps: 12,
                        ss_rescale_t: 5.0,
                        shape_slat_guidance_strength: 7.5,
                        shape_slat_guidance_rescale: 0.5,
                        shape_slat_sampling_steps: 12,
                        shape_slat_rescale_t: 3.0,
                        tex_slat_guidance_strength: 1.0,
                        tex_slat_guidance_rescale: 0.0,
                        tex_slat_sampling_steps: 12,
                        tex_slat_rescale_t: 3.0
                    });
                    logger.info('TRELLIS.2: 3D model generated, extracting GLB...');

                    // extract_glb — extracts the mesh from the generated 3D state
                    const glbResult = await client.predict('/extract_glb', {
                        decimation_target: 300000,
                        texture_size: 2048
                    });

                    return await this._extractGLBFromResult(glbResult.data);
                } finally {
                    client.close?.();
                }
            } catch (err) {
                lastError = err;
                logger.warn(`TRELLIS.2 failed: ${err.message}`);
            }

        } finally {
            await fs.unlink(tmpPath).catch(() => {});
        }

        // Surface quota errors with a user-friendly message
        const msg = lastError?.message || 'Unknown error';
        if (msg.includes('GPU quota')) {
            const match = msg.match(/Try again in ([\d:]+)/);
            const wait = match ? match[1] : '~24 hours';
            throw new Error(`HuggingFace GPU quota exceeded. Try again in ${wait}.`);
        }
        throw new Error(`All TRELLIS spaces failed. Last error: ${msg}`);
    }

    /**
     * Call Hunyuan3D-2 via @gradio/client (separate ZeroGPU quota from TRELLIS).
     * Space: tencent/Hunyuan3D-2 (3 replicas, textured output)
     */
    async _callHunyuan3DAPI(inputData, spaceId = 'tencent/Hunyuan3D-2') {
        const hfToken = process.env.HUGGINGFACE_TOKEN || process.env.HF_TOKEN || undefined;
        const { Client, handle_file } = await import('@gradio/client');

        if (!hfToken) {
            throw new Error('HuggingFace token required for Hunyuan3D (set HUGGINGFACE_TOKEN)');
        }

        const tmpPath = path.join(this.dataDir, `_hunyuan_input_${Date.now()}.jpg`);
        await fs.writeFile(tmpPath, inputData.buffer);

        try {
            logger.info(`Hunyuan3D: connecting to ${spaceId} (token: yes)...`);
            const client = await Client.connect(spaceId, {
                hf_token: hfToken,
                events: ['status', 'data']
            });

            try {
                logger.info(`${spaceId}: generating 3D model (60-120s)...`);

                // Hunyuan3D-2.0 has 'caption' as first param, 2.1 does not
                const is2dot0 = spaceId.includes('Hunyuan3D-2') && !spaceId.includes('2.1');
                const args = is2dot0
                    ? ['', handle_file(tmpPath), null, null, null, null, 30, 5.0, 1234, 256, true, 8000, true]
                    : [handle_file(tmpPath), null, null, null, null, 30, 5.0, 1234, 256, true, 8000, true];

                const result = await client.predict('/generation_all', args);

                // generation_all returns: (white_mesh, textured_mesh, viewer_html, stats, seed)
                // The textured mesh (index 1) is what we want
                const data = result.data;
                const glbBuffer = await this._extractGLBFromResult(data);
                logger.info(`${spaceId}: successfully generated 3D model (${(glbBuffer.length / 1024).toFixed(0)}KB)`);
                return glbBuffer;
            } finally {
                client.close?.();
            }
        } finally {
            await fs.unlink(tmpPath).catch(() => {});
        }
    }

    /**
     * Call TripoSR via @gradio/client (separate ZeroGPU quota).
     * Space: stabilityai/TripoSR
     */
    async _callTripoSRSpaceAPI(inputData) {
        const hfToken = process.env.HUGGINGFACE_TOKEN || process.env.HF_TOKEN || undefined;
        const { Client, handle_file } = await import('@gradio/client');

        const tmpPath = path.join(this.dataDir, `_triposr_input_${Date.now()}.jpg`);
        await fs.writeFile(tmpPath, inputData.buffer);

        try {
            const spaceId = 'stabilityai/TripoSR';
            logger.info(`TripoSR: connecting to ${spaceId}...`);
            const client = await Client.connect(spaceId, {
                hf_token: hfToken,
                events: ['status', 'data']
            });

            try {
                logger.info('TripoSR: generating 3D model (30-60s)...');
                const result = await client.predict('/run', [
                    handle_file(tmpPath),     // input_image
                    true,                     // do_remove_background
                    0.85,                     // foreground_ratio
                    256                       // mc_resolution
                ]);

                // Returns: (preprocessed_image, output_obj, output_glb)
                const data = result.data;
                const glbBuffer = await this._extractGLBFromResult(data);
                logger.info(`TripoSR: successfully generated 3D model (${(glbBuffer.length / 1024).toFixed(0)}KB)`);
                return glbBuffer;
            } finally {
                client.close?.();
            }
        } finally {
            await fs.unlink(tmpPath).catch(() => {});
        }
    }

    /**
     * Extract and download GLB buffer from Gradio result data.
     */
    async _extractGLBFromResult(data) {
        const glbInfo = this._findGLBInGradioResult(data);
        if (!glbInfo) {
            throw new Error(`No GLB in response: ${JSON.stringify(data).slice(0, 300)}`);
        }

        let glbUrl;
        if (typeof glbInfo === 'string') {
            glbUrl = glbInfo;
        } else if (glbInfo.url) {
            glbUrl = glbInfo.url;
        } else if (glbInfo.path) {
            glbUrl = glbInfo.path;
        }

        logger.info(`TRELLIS: downloading GLB from ${glbUrl?.slice(0, 80)}...`);
        const glbRes = await fetch(glbUrl, { signal: AbortSignal.timeout(60000) });
        if (!glbRes.ok) throw new Error(`Failed to download GLB: ${glbRes.status}`);

        const modelBuffer = Buffer.from(await glbRes.arrayBuffer());
        if (modelBuffer.length < 100) throw new Error('GLB file too small');

        logger.info(`TRELLIS: successfully generated 3D model (${(modelBuffer.length / 1024).toFixed(0)}KB)`);
        return modelBuffer;
    }

    /**
     * Recursively search a Gradio result object for a .glb file path.
     */
    _findGLBInGradioResult(obj) {
        if (!obj) return null;
        if (typeof obj === 'string' && obj.endsWith('.glb')) return obj;
        if (obj.path && typeof obj.path === 'string' && obj.path.endsWith('.glb')) return obj.path;
        if (obj.url && typeof obj.url === 'string' && obj.url.endsWith('.glb')) return obj.url;
        if (Array.isArray(obj)) {
            for (const item of obj) {
                const found = this._findGLBInGradioResult(item);
                if (found) return found;
            }
        }
        if (typeof obj === 'object') {
            for (const val of Object.values(obj)) {
                const found = this._findGLBInGradioResult(val);
                if (found) return found;
            }
        }
        return null;
    }

    async _generateThumbnail(modelPath, outputPath) {
        // Real 3D rendering would need headless GL (puppeteer + three.js or OSMesa).
        // For now, generate a placeholder thumbnail using sharp if available.
        try {
            const sharp = (await import('sharp')).default;
            const agentName = process.env.AGENT_NAME || 'LANAgent';

            // Create a simple colored square with an SVG overlay
            const svg = `<svg width="256" height="256" xmlns="http://www.w3.org/2000/svg">
                <rect width="256" height="256" fill="#1a1a2e"/>
                <circle cx="128" cy="100" r="50" fill="#16213e" stroke="#0f3460" stroke-width="2"/>
                <rect x="78" y="160" width="100" height="60" rx="10" fill="#16213e" stroke="#0f3460" stroke-width="2"/>
                <text x="128" y="240" font-family="Arial" font-size="14" fill="#e94560" text-anchor="middle">${agentName}</text>
            </svg>`;

            await sharp(Buffer.from(svg))
                .png()
                .toFile(outputPath);
        } catch (err) {
            logger.debug(`Thumbnail generation skipped (sharp not available): ${err.message}`);
            // Write a minimal 1x1 PNG as fallback
            const minimalPng = Buffer.from(
                'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
                'base64'
            );
            await fs.writeFile(outputPath, minimalPng);
        }
    }

    // ── Customization ────────────────────────────────────────────────

    async applyCustomizations(avatarId, customizations) {
        const avatar = await Avatar.findOne({ avatarId });
        if (!avatar) throw new Error(`Avatar not found: ${avatarId}`);

        // Merge customizations
        if (customizations.body) avatar.customizations.body = { ...avatar.customizations.body, ...customizations.body };
        if (customizations.face) avatar.customizations.face = { ...avatar.customizations.face, ...customizations.face };
        if (customizations.outfit) avatar.customizations.outfit = { ...avatar.customizations.outfit, ...customizations.outfit };
        if (customizations.accessories) avatar.customizations.accessories = customizations.accessories;
        if (customizations.effects) avatar.customizations.effects = { ...avatar.customizations.effects, ...customizations.effects };
        if (customizations.expression) avatar.customizations.expression = customizations.expression;

        avatar.version += 1;
        avatar.markModified('customizations');
        await avatar.save();

        logger.info(`Avatar ${avatarId} customizations updated to version ${avatar.version}`);
        return avatar;
    }

    async getAvailableItems(owner) {
        const defaultItems = [
            { itemId: 'helmet_basic', category: 'accessories', name: 'Basic Helmet', locked: true },
            { itemId: 'visor_holo', category: 'accessories', name: 'Holo Visor', locked: true },
            { itemId: 'jetpack', category: 'accessories', name: 'Jetpack', locked: true },
            { itemId: 'aura_fire', category: 'effects', name: 'Fire Aura', locked: true },
            { itemId: 'aura_electric', category: 'effects', name: 'Electric Aura', locked: true },
            { itemId: 'outfit_cyberpunk', category: 'outfit', name: 'Cyberpunk Suit', locked: true },
            { itemId: 'outfit_formal', category: 'outfit', name: 'Formal Suit', locked: true },
            { itemId: 'wings_angel', category: 'accessories', name: 'Angel Wings', locked: true },
            { itemId: 'wings_demon', category: 'accessories', name: 'Demon Wings', locked: true },
            { itemId: 'pet_drone', category: 'accessories', name: 'Companion Drone', locked: true }
        ];

        // Find all unlocked items for this owner
        const avatars = await Avatar.find({ owner });
        const unlockedSet = new Set();
        for (const avatar of avatars) {
            for (const item of avatar.unlockedItems || []) {
                unlockedSet.add(item.itemId);
            }
        }

        return defaultItems.map(item => ({
            ...item,
            locked: !unlockedSet.has(item.itemId)
        }));
    }

    async unlockItem(avatarId, itemId, achievement) {
        const avatar = await Avatar.findOne({ avatarId });
        if (!avatar) throw new Error(`Avatar not found: ${avatarId}`);

        const alreadyUnlocked = avatar.unlockedItems.some(i => i.itemId === itemId);
        if (alreadyUnlocked) {
            return { alreadyUnlocked: true, avatar };
        }

        avatar.unlockedItems.push({
            itemId,
            unlockedAt: new Date(),
            achievement: achievement || 'manual'
        });
        await avatar.save();

        logger.info(`Avatar ${avatarId}: unlocked item ${itemId} via ${achievement || 'manual'}`);
        return { alreadyUnlocked: false, avatar };
    }

    // ── NFT Minting ──────────────────────────────────────────────────

    async mintAvatar(avatarId) {
        if (!this.contractAddress) {
            throw new Error('Avatar NFT contract address not configured');
        }

        const avatar = await Avatar.findOne({ avatarId });
        if (!avatar) throw new Error(`Avatar not found: ${avatarId}`);
        if (avatar.nftTokenId) throw new Error(`Avatar ${avatarId} already minted as token #${avatar.nftTokenId}`);

        const signer = await this._getSigner();
        const ethers = await import('ethers');
        const contract = new ethers.Contract(this.contractAddress, AVATAR_NFT_ABI, signer);

        // Pin model + metadata to IPFS (if not already pinned)
        let metadataCID = avatar.ipfsCIDs?.metadata;
        if (!metadataCID) {
            logger.info(`Avatar ${avatarId}: pinning to IPFS before mint...`);
            const pinResult = await this.pinAvatarToIPFS(avatarId);
            metadataCID = pinResult.metadataCID;
            // Reload avatar after pinning updated it
            await avatar.save();
        }

        const tokenURI = metadataCID ? `ipfs://${metadataCID}` : `ipfs://placeholder/${avatarId}`;
        if (!metadataCID) {
            logger.warn(`Avatar ${avatarId}: minting with placeholder tokenURI (IPFS pinning unavailable)`);
        }

        const tx = await contract.mintAvatar(
            await signer.getAddress(),
            tokenURI,
            avatar.agentId || 0
        );

        const receipt = await tx.wait();
        logger.info(`Avatar ${avatarId} minted: tx=${receipt.hash}`);

        // Extract tokenId from Transfer event
        let tokenId = null;
        for (const log of receipt.logs) {
            try {
                const parsed = contract.interface.parseLog({ topics: log.topics, data: log.data });
                if (parsed?.name === 'Transfer') {
                    tokenId = Number(parsed.args.tokenId);
                    break;
                }
            } catch {
                // Not our event, skip
            }
        }

        avatar.nftTokenId = tokenId;
        avatar.nftTxHash = receipt.hash;
        avatar.ipfsCIDs.metadata = tokenURI;
        avatar.markModified('ipfsCIDs');
        await avatar.save();

        return { tokenId, txHash: receipt.hash, avatar };
    }

    async _getSigner() {
        const ethers = await import('ethers');
        const wallet = await walletService.getWallet();
        if (!wallet) throw new Error('Wallet not initialized');
        const mnemonic = decrypt(wallet.encryptedSeed);
        const derivedWallet = ethers.Wallet.fromPhrase(mnemonic);
        const provider = await contractServiceWrapper.getProvider(this.network);
        return derivedWallet.connect(provider);
    }

    // ── IPFS Pinning ────────────────────────────────────────────────

    /**
     * Pin a file (GLB model, image, etc.) to IPFS via nft.storage.
     * Requires NFT_STORAGE_API_KEY env var. Skips gracefully if not set.
     * @param {string} filePath - Absolute path to the file to pin
     * @returns {string|null} CID or null if pinning was skipped
     */
    async pinToIPFS(filePath) {
        const apiKey = process.env.NFT_STORAGE_API_KEY;
        if (!apiKey) {
            logger.warn('IPFS pinning skipped: NFT_STORAGE_API_KEY not configured');
            return null;
        }

        try {
            const fileBuffer = await fs.readFile(filePath);
            const ext = path.extname(filePath).toLowerCase();
            const mimeTypes = {
                '.glb': 'model/gltf-binary',
                '.png': 'image/png',
                '.jpg': 'image/jpeg',
                '.jpeg': 'image/jpeg',
                '.json': 'application/json'
            };
            const contentType = mimeTypes[ext] || 'application/octet-stream';

            const res = await fetch('https://api.nft.storage/upload', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': contentType
                },
                body: fileBuffer
            });

            if (!res.ok) {
                const errText = await res.text();
                throw new Error(`nft.storage upload failed: ${res.status} ${errText}`);
            }

            const data = await res.json();
            const cid = data.value?.cid;
            if (!cid) throw new Error('No CID in nft.storage response');

            logger.info(`IPFS pinned: ${path.basename(filePath)} → ${cid}`);
            return cid;
        } catch (err) {
            logger.error(`IPFS pin failed for ${filePath}: ${err.message}`);
            return null;
        }
    }

    /**
     * Pin JSON metadata to IPFS via nft.storage.
     * @param {object} metadata - JSON metadata object
     * @returns {string|null} CID or null if pinning was skipped
     */
    async pinMetadataToIPFS(metadata) {
        const apiKey = process.env.NFT_STORAGE_API_KEY;
        if (!apiKey) {
            logger.warn('IPFS metadata pinning skipped: NFT_STORAGE_API_KEY not configured');
            return null;
        }

        try {
            const res = await fetch('https://api.nft.storage/upload', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(metadata)
            });

            if (!res.ok) {
                const errText = await res.text();
                throw new Error(`nft.storage metadata upload failed: ${res.status} ${errText}`);
            }

            const data = await res.json();
            const cid = data.value?.cid;
            if (!cid) throw new Error('No CID in nft.storage response');

            logger.info(`IPFS metadata pinned: ${cid}`);
            return cid;
        } catch (err) {
            logger.error(`IPFS metadata pin failed: ${err.message}`);
            return null;
        }
    }

    /**
     * Get a public IPFS gateway URL for a CID.
     * @param {string} cid - IPFS content identifier
     * @returns {string} Gateway URL
     */
    getIPFSUrl(cid) {
        return `https://nftstorage.link/ipfs/${cid}`;
    }

    /**
     * Build ERC-721-compliant NFT metadata for an avatar.
     * @param {object} avatar - Avatar document
     * @param {object} cids - { model, thumbnail } CIDs
     * @returns {object} ERC-721 metadata JSON
     */
    _buildNFTMetadata(avatar, cids) {
        const agentName = avatar.agentName || process.env.AGENT_NAME || 'LANAgent';
        return {
            name: `LANAgent Avatar - ${agentName}`,
            description: `3D avatar for ${agentName}`,
            image: cids.thumbnail ? `ipfs://${cids.thumbnail}` : '',
            animation_url: cids.model ? `ipfs://${cids.model}` : '',
            attributes: [
                { trait_type: 'Agent Name', value: agentName },
                { trait_type: 'Source Type', value: avatar.sourceType || 'unknown' },
                { trait_type: 'Format', value: avatar.format || 'glb' },
                { trait_type: 'Version', value: avatar.version || 1 },
                ...(avatar.customizations?.outfit?.style
                    ? [{ trait_type: 'Outfit', value: avatar.customizations.outfit.style }]
                    : []),
                ...(avatar.customizations?.effects?.aura
                    ? [{ trait_type: 'Aura', value: avatar.customizations.effects.aura }]
                    : []),
                ...(avatar.unlockedItems?.length
                    ? [{ trait_type: 'Unlocked Items', value: avatar.unlockedItems.length }]
                    : [])
            ]
        };
    }

    /**
     * Pin avatar model + thumbnail to IPFS and store CIDs on the avatar document.
     * Called after avatar creation or on demand before minting.
     * @param {string} avatarId
     * @returns {object} { modelCID, thumbnailCID, metadataCID } (any may be null)
     */
    async pinAvatarToIPFS(avatarId) {
        const avatar = await Avatar.findOne({ avatarId });
        if (!avatar) throw new Error(`Avatar not found: ${avatarId}`);

        const modelPath = avatar.bakedModelPath || avatar.baseModelPath;
        const thumbnailPath = avatar.thumbnailPath;

        // Pin model
        const modelCID = modelPath ? await this.pinToIPFS(modelPath) : null;

        // Pin thumbnail
        const thumbnailCID = thumbnailPath ? await this.pinToIPFS(thumbnailPath) : null;

        // Build and pin metadata
        const metadata = this._buildNFTMetadata(avatar, { model: modelCID, thumbnail: thumbnailCID });
        const metadataCID = await this.pinMetadataToIPFS(metadata);

        // Store CIDs on the avatar document
        if (modelCID) avatar.ipfsCIDs.model = modelCID;
        if (thumbnailCID) avatar.ipfsCIDs.thumbnail = thumbnailCID;
        if (metadataCID) avatar.ipfsCIDs.metadata = metadataCID;
        avatar.markModified('ipfsCIDs');
        await avatar.save();

        logger.info(`Avatar ${avatarId} IPFS pinning complete: model=${modelCID || 'skipped'}, thumb=${thumbnailCID || 'skipped'}, meta=${metadataCID || 'skipped'}`);
        return { modelCID, thumbnailCID, metadataCID };
    }

    // ── Export ────────────────────────────────────────────────────────

    async exportAvatar(avatarId, format = 'glb') {
        const avatar = await Avatar.findOne({ avatarId });
        if (!avatar) throw new Error(`Avatar not found: ${avatarId}`);

        const modelPath = avatar.bakedModelPath || avatar.baseModelPath;
        if (!modelPath) throw new Error(`Avatar ${avatarId} has no model file`);

        if (format !== 'glb') {
            logger.info(`Avatar ${avatarId}: format conversion to ${format} would happen here — returning GLB`);
        }

        return { path: modelPath, format: avatar.format || 'glb', avatarId };
    }

    // ── Query ────────────────────────────────────────────────────────

    async getAvatar(avatarId) {
        const avatar = await Avatar.findOne({ avatarId });
        if (!avatar) throw new Error(`Avatar not found: ${avatarId}`);
        return avatar;
    }

    async getAvatarsByOwner(owner) {
        return Avatar.getByOwner(owner);
    }

    async getGallery(limit = 20, filters = {}) {
        return Avatar.getGallery(limit, filters);
    }

    async getStats() {
        const total = await Avatar.countDocuments();
        const bySourceType = await Avatar.aggregate([
            { $group: { _id: '$sourceType', count: { $sum: 1 } } }
        ]);
        const mintedCount = await Avatar.countDocuments({ nftTokenId: { $ne: null } });

        return {
            total,
            bySourceType: bySourceType.reduce((acc, item) => {
                acc[item._id || 'unknown'] = item.count;
                return acc;
            }, {}),
            minted: mintedCount
        };
    }
}

export default new AvatarService();
