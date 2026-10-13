// Shared <head> SEO tags for every page on the site: the landing pages (landing/build.mjs), the built demo pages
// (post-processed by landing/build.mjs) and the TypeDoc pages (scripts/typedoc-seo.mjs).
export const SITE = 'https://askalice.github.io/threejs-worldgen/'
export const GITHUB = 'https://github.com/AskAlice/threejs-worldgen'
export const SITE_NAME = 'threejs-worldgen'
export const OG = { width: 1200, height: 630 } // every card in landing/media/og/ (see landing/og.mjs)

// Package order on the homepage (landing/build.mjs) and in the README cards (landing/readme-cards.mjs) follows the
// pipeline: ground, then what grows on it, then people, then the sky. threejs-heightfield sits under all of them.
export const ORDER = ['heightfield', 'biomes', 'water', 'scatter', 'trees', 'grass', 'city', 'population', 'props', 'vehicles', 'fauna', 'weathering', 'sky']

export const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
export const plain = (html) => String(html).replace(/<[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')

/** Canonical, robots, Open Graph and Twitter tags. `url` and `image` are absolute; `themeColor` is optional. */
export function seoTags({ title, description, url, image, imageAlt, type = 'website', themeColor }) {
  const m = (attr, k, v) => `<meta ${attr}="${k}" content="${esc(v)}" />`
  return [
    m('name', 'description', description),
    `<link rel="canonical" href="${esc(url)}" />`,
    m('name', 'robots', 'index, follow, max-image-preview:large'),
    themeColor && m('name', 'theme-color', themeColor),
    m('property', 'og:type', type),
    m('property', 'og:site_name', SITE_NAME),
    m('property', 'og:locale', 'en_US'),
    m('property', 'og:title', title),
    m('property', 'og:description', description),
    m('property', 'og:url', url),
    m('property', 'og:image', image),
    m('property', 'og:image:width', OG.width),
    m('property', 'og:image:height', OG.height),
    m('property', 'og:image:alt', imageAlt),
    m('name', 'twitter:card', 'summary_large_image'),
    m('name', 'twitter:title', title),
    m('name', 'twitter:description', description),
    m('name', 'twitter:image', image),
    m('name', 'twitter:image:alt', imageAlt),
  ].filter(Boolean).join('\n  ')
}

/** A JSON-LD <script>; `<` is escaped so text can never close the tag. */
export const jsonLd = (data) => `<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', ...data }).replace(/</g, '\\u003c')}</script>`
