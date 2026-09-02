"""Audio clips for viser scenes."""

from __future__ import annotations

from typing import Tuple

import numpy as np
import numpy.typing as npt
import viser

from . import _messages
from ._runtime import runtime_source
from ._viser import install_runtime, queue_message


def _normalize_samples(samples: np.ndarray) -> tuple[npt.NDArray[np.float32], int]:
    """Normalize samples for transport: a flat, frame-major interleaved float32
    array in [-1, 1] plus the channel count.

    Accepts (N,) mono or (N, C) multi-channel arrays. Integer PCM is scaled by
    its dtype's range (unsigned formats are re-centered on their midpoint);
    floats are cast to float32 as-is, without clipping.
    """
    array = np.asarray(samples)
    if array.ndim == 1:
        num_channels = 1
    elif array.ndim == 2:
        num_channels = array.shape[1]
    else:
        raise ValueError(
            f"Expected audio samples of shape (N,) or (N, C), but got {array.shape}."
        )
    # Web Audio caps a buffer at 32 channels. Checking here also catches the
    # common (C, N) layout returned by librosa/torchaudio, which would
    # otherwise be read as N frames of C channels and only fail in the browser.
    if not 1 <= num_channels <= 32:
        raise ValueError(
            "Expected samples with shape (N,) or (N, C) with at most 32 "
            f"channels, but got shape {array.shape}. If your array is (C, N), "
            "transpose it."
        )

    if np.issubdtype(array.dtype, np.integer):
        info = np.iinfo(array.dtype)
        if info.min < 0:
            scaled = array.astype(np.float32) / float(max(abs(info.min), info.max))
        else:
            midpoint = (float(info.max) + 1.0) / 2.0
            scaled = (array.astype(np.float32) - midpoint) / midpoint
    elif np.issubdtype(array.dtype, np.floating):
        scaled = array.astype(np.float32)
    else:
        raise ValueError(
            f"Expected float or integer audio samples, but got dtype {array.dtype}."
        )
    return np.ascontiguousarray(scaled).reshape(-1), num_channels


class AudioHandle:
    """Handle for a single audio clip. Returned by :meth:`AudioApi.add`."""

    def __init__(
        self,
        server: viser.ViserServer,
        frame: viser.FrameHandle,
        samples: npt.NDArray[np.float32],
        num_channels: int,
        sample_rate: int,
        volume: float,
        loop: bool,
        positional: bool,
    ) -> None:
        self._server = server
        self._frame = frame
        self._name = frame.name
        self._samples = samples
        self._num_channels = num_channels
        self._sample_rate = sample_rate
        self._volume = volume
        self._loop = loop
        self._positional = positional
        self._removed = False

    def _check_alive(self) -> None:
        if self._removed:
            raise RuntimeError(f"Audio clip {self._name!r} has been removed.")

    def _update(self, **updates: object) -> None:
        self._check_alive()
        queue_message(
            self._server, _messages.AudioUpdateMessage(self._name, dict(updates))
        )

    @property
    def name(self) -> str:
        """Name of the scene node the clip is attached to."""
        return self._name

    @property
    def samples(self) -> npt.NDArray[np.float32]:
        """Samples of the clip, with shape (N,) for mono audio or (N, C) for C
        channels. Includes anything added with :meth:`append`. Assigning
        replaces the clip; a playing clip restarts from the beginning."""
        self._check_alive()
        if self._num_channels == 1:
            return self._samples
        return self._samples.reshape(-1, self._num_channels)

    @samples.setter
    def samples(self, samples: np.ndarray) -> None:
        flat, num_channels = _normalize_samples(samples)
        self._samples = flat
        self._num_channels = num_channels
        # Both fields go out in ONE update: the client rebuilds its audio
        # buffer from the pair, and a split update would briefly de-interleave
        # the new samples using the old channel count.
        self._update(samples=flat, num_channels=num_channels)

    @property
    def duration(self) -> float:
        """Length of the clip in seconds, including appended samples."""
        self._check_alive()
        return len(self._samples) / (self._num_channels * self._sample_rate)

    @property
    def volume(self) -> float:
        """Playback volume, where 1.0 is the original amplitude. Synchronized
        to clients automatically when assigned."""
        self._check_alive()
        return self._volume

    @volume.setter
    def volume(self, volume: float) -> None:
        self._volume = float(volume)
        self._update(volume=self._volume)

    @property
    def loop(self) -> bool:
        """Whether the clip restarts when it reaches the end. Synchronized to
        clients automatically when assigned."""
        self._check_alive()
        return self._loop

    @loop.setter
    def loop(self, loop: bool) -> None:
        self._loop = bool(loop)
        self._update(loop=self._loop)

    @property
    def positional(self) -> bool:
        """Whether the audio is spatialized, emitted from the scene node's
        position. Synchronized to clients automatically when assigned; toggling
        preserves the playhead."""
        self._check_alive()
        return self._positional

    @positional.setter
    def positional(self, positional: bool) -> None:
        self._positional = bool(positional)
        self._update(positional=self._positional)

    @property
    def position(self) -> npt.NDArray[np.float64]:
        """Position of the clip's scene node. Synchronized to clients
        automatically when assigned."""
        self._check_alive()
        return self._frame.position

    @position.setter
    def position(self, position: Tuple[float, float, float] | np.ndarray) -> None:
        self._check_alive()
        self._frame.position = position

    @property
    def wxyz(self) -> npt.NDArray[np.float64]:
        """Orientation of the clip's scene node, as a quaternion. Synchronized
        to clients automatically when assigned."""
        self._check_alive()
        return self._frame.wxyz

    @wxyz.setter
    def wxyz(self, wxyz: Tuple[float, float, float, float] | np.ndarray) -> None:
        self._check_alive()
        self._frame.wxyz = wxyz

    def play(self, offset: float | None = None) -> None:
        """Start playback, or resume it if the clip is paused.

        The latest playback state is replayed to late-joining clients, so a
        clip left playing also starts for new clients.

        Args:
            offset: If given, seek to this position (in seconds) before
                playing. If None, resume from the paused position, or from the
                start if playback never began or already finished.
        """
        self._check_alive()
        queue_message(
            self._server, _messages.AudioPlaybackMessage(self._name, True, offset)
        )

    def pause(self) -> None:
        """Pause playback, keeping the current position."""
        self._check_alive()
        queue_message(
            self._server, _messages.AudioPlaybackMessage(self._name, False, None)
        )

    def append(self, samples: np.ndarray) -> None:
        """Append samples to the end of the clip, for streaming.

        Unlike assigning to :attr:`samples`, this does not interrupt playback:
        the client swaps in the longer buffer without a gap.

        Args:
            samples: Samples to append, with the same number of channels as the
                current samples.
        """
        self._check_alive()
        flat, num_channels = _normalize_samples(samples)
        if num_channels != self._num_channels:
            raise ValueError(
                f"Expected {self._num_channels} channel(s) to match the current "
                f"samples, but got {num_channels}."
            )
        # Mirror the append locally so `handle.samples` reads back everything
        # the client has, without resending the whole clip.
        self._samples = np.concatenate([self._samples, flat])
        queue_message(self._server, _messages.AudioAppendMessage(self._name, flat))

    def remove(self) -> None:
        """Remove the clip and its scene node. The handle cannot be used
        afterwards."""
        self._check_alive()
        self._removed = True
        queue_message(self._server, _messages.AudioRemoveMessage(self._name))
        self._frame.remove()


