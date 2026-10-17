// Sorenson Video 1 ('SVQ1') decoder — the 640×480 ("best") versions of the PC cutscenes and the hidden
// credits movie TC exist only in this codec. A TypeScript port of FFmpeg's libavcodec/svq1dec.c
// (Copyright (c) 2002 The Xine project, (c) 2002 The FFmpeg project; tables in svq1tables.ts).
//
// This file and svq1tables.ts are licensed under the GNU Lesser General Public License, version 2.1
// or (at your option) any later version, like the FFmpeg code they come from.
//
// Pictures are YUV 4:1:0: a luma plane and two chroma planes of a quarter width and height, each
// coded in 16×16 macroblocks: intra blocks as a tree of vectors (mean + up to 6 codebook stages),
// inter blocks as half-pel motion compensation (one or four vectors) plus a residual vector tree.
import { BLOCK_TYPE_VLC, FRAME_SIZES, INTER_CB, INTER_MEAN_VLC, INTER_MULTISTAGE_VLC, INTRA_CB, INTRA_MEAN_VLC, INTRA_MULTISTAGE_VLC, MV_VLC, STRING_TABLE } from './svq1tables';
import type { VideoDecoder } from './cinepak';

// ---------------------------------------------------------------- bits and VLCs
class Bits {
  pos = 0;
  constructor(private d: Uint8Array) {}
  get left() { return this.d.length * 8 - this.pos; }
  bit(): number { const p = this.pos++; return p >> 3 < this.d.length ? (this.d[p >> 3] >> (7 - (p & 7))) & 1 : 0; }
  bits(n: number): number { let v = 0; for (let i = 0; i < n; i++) v = v * 2 + this.bit(); return v; }
}

/** binary decoding tree of a VLC table given as flat [code, length, …]; symbol = pair index */
class Vlc {
  private next: Int32Array; // per node: child 0, child 1 (≥ 0 node, < 0 leaf -(sym+1), 0 none)
  constructor(t: number[], off = 0, count = t.length / 2) {
    this.next = new Int32Array(2 * (count * 24 + 2));
    let nodes = 1;
    for (let s = 0; s < count; s++) {
      const code = t[(off + s) * 2], len = t[(off + s) * 2 + 1];
      if (!len) continue;
      let n = 0;
      for (let b = len - 1; b >= 0; b--) {
        const bit = (code >> b) & 1, k = n * 2 + bit;
        if (b === 0) this.next[k] = -(s + 1);
        else { if (this.next[k] <= 0) this.next[k] = nodes++; n = this.next[k]; }
      }
    }
  }
  /** the symbol, or -1 for a code not in the table */
  read(b: Bits): number {
    let n = 0;
    for (let i = 0; i < 32; i++) {
      const v = this.next[n * 2 + b.bit()];
      if (v < 0) return -v - 1;
      if (v === 0) return -1;
      n = v;
    }
    return -1;
  }
}

const blockType = new Vlc(BLOCK_TYPE_VLC);
const motionVlc = new Vlc(MV_VLC);
const intraStages = Array.from({ length: 6 }, (_, i) => new Vlc(INTRA_MULTISTAGE_VLC, i * 8, 8));
const interStages = Array.from({ length: 6 }, (_, i) => new Vlc(INTER_MULTISTAGE_VLC, i * 8, 8));
const intraMean = new Vlc(INTRA_MEAN_VLC);
const interMean = new Vlc(INTER_MEAN_VLC);

/** codebooks as little-endian 32-bit words (4 pixels), per level 0-3 (4x2, 4x4, 8x4, 8x8) */
function codebooks(b64: string): (Uint32Array | null)[] {
  const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const out: (Uint32Array | null)[] = [];
  let o = 0;
  for (const n of [768, 1536, 3072, 6144]) {
    const w = new Uint32Array(n / 4);
    for (let i = 0; i < w.length; i++) w[i] = (raw[o + i * 4] | (raw[o + i * 4 + 1] << 8) | (raw[o + i * 4 + 2] << 16) | (raw[o + i * 4 + 3] << 24)) >>> 0;
    out.push(w);
    o += n;
  }
  return [...out, null, null];
}
const INTRA = codebooks(INTRA_CB), INTER = codebooks(INTER_CB);

