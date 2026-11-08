# Asymmetric GPU surface probe

Teldra-authored fixture under the repository license. A 16×16 red/green/blue/yellow
image covers a matte floor with UVs from zero to one. It verifies framebuffer
origin/channel order and source UV correspondence with actual rendered pixels
on WebGL and WebGPU. It contains no user assets.

Regenerate with `python tools/fixtures/generate_sh3d_probe_fixture.py`, with the
workspace Python packages on PYTHONPATH.
