(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  const ns = (root.MotionGrid = root.MotionGrid || {});
  ns.QR = api;
})(typeof globalThis !== 'undefined' ? globalThis : window, function () {
  'use strict';

  // ISO/IEC 18004 Byte-mode QR Encoder (Versions 1-10, Error Correction Level M)
  // Zero external dependencies; renders crisp inline SVG with a 4-module quiet zone.

  const GF_EXP = new Uint8Array(512);
  const GF_LOG = new Uint8Array(256);
  (function initGF() {
    let x = 1;
    for (let i = 0; i < 255; i++) {
      GF_EXP[i] = x;
      GF_LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (let i = 255; i < 512; i++) {
      GF_EXP[i] = GF_EXP[i - 255];
    }
  })();

  function gfMul(a, b) {
    if (a === 0 || b === 0) return 0;
    return GF_EXP[GF_LOG[a] + GF_LOG[b]];
  }

  function rsGeneratorPoly(degree) {
    let poly = [1];
    for (let i = 0; i < degree; i++) {
      const next = new Array(poly.length + 1).fill(0);
      const rootVal = GF_EXP[i];
      for (let j = 0; j < poly.length; j++) {
        next[j] ^= poly[j];
        next[j + 1] ^= gfMul(poly[j], rootVal);
      }
      poly = next;
    }
    return poly;
  }

  function rsComputeRemainder(data, ecCount) {
    const gen = rsGeneratorPoly(ecCount);
    const rem = new Uint8Array(ecCount);
    for (let i = 0; i < data.length; i++) {
      const factor = data[i] ^ rem[0];
      for (let j = 0; j < ecCount - 1; j++) {
        rem[j] = rem[j + 1];
      }
      rem[ecCount - 1] = 0;
      if (factor !== 0) {
        for (let j = 0; j < ecCount; j++) {
          rem[j] ^= gfMul(gen[j + 1], factor);
        }
      }
    }
    return rem;
  }

  // Level M (ecBits = 0b00) specifications for Versions 1..10
  // blocks: array of [numBlocks, dataCodewordsPerBlock]
  const VERSION_SPECS = [
    null,
    { version: 1, total: 26, data: 16, ecPerBlock: 10, blocks: [[1, 16]], align: [] },
    { version: 2, total: 44, data: 28, ecPerBlock: 16, blocks: [[1, 28]], align: [6, 18] },
    { version: 3, total: 70, data: 44, ecPerBlock: 26, blocks: [[1, 44]], align: [6, 22] },
    { version: 4, total: 100, data: 64, ecPerBlock: 18, blocks: [[2, 32]], align: [6, 26] },
    { version: 5, total: 134, data: 86, ecPerBlock: 24, blocks: [[2, 43]], align: [6, 30] },
    { version: 6, total: 172, data: 108, ecPerBlock: 16, blocks: [[4, 27]], align: [6, 34] },
    { version: 7, total: 196, data: 124, ecPerBlock: 18, blocks: [[4, 31]], align: [6, 22, 38] },
    { version: 8, total: 242, data: 154, ecPerBlock: 22, blocks: [[2, 38], [2, 39]], align: [6, 24, 42] },
    { version: 9, total: 292, data: 182, ecPerBlock: 22, blocks: [[3, 36], [2, 37]], align: [6, 26, 46] },
    { version: 10, total: 346, data: 216, ecPerBlock: 26, blocks: [[4, 43], [1, 44]], align: [6, 28, 50] }
  ];

  function toUtf8Bytes(str) {
    if (typeof TextEncoder !== 'undefined') {
      return Array.from(new TextEncoder().encode(String(str)));
    }
    const bytes = [];
    const s = String(str);
    for (let i = 0; i < s.length; i++) {
      let code = s.charCodeAt(i);
      if (code < 0x80) {
        bytes.push(code);
      } else if (code < 0x800) {
        bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
      } else {
        bytes.push(
          0xe0 | (code >> 12),
          0x80 | ((code >> 6) & 0x3f),
          0x80 | (code & 0x3f)
        );
      }
    }
    return bytes;
  }

  function pickVersion(byteLen) {
    for (let v = 1; v <= 10; v++) {
      const spec = VERSION_SPECS[v];
      const countBits = v <= 9 ? 8 : 16;
      const neededBits = 4 + countBits + byteLen * 8;
      if (neededBits <= spec.data * 8) {
        return spec;
      }
    }
    throw new Error('QR payload too long for Versions 1-10 (max 213 bytes at EC-M)');
  }

  function buildDataCodewords(bytes, spec) {
    const bits = [];
    function pushBits(val, len) {
      for (let i = len - 1; i >= 0; i--) {
        bits.push((val >>> i) & 1);
      }
    }
    // Mode 0100 (Byte)
    pushBits(0b0100, 4);
    pushBits(bytes.length, spec.version <= 9 ? 8 : 16);
    for (let i = 0; i < bytes.length; i++) {
      pushBits(bytes[i], 8);
    }
    const capacityBits = spec.data * 8;
    const terminatorLen = Math.min(4, capacityBits - bits.length);
    for (let i = 0; i < terminatorLen; i++) bits.push(0);
    while (bits.length % 8 !== 0) bits.push(0);

    const codewords = [];
    for (let i = 0; i < bits.length; i += 8) {
      let b = 0;
      for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
      codewords.push(b);
    }
    let padToggle = 0;
    while (codewords.length < spec.data) {
      codewords.push(padToggle === 0 ? 0xec : 0x11);
      padToggle ^= 1;
    }
    return codewords;
  }

  function interleaveBlocks(dataCodewords, spec) {
    const dataBlocks = [];
    const ecBlocks = [];
    let offset = 0;
    for (let g = 0; g < spec.blocks.length; g++) {
      const count = spec.blocks[g][0];
      const len = spec.blocks[g][1];
      for (let b = 0; b < count; b++) {
        const slice = dataCodewords.slice(offset, offset + len);
        offset += len;
        dataBlocks.push(slice);
        ecBlocks.push(rsComputeRemainder(slice, spec.ecPerBlock));
      }
    }

    const out = [];
    const maxDataLen = Math.max.apply(null, dataBlocks.map(function (b) { return b.length; }));
    for (let i = 0; i < maxDataLen; i++) {
      for (let b = 0; b < dataBlocks.length; b++) {
        if (i < dataBlocks[b].length) out.push(dataBlocks[b][i]);
      }
    }
    for (let i = 0; i < spec.ecPerBlock; i++) {
      for (let b = 0; b < ecBlocks.length; b++) {
        out.push(ecBlocks[b][i]);
      }
    }
    return out;
  }

  function computeFormatBits(ecBits, mask) {
    const data = (ecBits << 3) | mask;
    let rem = data << 10;
    const gen = 0x537;
    for (let i = 14; i >= 10; i--) {
      if ((rem >>> i) & 1) rem ^= gen << (i - 10);
    }
    return ((data << 10) | rem) ^ 0x5412;
  }

  function computeVersionBits(version) {
    let rem = version << 12;
    const gen = 0x1f25;
    for (let i = 17; i >= 12; i--) {
      if ((rem >>> i) & 1) rem ^= gen << (i - 12);
    }
    return (version << 12) | rem;
  }

  function createFunctionMatrix(spec) {
    const size = spec.version * 4 + 17;
    const modules = Array.from({ length: size }, function () { return new Uint8Array(size); });
    const isFunc = Array.from({ length: size }, function () { return new Uint8Array(size); });

    function setFunc(r, c, dark) {
      if (r < 0 || c < 0 || r >= size || c >= size) return;
      modules[r][c] = dark ? 1 : 0;
      isFunc[r][c] = 1;
    }

    function drawFinder(top, left) {
      for (let dr = -1; dr <= 7; dr++) {
        for (let dc = -1; dc <= 7; dc++) {
          const r = top + dr;
          const c = left + dc;
          if (r < 0 || c < 0 || r >= size || c >= size) continue;
          const inOuter = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
          const onBorder = dr === 0 || dr === 6 || dc === 0 || dc === 6;
          const inCenter = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
          setFunc(r, c, inOuter && (onBorder || inCenter));
        }
      }
    }

    drawFinder(0, 0);
    drawFinder(0, size - 7);
    drawFinder(size - 7, 0);

    // Timing patterns
    for (let i = 8; i < size - 8; i++) {
      setFunc(6, i, i % 2 === 0);
      setFunc(i, 6, i % 2 === 0);
    }

    // Alignment patterns (skip only the 3 corners occupied by finder patterns)
    const coords = spec.align;
    for (let i = 0; i < coords.length; i++) {
      for (let j = 0; j < coords.length; j++) {
        if ((i === 0 && j === 0) ||
            (i === 0 && j === coords.length - 1) ||
            (i === coords.length - 1 && j === 0)) {
          continue;
        }
        const cr = coords[i];
        const cc = coords[j];
        for (let dr = -2; dr <= 2; dr++) {
          for (let dc = -2; dc <= 2; dc++) {
            const dist = Math.max(Math.abs(dr), Math.abs(dc));
            setFunc(cr + dr, cc + dc, dist === 0 || dist === 2);
          }
        }
      }
    }

    // Reserve format areas + dark module
    for (let i = 0; i <= 8; i++) {
      if (i !== 6) {
        setFunc(8, i, false);
        setFunc(i, 8, false);
      }
    }
    for (let i = 0; i < 8; i++) {
      setFunc(8, size - 1 - i, false);
      setFunc(size - 1 - i, 8, false);
    }
    setFunc(size - 8, 8, true); // Dark module

    // Version info (Version >= 7)
    if (spec.version >= 7) {
      const vBits = computeVersionBits(spec.version);
      for (let i = 0; i < 18; i++) {
        const bit = ((vBits >>> i) & 1) === 1;
        const a = Math.floor(i / 3);
        const b = size - 11 + (i % 3);
        setFunc(a, b, bit);
        setFunc(b, a, bit);
      }
    }

    return { size: size, modules: modules, isFunc: isFunc };
  }

  function placeDataBits(modules, isFunc, codewords) {
    const size = modules.length;
    const totalBits = codewords.length * 8;
    let bitIdx = 0;
    let upward = true;

    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5; // Skip vertical timing column
      for (let step = 0; step < size; step++) {
        const r = upward ? size - 1 - step : step;
        for (let dx = 0; dx < 2; dx++) {
          const c = right - dx;
          if (!isFunc[r][c]) {
            let dark = 0;
            if (bitIdx < totalBits) {
              const cw = codewords[bitIdx >>> 3];
              dark = (cw >>> (7 - (bitIdx & 7))) & 1;
              bitIdx++;
            }
            modules[r][c] = dark;
          }
        }
      }
      upward = !upward;
    }
  }

  function maskBit(mask, r, c) {
    switch (mask) {
      case 0: return (r + c) % 2 === 0;
      case 1: return r % 2 === 0;
      case 2: return c % 3 === 0;
      case 3: return (r + c) % 3 === 0;
      case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
      case 5: return ((r * c) % 2) + ((r * c) % 3) === 0;
      case 6: return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
      case 7: return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
      default: return false;
    }
  }

  function applyFormatBits(modules, mask) {
    const size = modules.length;
    const fmt = computeFormatBits(0b00, mask); // EC Level M = 00
    // Bit 0 is LSB, bit 14 is MSB
    const getBit = function (i) { return (fmt >>> i) & 1; };

    // Top-left around finder
    for (let i = 0; i <= 5; i++) modules[8][i] = getBit(14 - i);
    modules[8][7] = getBit(8);
    modules[8][8] = getBit(7);
    modules[7][8] = getBit(6);
    for (let i = 9; i < 15; i++) modules[14 - i][8] = getBit(14 - i);

    // Bottom-left and top-right
    for (let i = 0; i < 7; i++) modules[size - 1 - i][8] = getBit(14 - i);
    for (let i = 7; i < 15; i++) modules[8][size - 15 + i] = getBit(14 - i);
    modules[size - 8][8] = 1; // Dark module
  }

  function evaluatePenalty(modules) {
    const size = modules.length;
    let penalty = 0;

    // Rule 1: 5+ consecutive same-color modules in row/col
    for (let r = 0; r < size; r++) {
      let runColor = modules[r][0];
      let runLen = 1;
      for (let c = 1; c < size; c++) {
        if (modules[r][c] === runColor) {
          runLen++;
        } else {
          if (runLen >= 5) penalty += 3 + (runLen - 5);
          runColor = modules[r][c];
          runLen = 1;
        }
      }
      if (runLen >= 5) penalty += 3 + (runLen - 5);
    }
    for (let c = 0; c < size; c++) {
      let runColor = modules[0][c];
      let runLen = 1;
      for (let r = 1; r < size; r++) {
        if (modules[r][c] === runColor) {
          runLen++;
        } else {
          if (runLen >= 5) penalty += 3 + (runLen - 5);
          runColor = modules[r][c];
          runLen = 1;
        }
      }
      if (runLen >= 5) penalty += 3 + (runLen - 5);
    }

    // Rule 2: 2x2 blocks of same color
    for (let r = 0; r < size - 1; r++) {
      for (let c = 0; c < size - 1; c++) {
        const v = modules[r][c];
        if (v === modules[r][c + 1] && v === modules[r + 1][c] && v === modules[r + 1][c + 1]) {
          penalty += 3;
        }
      }
    }

    // Rule 3: Finder-like 1:1:3:1:1 patterns with 4 light modules on either side
    const patA = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
    const patB = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
    for (let r = 0; r < size; r++) {
      for (let c = 0; c <= size - 11; c++) {
        let mA = true;
        let mB = true;
        for (let k = 0; k < 11; k++) {
          if (modules[r][c + k] !== patA[k]) mA = false;
          if (modules[r][c + k] !== patB[k]) mB = false;
          if (!mA && !mB) break;
        }
        if (mA || mB) penalty += 40;
      }
    }
    for (let c = 0; c < size; c++) {
      for (let r = 0; r <= size - 11; r++) {
        let mA = true;
        let mB = true;
        for (let k = 0; k < 11; k++) {
          if (modules[r + k][c] !== patA[k]) mA = false;
          if (modules[r + k][c] !== patB[k]) mB = false;
          if (!mA && !mB) break;
        }
        if (mA || mB) penalty += 40;
      }
    }

    // Rule 4: Dark/light balance
    let darkCount = 0;
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        darkCount += modules[r][c];
      }
    }
    const pct = (darkCount * 100) / (size * size);
    const k = Math.floor(Math.abs(pct - 50) / 5);
    penalty += k * 10;

    return penalty;
  }

  function encode(text) {
    const bytes = toUtf8Bytes(text);
    const spec = pickVersion(bytes.length);
    const dataCodewords = buildDataCodewords(bytes, spec);
    const allCodewords = interleaveBlocks(dataCodewords, spec);
    const base = createFunctionMatrix(spec);
    placeDataBits(base.modules, base.isFunc, allCodewords);

    let bestMask = 0;
    let bestPenalty = Infinity;
    let bestModules = null;

    for (let mask = 0; mask < 8; mask++) {
      const candidate = base.modules.map(function (row) { return new Uint8Array(row); });
      for (let r = 0; r < base.size; r++) {
        for (let c = 0; c < base.size; c++) {
          if (!base.isFunc[r][c] && maskBit(mask, r, c)) {
            candidate[r][c] ^= 1;
          }
        }
      }
      applyFormatBits(candidate, mask);
      const p = evaluatePenalty(candidate);
      if (p < bestPenalty) {
        bestPenalty = p;
        bestMask = mask;
        bestModules = candidate;
      }
    }

    return {
      version: spec.version,
      size: base.size,
      mask: bestMask,
      ecLevel: 'M',
      modules: bestModules
    };
  }

  function buildPathData(qr, quiet) {
    const parts = [];
    const size = qr.size;
    for (let r = 0; r < size; r++) {
      let c = 0;
      while (c < size) {
        if (qr.modules[r][c]) {
          let run = 1;
          while (c + run < size && qr.modules[r][c + run]) run++;
          parts.push('M' + (c + quiet) + ',' + (r + quiet) + 'h' + run + 'v1h-' + run + 'z');
          c += run;
        } else {
          c++;
        }
      }
    }
    return parts.join('');
  }

  function renderSVGElement(text, opts) {
    const options = opts || {};
    const quiet = typeof options.quiet === 'number' ? options.quiet : 4;
    const fg = options.fg || '#141413';
    const bg = options.bg || '#ffffff';
    const qr = typeof text === 'string' ? encode(text) : text;
    const dim = qr.size + quiet * 2;
    const ns = 'http://www.w3.org/2000/svg';

    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + dim + ' ' + dim);
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', options.label || 'QR code to open iPhone motion controller');
    svg.setAttribute('shape-rendering', 'crispEdges');

    const rect = document.createElementNS(ns, 'rect');
    rect.setAttribute('width', String(dim));
    rect.setAttribute('height', String(dim));
    rect.setAttribute('fill', bg);
    svg.appendChild(rect);

    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', buildPathData(qr, quiet));
    path.setAttribute('fill', fg);
    svg.appendChild(path);

    return { svg: svg, qr: qr };
  }

  return {
    encode: encode,
    buildPathData: buildPathData,
    renderSVGElement: renderSVGElement,
    _internal: {
      rsComputeRemainder: rsComputeRemainder,
      computeFormatBits: computeFormatBits,
      computeVersionBits: computeVersionBits,
      VERSION_SPECS: VERSION_SPECS
    }
  };
});
