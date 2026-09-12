"""Fold recorded audio events into complete checkpoint tracks."""

from __future__ import annotations

import dataclasses

import numpy as np

from . import messages


class AudioState:
    """Timeline state shared by recorders, chunk caches, and exporters.

    Snapshots contain AudioAddMessage records accepted by the browser's
    loadCheckpoint(). Updates retain the track's start_time. Copies share
    immutable sample arrays until an event replaces or appends samples.
    """

    def __init__(self) -> None:
        self._tracks: dict[str, messages.AudioAddMessage] = {}

    def apply(self, message: messages.AudioMessage) -> None:
        if isinstance(message, messages.AudioAddMessage):
            if message.start_time is None:
                raise ValueError("Recorded tracks require a start_time.")
            samples = _owned_samples(message.samples)
            self._tracks[message.name] = dataclasses.replace(message, samples=samples)
            return
        if isinstance(message, messages.AudioRemoveMessage):
            self._tracks.pop(message.name, None)
            return
        if isinstance(message, messages.AudioPlaybackMessage):
            raise ValueError("Recorded tracks are controlled by a transport.")
        if isinstance(message, messages.AudioUpdateMessage):
            track = self._tracks[message.name]
            updated = dataclasses.replace(track, **message.updates)
        elif isinstance(message, messages.AudioSamplesMessage):
            track = self._tracks[message.name]
            samples = _owned_samples(message.samples)
            updated = dataclasses.replace(
                track, samples=samples, num_channels=message.num_channels
            )
        elif isinstance(message, messages.AudioAppendMessage):
            track = self._tracks[message.name]
            samples = np.concatenate((track.samples, message.samples))
            samples.flags.writeable = False
            updated = dataclasses.replace(track, samples=samples)
        else:
            raise TypeError(f"Unknown audio message: {type(message).__name__}")
        self._tracks[updated.name] = updated

    def snapshot(self) -> list[messages.AudioAddMessage]:
        """Return complete tracks with immutable sample arrays."""
        return [dataclasses.replace(track) for track in self._tracks.values()]

    def copy(self) -> AudioState:
        state = AudioState()
        state._tracks = self._tracks.copy()
        return state


def _owned_samples(samples: np.ndarray) -> np.ndarray:
    samples = np.array(samples, dtype="<f4", order="C", copy=True)
    samples.flags.writeable = False
    return samples
