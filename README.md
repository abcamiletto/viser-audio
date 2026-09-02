# viser-audio

Audio for [viser](https://github.com/nerfstudio-project/viser) scenes: play
clips from Python, spatialize them from a scene node, and stream samples to the
browser while they play.

viser-audio installs *alongside* viser -- it is not a fork. It injects a small
Web Audio runtime into viser's stock client, so nothing else about your setup
changes.

## Install

```bash
pip install viser-audio
```

## Usage

```python
import numpy as np
import viser
import viser_audio

server = viser.ViserServer()
audio = viser_audio.AudioApi(server)

sample_rate = 44100
t = np.arange(sample_rate) / sample_rate
clip = audio.add(
    "/speaker",
    0.3 * np.sin(2 * np.pi * 220 * t),
    sample_rate,
    loop=True,
    positional=True,
)
clip.play()

clip.position = (1.0, 0.0, 0.0)  # The sound follows the scene node.
clip.volume = 0.5
server.sleep_forever()
```

## API

- `AudioApi(server)` -- installs the browser runtime; idempotent per server.
- `AudioApi.add(name, samples, sample_rate=44100, *, volume, loop, positional,
  wxyz, position) -> AudioHandle` -- adds a clip on the scene node `name`.
  Samples are `(N,)` mono or `(N, C)`; floats in [-1, 1], integers normalized.
- `AudioHandle.play(offset=None)` / `.pause()` -- `offset` seeks; `None` resumes
  (a finished clip restarts from the beginning).
- `AudioHandle.append(chunk)` -- extends the clip without interrupting
  playback, for streaming.
- `AudioHandle.samples` / `.duration` / `.volume` / `.loop` / `.positional` /
  `.position` / `.wxyz` -- read and write; assigning `samples` replaces the
  clip, toggling `positional` preserves the playhead.
- `AudioHandle.remove()` -- removes the clip and its scene node.

Audio state is replayed to clients that join later, so a clip left playing also
starts for new browser tabs.

## Autoplay

Browsers refuse to start audio before the page sees a user gesture. If a clip is
asked to play first, the client shows an "Audio is waiting" notification and
playback starts on the first click or keypress.

## Development

```bash
uv sync --group dev
uv run ruff check . && uv run ruff format --check . && uv run pyright
uv run pytest tests --ignore=tests/e2e

# End-to-end tests drive a real browser.
uv run playwright install chromium
uv run pytest tests/e2e
```

The browser runtime is TypeScript in `src/viser_audio/client`, bundled by
esbuild into the checked-in `src/viser_audio/runtime.js`:

```bash
cd src/viser_audio/client
npm ci
npm run typecheck
npm run build   # rewrites ../runtime.js; commit it
```
