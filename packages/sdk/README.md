# @ride/sdk

Developer-friendly API client for Ride.

This package is scaffolded for incremental adoption. Current app runtime still uses `public/js/api.js` to avoid regressions.

## Usage

```js
import { createClient } from '@ride/sdk';

const client = createClient({ baseUrl: 'https://ride.incitat.io/api' });
const trips = await client.trips.list();
```

## Browser Usage

```js
import { createClient } from '@ride/sdk';

const api = createClient({ baseUrl: '/api', eventTarget: window });
const me = await api.auth.getUser();
```

## Notes

- Auth is cookie/session based by default (`credentials: 'include'`).
- Mutation endpoints support optimistic concurrency via `If-Match` headers.
- The SDK normalizes server snake_case fields into camelCase objects.