class SvqError extends Error {}

// ---------------------------------------------------------------- planes
interface Plane { w: number; h: number; data: Uint8Array }
const align16 = (v: number) => (v + 15) & ~15;
const mid = (a: number, b: number, c: number) => Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));
const sext6 = (v: number) => (v << 26) >> 26;
const clip = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** read / write 4 pixels as one little-endian word (the codebook arithmetic works on byte lanes) */
const get32 = (d: Uint8Array, p: number) => (d[p] | (d[p + 1] << 8) | (d[p + 2] << 16) | (d[p + 3] << 24)) >>> 0;
const put32 = (d: Uint8Array, p: number, v: number) => { d[p] = v & 255; d[p + 1] = (v >>> 8) & 255; d[p + 2] = (v >>> 16) & 255; d[p + 3] = v >>> 24; };

/** two 16-bit lanes of pixel sums → clipped to 0..255 (FFmpeg's SVQ1_ADD_CODEBOOK clip, lane borrows included) */
function clipLanes(n: number): number {
  if (!(n & 0xff00ff00)) return n;
  const m = ((((n >>> 15) & 0x00010001) | 0x01000100) - 0x00010001) >>> 0;
  n = (n + 0x7f007f00) >>> 0;
  n = (n | ((((~n >>> 15) & 0x00010001) | 0x01000100) - 0x00010001)) >>> 0;
  return (n & m & 0x00ff00ff) >>> 0;
}

/** breadth-first vector tree of one 16×16 block: calls `leaf(offset, level)` for every coded vector */
function vectorTree(b: Bits, base: number, pitch: number, leaf: (p: number, level: number) => void) {
  const list = [base];
  let m = 1, level = 5;
  for (let i = 0; i < list.length; i++) {
    for (; level > 0; i++) {
      if (i === m) { m = list.length; if (--level === 0) break; }
      if (!b.bit()) break;
      list.push(list[i], list[i] + (((level & 1) ? pitch : 1) << ((level >> 1) + 1)));
    }
    if (i >= list.length) break;
    leaf(list[i], level);
  }
}

function addStages(b: Bits, cb: Uint32Array | null, stages: number, level: number, mean: number, d: Uint8Array, p: number, pitch: number, w: number, h: number, inter: boolean) {
  const entries: number[] = [];
  if (stages > 0) {
    const cache = b.bits(4 * stages);
    for (let j = 0; j < stages; j++) entries.push((((cache >>> (4 * (stages - j - 1))) & 0xf) + 16 * j) << (level + 1));
  }
  const mm = (mean - stages * 128) >>> 0;
  const n4 = ((mm << 16) + mm) >>> 0;
  let g = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w / 4; x++, g++) {
      let n1 = n4, n2 = n4;
      if (inter) { const n3 = get32(d, p + y * pitch + x * 4); n1 = (n4 + ((n3 & 0xff00ff00) >>> 8)) >>> 0; n2 = (n4 + (n3 & 0x00ff00ff)) >>> 0; }
      for (let j = 0; j < stages; j++) {
        const n3 = (cb![entries[j] + g] ^ 0x80808080) >>> 0;
        n1 = (n1 + ((n3 & 0xff00ff00) >>> 8)) >>> 0;
        n2 = (n2 + (n3 & 0x00ff00ff)) >>> 0;
      }
      put32(d, p + y * pitch + x * 4, ((clipLanes(n1) << 8) | clipLanes(n2)) >>> 0);
    }
  }
}

function intraBlock(b: Bits, d: Uint8Array, p0: number, pitch: number) {
  vectorTree(b, p0, pitch, (p, level) => {
    const w = 1 << ((4 + level) >> 1), h = 1 << ((3 + level) >> 1);
    const stages = intraStages[level].read(b) - 1;
    if (stages === -1) { for (let y = 0; y < h; y++) d.fill(0, p + y * pitch, p + y * pitch + w); return; }
    if (stages < -1 || (stages > 0 && level >= 4)) throw new SvqError('invalid intra vector');
    const mean = intraMean.read(b);
    if (stages === 0) { for (let y = 0; y < h; y++) d.fill(mean, p + y * pitch, p + y * pitch + w); return; }
    addStages(b, INTRA[level], stages, level, mean, d, p, pitch, w, h, false);
  });
}

