
// this file is generated — do not edit it


declare module "svelte/elements" {
	export interface HTMLAttributes<T> {
		'data-sveltekit-keepfocus'?: true | '' | 'off' | undefined | null;
		'data-sveltekit-noscroll'?: true | '' | 'off' | undefined | null;
		'data-sveltekit-preload-code'?:
			| true
			| ''
			| 'eager'
			| 'viewport'
			| 'hover'
			| 'tap'
			| 'off'
			| undefined
			| null;
		'data-sveltekit-preload-data'?: true | '' | 'hover' | 'tap' | 'off' | undefined | null;
		'data-sveltekit-reload'?: true | '' | 'off' | undefined | null;
		'data-sveltekit-replacestate'?: true | '' | 'off' | undefined | null;
	}
}

export {};


declare module "$app/types" {
	type MatcherParam<M> = M extends (param : string) => param is (infer U extends string) ? U : string;

	export interface AppTypes {
		RouteId(): "/";
		RouteParams(): {
			
		};
		LayoutParams(): {
			"/": Record<string, never>
		};
		Pathname(): "/";
		ResolvedPathname(): `${"" | `/${string}`}${ReturnType<AppTypes['Pathname']>}`;
		Asset(): "/about.html" | "/css/app.css" | "/css/global.css" | "/css/ride-mode.css" | "/deletion.html" | "/icons/favicon.ico" | "/icons/icon-192.png" | "/icons/icon-512.png" | "/icons/icon.svg" | "/icons/og-default.svg" | "/icons/og-ride.png" | "/icons/ride-logo-32.png" | "/icons/ride-logo-48.png" | "/icons/ride-logo-light.png" | "/icons/ride-logo-light.webp" | "/icons/ride-logo.png" | "/icons/ride-logo.webp" | "/icons/ride-wordmark.svg" | "/images/product/addWaypointView.png" | "/images/product/googleMapsHelperForWaypoints.png" | "/images/product/journalEntryView.png" | "/images/product/mobileNavigationView.png" | "/images/product/navigationTurnbyTurnView.png" | "/images/product/newTripMapView.png" | "/images/product/README.md" | "/images/product/tripdetailsmodal.png" | "/manifest.json" | "/privacy.html" | "/robots.txt" | "/sitemap.xml" | "/sw.js" | "/terms.html" | "/_routes.json" | string & {};
	}
}