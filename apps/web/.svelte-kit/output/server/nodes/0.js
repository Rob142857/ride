

export const index = 0;
let component_cache;
export const component = async () => component_cache ??= (await import('../entries/pages/_layout.svelte.js')).default;
export const universal = {
  "prerender": false,
  "ssr": false
};
export const universal_id = "src/routes/+layout.ts";
export const imports = ["_app/immutable/nodes/0.C6Xc2M5I.js","_app/immutable/chunks/BP4nCMQk.js","_app/immutable/chunks/W9P8S5Ci.js"];
export const stylesheets = ["_app/immutable/assets/0.BTpXQ8xf.css"];
export const fonts = [];
