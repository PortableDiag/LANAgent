// Preset transcoding profiles for POST /api/external/transcode/convert —
// one-word alternatives to customProfile. Values must stay within the
// route's codec allowlists and format validators, since the preset branch
// bypasses customProfile validation (pinned by tests/unit/transcodePresets.test.js).
//
// podcast sets no videoCodec on purpose: audio-only targets (mp3/wav/…) can't
// carry a video stream, and an explicit -c:v (even 'copy') makes ffmpeg fail
// instead of dropping the video track. archive copies the source audio rather
// than re-encoding it — lossless-in, lossless-out.
export const TRANSCODE_PRESETS = {
  'social-media': {
    videoCodec: 'libx264',
    audioCodec: 'aac',
    resolution: '1080x1920',
    videoBitrate: '4000k',
    audioBitrate: '192k'
  },
  'podcast': {
    audioCodec: 'libmp3lame',
    audioBitrate: '128k'
  },
  'archive': {
    videoCodec: 'libx265',
    audioCodec: 'copy',
    videoBitrate: '8000k'
  }
};

// Display metadata for the presets above. Kept OUT of TRANSCODE_PRESETS:
// the preset branch Object.assigns those objects straight into ffmpeg convert
// options, so they must stay purely technical. supportedFormats must be a
// subset of the convert route's ALLOWED_OUTPUT_FORMATS.
export const PRESET_INFO = {
  'social-media': {
    displayName: 'Social Media Optimized',
    description: 'Optimized for social media platforms with high quality video and audio',
    useCases: ['Instagram', 'TikTok', 'Facebook', 'Twitter'],
    supportedFormats: ['mp4', 'webm']
  },
  'podcast': {
    displayName: 'Podcast Audio',
    description: 'High quality audio optimized for podcast distribution',
    useCases: ['Apple Podcasts', 'Spotify', 'Google Podcasts'],
    supportedFormats: ['mp3', 'wav']
  },
  'archive': {
    displayName: 'Archive Quality',
    description: 'Maximum quality preservation for long-term storage',
    useCases: ['Digital preservation', 'Master copies', 'Professional archiving'],
    supportedFormats: ['mp4', 'mkv']
  }
};

/**
 * Get structured metadata for all available transcoding presets
 * @returns {Array} Array of preset metadata objects
 */
export function getPresetMetadata() {
  return Object.entries(TRANSCODE_PRESETS).map(([key, preset]) => {
    const info = PRESET_INFO[key] || {};
    return {
      id: key,
      displayName: info.displayName || key,
      description: info.description || '',
      useCases: info.useCases || [],
      supportedFormats: info.supportedFormats || [],
      config: {
        videoCodec: preset.videoCodec,
        audioCodec: preset.audioCodec,
        resolution: preset.resolution,
        videoBitrate: preset.videoBitrate,
        audioBitrate: preset.audioBitrate
      }
    };
  });
}
