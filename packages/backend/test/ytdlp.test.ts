import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { downloadKaraokeVideo, searchYouTubeKaraoke, validateVideoId } from '../src/ytdlp.ts';

describe('validateVideoId', () => {
  it('accepts 11-character YouTube ids', () => {
    assert.equal(validateVideoId('dQw4w9WgXcQ'), true);
    assert.equal(validateVideoId('a-b_c-d_e-f'), true);
  });

  it('rejects anything that could reach yt-dlp as a flag or path', () => {
    for (const id of ['', 'short', 'dQw4w9WgXcQx', '--exec=rm -', '../../etc/pw', 'dQw4w9WgXc ']) {
      assert.equal(validateVideoId(id), false, id);
    }
  });
});

describe('downloadKaraokeVideo', () => {
  it('refuses invalid ids before spawning anything', async () => {
    await assert.rejects(downloadKaraokeVideo('--exec=sh'), /Invalid YouTube Video ID/);
  });
});

describe('searchYouTubeKaraoke', () => {
  it('returns no results for queries that sanitize to nothing', async () => {
    assert.deepEqual(await searchYouTubeKaraoke('$%^&*()'), []);
  });
});
