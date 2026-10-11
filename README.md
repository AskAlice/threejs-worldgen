# threejs-worldgen

Procedural terrain and scenery for **three.js** and **react-three-fiber**. Each kind of thing you'd scatter or grow in
an outdoor scene is its own small package, and every package shares one idea of where the ground is.

**[Website](https://askalice.github.io/threejs-worldgen/)** · **[Live demo](https://askalice.github.io/threejs-worldgen/demo/)** · **[API docs](https://askalice.github.io/threejs-worldgen/docs/)**

[![A dense meadow on rolling hills](media/hero.jpg)](https://askalice.github.io/threejs-worldgen/demo/)

## Packages

| Package | What it does |
|---|---|
| [`threejs-grass`](https://github.com/AskAlice/threejs-worldgen/tree/main/packages/grass) | Infinite, terrain-aware WebGPU grass: 12 presets, four LODs, wind, interaction, grass maps and a terrain painter. Includes a React component. |
| [`threejs-heightfield`](https://github.com/AskAlice/threejs-worldgen/tree/main/packages/heightfield) | Bakes meshes into fast `(x, z) => y` height lookups, with slope and ray-marching. The ground every other package stands on. |

Next up: 20 biomes, mountains, water, forests and savannas, and cities. [WORLDGEN.md](WORLDGEN.md) has the design
and the package plan. Every package takes a `Terrain` (a mesh or a height function) the same way `threejs-grass` does.

## Development

```bash
npm install          # links the workspaces
npm run dev          # demos at http://localhost:5173 and /r3f.html, running straight from packages/*/src
npm run typecheck
npm test             # node --test packages/*/test/*.test.ts
npm run build        # every package's dist/, in dependency order
npm run build:site   # landing page, demos and API docs into site/
```

New package: add `packages/<name>/` with its own `package.json` (`build` and `prepublishOnly` scripts), then list it in
`workspaces` (after its dependencies), in the `paths` in `tsconfig.json`, in the aliases in `example/vite.config.ts`
and in the `entryPoints` in `typedoc.json`.

## Package conventions

Every package follows the same shape, so worlds compose and every setting is live:

- **Parametric:** one options object per feature, every number in it has a default, and `set(partial)` / `reset(full)`
  change it at runtime. Options are plain JSON (no functions or class instances except where noted), so they can be
  saved, shared, sent to a worker and bound to a GUI.
- **Deterministic:** everything derives from `seed` and world position. The same options give the same world.
- **Plain three.js first:** an imperative class with `.object` (add it to your scene), `update()` (once per frame) and
  `dispose()`. Async setup goes in `static create()`.
- **Optional React Three Fiber:** `src/react.tsx` (the `./react` export) wraps each class in a component whose props are
  the options, calls `reset(props)` on every render and `update()` in `useFrame`. `react` and `-three/fiber` are
  optional peer dependencies; the core never imports them.
- **WebGPU:** `three/webgpu` and TSL node materials, like `threejs-grass`.
- **Instancing and buffer geometry:** anything that repeats is an `InstancedMesh`, `BatchedMesh` or
  `InstancedBufferGeometry` with per-instance attributes, never a mesh per object. Geometry is built straight into
  typed-array `BufferAttribute`s, static parts are merged into few draw calls, materials are shared and varied per
  instance in TSL, and bounding spheres are set explicitly.
- **Plain TypeScript:** no constructor parameter properties, enums or namespaces (Node runs the tests by stripping types).
- **Imports:** relative imports end in `.ts`; other packages are imported by name (they resolve to `src/` in development
  through the `worldgen-source` export condition).
- **Tests:** `packages/<name>/test/*.test.ts`, run by `node --test` (no DOM, no GPU), for the pure logic.

## Releasing

Each package is versioned and released on its own. Tags are `<package>@<version>`:

```bash
npm version minor -w threejs-grass        # bumps packages/grass/package.json only
git commit -am "threejs-grass 0.3.0"
git tag threejs-grass@0.3.0 && git push origin main threejs-grass@0.3.0
```

The tag starts `.github/workflows/release.yml`, which checks the tag against the package version, runs typecheck
and the tests, publishes that one package to npm (using the `NPM_TOKEN` repo secret) and creates a GitHub release.
Release a package's dependencies first. For example, `threejs-grass` needs its `threejs-heightfield` range on npm.

To publish every package from your machine instead, run `npm run publish:all` (`scripts/publish-all.sh`;
add `--dry-run` to preview). It builds once, then publishes each package whose version isn't on npm yet, dependencies
first. Packages marked `"private": true` and versions already on npm are skipped, so it's safe to re-run. It
authenticates with `NPM_TOKEN` if that's set, otherwise your `npm login`, otherwise it asks. Set `NPM_OTP` if your
account requires a 2FA code to publish. It doesn't create tags or GitHub releases.

## License

Apache-2.0
