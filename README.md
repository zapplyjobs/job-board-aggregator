# job-board-aggregator
Zapply job pipeline aggregator logic — fetchers, tag engine, processors

## Development
Pre-commit hooks keep the deployment-parity mirror (`.github/scripts/aggregator/...`) byte-identical to its source (`lib/...`) so the two commit together. Enable once per clone:

```sh
git config core.hooksPath .githooks
```

(The `lib/__tests__/deployment-parity.test.js` CI gate remains the reactive backstop if a contributor skips this.)
