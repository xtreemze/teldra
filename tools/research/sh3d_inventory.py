"""Inventory of a Sweet Home 3D archive's Home.xml: element counts and attribute usage.

Usage: python tools/research/sh3d_inventory.py <file.sh3d> [--json]
Reads Home.xml straight from the zip (no extraction). Output feeds
docs/research/capability-matrix.md.
"""
import collections
import json
import sys
import zipfile
import xml.etree.ElementTree as ET  # noqa: S405  (trusted local fixture)


def inventory(path: str) -> dict:
    with zipfile.ZipFile(path) as z:
        root = ET.fromstring(z.read("Home.xml"))  # noqa: S314
        entries = z.namelist()
    counts: collections.Counter[str] = collections.Counter()
    attrs: dict[str, collections.Counter[str]] = collections.defaultdict(collections.Counter)
    for el in root.iter():
        counts[el.tag] += 1
        for a in el.attrib:
            attrs[el.tag][a] += 1
    pieces = [e for e in root.iter() if e.tag in ("pieceOfFurniture", "doorOrWindow", "light")]
    catalog_ids = collections.Counter(p.get("catalogId", "<none>") for p in pieces)
    kinds = collections.Counter(p.tag for p in pieces)
    levels = [dict(e.attrib) for e in root.iter("level")]
    return {
        "homeAttributes": dict(root.attrib),
        "elementCounts": dict(counts),
        "attributeUsage": {k: dict(v) for k, v in attrs.items()},
        "pieceKinds": dict(kinds),
        "distinctCatalogIds": len(catalog_ids),
        "catalogIdsWithSource": sum(1 for p in pieces if p.get("catalogId")),
        "topCatalogIds": catalog_ids.most_common(10),
        "levels": levels,
        "zipEntryCount": len(entries),
        "zipEntriesSample": entries[:8],
    }


if __name__ == "__main__":
    data = inventory(sys.argv[1])
    if "--json" in sys.argv:
        print(json.dumps(data, indent=2))
    else:
        for k in ("homeAttributes", "elementCounts", "pieceKinds", "distinctCatalogIds",
                  "catalogIdsWithSource", "topCatalogIds", "levels"):
            print(k, json.dumps(data[k]) if not isinstance(data[k], int) else data[k])
        print("attributeUsage:")
        for tag, a in sorted(data["attributeUsage"].items()):
            print(" ", tag, dict(a))
