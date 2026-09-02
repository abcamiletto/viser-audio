"""Browser tests: clips reach the client, play, and grow while streaming."""

from __future__ import annotations

from typing import Callable

import numpy as np
from playwright.sync_api import Page

import viser_audio

# The runtime's view of one clip, by name.
CLIP_STATE = """
(name) => window.__VISER_AUDIO__.debug().find((clip) => clip.name === name) ?? null
"""


def _tone(seconds: float, sample_rate: int = 8000) -> np.ndarray:
    t = np.arange(int(seconds * sample_rate)) / sample_rate
    return 0.2 * np.sin(2.0 * np.pi * 220.0 * t)


def _wait_until(page: Page, name: str, condition: str) -> None:
    """Wait until `condition`, a JS expression over `clip`, holds."""
    page.wait_for_function(
        f"(name) => {{ const clip = ({CLIP_STATE})(name);"
        f" return clip !== null && ({condition}); }}",
        arg=name,
        timeout=15_000,
    )


def test_clip_reaches_a_client_that_joins_later(
    audio: viser_audio.AudioApi, connect: Callable[[], Page]
) -> None:
    audio.add("/late", _tone(1.0), 8000, positional=True)
    page = connect()
    _wait_until(page, "/late", "clip.duration === 1.0 && clip.positional")


def test_play_advances_the_playhead_and_pause_stops_it(
    audio: viser_audio.AudioApi, connect: Callable[[], Page]
) -> None:
    page = connect()
    clip = audio.add("/playback", _tone(5.0), 8000)
    _wait_until(page, "/playback", "clip.duration === 5.0")

    clip.play()
    _wait_until(page, "/playback", "clip.playing && clip.position > 0.05")

    clip.pause()
    _wait_until(page, "/playback", "!clip.playing")
    position = page.evaluate(CLIP_STATE, "/playback")["position"]
    assert position > 0.0


def test_append_extends_a_playing_clip(
    audio: viser_audio.AudioApi, connect: Callable[[], Page]
) -> None:
    page = connect()
    clip = audio.add("/stream", _tone(1.0), 8000)
    clip.play()
    _wait_until(page, "/stream", "clip.playing")

    clip.append(_tone(2.0))
    _wait_until(page, "/stream", "clip.duration > 2.9 && clip.playing")