/** FFmpeg before 2019 had the inter-mean codes of -128 and +128 swapped (tests against ffmpeg 4.x) */
export const oldTable = { on: false };

function interResidual(b: Bits, d: Uint8Array, p0: number, pitch: number, buggy: boolean) {
  vectorTree(b, p0, pitch, (p, level) => {
    const w = 1 << ((4 + level) >> 1), h = 1 << ((3 + level) >> 1);
    const stages = interStages[level].read(b) - 1;
    if (stages === -1) return;
    if (stages < -1 || (stages > 0 && level >= 4)) throw new SvqError('invalid inter vector');
    let mean = interMean.read(b) - 256;
    if (buggy !== oldTable.on) { if (mean === -128) mean = 128; else if (mean === 128) mean = -128; }
    addStages(b, INTER[level], stages, level, mean, d, p, pitch, w, h, true);
  });
}

/** half-pel block copy (FFmpeg hpeldsp put_pixels: rounded averages) */
function putPixels(dst: Uint8Array, dp: number, src: Uint8Array, sp: number, pitch: number, size: number, hx: number, hy: number) {
  for (let y = 0; y < size; y++) {
    const s = sp + y * pitch, t = dp + y * pitch;
    for (let x = 0; x < size; x++) {
      const a = src[s + x];
      dst[t + x] = !hx && !hy ? a
        : hx && !hy ? (a + src[s + x + 1] + 1) >> 1
        : !hx ? (a + src[s + x + pitch] + 1) >> 1
        : (a + src[s + x + 1] + src[s + x + pitch] + src[s + x + pitch + 1] + 2) >> 2;
    }
  }
}

interface Mv { x: number; y: number }

function motionVector(b: Bits, out: Mv, pmv: Mv[]) {
  for (let i = 0; i < 2; i++) {
    let diff = motionVlc.read(b);
    if (diff < 0) throw new SvqError('bad motion vector');
    if (diff && b.bit()) diff = -diff;
    if (i === 1) out.y = sext6(diff + mid(pmv[0].y, pmv[1].y, pmv[2].y));
    else out.x = sext6(diff + mid(pmv[0].x, pmv[1].x, pmv[2].x));
  }
}

// ---------------------------------------------------------------- decoder
export class Svq1Decoder implements VideoDecoder {
  readonly rgba: Uint8ClampedArray;
  private cur: Plane[] = [];
  private prev: Plane[] = [];
  private lastTempref = 0xff;
  private width: number;
  private height: number;
  /** the stream's sample description has extra data (else the "buggy" mean swap of old encoders applies) */
  constructor(readonly w: number, readonly h: number, private hasExtradata = false) {
    this.width = (w + 3) & ~3; this.height = (h + 3) & ~3;
    this.rgba = new Uint8ClampedArray(w * h * 4);
    for (let i = 3; i < this.rgba.length; i += 4) this.rgba[i] = 255;
  }

  private planes(): Plane[] {
    const W = align16(this.width), H = align16(this.height), cw = align16(this.width >> 2), ch = align16(this.height >> 2);
    return [{ w: W, h: H, data: new Uint8Array(W * H) }, { w: cw, h: ch, data: new Uint8Array(cw * ch) }, { w: cw, h: ch, data: new Uint8Array(cw * ch) }];
  }

