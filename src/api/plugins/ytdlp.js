import { BasePlugin } from '../core/basePlugin.js';
import { logger } from '../../utils/logger.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';

const execAsync = promisify(exec);

export default class YtDlpPlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'ytdlp';
    this.version = '1.0.0';
    this.description = 'Download videos and audio from YouTube and other platforms using yt-dlp';
    // Base yt-dlp command with JS runtime for YouTube extraction
    this.ytdlpBase = 'yt-dlp --js-runtimes node';
    this.commands = [
      {
        command: 'download',
        description: 'Download video from YouTube or other URL — for saving video files, NOT for reading lyrics text',
        usage: 'download [url] [options]',
        offerAsService: true,
        examples: [
          'download this youtube video',
          'download video from youtube',
          'save this video as mp4',
          'download the music video for Bohemian Rhapsody',
          'grab this video and save it'
        ]
      },
      {
        command: 'info',
        description: 'Get video information without downloading',
        usage: 'info [url]',
        offerAsService: true
      },
      {
        command: 'search',
        description: 'Search YouTube for videos or songs by name — for FINDING and LOCATING songs or videos to watch or download, NOT for reading lyrics text',
        usage: 'search [query] [limit]',
        offerAsService: true,
        params: { query: 'The search query (song name, video title, keywords)', limit: 'Number of results to return (default 5)' },
        examples: [
          'find me the song Bohemian Rhapsody by Queen',
          'search youtube for Never Gonna Give You Up',
          'find a song called Hotel California',
          'search for the song Stairway to Heaven',
          'look up Somebody to Love by Jefferson Airplane',
          'find a music video for Blinding Lights',
          'search for a video about cooking',
          'youtube search for Rick Astley',
          'can you find me the song Shape of You',
          'look for the song Imagine by John Lennon'
        ]
      },
      {
        command: 'audio',
        description: 'Download audio/MP3 from YouTube — for DOWNLOADING and SENDING a song as an audio file, NOT for reading lyrics text',
        usage: 'audio [url or query]',
        offerAsService: true,
        examples: [
          'download mp3 from youtube',
          'download the song Bohemian Rhapsody as mp3',
          'send me the mp3 of Never Gonna Give You Up',
          'download Stairway to Heaven and send me the mp3',
          'get me the audio for Hotel California',
          'find the song Shape of You and send me the mp3',
          'grab the song and send it as mp3',
          'youtube to mp3',
          'download as mp3',
          'just the audio please'
        ]
      },
      {
        command: 'playlist',
        description: 'Download entire playlist',
        usage: 'playlist [url] [options]',
        offerAsService: true
      },
      {
        command: 'formats',
        description: 'List available formats for a video',
        usage: 'formats [url]',
        offerAsService: false
      },
      {
        command: 'transcribe',
        description: 'Get transcript/subtitles from a video URL',
        usage: 'transcribe [url] [options]',
        offerAsService: true,
        examples: [
          'transcribe this YouTube video',
          'get the transcript from this video',
          'what does this video say',
          'extract subtitles from YouTube',
          'transcribe https://youtube.com/watch?v=...',
          'get captions from this video',
          'video transcript please',
          'show me what they say in this video'
        ]
      },
      {
        command: 'update',
        description: 'Update yt-dlp to the latest version',
        usage: 'update',
        offerAsService: false,
        examples: [
          'update yt-dlp',
          'upgrade yt-dlp',
          'get the latest version of yt-dlp'
        ]
      },
      {
        command: 'version',
        description: 'Show current yt-dlp version',
        usage: 'version',
        offerAsService: false
      }
    ];
    
    // VPN/proxy support: when useVpn is true, routes traffic through ExpressVPN's SOCKS proxy
    // or a custom proxy URL. Set via config or per-request.
    this.config = {
      useVpn: false,          // When true, connect ExpressVPN before downloads
      proxy: null,            // Custom proxy URL (e.g., 'socks5://127.0.0.1:1080')
    };

    this.downloadDir = path.join(process.cwd(), 'downloads');
    this.ensureDownloadDirectory();
  }

  async ensureDownloadDirectory() {
    try {
      await fs.mkdir(this.downloadDir, { recursive: true });
    } catch (error) {
      logger.error('Failed to create download directory:', error);
    }
  }

  /**
   * Sanitize a filename by replacing spaces and problematic characters with underscores.
   * Renames the file on disk and returns the new path.
   */
  async sanitizeDownloadedFile(filePath) {
    if (!filePath) return filePath;
    try {
      const dir = path.dirname(filePath);
      const ext = path.extname(filePath);
      const base = path.basename(filePath, ext);
      // Replace spaces, parentheses, brackets, and other URL-problematic chars with underscores
      // Then collapse multiple underscores and trim trailing ones
      const sanitized = base
        .replace(/[\s]+/g, '_')
        .replace(/[()[\]{}&$#@!%^+~`=,;'"]+/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_|_$/g, '');
      const newName = sanitized + ext;
      if (newName !== path.basename(filePath)) {
        const newPath = path.join(dir, newName);
        await fs.rename(filePath, newPath);
        logger.info(`Sanitized filename: "${path.basename(filePath)}" -> "${newName}"`);
        return newPath;
      }
      return filePath;
    } catch (error) {
      logger.warn(`Failed to sanitize filename, keeping original: ${error.message}`);
      return filePath;
    }
  }

  async execute(params) {
    const { action, ...data } = params;
    
    try {
      switch(action) {
        case 'download':
          return await this.downloadMedia(data);
          
        case 'info':
          return await this.getVideoInfo(data);
          
        case 'search':
          return await this.searchVideos(data);
          
        case 'playlist':
          return await this.downloadPlaylist(data);
          
        case 'formats':
          return await this.listFormats(data);
          
        case 'audio':
          return await this.downloadAudio(data);
          
        case 'thumbnail':
          return await this.downloadThumbnail(data);

        case 'transcribe':
          return await this.transcribeVideo(data);

        case 'update':
          return await this.updateYtDlp();

        case 'version':
          return await this.getVersion();

        default:
          return {
            success: false,
            error: 'Unknown action. Use: download, info, search, playlist, formats, audio, thumbnail, transcribe, update, version'
          };
      }
    } catch (error) {
      logger.error('YtDlp plugin error:', error);
      return { success: false, error: error.message };
    }
  }

  async downloadMedia(data) {
    let { url, format = 'best', quality = 'best', subtitles = false, output } = data;

    // If no URL but a search query is provided, search YouTube first and use the top result
    if (!url && data.query) {
      const searchResult = await this.searchVideos({ query: data.query, limit: 1 });
      if (searchResult.success && searchResult.videos && searchResult.videos.length > 0) {
        url = searchResult.videos[0].url;
        logger.info(`Auto-searched for "${data.query}", using: ${searchResult.videos[0].title} (${url})`);
      } else {
        return { success: false, error: `No videos found for: ${data.query}` };
      }
    }

    if (!url) {
      return { success: false, error: 'URL or search query required' };
    }

    await this._ensureVpn();

    // Build yt-dlp command
    let command = this._buildBaseCommand(data);
    
    // Format selection
    if (quality === 'best') {
      command += ` -f "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best"`;
    } else if (quality === 'worst') {
      command += ` -f worst`;
    } else if (quality.includes('p')) {
      // Specific resolution like 720p, 1080p
      command += ` -f "bestvideo[height<=${quality.replace('p', '')}]+bestaudio/best[height<=${quality.replace('p', '')}]"`;
    } else if (format) {
      command += ` -f ${format}`;
    }
    
    // Output template
    const outputTemplate = output || '%(title)s.%(ext)s';
    command += ` -o "${path.join(this.downloadDir, outputTemplate)}"`;
    
    // Add subtitles if requested
    if (subtitles) {
      command += ` --write-subs --sub-langs "en.*,es.*"`;
    }
    
    // Add URL
    command += ` "${url}"`;
    
    // Progress output
    command += ` --newline`;
    
    try {
      logger.info(`Downloading media: ${command}`);

      // Use execAsync to capture all output
      const { stdout, stderr } = await execAsync(command, { maxBuffer: 50 * 1024 * 1024 });
      const output = stdout + '\n' + stderr;

      // Extract filename from output - check multiple patterns:
      // 1. Merged file: [Merger] Merging formats into "path/file.mp4"
      // 2. Direct download: [download] Destination: path/file.mp4
      // 3. Already exists: [download] path/file.mp4 has already been downloaded
      let downloadedFile = null;

      // Check for merged file (most common for video+audio)
      const mergerMatch = output.match(/\[Merger\] Merging formats into "?([^"\n]+)"?/);
      if (mergerMatch) {
        downloadedFile = mergerMatch[1].trim();
      }

      // Check for direct download destination
      if (!downloadedFile) {
        const destMatch = output.match(/\[download\] Destination: (.+)/);
        if (destMatch) {
          downloadedFile = destMatch[1].trim();
        }
      }

      // Check for already downloaded file
      if (!downloadedFile) {
        const alreadyMatch = output.match(/\[download\] (.+\.(?:mp4|mkv|webm|avi|mov)) has already been downloaded/);
        if (alreadyMatch) {
          downloadedFile = alreadyMatch[1].trim();
        }
      }

      // Extract progress
      let lastProgress = '100%';
      const progressMatch = output.match(/(\d+\.?\d*)%/g);
      if (progressMatch && progressMatch.length > 0) {
        lastProgress = progressMatch[progressMatch.length - 1];
      }

      logger.info(`Video download - extracted file path: ${downloadedFile || 'none'}`);

      // Sanitize filename (replace spaces/special chars with underscores)
      downloadedFile = await this.sanitizeDownloadedFile(downloadedFile);

      // Get file info
      let fileInfo = null;
      if (downloadedFile) {
        try {
          const stats = await fs.stat(downloadedFile);
          fileInfo = {
            path: downloadedFile,
            size: this.formatFileSize(stats.size),
            filename: path.basename(downloadedFile)
          };
        } catch (e) {
          logger.warn('Could not get file stats:', e);
        }
      }

      // Use the filename (without extension) as the title for caption
      const title = fileInfo ? path.basename(fileInfo.filename, path.extname(fileInfo.filename)) : null;

      return {
        success: true,
        result: title || `Video downloaded successfully`,
        file: fileInfo,
        progress: lastProgress,
        command: command
      };

    } catch (error) {
      return {
        success: false,
        error: `Download failed: ${error.message}`,
        stderr: error.stderr || error.message
      };
    }
  }

  async getVideoInfo(data) {
    const { url } = data;
    
    if (!url) {
      return { success: false, error: 'URL required' };
    }
    
    const command = `${this._buildBaseCommand(data)} -j "${url}"`;

    try {
      logger.info(`Getting video info: ${command}`);
      const { stdout } = await execAsync(command);
      
      const info = JSON.parse(stdout);
      
      // Format the info into a readable format
      const formattedInfo = {
        title: info.title,
        channel: info.channel || info.uploader,
        duration: this.formatDuration(info.duration),
        views: info.view_count ? info.view_count.toLocaleString() : 'N/A',
        likes: info.like_count ? info.like_count.toLocaleString() : 'N/A',
        uploadDate: info.upload_date ? this.formatDate(info.upload_date) : 'N/A',
        description: info.description ? info.description.substring(0, 200) + '...' : 'N/A',
        thumbnail: info.thumbnail,
        formats: info.formats ? info.formats.length : 0,
        url: info.webpage_url || url
      };
      
      return {
        success: true,
        result: this.formatVideoInfo(formattedInfo),
        data: formattedInfo,
        raw: info
      };
      
    } catch (error) {
      return {
        success: false,
        error: `Failed to get video info: ${error.message}`
      };
    }
  }

  async searchVideos(data) {
    const { query, limit = 5 } = data;
    
    if (!query) {
      return { success: false, error: 'Search query required' };
    }
    
    // yt-dlp search syntax
    const searchUrl = `ytsearch${limit}:${query}`;
    const command = `${this._buildBaseCommand(data)} -j --flat-playlist "${searchUrl}"`;

    try {
      logger.info(`Searching videos: ${command}`);
      const { stdout } = await execAsync(command);
      
      // Parse each line as JSON (yt-dlp outputs one JSON object per line)
      const videos = stdout.trim().split('\n').map(line => {
        try {
          const video = JSON.parse(line);
          return {
            title: video.title,
            channel: video.channel || video.uploader,
            duration: video.duration ? this.formatDuration(video.duration) : 'N/A',
            url: video.url || `https://www.youtube.com/watch?v=${video.id}`,
            id: video.id,
            views: video.view_count ? video.view_count.toLocaleString() : 'N/A'
          };
        } catch (e) {
          return null;
        }
      }).filter(v => v !== null);
      
      return {
        success: true,
        result: `Found ${videos.length} videos`,
        videos: videos,
        query: query
      };
      
    } catch (error) {
      return {
        success: false,
        error: `Search failed: ${error.message}`
      };
    }
  }

  async downloadPlaylist(data) {
    const { url, format = 'best', maxItems = 0, reverse = false } = data;
    
    if (!url) {
      return { success: false, error: 'Playlist URL required' };
    }
    
    await this._ensureVpn();

    let command = `${this._buildBaseCommand(data)} -f ${format}`;

    // Output template for playlists
    command += ` -o "${path.join(this.downloadDir, '%(playlist)s/%(playlist_index)s - %(title)s.%(ext)s')}"`;
    
    // Limit number of items
    if (maxItems > 0) {
      command += ` --playlist-items 1-${maxItems}`;
    }
    
    // Reverse playlist order
    if (reverse) {
      command += ` --playlist-reverse`;
    }
    
    // Archive file to track downloaded videos
    command += ` --download-archive "${path.join(this.downloadDir, 'archive.txt')}"`;
    
    command += ` "${url}"`;
    
    try {
      logger.info(`Downloading playlist: ${command}`);
      const { stdout, stderr } = await execAsync(command, { maxBuffer: 10 * 1024 * 1024 });
      
      // Parse output to count downloads
      const downloadCount = (stderr.match(/\[download\] Downloading video/g) || []).length;
      
      return {
        success: true,
        result: `Playlist download completed. Downloaded ${downloadCount} videos`,
        location: path.join(this.downloadDir),
        command: command
      };
      
    } catch (error) {
      return {
        success: false,
        error: `Playlist download failed: ${error.message}`,
        stderr: error.stderr
      };
    }
  }

  async listFormats(data) {
    const { url } = data;
    
    if (!url) {
      return { success: false, error: 'URL required' };
    }
    
    const command = `${this._buildBaseCommand(data)} -F "${url}"`;

    try {
      logger.info(`Listing formats: ${command}`);
      const { stdout } = await execAsync(command);
      
      // Parse the format table
      const lines = stdout.split('\n');
      const formats = [];
      let startParsing = false;
      
      lines.forEach(line => {
        if (line.includes('ID  EXT')) {
          startParsing = true;
          return;
        }
        
        if (startParsing && line.trim()) {
          // Parse format line
          const match = line.match(/^(\S+)\s+(\S+)\s+(.+?)(?:\s+(\d+k))?\s+(.+)$/);
          if (match) {
            formats.push({
              id: match[1],
              ext: match[2],
              resolution: match[3].trim(),
              filesize: match[4] || 'N/A',
              note: match[5].trim()
            });
          }
        }
      });
      
      // Group by quality
      const videoFormats = formats.filter(f => f.note.includes('video') || f.resolution.includes('x'));
      const audioFormats = formats.filter(f => f.note.includes('audio only'));
      
      return {
        success: true,
        result: `Found ${formats.length} formats (${videoFormats.length} video, ${audioFormats.length} audio)`,
        formats: {
          video: videoFormats,
          audio: audioFormats,
          all: formats
        },
        raw: stdout
      };
      
    } catch (error) {
      return {
        success: false,
        error: `Failed to list formats: ${error.message}`
      };
    }
  }

  async downloadAudio(data) {
    const validAudioFormats = ['mp3', 'm4a', 'aac', 'flac', 'opus', 'vorbis', 'wav', 'best'];
    const videoFormats = ['mp4', 'mkv', 'webm', 'avi', 'mov', 'flv'];
    let { url, format = 'mp3', quality = 'best', output } = data;

    // If a video format was requested, redirect to video download instead
    if (videoFormats.includes(format)) {
      logger.info(`Audio handler received video format "${format}", redirecting to video download`);
      return this.downloadMedia(data);
    }

    // Normalize invalid audio formats to mp3
    if (!validAudioFormats.includes(format)) {
      const original = format;
      format = 'mp3';
      logger.info(`Audio format "${original}" is not valid for yt-dlp, using "${format}" instead`);
    }

    // If no URL but a search query is provided, search YouTube first and use the top result
    if (!url && data.query) {
      const searchResult = await this.searchVideos({ query: data.query, limit: 1 });
      if (searchResult.success && searchResult.videos && searchResult.videos.length > 0) {
        url = searchResult.videos[0].url;
        logger.info(`Auto-searched for "${data.query}", using: ${searchResult.videos[0].title} (${url})`);
      } else {
        return { success: false, error: `No videos found for: ${data.query}` };
      }
    }

    if (!url) {
      return { success: false, error: 'URL or search query required' };
    }
    
    await this._ensureVpn();

    let command = `${this._buildBaseCommand(data)} -x --audio-format ${format}`;

    // Audio quality
    if (quality === 'best') {
      command += ` --audio-quality 0`;
    } else if (quality === 'worst') {
      command += ` --audio-quality 9`;
    } else {
      command += ` --audio-quality ${quality}`;
    }
    
    // Output template
    const outputTemplate = output || '%(title)s.%(ext)s';
    command += ` -o "${path.join(this.downloadDir, outputTemplate)}"`;
    
    // Add metadata
    command += ` --embed-metadata --embed-thumbnail`;
    
    command += ` "${url}"`;
    
    try {
      logger.info(`Downloading audio: ${command}`);
      const { stdout, stderr } = await execAsync(command);
      
      // Extract filename from output (check both stdout and stderr)
      // Handle multiple yt-dlp output formats:
      // - New download: [ExtractAudio] Destination: /path/file.mp3
      // - Already exists: [download] /path/file.mp3 has already been downloaded
      // - No conversion needed: [ExtractAudio] Not converting audio /path/file.mp3
      let downloadedFile = null;
      const output = stdout + '\n' + stderr;

      const destinationMatch = output.match(/\[ExtractAudio\] Destination: (.+)/);
      const alreadyDownloadedMatch = output.match(/\[download\] (.+\.(?:mp3|m4a|wav|ogg|flac|aac|opus)) has already been downloaded/);
      const notConvertingMatch = output.match(/\[ExtractAudio\] Not converting audio (.+);/);

      if (destinationMatch) {
        downloadedFile = destinationMatch[1].trim();
      } else if (alreadyDownloadedMatch) {
        downloadedFile = alreadyDownloadedMatch[1].trim();
      } else if (notConvertingMatch) {
        downloadedFile = notConvertingMatch[1].trim();
      }

      logger.info(`Audio download - extracted file path: ${downloadedFile || 'none'}`);

      // Sanitize filename (replace spaces/special chars with underscores)
      downloadedFile = await this.sanitizeDownloadedFile(downloadedFile);

      let fileInfo = null;
      if (downloadedFile) {
        try {
          const stats = await fs.stat(downloadedFile);
          fileInfo = {
            path: downloadedFile,
            size: this.formatFileSize(stats.size),
            filename: path.basename(downloadedFile)
          };
        } catch (e) {
          logger.warn('Could not get file stats:', e);
        }
      }
      
      // Use the filename (without extension) as the title for caption
      // yt-dlp uses %(title)s which typically gives "Artist - Song" format
      const title = fileInfo ? path.basename(fileInfo.filename, path.extname(fileInfo.filename)) : null;

      return {
        success: true,
        result: title || `Audio downloaded successfully in ${format} format`,
        file: fileInfo,
        format: format,
        command: command
      };
      
    } catch (error) {
      return {
        success: false,
        error: `Audio download failed: ${error.message}`,
        stderr: error.stderr
      };
    }
  }

  async downloadThumbnail(data) {
    const { url } = data;
    
    if (!url) {
      return { success: false, error: 'URL required' };
    }
    
    const command = `${this._buildBaseCommand(data)} --write-thumbnail --skip-download -o "${path.join(this.downloadDir, '%(title)s')}" "${url}"`;

    try {
      logger.info(`Downloading thumbnail: ${command}`);
      const { stdout, stderr } = await execAsync(command);
      
      // Extract thumbnail filename
      let thumbnailFile = null;
      const match = stderr.match(/\[info\] Writing video thumbnail to: (.+)/);
      if (match) {
        thumbnailFile = match[1].trim();
      }
      
      if (!thumbnailFile) {
        // Try to find the file
        const files = await fs.readdir(this.downloadDir);
        const recentFile = files
          .filter(f => f.endsWith('.jpg') || f.endsWith('.png') || f.endsWith('.webp'))
          .sort((a, b) => {
            const statA = fs.statSync(path.join(this.downloadDir, a));
            const statB = fs.statSync(path.join(this.downloadDir, b));
            return statB.mtime - statA.mtime;
          })[0];

        if (recentFile) {
          thumbnailFile = path.join(this.downloadDir, recentFile);
        }
      }

      // Sanitize filename (replace spaces/special chars with underscores)
      thumbnailFile = await this.sanitizeDownloadedFile(thumbnailFile);

      return {
        success: true,
        result: 'Thumbnail downloaded successfully',
        file: thumbnailFile,
        command: command
      };
      
    } catch (error) {
      return {
        success: false,
        error: `Thumbnail download failed: ${error.message}`,
        stderr: error.stderr
      };
    }
  }

  /**
   * Build the base yt-dlp command with VPN/proxy flags if configured
   */
  _buildBaseCommand(data = {}) {
    let cmd = this.ytdlpBase;
    // Per-request proxy overrides config
    const proxy = data.proxy || this.config.proxy;
    if (proxy) {
      cmd += ` --proxy "${proxy}"`;
    }
    return cmd;
  }

  /**
   * Ensure VPN is connected before download if useVpn is enabled.
   * Returns true if VPN is ready (or not needed), false if VPN connect failed.
   */
  async _ensureVpn() {
    if (!this.config.useVpn) return true;
    try {
      const { stdout } = await execAsync('expressvpnctl get connectionstate');
      if (stdout.trim() === 'Connected') return true;
      logger.info('yt-dlp: useVpn enabled but VPN disconnected, connecting...');
      await execAsync('expressvpnctl connect', { timeout: 35000 });
      // Wait for connection
      for (let i = 0; i < 15; i++) {
        await new Promise(r => setTimeout(r, 2000));
        const { stdout: state } = await execAsync('expressvpnctl get connectionstate');
        if (state.trim() === 'Connected') {
          logger.info('yt-dlp: VPN connected successfully');
          return true;
        }
      }
      logger.warn('yt-dlp: VPN connection timed out');
      return false;
    } catch (error) {
      logger.warn('yt-dlp: VPN connect failed:', error.message);
      return false;
    }
  }

  /**
   * Update yt-dlp to the latest version
   */
  async updateYtDlp() {
    try {
      const { stdout: oldVersion } = await execAsync('yt-dlp --version');
      logger.info(`Updating yt-dlp from version ${oldVersion.trim()}`);

      // Try direct binary download (most reliable, avoids PEP 668 issues)
      try {
        await execAsync(
          'curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && chmod a+rx /usr/local/bin/yt-dlp',
          { timeout: 60000 }
        );
      } catch (dlError) {
        // Fallback: try pip
        try {
          await execAsync('pip3 install --break-system-packages -U yt-dlp', { timeout: 120000 });
        } catch (pipError) {
          // Last resort: yt-dlp self-update
          await execAsync('yt-dlp -U', { timeout: 60000 });
        }
      }

      const { stdout: newVersion } = await execAsync('yt-dlp --version');
      const updated = oldVersion.trim() !== newVersion.trim();

      return {
        success: true,
        result: updated
          ? `yt-dlp updated: ${oldVersion.trim()} → ${newVersion.trim()}`
          : `yt-dlp is already at the latest version (${newVersion.trim()})`,
        oldVersion: oldVersion.trim(),
        newVersion: newVersion.trim(),
        updated
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to update yt-dlp: ${error.message}`
      };
    }
  }

  /**
   * Get current yt-dlp version
   */
  async getVersion() {
    try {
      const { stdout } = await execAsync('yt-dlp --version');
      return {
        success: true,
        result: `yt-dlp version: ${stdout.trim()}`,
        version: stdout.trim()
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to get version: ${error.message}`
      };
    }
  }

  // Helper methods
  formatFileSize(bytes) {
    const sizes = ['B', 'KB', 'MB', 'GB'];
    if (bytes === 0) return '0 B';
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${sizes[i]}`;
  }

  formatDuration(seconds) {
    if (!seconds || seconds === 'N/A') return 'N/A';
    
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    
    if (h > 0) {
      return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    }
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  formatDate(dateStr) {
    if (!dateStr) return 'N/A';
    
    // Parse YYYYMMDD format
    const year = dateStr.substring(0, 4);
    const month = dateStr.substring(4, 6);
    const day = dateStr.substring(6, 8);
    
    return `${year}-${month}-${day}`;
  }

  formatVideoInfo(info) {
    let result = `📹 **${info.title}**\n\n`;
    result += `👤 **Channel**: ${info.channel}\n`;
    result += `⏱️ **Duration**: ${info.duration}\n`;
    result += `👁️ **Views**: ${info.views}\n`;
    result += `👍 **Likes**: ${info.likes}\n`;
    result += `📅 **Upload Date**: ${info.uploadDate}\n`;
    result += `\n📝 **Description**: ${info.description}\n`;
    result += `\n🔗 **URL**: ${info.url}`;

    return result;
  }

  // --- Transcription Methods ---

  async transcribeVideo(data) {
    const { url, lang = 'en', forceAudio = false } = data;
    const videoUrl = url || data.input || data.query || '';

    if (!videoUrl) {
      return { success: false, error: 'URL required' };
    }

    // Get video info for title/duration
    let videoTitle = 'Video';
    let videoDuration = 0;
    try {
      const info = await this.getVideoInfo({ url: videoUrl });
      if (info.success && info.data) {
        videoTitle = info.data.title || 'Video';
        videoDuration = info.raw?.duration || 0;
      }
    } catch (e) {
      logger.warn('Could not get video info for transcription:', e.message);
    }

    // Try subtitle extraction first (fast, free)
    if (!forceAudio) {
      try {
        const subResult = await this.extractSubtitles(videoUrl, lang);
        if (subResult.success && subResult.text) {
          return {
            success: true,
            result: this.formatTranscript(videoTitle, subResult.text, 'subtitles'),
            method: 'subtitles',
            title: videoTitle,
            duration: videoDuration
          };
        }
      } catch (e) {
        logger.info('Subtitle extraction failed, falling back to audio transcription:', e.message);
      }
    }

    // Fall back to audio download + Whisper transcription
    try {
      const transcription = await this.transcribeViaAudio(videoUrl, lang, videoDuration);
      return {
        success: true,
        result: this.formatTranscript(videoTitle, transcription, 'whisper'),
        method: 'whisper',
        title: videoTitle,
        duration: videoDuration
      };
    } catch (e) {
      return {
        success: false,
        error: `Transcription failed: ${e.message}`
      };
    }
  }

  async extractSubtitles(url, lang = 'en') {
    const tempDir = path.join(this.downloadDir, `subs_${Date.now()}`);
    await fs.mkdir(tempDir, { recursive: true });

    const outputTemplate = path.join(tempDir, 'subtitle');

    try {
      // Try manual (human-written) subtitles first
      let command = `${this._buildBaseCommand({})} --write-subs --sub-langs "${lang}.*" --skip-download --sub-format vtt -o "${outputTemplate}" "${url}"`;
      logger.info(`Extracting manual subtitles: ${command}`);

      try {
        await execAsync(command, { timeout: 30000 });
      } catch {
        // yt-dlp may exit non-zero if no subs found, that's ok
      }

      let subFile = await this.findSubtitleFile(tempDir);

      if (!subFile) {
        // Try auto-generated subtitles
        command = `${this._buildBaseCommand({})} --write-auto-subs --sub-langs "${lang}.*" --skip-download --sub-format vtt -o "${outputTemplate}" "${url}"`;
        logger.info(`Extracting auto subtitles: ${command}`);
        try {
          await execAsync(command, { timeout: 30000 });
        } catch {
          // Same - non-zero exit is ok
        }
        subFile = await this.findSubtitleFile(tempDir);
      }

      if (!subFile) {
        return { success: false, error: 'No subtitles available for this video' };
      }

      const rawContent = await fs.readFile(subFile, 'utf-8');
      const ext = path.extname(subFile).toLowerCase();

      let cleanText;
      if (ext === '.vtt') {
        cleanText = this.parseVTT(rawContent);
      } else if (ext === '.srt') {
        cleanText = this.parseSRT(rawContent);
      } else {
        cleanText = rawContent;
      }

      if (!cleanText || cleanText.trim().length < 10) {
        return { success: false, error: 'Subtitles extracted but contained no usable text' };
      }

      return { success: true, text: cleanText };

    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async findSubtitleFile(dir) {
    try {
      const files = await fs.readdir(dir);
      const subExts = ['.vtt', '.srt', '.ass', '.ssa', '.sub'];
      const subFile = files.find(f => subExts.some(ext => f.endsWith(ext)));
      return subFile ? path.join(dir, subFile) : null;
    } catch {
      return null;
    }
  }

  parseVTT(content) {
    const lines = content.split('\n');
    const textLines = [];
    let lastLine = '';

    for (const line of lines) {
      const trimmed = line.trim();

      // Skip VTT header, timestamps, cue IDs, metadata, and empty lines
      if (trimmed === 'WEBVTT' ||
          trimmed === '' ||
          /^\d+$/.test(trimmed) ||
          /-->/.test(trimmed) ||
          /^NOTE/.test(trimmed) ||
          /^STYLE/.test(trimmed) ||
          /^Kind:/.test(trimmed) ||
          /^Language:/.test(trimmed)) {
        continue;
      }

      // Remove HTML tags and entities
      let clean = trimmed
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&nbsp;/g, ' ')
        .trim();

      // Deduplicate consecutive identical lines (common in auto-subs)
      if (clean && clean !== lastLine) {
        textLines.push(clean);
        lastLine = clean;
      }
    }

    return textLines.join(' ');
  }

  parseSRT(content) {
    const lines = content.split('\n');
    const textLines = [];
    let lastLine = '';

    for (const line of lines) {
      const trimmed = line.trim();

      if (trimmed === '' ||
          /^\d+$/.test(trimmed) ||
          /-->/.test(trimmed)) {
        continue;
      }

      let clean = trimmed
        .replace(/<[^>]+>/g, '')
        .trim();

      if (clean && clean !== lastLine) {
        textLines.push(clean);
        lastLine = clean;
      }
    }

    return textLines.join(' ');
  }

  async transcribeViaAudio(url, lang, durationSeconds = 0) {
    // Download audio as MP3 at moderate quality (smaller files)
    const audioResult = await this.downloadAudio({ url, format: 'mp3', quality: '5' });

    if (!audioResult.success || !audioResult.file?.path) {
      throw new Error('Audio download failed: ' + (audioResult.error || 'Unknown error'));
    }

    const audioPath = audioResult.file.path;

    try {
      const stats = await fs.stat(audioPath);
      const fileSizeMB = stats.size / (1024 * 1024);

      logger.info(`Audio file for transcription: ${audioPath}, size: ${fileSizeMB.toFixed(1)}MB`);

      const WHISPER_LIMIT_MB = 24; // 25MB limit with margin

      if (fileSizeMB <= WHISPER_LIMIT_MB) {
        // Single-shot transcription
        const audioBuffer = await fs.readFile(audioPath);
        const transcription = await this.agent.providerManager.transcribeAudio(audioBuffer);
        return transcription;
      }

      // Need to chunk the audio
      logger.info(`Audio exceeds Whisper limit (${fileSizeMB.toFixed(1)}MB > ${WHISPER_LIMIT_MB}MB), splitting into chunks`);
      return await this.transcribeChunked(audioPath);

    } finally {
      await fs.unlink(audioPath).catch(() => {});
    }
  }

  async transcribeChunked(audioPath) {
    const chunkDir = path.join(this.downloadDir, `chunks_${Date.now()}`);
    await fs.mkdir(chunkDir, { recursive: true });

    try {
      // Get audio duration via ffprobe
      const { stdout: probeOut } = await execAsync(
        `ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${audioPath}"`
      );
      const totalDuration = parseFloat(probeOut.trim());

      if (isNaN(totalDuration) || totalDuration <= 0) {
        throw new Error('Could not determine audio duration');
      }

      // 20-minute chunks (~20MB at 128kbps, under 24MB limit)
      const CHUNK_SECONDS = 20 * 60;
      const numChunks = Math.ceil(totalDuration / CHUNK_SECONDS);

      logger.info(`Splitting ${this.formatDuration(totalDuration)} audio into ${numChunks} chunks`);

      const transcriptions = [];

      for (let i = 0; i < numChunks; i++) {
        const startTime = i * CHUNK_SECONDS;
        const chunkPath = path.join(chunkDir, `chunk_${i}.mp3`);

        await execAsync(
          `ffmpeg -i "${audioPath}" -ss ${startTime} -t ${CHUNK_SECONDS} -acodec copy -y "${chunkPath}"`,
          { timeout: 60000 }
        );

        const chunkStats = await fs.stat(chunkPath).catch(() => null);
        if (!chunkStats || chunkStats.size < 1000) {
          logger.warn(`Chunk ${i} is empty or too small, skipping`);
          continue;
        }

        logger.info(`Transcribing chunk ${i + 1}/${numChunks} (${(chunkStats.size / (1024 * 1024)).toFixed(1)}MB)`);

        const chunkBuffer = await fs.readFile(chunkPath);
        const chunkText = await this.agent.providerManager.transcribeAudio(chunkBuffer);

        if (chunkText && chunkText.trim()) {
          transcriptions.push(chunkText.trim());
        }

        await fs.unlink(chunkPath).catch(() => {});
      }

      if (transcriptions.length === 0) {
        throw new Error('No speech detected in audio');
      }

      return transcriptions.join(' ');

    } finally {
      await fs.rm(chunkDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  formatTranscript(title, text, method) {
    const methodLabel = method === 'subtitles' ? 'Subtitles' : 'Audio Transcription (Whisper)';
    const truncated = text.length > 3800;
    const displayText = truncated ? text.substring(0, 3800) + '...\n\n[Transcript truncated]' : text;

    return `**${title}**\n` +
           `_Method: ${methodLabel}_\n\n` +
           `${displayText}`;
  }
}