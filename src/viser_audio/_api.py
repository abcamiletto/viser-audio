"""Audio clips for viser scenes."""

from __future__ import annotations

import math
import time
from collections.abc import Callable
from weakref import WeakValueDictionary

import numpy as np
import numpy.typing as npt
import viser

from . import _runtime, _viser, messages


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

    def __init__(
        self,
        target: viser.ViserServer | Callable[[messages.AudioMessage], None],
        *,
        scene: viser.SceneApi | None = None,
    ) -> None:
        """Use a server for live audio, or a callback to record messages.

        A callback is responsible for storing or delivering messages and installing
        :func:`viser_audio.runtime_source`. Pass its scene API for positional audio.
        """
        self._handles: WeakValueDictionary[str, AudioHandle] = WeakValueDictionary()
        if callable(target):
            self._dispatch = target
            self._scene = scene
        else:
            _viser.install_runtime(target, _runtime.runtime_source())
            self._dispatch = lambda message: _viser.queue_message(target, message)
            self._scene = target.scene if scene is None else scene

    def add(
        self,
        name: str,
        samples: np.ndarray,
        sample_rate: int = 44100,
        *,
        volume: float = 1.0,
        loop: bool = False,
        positional: bool = False,
        playback_rate: float = 1.0,
        start_time: float | None = None,
        wxyz: tuple[float, float, float, float] | np.ndarray = (1.0, 0.0, 0.0, 0.0),
        position: tuple[float, float, float] | np.ndarray = (0.0, 0.0, 0.0),
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
            playback_rate: Positive speed multiplier; changes pitch with speed.
            start_time: Timeline anchor in seconds. When set, the browser transport
                controls playback; samples replacement preserves this anchor.
            wxyz: Quaternion orientation of the node.
            position: Position of the node.

        Returns:
            A handle for playback control and live updates.
        """
        if (
            isinstance(sample_rate, bool)
            or int(sample_rate) != sample_rate
            or sample_rate <= 0
        ):
            raise ValueError("sample_rate must be a positive integer.")
        sample_rate = int(sample_rate)
        volume = _finite("volume", volume, minimum=0.0)
        playback_rate = _finite(
            "playback_rate", playback_rate, minimum=0.0, inclusive=False
        )
        if start_time is not None:
            start_time = _finite("start_time", start_time)
        if positional and self._scene is None:
            raise ValueError("Positional audio requires a scene API.")
        flat, num_channels = _normalize_samples(samples)
        message = messages.AudioAddMessage(
            name,
            sample_rate,
            num_channels,
            flat,
            volume,
            bool(loop),
            bool(positional),
            playback_rate,
            start_time,
        )
        # A recorder may reject writes outside its recording context. Dispatch
        # before creating a node so rejected edits have no scene side effects.
        self._dispatch(message)
        frame = None
        if self._scene is not None:
            frame = self._scene.add_frame(
                name, show_axes=False, wxyz=wxyz, position=position
            )
        previous = self._handles.get(name)
        if previous is not None:
            previous._removed = True
        handle = AudioHandle(self._dispatch, message, frame)
        self._handles[name] = handle
        return handle


class AudioHandle:
    """Handle for a single audio clip. Returned by :meth:`AudioApi.add`."""

    def __init__(
        self,
        dispatch: Callable[[messages.AudioMessage], None],
        message: messages.AudioAddMessage,
        frame: viser.FrameHandle | None,
    ) -> None:
        self._dispatch = dispatch
        self._frame = frame
        self._name = message.name
        self._chunks = [message.samples]
        self._num_samples = len(message.samples)
        self._num_channels = message.num_channels
        self._sample_rate = message.sample_rate
        self._volume = message.volume
        self._loop = message.loop
        self._positional = message.positional
        self._playback_rate = message.playback_rate
        self._start_time = message.start_time
        self._playing = False
        self._offset = 0.0
        self._started_at = 0.0
        self._removed = False

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
        samples = np.concatenate(self._chunks)
        if self._num_channels == 1:
            return samples
        return samples.reshape(-1, self._num_channels)

    @samples.setter
    def samples(self, samples: np.ndarray) -> None:
        self._check_alive()
        flat, num_channels = _normalize_samples(samples)
        self._dispatch(messages.AudioSamplesMessage(self._name, flat, num_channels))
        self._chunks = [flat]
        self._num_samples = len(flat)
        self._num_channels = num_channels
        if self._start_time is None:
            self._offset = 0.0
            self._started_at = time.monotonic()

    @property
    def duration(self) -> float:
        """Length of the clip in seconds, including appended samples."""
        self._check_alive()
        return self._num_samples / (self._num_channels * self._sample_rate)

    @property
    def volume(self) -> float:
        """Playback volume, where 1.0 is the original amplitude. Synchronized
        to clients automatically when assigned."""
        self._check_alive()
        return self._volume

    @volume.setter
    def volume(self, volume: float) -> None:
        volume = _finite("volume", volume, minimum=0.0)
        self._update(volume=volume)
        self._volume = volume

    @property
    def loop(self) -> bool:
        """Whether the clip restarts when it reaches the end. Synchronized to
        clients automatically when assigned."""
        self._check_alive()
        return self._loop

    @loop.setter
    def loop(self, loop: bool) -> None:
        loop = bool(loop)
        self._update(loop=loop)
        self._loop = loop

    @property
    def positional(self) -> bool:
        """Whether the audio is spatialized, emitted from the scene node's
        position. Synchronized to clients automatically when assigned; toggling
        preserves the playhead."""
        self._check_alive()
        return self._positional

    @positional.setter
    def positional(self, positional: bool) -> None:
        positional = bool(positional)
        if positional:
            self._scene_frame()
        self._update(positional=positional)
        self._positional = positional

    @property
    def position(self) -> npt.NDArray[np.float64]:
        """Position of the clip's scene node. Synchronized to clients
        automatically when assigned."""
        self._check_alive()
        return self._scene_frame().position

    @position.setter
    def position(self, position: tuple[float, float, float] | np.ndarray) -> None:
        self._check_alive()
        self._scene_frame().position = position

    @property
    def wxyz(self) -> npt.NDArray[np.float64]:
        """Orientation of the clip's scene node, as a quaternion. Synchronized
        to clients automatically when assigned."""
        self._check_alive()
        return self._scene_frame().wxyz

    @wxyz.setter
    def wxyz(self, wxyz: tuple[float, float, float, float] | np.ndarray) -> None:
        self._check_alive()
        self._scene_frame().wxyz = wxyz

    def play(self, offset: float | None = None) -> None:
        """Start playback, or resume it if the clip is paused.

        The latest playback state is replayed to late-joining clients, so a
        clip left playing also starts for new clients.

        Args:
            offset: If given, seek to this position (in seconds) before
                playing. If None, resume from the paused position, or from the
                start if playback never began or already finished.
        """
        self._check_live_playback()
        if offset is None:
            offset = self._playhead()
            if not self._playing and offset >= self.duration:
                offset = 0.0
        offset = _finite("offset", offset, minimum=0.0)
        self._dispatch(messages.AudioPlaybackMessage(self.name, True, offset))
        self._offset = offset
        self._started_at = time.monotonic()
        self._playing = True

    def pause(self) -> None:
        """Pause playback and retain an explicit offset for client replay."""
        self._check_live_playback()
        offset = self._playhead()
        self._dispatch(messages.AudioPlaybackMessage(self.name, False, offset))
        self._offset = offset
        self._playing = False

    @property
    def playback_rate(self) -> float:
        """Positive playback speed; 2.0 plays twice as fast (and raises pitch)."""
        self._check_alive()
        return self._playback_rate

    @playback_rate.setter
    def playback_rate(self, value: float) -> None:
        value = _finite("playback_rate", value, minimum=0.0, inclusive=False)
        offset = self._playhead()
        self._update(playback_rate=value)
        self._offset = offset
        self._started_at = time.monotonic()
        self._playback_rate = value

    @property
    def start_time(self) -> float | None:
        """Timeline anchor in seconds, or None for independently controlled clips."""
        return self._start_time

    @property
    def sample_rate(self) -> int:
        return self._sample_rate

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
        if not len(flat):
            return
        self._dispatch(messages.AudioAppendMessage(self.name, flat))
        self._chunks.append(flat)
        self._num_samples += len(flat)

    def remove(self) -> None:
        """Remove this clip and its scene node, if it has one."""
        self._check_alive()
        self._dispatch(messages.AudioRemoveMessage(self.name))
        self._removed = True
        if self._frame is not None:
            self._frame.remove()

    def _check_alive(self) -> None:
        if self._removed or (
            self._frame is not None and _viser.is_removed(self._frame)
        ):
            raise RuntimeError(f"Audio clip {self._name!r} has been removed.")

    def _update(self, **updates: object) -> None:
        self._check_alive()
        self._dispatch(messages.AudioUpdateMessage(self._name, updates))

    def _scene_frame(self) -> viser.FrameHandle:
        self._check_alive()
        if self._frame is None:
            raise RuntimeError(
                "This audio API has no scene; pass scene= to attach nodes."
            )
        return self._frame

    def _check_live_playback(self) -> None:
        self._check_alive()
        if self._start_time is not None:
            raise RuntimeError(
                "Timeline tracks are controlled by the browser transport."
            )

    def _playhead(self) -> float:
        self._check_alive()
        offset = self._offset
        if self._playing:
            offset += (time.monotonic() - self._started_at) * self.playback_rate
        if self.loop and self.duration:
            return offset % self.duration
        return min(offset, self.duration)


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
    if not np.isfinite(scaled).all():
        raise ValueError("Audio samples must be finite.")
    flat = np.array(scaled, dtype="<f4", order="C", copy=True).reshape(-1)
    flat.flags.writeable = False
    return flat, num_channels


def _finite(
    name: str, value: float, *, minimum: float = -math.inf, inclusive: bool = True
) -> float:
    value = float(value)
    below = value < minimum if inclusive else value <= minimum
    if not math.isfinite(value) or below:
        comparison = "at least" if inclusive else "greater than"
        raise ValueError(f"{name} must be finite and {comparison} {minimum}.")
    return value
