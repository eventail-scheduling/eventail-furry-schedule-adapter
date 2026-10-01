# Eventail Furry Schedule Adapter

[![CI](https://github.com/eventail-scheduling/eventail-furry-schedule-adapter/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/eventail-scheduling/eventail-furry-schedule-adapter/actions/workflows/ci.yml?query=branch%3Amain)

A schedule publisher for Eventail, a call for papers and scheduling system for conferences. It
reads one edition from the [Eventail API](https://github.com/eventail-scheduling/eventail)
as an integration and serves its schedule in the
[Furry Schedule Schema](https://github.com/Alofoxx/furry-schedule-schema) format.

## Development

Requires Node.js 26 and pnpm, and a running API; its README covers the setup.

- `pnpm install`
- `pnpm start`

The document is served on http://localhost:12020. `config/development.toml` points it at the
local API and at the mock identity provider its compose file starts; `config/local.toml` is
yours and ignored, and is where the edition to publish belongs.

## Tests

`pnpm typecheck` checks the types of the app and the tests. `pnpm test` runs the unit tests on
`node:test`.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Licensed under the [Apache License 2.0](LICENSE).
