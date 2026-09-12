# viser-audio

Audio for [viser](https://github.com/nerfstudio-project/viser) scenes and timeline
players: positional clips, playback control, retained streaming, and client-local
timeline synchronization. Installs alongside viser.

## Install

```bash
pip install viser-audio
```

## Live scenes

```python
import numpy as np
import viser
import viser_audio

server = viser.ViserServer()
audio = viser_audio.AudioApi(server)
time = np.arange(44100) / 44100
clip = audio.add(
    "/speaker",
    0.3 * np.sin(2 * np.pi * 220 * time),
    44100,
    loop=True,
    positional=True,
)
clip.play()
clip.position = (1.0, 0.0, 0.0)
clip.volume = 0.5
server.sleep_forever()
```

- `AudioApi(server)` installs the runtime once per server.
- `add(name, samples, sample_rate=44100, *, volume=1, loop=False,
  positional=False, playback_rate=1, start_time=None, wxyz, position)` creates
  a clip and returns an `AudioHandle`. Adding the same name replaces it.
- `play(offset=None)` starts or resumes; an explicit offset seeks in seconds.
  `pause()` retains an explicit command offset for replay to new tabs.
- `samples` reads back a copy of normalized float32 audio. Assigning replaces
  the samples and restarts live clips; timeline tracks retain their anchor.
- `append(samples)` extends the clip and resumes a stream that ran out of data.
  It retains all samples for replay; it is not an unbounded streaming sink.
- `volume`, `loop`, `positional`, `playback_rate`, `position`, and `wxyz` are
  writable. `duration`, `sample_rate`, `start_time`, and `name` are readable.
- `remove()` releases the clip and its node. Removed or replaced handles reject
  further writes.

Samples have shape `(N,)` or `(N, C)`, with up to 32 channels. Integer PCM is
normalized around zero; floating-point input must be finite. Empty clips can
receive samples later. Rates must be positive; playback speed also changes pitch.
Browser-supported sample rates are required when creating audio buffers.

Each new tab receives the current clip state and latest playback command. Live
commands do not synchronize browser wall clocks. Browsers require a gesture to
start audio; an **Enable audio** button appears when playback is blocked.

## Timeline players and recordings

Use a callback to record messages without creating a live server. The callback
can reject edits outside a recording context; handle state changes only after it
accepts the message. Pass `scene=` if the recording also owns positional nodes.

```python
from viser_audio.messages import AudioMessage

recording: list[AudioMessage] = []
audio = viser_audio.AudioApi(recording.append)
track = audio.add("/speech", samples, 44100, start_time=step / fps)
track.volume = 0.8
track.append(more_samples)
```

`start_time` is in timeline seconds. These tracks are controlled by the browser
clock, so `play()` and `pause()` reject direct control.

The injected runtime exposes its engine at `window.__VISER_AUDIO__.engine`:

```javascript
const engine = window.__VISER_AUDIO__.engine;
engine.setTransport(() => ({
  position: player.currentTime, // seconds
  playing: player.playing,
  rate: player.speed,          // positive, e.g. 0.5, 1, 2
}));

// Each checkpoint contains complete AudioAddMessage payloads.
engine.loadCheckpoint(checkpointTracks);
for (const message of subsequentEvents) engine.handle(message);
engine.sync(); // immediately apply a seek or other clock change
```

The engine handles future starts, pause/resume, scrubbing, speed changes, track
loops, and autoplay recovery. Timeline looping is a seek performed by the player.
Use `reset()` to clear tracks and `dispose()` when the player is destroyed.
Different engines and tabs have independent clocks and resources.

`AudioState.apply(message)` folds recorded events; `snapshot()` returns complete
tracks for checkpoints, and `copy()` shares immutable sample storage. Decode
stored payloads with `viser_audio.messages.from_payload()` after resolving binary
placeholders.

`message.as_payload(binary_buffers)` returns the public data protocol for custom
recording storage. Without the buffer argument, samples are memoryviews; with it,
arrays use viser's binary placeholders. The player must resolve placeholders
before calling `handle()`. The engine accepts `Float32Array`, `Uint8Array`, and
`ArrayBuffer` sample data, all containing little-endian float32 PCM.

`message.as_serializable_dict()` returns a viser JavaScript command.
`viser_audio.runtime_source()` supplies the runtime for live or exported players.
A standalone ES module, `viser_audio/engine.js` in the installed package, exports
`AudioEngine`; TypeScript sources and protocol types ship under `viser_audio/client`.
It needs no viser viewer for non-positional audio.

Run `uv run python examples/03_timeline.py` to create a self-contained HTML player.
Exported players must bind their playback clock explicitly. No DOM controls are
scraped, and no older protocol or viser4d compatibility adapter is provided.
See [the design and viser4d feature comparison](docs/design.md) for the integration
contract and remaining constraints.

## Development

```bash
uv sync --group dev
uv run ruff check .
uv run ruff format --check .
uv run pyright
uv run pytest tests --ignore=tests/e2e
uv run playwright install chromium
uv run pytest tests/e2e

npm --prefix src/viser_audio/client ci
npm --prefix src/viser_audio/client run typecheck
npm --prefix src/viser_audio/client run build
```

Commit both generated bundles, `runtime.js` and `engine.js`. CI checks that they
match the TypeScript sources. Live delivery uses viser's JavaScript command with
base64 PCM; custom recording players can use binary payloads directly.
