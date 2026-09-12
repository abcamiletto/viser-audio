"""Wire messages, sent from the Python server to the browser runtime.

All of them subclass viser's ``Message``, so they ride viser's websocket and
its broadcast buffer: create/remove coalesce per clip, updates are purged when
a clip is removed, and a late-joining client replays the current state.
"""

from __future__ import annotations

import base64
import dataclasses
import json
import uuid
from typing import Any, Dict, Optional

import numpy as np
import numpy.typing as npt

from ._viser import Message, audio_entity


class AudioMessage(Message, include_in_scene_serialization=True):
    """Public recording protocol; arrays use interleaved float32 PCM.

    ``as_payload()`` produces data for custom players. Viser serialization uses
    its built-in JavaScript command so no frontend message handler is patched.
    """

    def as_payload(
        self, binary_buffers: list[memoryview] | None = None
    ) -> dict[str, Any]:
        return super().as_serializable_dict(binary_buffers)

    def as_serializable_dict(
        self, binary_buffers: list[memoryview] | None = None
    ) -> dict[str, Any]:
        payload = json.dumps(
            self.as_payload(), default=_encode_samples, allow_nan=False
        )
        # The payload is parsed from a JSON string rather than embedded as a JS
        # object literal, so even names like __proto__ retain their data meaning.
        source = f"window.__VISER_AUDIO__.receive({json.dumps(payload)});"
        return {"type": "RunJavascriptMessage", "source": source}


@dataclasses.dataclass
class AudioAddMessage(
    AudioMessage,
    entity=audio_entity("create"),
):
    """Create a clip attached to the scene node ``name``."""

    name: str
    sample_rate: int
    num_channels: int
    samples: npt.NDArray[np.float32]
    """Interleaved, frame-major: ``samples[frame * num_channels + channel]``."""
    volume: float
    loop: bool
    positional: bool
    playback_rate: float = 1.0
    start_time: Optional[float] = None
    """Timeline anchor in seconds, or None for live playback."""


@dataclasses.dataclass
class AudioUpdateMessage(
    AudioMessage,
    entity=audio_entity("update_dict"),
):
    """Update volume, loop, positional, or playback_rate."""

    name: str
    updates: Dict[str, Any]


@dataclasses.dataclass
class AudioSamplesMessage(AudioMessage, entity=audio_entity("update_simple")):
    """Replace all samples. Timeline tracks retain their start time."""

    name: str
    samples: npt.NDArray[np.float32]
    num_channels: int


@dataclasses.dataclass
class AudioAppendMessage(
    AudioMessage,
    entity=audio_entity("update_simple"),
):
    """Extend a clip with more samples, for streaming."""

    name: str
    samples: npt.NDArray[np.float32]

    def __post_init__(self) -> None:
        self._id = uuid.uuid4().hex

    def redundancy_key(self) -> str:
        return f"audio:{self.name}:append:{self._id}"


@dataclasses.dataclass
class AudioPlaybackMessage(
    AudioMessage,
    entity=audio_entity("update_simple"),
):
    """Play or pause a clip; latest state wins for late-joining clients."""

    name: str
    playing: bool
    offset: float


@dataclasses.dataclass
class AudioRemoveMessage(
    AudioMessage,
    entity=audio_entity("remove"),
):
    """Remove a clip and free its buffers."""

    name: str


def _encode_samples(value: object) -> dict[str, str]:
    if isinstance(value, memoryview):
        return {"__audio_samples": base64.b64encode(value).decode("ascii")}
    raise TypeError(f"Cannot encode audio payload value: {type(value).__name__}")


MESSAGE_TYPES: dict[str, type[AudioMessage]] = {
    cls.__name__: cls
    for cls in (
        AudioAddMessage,
        AudioUpdateMessage,
        AudioSamplesMessage,
        AudioAppendMessage,
        AudioPlaybackMessage,
        AudioRemoveMessage,
    )
}


def from_payload(payload: dict[str, Any]) -> AudioMessage:
    """Decode the public protocol after the player resolves binary placeholders."""
    fields = payload.copy()
    message_type = MESSAGE_TYPES[fields.pop("type")]
    if "samples" in fields:
        samples = np.frombuffer(fields["samples"], dtype="<f4").copy()
        samples.flags.writeable = False
        fields["samples"] = samples
    return message_type(**fields)
