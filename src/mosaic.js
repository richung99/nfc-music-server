// ── Voronoi mosaic cover art ───────────────────────────────────────────────────
// Builds a canvas element showing album cover fragments arranged in a
// Voronoi mosaic. Each region shows a clipped portion of one album cover.
// Same playlist ID always produces the same geometry.

function _mosaicHash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

function _mosaicRand(seed) {
  let s = typeof seed === 'string' ? _mosaicHash(seed) : (seed | 0);
  return () => {
    s = Math.imul(s ^ (s >>> 16), 0x45d9f3b);
    s = Math.imul(s ^ (s >>> 16), 0x45d9f3b);
    return ((s ^ (s >>> 16)) >>> 0) / 0xffffffff;
  };
}

function _clipPolygon(poly, nx, ny, d) {
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const da = nx * a[0] + ny * a[1] - d;
    const db = nx * b[0] + ny * b[1] - d;
    if (da <= 0) out.push(a);
    if ((da < 0 && db > 0) || (da > 0 && db < 0)) {
      const t = da / (da - db);
      out.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]);
    }
  }
  return out;
}

function _buildVoronoiPolygons(n, seedStr, size) {
  const r = _mosaicRand(seedStr);
  const candidates = n * 2;
  const pts = [];
  for (let i = 0; i < candidates; i++) pts.push([r() * size, r() * size]);

  const square = [[0,0],[size,0],[size,size],[0,size]];
  const allPolys = pts.map((p, i) => {
    let poly = [...square];
    for (let j = 0; j < candidates; j++) {
      if (i === j || !poly.length) continue;
      const q = pts[j];
      const mx = (p[0]+q[0])/2, my = (p[1]+q[1])/2;
      const nx = p[0]-q[0], ny = p[1]-q[1];
      poly = _clipPolygon(poly, nx, ny, nx*mx+ny*my);
    }
    return poly;
  });

  return allPolys
    .map(poly => {
      if (!poly.length) return null;
      let a = 0;
      for (let i = 0; i < poly.length; i++) {
        const [x1,y1]=poly[i],[x2,y2]=poly[(i+1)%poly.length];
        a += x1*y2-x2*y1;
      }
      return { poly, area: Math.abs(a)/2 };
    })
    .filter(Boolean)
    .sort((a, b) => b.area - a.area)
    .slice(0, n)
    .map(x => x.poly);
}

// Draw one polygon region using a loaded image
function _drawRegion(ctx, poly, img, size) {
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(poly[0][0], poly[0][1]);
  for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i][0], poly[i][1]);
  ctx.closePath();
  ctx.clip();
  // Draw image scaled to fill the entire square (cover crop)
  ctx.drawImage(img, 0, 0, size, size);
  ctx.restore();
}

// Main function — returns a Promise<canvas>
// covers: array of image URLs
// size: pixel size of the square canvas
// seed: string (use playlist id)
function buildMosaic(covers, size, seed) {
  if (!covers || !covers.length) {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    return Promise.resolve(c);
  }

  const polys = _buildVoronoiPolygons(covers.length, seed, size);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');

  // Load all images in parallel
  const loadImg = url => new Promise(resolve => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });

  return Promise.all(covers.map(loadImg)).then(imgs => {
    // Draw each region
    polys.forEach((poly, i) => {
      const img = imgs[i % imgs.length];
      if (img) {
        _drawRegion(ctx, poly, img, size);
      } else {
        // Fallback: fill with dark color so no transparent holes
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(poly[0][0], poly[0][1]);
        for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i][0], poly[i][1]);
        ctx.closePath();
        ctx.fillStyle = '#1a1a1a';
        ctx.fill();
        ctx.restore();
      }
    });

    // Draw seams on top
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    polys.forEach(poly => {
      ctx.beginPath();
      ctx.moveTo(poly[0][0], poly[0][1]);
      for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i][0], poly[i][1]);
      ctx.closePath();
      ctx.stroke();
    });

    return canvas;
  });
}
