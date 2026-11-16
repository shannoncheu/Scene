import sharp from 'sharp';
import { db } from './db';

const LIMIT_OPTS = { limitInputPixels: 25_000_000 } as const;

let tableReady: Promise<void> | null = null;
export function ensureTicketTable() {
  if (!tableReady) {
    tableReady = (async () => {
      await db.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS "TicketStub" (
          "id" TEXT NOT NULL PRIMARY KEY,
          "ownerId" TEXT NOT NULL,
          "mediaId" TEXT NOT NULL,
          "filePath" TEXT NOT NULL,
          "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          "updatedAt" DATETIME NOT NULL,
          CONSTRAINT "TicketStub_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "Owner" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
          CONSTRAINT "TicketStub_mediaId_fkey" FOREIGN KEY ("mediaId") REFERENCES "Media" ("id") ON DELETE CASCADE ON UPDATE CASCADE
        )
      `);
      await db.$executeRawUnsafe(`CREATE UNIQUE INDEX IF NOT EXISTS "TicketStub_ownerId_mediaId_key" ON "TicketStub"("ownerId", "mediaId")`);
      await db.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "TicketStub_ownerId_idx" ON "TicketStub"("ownerId")`);
    })().catch(error => {
      tableReady = null;
      throw error;
    });
  }
  return tableReady;
}

function maxOf(values: Int32Array): number {
  let m = 0;
  for (let i = 0; i < values.length; i++) if (values[i] > m) m = values[i];
  return m;
}

function otsuThreshold(values: Float32Array): number {
  const bins = 256;
  const hist = new Int32Array(bins);
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < values.length; i++) {
    if (values[i] < min) min = values[i];
    if (values[i] > max) max = values[i];
  }
  const range = max - min;
  if (range < 12) return max + 1;

  for (let i = 0; i < values.length; i++) {
    const b = Math.min(bins - 1, Math.max(0, Math.floor(((values[i] - min) / range) * (bins - 1))));
    hist[b]++;
  }

  let total = values.length;
  let sum = 0;
  for (let i = 0; i < bins; i++) sum += i * hist[i];

  let sumB = 0;
  let wB = 0;
  let maxVar = -1;
  let bestBin = 128;

  for (let t = 0; t < bins; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > maxVar) {
      maxVar = between;
      bestBin = t;
    }
  }
  return min + (bestBin / (bins - 1)) * range;
}

function dilateMask(src: Uint8Array, w: number, h: number, rx: number, ry: number): Uint8Array {
  const horiz = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let on = 0;
      const xStart = Math.max(0, x - rx);
      const xEnd = Math.min(w - 1, x + rx);
      for (let xx = xStart; xx <= xEnd; xx++) {
        if (src[row + xx]) { on = 1; break; }
      }
      horiz[row + x] = on;
    }
  }
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const yStart = Math.max(0, y - ry);
    const yEnd = Math.min(h - 1, y + ry);
    for (let x = 0; x < w; x++) {
      let on = 0;
      for (let yy = yStart; yy <= yEnd; yy++) {
        if (horiz[yy * w + x]) { on = 1; break; }
      }
      out[y * w + x] = on;
    }
  }
  return out;
}

function erodeMask(src: Uint8Array, w: number, h: number, rx: number, ry: number): Uint8Array {
  const horiz = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let on = 1;
      const xStart = Math.max(0, x - rx);
      const xEnd = Math.min(w - 1, x + rx);
      for (let xx = xStart; xx <= xEnd; xx++) {
        if (!src[row + xx]) { on = 0; break; }
      }
      horiz[row + x] = on;
    }
  }
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const yStart = Math.max(0, y - ry);
    const yEnd = Math.min(h - 1, y + ry);
    for (let x = 0; x < w; x++) {
      let on = 1;
      for (let yy = yStart; yy <= yEnd; yy++) {
        if (!horiz[yy * w + x]) { on = 0; break; }
      }
      out[y * w + x] = on;
    }
  }
  return out;
}

