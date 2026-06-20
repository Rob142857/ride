// eslint.config.mjs — minimal flat config for Ride
// Works with ESLint v9+

import js from '@eslint/js';

const baseRules = {
  'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
  'no-console': 'off',
  'eqeqeq': ['warn', 'smart'],
  'no-var': 'warn',
  'prefer-const': 'warn',
  'no-extra-semi': 'warn',
  'no-irregular-whitespace': 'warn',
  'no-empty': ['error', { allowEmptyCatch: true }],
  // Catch missing spaces around operators (e.g. ===401)
  'space-infix-ops': ['warn', { int32Hint: false }],
};

export default [
  // Recommended base rules everywhere
  js.configs.recommended,

  {
    // Frontend scripts are classic browser scripts with heavy global usage
    files: ['public/**/*.js'],
    languageOptions: {
      ecmaVersion:2022,
      sourceType: 'script',
      globals: {
        // Browser globals
        window: 'readonly',
        document: 'readonly',
        navigator: 'readonly',
        console: 'readonly',
        localStorage: 'readonly',
        sessionStorage: 'readonly',
        fetch: 'readonly',
        caches: 'readonly',
        self: 'readonly',
        crypto: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        Blob: 'readonly',
        FileReader: 'readonly',
        FormData: 'readonly',
        CustomEvent: 'readonly',
        AbortController: 'readonly',
        ResizeObserver: 'readonly',
        IntersectionObserver: 'readonly',
        HTMLElement: 'readonly',
        DOMParser: 'readonly',
        requestAnimationFrame: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        location: 'readonly',
        // Third-party / cross-script globals
        L: 'readonly',
        // App globals (declared across multiple classic script files)
        App: 'readonly',
        API: 'readonly',
        UI: 'readonly',
        MapManager: 'readonly',
        Storage: 'readonly',
        Utils: 'readonly',
        Trip: 'readonly',
        Share: 'readonly',
        RideUtils: 'readonly',
        authHeaders: 'readonly',
        API_BASE: 'readonly',
        showToast: 'readonly',
        drawRouteForIndex: 'readonly',
        updateTripStatsForRoute: 'readonly',
      },
    },
    rules: {
      // The project relies on script-tag-loaded globals; undefined checking is too noisy
      'no-undef': 'off',
      'no-redeclare': 'off',
      ...baseRules,
    },
  },

  {
    // Worker / backend uses ES modules inside the Workers runtime
    files: ['api/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        console: 'readonly',
        Buffer: 'readonly',
        crypto: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        fetch: 'readonly',
        Request: 'readonly',
        Response: 'readonly',
        Headers: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        FormData: 'readonly',
      },
    },
    rules: {
      ...baseRules,
      // Intentional control-character sanitisation in Content-Disposition
      'no-control-regex': 'off',
    },
  },

  {
    // Node build/util scripts use CommonJS
    files: ['scripts/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        console: 'readonly',
        process: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        performance: 'readonly',
        fetch: 'readonly',
      },
    },
    rules: baseRules,
  },

  {
    // SDK package is consumed as a module; keep false-positive noise low
    files: ['packages/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        window: 'readonly',
        document: 'readonly',
        navigator: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        FormData: 'readonly',
        CustomEvent: 'readonly',
        URLSearchParams: 'readonly',
      },
    },
    rules: {
      ...baseRules,
      'no-undef': 'off',
      'no-redeclare': 'off',
    },
  },
];
