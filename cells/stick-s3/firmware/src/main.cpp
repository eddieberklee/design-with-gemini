#include <Arduino.h>
#include <M5Unified.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>
#include <string.h>
#include "color_math.h"

using namespace sticks3_color;

// BLE GATT UUIDs for wireless Web Bluetooth pairing ("StickS3-Color")
static constexpr const char* BLE_DEVICE_NAME   = "StickS3-Color";
static constexpr const char* BLE_SERVICE_UUID  = "4fafc201-1fb5-459e-8fcc-c5c9c331914b";
static constexpr const char* BLE_NOTIFY_UUID   = "beb5483e-36e1-4688-b7f5-ea07361b26a8";
static constexpr const char* BLE_COMMAND_UUID  = "beb5483e-36e1-4688-b7f5-ea07361b26a9";

static M5Canvas canvas(&M5.Display);
static BLEServer* gBleServer = nullptr;
static BLECharacteristic* gNotifyChar = nullptr;
static bool gBleConnected = false;

// Cross-core spinlock & staging ringbuffer for Bluedroid Core 0 -> Arduino loop() Core 1 handoff
static portMUX_TYPE gBleMux = portMUX_INITIALIZER_UNLOCKED;
static bool gBlePendingConnEvent = false;
static bool gBlePendingConnState = false;
static constexpr size_t BLE_CMD_QUEUE_CAP = 4;
static char gBleCmdQueue[BLE_CMD_QUEUE_CAP][192];
static uint8_t gBleCmdHead = 0;
static uint8_t gBleCmdCount = 0;

// Live sensor + instrument state (exclusively owned by Core 1 loop())
static float gSmoothAx = 0.0f;
static float gSmoothAy = 0.0f;
static float gSmoothAz = 1.0f;
static float gRawGx = 0.0f;
static float gRawGy = 0.0f;
static float gRawGz = 0.0f;

static float gTareX = 0.0f;
static float gTareY = 0.0f;
static float gKineticEnergy = 0.0f;

static uint8_t gMode = MODE_OKLCH_DOME;
static bool gHold = false;
static bool gBtnALongHandled = false;
static RgbColor gCurrentColor = {246, 246, 244, 0.96f, 0.01f, 0.0f};
static RgbColor gHeldColor = {246, 246, 244, 0.96f, 0.01f, 0.0f};

static uint32_t gSeq = 0;
static uint32_t gLastSerialMs = 0;
static uint32_t gLastBleMs = 0;
static uint32_t gLastUiMs = 0;
static uint32_t gBannerUntilMs = 0;
static int gCachedBatPct = -1;
static char gBannerText[20] = "";
static char gPendingEvent[12] = "";
static char gSerialCmdBuf[192];
static size_t gSerialCmdLen = 0;
static bool gSerialDiscardLine = false;

static void showBanner(const char* msg, uint32_t durationMs = 900) {
  snprintf(gBannerText, sizeof(gBannerText), "%s", msg);
  gBannerUntilMs = millis() + durationMs;
}

static void setPendingEvent(const char* ev) {
  if (!ev || !ev[0]) return;
  // Preserve "swatch" against lower-priority events in the same tick (unless unholding to "live")
  if (strcmp(gPendingEvent, "swatch") == 0 && strcmp(ev, "live") != 0) {
    return;
  }
  if (strcmp(ev, "pong") == 0 && gPendingEvent[0] != '\0') {
    return;
  }
  snprintf(gPendingEvent, sizeof(gPendingEvent), "%s", ev);
}

static void playClick(uint16_t freqHz, uint16_t durMs = 14) {
  if (M5.Speaker.isEnabled()) {
    M5.Speaker.setVolume(44);
    M5.Speaker.tone(freqHz, durMs);
  }
}

static void triggerTare() {
  gTareX = gSmoothAx;
  gTareY = gSmoothAy;
  setPendingEvent("tare");
  showBanner("ZERO TARED");
  playClick(1320, 22);
}

static void setHoldState(bool nextHold, bool fromHardware) {
  gHold = nextHold;
  if (gHold) {
    gHeldColor = gCurrentColor;
    setPendingEvent(fromHardware ? "swatch" : "hold");
    showBanner("COLOR HELD");
    playClick(1046, 16);
  } else {
    setPendingEvent("live");
    showBanner("LIVE IMU");
    playClick(784, 14);
  }
}

