// Lander data for threejs-sky. Schema and conventions: see landing/build.mjs and landing/packages/grass.mjs.
export default {
  short: 'sky',
  name: 'threejs-sky',
  status: 'live',
  accent: '#3c3f91',
  icon: '<path d=\"M20 4a12 12 0 1 0 8 19A10 10 0 0 1 20 4z\" fill=\"currentColor\"/><path d=\"M8 5l1.2 2.8L12 9l-2.8 1.2L8 13l-1.2-2.8L4 9l2.8-1.2z\" fill=\"currentColor\"/>',
  title: 'threejs-sky · Physically based WebGPU skies for three.js and React Three Fiber',
  description: 'WebGPU skies for three.js and React Three Fiber: layered atmosphere, Gaussian clouds, moon phases, Milky Way, shooting stars and Keplerian orbits.',
  pitch: 'A physically based sky from the ground to orbit: clouds, moon phases, Milky Way, meteors and a Keplerian solar system.',
  label: 'WebGPU · three.js · React Three Fiber',
  headline: 'From an ant\'s eye view to <em>orbital mechanics.</em>',
  lede: 'A layered atmosphere, Gaussian clouds, a sun and moon on real orbits, stars and the Milky Way turning with sidereal time. The lighting, fog and exposure that go with them come from the same <code>Sky.create()</code> or one <code>&lt;Sky /&gt;</code>.',
  hero: { img: 'sky/hero.jpg', alt: 'Sunset over rolling hills, with golden cumulus on the horizon and cirrus streaks above' },
  thumb: 'sky/thumb.jpg',
  demos: [{ label: 'three.js demo', href: 'sky.html' }],
  stats: [['5', 'atmosphere layers'], ['16k', 'cloud splats nearby'], ['5', 'seeded planets'], ['1', 'draw call per layer']],
  install: 'npm i threejs-sky three',
  code: {
    heading: 'One sky, <em>one update.</em>',
    intro: 'Give it your renderer, scene and camera, a date and a place on the planet. Call <code>update()</code> once per frame and it moves the sun, moon and stars, lights the scene and sets fog and exposure. Every setting is plain JSON and live.',
    three: { src: `
import { Sky } from 'threejs-sky'

const sky = await Sky.create({
  renderer, scene, camera,      // WebGPURenderer
  clock: { date: '2026-08-12T19:00:00Z', dayLength: 600 },
  observer: { latitude: 47, longitude: 8 },
  shootingStars: { shower: 80 }, // the Perseids, roughly
  lighting: { fogDensity: 0.0008, autoExposure: true },
})
sky.follow(controls.target)

renderer.setAnimationLoop(() => {
  sky.update()
  renderer.render(scene, camera)
})` },
    r3f: { src: `
import { Html } from '@react-three/drei'
import { Sky, useSkyTime } from 'threejs-sky/react'

function Clock() {
  const t = useSkyTime()  // re-renders 4×/s
  return <Html>{t.date.toUTCString()}
    <button onClick={() => t.setTimeOfDay(19)}>dusk</button>
  </Html>
}

<Sky
  clock={{ dayLength: 300 }}
  observer={{ latitude: 52 }}
  clouds={{ coverage: 0.5 }}
  shootingStars={{ shower: 60 }}
>
  <Clock />
</Sky>` },
  },
  features: {
    heading: 'Everything above the <em>horizon.</em>',
    intro: 'Physics where it shows, cheap tricks where it doesn\'t. Everything is a deterministic function of <code>seed</code> and time, and every feature below is live in the demo.',
    rows: [
      { title: 'A physically based atmosphere', sub: 'Rayleigh, Mie and ozone, per pixel.', body: 'The dome ray-marches the same scattering model the CPU uses for light colours, fog and exposure, so the sky and the scene always agree. Turn up <code>mie</code> for a hazy day, or switch the atmosphere off for an airless world with stars by day.', media: { img: 'sky/day.jpg', alt: 'A deep blue afternoon sky fading to a pale horizon, with side-lit cumulus over green hills' } },
      { title: 'Sunrise and sunset', sub: 'Lighting that follows the sun down.', body: 'Sun and moon lights take their colour from the atmosphere\'s transmittance. Image-based lighting is re-rendered from the sky a few cube faces per frame, fog takes the horizon colour, and <code>sky.exposure</code> keeps noon and midnight readable. <code>sky.uniforms.night</code> is there for lit windows and street lamps.', media: { img: 'sky/sunset.jpg', alt: 'The sun setting behind hills, lighting cumulus, stratus and cirrus gold from below' } },
      { title: 'Gaussian clouds', sub: 'Thousands of splats, one draw call.', body: 'Cumulus clusters with flat bases, stratus sheets and cirrus streaks, placed by a seeded weather field and drifting with <code>clouds.wind</code>. Each splat integrates its Gaussian along the view ray. <code>sky.cloudCover(x, y, z)</code> returns the same field, so rain can fall where the clouds are.', chips: ['cumulus', 'stratus', 'cirrus'], media: { img: 'sky/clouds.jpg', alt: 'Flat-based cumulus clusters and stratus sheets along the horizon, under the grey base of a cloud overhead' } },
      { title: 'Moon phases from geometry', sub: 'No phase slider.', body: 'The moon is on a Keplerian orbit, and its phase comes from the sun-moon-observer angle. Phases match the real Moon to within about a day, moonlight scales with them, and eclipses happen when the moon passes in front of the sun.', media: { img: 'sky/moon.jpg', alt: 'A waxing gibbous moon, 89% lit, through a 1.6 degree field of view after dusk' } },
      { title: 'Stars and the Milky Way', sub: 'Turning with sidereal time.', body: 'A seeded star field with black-body colours and twinkling, plus a procedural Milky Way with a bulge and dust lanes. A brighter sky lowers the magnitude limit, so stars come out one by one at dusk and thin out under a full moon. One draw call, no geometry per star.', media: { img: 'sky/milkyway.jpg', alt: 'The Milky Way with dark dust lanes and coloured stars over dark hills on a moonless night' } },
      { title: 'Shooting stars', sub: 'Sporadic meteors and showers.', body: 'A steady <code>rate</code> of sporadic meteors plus a <code>shower</code> from a radiant: tens per hour for the Perseids, thousands for a storm. They only show at night and all render in a single draw.', media: { img: 'sky/milkyway.jpg', alt: 'A moonless night sky with the Milky Way, where the meteors show' } },
      { title: 'Up to the edge of space', sub: 'Troposphere to exosphere.', body: 'Real atmosphere layers, with the Kármán line as the edge of space. Above it the sky goes black, stars reach full brightness and fog switches off. Labelled shells mark each layer and the moon\'s apogee, and <code>sky.clipPlanes()</code> keeps everything in view from an ant on the ground to past the moon.', media: { stack: [{ img: 'sky/shells.jpg', alt: 'Labelled altitude shells above a sunset horizon', tag: 'altitude shells' }, { img: 'sky/orbit.jpg', alt: 'The planet from 400 km up, its limb glowing blue on the day side', tag: 'from orbit' }] } },
      { title: 'Night side and city lights', sub: 'The planet glows after dark.', body: 'Seen from altitude, the night side glows with city lights from your own <code>(lat, lon) =&gt; 0..1</code> field or a seeded one. They switch on with the local sun angle and are dimmed by the clouds in front of them. A thin airglow shell shows as a green line on the limb.', media: { img: 'sky/orbit.jpg', alt: 'The night side from orbit, with city lights below the terminator and a green airglow line on the limb' } },
      { title: 'A Keplerian solar system', sub: 'Seasons and sunrise times from real orbits.', body: 'The sun, home planet and moon run on two-body orbits from classical elements, with five seeded planets around them: rocky and desert worlds inside, gas giants further out and ice giants beyond, some of them ringed. <code>SolarSystem</code> draws it all with a floating origin and orbit lines, and marks periapsis and apoapsis.', media: { img: 'sky/system.jpg', alt: 'The star system from afar: the sun, orbit lines with apsis markers, and the home planet with its moon' } },
      { title: 'Made for React too', sub: 'A declarative &lt;Sky&gt; component.', body: 'Every setting is a prop. <code>&lt;Stars&gt;</code>, <code>&lt;ShootingStars&gt;</code> and <code>&lt;SolarSystem&gt;</code> work on their own or inside <code>&lt;Sky&gt;</code>, and <code>useSkyTime()</code> gives you the clock with setters.', media: { img: 'sky/hero.jpg', alt: 'Sunset over rolling hills, with golden cumulus on the horizon' } },
    ],
  },
  final: { heading: 'Look <em>up.</em>', text: 'Scrub the clock, fly up past the moon and back down in the live demo, or go straight to the API reference.' },
}
