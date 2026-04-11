export const manifest = (() => {
function __memo(fn) {
	let value;
	return () => value ??= (value = fn());
}

return {
	appDir: "_app",
	appPath: "_app",
	assets: new Set(["about.html","deletion.html","icons/favicon.ico","icons/icon-192.png","icons/icon-512.png","icons/icon.svg","icons/og-default.svg","icons/og-ride.png","icons/ride-logo-32.png","icons/ride-logo-48.png","icons/ride-logo-light.png","icons/ride-logo-light.webp","icons/ride-logo.png","icons/ride-logo.webp","icons/ride-wordmark.svg","images/product/addWaypointView.png","images/product/googleMapsHelperForWaypoints.png","images/product/journalEntryView.png","images/product/mobileNavigationView.png","images/product/navigationTurnbyTurnView.png","images/product/newTripMapView.png","images/product/README.md","images/product/tripdetailsmodal.png","manifest.json","privacy.html","robots.txt","sitemap.xml","sw.js","terms.html","_routes.json"]),
	mimeTypes: {".html":"text/html",".png":"image/png",".svg":"image/svg+xml",".webp":"image/webp",".md":"text/markdown",".json":"application/json",".txt":"text/plain",".xml":"text/xml",".js":"text/javascript"},
	_: {
		client: {start:"_app/immutable/entry/start.CKd0gDuT.js",app:"_app/immutable/entry/app.BlZCKMlX.js",imports:["_app/immutable/entry/start.CKd0gDuT.js","_app/immutable/chunks/Bp_-EhYr.js","_app/immutable/chunks/DILfUbMC.js","_app/immutable/chunks/BP4nCMQk.js","_app/immutable/chunks/BeNdFXIq.js","_app/immutable/chunks/D1gtkjhw.js","_app/immutable/entry/app.BlZCKMlX.js","_app/immutable/chunks/DILfUbMC.js","_app/immutable/chunks/BP4nCMQk.js","_app/immutable/chunks/BeNdFXIq.js"],stylesheets:[],fonts:[],uses_env_dynamic_public:false},
		nodes: [
			__memo(() => import('./nodes/0.js')),
			__memo(() => import('./nodes/1.js')),
			__memo(() => import('./nodes/2.js'))
		],
		remotes: {
			
		},
		routes: [
			{
				id: "/",
				pattern: /^\/$/,
				params: [],
				page: { layouts: [0,], errors: [1,], leaf: 2 },
				endpoint: null
			}
		],
		prerendered_routes: new Set([]),
		matchers: async () => {
			
			return {  };
		},
		server_assets: {}
	}
}
})();