static void setModeState(uint8_t nextMode) {
  gMode = nextMode % MODE_COUNT;
  setPendingEvent("mode");
  char msg[20];
  snprintf(msg, sizeof(msg), "MODE %s", modeShortName(gMode));
  showBanner(msg);
  playClick(880 + gMode * 140, 14);
}

// Minimal command parser accepting JSON or plain-token commands from USB Serial or BLE
static void handleHostCommand(const char* line) {
  if (!line || !line[0]) return;

  if (strstr(line, "\"tare\"") || strcmp(line, "TARE") == 0) {
    triggerTare();
    return;
  }

  if (strstr(line, "\"hold\"")) {
    const char* hPos = strstr(line, "\"h\"");
    if (hPos) {
      const char* colon = strchr(hPos, ':');
      if (colon) {
        int val = atoi(colon + 1);
        if (strstr(colon + 1, "true")) val = 1;
        setHoldState(val != 0, false);
        return;
      }
    }
    setHoldState(!gHold, false);
    return;
  }

  if (strstr(line, "\"mode\"")) {
    const char* mPos = strstr(line, "\"m\"");
    if (mPos) {
      const char* colon = strchr(mPos, ':');
      if (colon) {
        int val = atoi(colon + 1);
        if (val >= 0 && val < 32) {
          setModeState((uint8_t)(val % MODE_COUNT));
          return;
        }
      }
    }
    setModeState((gMode + 1) % MODE_COUNT);
    return;
  }

  if (strstr(line, "\"ping\"") || strstr(line, "\"status\"")) {
    setPendingEvent("pong");
  }
}

class StickBleServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer* pServer) override {
    (void)pServer;
    portENTER_CRITICAL(&gBleMux);
    gBlePendingConnState = true;
    gBlePendingConnEvent = true;
    portEXIT_CRITICAL(&gBleMux);
  }
  void onDisconnect(BLEServer* pServer) override {
    portENTER_CRITICAL(&gBleMux);
    gBlePendingConnState = false;
    gBlePendingConnEvent = true;
    portEXIT_CRITICAL(&gBleMux);
    if (pServer) {
      pServer->startAdvertising();
    }
  }
};

class StickBleCmdCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic* pCharacteristic) override {
    if (!pCharacteristic) return;
    auto val = pCharacteristic->getValue();
    const size_t n = val.length();
    if (n == 0) return;
    const char* src = val.c_str();
    const size_t copyLen = n < (sizeof(gBleCmdQueue[0]) - 1) ? n : (sizeof(gBleCmdQueue[0]) - 1);

    portENTER_CRITICAL(&gBleMux);
    if (gBleCmdCount < BLE_CMD_QUEUE_CAP) {
      const uint8_t slot = (uint8_t)((gBleCmdHead + gBleCmdCount) % BLE_CMD_QUEUE_CAP);
      memcpy(gBleCmdQueue[slot], src, copyLen);
      gBleCmdQueue[slot][copyLen] = '\0';
      ++gBleCmdCount;
    } else {
      const uint8_t slot = (uint8_t)((gBleCmdHead + BLE_CMD_QUEUE_CAP - 1) % BLE_CMD_QUEUE_CAP);
      memcpy(gBleCmdQueue[slot], src, copyLen);
      gBleCmdQueue[slot][copyLen] = '\0';
    }
    portEXIT_CRITICAL(&gBleMux);
  }
};

