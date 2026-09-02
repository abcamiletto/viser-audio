"""Fixtures for the browser tests.

Requires a chromium install: ``uv run playwright install chromium``.
"""

from __future__ import annotations

import contextlib
import socket
from typing import Any, Callable, Dict, Iterator

import pytest
import viser
from playwright.sync_api import Page

import viser_audio


def _free_port() -> int:
    with contextlib.closing(socket.socket()) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


@pytest.fixture(scope="session")
def browser_type_launch_args(
    browser_type_launch_args: Dict[str, Any],
) -> Dict[str, Any]:
    # Headless chromium has no audio device, but it will run the Web Audio
    # graph against a null sink -- as long as it doesn't wait for a gesture.
    args = list(browser_type_launch_args.get("args", []))
    args.append("--autoplay-policy=no-user-gesture-required")
    return {**browser_type_launch_args, "args": args}


@pytest.fixture
def port() -> int:
    return _free_port()


@pytest.fixture
def server(port: int) -> Iterator[viser.ViserServer]:
    server = viser.ViserServer(port=port, verbose=False)
    yield server
    server.stop()


@pytest.fixture
def audio(server: viser.ViserServer) -> viser_audio.AudioApi:
    return viser_audio.AudioApi(server)


@pytest.fixture
def connect(page: Page, port: int, audio: viser_audio.AudioApi) -> Callable[[], Page]:
    """Open the viewer and wait for the audio runtime to install."""

    def _connect() -> Page:
        page.goto(f"http://localhost:{port}", wait_until="domcontentloaded")
        page.wait_for_function("() => window.__VISER_AUDIO__ !== undefined")
        return page

    return _connect
