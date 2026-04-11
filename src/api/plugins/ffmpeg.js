import { BasePlugin } from '../core/basePlugin.js';
import { logger } from '../../utils/logger.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';

const execAsync = promisify(exec);

export default class FFmpegPlugin extends BasePlugin {
  constructor(agent) {
    super(agent);
    this.name = 'ffmpeg';
    this.version = '1.0.0';
    this.description = 'Audio and video processing using FFmpeg';
    this.commands = [
      {
        command: 'convert',
        description: 'Convert media between formats',
        usage: 'convert [input] to [output] [options]',
        offerAsService: true
      },
      {
        command: 'extract',
        description: 'Extract audio, video, or frames from media',
        usage: 'extract [audio|video|frames] from [input]',
        offerAsService: true
      },
      {
        command: 'compress',
        description: 'Compress media files',
        usage: 'compress [input] [quality]',
        offerAsService: true
      },
      {
        command: 'info',
        description: 'Get media file information',
        usage: 'info [file]',
        offerAsService: true
      },
      {
        command: 'concat',
        description: 'Concatenate multiple media files',
        usage: 'concat [file1] [file2] ... to [output]',
        offerAsService: true
      },
      {
        command: 'trim',
        description: 'Trim media file',
        usage: 'trim [input] from [start] to [end]',
        offerAsService: true
      }
    ];
    
    this.mediaDir = path.join(process.cwd(), 'media');
    this.ensureMediaDirectory();
  }

  // Safe fraction parser to replace eval()
  parseFraction(fractionStr) {
    if (!fractionStr || typeof fractionStr !== 'string') return 0;
    
    const parts = fractionStr.split('/');
    if (parts.length !== 2) {
      // Try to parse as a regular number
      const num = parseFloat(fractionStr);
      return isNaN(num) ? 0 : num;
    }
    
    const numerator = parseFloat(parts[0]);
    const denominator = parseFloat(parts[1]);
    
    if (isNaN(numerator) || isNaN(denominator) || denominator === 0) {
      return 0;
    }
    
    return numerator / denominator;
  }

  async ensureMediaDirectory() {
    try {
      await fs.mkdir(this.mediaDir, { recursive: true });
    } catch (error) {
      logger.error('Failed to create media directory:', error);
    }
  }

  async execute(params) {
    const { action, ...data } = params;
    
    try {
      switch(action) {
        case 'convert':
          return await this.convertMedia(data);
          
        case 'extract':
          return await this.extractFromMedia(data);
          
        case 'compress':
          return await this.compressMedia(data);
          
        case 'info':
          return await this.getMediaInfo(data);
          
        case 'concat':
          return await this.concatenateMedia(data);
          
        case 'trim':
          return await this.trimMedia(data);
          
        case 'thumbnail':
          return await this.generateThumbnail(data);
          
        case 'gif':
          return await this.createGif(data);
          
        case 'watermark':
          return await this.addWatermark(data);
          
        default:
          return { 
            success: false, 
            error: 'Unknown action. Use: convert, extract, compress, info, concat, trim, thumbnail, gif, watermark' 
          };
      }
    } catch (error) {
      logger.error('FFmpeg plugin error:', error);
      return { success: false, error: error.message };
    }
  }

  async convertMedia(data) {
    const { input, output, format, options = {} } = data;
    
    if (!input || !output) {
      return { success: false, error: 'Input and output files required' };
    }
    
    const inputPath = this.resolveMediaPath(input);
    const outputPath = this.resolveMediaPath(output);
    
    // Build FFmpeg command
    let command = `ffmpeg -i "${inputPath}"`;
    
    // Add codec options
    if (options.videoCodec) {
      command += ` -c:v ${options.videoCodec}`;
    }
    if (options.audioCodec) {
      command += ` -c:a ${options.audioCodec}`;
    }
    
    // Add quality options
    if (options.videoBitrate) {
      command += ` -b:v ${options.videoBitrate}`;
    }
    if (options.audioBitrate) {
      command += ` -b:a ${options.audioBitrate}`;
    }
    
    // Add resolution
    if (options.resolution) {
      command += ` -s ${options.resolution}`;
    }
    
    // Add frame rate
    if (options.fps) {
      command += ` -r ${options.fps}`;
    }
    
    // Overwrite output
    command += ` -y "${outputPath}"`;
    
    try {
      logger.info(`Converting media: ${command}`);
      const { stdout, stderr } = await execAsync(command);
      
      // Check if output file exists
      await fs.access(outputPath);
      
      return {
        success: true,
        result: `Media converted successfully`,
        output: outputPath,
        command: command,
        details: this.parseFFmpegOutput(stderr)
      };
    } catch (error) {
      return {
        success: false,
        error: `Conversion failed: ${error.message}`,
        stderr: error.stderr
      };
    }
  }