static void drainBleEvents() {
  bool hasConnEvent = false;
  bool connState = false;
  portENTER_CRITICAL(&gBleMux);
  if (gBlePendingConnEvent) {
    hasConnEvent = true;
    connState = gBlePendingConnState;
    gBlePendingConnEvent = false;
  }
  portEXIT_CRITICAL(&gBleMux);

  if (hasConnEvent) {
    gBleConnected = connState;
    showBanner(connState ? "BLE LINKED" : "BLE IDLE");
  }

  char cmdBuf[192];
  while (true) {
    bool hasCmd = false;
    portENTER_CRITICAL(&gBleMux);
    if (gBleCmdCount > 0) {
      memcpy(cmdBuf, gBleCmdQueue[gBleCmdHead], sizeof(cmdBuf));
      gBleCmdHead = (uint8_t)((gBleCmdHead + 1) % BLE_CMD_QUEUE_CAP);
      --gBleCmdCount;
      hasCmd = true;
    }
    portEXIT_CRITICAL(&gBleMux);

    if (!hasCmd) break;
    char* cursor = cmdBuf;
    while (*cursor != '\0') {
      while (*cursor == '\r' || *cursor == '\n' || *cursor == ' ') ++cursor;
      if (*cursor == '\0') break;
      char* nl = cursor;
      while (*nl != '\0' && *nl != '\r' && *nl != '\n') ++nl;
      const char saved = *nl;
      *nl = '\0';
      handleHostCommand(cursor);
      cursor = (saved == '\0') ? nl : (nl + 1);
    }
  }
}

static void setupBle() {
  BLEDevice::init(BLE_DEVICE_NAME);
  BLEDevice::setMTU(247);
  gBleServer = BLEDevice::createServer();
  gBleServer->setCallbacks(new StickBleServerCallbacks());

  BLEService* service = gBleServer->createService(BLE_SERVICE_UUID);
  gNotifyChar = service->createCharacteristic(
      BLE_NOTIFY_UUID,
      BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_NOTIFY);
  gNotifyChar->addDescriptor(new BLE2902());

  BLECharacteristic* cmdChar = service->createCharacteristic(
      BLE_COMMAND_UUID,
      BLECharacteristic::PROPERTY_WRITE | BLECharacteristic::PROPERTY_WRITE_NR);
  cmdChar->setCallbacks(new StickBleCmdCallbacks());

  service->start();

  BLEAdvertising* adv = BLEDevice::getAdvertising();
  adv->addServiceUUID(BLE_SERVICE_UUID);
  adv->setScanResponse(true);
  adv->setMinPreferred(0x06);
  BLEDevice::startAdvertising();
}

static void pollSerialCommands() {
  while (Serial.available() > 0) {
    const int ch = Serial.read();
    if (ch < 0) break;
    if (ch == '\n' || ch == '\r') {
      if (gSerialDiscardLine) {
        gSerialDiscardLine = false;
        gSerialCmdLen = 0;
      } else if (gSerialCmdLen > 0) {
        gSerialCmdBuf[gSerialCmdLen] = '\0';
        handleHostCommand(gSerialCmdBuf);
        gSerialCmdLen = 0;
      }
    } else if (gSerialDiscardLine) {
      // Discard remainder of overflowed line until newline
    } else if (gSerialCmdLen + 1 < sizeof(gSerialCmdBuf)) {
      gSerialCmdBuf[gSerialCmdLen++] = (char)ch;
    } else {
      gSerialCmdLen = 0;
      gSerialDiscardLine = true;
    }
  }
}

static void drawAxisBar(int y, const char* label, float valG, uint16_t accentColor) {
  canvas.setTextColor(0xAD55u);  // crisp muted gray
  canvas.setCursor(8, y);
  canvas.printf("%s", label);

  const int trackX = 22;
  const int trackW = 64;
  const int trackH = 7;
  const int midX = trackX + trackW / 2;
  canvas.fillRoundRect(trackX, y + 1, trackW, trackH, 2, 0x2104u);
  canvas.drawFastVLine(midX, y, trackH + 2, 0x52AAu);

  const float norm = clampf(valG / 1.25f, -1.0f, 1.0f);
  const int barPx = (int)roundf(fabsf(norm) * (trackW / 2 - 2));
  if (barPx > 0) {
    const int bx = (norm >= 0.0f) ? midX : (midX - barPx);
    canvas.fillRect(bx, y + 2, barPx, trackH - 2, accentColor);
  }

  canvas.setTextColor(0xFFFFu);
  canvas.setCursor(90, y);
  canvas.printf("%+.2f", valG);
}

