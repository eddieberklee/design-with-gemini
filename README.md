# design-with-gemini

Interactive 3×3 grid of focused Gemini capability prototypes. Open [`index.html`](index.html) directly in a browser or serve it locally (`python3 -m http.server 8000`).

## Cells

| # | Prototype | Directory & Docs |
| :--- | :--- | :--- |
| **01 (Row 1)** | **Gemini Decisions API 3-Cell Triptych** (`gemini-decision-1`) — linked `1 · INPUT → 2 · CHECK & ROUTE → 3 · RUBRIC & PROOF` horizontal strip showcasing single-pass, zero-output-token `noul` (Yes/No), `choice` (Category), and `score` (Rubric) decisions over multimodal image+text specimens, plus full Workbench studio & JSON/cURL inspector | [`cells/decisions/`](cells/decisions/) · [`NOTES.md`](cells/decisions/NOTES.md) |
| **02** | **Voice Prosody Button Sizer** (`gemini-3.8-flash` native audio) — maps vocal stress, elongation, and tone directly to a centered button's scale with live waveform capture, ghost-outline delta comparison, and instant prosody demo chips | [`cells/prosody/`](cells/prosody/) · [`NOTES.md`](cells/prosody/NOTES.md) |
| **03** | **iPhone Motion Grid Controller** — scannable QR code pairing to a standalone iPhone accelerometer web app; rotate/tilt, lift up/down, or pull/push the phone to smoothly resize every grid cell (`Reflow` or locked columns) via local HTTPS bridge or zero-server MQTT WSS | [`cells/motion/`](cells/motion/) · [`NOTES.md`](cells/motion/NOTES.md) |
| **04** | **Google Gemini API Matrix** — tap-to-open secondary grid probing 18 Gemini API endpoints (Models, Generate, SSE Stream, Interactions, Decisions, Search Grounding, Live WebSocket, Speech TTS with playback, Audio Input, Lyria, Embeddings, Count Tokens, Image Gen, Veo, Files, Caching, Batch, OpenAI Compat) with dynamic model discovery and shared local key store | [`cells/api-matrix/`](cells/api-matrix/) · [`NOTES.md`](cells/api-matrix/NOTES.md) |
| **05** | **Left Grille & Hardware Acoustic Lab (7-Cell Secondary Grid)** — tap-to-replace secondary `.grid` housing (1) Left-Grille Swipe Sonar, (2) 4-Zone Chassis Tap Localization, (3) Nail Scratch vs Soft Finger-Pad Tap (*TapSense*), (4) `18–20.5 kHz` Stereo FMCW Chirp Hand-Wave & Push-Pull Radar, (5) Grille Breath-Puff Anemometer, (6) Dual-Mode Lid Angle (`18.2–20.4 kHz` screen-bounce sonar + `IOHIDManager` `0x05AC:0x8104` hardware sensor bridge), and (7) iPhone Spinning Dial Control (QR/WSS/Wi-Fi/BLE rotary encoder) | [`cells/left-grille/`](cells/left-grille/) · [`NOTES.md`](cells/left-grille/NOTES.md) |
| **06** | **16" MacBook Pro Right Grille Swipe Lab** — maps the `Mac16,5` 3-MEMS upper-left microphone array (`~`/`tab`, `0` mics in notch or right grille) and differentiates `↑ UP` vs `↓ DOWN` swipes on the silent right speaker grille (`31.0–32.4 cm`, `Δ4.5%` path) via coherent hard-right `19.0 kHz` tweeter homodyne sonar (MTI Doppler + zero-phase real occlusion timing), unibody stiffness tilt, 31-blade kinetic louver scrubber, and 4-stroke Cholesky Shrinkage Fisher LDA (`d'_OOF`) | [`cells/grille-swipe/`](cells/grille-swipe/) · [`NOTES.md`](cells/grille-swipe/NOTES.md) |
| **07** | **M5StickS3 Accelerometer Color Studio** (`ESP32-S3-PICO-1` · `BMI270` 6-axis IMU) — flashes native C++ `M5Unified` firmware onto an M5StickS3 (`135×240` IPS LCD + `KEY1` Freeze/Tare + `KEY2` Mode) and streams 50 Hz accelerometer + kinetic telemetry over zero-click local USB bridge, Web Serial, or wireless BLE to flood the grid cell in synchronized gamut-mapped OKLCH, RGB Cube, Thermal Kinetic, or Spectral Prism pigment | [`cells/stick-s3/`](cells/stick-s3/) · [`NOTES.md`](cells/stick-s3/NOTES.md) |
| **08** | **Webcam Hand & Spatial Gesture Cursor** (`@mediapipe/tasks-vision@1.2.3`) — raise an open palm (`200 ms` dwell) to engage a zero-GC spatial cursor across the main grid or its 9-cell `#hand-gesture` Studio (`1€` 2D filter oscilloscope, zero-slip metacarpal pinch click/drag, unwrapped wrist-twist rotary dial, 2-hand zoom/steer, vertical pinch-scrub fader, and Two-Finger `V-Scroll` momentum tape) | [`cells/hand-gesture/`](cells/hand-gesture/) · [`NOTES.md`](cells/hand-gesture/NOTES.md) |
| **09** | **Freehand Drawing Sketchpad** — zero-chrome full-bleed drawing sheet for laptop trackpad, desktop cursor, phone touch, and stylus with $C^1$ quadratic midpoint ink splines, tap-to-dot, lossless HiDPI vector replay across `MotionGrid` resizes, and strictly one floating `Clear` button | [`cells/draw/`](cells/draw/) · [`NOTES.md`](cells/draw/NOTES.md) |
| **10** | **Gemini Image Gen** (`gemini-3-pro-image-preview` / `gemini-3.1-flash-image-preview`) — native Gemini `generateContent` image generation playground with dynamic model discovery, aspect-ratio control, one-click presets, shared local key store, abortable requests, download, and full-resolution lightbox | [`cells/image-gen/`](cells/image-gen/) · [`NOTES.md`](cells/image-gen/NOTES.md) |
| **11** | **Image → 3D (4× Arena)** — drop any image to race 4 Gemini models in parallel reconstructing it as a 3D primitive mesh, rendered side by side in 4 interactive 3D viewers with synced orbit, model labels, full-width 4-Up studio, and `.OBJ` export | [`cells/image-to-3d/`](cells/image-to-3d/) · [`NOTES.md`](cells/image-to-3d/NOTES.md) |

## Verify

```sh
bash scripts/check.sh
```

One command, no dependencies beyond Node 22 and `timeout`. It checks that every script and stylesheet a page references exists (and that no cell script or stylesheet is left unwired), that every `.js` / `.mjs` file parses, that the `index.html` scripts parse as **one** program (they are classic `<script defer>` files sharing one global scope, so a duplicate top-level `const` / `let` / `class` across cells is a load-time error no per-file check can see), and that every Node suite under `cells/*/` passes. Exit `0` means all four hold.

It does not open a browser. Interaction, layout, and hardware paths (microphone, camera, phone sensors, Web Serial / BLE, a Gemini API key) need a manual pass in the page; each cell's `NOTES.md` lists what to exercise.

## License

Released under the [MIT No Attribution (`MIT-0`)](LICENSE) license — free to use, copy, modify, build on, redistribute, and use commercially in any way, with no attribution required.
