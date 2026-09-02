"""Audio streaming

Stream a live synthesizer to the browser by appending ~100ms chunks.

**Features:**

* :meth:`viser.AudioHandle.append` for extending a clip while it plays
* :meth:`viser.SceneApi.add_audio` starting from an empty clip
"""

import time

import numpy as np

import viser

SAMPLE_RATE = 44100
CHUNK_FRAMES = SAMPLE_RATE // 10  # ~100ms.


def main() -> None:
    server = viser.ViserServer()

    frequency = server.gui.add_slider("Frequency (Hz)", 110.0, 880.0, 1.0, 220.0)
    audio = server.scene.add_audio(
        "/synth", np.zeros(0, dtype=np.float32), SAMPLE_RATE, positional=False
    )
    audio.play()

    phase = 0.0
    while True:
        # Track the phase across chunks so the sine wave stays continuous.
        step = 2.0 * np.pi * frequency.value / SAMPLE_RATE
        audio.append(0.3 * np.sin(phase + step * np.arange(CHUNK_FRAMES)))
        phase = (phase + step * CHUNK_FRAMES) % (2.0 * np.pi)
        # Send slightly faster than real time, so the client always has samples
        # queued up ahead of the playhead.
        time.sleep(0.9 * CHUNK_FRAMES / SAMPLE_RATE)


if __name__ == "__main__":
    main()
