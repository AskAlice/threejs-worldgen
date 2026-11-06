# 14: Rule: optimized instancing and buffer geometry wherever possible

**What to build:** All work must use optimized instancing and buffer geometry wherever possible.

**Blocked by:** None (can start immediately).

**Status:** ready-for-human

- [ ] Behaviour described in the imported issue body is implemented

**Type:** task · imported from GitHub

## Imported issue

- Imported from: [#41](https://github.com/AskAlice/threejs-worldgen/issues/41)
- State: OPEN
- Milestone: threejs-worldgen · M1 — Worlds (WORLDGEN.md phases 1–4)
- Labels: enhancement, ready-for-human, verify-done, task, project:threejs-worldgen, area:docs
- Packages: shared
- Opened: 2026-10-13

## Request

All work must use optimized instancing and buffer geometry wherever possible.

## Invariant

Repeated objects → InstancedMesh / BatchedMesh / InstancedBufferGeometry with per-instance attributes (or storage buffers), never a Mesh per object; geometry built directly into typed-array BufferAttributes; static parts merged; materials shared and varied per instance in TSL; instance buffers updated in place; explicit bounding spheres.

Added to README "Package conventions" (2026-10-09) and broadcast to the six running package agents with a request to audit their packages before reporting.

## Completion assessment

At migration the committed code (`worldgen-design` at 6f1b8ff) appears to complete this: **done, medium confidence**. Labelled `verify-done`: confirm and close.

- Conventions: instancing and buffer geometry for anything that repeats (14a8153)
- Scatter pools instanced LODs that share instance buffers (packages/scatter/src/scatter.ts)
- City buildings via BatchedMesh (packages/city/src/buildings.ts)
- Sky shells are one instanced sphere and labels one instanced quad (2dbb817)
- Instanced meshes in fauna, vehicles, props, weathering and grass (packages/vehicles/src/index.ts)

---
<sub>Migrated from Linear ASK-41 · created 2026-10-09 by Alice Knag · priority: High</sub>
<!-- linear-id: ASK-41 -->
