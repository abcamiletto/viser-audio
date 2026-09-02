"""Single-point adapter for viser's private APIs.

viser has no extension API, so viser-audio reaches into a few internals. Every
such access is concentrated here; the rest of the package imports only this
module.
"""

from __future__ import annotations

from typing import Any, cast

import viser
from viser import _messages

Message = _messages.Message
"""Base class for all viser wire messages."""

_RUNTIME_INSTALLED_ATTR = "_viser_audio_runtime_installed"
_RUNTIME_REDUNDANCY_KEY = "viser_audio:runtime"


def audio_entity(phase: str) -> Any:
    """Lifecycle markers for an ``"audio"`` entity keyed by scene node name.

    ``"audio"`` is not one of viser's declared entity types, but the message
    buffer only compares the string: create/remove coalesce, and updates are
    purged when the entity is removed.
    """
    return _messages.EntityLifecycle(cast(Any, "audio"), cast(Any, phase), "name")


def queue_message(server: viser.ViserServer, message: Message) -> None:
    """Broadcast a message to every connected (and future) client."""
    server._websock_server.queue_message(message)


def install_runtime(server: viser.ViserServer, source: str) -> None:
    """Inject the browser runtime into every client of ``server``, once."""
    if getattr(server, _RUNTIME_INSTALLED_ATTR, False):
        return
    message = _messages.RunJavascriptMessage(source)
    # viser's plotly support also sends RunJavascriptMessage; a stable key of
    # our own keeps a re-injection from replacing plotly's payload (or the
    # reverse) in the broadcast buffer.
    object.__setattr__(message, "_cached_redundancy_key", _RUNTIME_REDUNDANCY_KEY)
    queue_message(server, message)
    setattr(server, _RUNTIME_INSTALLED_ATTR, True)
