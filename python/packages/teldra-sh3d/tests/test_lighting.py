from math import pi

import pytest
from teldra_sh3d import parse_home_xml
from teldra_sh3d.lighting import source_lighting


def test_light_sources_project_rotated_offsets_level_elevation_and_visibility():
    home = parse_home_xml(f'''<home><level id="floor" name="Floor" elevation="300" height="250"
        floorThickness="20"/>
      <light id="lamp" name="Lamp" level="floor" x="100" y="200"
        elevation="40" width="100" depth="60" height="80" angle="{pi / 2}" power="0.4">
        <lightSource x="1" y="0.5" z="0.75" color="FFFFFF"/>
      </light>
      <light name="Hidden" visible="false" x="0" y="0"
        width="10" depth="10" height="10">
        <lightSource x="0.5" y="0.5" z="0.5" color="FFFFFF"/></light>
      <doorOrWindow name="Fixed window" x="100" y="200" width="100" depth="10" height="120"
        elevation="90"/>
      <doorOrWindow name="Door" x="0" y="0" width="80" depth="10" height="200"/>
    </home>''')
    lighting = source_lighting(home)
    assert len(lighting["pointSources"]) == 1
    assert lighting["pointSources"][0]["position"] == pytest.approx([1, 4, 2.5])
    assert lighting["pointSources"][0]["power"] == 0.4
    assert lighting["pointSources"][0]["canonicalId"] == "sh3d:light:lamp"
    assert len(lighting["windowSources"]) == 1
    assert lighting["windowSources"][0]["position"] == pytest.approx([1, 1.5, 2])
