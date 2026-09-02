"""Audio for viser scenes."""

from importlib.metadata import version

from ._api import AudioApi as AudioApi
from ._api import AudioHandle as AudioHandle

__version__ = version("viser-audio")

__all__ = ["AudioApi", "AudioHandle", "__version__"]
