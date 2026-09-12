# Audio engine and recording interface

The Python API emits one public protocol, `viser_audio.messages`. The browser
engine consumes it without knowing about a Python server, React, or a recording
format. Live viser scenes and timeline players use the same engine.

## Live delivery

Viser 1.1 has a JavaScript command but no extension message handler. Audio messages
serialize as `RunJavascriptMessage` commands calling the installed runtime.
PCM is little-endian float32 encoded as base64 inside JSON. This increases sample
payload size by one third and adds decoding work, but avoids patching viser's
message queue or intercepting console output. Commands execute in scene order,
including the first batch received by a new tab.

The adapter in `_viser.py` owns the private Python dependencies: message lifecycle
metadata, the websocket buffer, its recording lock, and frame removal state.
`client/viser.ts` discovers the camera and scene matrices through React because
viser has no public equivalent. That discovery is needed only for positional
sound. Discovery failure raises an error; it does not silently disable sound.

Audio create/remove messages coalesce by name. Re-creation drops old updates, and
sample replacement drops old appends. These operations share viser's recording
lock so recording and live replay observe the same sequence. Recording callbacks
receive every event and own storage. `AudioState` folds those events into complete
checkpoint tracks.

## State and resource ownership

Sample input is copied into immutable float32 chunks. Appending retains one new
chunk; reading `samples` produces a copy. Failed recording callbacks leave handle
state unchanged. Removed and replaced handles reject further writes.

The browser owns one source, gain, and optional panner per clip. An append copies
channel data into a longer buffer and replaces the source at the current audio
clock position. There are no deferred sources left behind by rapid appends.
Pause, removal, checkpoint replacement, and disposal stop owned sources.

Append retains the entire recording for replay. Browser buffer replacement is
linear in accumulated samples, so appending many small chunks has quadratic total
copying cost. This API is for retained clips, not an unbounded low-latency audio
stream. Python accumulation avoids that repeated copying.

Live play/pause commands carry an explicit offset computed from the server's
monotonic clock. Each browser starts at that command offset; this is not a shared
wall-clock synchronization guarantee. Use an external transport for scene/audio
synchronization. A transport's position is in seconds and its rate must be
positive. Speed changes alter pitch; time stretching is not implemented.

## Timeline players

A track with `start_time` belongs to the external clock. Its offset is
`(transport.position - start_time) * playback_rate`. The engine schedules future
starts, stops at the end, and resynchronizes after seeks, rate changes, or autoplay
unlock. `sync()` applies an explicit seek immediately. Normal animation frames
correct drift only beyond 80 ms so they do not continuously restart sound.

`loadCheckpoint()` replaces the complete track set, releasing removed tracks.
The player then applies subsequent messages with `handle()`. Replacing samples
or appending retains the track's timeline anchor. Each engine has its own context,
track set, and transport, so players and tabs are independent.

Recording serialization includes the runtime and audio commands. Exported players
must bind their clock with `setTransport()`; the engine does not scrape player
controls or infer playback from DOM changes. The standalone HTML example shows
this contract without a websocket or a viser viewer.

## Comparison with viser4d

Reviewed the published [viser4d 0.19.0 wheel](https://pypi.org/pypi/viser4d/0.19.0/json)
and its `_audio.py`, `_protocol.py`, `_state.py`, and browser audio engine. The
comparison concerns audio; scene recording, chunk storage, playback controls, and
3D export remain the timeline player's responsibility.

| viser4d audio responsibility | Shared API |
| --- | --- |
| Record add, volume, waveform, append, remove | `AudioApi(callback)` and `AudioHandle` |
| Normalize mono/stereo integer or float samples | `AudioApi.add()`; also supports up to 32 channels |
| Anchor a track at its recorded step | `start_time=step / fps` |
| Fold and restore audio at a chunk boundary | `AudioState` and `engine.loadCheckpoint(tracks)` |
| Fold updates after that boundary | Apply `AudioMessage` payloads with `engine.handle()` |
| Follow client-local play, pause, scrub, speed, loop | `engine.setTransport(clock)` and `engine.sync()` |
| Play without a live server | `engine.js` or the injected runtime in standalone HTML |
| Carry binary samples in custom recordings | `message.as_payload(binary_buffers)` |

Consumers adopt the public protocol directly. There are no adapters for viser4d's
old message names, waveform aliases, version branches, or legacy player detection.
Unlike viser4d's original waveform getter, `samples` returns normalized float32,
not the caller's original integer dtype.
