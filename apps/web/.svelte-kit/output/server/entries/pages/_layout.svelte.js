import { O as writable, T as derived, V as escape_html, c as unsubscribe_stores, i as ensure_array_like, n as attr_class, o as store_get, s as stringify } from "../../chunks/dev.js";
import "../../chunks/index-server2.js";
import { h as uiState } from "../../chunks/utils2.js";
var authStore = writable({
	user: null,
	status: "unknown"
});
derived(authStore, ($a) => $a.status === "authenticated");
derived(authStore, ($a) => $a.status === "unknown" || $a.status === "checking");
derived(authStore, ($a) => $a.user);
//#endregion
//#region src/lib/components/Toast.svelte
function Toast($$renderer, $$props) {
	$$renderer.component(($$renderer) => {
		var $$store_subs;
		$$renderer.push(`<div class="toast-container svelte-1cpok13" aria-live="polite"><!--[-->`);
		const each_array = ensure_array_like(store_get($$store_subs ??= {}, "$uiState", uiState).toasts);
		for (let $$index = 0, $$length = each_array.length; $$index < $$length; $$index++) {
			let toast = each_array[$$index];
			$$renderer.push(`<div${attr_class(`toast toast-${stringify(toast.type)}`, "svelte-1cpok13")} role="alert"><span class="toast-msg">${escape_html(toast.text)}</span></div>`);
		}
		$$renderer.push(`<!--]--></div>`);
		if ($$store_subs) unsubscribe_stores($$store_subs);
	});
}
//#endregion
//#region src/routes/+layout.svelte
function _layout($$renderer, $$props) {
	$$renderer.component(($$renderer) => {
		var $$store_subs;
		let { children } = $$props;
		$$renderer.push("<!--[0-->");
		$$renderer.push(`<div class="app-loader svelte-12qhfyh"><img src="/icons/icon.svg" alt="Ride" class="app-loader-icon svelte-12qhfyh"/> <span class="wordmark app-loader-title svelte-12qhfyh">Ride</span></div>`);
		$$renderer.push(`<!--]--> `);
		Toast($$renderer, {});
		$$renderer.push(`<!---->`);
		if ($$store_subs) unsubscribe_stores($$store_subs);
	});
}
//#endregion
export { _layout as default };
