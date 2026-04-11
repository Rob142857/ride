import { r as root } from "./root.js";
import "./environment.js";
let public_env = {};
function set_private_env(environment) {
}
function set_public_env(environment) {
  public_env = environment;
}
let read_implementation = null;
function set_read_implementation(fn) {
  read_implementation = fn;
}
function set_manifest(_) {
}
const options = {
  app_template_contains_nonce: false,
  async: false,
  csp: { "mode": "auto", "directives": { "upgrade-insecure-requests": false, "block-all-mixed-content": false }, "reportOnly": { "upgrade-insecure-requests": false, "block-all-mixed-content": false } },
  csrf_check_origin: true,
  csrf_trusted_origins: [],
  embedded: false,
  env_public_prefix: "PUBLIC_",
  env_private_prefix: "",
  hash_routing: false,
  hooks: null,
  // added lazily, via `get_hooks`
  preload_strategy: "modulepreload",
  root,
  service_worker: false,
  service_worker_options: void 0,
  server_error_boundaries: false,
  templates: {
    app: ({ head, body, assets, nonce, env }) => '<!doctype html>\r\n<html lang="en">\r\n<head>\r\n	<meta charset="utf-8" />\r\n	<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover" />\r\n	<meta name="apple-mobile-web-app-capable" content="yes" />\r\n	<meta name="mobile-web-app-capable" content="yes" />\r\n	<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />\r\n	<meta name="theme-color" content="#0f172a" />\r\n	<meta name="description" content="Friendly open-source ride planning and sharing app" />\r\n	<meta property="og:type" content="website" />\r\n	<meta property="og:site_name" content="Ride" />\r\n	<meta property="og:title" content="Ride — Open Source Ride Planner" />\r\n	<meta property="og:description" content="Friendly open-source ride planning and sharing app with waypoints, custom routes, journals, and collaborative trip links." />\r\n	<meta property="og:url" content="https://ride.incitat.io/" />\r\n	<meta property="og:image" content="https://ride.incitat.io/icons/og-ride.png" />\r\n	<link rel="icon" type="image/svg+xml" href="/icons/icon.svg" />\r\n	<link rel="icon" type="image/png" sizes="32x32" href="/icons/ride-logo-32.png" />\r\n	<link rel="apple-touch-icon" href="/icons/icon-192.png" />\r\n	<link rel="manifest" href="/manifest.json" />\r\n	<link rel="preconnect" href="https://fonts.googleapis.com" />\r\n	<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />\r\n	<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=Playfair+Display:ital,wght@0,400;0,700;1,400&display=swap" rel="stylesheet" />\r\n	<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" crossorigin="" />\r\n	' + head + '\r\n</head>\r\n<body data-sveltekit-preload-data="hover">\r\n	<div id="app">' + body + "</div>\r\n</body>\r\n</html>\r\n",
    error: ({ status, message }) => '<!doctype html>\n<html lang="en">\n	<head>\n		<meta charset="utf-8" />\n		<title>' + message + `</title>

		<style>
			body {
				--bg: white;
				--fg: #222;
				--divider: #ccc;
				background: var(--bg);
				color: var(--fg);
				font-family:
					system-ui,
					-apple-system,
					BlinkMacSystemFont,
					'Segoe UI',
					Roboto,
					Oxygen,
					Ubuntu,
					Cantarell,
					'Open Sans',
					'Helvetica Neue',
					sans-serif;
				display: flex;
				align-items: center;
				justify-content: center;
				height: 100vh;
				margin: 0;
			}

			.error {
				display: flex;
				align-items: center;
				max-width: 32rem;
				margin: 0 1rem;
			}

			.status {
				font-weight: 200;
				font-size: 3rem;
				line-height: 1;
				position: relative;
				top: -0.05rem;
			}

			.message {
				border-left: 1px solid var(--divider);
				padding: 0 0 0 1rem;
				margin: 0 0 0 1rem;
				min-height: 2.5rem;
				display: flex;
				align-items: center;
			}

			.message h1 {
				font-weight: 400;
				font-size: 1em;
				margin: 0;
			}

			@media (prefers-color-scheme: dark) {
				body {
					--bg: #222;
					--fg: #ddd;
					--divider: #666;
				}
			}
		</style>
	</head>
	<body>
		<div class="error">
			<span class="status">` + status + '</span>\n			<div class="message">\n				<h1>' + message + "</h1>\n			</div>\n		</div>\n	</body>\n</html>\n"
  },
  version_hash: "8q2a1f"
};
async function get_hooks() {
  let handle;
  let handleFetch;
  let handleError;
  let handleValidationError;
  let init;
  let reroute;
  let transport;
  return {
    handle,
    handleFetch,
    handleError,
    handleValidationError,
    init,
    reroute,
    transport
  };
}
export {
  set_public_env as a,
  set_read_implementation as b,
  set_manifest as c,
  get_hooks as g,
  options as o,
  public_env as p,
  read_implementation as r,
  set_private_env as s
};
