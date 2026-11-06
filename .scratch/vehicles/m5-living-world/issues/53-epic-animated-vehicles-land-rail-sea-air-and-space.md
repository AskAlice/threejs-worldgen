# 53: Epic: Animated vehicles — land, rail, sea, air and space

**What to build:** Add animated trains, cars, airplanes, rockets, bicycles, fishing boats, cruise liners, speedboats, hovercraft, aircraft carriers and fighter jets.

**Blocked by:** None (can start immediately).

**Status:** ready-for-human

- [ ] Behaviour described in the imported issue body is implemented

**Type:** epic · imported from GitHub

## Imported issue

- Imported from: [#35](https://github.com/AskAlice/threejs-worldgen/issues/35)
- State: OPEN
- Milestone: threejs-worldgen · M5 — Living world
- Labels: enhancement, ready-for-human, epic, project:threejs-worldgen, package:vehicles
- Packages: vehicles
- Opened: 2026-10-13

## Request

Add animated trains, cars, airplanes, rockets, bicycles, fishing boats, cruise liners, speedboats, hovercraft, aircraft carriers and fighter jets.

## Approach

New `threejs-vehicles`: parametric generators per class (proportions, colours, liveries seeded), instanced and LODed, animated along networks:

* Land: cars and bicycles on the city road graph (lane-following, intersections, speed by road type); trains on rail lines between settlements (generated rail graph with gentle grades, bridges, tunnels later).
* Sea: fishing boats, speedboats, cruise liners, aircraft carriers, hovercraft (crosses water and flat land) on sea lanes between coastal settlements; buoyancy from threejs-water `waterAt`.
* Air: airplanes on routes between airports (generated at large settlements), fighter jets (carrier/airbase ops), rockets launched from spaceports (ballistic/orbital trajectories into the threejs-sky solar system).
* Densities driven by population (hex grid epic).

## Acceptance criteria

All 11 vehicle types, seeded traffic that never looks random-teleporting, floating-origin safe, R3F components, weather states apply.

## Progress so far

Assessed at migration against committed code (`worldgen-design` at 6f1b8ff): **partial**.

- [x] All 11 vehicle types
- [x] Seeded generation and traffic
- [x] R3F components
- [x] Weather states apply
- [x] Cars follow city RoadGraph; boats ride threejs-water waves
- [ ] Rail lines between settlements, sea lanes, airports and spaceports as generated networks
- [ ] Densities driven by population
- [ ] LODs
- [ ] Traffic never looks random-teleporting (self-reported: hovercraft flip instantly at path ends; no car-following/collision avoidance)
- [ ] Floating-origin safety not demonstrated in code or tests

Evidence:
- All 11 requested vehicle types (cars, bicycles, trains, fishing boats, speedboats, cruise liners, hovercraft, carriers, airliners, fighter jets, rockets) (84d767f; packages/vehicles/README.md)
- R3F <Fleet> and <Vehicle> components (packages/vehicles/src/react.tsx)
- Wet/snowy/burnt/damaged/on-fire states via threejs-weathering (84d767f; packages/vehicles/package.json)
- Routes are planned per vehicle (planRoute, circles, paths, pads) rather than generated rail/sea-lane/air networks (packages/vehicles/src/placement.ts)
- No LOD and no population-driven density in vehicles (packages/vehicles/src (no lod/population references at HEAD))

<details><summary>Linear discussion (1 comment)</summary>

**Alice Knag** · 2026-10-11

2026-10-11: threejs-vehicles committed and pushed. 12/12 tests, clean typecheck. Headless check: 58–60 fps, 223 vehicles in 80 draw calls, shadows on, no WebGPU errors.

All 11 requested types are in: cars (sedan, hatchback, SUV, pickup, van, bus), bicycles, trains (locomotive plus passenger and freight wagons), fishing boats, speedboats, cruise liners, hovercraft, aircraft carriers with parked jets, airliners and light aircraft, fighter jets, and rockets with 1–3 stages.

Rendering and motion:
- One single-material InstancedMesh per part, tinted via an attribute (follows #8).
- Wheels steer and spin, cars follow a city RoadGraph or splines, trains pull wagons, boats ride threejs-water waves with wakes, planes bank, rockets launch on a gravity turn and drop stages.

Weather:
- wet, snowy, burnt, damaged and on fire per vehicle;
- moving vehicles shed snow, rain puts out fires, damage dents and stops vehicles.

Also: `vehicleAssets()` and `planRoute()`, `<Fleet>` and `<Vehicle>`, and `/vehicles.html` (gallery) plus `?scene` (live scene).

Known limits:
- No car-following or collision avoidance.
- Hovercraft flip instantly at the ends of the demo path.
- Damaged aircraft keep flying.
- The ember glow at full heat looks lava-like.
- `PlacementRule`/`isPlausible` are mirrored, not imported, because worldgen depends on vehicles (cycle); props did the same. Moving both into threejs-biomes would remove the duplication: #48.

</details>

Related: #8

---
<sub>Migrated from Linear ASK-33 · created 2026-10-09 by Alice Knag · priority: High</sub>
<!-- linear-id: ASK-33 -->