  /** decode one frame into the YUV planes (and, unless `noRgb`, the RGBA picture) */
  decode(pkt: Uint8Array, noRgb = false): void {
    let buf = pkt;
    let b = new Bits(buf);
    const code = b.bits(22);
    if ((code & ~0x70) || !(code & 0x60)) throw new SvqError('not an SVQ1 frame');
    if (code !== 0x20) { // header words scrambled
      if (buf.length < 36) throw new SvqError('frame too small');
      buf = pkt.slice();
      const dv = new DataView(buf.buffer);
      for (let i = 0; i < 4; i++) {
        const v = dv.getUint32(4 + 4 * i, true), x = dv.getUint32(4 + 4 * (7 - i), true);
        dv.setUint32(4 + 4 * i, (((v << 16) | (v >>> 16)) ^ x) >>> 0, true);
      }
      b = new Bits(buf);
      b.pos = 22;
    }
    const tempref = b.bits(8);
    const buggy = tempref === 0 && this.lastTempref === 0 && !this.hasExtradata;
    this.lastTempref = tempref;
    const type = b.bits(2);
    if (type === 3) throw new SvqError('bad frame type');
    const intra = type === 0, nonref = type === 2;
    let width = this.width, height = this.height;
    if (intra) {
      if (code === 0x50 || code === 0x60) b.bits(16); // checksum
      if ((code ^ 0x10) >= 0x50) { // embedded text message
        const len = b.bits(8);
        let seed = STRING_TABLE[len];
        for (let i = 0; i < len; i++) { const c = b.bits(8) ^ seed; seed = STRING_TABLE[c ^ seed]; }
      }
      b.bits(5);
      const sz = b.bits(3);
      if (sz === 7) { width = b.bits(12); height = b.bits(12); if (!width || !height) throw new SvqError('bad size'); }
      else [width, height] = FRAME_SIZES[sz];
    }
    if (b.bit()) { b.bits(2); if (b.bits(2) !== 0) throw new SvqError('bad header'); }
    if (b.bit()) { b.bits(8); while (b.bit()) b.bits(8); }
    if (b.left <= 0) throw new SvqError('frame ends early');
    if (width !== this.width || height !== this.height || !this.prev.length) {
      if (!intra && (width !== this.width || height !== this.height || !this.prev.length)) throw new SvqError('missing reference frame');
      this.width = width; this.height = height;
      this.prev = this.planes();
    }
    const cur = this.cur.length && this.cur[0].w === this.prev[0].w ? this.cur : this.planes();
    for (let k = 0; k < 3; k++) {
      const P = cur[k], pitch = P.w, d = P.data;
      const W = k ? align16(this.width >> 2) : align16(this.width), H = k ? align16(this.height >> 2) : align16(this.height);
      if (intra) {
        for (let y = 0; y < H; y += 16) for (let x = 0; x < W; x += 16) intraBlock(b, d, y * pitch + x, pitch);
        continue;
      }
      const prev = this.prev[k].data;
      const pmv: Mv[] = Array.from({ length: (W >> 3) + 3 }, () => ({ x: 0, y: 0 }));
      for (let y = 0; y < H; y += 16) {
        for (let x = 0; x < W; x += 16) {
          const at = y * pitch + x, bt = blockType.read(b);
          if (bt === 0 || bt === 3) { pmv[0].x = pmv[0].y = pmv[(x >> 3) + 2].x = pmv[(x >> 3) + 2].y = pmv[(x >> 3) + 3].x = pmv[(x >> 3) + 3].y = 0; }
          if (bt === 0) { for (let r = 0; r < 16; r++) d.set(prev.subarray(at + r * pitch, at + r * pitch + 16), at + r * pitch); }
          else if (bt === 1) {
            const mv: Mv = { x: 0, y: 0 };
            const pv = y === 0 ? [pmv[0], pmv[0], pmv[0]] : [pmv[0], pmv[(x >> 3) + 2], pmv[(x >> 3) + 4]];
            motionVector(b, mv, pv);
            for (const q of [pmv[0], pmv[(x >> 3) + 2], pmv[(x >> 3) + 3]]) { q.x = mv.x; q.y = mv.y; }
            const mx = clip(mv.x, -2 * x, 2 * (W - x - 16)), my = clip(mv.y, -2 * y, 2 * (H - y - 16));
            putPixels(d, at, prev, (x + (mx >> 1)) + (y + (my >> 1)) * pitch, pitch, 16, mx & 1, my & 1);
            interResidual(b, d, at, pitch, buggy);
          } else if (bt === 2) {
            const mv: Mv = { x: 0, y: 0 };
            const pv: Mv[] = y === 0 ? [pmv[0], pmv[0], pmv[0]] : [pmv[0], pmv[(x >> 3) + 2], pmv[(x >> 3) + 4]];
            motionVector(b, mv, pv);
            pv[0] = mv;
            if (y === 0) { pv[1] = pv[2] = mv; } else pv[1] = pmv[(x >> 3) + 3];
            motionVector(b, pmv[0], pv);
            pv[1] = pmv[0]; pv[2] = pmv[(x >> 3) + 1];
            motionVector(b, pmv[(x >> 3) + 2], pv);
            pv[2] = pmv[(x >> 3) + 2]; pv[3] = pmv[(x >> 3) + 3];
            motionVector(b, pv[3], pv);
            let dst = at;
            for (let i = 0; i < 4; i++) {
              const mvx = clip(pv[i].x + (i & 1) * 16, -2 * x, 2 * (W - x - 8)), mvy = clip(pv[i].y + (i >> 1) * 16, -2 * y, 2 * (H - y - 8));
              putPixels(d, dst, prev, (x + (mvx >> 1)) + (y + (mvy >> 1)) * pitch, pitch, 8, mvx & 1, mvy & 1);
              dst += i & 1 ? 8 * (pitch - 1) : 8;
            }
            interResidual(b, d, at, pitch, buggy);
          } else if (bt === 3) intraBlock(b, d, at, pitch);
          else throw new SvqError('bad block type');
        }
        pmv[0].x = pmv[0].y = 0;
      }
    }
    this.cur = cur;
    this.lastShown = cur;
    if (!nonref) { const t = this.prev; this.prev = cur; this.cur = t; }
    if (!noRgb) this.toRgba(cur);
  }