  async extractFromMedia(data) {
    const { type, input, output, options = {} } = data;
    
    if (!type || !input) {
      return { success: false, error: 'Type and input file required' };
    }
    
    const inputPath = this.resolveMediaPath(input);
    let command;
    
    switch(type) {
      case 'audio':
        const audioOutput = output || `${path.basename(input, path.extname(input))}.mp3`;
        const audioPath = this.resolveMediaPath(audioOutput);
        command = `ffmpeg -i "${inputPath}" -vn -acodec mp3 -y "${audioPath}"`;
        break;
        
      case 'video':
        const videoOutput = output || `${path.basename(input, path.extname(input))}_video.mp4`;
        const videoPath = this.resolveMediaPath(videoOutput);
        command = `ffmpeg -i "${inputPath}" -an -vcodec copy -y "${videoPath}"`;
        break;
        
      case 'frames':
        const framesDir = path.join(this.mediaDir, 'frames', Date.now().toString());
        await fs.mkdir(framesDir, { recursive: true });
        const fps = options.fps || 1;
        command = `ffmpeg -i "${inputPath}" -vf fps=${fps} "${framesDir}/frame_%04d.png"`;
        break;
        
      default:
        return { success: false, error: 'Invalid extraction type. Use: audio, video, or frames' };
    }
    
    try {
      logger.info(`Extracting ${type}: ${command}`);
      const { stdout, stderr } = await execAsync(command);
      
      return {
        success: true,
        result: `${type} extracted successfully`,
        type: type,
        output: type === 'frames' ? framesDir : (audioPath || videoPath),
        command: command
      };
    } catch (error) {
      return {
        success: false,
        error: `Extraction failed: ${error.message}`,
        stderr: error.stderr
      };
    }
  }

  async compressMedia(data) {
    const { input, quality = 'medium', output } = data;
    
    if (!input) {
      return { success: false, error: 'Input file required' };
    }
    
    const inputPath = this.resolveMediaPath(input);
    const outputPath = output ? 
      this.resolveMediaPath(output) : 
      this.resolveMediaPath(`${path.basename(input, path.extname(input))}_compressed${path.extname(input)}`);
    
    // Quality presets
    const qualityPresets = {
      'low': { crf: 35, audioBitrate: '96k' },
      'medium': { crf: 28, audioBitrate: '128k' },
      'high': { crf: 23, audioBitrate: '192k' },
      'best': { crf: 18, audioBitrate: '256k' }
    };
    
    const preset = qualityPresets[quality] || qualityPresets.medium;
    
    const command = `ffmpeg -i "${inputPath}" -c:v libx264 -crf ${preset.crf} -preset medium -c:a aac -b:a ${preset.audioBitrate} -y "${outputPath}"`;
    
    try {
      logger.info(`Compressing media: ${command}`);
      const { stdout, stderr } = await execAsync(command);
      
      // Get file sizes for comparison
      const inputStats = await fs.stat(inputPath);
      const outputStats = await fs.stat(outputPath);
      const reduction = ((1 - outputStats.size / inputStats.size) * 100).toFixed(2);
      
      return {
        success: true,
        result: `Media compressed successfully (${reduction}% size reduction)`,
        output: outputPath,
        originalSize: this.formatFileSize(inputStats.size),
        compressedSize: this.formatFileSize(outputStats.size),
        reduction: `${reduction}%`,
        command: command
      };
    } catch (error) {
      return {
        success: false,
        error: `Compression failed: ${error.message}`,
        stderr: error.stderr
      };
    }
  }

