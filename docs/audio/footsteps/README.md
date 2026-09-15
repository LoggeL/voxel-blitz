# Material footsteps

Implemented locally on 2026-09-16. The game now plays generated Foley for the
supporting floor material, with three takes per surface. The previous optional
generic footstep file was absent, so every footfall used the same synthesized
thud and hiss.

## Selection and waveform review

36 ElevenLabs Sound Effects candidates generated, 21 selected, 15 rejected,
240 credits reported by the API. Every candidate waveform and spectrogram was
visually inspected. Rejected recordings included an ascending high-frequency
tone, infrasonic drift, long scrapes and poorly defined attacks. Longer sources
were cut to one contact, excluding later footfalls.

| Surface | Game materials | Final waveforms and spectrograms |
| --- | --- | --- |
| Stone | Concrete, stone, paving, tile, glass and other hard solids | [3 takes](stone-waveforms.png) |
| Wood | Boards, logs, wooden crates, furniture and siding | [3 takes](wood-waveforms.png) |
| Metal | Steel, rusty metal, vehicle panels, iron and metal blocks | [3 takes](metal-waveforms.png) |
| Grass | Grass, earth, leaves and clay | [3 takes](grass-waveforms.png) |
| Gravel | Gravel | [3 takes](gravel-waveforms.png) |
| Sand | Sand | [3 takes](sand-waveforms.png) |
| Cloth | Carpet-like wool and soft cloud blocks | [3 takes](cloth-waveforms.png) |

The final decoded Opus assets are mono at 48 kHz and total 45,264 bytes:

- Duration: 90 to 270 ms.
- First signal above 2% of peak: 0 to 5.1 ms.
- Strongest 5 ms RMS window: 5 to 60 ms after onset; sand has a softer attack.
- Maximum peak: 0.558, approximately -5.1 dBFS. No clipped samples.
- Final 20 ms RMS stays below 0.004. Short fades remove cut-edge clicks.

Processing removes infrasonic drift with an 85 Hz high-pass and limits the upper
band to 8.5 kHz. Levels use the strongest 40 ms RMS window with a peak ceiling;
soft materials retain lower targets. One concrete take also has a gentle decay
on its sustained scuff. No synthesized layer is added to a loaded recording.

[Recipes](recipes.json) specify every source, exact cut and selection reason.
[Source manifest](../../../public/assets/audio/elevenlabs-footstep-sources.json)
records prompts, API receipts, source/output hashes and decoded measurements.
Raw MP3/WAV files, rejected-candidate plots and full browser traces remain in
`.artifacts/elevenlabs-footsteps-2026-09-16/`.

This is waveform, spectrum and runtime verification. A subjective listening
approval is not asserted. The local `/audio-preview.html#footsteps` page provides
all 21 isolated recordings, eight-step walk/sprint sequences and positional
remote steps for listening.

## Playback

The support probe reads live voxel data beneath the center and corners of the
player footprint, matching the grounded probe. It handles ledges and ignores
fluids and pass-through decorative blocks. Terrain changes take effect on the
next footfall. Unknown support falls back to the stone bank.

Each persistent avatar has independent take selection. Consecutive takes do not
repeat, pitch varies by at most 2.5%, and gain varies by at most 4%. New network
snapshot objects do not reset variation. Own steps alternate gently left/right;
remote steps keep the world panner and distance attenuation. Existing gait,
stance, swimming, speed and bot-hearing rules are unchanged. Missing samples
retain the procedural fallback.

## Validation

- `npm run audio:test`: all audio suites pass, including support-material,
  ledge, terrain mutation, sample routing, per-avatar variation and silence tests.
- `npm run audio:audit`: all shipped asset checks pass.
- Native browser mix: **363/363 checks passed** through the production audio
  facade. Each surface plays nine sprint footfalls with all three takes, no
  consecutive repetition, complete sample tails and no clipping. Remote metal
  footsteps attenuate from 4 m to 35 m. See [browser measurements](browser-metrics.json).
- Preview: 49/49 featured recordings decode, including all 21 new footsteps.
  Live sprint playback starts without browser errors.
- All final audio hashes match the reviewed manifest.
- Before publication, the isolated audio commit passed `audio:test` and
  `audio:audit` again. The broader `atlastest` reports one Reactor map byte
  fingerprint failure, reproduced on unchanged parent `f7378b5`; it is outside
  this audio change.

The broader browser audit also needed a correction to an existing assertion:
the nearby explosion includes a listener-relative ringing voice in addition to
33 positional voices. Its cap check now counts positional voices explicitly;
the required 17 same-frame evictions and cap of 16 remain unchanged.

The measurements above describe local validation before publication. They do
not assert production deployment or subjective listening acceptance.

## Rebuild

Use Python with numpy, scipy and matplotlib, plus ffmpeg/ffprobe. Retain the raw
sources and API receipts before rebuilding:

```sh
python3 tools/prepare-footstep-audio.py analyze
python3 tools/prepare-footstep-audio.py process
```

`tools/generate-footstep-audio.py` defaults to a dry run. `--generate` makes paid
requests through the existing Keychain-backed client. Completed requests are
resumed by hash; uncertain or failed requests are not retried automatically.
