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
