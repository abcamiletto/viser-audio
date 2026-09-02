"""Audio streaming.

Stream a live synthesizer to the browser by appending ~100ms chunks to a clip
that starts out empty.
"""

import time

import numpy as np
import viser

import viser_audio

SAMPLE_RATE = 44100
CHUNK_FRAMES = SAMPLE_RATE // 10  # ~100ms.


def main() -> None:
    server = viser.ViserServer()
    audio = viser_audio.AudioApi(server)

    frequency = server.gui.add_slider("Frequency (Hz)", 110.0, 880.0, 1.0, 220.0)
    clip = audio.add("/synth", np.zeros(0), SAMPLE_RATE)
    clip.play()

    phase = 0.0
    while True:
        # Track the phase across chunks so the sine wave stays continuous.
        step = 2.0 * np.pi * frequency.value / SAMPLE_RATE
        clip.append(0.3 * np.sin(phase + step * np.arange(CHUNK_FRAMES)))
        phase = (phase + step * CHUNK_FRAMES) % (2.0 * np.pi)
        # Send slightly faster than real time, so the client always has samples
        # queued up ahead of the playhead.
        time.sleep(0.9 * CHUNK_FRAMES / SAMPLE_RATE)


if __name__ == "__main__":
    main()