  async getMediaInfo(data) {
    const { file } = data;
    
    if (!file) {
      return { success: false, error: 'File path required' };
    }
    
    const filePath = this.resolveMediaPath(file);
    
    try {
      // Use ffprobe for detailed information
      const command = `ffprobe -v quiet -print_format json -show_format -show_streams "${filePath}"`;
      const { stdout } = await execAsync(command);
      const info = JSON.parse(stdout);
      
      // Parse the info into a more readable format
      const result = {
        format: info.format.format_name,
        duration: this.formatDuration(parseFloat(info.format.duration)),
        size: this.formatFileSize(parseInt(info.format.size)),
        bitrate: `${Math.round(info.format.bit_rate / 1000)} kbps`,
        streams: []
      };
      
      info.streams.forEach(stream => {
        if (stream.codec_type === 'video') {
          result.video = {
            codec: stream.codec_name,
            resolution: `${stream.width}x${stream.height}`,
            fps: this.parseFraction(stream.r_frame_rate),
            bitrate: stream.bit_rate ? `${Math.round(stream.bit_rate / 1000)} kbps` : 'N/A'
          };
        } else if (stream.codec_type === 'audio') {
          result.audio = {
            codec: stream.codec_name,
            channels: stream.channels,
            sampleRate: `${stream.sample_rate} Hz`,
            bitrate: stream.bit_rate ? `${Math.round(stream.bit_rate / 1000)} kbps` : 'N/A'
          };
        }
      });
      
      return {
        success: true,
        result: this.formatMediaInfo(result),
        data: result,
        raw: info
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to get media info: ${error.message}`
      };
    }
  }

  async concatenateMedia(data) {
    const { files, output } = data;
    
    if (!files || files.length < 2 || !output) {
      return { success: false, error: 'At least 2 input files and output file required' };
    }
    
    // Create a temporary file list
    const listFile = path.join(this.mediaDir, `concat_${Date.now()}.txt`);
    const fileContent = files.map(f => `file '${this.resolveMediaPath(f)}'`).join('\n');
    await fs.writeFile(listFile, fileContent);
    
    const outputPath = this.resolveMediaPath(output);
    const command = `ffmpeg -f concat -safe 0 -i "${listFile}" -c copy -y "${outputPath}"`;
    
    try {
      logger.info(`Concatenating media: ${command}`);
      const { stdout, stderr } = await execAsync(command);
      
      // Clean up temp file
      await fs.unlink(listFile);
      
      return {
        success: true,
        result: `${files.length} files concatenated successfully`,
        output: outputPath,
        command: command
      };
    } catch (error) {
      // Clean up temp file on error
      await fs.unlink(listFile).catch(() => {});
      
      return {
        success: false,
        error: `Concatenation failed: ${error.message}`,
        stderr: error.stderr
      };
    }
  }

  async trimMedia(data) {
    const { input, start, end, output } = data;
    
    if (!input || (!start && !end)) {
      return { success: false, error: 'Input file and at least start or end time required' };
    }
    
    const inputPath = this.resolveMediaPath(input);
    const outputPath = output ? 
      this.resolveMediaPath(output) : 
      this.resolveMediaPath(`${path.basename(input, path.extname(input))}_trimmed${path.extname(input)}`);
    
    let command = `ffmpeg -i "${inputPath}"`;
    
    if (start) {
      command += ` -ss ${start}`;
    }
    
    if (end && start) {
      // Calculate duration
      const duration = this.calculateDuration(start, end);
      command += ` -t ${duration}`;
    } else if (end) {
      command += ` -to ${end}`;
    }
    
    command += ` -c copy -y "${outputPath}"`;
    
    try {
      logger.info(`Trimming media: ${command}`);
      const { stdout, stderr } = await execAsync(command);
      
      return {
        success: true,
        result: `Media trimmed successfully`,
        output: outputPath,
        start: start || '0',
        end: end || 'end of file',
        command: command
      };
    } catch (error) {
      return {
        success: false,
        error: `Trim failed: ${error.message}`,
        stderr: error.stderr
      };
    }
  }

  async generateThumbnail(data) {
    const { input, time = '00:00:01', output } = data;
    
    if (!input) {
      return { success: false, error: 'Input video file required' };
    }
    
    const inputPath = this.resolveMediaPath(input);
    const outputPath = output ? 
      this.resolveMediaPath(output) : 
      this.resolveMediaPath(`${path.basename(input, path.extname(input))}_thumb.jpg`);
    
    const command = `ffmpeg -i "${inputPath}" -ss ${time} -vframes 1 -y "${outputPath}"`;
    
    try {
      logger.info(`Generating thumbnail: ${command}`);
      await execAsync(command);
      
      return {
        success: true,
        result: 'Thumbnail generated successfully',
        output: outputPath,
        time: time
      };
    } catch (error) {
      return {
        success: false,
        error: `Thumbnail generation failed: ${error.message}`,
        stderr: error.stderr
      };
    }
  }

  async createGif(data) {
    const { input, start = '0', duration = '5', fps = 10, scale = 320, output } = data;
    
    if (!input) {
      return { success: false, error: 'Input video file required' };
    }
    
    const inputPath = this.resolveMediaPath(input);
    const outputPath = output ? 
      this.resolveMediaPath(output) : 
      this.resolveMediaPath(`${path.basename(input, path.extname(input))}.gif`);
    
    const paletteFile = path.join(this.mediaDir, `palette_${Date.now()}.png`);
    
    // Generate palette for better quality
    const paletteCmd = `ffmpeg -i "${inputPath}" -ss ${start} -t ${duration} -vf "fps=${fps},scale=${scale}:-1:flags=lanczos,palettegen" -y "${paletteFile}"`;
    
    // Create GIF using palette
    const gifCmd = `ffmpeg -i "${inputPath}" -i "${paletteFile}" -ss ${start} -t ${duration} -lavfi "fps=${fps},scale=${scale}:-1:flags=lanczos[x];[x][1:v]paletteuse" -y "${outputPath}"`;
    
    try {
      logger.info('Generating GIF palette...');
      await execAsync(paletteCmd);
      
      logger.info('Creating GIF...');
      await execAsync(gifCmd);
      
      // Clean up palette file
      await fs.unlink(paletteFile);
      
      const stats = await fs.stat(outputPath);
      
      return {
        success: true,
        result: 'GIF created successfully',
        output: outputPath,
        size: this.formatFileSize(stats.size),
        parameters: { start, duration, fps, scale }
      };
    } catch (error) {
      // Clean up palette file on error
      await fs.unlink(paletteFile).catch(() => {});
      
      return {
        success: false,
        error: `GIF creation failed: ${error.message}`,
        stderr: error.stderr
      };
    }
  }

  async addWatermark(data) {
    const { input, watermark, position = 'bottom-right', opacity = 0.3, output } = data;
    
    if (!input || !watermark) {
      return { success: false, error: 'Input video and watermark image required' };
    }
    
    const inputPath = this.resolveMediaPath(input);
    const watermarkPath = this.resolveMediaPath(watermark);
    const outputPath = output ? 
      this.resolveMediaPath(output) : 
      this.resolveMediaPath(`${path.basename(input, path.extname(input))}_watermarked${path.extname(input)}`);
    
    // Position mappings
    const positions = {
      'top-left': 'overlay=10:10',
      'top-right': 'overlay=main_w-overlay_w-10:10',
      'bottom-left': 'overlay=10:main_h-overlay_h-10',
      'bottom-right': 'overlay=main_w-overlay_w-10:main_h-overlay_h-10',
      'center': 'overlay=(main_w-overlay_w)/2:(main_h-overlay_h)/2'
    };
    
    const overlayPosition = positions[position] || positions['bottom-right'];
    
    const command = `ffmpeg -i "${inputPath}" -i "${watermarkPath}" -filter_complex "[1:v]format=rgba,colorchannelmixer=aa=${opacity}[watermark];[0:v][watermark]${overlayPosition}" -codec:a copy -y "${outputPath}"`;
    
    try {
      logger.info(`Adding watermark: ${command}`);
      await execAsync(command);
      
      return {
        success: true,
        result: 'Watermark added successfully',
        output: outputPath,
        position: position,
        opacity: opacity
      };
    } catch (error) {
      return {
        success: false,
        error: `Watermark failed: ${error.message}`,
        stderr: error.stderr
      };
    }
  }

  // Helper methods
  resolveMediaPath(filename) {
    if (path.isAbsolute(filename)) {
      return filename;
    }
    return path.join(this.mediaDir, filename);
  }

  formatFileSize(bytes) {
    const sizes = ['B', 'KB', 'MB', 'GB'];
    if (bytes === 0) return '0 B';
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${sizes[i]}`;
  }

  formatDuration(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }

  calculateDuration(start, end) {
    const parseTime = (time) => {
      const parts = time.split(':');
      return parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseFloat(parts[2]);
    };
    
    const startSeconds = parseTime(start);
    const endSeconds = parseTime(end);
    return endSeconds - startSeconds;
  }

  parseFFmpegOutput(stderr) {
    // Extract useful information from FFmpeg stderr
    const lines = stderr.split('\n');
    const info = {};
    
    lines.forEach(line => {
      if (line.includes('Duration:')) {
        const match = line.match(/Duration: ([\d:.]+)/);
        if (match) info.duration = match[1];
      }
      if (line.includes('Video:')) {
        const match = line.match(/Video: (\S+)/);
        if (match) info.videoCodec = match[1];
      }
      if (line.includes('Audio:')) {
        const match = line.match(/Audio: (\S+)/);
        if (match) info.audioCodec = match[1];
      }
    });
    
    return info;
  }

  formatMediaInfo(info) {
    let result = `📹 **Media Information**\n\n`;
    result += `**Format**: ${info.format}\n`;
    result += `**Duration**: ${info.duration}\n`;
    result += `**Size**: ${info.size}\n`;
    result += `**Bitrate**: ${info.bitrate}\n`;
    
    if (info.video) {
      result += `\n**Video Stream**\n`;
      result += `• Codec: ${info.video.codec}\n`;
      result += `• Resolution: ${info.video.resolution}\n`;
      result += `• FPS: ${info.video.fps}\n`;
      result += `• Bitrate: ${info.video.bitrate}\n`;
    }
    
    if (info.audio) {
      result += `\n**Audio Stream**\n`;
      result += `• Codec: ${info.audio.codec}\n`;
      result += `• Channels: ${info.audio.channels}\n`;
      result += `• Sample Rate: ${info.audio.sampleRate}\n`;
      result += `• Bitrate: ${info.audio.bitrate}\n`;
    }
    
    return result;
  }
}