import "clsx";
import { u as uiState } from "../../chunks/map.js";
import { d as derived, w as writable } from "../../chunks/index.js";
import { e as ensure_array_like, a as attr_class, s as stringify, b as escape_html, u as unsubscribe_stores, d as derived$1, c as store_get } from "../../chunks/renderer.js";
const initial = { user: null, status: "unknown" };
const authStore = writable(initial);
derived(authStore, ($a) => $a.status === "authenticated");
derived(authStore, ($a) => $a.status === "unknown" || $a.status === "checking");
derived(authStore, ($a) => $a.user);
function Toast($$renderer) {
  var $$store_subs;
  const ui = derived$1(() => store_get($$store_subs ??= {}, "$uiState", uiState));
  $$renderer.push(`<div class="toast-container svelte-1cpok13" aria-live="polite"><!--[-->`);
  const each_array = ensure_array_like(ui().toasts);
  for (let $$index = 0, $$length = each_array.length; $$index < $$length; $$index++) {
    let toast = each_array[$$index];
    $$renderer.push(`<div${attr_class(`toast toast-${stringify(toast.type)}`, "svelte-1cpok13")} role="alert"><span class="toast-msg">${escape_html(toast.text)}</span></div>`);
  }
  $$renderer.push(`<!--]--></div>`);
  if ($$store_subs) unsubscribe_stores($$store_subs);
}
function _layout($$renderer, $$props) {
  $$renderer.component(($$renderer2) => {
    let { children } = $$props;
    {
      $$renderer2.push("<!--[0-->");
      $$renderer2.push(`<div class="app-loader svelte-12qhfyh"><img src="/icons/icon.svg" alt="Ride" class="app-loader-icon svelte-12qhfyh"/> <span class="wordmark app-loader-title svelte-12qhfyh">Ride</span></div>`);
    }
    $$renderer2.push(`<!--]--> `);
    Toast($$renderer2);
    $$renderer2.push(`<!---->`);
  });
}
export {
  _layout as default
};
