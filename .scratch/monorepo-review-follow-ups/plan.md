# Execution plan for the remaining review refactors

From the architecture review of tickets 02, 05, 08, 09, checked against the running package wave.

## Order

1. **02 and 08 in parallel** — different packages, no interdependency, both small.
2. **02 before 09** — both rewrite `mpm-lava.ts`; write the docs before deleting the helpers they describe.
3. **09 after 03** — `applySchema` replaces resolvers built on `merge`; doing it first means rewriting it twice.
4. **05 last** — the only cross-package change: needs 04's adoption rule, 01's settled `set`/`reset` for `apply`, and three quiet `react.tsx` files.

## Designs

### 02 — particles API honest
Add a documented `get writeHead(): number` to the solver, use it in the lava vent, delete the `as unknown as { head }` cast. Document `SnowShading`'s nine bare members and add units/ranges to the lava and snow constants. Test: `writeHead === (before + k) % capacity`, including wraparound. Files: `particles/src/{mpm,mpm-lava,mpm-snow}.ts`, `particles/test/mpm.test.ts`.

### 08 — typed vehicle parameters
Derive values from the parameter definitions:
```ts
type ParamValue<D> = D extends {type:'number'} ? number : D extends {type:'boolean'} ? boolean
  : D extends {type:'choice'; options: readonly (infer O)[]} ? O
  : D extends {type:'color'} ? string : never
export type VehicleParamsOf<K extends VehicleType> = Partial<{ [P in keyof (typeof VEHICLE_KINDS)[K]['params']]:
  ParamValue<(typeof VEHICLE_KINDS)[K]['params'][P]> }>
```
Requires `VEHICLE_KINDS` to keep literals (`satisfies Record<VehicleType, VehicleKind>`, export `typeof`). Keep the loose `VehicleParams` as the internal generator type so generators and models are unchanged. Public surface: `buildVehicle<K>`, `defaultParams<K>`, `VehicleSettings`, `TrafficEntry`, `FleetGroup.params`; one cast at the `Vehicle` boundary. Test with `@ts-expect-error` on a wrong type and an unknown key. Risk: discriminated `FleetGroup` could ripple — fall back to typing only the entry points.

### 09 — one MPM sanitiser
New `particles/src/sanitize.ts`: a field-spec union (number, integer, vector, range, colour, colours, enum, boolean, seed, string) with `min`/`max`, plus one dependent bound, and `applySchema(o, schema)` mutating in place. Per-solver schemas: `MPM_SCHEMA`, `LAVA_SCHEMA`, `PUDDLE_SCHEMA`, `SPLASH_SCHEMA`, `FLUID_SURFACE_SCHEMA`. Delete the local `num`/`int`/`vec`/`hex` helpers in all resolver functions. `MPMOptions.materials` stays hand-written (dynamic keys). Files: `sanitize.ts` (new), `mpm-reference.ts`, `mpm-lava.ts`, `mpm-water.ts`, `fluid-surface.ts`.

### 05 — one R3F lifecycle hook
New package `packages/r3f` (`threejs-r3f`) exporting `useField(binding, ref)` over a framework-free `createFieldBinding`, with a `FieldBinding` of `key`, `props`, `create`, `apply`, optional `adopt`, optional `frame`. Lifecycle: adopt-once at create, cancel-safe async create, apply latest props each render, imperative handle, per-frame adopt (apply, never recreate) then frame.
Ticket 04 is expressed by the optional `adopt` phase: present = both entry points adopt a late terrain; absent = neither does.
Files: new package, root `package.json` workspaces, `tsconfig.json` paths, `typedoc.json`, the three `react.tsx` files, `grass/test/lifecycle.test.ts`.
Decision needed: publish a new package versus share an internal module.

## Collisions

- 02: `mpm-lava.ts`/`mpm-snow.ts` are follow-up 01's files (now landed) and 09's target — safe now, but before 09.
- 08: the whole vehicles package is the vehicles wave's — wait.
- 09: shares `mpm-reference.ts`/`options.ts` with 03 and `mpm-lava.ts`/`mpm-water.ts` with the particles wave — wait for both.
- 05: `grass/src/react.tsx` is mid-edit by 04; city/particles wrappers belong to their waves — land last.
