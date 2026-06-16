import express from 'express';
import fs from 'fs';
import path from 'path';
import { authenticateToken } from '../interfaces/web/auth.js';

const router = express.Router();

const AUDIO_EXTENSIONS_ARR = ['.mp3', '.flac', '.ogg', '.wav', '.m4a', '.aac', '.opus', '.wma'];
const AUDIO_EXTENSIONS = new Set(AUDIO_EXTENSIONS_ARR);

const AUDIO_MIMES = {
    '.mp3': 'audio/mpeg',
    '.flac': 'audio/flac',
    '.ogg': 'audio/ogg',
    '.wav': 'audio/wav',
    '.m4a': 'audio/mp4',
    '.aac': 'audio/aac',
    '.opus': 'audio/opus',
    '.wma': 'audio/x-ms-wma'
};

const SETTING_KEY = 'music-library.sourcePath';
const SMB_ORIGIN_KEY = 'music-library.smbOrigin'; // original smb:// URL for remounting

/**
 * Ensure the music source is accessible on startup. If it's an SMB mount
 * that disappeared after a reboot, remount it automatically.
 */
async function ensureMusicMount() {
    try {
        const { SystemSettings } = await import('../models/SystemSettings.js');
        const sourcePath = await SystemSettings.getSetting(SETTING_KEY, '');
        if (!sourcePath) return;

        // Check if path is accessible
        try {
            await fs.promises.access(sourcePath, fs.constants.R_OK);
            // Try to actually read it — mount points can exist but be empty
            const entries = await fs.promises.readdir(sourcePath);
            if (entries.length > 0) return; // accessible and has content
        } catch {}

        // Path not accessible — check if we have an SMB origin to remount
        const smbOrigin = await SystemSettings.getSetting(SMB_ORIGIN_KEY, '');
        if (!smbOrigin) return;

        const match = smbOrigin.match(/^smb:\/\/([^/]+)\/([^/]+)(\/.*)?$/i);
        if (!match) return;

        const [, server, share] = match;
        const mountName = `music-${server}-${share}`.replace(/[^a-zA-Z0-9-]/g, '_');
        const mountPoint = `/mnt/${mountName}`;

        const { execSync } = await import('child_process');
        try { await fs.promises.mkdir(mountPoint, { recursive: true }); } catch {}

        // Check if already mounted
        try {
            const mountCheck = execSync(`mount | grep '${mountPoint}'`, { encoding: 'utf8' });
            if (mountCheck.trim()) return; // already mounted
        } catch {}

        // Try to mount
        try {
            execSync(`mount -t cifs //${server}/${share} ${mountPoint} -o guest,iocharset=utf8`, { timeout: 15000 });
            const { logger } = await import('../utils/logger.js');
            logger.info(`Music library: auto-remounted ${smbOrigin} → ${mountPoint}`);
        } catch (e) {
            const { logger } = await import('../utils/logger.js');
            logger.warn(`Music library: failed to auto-remount ${smbOrigin}: ${e.message}`);
        }
    } catch (e) {
        // Non-fatal — don't block startup
    }
}

// Run on import (agent startup)
ensureMusicMount();

function isUrl(str) {
    return /^https?:\/\//i.test(str);
}

function isSmbUrl(str) {
    return /^smb:\/\//i.test(str);
}

// Allow token as query param for audio streaming (Audio elements can't set headers)
router.use((req, res, next) => {
    if (req.query.token && !req.headers.authorization) {
        req.headers.authorization = `Bearer ${req.query.token}`;
    }
    next();
});
router.use(authenticateToken);

// GET /browse-local - browse the agent's local filesystem for directory selection
router.get('/browse-local', async (req, res) => {
    try {
        const dirPath = req.query.path || '/';
        const resolved = path.resolve(dirPath);
        const entries = await fs.promises.readdir(resolved, { withFileTypes: true });
        const dirs = [];
        let audioCount = 0;
        for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
            if (e.name.startsWith('.')) continue;
            if (e.isDirectory()) dirs.push(e.name);
            else if (e.isFile() && AUDIO_EXTENSIONS.has(path.extname(e.name).toLowerCase())) audioCount++;
        }
        res.json({ success: true, path: resolved, dirs, audioCount, parent: path.dirname(resolved) });
    } catch (err) {
        res.status(400).json({ success: false, error: err.message });
    }
});