static void renderInstrumentScreen(const RgbColor& activeColor, float tx, float ty, int batPct) {
  const uint16_t bgDark = 0x1082u;     // #101010 instrument obsidian
  const uint16_t cardBorder = 0x39E7u; // subtle hairline
  const uint16_t swatch565 = canvas.color565(activeColor.r, activeColor.g, activeColor.b);
  // IEC 61966-2-1 crossover (0.1791) with pure black 0x0000u vs pure white 0xFFFFu guarantees >= 4.58:1 WCAG AA
  const bool lightSwatch = relativeLuminance(activeColor.r, activeColor.g, activeColor.b) > 0.1791f;
  const uint16_t swatchInk = lightSwatch ? 0x0000u : 0xFFFFu;

  canvas.fillScreen(bgDark);

  // 1. Top Swiss Header Bar (135 x 22)
  canvas.setTextSize(1);
  canvas.setTextColor(0xFFFFu);
  canvas.setCursor(7, 7);
  canvas.print("STICK S3");

  // Link / Hold badge
  const uint16_t pillBg = gHold ? 0xD980u : (gBleConnected ? 0x03EFu : 0x0451u);
  canvas.fillRoundRect(68, 4, 34, 14, 3, pillBg);
  canvas.setTextColor(0xFFFFu);
  canvas.setCursor(73, 7);
  canvas.print(gHold ? "HOLD" : (gBleConnected ? "BLE" : "USB"));

  // Battery %
  canvas.setTextColor(0xBDF7u);
  canvas.setCursor(106, 7);
  if (batPct >= 0 && batPct <= 100) {
    canvas.printf("%3d%%", batPct);
  } else {
    canvas.print("USB");
  }

  // 2. Hero Live Color Field + Gravity Dome Reticle (x=7, y=24, w=121, h=116)
  const int cardX = 7;
  const int cardY = 24;
  const int cardW = 121;
  const int cardH = 116;
  canvas.fillRoundRect(cardX, cardY, cardW, cardH, 8, swatch565);
  canvas.drawRoundRect(cardX, cardY, cardW, cardH, 8, cardBorder);

  // Mode badge top-left inside swatch
  canvas.setTextColor(swatchInk);
  canvas.setCursor(cardX + 7, cardY + 7);
  canvas.print(modeShortName(gMode));

  // Tilt reticle circle in middle of swatch
  const int cx = cardX + cardW / 2;
  const int cy = cardY + 56;
  const int domeR = 28;
  canvas.drawCircle(cx, cy, domeR, swatchInk);
  canvas.drawFastHLine(cx - 5, cy, 11, swatchInk);
  canvas.drawFastVLine(cx, cy - 5, 11, swatchInk);

  const int dotX = cx + (int)roundf(clampf(tx, -1.0f, 1.0f) * (domeR - 5));
  const int dotY = cy - (int)roundf(clampf(ty, -1.0f, 1.0f) * (domeR - 5));
  canvas.fillCircle(dotX, dotY, 5, swatchInk);

  // Hex readout bottom-left of swatch
  char hexBuf[8];
  formatHex(activeColor.r, activeColor.g, activeColor.b, hexBuf);
  canvas.setTextSize(1);
  canvas.setCursor(cardX + 8, cardY + cardH - 15);
  canvas.print(hexBuf);

  // OKLCH lightness readout bottom-right
  canvas.setCursor(cardX + cardW - 42, cardY + cardH - 15);
  canvas.printf("L%02d", (int)roundf(activeColor.l * 100.0f));

  // Transient action banner overlay if active (49.7-day wrap-safe signed comparison)
  if (gBannerText[0] != '\0') {
    if ((int32_t)(millis() - gBannerUntilMs) < 0) {
      canvas.fillRoundRect(cardX + 10, cy - 9, cardW - 20, 18, 4, 0x0000u);
      canvas.setTextColor(0xFFFFu);
      canvas.setCursor(cardX + 16, cy - 4);
      canvas.print(gBannerText);
    } else {
      gBannerText[0] = '\0';
    }
  }

  // 3. 3-Axis Accelerometer Telemetry Bars (y=148..194)
  drawAxisBar(148, "X", gSmoothAx, 0xF986u);  // coral-red X
  drawAxisBar(163, "Y", gSmoothAy, 0x2E8Bu);  // emerald Y
  drawAxisBar(178, "Z", gSmoothAz, 0x3C5Fu);  // cobalt Z

  // Kinetic Shake Meter thin bar
  canvas.setTextColor(0x8410u);
  canvas.setCursor(8, 195);
  canvas.print("KIN");
  canvas.fillRoundRect(30, 196, 96, 5, 2, 0x2104u);
  const int kinW = (int)roundf(clampf(gKineticEnergy, 0.0f, 1.0f) * 94.0f);
  if (kinW > 0) {
    canvas.fillRect(31, 197, kinW, 3, 0xFD20u);
  }

  // 4. Bottom Hardware Key Legend (y=212..234)
  canvas.drawFastHLine(7, 209, 121, 0x2945u);
  canvas.setTextColor(0xCE79u);
  canvas.setCursor(7, 215);
  canvas.print("[A] HOLD / TARE");
  canvas.setCursor(7, 227);
  canvas.print("[B] CYCLE MODE");

  canvas.pushSprite(0, 0);
}

