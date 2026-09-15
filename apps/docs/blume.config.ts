import { defineConfig } from 'blume'

const posthogScript = String.raw`
!function(t,e){var o,n,p,r;e.__SV||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.crossOrigin="anonymous",p.async=!0,p.src=s.api_host.replace(".i.posthog.com","-assets.i.posthog.com")+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],u.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e},u.people.toString=function(){return u.toString(1)+".people (stub)"},o="init capture register register_once get_distinct_id get_session_id".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);
function bg0WithoutUrls(p){if(!p)return p;p=Object.assign({},p);delete p.$current_url;delete p.$referrer;delete p.$initial_current_url;delete p.$initial_referrer;return p}
function bg0StripUrls(e){if(!e)return null;e.properties=bg0WithoutUrls(e.properties);e.$set=bg0WithoutUrls(e.$set);e.$set_once=bg0WithoutUrls(e.$set_once);return e}
if(location.hostname==="bg0.dev"||location.hostname==="www.bg0.dev"){
posthog.init("phc_wVUY4kf7cB9GCtKztaQ4dk6ooYU8QaagC88breDYcgaj",{api_host:"https://us.i.posthog.com",autocapture:false,capture_dead_clicks:false,capture_pageleave:true,capture_pageview:false,capture_performance:false,disable_session_recording:true,disable_surveys:true,advanced_disable_feature_flags:true,person_profiles:"never",persistence:"localStorage",before_send:bg0StripUrls});
function bg0DocsPageview(){var route=location.pathname;if(window.__bg0LastRoute===route)return;window.__bg0LastRoute=route;posthog.capture("$pageview",{route:route})}
bg0DocsPageview();document.addEventListener("astro:page-load",bg0DocsPageview);
}
`

// Seed the docs theme key from the app's key so a manual choice on bg0.dev
// carries into /docs. Runs after Blume's theme script, so it must also fix
// data-theme on the root element directly.
const themeSeedScript = String.raw`
try {
  var t = localStorage.getItem('bg0-theme');
  if ((t === 'light' || t === 'dark') && !localStorage.getItem('blume-theme')) {
    localStorage.setItem('blume-theme', t);
    document.documentElement.dataset.theme = t;
  }
} catch (_) {}
`

const productUrl = process.env.BG0_PRODUCT_URL ?? 'https://bg0.dev'

export default defineConfig({
  title: 'BG0',
  description:
    'Private background removal in your browser. No uploads, accounts, or server-side inference.',
  logo: { image: '/logo.svg', text: 'bg0', href: productUrl },
  github: { owner: 'opencoredev', repo: 'bg0', dir: 'apps/docs' },
  content: { root: 'docs' },
  navigation: {
    repo: true,
    sidebar: { display: 'flat' },
  },
  theme: {
    mode: 'system',
    accent: '#5e9bff',
    radius: 'md',
    background: { dark: '#0a0a0a', light: '#ffffff' },
    fonts: { display: 'geist', body: 'geist', mono: 'geist-mono' },
  },
  markdown: {
    code: { icons: false },
    codeBlocks: { theme: { light: 'github-light', dark: 'github-dark' } },
  },
  search: { provider: 'orama' },
  analytics: {
    scripts: [{ content: themeSeedScript }, { content: posthogScript }],
  },
  ai: { llmsTxt: true },
  seo: { sitemap: true, robots: true, og: { enabled: true } },
  deployment: { output: 'static', site: 'https://bg0.dev', base: '/docs' },
})
