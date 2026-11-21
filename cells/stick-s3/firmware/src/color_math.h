#pragma once
#include <math.h>
#include <stdint.h>
#include <stdio.h>

namespace sticks3_color {

enum ColorMode : uint8_t {
  MODE_OKLCH_DOME = 0,
  MODE_RGB_CUBE = 1,
  MODE_THERMAL_KINETIC = 2,
  MODE_SPECTRAL_PRISM = 3,
  MODE_COUNT = 4
};

struct RgbColor {
  uint8_t r;
  uint8_t g;
  uint8_t b;
  float l;      // OKLab/perceptual lightness [0..1]
  float c;      // OKLCH chroma [0..0.32]
  float h_deg;  // Hue angle [0..360)
};

static inline float clampf(float v, float lo, float hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}

static inline float smoothstep01(float t) {
  t = clampf(t, 0.0f, 1.0f);
  return t * t * (3.0f - 2.0f * t);
}

static inline float linearToSrgb(float c) {
  c = clampf(c, 0.0f, 1.0f);
  return (c <= 0.0031308f) ? (12.92f * c) : (1.055f * powf(c, 1.0f / 2.4f) - 0.055f);
}

static inline void oklabToLinearSrgb(float L, float a, float b, float* r, float* g, float* bl) {
  const float l_ = L + 0.3963377774f * a + 0.2158037573f * b;
  const float m_ = L - 0.1055613458f * a - 0.0638541728f * b;
  const float s_ = L - 0.0894841775f * a - 1.2914855480f * b;

  const float l = l_ * l_ * l_;
  const float m = m_ * m_ * m_;
  const float s = s_ * s_ * s_;

  *r  = +4.0767416621f * l - 3.3077115913f * m + 0.2309699292f * s;
  *g  = -1.2684380046f * l + 2.6097574011f * m - 0.3413193965f * s;
  *bl = -0.0041960863f * l - 0.7034186147f * m + 1.7076147010f * s;
}

static inline bool inSrgbGamut(float r, float g, float b) {
  const float eps = 0.0005f;
  return r >= -eps && r <= 1.0f + eps &&
         g >= -eps && g <= 1.0f + eps &&
         b >= -eps && b <= 1.0f + eps;
}

// Binary-search chroma reduction in OKLCH so hue & lightness never clip or shift
static inline RgbColor oklchToSrgbGamutMapped(float L, float C, float hDeg) {
  L = clampf(L, 0.04f, 0.96f);
  C = clampf(C, 0.0f, 0.32f);
  float wrappedH = fmodf(hDeg, 360.0f);
  if (wrappedH < 0.0f) wrappedH += 360.0f;

  const float rad = wrappedH * (3.14159265358979323846f / 180.0f);
  const float cosH = cosf(rad);
  const float sinH = sinf(rad);

  float r = 0.0f, g = 0.0f, b = 0.0f;
  float usedC = C;
  oklabToLinearSrgb(L, C * cosH, C * sinH, &r, &g, &b);

  if (!inSrgbGamut(r, g, b)) {
    float lo = 0.0f;
    float hi = C;
    for (int i = 0; i < 10; ++i) {
      const float mid = 0.5f * (lo + hi);
      float mr, mg, mb;
      oklabToLinearSrgb(L, mid * cosH, mid * sinH, &mr, &mg, &mb);
      if (inSrgbGamut(mr, mg, mb)) {
        lo = mid;
        r = mr; g = mg; b = mb;
      } else {
        hi = mid;
      }
    }
    usedC = lo;
    oklabToLinearSrgb(L, usedC * cosH, usedC * sinH, &r, &g, &b);
  }

  RgbColor out;
  out.r = (uint8_t)roundf(linearToSrgb(r) * 255.0f);
  out.g = (uint8_t)roundf(linearToSrgb(g) * 255.0f);
  out.b = (uint8_t)roundf(linearToSrgb(b) * 255.0f);
  out.l = L;
  out.c = usedC;
  out.h_deg = wrappedH;
  return out;
}

static inline RgbColor srgbToRgbColor(float rf, float gf, float bf, float approxL, float approxC, float approxH) {
  RgbColor out;
  out.r = (uint8_t)roundf(clampf(rf, 0.0f, 1.0f) * 255.0f);
  out.g = (uint8_t)roundf(clampf(gf, 0.0f, 1.0f) * 255.0f);
  out.b = (uint8_t)roundf(clampf(bf, 0.0f, 1.0f) * 255.0f);
  out.l = clampf(approxL, 0.0f, 1.0f);
  out.c = clampf(approxC, 0.0f, 0.32f);
  out.h_deg = fmodf(approxH + 360.0f, 360.0f);
  return out;
}

// Compute synchronized color from tared tilt components (tx, ty), vertical z (az), and kinetic energy [0..1]
static inline RgbColor mapImuToColor(
    float tx,
    float ty,
    float az,
    float kineticEnergy,
    uint8_t mode) {
  const float tiltMag = clampf(hypotf(tx, ty) / 0.92f, 0.0f, 1.0f);
  float angleDeg = atan2f(ty, tx) * (180.0f / 3.14159265358979323846f);
  if (angleDeg < 0.0f) angleDeg += 360.0f;
  const float zNorm = clampf((az + 1.0f) * 0.5f, 0.0f, 1.0f);
  const float kin = clampf(kineticEnergy, 0.0f, 1.0f);

  switch (mode % MODE_COUNT) {
    case MODE_OKLCH_DOME: {
      const float chroma = 0.018f + 0.235f * smoothstep01(tiltMag) + 0.045f * kin;
      const float lightness = clampf(0.36f + 0.48f * zNorm + 0.08f * kin, 0.24f, 0.90f);
      return oklchToSrgbGamutMapped(lightness, chroma, angleDeg);
    }

    case MODE_RGB_CUBE: {
      const float rx = smoothstep01(clampf((tx + 0.95f) / 1.90f, 0.0f, 1.0f));
      const float gy = smoothstep01(clampf((ty + 0.95f) / 1.90f, 0.0f, 1.0f));
      const float bz = smoothstep01(zNorm);
      const float boost = 0.08f * kin;
      const float rf = clampf(0.08f + 0.86f * rx + boost, 0.0f, 1.0f);
      const float gf = clampf(0.08f + 0.86f * gy + boost, 0.0f, 1.0f);
      const float bf = clampf(0.08f + 0.86f * bz + boost, 0.0f, 1.0f);
      const float lum = 0.2126f * rf + 0.7152f * gf + 0.0722f * bf;
      return srgbToRgbColor(rf, gf, bf, lum, 0.16f * tiltMag, angleDeg);
    }

    case MODE_THERMAL_KINETIC: {
      // Heat combines tilt elevation + kinetic motion energy along a blackbody magma curve
      const float heat = clampf(0.55f * tiltMag + 0.72f * kin + 0.18f * (1.0f - zNorm), 0.0f, 1.0f);
      // Hue sweeps from deep indigo (275 deg) -> crimson (12 deg) -> signal orange (38 deg) -> solar gold (88 deg)
      float hue;
      if (heat < 0.35f) {
        const float u = heat / 0.35f;
        hue = 275.0f + u * (372.0f - 275.0f);  // wraps through magenta/crimson
      } else {
        const float u = (heat - 0.35f) / 0.65f;
        hue = 12.0f + u * 78.0f;               // 12 -> 90 deg
      }
      const float lightness = 0.24f + 0.66f * powf(heat, 0.88f);
      const float chroma = (heat < 0.85f) ? (0.08f + 0.19f * sinf(heat * 3.14159f * 0.85f))
                                          : (0.22f * (1.0f - (heat - 0.85f) * 3.2f));
      return oklchToSrgbGamutMapped(lightness, clampf(chroma, 0.03f, 0.27f), hue);
    }

    case MODE_SPECTRAL_PRISM:
    default: {
      // High-sensitivity micro-tilt dispersion: +-32 deg sweeps full rainbow with roll/pitch cross-modulation
      const float fineHue = fmodf((tx * 210.0f) + (ty * 135.0f) + 200.0f + 720.0f, 360.0f);
      const float lightness = clampf(0.52f + 0.22f * ty + 0.10f * (zNorm - 0.5f) + 0.06f * kin, 0.34f, 0.86f);
      const float chroma = 0.15f + 0.11f * smoothstep01(clampf(tiltMag * 1.6f, 0.0f, 1.0f));
      return oklchToSrgbGamutMapped(lightness, chroma, fineHue);
    }
  }
}

static inline float relativeLuminance(uint8_t r, uint8_t g, uint8_t b) {
  auto chan = [](uint8_t v) -> float {
    const float s = (float)v / 255.0f;
    return (s <= 0.04045f) ? (s / 12.92f) : powf((s + 0.055f) / 1.055f, 2.4f);
  };
  return 0.2126f * chan(r) + 0.7152f * chan(g) + 0.0722f * chan(b);
}

static inline void formatHex(uint8_t r, uint8_t g, uint8_t b, char out[8]) {
  snprintf(out, 8, "#%02X%02X%02X", r, g, b);
}

static inline const char* modeShortName(uint8_t mode) {
  switch (mode % MODE_COUNT) {
    case MODE_OKLCH_DOME:      return "OKLCH";
    case MODE_RGB_CUBE:        return "RGB";
    case MODE_THERMAL_KINETIC: return "THERM";
    case MODE_SPECTRAL_PRISM:  return "PRISM";
    default:                   return "OKLCH";
  }
}

}  // namespace sticks3_color
