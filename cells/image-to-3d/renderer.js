(function (global) {
  'use strict';

  const NS = (global.GeminiImageTo3D = global.GeminiImageTo3D || {});

  function parseHexColor(hex) {
    const clean = String(hex || '#9aa0a6').trim().replace(/^#/, '');
    let r = 154, g = 160, b = 166;
    if (/^[0-9a-f]{6}$/i.test(clean)) {
      r = parseInt(clean.slice(0, 2), 16);
      g = parseInt(clean.slice(2, 4), 16);
      b = parseInt(clean.slice(4, 6), 16);
    } else if (/^[0-9a-f]{3}$/i.test(clean)) {
      r = parseInt(clean[0] + clean[0], 16);
      g = parseInt(clean[1] + clean[1], 16);
      b = parseInt(clean[2] + clean[2], 16);
    }
    return [r, g, b];
  }

  function buildBox(verts, tris) {
    const p = [
      [-0.5, -0.5, -0.5], [0.5, -0.5, -0.5], [0.5, 0.5, -0.5], [-0.5, 0.5, -0.5],
      [-0.5, -0.5, 0.5], [0.5, -0.5, 0.5], [0.5, 0.5, 0.5], [-0.5, 0.5, 0.5]
    ];
    const base = verts.length;
    for (let i = 0; i < p.length; i++) verts.push(p[i]);
    const f = [
      [0, 2, 1], [0, 3, 2],
      [4, 5, 6], [4, 6, 7],
      [0, 1, 5], [0, 5, 4],
      [2, 3, 7], [2, 7, 6],
      [0, 4, 7], [0, 7, 3],
      [1, 2, 6], [1, 6, 5]
    ];
    for (let i = 0; i < f.length; i++) tris.push([base + f[i][0], base + f[i][1], base + f[i][2]]);
  }

  function buildSphere(verts, tris, segU, segV) {
    const uCount = segU || 14;
    const vCount = segV || 10;
    const base = verts.length;
    for (let v = 0; v <= vCount; v++) {
      const phi = (v / vCount) * Math.PI;
      const sinP = Math.sin(phi);
      const cosP = Math.cos(phi);
      for (let u = 0; u <= uCount; u++) {
        const theta = (u / uCount) * Math.PI * 2;
        verts.push([0.5 * sinP * Math.cos(theta), 0.5 * cosP, 0.5 * sinP * Math.sin(theta)]);
      }
    }
    const stride = uCount + 1;
    for (let v = 0; v < vCount; v++) {
      for (let u = 0; u < uCount; u++) {
        const a = base + v * stride + u;
        const b = a + stride;
        const c = b + 1;
        const d = a + 1;
        if (v !== 0) tris.push([a, b, d]);
        if (v !== vCount - 1) tris.push([b, c, d]);
      }
    }
  }

  function buildCylinder(verts, tris, segs, topRadius) {
    const n = segs || 14;
    const rTop = topRadius === undefined ? 0.5 : topRadius;
    const rBot = 0.5;
    const base = verts.length;
    const topCenter = base;
    const botCenter = base + 1;
    verts.push([0, 0.5, 0], [0, -0.5, 0]);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const ca = Math.cos(a), sa = Math.sin(a);
      verts.push([rTop * ca, 0.5, rTop * sa]);
      verts.push([rBot * ca, -0.5, rBot * sa]);
    }
    for (let i = 0; i < n; i++) {
      const next = (i + 1) % n;
      const t0 = base + 2 + i * 2;
      const b0 = t0 + 1;
      const t1 = base + 2 + next * 2;
      const b1 = t1 + 1;
      if (rTop > 0.001) tris.push([topCenter, t1, t0]);
      tris.push([botCenter, b0, b1]);
      if (rTop > 0.001) {
        tris.push([t0, t1, b1]);
        tris.push([t0, b1, b0]);
      } else {
        tris.push([topCenter, b1, b0]);
      }
    }
  }

  function buildTorus(verts, tris, segMajor, segMinor) {
    const nMaj = segMajor || 16;
    const nMin = segMinor || 10;
    const R = 0.36;
    const r = 0.14;
    const base = verts.length;
    for (let i = 0; i < nMaj; i++) {
      const u = (i / nMaj) * Math.PI * 2;
      const cu = Math.cos(u), su = Math.sin(u);
      for (let j = 0; j < nMin; j++) {
        const v = (j / nMin) * Math.PI * 2;
        const cv = Math.cos(v), sv = Math.sin(v);
        verts.push([(R + r * cv) * cu, r * sv, (R + r * cv) * su]);
      }
    }
    for (let i = 0; i < nMaj; i++) {
      const ni = (i + 1) % nMaj;
      for (let j = 0; j < nMin; j++) {
        const nj = (j + 1) % nMin;
        const a = base + i * nMin + j;
        const b = base + ni * nMin + j;
        const c = base + ni * nMin + nj;
        const d = base + i * nMin + nj;
        tris.push([a, b, c], [a, c, d]);
      }
    }
  }

  function transformPoint(p, pos, rotDeg, scale) {
    let x = p[0] * scale[0];
    let y = p[1] * scale[1];
    let z = p[2] * scale[2];

    const rx = (rotDeg[0] * Math.PI) / 180;
    const ry = (rotDeg[1] * Math.PI) / 180;
    const rz = (rotDeg[2] * Math.PI) / 180;

    // X rotation
    let cy = Math.cos(rx), sy = Math.sin(rx);
    let y1 = y * cy - z * sy;
    let z1 = y * sy + z * cy;
    y = y1; z = z1;

    // Y rotation
    let cx = Math.cos(ry), sx = Math.sin(ry);
    let x1 = x * cx + z * sx;
    z1 = -x * sx + z * cx;
    x = x1; z = z1;

    // Z rotation
    let cz = Math.cos(rz), sz = Math.sin(rz);
    x1 = x * cz - y * sz;
    y1 = x * sz + y * cz;
    x = x1; y = y1;

    return [x + pos[0], y + pos[1], z + pos[2]];
  }

  function buildMeshFromScene(scene) {
    const parts = (scene && Array.isArray(scene.parts)) ? scene.parts : [];
    const allVerts = [];
    const allTris = [];

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (!part) continue;
      const localVerts = [];
      const localTris = [];
      const type = String(part.type || 'box').toLowerCase();

      if (type === 'sphere' || type === 'ellipsoid') {
        buildSphere(localVerts, localTris, 12, 8);
      } else if (type === 'cylinder' || type === 'capsule') {
        buildCylinder(localVerts, localTris, 14, 0.5);
      } else if (type === 'cone' || type === 'pyramid') {
        buildCylinder(localVerts, localTris, type === 'pyramid' ? 4 : 14, 0);
      } else if (type === 'torus' || type === 'ring') {
        buildTorus(localVerts, localTris, 14, 8);
      } else {
        buildBox(localVerts, localTris);
      }

      const pos = Array.isArray(part.pos) && part.pos.length === 3 ? part.pos.map(Number) : [0, 0, 0];
      const rot = Array.isArray(part.rot) && part.rot.length === 3 ? part.rot.map(Number) : [0, 0, 0];
      const scale = Array.isArray(part.scale) && part.scale.length === 3 ? part.scale.map(Number) : [1, 1, 1];
      const rgb = parseHexColor(part.color);

      const baseIdx = allVerts.length;
      for (let v = 0; v < localVerts.length; v++) {
        allVerts.push(transformPoint(localVerts[v], pos, rot, scale));
      }
      for (let t = 0; t < localTris.length; t++) {
        allTris.push({
          a: baseIdx + localTris[t][0],
          b: baseIdx + localTris[t][1],
          c: baseIdx + localTris[t][2],
          rgb: rgb
        });
      }
    }

    // Auto-center and normalize bounding sphere radius to ~1.25
    if (allVerts.length > 0) {
      let minX = Infinity, minY = Infinity, minZ = Infinity;
      let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
      for (let i = 0; i < allVerts.length; i++) {
        const v = allVerts[i];
        if (v[0] < minX) minX = v[0];
        if (v[1] < minY) minY = v[1];
        if (v[2] < minZ) minZ = v[2];
        if (v[0] > maxX) maxX = v[0];
        if (v[1] > maxY) maxY = v[1];
        if (v[2] > maxZ) maxZ = v[2];
      }
      const cx = (minX + maxX) / 2;
      const cy = (minY + maxY) / 2;
      const cz = (minZ + maxZ) / 2;
      const span = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 0.001);
      const norm = 2.1 / span;
      for (let i = 0; i < allVerts.length; i++) {
        allVerts[i][0] = (allVerts[i][0] - cx) * norm;
        allVerts[i][1] = (allVerts[i][1] - cy) * norm;
        allVerts[i][2] = (allVerts[i][2] - cz) * norm;
      }
    }

    return {
      vertices: allVerts,
      triangles: allTris,
      partCount: parts.length
    };
  }

  function exportMeshToOBJ(mesh, title) {
    const lines = ['# Generated by Gemini Image-to-3D: ' + String(title || 'model')];
    const verts = (mesh && mesh.vertices) || [];
    const tris = (mesh && mesh.triangles) || [];
    for (let i = 0; i < verts.length; i++) {
      const v = verts[i];
      lines.push('v ' + v[0].toFixed(4) + ' ' + v[1].toFixed(4) + ' ' + v[2].toFixed(4));
    }
    for (let i = 0; i < tris.length; i++) {
      const t = tris[i];
      lines.push('f ' + (t.a + 1) + ' ' + (t.b + 1) + ' ' + (t.c + 1));
    }
    return lines.join('\n') + '\n';
  }

  // Stage colours from the shared tokens (ui/base.css), read once and cached.
  let palette = null;
  function getPalette() {
    if (palette) return palette;
    palette = { well: '#f7f7f5', surface: '#ffffff', shadow: 'rgba(22, 22, 21, 0.07)' };
    try {
      const cs = global.getComputedStyle(global.document.documentElement);
      palette.well = cs.getPropertyValue('--ui-well').trim() || palette.well;
      palette.surface = cs.getPropertyValue('--ui-surface').trim() || palette.surface;
    } catch (_err) {}
    return palette;
  }

  // One visibilitychange listener for every viewer on the page: resuming the tab restarts
  // only viewers that still have something to spin (frame() stops the rest at once).
  const liveViewers = new Set();
  let visibilityHooked = false;
  function hookVisibility() {
    if (visibilityHooked || !global.document || typeof global.document.addEventListener !== 'function') return;
    visibilityHooked = true;
    global.document.addEventListener('visibilitychange', function () {
      if (global.document.visibilityState === 'hidden') return;
      liveViewers.forEach(function (draw) { draw(); });
    });
  }

  function createViewer(canvas, options) {
    const opts = options || {};
    const ctx = canvas.getContext('2d');
    let mesh = null;
    let yaw = opts.yaw !== undefined ? opts.yaw : 0.6;
    let pitch = opts.pitch !== undefined ? opts.pitch : 0.35;
    let zoom = opts.zoom !== undefined ? opts.zoom : 1.0;
    let autoSpin = opts.autoSpin !== false;
    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    let rafId = null;

    const lightKey = [0.52, 0.72, 0.46];
    const lightFill = [-0.6, 0.25, -0.75];

    function projectAndDraw() {
      const rect = canvas.getBoundingClientRect();
      const w = Math.max(1, Math.floor(rect.width));
      const h = Math.max(1, Math.floor(rect.height));
      const dpr = Math.min(global.devicePixelRatio || 1, 2);
      // Integer backing size: at a fractional DPR (page zoom) `w * dpr` never equals the
      // integer canvas.width, which reallocated the canvas on every frame.
      const bw = Math.round(w * dpr);
      const bh = Math.round(h * dpr);
      if (canvas.width !== bw || canvas.height !== bh) {
        canvas.width = bw;
        canvas.height = bh;
      }

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const pal = getPalette();

      // Light well with a soft lit centre, so the stage belongs to the page.
      const grad = ctx.createRadialGradient(w * 0.5, h * 0.45, 4, w * 0.5, h * 0.5, Math.max(w, h) * 0.7);
      grad.addColorStop(0, pal.surface);
      grad.addColorStop(1, pal.well);
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);

      if (!mesh || !mesh.vertices.length) return;

      const cy = Math.cos(yaw), sy = Math.sin(yaw);
      const cp = Math.cos(pitch), sp = Math.sin(pitch);
      const camDist = 4.4 / Math.max(0.45, Math.min(2.5, zoom));
      const focal = Math.min(w, h) * 1.18;
      const cx = w * 0.5;
      const cyScreen = h * 0.52;

      // Ground shadow under the normalised mesh (its bottom sits near y = -1.05).
      const unit = focal / camDist;
      ctx.fillStyle = pal.shadow;
      ctx.beginPath();
      ctx.ellipse(cx, cyScreen + unit * 1.05 * Math.cos(pitch), unit * 0.85, unit * 0.16, 0, 0, Math.PI * 2);
      ctx.fill();

      const transformed = new Array(mesh.vertices.length);
      for (let i = 0; i < mesh.vertices.length; i++) {
        const v = mesh.vertices[i];
        const x1 = v[0] * cy - v[2] * sy;
        const z1 = v[0] * sy + v[2] * cy;
        const y2 = v[1] * cp - z1 * sp;
        const z2 = v[1] * sp + z1 * cp;
        const depth = camDist + z2;
        const scale = focal / Math.max(0.2, depth);
        transformed[i] = [cx + x1 * scale, cyScreen - y2 * scale, z2, x1, y2];
      }

      const drawList = [];
      for (let i = 0; i < mesh.triangles.length; i++) {
        const tri = mesh.triangles[i];
        const va = transformed[tri.a];
        const vb = transformed[tri.b];
        const vc = transformed[tri.c];

        // Screen-space winding check (skip backfaces)
        const ux = vb[3] - va[3], uy = vb[4] - va[4], uz = vb[2] - va[2];
        const vx = vc[3] - va[3], vy = vc[4] - va[4], vz = vc[2] - va[2];
        let nx = uy * vz - uz * vy;
        let ny = uz * vx - ux * vz;
        let nz = ux * vy - uy * vx;
        const nLen = Math.hypot(nx, ny, nz) || 1;
        nx /= nLen; ny /= nLen; nz /= nLen;

        // Flip normal if pointing away from camera so both windings light cleanly
        const dotKey = Math.max(0, Math.abs(nx * lightKey[0] + ny * lightKey[1] + nz * lightKey[2]));
        const dotFill = Math.max(0, Math.abs(nx * lightFill[0] + ny * lightFill[1] + nz * lightFill[2]));
        const shade = Math.min(1.15, 0.28 + dotKey * 0.68 + dotFill * 0.22);

        drawList.push({
          ax: va[0], ay: va[1],
          bx: vb[0], by: vb[1],
          cx: vc[0], cy: vc[1],
          z: (va[2] + vb[2] + vc[2]) / 3,
          r: Math.min(255, Math.round(tri.rgb[0] * shade)),
          g: Math.min(255, Math.round(tri.rgb[1] * shade)),
          b: Math.min(255, Math.round(tri.rgb[2] * shade))
        });
      }

      drawList.sort(function (a, b) { return b.z - a.z; });

      for (let i = 0; i < drawList.length; i++) {
        const f = drawList[i];
        const fill = 'rgb(' + f.r + ',' + f.g + ',' + f.b + ')';
        ctx.beginPath();
        ctx.moveTo(f.ax, f.ay);
        ctx.lineTo(f.bx, f.by);
        ctx.lineTo(f.cx, f.cy);
        ctx.closePath();
        ctx.fillStyle = fill;
        ctx.fill();
        ctx.strokeStyle = fill;
        ctx.lineWidth = 0.4;
        ctx.stroke();
      }
    }

    // Draw on demand. The frame loop runs only while a mesh is auto-spinning in a canvas that
    // is on screen in a visible tab; otherwise one frame is drawn per change (mesh, camera,
    // resize) and nothing is scheduled. Three tiles x 8 viewers used to loop forever.
    let onScreen = true;
    function spinning() {
      return Boolean(mesh) && autoSpin && !dragging && onScreen &&
        !(global.document && global.document.visibilityState === 'hidden');
    }

    function frame() {
      rafId = null;
      if (spinning()) yaw += 0.008;
      projectAndDraw();
      if (spinning()) requestDraw();
    }

    function requestDraw() {
      if (rafId || typeof global.requestAnimationFrame !== 'function') return;
      rafId = global.requestAnimationFrame(frame);
    }

    const observers = [];
    if (typeof global.IntersectionObserver === 'function') {
      const io = new global.IntersectionObserver(function (entries) {
        const last = entries[entries.length - 1];
        onScreen = Boolean(last && last.isIntersecting);
        if (onScreen) requestDraw();
      });
      io.observe(canvas);
      observers.push(io);
    }
    if (typeof global.ResizeObserver === 'function') {
      // Dialog canvases are 0x0 until the dialog opens; redraw at the new size.
      const ro = new global.ResizeObserver(function () { requestDraw(); });
      ro.observe(canvas);
      observers.push(ro);
    }
    liveViewers.add(requestDraw);
    hookVisibility();

    // A lost 2D context comes back blank; repaint once it is restored.
    canvas.addEventListener('contextrestored', function () { requestDraw(); });

    canvas.addEventListener('pointerdown', function (e) {
      dragging = true;
      autoSpin = false;
      lastX = e.clientX;
      lastY = e.clientY;
      // Throws NotFoundError when the pointer is no longer active (released, synthetic).
      try { if (canvas.setPointerCapture) canvas.setPointerCapture(e.pointerId); } catch (_err) {}
    });

    canvas.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      yaw += dx * 0.012;
      pitch = Math.max(-1.35, Math.min(1.35, pitch + dy * 0.012));
      requestDraw();
      if (typeof opts.onOrbit === 'function') {
        opts.onOrbit({ yaw: yaw, pitch: pitch, zoom: zoom });
      }
    });

    function endDrag() {
      dragging = false;
    }
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);

    // Zoom only on a trackpad pinch or Ctrl/Cmd + wheel, and only with a mesh: twelve
    // viewports cover most of three tiles, and a plain wheel there must scroll the page.
    canvas.addEventListener('wheel', function (e) {
      if (!mesh || !(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      zoom = Math.max(0.5, Math.min(2.2, zoom - e.deltaY * 0.0012));
      requestDraw();
      if (typeof opts.onOrbit === 'function') {
        opts.onOrbit({ yaw: yaw, pitch: pitch, zoom: zoom });
      }
    }, { passive: false });

    projectAndDraw();

    return {
      setMesh: function (nextMesh) {
        mesh = nextMesh;
        autoSpin = true;
        // Synchronous draw: rAF / observers may not run in a hidden or background tab.
        projectAndDraw();
        requestDraw();
      },
      setCamera: function (cam) {
        if (!cam) return;
        yaw = cam.yaw;
        pitch = cam.pitch;
        zoom = cam.zoom;
        autoSpin = false;
        requestDraw();
      },
      isAnimating: function () {
        return rafId !== null;
      },
      destroy: function () {
        if (rafId && typeof global.cancelAnimationFrame === 'function') global.cancelAnimationFrame(rafId);
        rafId = null;
        observers.forEach(function (o) { o.disconnect(); });
        liveViewers.delete(requestDraw);
      }
    };
  }

  NS.Renderer = {
    buildMeshFromScene: buildMeshFromScene,
    exportMeshToOBJ: exportMeshToOBJ,
    createViewer: createViewer
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = NS.Renderer;
  }
})(typeof window !== 'undefined' ? window : globalThis);
