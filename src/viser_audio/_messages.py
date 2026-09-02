"""Wire messages, sent from the Python server to the browser runtime.

All of them subclass viser's ``Message``, so they ride viser's websocket and
its broadcast buffer: create/remove coalesce per clip, updates are purged when
a clip is removed, and a late-joining client replays the current state.
"""

from __future__ import annotations

import dataclasses
import uuid
from typing import Any, Dict, Optional

import numpy as np
import numpy.typing as npt

from ._viser import Message, audio_entity


@dataclasses.dataclass
class AudioAddMessage(
    Message,
    entity=audio_entity("create"),
    include_in_scene_serialization=False,
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


@dataclasses.dataclass
class AudioUpdateMessage(
    Message,
    entity=audio_entity("update_dict"),
    include_in_scene_serialization=False,
):
    """Update clip properties. Samples are replaced by sending both
    ``samples`` and ``num_channels``, which the client applies as one edit."""

    name: str
    updates: Dict[str, Any]


@dataclasses.dataclass
class AudioAppendMessage(
    Message,
    entity=audio_entity("update_simple"),
    include_in_scene_serialization=False,
):
    """Extend a clip with more samples, for streaming."""

    name: str
    samples: npt.NDArray[np.float32]

    def __post_init__(self) -> None:
        # Appends are cumulative, so unlike every other update they must never
        # coalesce: give each instance its own redundancy key. (The base class
        # returns a cached key when one is present.) They are still purged
        # from the buffer when the clip is removed.
        object.__setattr__(
            self, "_cached_redundancy_key", f"audio:{self.name}:append:{uuid.uuid4()}"
        )


@dataclasses.dataclass
class AudioPlaybackMessage(
    Message,
    entity=audio_entity("update_simple"),
    include_in_scene_serialization=False,
):
    """Play or pause a clip; latest state wins for late-joining clients."""

    name: str
    playing: bool
    offset: Optional[float]


@dataclasses.dataclass
class AudioRemoveMessage(
    Message,
    entity=audio_entity("remove"),
    include_in_scene_serialization=False,
):
    """Remove a clip and free its buffers."""

    name: str