function largestComponentMask(mask: Uint8Array, w: number, h: number): { mask: Uint8Array; count: number } {
  const visited = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);
  let bestPixels: number[] = [];

  for (let start = 0; start < w * h; start++) {
    if (!mask[start] || visited[start]) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    visited[start] = 1;
    const comp: number[] = [];

    while (head < tail) {
      const idx = queue[head++];
      comp.push(idx);
      const x = idx % w;
      const y = (idx - x) / w;
      if (x > 0 && mask[idx - 1] && !visited[idx - 1]) { visited[idx - 1] = 1; queue[tail++] = idx - 1; }
      if (x + 1 < w && mask[idx + 1] && !visited[idx + 1]) { visited[idx + 1] = 1; queue[tail++] = idx + 1; }
      if (y > 0 && mask[idx - w] && !visited[idx - w]) { visited[idx - w] = 1; queue[tail++] = idx - w; }
      if (y + 1 < h && mask[idx + w] && !visited[idx + w]) { visited[idx + w] = 1; queue[tail++] = idx + w; }
    }

    if (comp.length > bestPixels.length) {
      bestPixels = comp;
    }
  }

  const out = new Uint8Array(w * h);
  for (let i = 0; i < bestPixels.length; i++) out[bestPixels[i]] = 1;
  return { mask: out, count: bestPixels.length };
}

async function segmentTicket(uprightBuffer: Buffer, origWidth: number, origHeight: number) {
  const { data, info } = await sharp(uprightBuffer, LIMIT_OPTS)
    .resize({ width: 320, height: 320, fit: 'inside', withoutEnlargement: true })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const w = info.width;
  const h = info.height;
  const n = w * h;
  const scores = new Float32Array(n);

  // Paper-ness score: bright & low-saturation pixels stand out cleanly even under uneven desk lighting.
  for (let i = 0; i < n; i++) {
    const p = i * 3;
    const r = data[p];
    const g = data[p + 1];
    const b = data[p + 2];
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    const chroma = Math.max(r, g, b) - Math.min(r, g, b);
    scores[i] = lum - 0.7 * chroma;
  }

  const thresh = otsuThreshold(scores);
  const rawMask = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (scores[i] >= thresh) rawMask[i] = 1;
  }

  // 3x3 morphological open/smooth to drop stray specular highlights
  const clean = new Uint8Array(n);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const idx = y * w + x;
      if (!rawMask[idx]) continue;
      let neighbors = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          neighbors += rawMask[(y + dy) * w + (x + dx)];
        }
      }
      if (neighbors >= 5) clean[idx] = 1;
    }
  }

  // Morphological closing bridges horizontal/vertical printed stripes, logos, and QR codes
  // so header and body stay connected as one paper component.
  const closed = erodeMask(dilateMask(clean, w, h, 4, 10), w, h, 4, 10);

  const { mask, count } = largestComponentMask(closed, w, h);
  const areaRatio = count / n;
  if (count < 120 || areaRatio < 0.04 || areaRatio > 0.94) return null;

  // Estimate tilt angle using central moments of the largest paper component
  let sumX = 0;
  let sumY = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (mask[y * w + x]) {
        sumX += x;
        sumY += y;
      }
    }
  }
  const cx = sumX / count;
  const cy = sumY / count;
  let mu20 = 0;
  let mu02 = 0;
  let mu11 = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (mask[y * w + x]) {
        const dx = x - cx;
        const dy = y - cy;
        mu20 += dx * dx;
        mu02 += dy * dy;
        mu11 += dx * dy;
      }
    }
  }
  const thetaRad = 0.5 * Math.atan2(2 * mu11, mu20 - mu02);
  let angleDeg = (thetaRad * 180) / Math.PI;
  // Snap tilt to nearest 90-degree axis so small/moderate tilts straighten without flipping orientation
  while (angleDeg > 45) angleDeg -= 90;
  while (angleDeg < -45) angleDeg += 90;

  // Tight bounding box using 20% of peak row/col density so slanted corners don't leave excess desk
  const rowCounts = new Int32Array(h);
  const colCounts = new Int32Array(w);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (mask[y * w + x]) {
        rowCounts[y]++;
        colCounts[x]++;
      }
    }
  }
  const maxRow = maxOf(rowCounts);
  const maxCol = maxOf(colCounts);
  const rowThresh = Math.max(3, Math.floor(maxRow * 0.12));
  const colThresh = Math.max(3, Math.floor(maxCol * 0.12));

  let y0 = 0;
  while (y0 < h && rowCounts[y0] < rowThresh) y0++;
  let y1 = h - 1;
  while (y1 > y0 && rowCounts[y1] < rowThresh) y1--;
  let x0 = 0;
  while (x0 < w && colCounts[x0] < colThresh) x0++;
  let x1 = w - 1;
  while (x1 > x0 && colCounts[x1] < colThresh) x1--;

  // Slight outer margin preserves thin colored top/bottom border strips on thermal tickets
  const padY = Math.max(2, Math.round((y1 - y0 + 1) * 0.025));
  const padX = Math.max(1, Math.round((x1 - x0 + 1) * 0.012));
  y0 = Math.max(0, y0 - padY);
  y1 = Math.min(h - 1, y1 + padY);
  x0 = Math.max(0, x0 - padX);
  x1 = Math.min(w - 1, x1 + padX);

  const scaleX = origWidth / w;
  const scaleY = origHeight / h;
  const left = Math.max(0, Math.floor(x0 * scaleX));
  const top = Math.max(0, Math.floor(y0 * scaleY));
  const width = Math.min(origWidth - left, Math.ceil((x1 - x0 + 1) * scaleX));
  const height = Math.min(origHeight - top, Math.ceil((y1 - y0 + 1) * scaleY));

  if (width < 60 || height < 60) return null;
  return { box: { left, top, width, height }, deskewDeg: -angleDeg };
}

