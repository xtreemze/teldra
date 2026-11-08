# Source Phong color transfer

Teldra-authored fixture under the repository license. A 16×16 constant RGB
(42, 56, 62) image covers a matte floor with repeated UVs. It traverses the
normal OBJ → glTF PBR → source Phong loading path. The browser test measures
rendered pixels near and far, with unlit inspection and normal lighting.

Regenerate with `python tools/fixtures/generate_sh3d_color_fixture.py` using
the workspace Python packages on PYTHONPATH. This fixture contains no user assets.
