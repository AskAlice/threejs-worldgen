// Lander data for threejs-heightfield. Schema and conventions: see landing/build.mjs and landing/packages/grass.mjs.
// Its own demo is the sandbox (example/heightfield.html); the feature screenshots come from the demos of the packages
// built on it, where it does its work.
export default {
  short: 'heightfield',
  name: 'threejs-heightfield',
  status: 'live',
  accent: '#7a5a2e',
  icon: '<path d="M2 22 8 14l6 4 6-9 10 8" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M3 28h26M8 28V17M14 28v-7M20 28V12M26 28v-11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" opacity=".6"/>',
  title: 'threejs-heightfield · Height lookup, slope and ray-marching on three.js terrain',
  description: 'Bake any three.js mesh into a fast (x, z) => y heightfield: height lookup, slope and ray-marching for placing grass, trees, rocks and buildings on terrain.',
  pitch: 'Any mesh baked into a fast (x, z) => y lookup, with slope and ray-marching: the ground the other packages stand on.',
  label: 'WebGPU · three.js · React Three Fiber',
  headline: 'Know where <em>the ground</em> is.',
  lede: 'Bake any mesh or group into a heightfield once, then look up the height, measure the slope and ray-march the ground anywhere, with no per-object raycasts. A height function works the same way, so a modelled island and an endless procedural world look alike to everything built on top.',
  hero: { img: 'terrain.jpg', alt: 'Grass covering a rolling hill mesh, every blade placed on its baked heightfield in the threejs-grass demo' },
  thumb: 'heightfield/thumb.jpg',
  demos: [{ label: 'Sandbox', href: 'heightfield.html' }],
  stats: [['4', 'functions, one peer dependency'], ['1024', 'samples per side by default'], ['12', 'bisection steps per ray hit'], ['NaN', 'off the terrain, never a guess']],
  install: 'npm i threejs-heightfield three',
  code: {
    heading: 'Ask the ground <em>anything.</em>',
    intro: 'Bake once, then every lookup is a few multiplies. <code>threejs-grass</code> and <code>threejs-scatter</code> do this for you when you hand them a <code>terrain</code>; use it directly to put your own things on the same ground.',
    three: { src: `
import { Raycaster } from 'three/webgpu'
import { bakeHeightfield, createHeightSampler, raycastHeight,
  slopeAt } from 'threejs-heightfield'

const height = bakeHeightfield(island) // any mesh, baked once
const y = height(12, -40)              // NaN off the terrain

// keep trees off cliffs
if (slopeAt(height, 12, -40) < 0.6) tree.position.set(12, y, -40)

// brushes and picking without a triangle raycast
const ray = new Raycaster()
ray.setFromCamera(pointer, camera)
const { origin, direction } = ray.ray
const hit = raycastHeight(height, origin, direction)

// procedural worlds: functions pass straight through
const hills = createHeightSampler((x, z) => 6 * Math.sin(x / 50))` },
    r3f: { file: 'threejs-heightfield in React', src: `
import { useMemo } from 'react'
import { useGLTF } from '@react-three/drei'
import { bakeHeightfield, slopeAt } from 'threejs-heightfield'
import { Grass } from 'threejs-grass/react'

function Island() {
  const { scene } = useGLTF('/island.glb')
  const height = useMemo(() => bakeHeightfield(scene), [scene])
  const flat = spots.filter(([x, z]) =>
    slopeAt(height, x, z) < 0.4)
  return (
    <>
      <primitive object={scene} />
      <Grass terrain={height} />
      {flat.map(([x, z], i) => (
        <mesh key={i} geometry={rock}
          position={[x, height(x, z), z]} />
      ))}
    </>
  )
}` },
  },
  features: {
    heading: 'Small, and <em>underneath everything.</em>',
    intro: 'Four functions and two types. The sandbox puts all four on a height function and on baked meshes side by side; <a href="../grass/">threejs-grass</a> and <a href="../scatter/">threejs-scatter</a> sample their terrain through it, so these shots come from their demos.',
    rows: [
      { title: 'Bake any mesh', sub: 'Triangles in, heights out.', body: '<code>bakeHeightfield()</code> rasterises every triangle under a mesh or group on the CPU, world transforms included, into a grid of about <code>maxResolution</code> samples along the longer side (1024 by default). Where surfaces overlap the highest one wins, so things land on the bridge, not under it.', media: { img: 'grass-map.jpg', alt: 'Grass hugging a hill mesh beside a dirt path, each blade set on the baked heightfield', tag: 'threejs-grass demo' } },
      { title: 'Smooth lookups', sub: 'Bilinear inside, NaN outside.', body: 'The baked sampler blends the four nearest samples, so heights are continuous across the grid and objects don\'t step. Off the edge of the terrain it returns <code>NaN</code> instead of a made-up zero, and callers simply skip those points.', media: { img: 'hero.jpg', alt: 'Tall grass following a hillside, with a dirt path cut across it', tag: 'threejs-grass demo' } },
      { title: 'Functions pass straight through', sub: 'Endless worlds, same API.', body: '<code>createHeightSampler()</code> takes a mesh, an <code>(x, z) =&gt; y</code> function or nothing at all (flat ground at y = 0) and always hands back a <code>HeightFn</code>. Procedural terrain, such as the height of a <a href="../biomes/">threejs-biomes</a> world, is never baked, so it can go on forever.', media: { img: 'biomes/mountains.jpg', alt: 'Procedural mountains and winding rivers from a height function, seen from the air', tag: 'threejs-biomes demo' } },
      { title: 'Slope', sub: 'Keep trees off cliffs.', body: '<code>slopeAt()</code> measures rise over run by central differences, 25 cm either side by default. Grass uses it to skip ground steeper than <code>maxSlope</code>; use it the same way to keep trees off cliffs and buildings off hillsides.', media: { img: 'terrain.jpg', alt: 'Grass running up and over a rolling hill to the horizon', tag: 'threejs-grass demo' } },
      { title: 'Ray-march the ground', sub: 'Brushes, picking, camera collision.', body: '<code>raycastHeight()</code> marches a ray in half-metre steps, then bisects twelve times to the surface. It works on baked meshes and procedural terrain alike, so nothing needs a triangle raycast. The threejs-grass terrain painter runs on it.', media: { video: 'painter.mp4', poster: 'painter.jpg', alt: 'Painting grass onto terrain with a brush that follows the ground', tag: 'threejs-grass painter' } },
      { title: 'Made for React too', sub: 'Nothing new to learn.', body: 'There is no component: bake in a <code>useMemo</code> and pass the sampler to <code>&lt;Grass&gt;</code>, <code>&lt;Scatter&gt;</code> or your own meshes. Those components also take a mesh ref as <code>terrain</code> and bake it for you.', media: { img: 'r3f-demo.jpg', alt: 'The threejs-grass React Three Fiber demo, its grass sampled from a terrain mesh ref', tag: 'React Three Fiber demo' } },
    ],
  },
  final: { heading: 'Stand on <em>solid ground.</em>', text: 'Every function is documented with examples in the API reference. Try every parameter in the sandbox, and see it at work in the grass and scatter demos.' },
}
