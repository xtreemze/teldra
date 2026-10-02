# ADR 0006: Sweet Home 3D semantic import boundary

Status: accepted

## Decision

Teldra imports Sweet Home 3D projects from the documented `Home.xml` entry inside the `.sh3d` ZIP container.

Teldra will not deserialize the Java-serialized `Home` entry.

The implementation is clean-room: it is based on the public XML/DTD and model API contract plus Teldra-authored fixtures. Sweet Home 3D implementation code is not copied into Teldra.

## Units and coordinates

Sweet Home 3D `Home.xml` stores geometric lengths in centimetres. The parser normalizes lengths to SI metres.

The parser does not silently reinterpret or rotate the source coordinate frame. It preserves SH3D plan coordinates as source-frame X/Y values in metres. Conversion into Teldra/IFC's canonical right-handed Z-up frame belongs to an explicit mapping layer with fixtures proving the transform.

Angles documented by Sweet Home 3D as radians, including camera yaw/pitch/FOV and furniture/wall angles, remain radians.

## Identity and provenance

Where SH3D supplies an `id`, it is preserved as source identity. For elements where IDs are optional, the semantic representation also records an ordinal source reference. IFC GlobalIds generated during import must remain distinct canonical identities and retain SH3D provenance for repeatable re-import.

## Security

The importer:

- reads exactly one `Home.xml` entry;
- never extracts the archive to arbitrary filesystem paths;
- places a bounded size limit on `Home.xml`;
- rejects encrypted XML entries;
- rejects DTD/entity declarations;
- never invokes Java deserialization.

## Scope

The first semantic model covers levels, walls, rooms, ordinary furniture, doors/windows, lights, materials, and cameras.

Some SH3D constructs may initially be reported as unsupported rather than silently discarded. IFC mapping and loss reporting are separate steps so parsing fidelity can be tested independently of BIM conversion.
