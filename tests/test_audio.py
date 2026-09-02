"""Server-side behaviour of the audio API."""

from __future__ import annotations

import contextlib
import socket
from typing import Iterator

import numpy as np
import pytest
import viser

import viser_audio


def _free_port() -> int:
    with contextlib.closing(socket.socket()) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


@pytest.fixture(scope="module")
def server() -> Iterator[viser.ViserServer]:
    server = viser.ViserServer(port=_free_port(), verbose=False)
    yield server
    server.stop()


@pytest.fixture
def audio(server: viser.ViserServer) -> viser_audio.AudioApi:
    return viser_audio.AudioApi(server)


def test_mono_samples_round_trip(audio: viser_audio.AudioApi) -> None:
    samples = np.linspace(-1.0, 1.0, 100)
    clip = audio.add("/mono", samples, 100)
    assert clip.samples.shape == (100,)
    assert clip.samples.dtype == np.float32
    np.testing.assert_allclose(clip.samples, samples, atol=1e-6)
    assert clip.duration == pytest.approx(1.0)


def test_stereo_samples_round_trip(audio: viser_audio.AudioApi) -> None:
    samples = np.stack([np.zeros(50), np.ones(50)], axis=-1)
    clip = audio.add("/stereo", samples, 50)
    assert clip.samples.shape == (50, 2)
    np.testing.assert_allclose(clip.samples, samples)
    assert clip.duration == pytest.approx(1.0)


def test_integer_samples_are_normalized(audio: viser_audio.AudioApi) -> None:
    samples = np.array([-32768, 0, 32767], dtype=np.int16)
    clip = audio.add("/int16", samples, 3)
    np.testing.assert_allclose(clip.samples, [-1.0, 0.0, 1.0], atol=1e-4)


def test_channels_first_samples_hint_at_a_transpose(
    audio: viser_audio.AudioApi,
) -> None:
    with pytest.raises(ValueError, match="transpose"):
        audio.add("/channels_first", np.zeros((2, 100)), 100)


def test_append_extends_the_clip(audio: viser_audio.AudioApi) -> None:
    clip = audio.add("/append", np.zeros(100), 100)
    clip.append(np.ones(50))
    assert clip.samples.shape == (150,)
    assert clip.duration == pytest.approx(1.5)
    np.testing.assert_allclose(clip.samples[100:], 1.0)


def test_append_rejects_a_channel_mismatch(audio: viser_audio.AudioApi) -> None:
    clip = audio.add("/mismatch", np.zeros((100, 2)), 100)
    with pytest.raises(ValueError, match="2 channel"):
        clip.append(np.zeros(50))


def test_assigning_samples_replaces_the_clip(audio: viser_audio.AudioApi) -> None:
    clip = audio.add("/replace", np.zeros(100), 100)
    clip.samples = np.zeros((25, 2))
    assert clip.samples.shape == (25, 2)
    assert clip.duration == pytest.approx(0.25)


def test_removed_clip_rejects_further_use(audio: viser_audio.AudioApi) -> None:
    clip = audio.add("/removed", np.zeros(10), 10)
    clip.remove()
    with pytest.raises(RuntimeError):
        clip.play()
    with pytest.raises(RuntimeError):
        clip.volume = 0.5


def test_pose_round_trips(audio: viser_audio.AudioApi) -> None:
    clip = audio.add(
        "/posed", np.zeros(10), 10, position=(1.0, 2.0, 3.0), wxyz=(0.0, 1.0, 0.0, 0.0)
    )
    np.testing.assert_allclose(clip.position, (1.0, 2.0, 3.0))
    np.testing.assert_allclose(clip.wxyz, (0.0, 1.0, 0.0, 0.0))
    clip.position = (4.0, 5.0, 6.0)
    np.testing.assert_allclose(clip.position, (4.0, 5.0, 6.0))


def test_api_can_be_constructed_twice(server: viser.ViserServer) -> None:
    viser_audio.AudioApi(server)
    viser_audio.AudioApi(server)
