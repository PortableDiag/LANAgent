import { test } from 'node:test';
import { strict as assert } from 'node:assert';

// The route itself needs an Express app + auth chain to exercise, so these
// tests pin the preset contract instead: every preset must only emit values
// the route's own allowlists and format validators would accept, since the
// preset branch bypasses the customProfile validation path.
import { TRANSCODE_PRESETS } from '../../src/api/external/routes/transcodePresets.js';

const ALLOWED_VIDEO_CODECS = ['libx264', 'libx265', 'libvpx', 'libvpx-vp9', 'copy'];
const ALLOWED_AUDIO_CODECS = ['aac', 'libmp3lame', 'libvorbis', 'libopus', 'flac', 'copy'];

test('all presets exist and use allowlisted codecs and valid formats', () => {
  const names = Object.keys(TRANSCODE_PRESETS);
  assert.deepEqual(names.sort(), ['archive', 'podcast', 'social-media']);

  for (const [name, profile] of Object.entries(TRANSCODE_PRESETS)) {
    if (profile.videoCodec !== undefined) {
      assert.ok(ALLOWED_VIDEO_CODECS.includes(profile.videoCodec), `${name}: videoCodec ${profile.videoCodec} not allowlisted`);
    }
    assert.ok(ALLOWED_AUDIO_CODECS.includes(profile.audioCodec), `${name}: audioCodec ${profile.audioCodec} not allowlisted`);
    if (profile.resolution !== undefined) {
      assert.match(profile.resolution, /^\d+x\d+$/, `${name}: bad resolution format`);
    }
    if (profile.videoBitrate !== undefined) {
      assert.match(profile.videoBitrate, /^\d+k$/, `${name}: bad videoBitrate format`);
    }
    if (profile.audioBitrate !== undefined) {
      assert.match(profile.audioBitrate, /^\d+k$/, `${name}: bad audioBitrate format`);
    }
  }
});

test('podcast preset sets no video codec so audio-only outputs work', () => {
  // ffmpeg fails on explicit -c:v (even 'copy') when the target container
  // is audio-only (mp3/wav/flac/ogg/aac); omitting it lets ffmpeg drop the
  // video track automatically.
  assert.equal(TRANSCODE_PRESETS.podcast.videoCodec, undefined);
});

test('archive preset copies audio instead of re-encoding', () => {
  assert.equal(TRANSCODE_PRESETS.archive.audioCodec, 'copy');
});
