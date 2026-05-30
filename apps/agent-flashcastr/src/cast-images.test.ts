import { describe, it, expect, afterEach } from 'vitest';
import { flashPhotoUrl } from './flashcastr-api.js';
import { resolvePhotoEmbed } from './daily-prep.js';
import { encodeEmbeds } from './farcaster-publish.js';

const CID = 'QmUxrjpXfN85X8udJVFW5DsKdjGV3LcxoasoX7v4oJdGV5';

afterEach(() => {
  delete process.env.FLASHCASTR_IPFS_GATEWAY;
});

describe('flashPhotoUrl', () => {
  it('builds a content-addressed gateway URL from ipfs_cid', () => {
    expect(flashPhotoUrl({ ipfs_cid: CID })).toBe(
      `https://fuchsia-rich-lungfish-648.mypinata.cloud/ipfs/${CID}`,
    );
  });

  it('returns null when there is no pinned image (resolver no-ops)', () => {
    expect(flashPhotoUrl({ ipfs_cid: null })).toBeNull();
    expect(flashPhotoUrl({ ipfs_cid: undefined })).toBeNull();
    expect(flashPhotoUrl({ ipfs_cid: '   ' })).toBeNull();
    expect(flashPhotoUrl({})).toBeNull();
  });

  it('honours FLASHCASTR_IPFS_GATEWAY override', () => {
    process.env.FLASHCASTR_IPFS_GATEWAY = 'https://ipfs.io';
    expect(flashPhotoUrl({ ipfs_cid: CID })).toBe(`https://ipfs.io/ipfs/${CID}`);
  });

  it('normalises a trailing slash and a trailing /ipfs on the gateway base', () => {
    expect(flashPhotoUrl({ ipfs_cid: CID }, 'https://g.example/')).toBe(
      `https://g.example/ipfs/${CID}`,
    );
    expect(flashPhotoUrl({ ipfs_cid: CID }, 'https://g.example/ipfs')).toBe(
      `https://g.example/ipfs/${CID}`,
    );
  });
});

describe('resolvePhotoEmbed', () => {
  const photoUrl = `https://fuchsia-rich-lungfish-648.mypinata.cloud/ipfs/${CID}`;
  const valid = {
    invaderIds: new Set<string>(),
    flashIds: new Set([100]),
    castHashes: new Set(['0xabc']),
    urls: new Set<string>(),
    flashLookup: new Map([
      [100, { flashId: 100, castHash: '0xabc', fid: 7, city: 'Paris', player: 'P', photoUrl }],
      [200, { flashId: 200, castHash: '0xdef', fid: 8, city: 'NYC', player: 'Q', photoUrl: null }],
    ]),
  };

  it('attaches a real-photo url embed to a highlight with a resolvable flash', () => {
    expect(resolvePhotoEmbed(
      { text: 'feature this one', contentType: 'highlight', sourceFlashId: 100 },
      valid,
    )).toEqual({ type: 'url', url: photoUrl });
  });

  it('attaches the photo to an addition when a flash link resolves (plumbing ready)', () => {
    expect(resolvePhotoEmbed(
      { text: 'new install', contentType: 'addition', sourceFlashId: 100 },
      valid,
    )).toEqual({ type: 'url', url: photoUrl });
  });

  it('no-ops for content types other than addition/highlight', () => {
    expect(resolvePhotoEmbed(
      { text: 'RIP', contentType: 'destruction', sourceFlashId: 100 },
      valid,
    )).toBeNull();
  });

  it('no-ops when the plan names no flash (addition sourced from an event)', () => {
    expect(resolvePhotoEmbed(
      { text: 'new install', contentType: 'addition', sourceFlashId: null },
      valid,
    )).toBeNull();
  });

  it('no-ops for an unknown flash id (never guesses a photo)', () => {
    expect(resolvePhotoEmbed(
      { text: 'feature', contentType: 'highlight', sourceFlashId: 999 },
      valid,
    )).toBeNull();
  });

  it('no-ops when the resolved flash has no pinned image', () => {
    expect(resolvePhotoEmbed(
      { text: 'feature', contentType: 'highlight', sourceFlashId: 200 },
      valid,
    )).toBeNull();
  });
});

describe('encodeEmbeds', () => {
  it('encodes a url (flash photo) embed to a bare { url }', () => {
    const url = `https://fuchsia-rich-lungfish-648.mypinata.cloud/ipfs/${CID}`;
    expect(encodeEmbeds([{ type: 'url', url }])).toEqual([{ url }]);
  });

  it('encodes a castId embed with the hash decoded from hex', () => {
    const [encoded] = encodeEmbeds([{ type: 'castId', fid: 42, hash: '0xdeadbeef' }]);
    expect(encoded).toEqual({ castId: { fid: 42, hash: Buffer.from('deadbeef', 'hex') } });
  });

  it('treats a bare string as a url embed (backward compat)', () => {
    expect(encodeEmbeds(['https://x.example/a.jpg'])).toEqual([{ url: 'https://x.example/a.jpg' }]);
  });

  it('preserves order — photo first, quoted cast second', () => {
    const url = `https://fuchsia-rich-lungfish-648.mypinata.cloud/ipfs/${CID}`;
    const encoded = encodeEmbeds([
      { type: 'url', url },
      { type: 'castId', fid: 1, hash: '0xab' },
    ]);
    expect(encoded).toEqual([
      { url },
      { castId: { fid: 1, hash: Buffer.from('ab', 'hex') } },
    ]);
  });
});
