import { describe, expect, it } from "vitest";
import raw from "../../../fixtures/projects/golden-home/building.ifc?raw";
import { IfcAPI, IFCFURNITURE, IFCRELCONTAINEDINSPATIALSTRUCTURE } from "web-ifc";
import {
  duplicateFurniture, removeFurniture, readFurniturePose, writeFurniturePose,
  readFurnitureGeometryScale, writeFurnitureGeometryScale, readFurnitureSourceDimensions,
  FurnitureLifecycleError,
} from "../src/index.js";

const code = new TextEncoder();
const guid = "16W6mYG0DO8hR8U$bz6FSv";
const copyGuid = "2gEfmKcdn6c9fX3LLRJBkX";

/** Chair with owned mapped geometry (shared IfcRepresentationMap), type, material and classification-free associations. */
interface Ids { chair: number; place: number; axis: number; contain: number; storey: number; type: number; typeRel: number; material: number; materialRel: number; next: number }
let fx!: Ids;
function richFixture(extra: (f: Ids) => string[] = () => []): Uint8Array {
  // Derive express ids from the fixture so regenerating golden-home does not break the test.
  const chair = raw.match(/^#(\d+)=IFCFURNITURE\('16W6mYG0DO8hR8U\$bz6FSv',\$,'Chair',\$,\$,(#\d+),\$,\$,\$\);$/m);
  const body = raw.match(/^#(\d+)=IFCSHAPEREPRESENTATION\((#\d+),'Body','SweptSolid'/m);
  const origin = raw.match(/^#(\d+)=IFCAXIS2PLACEMENT3D\(/m);
  const point = raw.match(/^#(\d+)=IFCCARTESIANPOINT\(\(0\.,0\.,0\.\)\);$/m);
  if (!chair || !body || !origin || !point) throw new Error("Fixture changed.");
  const base = Math.max(...[...raw.matchAll(/^#(\d+)=/gm)].map((m) => Number(m[1]))) + 10;
  const id = (offset: number) => `#${base + offset}`;
  const placement = raw.match(new RegExp(`^#${chair[2]!.slice(1)}=IFCLOCALPLACEMENT\\(#\\d+,#(\\d+)\\);$`, "m"));
  const containment = raw.match(new RegExp(`^#(\\d+)=IFCRELCONTAINEDINSPATIALSTRUCTURE\\([^\\n]*\\(([^)]*)\\),#(\\d+)\\);$`, "m"));
  if (!placement || !containment || !containment[2]!.split(",").includes(`#${chair[1]}`)) throw new Error("Fixture changed.");
  fx = { chair: Number(chair[1]), place: Number(chair[2]!.slice(1)), axis: Number(placement[1]), contain: Number(containment[1]), storey: Number(containment[3]),
    type: base + 10, typeRel: base + 11, material: base + 12, materialRel: base + 13, next: base + 20 };
  const source = raw.replace(chair[0], chair[0].replace(`,${chair[2]},$,$,$);`, `,${chair[2]},${id(4)},$,$);`));
  const lines = [
    `${id(0)}=IFCREPRESENTATIONMAP(#${origin[1]},#${body[1]});`,
    `${id(1)}=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#${point[1]},1.,$);`,
    `${id(2)}=IFCMAPPEDITEM(${id(0)},${id(1)});`,
    `${id(3)}=IFCSHAPEREPRESENTATION(${body[2]},'Body','MappedRepresentation',(${id(2)}));`,
    `${id(4)}=IFCPRODUCTDEFINITIONSHAPE($,$,(${id(3)}));`,
    `${id(10)}=IFCFURNITURETYPE('3pEfmKcdn6c9fX3LLRJBkA',$,'Chair type',$,$,$,$,$,$,.CHAIR.);`,
    `${id(11)}=IFCRELDEFINESBYTYPE('3pEfmKcdn6c9fX3LLRJBkB',$,$,$,(#${chair[1]}),${id(10)});`,
    `${id(12)}=IFCMATERIAL('Oak',$,$);`,
    `${id(13)}=IFCRELASSOCIATESMATERIAL('3pEfmKcdn6c9fX3LLRJBkC',$,$,$,(#${chair[1]}),${id(12)});`,
    ...extra(fx),
  ];
  return code.encode(source.replace("\nENDSEC;\nEND-ISO-10303-21;", "\n" + lines.join("\n") + "\nENDSEC;\nEND-ISO-10303-21;"));
}

async function api() { const a = new IfcAPI(); await a.Init(); return a; }

function inspect<T>(a: IfcAPI, bytes: Uint8Array, run: (id: number) => T): T {
  const id = a.OpenModel(bytes);
  try { return run(id); } finally { a.CloseModel(id); }
}
const refs = (list: any[] | undefined) => (list ?? []).map((v: any) => v.value);
function elementId(a: IfcAPI, id: number, g: string): number {
  const ids = a.GetLineIDsWithType(id, IFCFURNITURE);
  for (let i = 0; i < ids.size(); i++) if ((a.GetLine(id, ids.get(i)) as any).GlobalId.value === g) return ids.get(i);
  return -1;
}
function relationsOf(a: IfcAPI, id: number, type: number, element: number) {
  const out: any[] = []; const ids = a.GetLineIDsWithType(id, type);
  for (let i = 0; i < ids.size(); i++) out.push(a.GetLine(id, ids.get(i)));
  return out.filter(rel => refs(rel.RelatedElements ?? rel.RelatedObjects).includes(element));
}

describe("duplicateFurniture", () => {
  it("creates a distinct element with the caller GlobalId, same containment/type/material, and never mutates input bytes", async () => {
    const a = await api(); const input = richFixture(); const snapshot = input.slice();
    const out = duplicateFurniture(a, input, guid, copyGuid);
    expect(input).toEqual(snapshot);
    expect(out).not.toEqual(input);
    inspect(a, out, id => {
      const src = elementId(a, id, guid), copy = elementId(a, id, copyGuid);
      expect(src).toBeGreaterThan(0); expect(copy).toBeGreaterThan(0); expect(copy).not.toBe(src);
      expect((a.GetLine(id, copy) as any).Name.value).toBe("Chair");
      const contained = relationsOf(a, id, IFCRELCONTAINEDINSPATIALSTRUCTURE, copy);
      expect(contained).toHaveLength(1);
      expect(refs(contained[0].RelatedElements)).toContain(src);
      expect(contained[0].RelatingStructure.value).toBe(fx.storey);
      const type = a.GetLine(id, fx.typeRel) as any; expect(refs(type.RelatedObjects)).toEqual([src, copy]);
      const mat = a.GetLine(id, fx.materialRel) as any; expect(refs(mat.RelatedObjects)).toEqual([src, copy]);
    });
    // Original is unchanged in meaning.
    expect(readFurniturePose(a, out, guid)).toEqual(readFurniturePose(a, input, guid));
  });

  it("copies the placement so the copy starts at the source pose and can then move independently", async () => {
    const a = await api(); const out = duplicateFurniture(a, richFixture(), guid, copyGuid);
    expect(readFurniturePose(a, out, copyGuid)).toEqual(readFurniturePose(a, out, guid));
    const moved = writeFurniturePose(a, out, copyGuid, { position: [4, 5, 0], yawRadians: 0.5 });
    expect(readFurniturePose(a, moved, guid).position).toEqual([1, -1, 0]);
    expect(readFurniturePose(a, moved, copyGuid).position[0]).toBeCloseTo(4);
  });

  it("applies an optional world offset to the copy only", async () => {
    const a = await api(); const out = duplicateFurniture(a, richFixture(), guid, copyGuid, { offset: [0.5, 0.25, 0] });
    expect(readFurniturePose(a, out, guid).position).toEqual([1, -1, 0]);
    const p = readFurniturePose(a, out, copyGuid).position;
    expect(p[0]).toBeCloseTo(1.5); expect(p[1]).toBeCloseTo(-0.75); expect(p[2]).toBeCloseTo(0);
  });

  it("gives the copy owned mapped geometry that scales independently while sharing the source representation map", async () => {
    const a = await api(); const out = duplicateFurniture(a, richFixture(), guid, copyGuid);
    expect(readFurnitureGeometryScale(a, out, copyGuid)).toEqual([1, 1, 1]);
    const scaled = writeFurnitureGeometryScale(a, out, copyGuid, [2, 2, 2]);
    expect(readFurnitureGeometryScale(a, scaled, guid)).toEqual([1, 1, 1]);
    expect(readFurnitureGeometryScale(a, scaled, copyGuid)).toEqual([2, 2, 2]);
    // Exactly one IfcRepresentationMap: shared source geometry, no deep copy of it.
    expect(new TextDecoder().decode(scaled).match(/IFCREPRESENTATIONMAP\(/g)).toHaveLength(1);
  });

  it("deep-copies the single-owner source provenance so each element keeps valid, unshared nominal dimensions", async () => {
    const a = await api(); const out = duplicateFurniture(a, richFixture(), guid, copyGuid);
    expect(readFurnitureSourceDimensions(a, out, guid)).toEqual(readFurnitureSourceDimensions(a, out, copyGuid));
    expect(readFurnitureSourceDimensions(a, out, copyGuid)).not.toBeNull();
  });

  it("is deterministic for identical inputs", async () => {
    const a = await api();
    expect(duplicateFurniture(a, richFixture(), guid, copyGuid)).toEqual(duplicateFurniture(a, richFixture(), guid, copyGuid));
  });

  it("round-trips through a second duplicate (copy of a copy)", async () => {
    const a = await api(); const once = duplicateFurniture(a, richFixture(), guid, copyGuid);
    const twice = duplicateFurniture(a, once, copyGuid, "0Zz9fmKcdn6c9fX3LLRJBk");
    expect(readFurniturePose(a, twice, "0Zz9fmKcdn6c9fX3LLRJBk")).toEqual(readFurniturePose(a, twice, guid));
  });

  it("rejects a missing source, invalid GlobalId and a GlobalId that already exists, with explicit codes", async () => {
    const a = await api(); const bytes = richFixture();
    const code_ = (run: () => unknown) => { try { run(); } catch (e) { return (e as FurnitureLifecycleError).code; } return "none"; };
    expect(code_(() => duplicateFurniture(a, bytes, "nope-nope-nope-nope-no", copyGuid))).toBe("not-found");
    expect(code_(() => duplicateFurniture(a, bytes, guid, "short"))).toBe("invalid-global-id");
    expect(code_(() => duplicateFurniture(a, bytes, guid, guid))).toBe("duplicate-global-id");
    expect(code_(() => duplicateFurniture(a, bytes, guid, "3alYBHMR1G5AaThtWNzo_l"))).toBe("duplicate-global-id");
  });
});

describe("removeFurniture", () => {
  it("removes the element, cleans containment/type/material relations and properties, and keeps shared type/material/geometry", async () => {
    const a = await api(); const input = richFixture(); const snapshot = input.slice();
    const out = removeFurniture(a, input, guid);
    expect(input).toEqual(snapshot);
    const text = new TextDecoder().decode(out);
    expect(text).not.toContain(guid);
    expect(() => readFurniturePose(a, out, guid)).toThrow();
    inspect(a, out, id => {
      expect(refs((a.GetLine(id, fx.contain) as any).RelatedElements)).not.toContain(fx.chair);
      // Type and material objects survive; the now-empty relations are gone.
      expect((a.GetLine(id, fx.type) as any).Name.value).toBe("Chair type");
      expect((a.GetLine(id, fx.material) as any).Name.value).toBe("Oak");
    });
    expect(text).not.toContain("3pEfmKcdn6c9fX3LLRJBkB"); // emptied type relation deleted
    expect(text).not.toContain("3pEfmKcdn6c9fX3LLRJBkC"); // emptied material relation deleted
    expect(text).not.toContain("chair0"); // owned single-object source property set removed
    expect(text).toContain("IFCREPRESENTATIONMAP("); // shared source geometry remains
  });

  it("keeps shared relations for other elements", async () => {
    const a = await api();
    const twice = duplicateFurniture(a, richFixture(), guid, copyGuid);
    const out = removeFurniture(a, twice, guid);
    inspect(a, out, id => {
      const copy = elementId(a, id, copyGuid);
      expect(refs((a.GetLine(id, fx.typeRel) as any).RelatedObjects)).toEqual([copy]);
      expect(refs((a.GetLine(id, fx.materialRel) as any).RelatedObjects)).toEqual([copy]);
    });
    expect(readFurnitureSourceDimensions(a, out, copyGuid)).not.toBeNull();
  });

  it("add then remove restores a canonical equivalent of the original model", async () => {
    const a = await api(); const original = richFixture();
    const roundTrip = removeFurniture(a, duplicateFurniture(a, original, copyGuidSource(), copyGuid), copyGuid);
    const normalized = (b: Uint8Array) => inspect(a, b, id => {
      const furniture = a.GetLineIDsWithType(id, IFCFURNITURE); const names: string[] = [];
      for (let i = 0; i < furniture.size(); i++) names.push((a.GetLine(id, furniture.get(i)) as any).GlobalId.value);
      return names.sort().join(",") + "|" + refs((a.GetLine(id, fx.contain) as any).RelatedElements).sort().join(",") + "|" +
        refs((a.GetLine(id, fx.typeRel) as any).RelatedObjects).join(",") + "|" + refs((a.GetLine(id, fx.materialRel) as any).RelatedObjects).join(",");
    });
    expect(normalized(roundTrip)).toBe(normalized(original));
  });

  it("refuses with an explicit code when the element is referenced by a relation it cannot safely clean", async () => {
    const a = await api();
    const withAssign = richFixture(f => [`#${f.next}=IFCGROUP('3pEfmKcdn6c9fX3LLRJBkD',$,'Seating',$,$);`,
      `#${f.next + 1}=IFCRELASSIGNSTOGROUP('3pEfmKcdn6c9fX3LLRJBkE',$,$,$,(#${f.chair}),$,#${f.next});`]);
    try { removeFurniture(a, withAssign, guid); expect.unreachable(); }
    catch (e) { expect((e as FurnitureLifecycleError).code).toBe("unsupported-relation"); expect((e as Error).message).toMatch(/IfcRelAssignsToGroup/i); }
  });

  it("refuses to remove an element that fills an opening and one with dependent placements", async () => {
    const a = await api();
    const hosted = richFixture(f => [`#${f.next}=IFCOPENINGELEMENT('1Ku0EdV$X7qxV8_lKszoFq',$,'Opening',$,$,#${f.place},$,$,.OPENING.);`,
      `#${f.next + 1}=IFCRELFILLSELEMENT('31lGOMRir8fONp6JFdxBYF',$,$,$,#${f.next},#${f.chair});`]);
    try { removeFurniture(a, hosted, guid); expect.unreachable(); }
    catch (e) { expect((e as FurnitureLifecycleError).code).toBe("hosted-element"); }
    const dependent = richFixture(f => [`#${f.next}=IFCLOCALPLACEMENT(#${f.place},#${f.axis});`]);
    try { removeFurniture(a, dependent, guid); expect.unreachable(); }
    catch (e) { expect((e as FurnitureLifecycleError).code).toBe("dependent-placement"); }
  });

  it("reports an unknown GlobalId as not-found", async () => {
    const a = await api();
    try { removeFurniture(a, richFixture(), "0AAAAAAAAAAAAAAAAAAAAA"); expect.unreachable(); }
    catch (e) { expect((e as FurnitureLifecycleError).code).toBe("not-found"); }
  });
});

function copyGuidSource() { return guid; }
