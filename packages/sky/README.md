# threejs-sky

Skies for three.js from an ant's eye view to orbital mechanics. A physically based, layered atmosphere that works on
the ground and from space (troposphere to exosphere, with the Kármán line as the edge of space), sparse Gaussian
clouds, a sun and a moon on Keplerian orbits (phases, eclipses and seasons emerge from geometry), a seeded star field
and Milky Way that turn with sidereal time, shooting stars, city lights on the night side, and the day/night lighting
that goes with them: sun and moon lights, a night fill so nights are never pitch black, image-based lighting re-rendered
from the sky, fog colour, an exposure suggestion and a `night` value other packages can bind. Part of [threejs-worldgen](https://github.com/AskAlice/threejs-worldgen).

```bash
npm i threejs-sky three
```

```ts
import * as THREE from 'three/webgpu'
import { Sky } from 'threejs-sky'

const sky = await Sky.create({
  renderer, scene, camera,
  clock: { date: '2026-08-12T19:00:00Z', dayLength: 600 }, // a 10-minute day
  observer: { latitude: 47, longitude: 8 },
  shootingStars: { shower: 80 },                           // the Perseids, roughly
  lighting: { fogDensity: 0.0008, autoExposure: true },
})
sky.follow(controls.target)                                // centre sun shadows on what you look at

renderer.setAnimationLoop(() => {
  sky.update()                                             // once per frame, before rendering
  renderer.render(scene, camera)
})

sky.setTimeOfDay(6.5)                                      // 06:30 local solar time
sky.set({ atmosphere: { mie: 2e-5 } })                     // hazy day; every setting is live
sky.state.moonIllumination                                 // 0..1, from the real geometry
sky.layerAt()                                              // 'troposphere' … 'exosphere' for the camera
sky.cloudCover(x, 0, z)                                    // 0..1: make it rain where the clouds are
sky.setNightLights((lat, lon) => population(lat, lon))     // city lights from your own data
myWindowMaterial.emissiveNode = glow.mul(sky.uniforms.night) // lit windows at night
```

Needs `WebGPURenderer` from `three/webgpu` (it falls back to WebGL 2 by itself). Everything is a deterministic function
of `seed` and time. Settings are plain JSON with defaults for every number, and `set(partial)` / `reset(full)` change
them at runtime.

### React Three Fiber

```tsx
import { Sky, SolarSystem, useSkyTime } from 'threejs-sky/react'

function Clock() {
  const t = useSkyTime()                                   // re-renders 4×/s
  return <Html>{t.date.toUTCString()} <button onClick={() => t.setPaused(!t.paused)}>⏯</button></Html>
}

<Canvas gl={async (props) => { const r = new WebGPURenderer(props as any); await r.init(); return r }}>
  <Sky clock={{ dayLength: 300 }} observer={{ latitude: 52 }} stars={{ magnitudeLimit: 7.5 }}>
    <Clock />
  </Sky>
</Canvas>
```

| Component / hook | What it does |
|---|---|
| `<Sky {...SkyInput} world? camera?>` | The whole sky. Props are the settings below; `ref` gives the `Sky` instance. Children get the context. |
| `<Stars {...StarsInput}>` | Star field and Milky Way on their own (space scenes). Inside `<Sky>` it follows that sky. |
| `<ShootingStars {...ShootingStarsInput}>` | Meteors on their own. Inside `<Sky>` they follow its clock and only show at night. |
| `<SolarSystem {...SolarSystemInput} clock? materials?>` | Orbital view. Inside `<Sky>` it shows that sky's system at its time; outside it runs its own clock. |
| `useSkyTime(fps = 4)` | `{ date, time, rate, paused, solarTime, setDate, setTimeScale, setDayLength, setPaused, advance, setTimeOfDay }` |
| `useSky()` | The nearest `Sky` instance. |

## What's inside

| Export | What it does |
|---|---|
| `Sky` | Runs everything: clock, star system, observer, dome, stars, meteors, lights, IBL, fog, exposure. |
| `SkyClock` | Simulation time: `date`, `timeScale`, `dayLength`, `paused`; `setDate`, `advance`, `update(dt)`. |
| `StarSystem` | Star, home planet, moon and seeded procedural planets: `position`, `velocity`, `orientation`, `solarDay`. |
| `solveKepler`, `orbitState`, `orbitPath`, `orbitalPeriod` | Two-body orbits from classical elements (Newton with a bisection safeguard, fine to e ≈ 0.99). |
| `observe(system, time, observer, camera)` | A `SkyState`: sun and moon directions, elevations, phase, solar time, the celestial rotation. |
| `sunTimes`, `moonPhase`, `moonPhaseName` | Sunrise/sunset by bisection; phase from the sun–moon–observer angle. |
| `skyRadiance`, `transmittance` | The atmosphere on the CPU, same model as the shader (light colours, fog, exposure). |
| `computeLighting` | Sun and moon light colour and intensity, fog colour, sky luminance, `night`, exposure. Pure. |
| `apsides(elements, gm, from)`, `StarSystem.apsides(name)` | Periapsis/apoapsis distances, positions and next passage times, named perigee/apogee or perihelion/aphelion. |
| `layerAt(altitude, layers)`, `inSpace`, `resolveAtmosphere` | Atmosphere layers and the Kármán line; altitudes scaled to the planet radius. |
| `AltitudeShells`, `resolveShells` | Labelled shells (troposphere, ionosphere, Kármán line, the moon's apogee): one instanced sphere and one instanced label quad. |
| `clipPlanes(height, radius, atmosphereHeight?, reach?)`, `sky.clipPlanes()` | Near/far planes from an ant on the ground to past the moon (use with `reversedDepthBuffer`). |
| `Clouds`, `cloudCover(options, seed, point)` | Sparse Gaussian clouds and the weather field they are placed from. |
| `bakeNightLights(field)`, `nightLightsNode(u, bodyDir, sunDir)` | City lights: bake a `(lat, lon) => 0..1` field; the TSL node for planet terrain materials. |
| `Stars`, `ShootingStars`, `SolarSystem` | The individual layers, each with `.object`, `update()`, `set()`, `reset()` and `dispose()`. |
| `createSkyDome`, `skyColorNode`, `milkyWayNode`, `moonAlbedo` | The TSL building blocks, for your own materials. |

### Frames, planets and floating origins

`observer.frame` picks what render space means:

- **`'local'`** (default): a flat tangent frame at the observer, x east, y up, z south. Flat worlds, and terrain built in
  a `threejs-biomes` `LocalFrame`, use it. A flat world sits at `observer.latitude`/`longitude` on a virtual planet the
  size of the home planet, which is always right under the camera, so the horizon and the atmosphere stay correct.
- **`'planet'`**: the home planet's body-fixed frame (planet-centred, +Y north pole, longitude 0 on +Z, the same as
  `threejs-biomes` planets). The observer is wherever the camera is, so flying around the planet changes the local time.
  Set `observer.planetCenter` to the planet centre's render position to use a floating origin.

Pass a planet `World` as `world` and the home planet takes its radius (and, in the local frame, its `origin`).

The sky dome is analytic per pixel and pinned to the camera's far plane. From orbit it draws the planet ball with its
glowing limb and night side, and terrain simply covers it. The ray maths uses the closest-approach form, so it stays
accurate from millions of kilometres away. `SolarSystem` keeps everything in float64 metres until the last step. Then
it makes positions relative to an origin body (`origin` + `originOffset`), scales them, and pulls bodies beyond
`maxDistance` in along their true direction with their size scaled to match.

```ts
const solar = new SolarSystem({ model: sky.system, exaggerateSizes: 300, origin: 'sun' })
scene.add(solar.object)
solar.update(sky.clock.time, camera)                      // each frame
terrain.matrixAutoUpdate = false
solar.bodyMatrix('home', terrain.matrix)                  // a planet World on the home planet, spinning with it
```

### Atmosphere layers and space

The atmosphere has real layers: the troposphere (weather and clouds), the stratosphere (ozone), the mesosphere, the
thermosphere/ionosphere, and the exosphere. Their altitudes are Earth's by default. With `atmosphere.scaleWithRadius`
(on by default) they scale with the planet radius, and so do the scattering scale heights and cloud bands. Scattering
coefficients scale inversely, so a 120 km planet still gets an Earth-coloured sky. Above the Kármán line the sky is
black, stars are at full brightness and fog and cloud haze switch off. A thin airglow shell at the mesopause shows as a
green line on the limb at night. `sky.layers`, `sky.layerAt(altitude?)` and `sky.state.layer` report all of this.

### Clouds

Clouds are made of a few thousand to tens of thousands of anisotropic 3D Gaussians. Each splat is one instance of a
camera-facing quad that integrates its Gaussian analytically along the view ray. Splats are depth-sorted every few
frames and blended back to front. A seeded weather field places cumulus clusters (flat bases, puffy tops), stratus
sheets where cover is high, and cirrus streaks along the wind, all drifting with `clouds.wind`. Lighting is a cheap
single-scattering model: dark bases, bright tops, a forward-scattering silver lining, the planet's shadow at dusk and
haze with distance. A detailed layer covers `range` around the camera (fewer, bigger splats far away). A planet-wide
layer of large flat splats takes over from orbit, and the two cross-fade with altitude. `sky.cloudCover(x, y, z)`
returns the same field, so rain and shadows can line up with the clouds.

### Nights

Moonlight scales with the moon's phase. A hemisphere fill (`lighting.nightAmbient`) and airglow keep moonless nights
dark but never black. Seen from altitude, the night side glows with city lights from `sky.setNightLights(field | texture)`
or a seeded procedural field. They switch on with the local sun angle and are dimmed by clouds in front of them.
`sky.uniforms.night` (0..1) is there for lit windows and street lamps. Planet terrain can add
`nightLightsNode(sky.uniforms.nightLights, bodyNormal, bodySunDir)` to its emissive.

### Draw calls

Everything repeated is instanced, so the draw count stays flat:

| Layer | Draws |
|---|---|
| Sky dome | 1 |
| Stars and Milky Way (procedural, no geometry per star) | 1 |
| Meteors | 1 |
| Detailed clouds | 1 |
| Global clouds | 1 |
| All procedural planets and moons | 1 |
| All rings | 1 |
| All glows | 1 |
| All orbit lines | 1 |
| All apsis markers | 1 |
| All altitude shells / their labels | 1 / 1 |

The star is two more draws (sphere and glow). Each body with your own material gets its own mesh.

## Settings

### `Sky`

| Setting | Default | |
|---|---|---|
| `seed` | `1` | Seeds stars, meteors and procedural planets unless they set their own. |
| `clock` | see below | Time. |
| `system` | see below | The star system. |
| `observer` | `{ frame: 'local', latitude: 45, longitude: 0, planetCenter: [0,0,0] }` | Where you stand. |
| `atmosphere` | see below | Scattering physics. |
| `sun.discIntensity` / `sun.discScale` | `60` / `1` | HDR disc radiance (bloom) and size multiplier. |
| `moon.brightness` / `moon.discScale` | `1` / `1` | Disc brightness and size multiplier. |
| `moon.earthshine` | `0.3` | Glow of the dark side. |
| `moon.skyGlow` | `0.02` | How much moonlight brightens the night sky (physical ≈ 2e-6). |
| `stars`, `shootingStars`, `lighting`, `clouds`, `nightLights`, `shells` | see below | |

Object options (not JSON): `renderer`, `scene`, `camera`, `world`.

### `clock`

| Setting | Default | |
|---|---|---|
| `date` | `'2026-06-21T16:00:00Z'` | ISO string or Unix ms. The clock jumps when this value changes; otherwise it keeps running. |
| `timeScale` | `1` | Simulated seconds per real second. |
| `dayLength` | `0` | Real seconds per solar day; overrides `timeScale` when > 0. |
| `paused` | `false` | |
| `maxStep` | `0.25` | Longest real frame step accepted (a background tab doesn't skip hours). |

### `system`

| Setting | Default | |
|---|---|---|
| `seed` | sky `seed` | Procedural planets. |
| `star` | Sun: 696 000 km, 5772 K | `BodyOptions` overrides. |
| `home` | Earth: J2000 orbit, 23.44° tilt, sidereal day 86 164 s, radius 6371 km | Real dates give real seasons and sunrise times. |
| `moon` | Moon: mean J2000 orbit, tidally locked | `null` for no moon. Phases match the real Moon to within about a day. |
| `planets` | `5` | Seeded planets: rocky and desert inside, gas giants (some ringed) further out, ice giants beyond. |
| `bodies` | `[]` | Extra complete `BodyOptions` (e.g. more moons). |

`BodyOptions`: `name`, `kind`, `parent`, `radius`, `gm`, `orbit` (`semiMajorAxis`, `eccentricity`, `inclination`,
`longitudeOfAscendingNode`, `argumentOfPeriapsis`, `meanAnomalyAtEpoch`, `period` (0 = from GM)), `axialTilt`,
`siderealDay`, `rotationAtEpoch`, `tidallyLocked`, `surface`, `colors`, `temperature`, `albedo`, `rings`, `atmosphere`.

### `atmosphere`

| Setting | Default | |
|---|---|---|
| `enabled` | `true` | Off = airless (black sky, stars by day). |
| `height` | `100000` | Shell thickness, m. |
| `rayleigh` | `[5.802e-6, 13.558e-6, 33.1e-6]` | Per-metre scattering; blue sky. |
| `rayleighScaleHeight` / `mieScaleHeight` | `8000` / `1200` | m. |
| `mie` / `mieAbsorption` / `mieG` | `3.996e-6` / `4.4e-7` / `0.8` | Haze amount, absorption and forward glow. |
| `ozone` / `ozoneCenter` / `ozoneWidth` | `[0.65e-6, 1.881e-6, 0.085e-6]` / `25000` / `15000` | Twilight blue. |
| `density` | `1` | Multiplier on everything. |
| `sunIntensity` | `20` | Radiance scale. |
| `groundColor` | `'#2c3b2e'` | Ground seen through the air where no terrain is drawn (from orbit). |
| `airglow` | `[0.00025, 0.0004, 0.0009]` | Night-sky glow. |
| `airglowBand` / `airglowBandColor` | `1` / `[0.3, 1, 0.45]` | The green airglow shell between the mesopause and the Kármán line. |
| `layers` | Earth: troposphere 12 km, stratosphere 50 km, mesosphere 85 km, Kármán 100 km, thermosphere 600 km, exosphere 10 000 km | Layer tops. |
| `scaleWithRadius` | `true` | Scale all altitudes by radius / Earth radius (coefficients inversely). |
| `steps` / `lightSteps` | `16` / `6` | Ray-march samples (cost vs. quality). |

### `stars` (and `<Stars>`)

| Setting | Default | |
|---|---|---|
| `enabled`, `seed` | `true`, sky `seed` | |
| `brightness` | `1` | |
| `magnitudeLimit` | `7` | Faintest star under a dark sky. A brighter sky lowers it by 2.5·log10(sky / `darkSky`), so stars come out one by one at dusk and thin out under a full moon. |
| `darkSky` | `1e-4` | Sky luminance that counts as dark. |
| `density` | `1` | Stars per cell layer. |
| `twinkle` / `twinkleSpeed` | `0.6` / `1` | Scintillation, stronger near the horizon. |
| `size` / `saturation` | `1` / `1` | Point size (px) and black-body tint strength. |
| `milkyWay` | real galaxy | `enabled`, `intensity` (1), `pole` / `center` (ecliptic lon/lat), `width` (9°), `bulge` (1), `dust` (0.8), `detail` (1), `color`, `bulgeColor`. |

### `shootingStars` (and `<ShootingStars>`)

| Setting | Default | |
|---|---|---|
| `enabled`, `seed` | `true`, sky `seed` | |
| `rate` | `12` | Sporadic meteors per hour (elapsed real time; pausing the clock pauses them). |
| `shower` | `0` | Extra meteors per hour from the radiant (thousands = a storm). |
| `radiant` | `null` | `[azimuth, elevation]` in degrees, or seeded. |
| `minElevation` | `15` | |
| `duration` / `length` | `[0.35, 1.3]` s / `[6, 28]`° | |
| `trail` / `width` / `brightness` / `color` | `0.45` / `0.09`° / `1` / `'#dfe8ff'` | |

### `lighting`

| Setting | Default | |
|---|---|---|
| `sunIntensity` / `moonIntensity` | `3.4` / `0.35` | Light intensity overhead (sun) and at full moon overhead. Colour comes from the atmosphere's transmittance of the star's black-body colour. |
| `moonColor` | `'#9fb6ff'` | |
| `nightAmbient` / `nightAmbientColors` | `0.12` / `['#5a6f9e', '#1b1f26']` | Night hemisphere fill (sky, ground), scaled by `night`. |
| `twilight` | `[2, -12]` | Sun elevations where `night` goes 0 → 1. |
| `shadows` / `moonShadows` | `true` / `false` | |
| `lightDistance` | `150` | Light distance from the followed point (size `sky.sun.shadow.camera` yourself). |
| `environment` | `true` | `scene.environment` rendered from the sky. |
| `environmentIntensity` / `environmentResolution` | `0.25` / `64` | |
| `environmentThreshold` / `environmentFacesPerFrame` | `0.5`° / `2` | Re-render when the sun or moon moves this far, a few cube faces per frame. |
| `fog` / `fogDensity` / `fogBrightness` | `true` / `0` / `1` | Fog colour from the horizon sky; density > 0 creates `FogExp2` and fades it out towards the Kármán line. |
| `autoExposure` | `false` | Apply `sky.exposure` to `renderer.toneMappingExposure`. |
| `exposureKey` / `exposureRange` / `exposureSpeed` | `0.35` / `[0.25, 8]` / `1.5` | From high up, the sunlit planet below counts too. |

### `clouds`

| Setting | Default | |
|---|---|---|
| `enabled`, `seed` | `true`, sky `seed` | |
| `coverage` | `0.35` | Fraction of the sky covered (the field is calibrated so this is literal). |
| `density` | `1` | Optical density. |
| `featureSize` | `18000` | Size of weather systems, m. |
| `cumulus` / `stratus` / `cirrus` | `{ amount, altitude: [min, max], size: [min, max] }` | Per genus: amount 0..2, base altitudes and cluster sizes in Earth metres (scaled with the atmosphere). |
| `wind` | `[6, 1.5]` | [east, north] m/s of simulation time. |
| `range` / `cellSize` | `40000` / `2500` | Detailed layer radius and placement cell, m. |
| `maxSplats` / `globalSplats` | `16000` / `20000` | Splat budgets of the detailed and planet-wide layers. |
| `color` / `silverLining` / `ambient` | `'#ffffff'` / `1` / `1` | |
| `haze` | `70000` | Aerial-perspective distance, m. |
| `sortInterval` | `4` | Updates between depth sorts. |

### `nightLights`

| Setting | Default | |
|---|---|---|
| `enabled` / `intensity` / `color` | `true` / `1` / `'#ffb35c'` | |
| `density` / `scale` | `0.35` / `1` | Procedural field (when no field or texture is set). |
| `twilight` | `[3, -8]` | Sun elevations at the lit point where lights come on. |
| `resolution` | `[1024, 512]` | Equirectangular size used to bake a `(lat, lon) => 0..1` callback. |

### `shells`

| Setting | Default | |
|---|---|---|
| `enabled` | `false` | Draw the labelled altitude shells. |
| `shells` | troposphere, Kármán line, ionosphere (300 km), apogee | `{ label, altitude, color }`; `altitude` is metres (scaled with the atmosphere), a layer name (`'troposphere'`, `'karman'`, …) or `'perigee'` / `'apogee'` of the moon. |
| `opacity` / `labels` / `labelSize` | `0.3` / `true` / `0.035` | Rim brightness; label height as a fraction of its distance (constant on screen). Labels hide while their shell is smaller on screen than the label. |

The planet hides the far side of each shell. From outside, labels sit on the shell's limb; from inside, near the horizon
ahead. `sky.clipPlanes(heightAboveGround)` gives near/far planes that keep the outermost shell in view:

```ts
const renderer = new WebGPURenderer({ reversedDepthBuffer: true })
// each frame, before sky.update():
;[camera.near, camera.far] = sky.clipPlanes(camera.position.y - groundHeight)
camera.updateProjectionMatrix()
```

### `SolarSystem` (and `<SolarSystem>`)

| Setting | Default | |
|---|---|---|
| `system` | `{}` | Used when no `model` (a `StarSystem`, e.g. `sky.system`) is passed. |
| `origin` / `originOffset` | `'home'` / `[0,0,0]` | Floating origin: body and offset in metres. |
| `scale` | `1e-6` | Render units per metre. |
| `exaggerateSizes` / `exaggerateStar` | `200` / `10` | Radius multipliers. Moon orbits widen by √`exaggerateSizes` so planets don't swallow them. |
| `orbitLines` / `orbitColor` / `orbitOpacity` | `true` / `'#8aa4c8'` / `0.35` | |
| `apsides` / `apsisColors` / `apsisSize` | `true` / `['#5ee0ff', '#ffb35e']` / `0.006` | Periapsis/apoapsis markers on each orbit (size as a fraction of camera distance). |
| `maxDistance` | `5e6` | Beyond this (render units), bodies are pulled in with their angular size preserved. |
| `starGlow` / `starLight` / `ambient` | `1` / `2.5` / `0.03` | Glow, starlight on bodies, night-side light. |
| `hidden` | `[]` | Bodies not to draw (e.g. `'home'` when a `World` draws it). |
| `segments` | `64` | |

Object options: `model`, `materials` (your own `Material` per body name).

Full API docs: <https://askalice.github.io/threejs-worldgen/docs/>.

## License

Apache-2.0
