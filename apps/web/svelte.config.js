import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),
	kit: {
		adapter: adapter({
			pages: 'build',
			assets: 'build',
			fallback: 'index.html',  // SPA mode — all routes to index.html
			precompress: true
		}),
		alias: {
			$components: 'src/lib/components',
			$stores: 'src/lib/stores',
			$types: 'src/lib/types'
		}
	}
};

export default config;
