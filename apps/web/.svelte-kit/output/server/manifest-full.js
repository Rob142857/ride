export const manifest = (() => {
function __memo(fn) {
	let value;
	return () => value ??= (value = fn());
}

return {
	appDir: "_app",
	appPath: "_app",
	assets: new Set(["about.html","css/app.css","css/global.css","css/ride-mode.css","deletion.html","icons/favicon.ico","icons/icon-192.png","icons/icon-512.png","icons/icon.svg","icons/og-default.svg","icons/og-ride.png","icons/ride-logo-32.png","icons/ride-logo-48.png","icons/ride-logo-light.png","icons/ride-logo-light.webp","icons/ride-logo.png","icons/ride-logo.webp","icons/ride-wordmark.svg","images/product/addWaypointView.png","images/product/googleMapsHelperForWaypoints.png","images/product/journalEntryView.png","images/product/mobileNavigationView.png","images/product/navigationTurnbyTurnView.png","images/product/newTripMapView.png","images/product/README.md","images/product/tripdetailsmodal.png","manifest.json","privacy.html","robots.txt","sitemap.xml","sw.js","terms.html","_routes.json"]),
	mimeTypes: {".html":"text/html",".css":"text/css",".png":"image/png",".svg":"image/svg+xml",".webp":"image/webp",".md":"text/markdown",".json":"application/json",".txt":"text/plain",".xml":"text/xml",".js":"text/javascript"},
	_: {
		client: {start:"_app/immutable/entry/start.CqhK_WaQ.js",app:"_app/immutable/entry/app.DI7ZDdky.js",imports:["_app/immutable/entry/start.CqhK_WaQ.js","_app/immutable/chunks/Gq8qOB3p.js","_app/immutable/chunks/rUoeTMW2.js","_app/immutable/chunks/Bbxpyo70.js","_app/immutable/entry/app.DI7ZDdky.js","_app/immutable/chunks/rUoeTMW2.js","_app/immutable/chunks/BcgnSMxp.js","_app/immutable/chunks/DXLwiZ0H.js"],stylesheets:[],fonts:[],uses_env_dynamic_public:false},
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
