"""E2E tests for scene audio: playback, streaming appends, and muting."""

from __future__ import annotations

import numpy as np
from playwright.sync_api import Page

import viser

from .utils import wait_for_scene_node

# The three.js Audio object under a scene node, reduced to what the tests
# observe. three leaves `type` as "Audio" on PositionalAudio; the panner is
# what tells the two apart.
JS_AUDIO_STATE = """
(nodeName) => {
    const root = window.__viserMutable.nodeRefFromName[nodeName];
    if (!root) return null;
    let audio = null;
    root.traverse((child) => {
        if (child.type === "Audio") audio = child;
    });
    if (audio === null) return null;
    return {
        positional: audio.panner !== undefined,
        isPlaying: audio.isPlaying,
        duration: audio.buffer === null ? 0.0 : audio.buffer.duration,
        gain: audio.gain.gain.value,
        progress: audio._progress,
        contextState: audio.context.state,
    };
}
"""


def _tone(seconds: float, sample_rate: int = 8000) -> np.ndarray:
    t = np.arange(int(seconds * sample_rate)) / sample_rate
    return 0.2 * np.sin(2.0 * np.pi * 220.0 * t)


def _wait_until(page: Page, node_name: str, condition: str) -> None:
    """Wait until `condition`, a JS expression over `state`, holds."""
    page.wait_for_function(
        f"(nodeName) => {{ const state = ({JS_AUDIO_STATE})(nodeName);"
        f" return state !== null && ({condition}); }}",
        arg=node_name,
        timeout=10_000,
    )


def _add_and_unlock(server: viser.ViserServer, page: Page, name: str, **kwargs):
    audio = server.scene.add_audio(name, _tone(1.0), 8000, **kwargs)
    wait_for_scene_node(page, name)
    # Browsers keep the AudioContext suspended until the page sees a gesture.
    page.mouse.click(400, 300)
    return audio


def test_audio_plays_and_streams(viser_server: viser.ViserServer, viser_page: Page):
    errors: list[str] = []
    viser_page.on(
        "console", lambda m: errors.append(m.text) if m.type == "error" else None
    )
    viser_page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))

    audio = _add_and_unlock(
        viser_server, viser_page, "/audio", loop=True, positional=True
    )
    audio.play()
    _wait_until(
        viser_page, "/audio", 'state.isPlaying && state.contextState === "running"'
    )
    state = viser_page.evaluate(JS_AUDIO_STATE, "/audio")
    assert state["positional"] is True
    assert state["duration"] == 1.0

    # Appending to a playing node extends the buffer in place.
    audio.append(_tone(0.5))
    _wait_until(viser_page, "/audio", "state.duration > 1.4 && state.isPlaying")

    # A hidden node is muted.
    audio.visible = False
    _wait_until(viser_page, "/audio", "state.gain === 0.0")
    audio.visible = True
    _wait_until(viser_page, "/audio", "state.gain === 1.0")

    # Toggling `positional` swaps the three.js object; playback and the
    # appended samples carry over.
    audio.positional = False
    _wait_until(
        viser_page,
        "/audio",
        "!state.positional && state.isPlaying && state.duration > 1.4",
    )

    audio.pause()
    _wait_until(viser_page, "/audio", "!state.isPlaying")
    assert errors == [], f"console errors: {errors}"


def test_streamed_clip_resumes_after_running_dry(
    viser_server: viser.ViserServer, viser_page: Page
):
    """A stream whose source ends before the next chunk arrives resumes at
    the end of the old buffer, not from the start."""
    audio = _add_and_unlock(viser_server, viser_page, "/stream")
    audio.play()
    _wait_until(viser_page, "/stream", "state.isPlaying")
    _wait_until(viser_page, "/stream", "!state.isPlaying")

    audio.append(_tone(0.5))
    _wait_until(
        viser_page,
        "/stream",
        "state.isPlaying && state.duration > 1.4 && state.progress >= 0.99",
    )

    # An explicit play() after a natural end restarts from the top.
    _wait_until(viser_page, "/stream", "!state.isPlaying")
    audio.play()
    _wait_until(viser_page, "/stream", "state.isPlaying && state.progress === 0")


def test_paused_stream_does_not_autostart_on_append(
    viser_server: viser.ViserServer, viser_page: Page
):
    audio = _add_and_unlock(viser_server, viser_page, "/paused")
    audio.play()
    _wait_until(viser_page, "/paused", "state.isPlaying")
    audio.pause()
    _wait_until(viser_page, "/paused", "!state.isPlaying")

    audio.append(_tone(0.5))
    _wait_until(viser_page, "/paused", "state.duration > 1.4")
    assert viser_page.evaluate(JS_AUDIO_STATE, "/paused")["isPlaying"] is False
