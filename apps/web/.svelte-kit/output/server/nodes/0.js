

export const index = 0;
let component_cache;
export const component = async () => component_cache ??= (await import('../entries/pages/_layout.svelte.js')).default;
export const universal = {
  "prerender": false,
  "ssr": false
};
export const universal_id = "src/routes/+layout.ts";
export const imports = ["_app/immutable/nodes/0.By0ud7s8.js","_app/immutable/chunks/rUoeTMW2.js","_app/immutable/chunks/QiJxGlzc.js","_app/immutable/chunks/Bbxpyo70.js","_app/immutable/chunks/DXLwiZ0H.js"];
export const stylesheets = ["_app/immutable/assets/0.Da-bwJ0-.css"];
export const fonts = [];