class AudioApi:
    """Audio for a :class:`viser.ViserServer`.

    Constructing this installs the browser-side audio runtime on the server's
    clients; it is idempotent, so it is safe to construct one per module::

        server = viser.ViserServer()
        audio = viser_audio.AudioApi(server)
        clip = audio.add("/speaker", samples, 44100)
        clip.play()

    Browsers only start audio after a user gesture: playback begins on the
    first click or keypress in the page.
    """

    def __init__(self, server: viser.ViserServer) -> None:
        self._server = server
        install_runtime(server, runtime_source())

    def add(
        self,
        name: str,
        samples: np.ndarray,
        sample_rate: int = 44100,
        *,
        volume: float = 1.0,
        loop: bool = False,
        positional: bool = False,
        wxyz: Tuple[float, float, float, float] | np.ndarray = (1.0, 0.0, 0.0, 0.0),
        position: Tuple[float, float, float] | np.ndarray = (0.0, 0.0, 0.0),
    ) -> AudioHandle:
        """Add an audio clip to the scene.

        The clip is attached to a scene node, so it moves with its parent:
        ``add("/robot/speaker", ...)`` follows ``/robot`` around.

        Args:
            name: A scene tree name, of the form ``/parent/child``. Positional
                audio is emitted from this node.
            samples: Samples with shape (N,) for mono audio or (N, C) for C
                channels, C at most 32. Floats are expected in [-1, 1];
                integers are normalized by their dtype's range. An empty array
                is a valid start for a streamed clip.
            sample_rate: Sample rate of ``samples``, in Hz.
            volume: Playback volume, where 1.0 is the original amplitude.
            loop: Whether the clip restarts when it reaches the end.
            positional: Whether to spatialize the audio, emitting it from the
                node's position.
            wxyz: Quaternion orientation of the node.
            position: Position of the node.

        Returns:
            A handle for playback control and live updates.
        """
        flat, num_channels = _normalize_samples(samples)
        frame = self._server.scene.add_frame(
            name, show_axes=False, wxyz=wxyz, position=position
        )
        queue_message(
            self._server,
            _messages.AudioAddMessage(
                name=name,
                sample_rate=sample_rate,
                num_channels=num_channels,
                samples=flat,
                volume=volume,
                loop=loop,
                positional=positional,
            ),
        )
        return AudioHandle(
            self._server,
            frame,
            flat,
            num_channels,
            sample_rate,
            volume,
            loop,
            positional,
        )
