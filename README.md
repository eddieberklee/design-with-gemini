# design-with-gemini

Interactive 3×3 grid of focused Gemini capability prototypes. Open [`index.html`](index.html) directly in a browser or serve it locally (`python3 -m http.server 8000`).

## Cells

| # | Prototype | Directory & Docs |
| :--- | :--- | :--- |
| **01** | **Gemini Decisions API** (`gemini-decision-1`) — calibrated `noul`, `choice`, and `score` single-pass zero-output-token instrument with multimodal image+text specimens, A/B perturbation, live schema builder, and wire JSON/cURL inspector | [`cells/decisions/`](cells/decisions/) · [`NOTES.md`](cells/decisions/NOTES.md) |
| **02** | **Voice Prosody Button Sizer** (`gemini-2.5-flash` native audio) — maps vocal stress, elongation, and tone directly to a centered button's scale with live waveform capture, ghost-outline delta comparison, and instant prosody demo chips | [`cells/prosody/`](cells/prosody/) · [`NOTES.md`](cells/prosody/NOTES.md) |
| **03** | **iPhone Motion Grid Controller** — scannable QR code pairing to a standalone iPhone accelerometer web app; rotate/tilt, lift up/down, or pull/push the phone to smoothly resize every grid cell (`Reflow` or `Lock 3×3`) via local HTTPS bridge or zero-server MQTT WSS | [`cells/motion/`](cells/motion/) · [`NOTES.md`](cells/motion/NOTES.md) |

## License

Released under the [MIT No Attribution (`MIT-0`)](LICENSE) license — free to use, copy, modify, build on, redistribute, and use commercially in any way, with no attribution required.
