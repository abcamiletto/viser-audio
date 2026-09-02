"""Tests for the scene audio API."""

from __future__ import annotations

import numpy as np
import pytest

from .utils import viser_server as _server


def test_int_pcm_is_normalized_to_float() -> None:
    with _server() as server:
        int16 = server.scene.add_audio(
            "/int16", np.array([0, 32767, -32768], dtype=np.int16), 8000
        )
        uint8 = server.scene.add_audio(
            "/uint8", np.array([0, 128, 255], dtype=np.uint8), 8000
        )
        assert int16.samples.dtype == np.float32
        np.testing.assert_allclose(int16.samples, [0.0, 32767 / 32768, -1.0])
        np.testing.assert_allclose(uint8.samples, [-1.0, 0.0, 127 / 128])


def test_samples_round_trip_mono_and_stereo() -> None:
    mono = np.linspace(-1.0, 1.0, 8)
    stereo = np.stack([mono, -mono], axis=-1)
    with _server() as server:
        handle = server.scene.add_audio("/audio", mono, 8000)
        np.testing.assert_allclose(handle.samples, mono)
        handle.samples = stereo
        np.testing.assert_allclose(handle.samples, stereo)


@pytest.mark.parametrize(
    "samples",
    [
        np.zeros((2, 2, 2)),
        np.zeros((4, 0)),
        np.zeros((2, 44100)),  # (C, N), as returned by librosa/torchaudio.
    ],
)
def test_bad_shapes_raise(samples: np.ndarray) -> None:
    with _server() as server, pytest.raises(ValueError):
        server.scene.add_audio("/audio", samples, 8000)


def test_append_extends_clip() -> None:
    with _server() as server:
        handle = server.scene.add_audio("/audio", np.zeros((4000, 2)), 8000)
        assert handle.duration == pytest.approx(0.5)
        handle.append(np.ones((2000, 2)))
        assert handle.duration == pytest.approx(0.75)
        np.testing.assert_allclose(handle.samples[4000:], 1.0)
        with pytest.raises(ValueError):
            handle.append(np.zeros(4))


def test_removed_handle_raises() -> None:
    with _server() as server:
        handle = server.scene.add_audio("/audio", np.zeros(8), 8000)
        handle.remove()
        with pytest.raises(RuntimeError):
            handle.play()
        with pytest.raises(RuntimeError):
            handle.append(np.zeros(4))