void setup() {
  Serial.begin(115200);

  auto cfg = M5.config();
  cfg.serial_baudrate = 115200;
  cfg.internal_imu = true;
  cfg.internal_spk = true;
  cfg.internal_mic = false;
  M5.begin(cfg);

  M5.Display.setRotation(0);  // 135 x 240 portrait (natural wand grip, KEY1 under thumb)
  M5.Display.setBrightness(215);

  canvas.setColorDepth(16);
  canvas.createSprite(135, 240);
  canvas.setTextWrap(false);

  setupBle();
  showBanner("STICK S3 READY", 1200);
}

void loop() {
  M5.update();
  drainBleEvents();
  pollSerialCommands();

  // Button A (KEY1, GPIO 11): Short press = Freeze/Swatch, Long press (600ms) = Zero Tare
  if (M5.BtnA.pressedFor(600) && !gBtnALongHandled) {
    gBtnALongHandled = true;
    triggerTare();
  }
  if (M5.BtnA.wasReleased()) {
    if (!gBtnALongHandled) {
      setHoldState(!gHold, true);
    }
    gBtnALongHandled = false;
  }

  // Button B (KEY2, GPIO 12): Cycle Color Mapping Mode
  if (M5.BtnB.wasPressed()) {
    setModeState((gMode + 1) % MODE_COUNT);
  }

  // Sample 6-axis BMI270 IMU with strict NaN/Inf guards before EMA update
  if (M5.Imu.update()) {
    const auto imu = M5.Imu.getImuData();
    const float alpha = 0.24f;  // crisp low-latency EMA filter
    if (isfinite(imu.accel.x) && isfinite(imu.accel.y) && isfinite(imu.accel.z)) {
      // Negate proper-acceleration X & Y reaction forces so physical tilt-right = +X (+tx) and tilt-up/forward = +Y (+ty)
      const float tiltRightAx = -imu.accel.x;
      const float tiltUpAy = -imu.accel.y;
      gSmoothAx += alpha * (tiltRightAx - gSmoothAx);
      gSmoothAy += alpha * (tiltUpAy - gSmoothAy);
      gSmoothAz += alpha * (imu.accel.z - gSmoothAz);
    }
    if (isfinite(imu.gyro.x) && isfinite(imu.gyro.y) && isfinite(imu.gyro.z)) {
      gRawGx = imu.gyro.x;
      gRawGy = imu.gyro.y;
      gRawGz = imu.gyro.z;
    }
    if (!isfinite(gSmoothAx)) gSmoothAx = 0.0f;
    if (!isfinite(gSmoothAy)) gSmoothAy = 0.0f;
    if (!isfinite(gSmoothAz)) gSmoothAz = 1.0f;

    const float axSample = isfinite(imu.accel.x) ? -imu.accel.x : gSmoothAx;
    const float aySample = isfinite(imu.accel.y) ? -imu.accel.y : gSmoothAy;
    const float azSample = isfinite(imu.accel.z) ? imu.accel.z : gSmoothAz;
    const float magG = hypotf(hypotf(axSample, aySample), azSample);
    const float linShock = fabsf(magG - 1.0f);
    const float gyroNorm = hypotf(hypotf(gRawGx, gRawGy), gRawGz) / 420.0f;
    const float instantKin = clampf(linShock * 1.35f + gyroNorm * 0.35f, 0.0f, 1.0f);
    if (instantKin > gKineticEnergy) {
      gKineticEnergy = instantKin;
    } else {
      gKineticEnergy *= 0.92f;  // smooth decay
    }
  }

  const float tx = clampf(gSmoothAx - gTareX, -1.2f, 1.2f);
  const float ty = clampf(gSmoothAy - gTareY, -1.2f, 1.2f);
  gCurrentColor = mapImuToColor(tx, ty, gSmoothAz, gKineticEnergy, gMode);
  const RgbColor& displayed = gHold ? gHeldColor : gCurrentColor;

  const uint32_t now = millis();
  const bool hasEvent = (gPendingEvent[0] != '\0');
  const bool emitSerialNow = hasEvent || (now - gLastSerialMs >= 20);
  const bool renderUiNow = (now - gLastUiMs >= 20);

  if (emitSerialNow || renderUiNow) {
    gCachedBatPct = M5.Power.getBatteryLevel();
  }

  // Emit 50 Hz JSON line telemetry over USB-Serial/JTAG (or immediately on button event)
  if (emitSerialNow) {
    gLastSerialMs = now;
    ++gSeq;

    const float rollDeg  = atan2f(tx, hypotf(ty, gSmoothAz)) * (180.0f / 3.14159265f);
    const float pitchDeg = atan2f(ty, hypotf(tx, gSmoothAz)) * (180.0f / 3.14159265f);
    const int batPct = gCachedBatPct;
    char hexBuf[8];
    formatHex(displayed.r, displayed.g, displayed.b, hexBuf);

    char jsonLine[256];
    const int len = snprintf(
        jsonLine,
        sizeof(jsonLine),
        "{\"t\":\"s3\",\"seq\":%lu,\"ax\":%.3f,\"ay\":%.3f,\"az\":%.3f,"
        "\"tx\":%.3f,\"ty\":%.3f,\"gx\":%.1f,\"gy\":%.1f,\"gz\":%.1f,"
        "\"r\":%.1f,\"p\":%.1f,\"kin\":%.3f,\"m\":%u,\"h\":%u,"
        "\"hex\":\"%s\",\"bat\":%d,\"ev\":\"%s\"}\n",
        (unsigned long)gSeq,
        gSmoothAx, gSmoothAy, gSmoothAz,
        tx, ty,
        gRawGx, gRawGy, gRawGz,
        rollDeg, pitchDeg,
        gKineticEnergy,
        (unsigned)gMode,
        gHold ? 1u : 0u,
        hexBuf,
        batPct,
        gPendingEvent);

    if (len > 0) {
      size_t sendLen = (size_t)len < (sizeof(jsonLine) - 1) ? (size_t)len : (sizeof(jsonLine) - 1);
      if (jsonLine[sendLen - 1] != '\n') {
        jsonLine[sendLen - 1] = '\n';
        jsonLine[sendLen] = '\0';
      }
      Serial.write((const uint8_t*)jsonLine, sendLen);

      // Push over BLE GATT Notify at ~30 Hz (newline-delimited; chunks cleanly if peer MTU < 247)
      if (gBleConnected && gNotifyChar && (hasEvent || (now - gLastBleMs >= 33))) {
        gLastBleMs = now;
        size_t peerMax = 244;
        if (gBleServer) {
          const uint16_t mtu = gBleServer->getPeerMTU(gBleServer->getConnId());
          if (mtu > 3) {
            peerMax = (size_t)(mtu - 3);
          }
        }
        if (peerMax < 20) peerMax = 20;
        size_t offset = 0;
        while (offset < sendLen) {
          const size_t chunkLen = (sendLen - offset) < peerMax ? (sendLen - offset) : peerMax;
          gNotifyChar->setValue((uint8_t*)(jsonLine + offset), chunkLen);
          gNotifyChar->notify();
          offset += chunkLen;
        }
      }
    }

    gPendingEvent[0] = '\0';
  }

  // Refresh 135x240 LCD sprite at ~50 FPS
  if (renderUiNow) {
    gLastUiMs = now;
    renderInstrumentScreen(displayed, tx, ty, gCachedBatPct);
  }

  delay(2);
}
