"""Audio

Play a synthesized melody from a moving, spatialized scene node.

**Features:**

* :meth:`viser.SceneApi.add_audio` for attaching audio to a scene node
* :meth:`viser.AudioHandle.play` and :meth:`viser.AudioHandle.pause` for playback control
* :attr:`viser.AudioHandle.volume`, :attr:`viser.AudioHandle.loop`, and
  :attr:`viser.AudioHandle.positional` for live playback settings
"""

import time

import numpy as np

import viser

SAMPLE_RATE = 44100


def make_melody() -> np.ndarray:
    """Synthesize a short arpeggio as mono samples in [-1, 1]."""
    note_seconds = 0.25
    t = np.arange(int(SAMPLE_RATE * note_seconds)) / SAMPLE_RATE
    # Fade each note in and out to avoid clicks at the boundaries.
    envelope = np.minimum(1.0, 20.0 * np.minimum(t, note_seconds - t))
    return np.concatenate(
        [
            0.4 * envelope * np.sin(2.0 * np.pi * frequency * t)
            for frequency in (261.63, 329.63, 392.00, 523.25, 392.00, 329.63)
        ]
    )


def main() -> None:
    server = viser.ViserServer()

    # A small sphere marks where the sound is coming from.
    source = server.scene.add_icosphere("/source", radius=0.15, color=(255, 130, 40))
    audio = server.scene.add_audio(
        "/source/audio",
        make_melody(),
        SAMPLE_RATE,
        loop=True,
        positional=True,
    )

    play_button = server.gui.add_button("Play")
    pause_button = server.gui.add_button("Pause")
    volume_slider = server.gui.add_slider(
        "Volume", min=0.0, max=1.0, step=0.01, initial_value=1.0
    )
    loop_checkbox = server.gui.add_checkbox("Loop", initial_value=True)
    positional_checkbox = server.gui.add_checkbox("Positional", initial_value=True)

    @play_button.on_click
    def _(_) -> None:
        audio.play()

    @pause_button.on_click
    def _(_) -> None:
        audio.pause()

    @volume_slider.on_update
    def _(_) -> None:
        audio.volume = volume_slider.value

    @loop_checkbox.on_update
    def _(_) -> None:
        audio.loop = loop_checkbox.value

    @positional_checkbox.on_update
    def _(_) -> None:
        audio.positional = positional_checkbox.value

    # Orbit the source around the origin.
    while True:
        angle = time.time()
        source.position = (2.0 * np.cos(angle), 2.0 * np.sin(angle), 0.0)
        time.sleep(1.0 / 60.0)


if __name__ == "__main__":
    main()
