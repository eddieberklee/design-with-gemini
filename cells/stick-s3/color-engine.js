(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  const ns = (root.StickS3Color = root.StickS3Color || {});
  ns.ColorEngine = api;
})(typeof globalThis !== 'undefined' ? globalThis : window, function () {
  'use strict';

  const MODES = [
    {
      id: 0,
      key: 'oklch',
      shortLabel: 'OKLCH',
      label: 'OKLCH Gravity Dome',
      axisHint: 'Tilt direction → Hue · Tilt angle → Chroma · Face Z → Lightness'
    },
    {
      id: 1,
      key: 'rgb',
      shortLabel: 'RGB',
      label: 'XYZ → RGB Cube',
      axisHint: 'X-axis → Red · Y-axis → Green · Z-axis → Blue'
    },
    {
      id: 2,
      key: 'thermal',
      shortLabel: 'THERM',
      label: 'Thermal Kinetic',
      axisHint: 'Tilt + Shake energy → Indigo · Crimson · Signal Orange · Solar Gold'
    },
    {
      id: 3,
      key: 'prism',
      shortLabel: 'PRISM',
      label: 'Spectral Prism',
      axisHint: 'Micro-tilt ±30° → High-dispersion full-spectrum sweep'
    }
  ];

  function clamp(v, lo, hi) {
    if (v === Infinity) return hi;
    if (v === -Infinity) return lo;
    if (v === null || v === undefined || v === '' || typeof v === 'boolean') {
      return 0 < lo ? lo : (0 > hi ? hi : 0);
    }
    const n = Number(v);
    if (n === Infinity) return hi;
    if (n === -Infinity) return lo;
    if (!Number.isFinite(n)) {
      return 0 < lo ? lo : (0 > hi ? hi : 0);
    }
    return n < lo ? lo : (n > hi ? hi : n);
  }

  function safeMode(m) {
    if (m === null || m === undefined || typeof m === 'boolean') return 0;
    const n = Number(m);
    if (!Number.isFinite(n)) return 0;
    const len = MODES.length;
    return ((Math.trunc(n) % len) + len) % len;
  }

  function finiteOr(val, fallback) {
    if (val === null || val === undefined || val === '' || typeof val === 'boolean') {
      return fallback;
    }
    const n = Number(val);
    return Number.isFinite(n) ? n : fallback;
  }

  function smoothstep01(t) {
    const u = clamp(t, 0, 1);
    return u * u * (3 - 2 * u);
  }

  function wrapHue(deg) {
    const n = Number(deg);
    if (!Number.isFinite(n)) return 0;
    const m = n % 360;
    return m < 0 ? m + 360 : m;
  }

  function linearToSrgb(c) {
    const v = clamp(c, 0, 1);
    return v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  }

  function srgbByteToLinear(byteVal) {
    const s = clamp(byteVal, 0, 255) / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  }

  function oklabToLinearSrgb(L, a, b) {
    const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
    const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
    const s_ = L - 0.0894841775 * a - 1.2914855480 * b;

    const l = l_ * l_ * l_;
    const m = m_ * m_ * m_;
    const s = s_ * s_ * s_;

    return {
      r: +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
      g: -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
      b: -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s
    };
  }

  function linearSrgbToOklab(r, g, b) {
    const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
    const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
    const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;

    const l_ = Math.cbrt(Math.max(0, l));
    const m_ = Math.cbrt(Math.max(0, m));
    const s_ = Math.cbrt(Math.max(0, s));

    return {
      L: 0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
      a: 1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
      b: 0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_
    };
  }

  function inSrgbGamut(rgb) {
    const eps = 0.0005;
    return (
      rgb.r >= -eps && rgb.r <= 1 + eps &&
      rgb.g >= -eps && rgb.g <= 1 + eps &&
      rgb.b >= -eps && rgb.b <= 1 + eps
    );
  }

  function toHexByte(n) {
    const v = Math.round(clamp(n, 0, 255));
    return (v < 16 ? '0' : '') + v.toString(16).toUpperCase();
  }

  function formatHex(r, g, b) {
    return '#' + toHexByte(r) + toHexByte(g) + toHexByte(b);
  }

  // Matches firmware/src/color_math.h::oklchToSrgbGamutMapped
  function oklchToSrgbGamutMapped(L, C, hDeg) {
    const clL = clamp(L, 0, 1);
    const clC = clamp(C, 0, 0.37);
    const wrappedH = wrapHue(hDeg);

    if (clL <= 0.001) {
      return {
        r: 0,
        g: 0,
        b: 0,
        hex: '#000000',
        l: 0,
        c: 0,
        h: wrappedH,
        oklabA: 0,
        oklabB: 0
      };
    }
    if (clL >= 0.999 && clC <= 0.001) {
      return {
        r: 255,
        g: 255,
        b: 255,
        hex: '#FFFFFF',
        l: 1,
        c: 0,
        h: wrappedH,
        oklabA: 0,
        oklabB: 0
      };
    }

    const rad = wrappedH * (Math.PI / 180);
    const cosH = Math.cos(rad);
    const sinH = Math.sin(rad);

    let usedC = clC;
    let lin = oklabToLinearSrgb(clL, clC * cosH, clC * sinH);

    if (!inSrgbGamut(lin)) {
      let lo = 0;
      let hi = clC;
      for (let i = 0; i < 10; i++) {
        const mid = 0.5 * (lo + hi);
        const test = oklabToLinearSrgb(clL, mid * cosH, mid * sinH);
        if (inSrgbGamut(test)) {
          lo = mid;
          lin = test;
        } else {
          hi = mid;
        }
      }
      usedC = lo;
      lin = oklabToLinearSrgb(clL, usedC * cosH, usedC * sinH);
    }

    const r = Math.round(linearToSrgb(lin.r) * 255);
    const g = Math.round(linearToSrgb(lin.g) * 255);
    const b = Math.round(linearToSrgb(lin.b) * 255);
    return {
      r: r,
      g: g,
      b: b,
      hex: formatHex(r, g, b),
      l: clL,
      c: usedC,
      h: wrappedH,
      oklabA: usedC * cosH,
      oklabB: usedC * sinH
    };
  }

  function rgbBytesToColorSpec(r, g, b) {
    const rb = Math.round(clamp(r, 0, 255));
    const gb = Math.round(clamp(g, 0, 255));
    const bb = Math.round(clamp(b, 0, 255));
    const lab = linearSrgbToOklab(
      srgbByteToLinear(rb),
      srgbByteToLinear(gb),
      srgbByteToLinear(bb)
    );
    const c = Math.hypot(lab.a, lab.b);
    const h = c > 0.0002 ? wrapHue(Math.atan2(lab.b, lab.a) * (180 / Math.PI)) : 0;
    return {
      r: rb,
      g: gb,
      b: bb,
      hex: formatHex(rb, gb, bb),
      l: clamp(lab.L, 0, 1),
      c: clamp(c, 0, 0.37),
      h: h,
      oklabA: lab.a,
      oklabB: lab.b
    };
  }

  // Exact match to firmware/src/color_math.h::mapImuToColor
  function mapImuToColor(tx, ty, az, kineticEnergy, mode) {
    const cleanTx = clamp(tx, -1.5, 1.5);
    const cleanTy = clamp(ty, -1.5, 1.5);
    const cleanAz = clamp(az, -1.5, 1.5);
    const kin = clamp(kineticEnergy, 0, 1);

    const tiltMag = clamp(Math.hypot(cleanTx, cleanTy) / 0.92, 0, 1);
    const angleDeg = wrapHue(Math.atan2(cleanTy, cleanTx) * (180 / Math.PI));
    const zNorm = clamp((cleanAz + 1) * 0.5, 0, 1);
    const m = safeMode(mode);

    if (m === 0) {
      const chroma = 0.018 + 0.235 * smoothstep01(tiltMag) + 0.045 * kin;
      const lightness = clamp(0.36 + 0.48 * zNorm + 0.08 * kin, 0.24, 0.90);
      return oklchToSrgbGamutMapped(lightness, chroma, angleDeg);
    }

    if (m === 1) {
      const rx = smoothstep01(clamp((cleanTx + 0.95) / 1.90, 0, 1));
      const gy = smoothstep01(clamp((cleanTy + 0.95) / 1.90, 0, 1));
      const bz = smoothstep01(zNorm);
      const boost = 0.08 * kin;
      const rf = clamp(0.08 + 0.86 * rx + boost, 0, 1);
      const gf = clamp(0.08 + 0.86 * gy + boost, 0, 1);
      const bf = clamp(0.08 + 0.86 * bz + boost, 0, 1);
      return rgbBytesToColorSpec(rf * 255, gf * 255, bf * 255);
    }

    if (m === 2) {
      const heat = clamp(0.55 * tiltMag + 0.72 * kin + 0.18 * (1 - zNorm), 0, 1);
      let hue;
      if (heat < 0.35) {
        const u = heat / 0.35;
        hue = 275 + u * (372 - 275);
      } else {
        const u = (heat - 0.35) / 0.65;
        hue = 12 + u * 78;
      }
      const lightness = 0.24 + 0.66 * Math.pow(heat, 0.88);
      const chroma = heat < 0.85
        ? 0.08 + 0.19 * Math.sin(heat * Math.PI * 0.85)
        : 0.22 * (1 - (heat - 0.85) * 3.2);
      return oklchToSrgbGamutMapped(lightness, clamp(chroma, 0.03, 0.27), hue);
    }

    const fineHue = wrapHue(cleanTx * 210 + cleanTy * 135 + 200);
    const lightness = clamp(0.52 + 0.22 * cleanTy + 0.10 * (zNorm - 0.5) + 0.06 * kin, 0.34, 0.86);
    const chroma = 0.15 + 0.11 * smoothstep01(clamp(tiltMag * 1.6, 0, 1));
    return oklchToSrgbGamutMapped(lightness, chroma, fineHue);
  }

  function relativeLuminance(r, g, b) {
    return (
      0.2126 * srgbByteToLinear(r) +
      0.7152 * srgbByteToLinear(g) +
      0.0722 * srgbByteToLinear(b)
    );
  }

  function contrastRatio(lumA, lumB) {
    const hi = Math.max(lumA, lumB);
    const lo = Math.min(lumA, lumB);
    return (hi + 0.05) / (lo + 0.05);
  }

  // Returns WCAG-verified surface/ink tokens for any background RGB.
  // Optional prevIsLightBg enables Schmitt-trigger hysteresis around IEC crossover (~0.1791)
  // so 50 Hz IMU micro-jitter never strobes open-field reticle polarity.
  function pickAdaptiveTheme(r, g, b, prevIsLightBg) {
    const bgLum = relativeLuminance(r, g, b);
    const darkInkHex = '#000000'; // L_rel = 0.0 -> >= 4.58:1 at 0.1791 IEC crossover
    const darkInkLum = 0;
    const lightInkLum = 1;
    const crDark = contrastRatio(bgLum, darkInkLum);
    const crLight = contrastRatio(bgLum, lightInkLum);

    let useDarkInk;
    if (typeof prevIsLightBg === 'boolean') {
      if (prevIsLightBg) {
        useDarkInk = bgLum >= 0.168 && crDark >= 4.5 ? true : crDark >= crLight;
      } else {
        useDarkInk = bgLum > 0.192 && crDark >= 4.5 ? true : crDark > crLight && bgLum > 0.185;
      }
      // Always uphold strict >= 4.5:1 WCAG AA floor even inside hysteresis band
      const chosenCr = useDarkInk ? crDark : crLight;
      if (chosenCr < 4.5) {
        useDarkInk = crDark >= crLight;
      }
    } else {
      useDarkInk = crDark >= crLight;
    }

    return {
      isLightBg: useDarkInk,
      bgLuminance: bgLum,
      contrastRatio: useDarkInk ? crDark : crLight,
      ink: useDarkInk ? darkInkHex : '#ffffff',
      inkMuted: useDarkInk ? 'rgba(8, 8, 8, 0.78)' : 'rgba(255, 255, 255, 0.86)',
      pillBg: 'rgba(255, 255, 255, 0.93)',
      pillBorder: 'rgba(20, 20, 19, 0.14)',
      domeWell: useDarkInk ? 'rgba(255, 255, 255, 0.16)' : 'rgba(10, 10, 10, 0.20)',
      reticleHalo: useDarkInk ? 'rgba(255, 255, 255, 0.42)' : 'rgba(8, 8, 8, 0.44)',
      reticleStroke: useDarkInk ? 'rgba(8, 8, 8, 0.62)' : 'rgba(255, 255, 255, 0.72)',
      reticleFill: useDarkInk ? darkInkHex : '#ffffff'
    };
  }

  // Smooth interpolation in OKLab perceptual space so hue/lightness transitions never muddy
  function lerpColorOklab(c0, c1, t) {
    if (!c0) return c1;
    if (!c1) return c0;
    const u = clamp(t, 0, 1);
    if (u <= 0.001) return c0;
    if (u >= 0.999 || (c0.r === c1.r && c0.g === c1.g && c0.b === c1.b)) {
      return c1;
    }

    const L = c0.l + (c1.l - c0.l) * u;
    const a0 = typeof c0.oklabA === 'number' ? c0.oklabA : c0.c * Math.cos((c0.h * Math.PI) / 180);
    const b0 = typeof c0.oklabB === 'number' ? c0.oklabB : c0.c * Math.sin((c0.h * Math.PI) / 180);
    const a1 = typeof c1.oklabA === 'number' ? c1.oklabA : c1.c * Math.cos((c1.h * Math.PI) / 180);
    const b1 = typeof c1.oklabB === 'number' ? c1.oklabB : c1.c * Math.sin((c1.h * Math.PI) / 180);

    const a = a0 + (a1 - a0) * u;
    const b = b0 + (b1 - b0) * u;
    const C = Math.hypot(a, b);
    const h = C > 0.0002 ? wrapHue(Math.atan2(b, a) * (180 / Math.PI)) : c1.h;
    return oklchToSrgbGamutMapped(L, C, h);
  }

  function parseHexToSpec(hexStr) {
    if (typeof hexStr !== 'string') return null;
    const m = /^#?([0-9a-fA-F]{6})$/.exec(hexStr.trim());
    if (!m) return null;
    const n = parseInt(m[1], 16);
    return rgbBytesToColorSpec((n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff);
  }

  // Strict zero-throw telemetry line parser for StickS3 JSON packets
  function parseTelemetryLine(rawLine) {
    if (typeof rawLine !== 'string') return null;
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed[0] !== '{') return null;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch (_err) {
      return null;
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    if (obj.t !== 's3' && obj.t !== 'imu') return null;

    const ax = clamp(finiteOr(obj.ax, 0), -4, 4);
    const ay = clamp(finiteOr(obj.ay, 0), -4, 4);
    const az = clamp(finiteOr(obj.az, 1), -4, 4);
    const tx = clamp(finiteOr(obj.tx, ax), -2, 2);
    const ty = clamp(finiteOr(obj.ty, ay), -2, 2);
    const gx = clamp(finiteOr(obj.gx, 0), -2000, 2000);
    const gy = clamp(finiteOr(obj.gy, 0), -2000, 2000);
    const gz = clamp(finiteOr(obj.gz, 0), -2000, 2000);
    const mode = safeMode(obj.m);
    const hold = Boolean(obj.h === 1 || obj.h === true || obj.hold === 1 || obj.hold === true);
    const fallbackKin = Math.abs(Math.hypot(ax, ay, az) - 1) * 1.35 + Math.hypot(gx, gy, gz) / 1200;
    const kin = clamp(finiteOr(obj.kin, fallbackKin), 0, 1);

    const hasRoll = obj.r !== null && obj.r !== undefined && obj.r !== '' && typeof obj.r !== 'boolean' && Number.isFinite(Number(obj.r));
    const roll = hasRoll
      ? clamp(Number(obj.r), -180, 180)
      : Math.atan2(tx, Math.hypot(ty, az)) * (180 / Math.PI);

    const hasPitch = obj.p !== null && obj.p !== undefined && obj.p !== '' && typeof obj.p !== 'boolean' && Number.isFinite(Number(obj.p));
    const pitch = hasPitch
      ? clamp(Number(obj.p), -180, 180)
      : Math.atan2(ty, Math.hypot(tx, az)) * (180 / Math.PI);

    const hasBat = obj.bat !== null && obj.bat !== undefined && obj.bat !== '' && typeof obj.bat !== 'boolean' && Number.isFinite(Number(obj.bat));
    const battery = hasBat ? clamp(Math.round(Number(obj.bat)), -1, 100) : -1;

    const rawSeq = obj.seq === null || obj.seq === undefined || typeof obj.seq === 'boolean' ? NaN : Number(obj.seq);
    const seq = Number.isFinite(rawSeq) ? Math.max(0, Math.min(0xFFFFFFFF, Math.trunc(rawSeq))) : 0;

    const computedColor = mapImuToColor(tx, ty, az, kin, mode);
    const deviceColor = parseHexToSpec(obj.hex) || computedColor;

    return {
      seq: seq,
      ax: ax,
      ay: ay,
      az: az,
      tx: tx,
      ty: ty,
      gx: gx,
      gy: gy,
      gz: gz,
      roll: roll,
      pitch: pitch,
      kin: kin,
      mode: mode,
      hold: hold,
      battery: battery,
      event: typeof obj.ev === 'string' ? obj.ev.slice(0, 16) : '',
      color: hold ? deviceColor : computedColor,
      deviceHex: deviceColor.hex
    };
  }

  function buildHostCommand(cmd) {
    if (!cmd || typeof cmd !== 'object') return '';
    if (cmd.cmd === 'mode') {
      const m = safeMode(cmd.m);
      return JSON.stringify({ cmd: 'mode', m: m }) + '\n';
    }
    if (cmd.cmd === 'hold') {
      return JSON.stringify({ cmd: 'hold', h: cmd.h ? 1 : 0 }) + '\n';
    }
    if (cmd.cmd === 'tare') {
      return JSON.stringify({ cmd: 'tare' }) + '\n';
    }
    if (cmd.cmd === 'status' || cmd.cmd === 'ping') {
      return JSON.stringify({ cmd: 'status' }) + '\n';
    }
    return '';
  }

  function sampleDemoMotion(preset, timeSec) {
    const rawT = Number(timeSec);
    const t = Number.isFinite(rawT) ? rawT : 0;
    if (preset === 'flip') {
      const phase = t * 1.35;
      const ax = 0.38 * Math.sin(phase * 0.7);
      const ay = Math.sin(phase) * 0.92;
      const az = Math.cos(phase);
      return { ax: ax, ay: ay, az: az, tx: ax, ty: ay, kin: 0.08 + 0.12 * Math.abs(Math.sin(phase * 2)) };
    }
    if (preset === 'shake') {
      const burst = Math.pow(0.5 + 0.5 * Math.sin(t * 2.1), 2);
      const ax = 0.65 * Math.sin(t * 9.5) * burst;
      const ay = 0.58 * Math.cos(t * 7.8) * burst;
      const az = 0.78 + 0.35 * Math.sin(t * 12.0) * burst;
      return { ax: ax, ay: ay, az: az, tx: ax, ty: ay, kin: clamp(0.15 + 0.85 * burst, 0, 1) };
    }
    // Default smooth 360-degree tilt orbit
    const radius = 0.62 + 0.22 * Math.sin(t * 0.55);
    const ax = Math.cos(t * 1.15) * radius;
    const ay = Math.sin(t * 1.15) * radius;
    const az = Math.sqrt(Math.max(0.05, 1 - Math.min(0.95, ax * ax + ay * ay))) * (Math.cos(t * 0.35) >= -0.6 ? 1 : -1);
    return { ax: ax, ay: ay, az: az, tx: ax, ty: ay, kin: 0.06 };
  }

  return {
    MODES: MODES,
    clamp: clamp,
    safeMode: safeMode,
    wrapHue: wrapHue,
    formatHex: formatHex,
    oklchToSrgbGamutMapped: oklchToSrgbGamutMapped,
    rgbBytesToColorSpec: rgbBytesToColorSpec,
    mapImuToColor: mapImuToColor,
    relativeLuminance: relativeLuminance,
    contrastRatio: contrastRatio,
    pickAdaptiveTheme: pickAdaptiveTheme,
    lerpColorOklab: lerpColorOklab,
    parseHexToSpec: parseHexToSpec,
    parseTelemetryLine: parseTelemetryLine,
    buildHostCommand: buildHostCommand,
    sampleDemoMotion: sampleDemoMotion
  };
});