export function ticketMasterName(filePath: string) {
  return filePath.replace(/\.webp$/, '.orig.webp');
}

export async function ticketImage(input: Buffer, mime: string) {
  if (input.length > 10 * 1024 * 1024) throw new Error('FILE_TOO_LARGE');
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(mime)) throw new Error('FILE_INVALID');

  try {
    const metadata = await sharp(input, LIMIT_OPTS).metadata();
    if (!metadata.format || !['png', 'jpeg', 'webp'].includes(metadata.format) || (metadata.pages ?? 1) > 1) {
      throw new Error('FILE_INVALID');
    }
    if (mime !== ({ png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' } as Record<string, string>)[metadata.format]) {
      throw new Error('FILE_INVALID');
    }
    const rawW = metadata.width ?? 0;
    const rawH = metadata.height ?? 0;
    if (rawW < 10 || rawH < 10 || Math.max(rawW, rawH) / Math.min(rawW, rawH) > 10) {
      throw new Error('FILE_INVALID');
    }

    // Orient and normalize resolution once, keeping all intermediates lossless so the only lossy encode is the final WebP.
    let working = await sharp(input, LIMIT_OPTS)
      .rotate()
      .resize({ width: 2400, height: 2400, fit: 'inside', withoutEnlargement: true })
      .png({ compressionLevel: 1 })
      .toBuffer();
    let info = await sharp(working, LIMIT_OPTS).metadata();
    let autoCropped = false;

    const firstPass = await segmentTicket(working, info.width!, info.height!);
    if (firstPass) {
      autoCropped = true;
      // Straighten tilt if noticeable (> 0.8 deg), then re-crop tightly so zero desk corners remain
      if (Math.abs(firstPass.deskewDeg) > 0.8) {
        working = await sharp(working, LIMIT_OPTS)
          .rotate(firstPass.deskewDeg, { background: { r: 20, g: 20, b: 22, alpha: 1 } })
          .png({ compressionLevel: 1 })
          .toBuffer();
        info = await sharp(working, LIMIT_OPTS).metadata();
        const secondPass = await segmentTicket(working, info.width!, info.height!);
        if (secondPass) {
          working = await sharp(working, LIMIT_OPTS).extract(secondPass.box).png({ compressionLevel: 1 }).toBuffer();
        }
      } else {
        working = await sharp(working, LIMIT_OPTS).extract(firstPass.box).png({ compressionLevel: 1 }).toBuffer();
      }
    }

    const resized = sharp(working, LIMIT_OPTS).resize({ width: 1080, height: 1080, fit: 'inside', withoutEnlargement: true });
    const [masterBuffer, buffer] = await Promise.all([
      resized.clone().webp({ lossless: true, effort: 4 }).toBuffer(),
      resized.clone().webp({ quality: 88, effort: 4 }).toBuffer(),
    ]);

    return { buffer, masterBuffer, autoCropped };
  } catch (error) {
    if (error instanceof Error && (error.message === 'FILE_TOO_LARGE' || error.message === 'FILE_INVALID')) {
      throw error;
    }
    throw new Error('FILE_INVALID');
  }
}

export async function rotateTicketBuffer(masterOrExistingWebp: Buffer, degrees: 90 | -90 | 180) {
  const rotated = sharp(masterOrExistingWebp, LIMIT_OPTS).rotate(degrees);
  const [masterBuffer, buffer] = await Promise.all([
    rotated.clone().webp({ lossless: true, effort: 4 }).toBuffer(),
    rotated.clone().webp({ quality: 88, effort: 4 }).toBuffer(),
  ]);
  return { buffer, masterBuffer };
}