// GET /samba-mounts - list saved Samba connections
router.get('/samba-mounts', async (req, res) => {
    try {
        const { SambaMount } = await import('../models/SambaMount.js');
        const mounts = await SambaMount.find({}).lean();
        res.json({ success: true, mounts: mounts.map(m => ({
            id: m._id, name: m.name, server: m.server, share: m.share,
            mountPoint: m.mountPoint, mounted: m.mounted
        }))});
    } catch (err) {
        res.json({ success: true, mounts: [] });
    }
});

// GET /ssh-connections - list saved SSH connections
router.get('/ssh-connections', async (req, res) => {
    try {
        const { SSHConnection } = await import('../models/SSHConnection.js');
        const connections = await SSHConnection.find({}).lean();
        res.json({ success: true, connections: connections.map(c => ({
            id: c._id, name: c.name, host: c.host, port: c.port, username: c.username
        }))});
    } catch (err) {
        res.json({ success: true, connections: [] });
    }
});

// POST /browse-ssh - browse a directory on a remote SSH server
// Uses the SSH plugin's existing connection management (already authenticated)
router.post('/browse-ssh', async (req, res) => {
    try {
        const { connectionId, dirPath = '/' } = req.body;
        if (!connectionId) return res.status(400).json({ error: 'connectionId required' });

        // Look up the connection to get the connectionId string (e.g. "root@your-server:22")
        const { SSHConnection } = await import('../models/SSHConnection.js');
        const conn = await SSHConnection.findById(connectionId);
        if (!conn) return res.status(404).json({ error: 'SSH connection not found' });

        // Use the SSH plugin which already has decrypted credentials and working connections
        const agent = req.app.locals.agent;
        const sshPlugin = agent?.apiManager?.apis?.get('ssh')?.instance;
        if (!sshPlugin) return res.status(500).json({ success: false, error: 'SSH plugin not available' });

        // Connect if not already connected
        const sshId = conn.connectionId || `${conn.username}@${conn.host}:${conn.port || 22}`;
        if (!sshPlugin.activeConnections?.has(sshId)) {
            const connectResult = await sshPlugin.execute({ action: 'connect', id: sshId });
            if (!connectResult.success) return res.json({ success: false, error: 'SSH connect failed: ' + connectResult.error });
        }

        const safePath = dirPath.replace(/'/g, "'\\''");
        const cmd = `ls -1pA '${safePath}' 2>/dev/null && echo '---AUDIO---' && find '${safePath}' -maxdepth 1 -type f \\( -iname '*.mp3' -o -iname '*.flac' -o -iname '*.ogg' -o -iname '*.wav' -o -iname '*.m4a' -o -iname '*.aac' -o -iname '*.opus' -o -iname '*.wma' \\) 2>/dev/null | wc -l`;
        const execResult = await sshPlugin.executeCommand(sshId, cmd);
        if (!execResult.success) return res.json({ success: false, error: execResult.error });

        const stdout = execResult.data?.stdout || execResult.output || '';
        const [listing, countStr] = stdout.split('---AUDIO---');
        const dirs = listing.trim().split('\n')
            .filter(l => l.endsWith('/') && l !== './' && l !== '../')
            .map(l => l.replace(/\/$/, ''));
        const result = { dirs, audioCount: parseInt(countStr?.trim()) || 0 };

        const parent = dirPath === '/' ? '/' : path.posix.dirname(dirPath);
        res.json({ success: true, path: dirPath, dirs: result.dirs, audioCount: result.audioCount, parent });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// POST /mount-smb - mount an smb:// URL and return the mount point
router.post('/mount-smb', async (req, res) => {
    try {
        const { smbUrl, username, password } = req.body;
        if (!smbUrl) return res.status(400).json({ error: 'smbUrl required' });

        // Parse smb://server/share/path
        const match = smbUrl.match(/^smb:\/\/([^/]+)\/([^/]+)(\/.*)?$/i);
        if (!match) return res.status(400).json({ error: 'Invalid SMB URL format. Use smb://server/share or smb://server/share/path' });

        const [, server, share, subPath] = match;
        const mountName = `music-${server}-${share}`.replace(/[^a-zA-Z0-9-]/g, '_');
        const mountPoint = `/mnt/${mountName}`;

        // Create mount point if needed
        const { execSync } = await import('child_process');
        try { await fs.promises.mkdir(mountPoint, { recursive: true }); } catch {}

        // Check if already mounted
        try {
            const mountCheck = execSync(`mount | grep '${mountPoint}'`, { encoding: 'utf8' });
            if (mountCheck.trim()) {
                const fullPath = subPath ? path.join(mountPoint, subPath) : mountPoint;
                return res.json({ success: true, mountPoint: fullPath, alreadyMounted: true });
            }
        } catch {}

        // Mount
        const creds = username ? `username=${username},password=${password || ''}` : 'guest';
        const cmd = `mount -t cifs //${server}/${share} ${mountPoint} -o ${creds},iocharset=utf8,file_mode=0644,dir_mode=0755`;
        try {
            execSync(cmd, { timeout: 15000 });
        } catch (e) {
            return res.status(500).json({ success: false, error: `Mount failed: ${e.stderr?.toString() || e.message}` });
        }

        const fullPath = subPath ? path.join(mountPoint, subPath) : mountPoint;
        res.json({ success: true, mountPoint: fullPath });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// GET /config - return the configured music source path
router.get('/config', async (req, res) => {
    try {
        const { SystemSettings } = await import('../models/SystemSettings.js');
        const sourcePath = await SystemSettings.getSetting(SETTING_KEY, '');
        res.json({ sourcePath });
    } catch (err) {
        res.status(500).json({ error: 'Failed to read config', details: err.message });
    }
});

// PUT /config - set the music source path
router.put('/config', async (req, res) => {
    try {
        const { sourcePath } = req.body;
        if (!sourcePath || typeof sourcePath !== 'string') {
            return res.status(400).json({ error: 'sourcePath is required' });
        }

        const trimmed = sourcePath.trim();

        if (isSmbUrl(trimmed)) {
            // SMB URL — auto-mount and store the mount point instead
            try {
                const match = trimmed.match(/^smb:\/\/([^/]+)\/([^/]+)(\/.*)?$/i);
                if (!match) return res.status(400).json({ error: 'Invalid SMB URL. Use smb://server/share or smb://server/share/path' });
                const [, server, share, subPath] = match;
                const mountName = `music-${server}-${share}`.replace(/[^a-zA-Z0-9-]/g, '_');
                const mountPoint = `/mnt/${mountName}`;
                try { await fs.promises.mkdir(mountPoint, { recursive: true }); } catch {}
                const { execSync } = await import('child_process');
                try { execSync(`mount | grep '${mountPoint}'`, { encoding: 'utf8' }); }
                catch { execSync(`mount -t cifs //${server}/${share} ${mountPoint} -o guest,iocharset=utf8`, { timeout: 15000 }); }
                const fullPath = subPath ? path.join(mountPoint, subPath) : mountPoint;
                await fs.promises.access(fullPath, fs.constants.R_OK);
                // Save the resolved local path + remember the SMB origin for remounting
                const { SystemSettings: SS } = await import('../models/SystemSettings.js');
                await SS.setSetting(SETTING_KEY, fullPath);
                await SS.setSetting(SMB_ORIGIN_KEY, trimmed);
                return res.json({ success: true, sourcePath: fullPath, mountedFrom: trimmed });
            } catch (e) {
                return res.status(400).json({ error: `SMB mount failed: ${e.message}`, path: trimmed });
            }
        } else if (isUrl(trimmed)) {
            // HTTP URL source — accept as-is
        } else {
            // Local path — verify it exists and is accessible
            try {
                await fs.promises.access(trimmed, fs.constants.R_OK);
            } catch {
                return res.status(400).json({ error: 'Local path is not accessible', path: trimmed });
            }
        }

        const { SystemSettings } = await import('../models/SystemSettings.js');
        await SystemSettings.setSetting(SETTING_KEY, trimmed);
        res.json({ success: true, sourcePath: trimmed });
    } catch (err) {
        res.status(500).json({ error: 'Failed to save config', details: err.message });
    }
});

// GET /browse - list files in current directory (non-recursive, paginated)
// Query params: subdir (relative path), limit (default 200), offset (default 0)
router.get('/browse', async (req, res) => {
    try {
        const { SystemSettings } = await import('../models/SystemSettings.js');
        const sourcePath = await SystemSettings.getSetting(SETTING_KEY, '');

        if (!sourcePath) {
            return res.json({ success: false, error: 'Music source path not configured' });
        }

        if (isUrl(sourcePath)) {
            return res.json({ success: true, type: 'url', basePath: sourcePath });
        }

        const subdir = req.query.subdir || '';
        const limit = Math.min(parseInt(req.query.limit) || 200, 1000);
        const offset = parseInt(req.query.offset) || 0;
        const resolved = path.resolve(sourcePath, subdir);

        // Path traversal check
        if (!resolved.startsWith(path.resolve(sourcePath))) {
            return res.status(403).json({ success: false, error: 'Path traversal not allowed' });
        }

        let entries;
        try {
            entries = await fs.promises.readdir(resolved, { withFileTypes: true });
        } catch (e) {
            return res.json({ success: false, error: 'Cannot read directory: ' + e.message });
        }

        // Separate folders and audio files, skip hidden
        const folders = [];
        const files = [];
        for (const entry of entries) {
            if (entry.name.startsWith('.')) continue;
            if (entry.isDirectory()) {
                folders.push(entry.name);
            } else if (entry.isFile() && AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
                const relPath = subdir ? subdir + '/' + entry.name : entry.name;
                files.push({ name: entry.name, path: relPath });
            }
        }

        // Sort
        folders.sort((a, b) => a.localeCompare(b));
        files.sort((a, b) => a.name.localeCompare(b.name));

        // Paginate files only (folders always shown)
        const totalFiles = files.length;
        const pagedFiles = files.slice(offset, offset + limit);

        res.json({
            success: true,
            subdir: subdir || '',
            folders,
            files: pagedFiles,
            totalFiles,
            offset,
            limit,
            hasMore: offset + limit < totalFiles
        });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Failed to browse: ' + err.message });
    }
});

// GET /search - search music library by filename (artist, song, album keywords)
router.get('/search', async (req, res) => {
    try {
        const query = (req.query.q || '').toLowerCase().trim();
        if (!query) return res.json({ success: false, error: 'q parameter required' });

        const { SystemSettings } = await import('../models/SystemSettings.js');
        const sourcePath = await SystemSettings.getSetting(SETTING_KEY, '');
        if (!sourcePath || isUrl(sourcePath)) return res.json({ success: false, error: 'Local music source not configured' });

        const limit = Math.min(parseInt(req.query.limit) || 50, 200);
        const { exec: execCb } = await import('child_process');
        const { promisify } = await import('util');
        const execAsync = promisify(execCb);

        // Use find + grep for recursive filename search (maxdepth 3 for NAS performance)
        const safeQuery = query.replace(/['"\\]/g, '');
        const audioPattern = AUDIO_EXTENSIONS_ARR.map(e => `-iname '*${e}'`).join(' -o ');
        const cmd = `find "${sourcePath}" -maxdepth 3 \\( ${audioPattern} \\) 2>/dev/null | grep -i '${safeQuery}' | head -${limit}`;
        const { stdout } = await execAsync(cmd, { timeout: 60000, maxBuffer: 1024 * 1024 });
        const output = stdout.trim();

        if (!output) return res.json({ success: true, results: [], total: 0 });

        const results = output.split('\n').filter(Boolean).map(fullPath => {
            const relPath = fullPath.startsWith(sourcePath) ? fullPath.slice(sourcePath.length + 1) : fullPath;
            const name = path.basename(fullPath);
            return { name, path: relPath, fullPath };
        });

        res.json({ success: true, results, total: results.length });
    } catch (err) {
        res.json({ success: true, results: [], total: 0 });
    }
});

// POST /save - download a URL (YouTube, etc.) to the music library using yt-dlp
router.post('/save', async (req, res) => {
    try {
        const { url, query } = req.body;
        if (!url && !query) return res.status(400).json({ success: false, error: 'url or query required' });

        const { SystemSettings } = await import('../models/SystemSettings.js');
        const sourcePath = await SystemSettings.getSetting(SETTING_KEY, '');
        if (!sourcePath || isUrl(sourcePath)) return res.json({ success: false, error: 'Local music source not configured' });

        // Use yt-dlp plugin to download audio
        const agent = req.app.locals.agent;
        const ytdlpPlugin = agent?.apiManager?.apis?.get('ytdlp')?.instance;
        if (!ytdlpPlugin) return res.json({ success: false, error: 'ytdlp plugin not available' });

        // Download to default dir first, then move to music library
        const result = await ytdlpPlugin.execute({
            action: 'audio',
            url: url || undefined,
            query: (!url && query) ? query : undefined
        });

        if (result.success) {
            // Move downloaded file to music library
            const downloadedPath = result.path || result.data?.path;
            const filename = result.filename || result.data?.filename || path.basename(downloadedPath || '');
            if (downloadedPath) {
                try {
                    const destPath = path.join(sourcePath, path.basename(downloadedPath));
                    await fs.promises.copyFile(downloadedPath, destPath);
                    await fs.promises.unlink(downloadedPath).catch(() => {});
                    res.json({ success: true, message: `Saved to music library: ${filename}`, path: destPath });
                } catch (moveErr) {
                    res.json({ success: true, message: `Downloaded ${filename} but couldn't move to library: ${moveErr.message}. File is in downloads.`, path: downloadedPath });
                }
            } else {
                res.json({ success: true, message: `Downloaded: ${filename}`, data: result });
            }
        } else {
            res.json({ success: false, error: result.error || 'Download failed' });
        }
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// GET /stream/* - stream an audio file
router.get('/stream/*', async (req, res) => {
    try {
        const { SystemSettings } = await import('../models/SystemSettings.js');
        const sourcePath = await SystemSettings.getSetting(SETTING_KEY, '');

        if (!sourcePath) {
            return res.status(400).json({ error: 'Music source path not configured' });
        }

        const filePath = decodeURIComponent(req.params[0]);
        if (!filePath) {
            return res.status(400).json({ error: 'File path is required' });
        }

        if (isUrl(sourcePath)) {
            const url = sourcePath.replace(/\/+$/, '') + '/' + filePath;
            return res.redirect(302, url);
        }

        const fullPath = path.resolve(path.join(sourcePath, filePath));

        // Path traversal check
        if (!fullPath.startsWith(path.resolve(sourcePath))) {
            return res.status(403).json({ error: 'Path traversal not allowed' });
        }

        const ext = path.extname(fullPath).toLowerCase();
        const mime = AUDIO_MIMES[ext];
        if (!mime) {
            return res.status(400).json({ error: 'Unsupported audio format' });
        }

        let stat;
        try {
            stat = await fs.promises.stat(fullPath);
        } catch {
            return res.status(404).json({ error: 'File not found' });
        }

        const fileSize = stat.size;
        const range = req.headers.range;

        if (range) {
            const parts = range.replace(/bytes=/, '').split('-');
            const start = parseInt(parts[0], 10);
            const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

            if (start >= fileSize || end >= fileSize || start > end) {
                res.writeHead(416, { 'Content-Range': `bytes */${fileSize}` });
                return res.end();
            }

            res.writeHead(206, {
                'Content-Range': `bytes ${start}-${end}/${fileSize}`,
                'Accept-Ranges': 'bytes',
                'Content-Length': end - start + 1,
                'Content-Type': mime
            });
            fs.createReadStream(fullPath, { start, end }).pipe(res);
        } else {
            res.writeHead(200, {
                'Content-Length': fileSize,
                'Content-Type': mime,
                'Accept-Ranges': 'bytes'
            });
            fs.createReadStream(fullPath).pipe(res);
        }
    } catch (err) {
        if (!res.headersSent) {
            res.status(500).json({ error: 'Failed to stream file', details: err.message });
        }
    }
});

export default router;
