"""Access to the prebuilt browser runtime bundle."""

from __future__ import annotations

import pathlib

_BUNDLE = pathlib.Path(__file__).resolve().parent / "runtime.js"


def runtime_source() -> str:
    """Return the JavaScript source of the browser runtime."""
    try:
        return _BUNDLE.read_text()
    except FileNotFoundError as exc:  # pragma: no cover
        raise RuntimeError(
            f"Missing the viser-audio browser runtime at {_BUNDLE}. Build it with "
            "`npm ci && npm run build` in src/viser_audio/client."
        ) from exc
