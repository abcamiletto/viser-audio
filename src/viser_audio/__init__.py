"""Audio for viser scenes."""

from importlib.metadata import version

from ._api import AudioApi as AudioApi
from ._api import AudioHandle as AudioHandle
from ._runtime import runtime_source as runtime_source
from ._state import AudioState as AudioState

__version__ = version("viser-audio")

__all__ = ["AudioApi", "AudioHandle", "AudioState", "__version__", "runtime_source"]
