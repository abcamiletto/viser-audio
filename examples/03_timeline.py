"""Export a self-contained audio timeline with a client-local playback clock.

Run with ``uv run python examples/03_timeline.py``, then open audio-timeline.html.
The same clock interface can be driven by a 3D recording player.
"""

import pathlib

import numpy as np

import viser_audio
from viser_audio.messages import AudioMessage


def main() -> None:
    events: list[AudioMessage] = []
    audio = viser_audio.AudioApi(events.append)
    sample_rate = 8000
    time = np.arange(sample_rate * 3) / sample_rate
    samples = 0.2 * np.sin(2 * np.pi * 220 * time)
    audio.add("/tone", samples, sample_rate, start_time=1.0)

    commands = "\n".join(event.as_serializable_dict()["source"] for event in events)
    runtime = viser_audio.runtime_source()
    # Escape the HTML parser's script terminator, including user-supplied names.
    scripts = (runtime + "\n" + commands).replace("</", "<\\/")
    html = (
        """<!doctype html>
<html lang="en">
<meta charset="utf-8">
<title>Audio timeline</title>
<style>
body { font: 16px system-ui; max-width: 560px; margin: 80px auto; padding: 20px; }
input { width: 100%; margin: 24px 0; }
button, select { font: inherit; padding: 8px; }
</style>
<h1>Audio timeline</h1>
<p>A three-second tone starts at one second. Each tab plays independently.</p>
<button id="play">Play</button>
<label>Speed <select id="rate"><option>0.5</option><option selected>1</option><option>2</option></select></label>
<input id="seek" aria-label="Timeline position" type="range" min="0" max="5" step="0.01" value="0">
<output id="position">0.00 s</output>
<script>
"""
        + scripts
        + """
const engine = window.__VISER_AUDIO__.engine;
const play = document.getElementById("play");
const seek = document.getElementById("seek");
const rate = document.getElementById("rate");
const output = document.getElementById("position");
let position = 0, playing = false, speed = 1, anchor = performance.now();
function now() {
  const elapsed = playing ? (performance.now() - anchor) / 1000 * speed : 0;
  return Math.min(5, position + elapsed);
}
function update(nextPosition, nextPlaying, nextSpeed) {
  position = nextPosition; playing = nextPlaying; speed = nextSpeed;
  anchor = performance.now();
  play.textContent = playing ? "Pause" : "Play";
  engine.sync();
}
engine.setTransport(() => ({position: now(), playing, rate: speed}));
play.onclick = () => update(now() === 5 ? 0 : now(), !playing, speed);
seek.oninput = () => update(Number(seek.value), playing, speed);
rate.onchange = () => update(now(), playing, Number(rate.value));
function draw() {
  const current = now();
  if (current === 5 && playing) update(5, false, speed);
  seek.value = current;
  output.textContent = current.toFixed(2) + " s";
  requestAnimationFrame(draw);
}
draw();
</script>
</html>
"""
    )
    path = pathlib.Path("audio-timeline.html")
    path.write_text(html)
    print(path.resolve())


if __name__ == "__main__":
    main()