  /** the last decoded picture's planes (tests) */
  get yuv(): Plane[] { return this.lastShown; }
  private lastShown: Plane[] = [];

  /** YUV 4:1:0 → RGBA (BT.601 studio range, chroma bilinear) */
  private cols: { x0: Int32Array; x1: Int32Array; wx: Float32Array } | null = null;
  private toRgba(p: Plane[]) {
    const [Y, U, V] = p, W = this.w, H = this.h, out = this.rgba, cw = U.w;
    const cmaxX = (this.width >> 2) - 1, cmaxY = (this.height >> 2) - 1;
    if (!this.cols || this.cols.x0.length !== W) {
      const x0 = new Int32Array(W), x1 = new Int32Array(W), wx = new Float32Array(W);
      for (let x = 0; x < W; x++) { const f = Math.max(0, (x - 1.5) / 4); x0[x] = Math.min(cmaxX, Math.floor(f)); x1[x] = Math.min(cmaxX, x0[x] + 1); wx[x] = Math.min(1, f - x0[x]); }
      this.cols = { x0, x1, wx };
    }
    const { x0, x1, wx } = this.cols, ud = U.data, vd = V.data, yd = Y.data;
    for (let y = 0; y < H; y++) {
      const fy = Math.max(0, (y - 1.5) / 4), y0 = Math.min(cmaxY, Math.floor(fy)), y1 = Math.min(cmaxY, y0 + 1), wy = Math.min(1, fy - y0);
      const r0 = y0 * cw, r1 = y1 * cw;
      let q = y * W * 4;
      for (let x = 0; x < W; x++, q += 4) {
        const a = x0[x], b = x1[x], w = wx[x];
        const u = (ud[r0 + a] + (ud[r0 + b] - ud[r0 + a]) * w) * (1 - wy) + (ud[r1 + a] + (ud[r1 + b] - ud[r1 + a]) * w) * wy - 128;
        const v = (vd[r0 + a] + (vd[r0 + b] - vd[r0 + a]) * w) * (1 - wy) + (vd[r1 + a] + (vd[r1 + b] - vd[r1 + a]) * w) * wy - 128;
        const c = 1.164 * (yd[y * Y.w + x] - 16);
        out[q] = c + 1.596 * v; out[q + 1] = c - 0.392 * u - 0.813 * v; out[q + 2] = c + 2.017 * u;
      }
    }
  }
}
