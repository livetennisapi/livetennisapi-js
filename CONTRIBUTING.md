# Contributing

## Setup

```bash
npm install
npm test            # unit tests, no API key needed
npm run typecheck
npm run build
```

## Contract tests

The unit tests use a mocked fetch. The **contract** tests run against the real
API and are what prove the types match production:

```bash
LIVETENNISAPI_KEY=twjp_… npm run test:contract
```

They skip automatically without a key, and tolerate an empty slate — there may
genuinely be no live matches at 3am.

## Before opening a PR

```bash
npm run typecheck && npm test && npm run build
```

## Reporting a spec mismatch

If the API returns something these types don't expect, that's the most valuable
bug report there is. Include the endpoint, the request, and the raw response.
The [spec](https://github.com/livetennisapi/openapi) is the source of truth; if
the spec and the API disagree, the spec gets fixed.

## Design rules

Two constraints are not up for negotiation, because the API's contract depends
on them:

1. **Response types must never forbid unknown fields.** The API ships additive
   changes within `v1`, so a closed type would make a new server-side field a
   compile error for every consumer.
2. **Never retry a non-429 4xx.** A bad key or an unentitled tier cannot start
   working, and retrying only burns the caller's rate limit.

Keep the Python and JavaScript clients behaviourally identical. If you change a
default, an error mapping, or a retry rule here, change it there too.
