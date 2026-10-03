# Changelog

## [0.2.0](https://github.com/eventail-scheduling/eventail-furry-schedule-adapter/compare/v0.1.0...v0.2.0) (2026-10-03)


### ⚠ BREAKING CHANGES

* the venue settings are gone. Remove VENUE_ID, VENUE_NAME and VENUE_ADDRESS, or whatever names your configuration gives them. Venues come from eventail, which has to be 0.2.0 or newer: an older one does not offer the venue include at all, so it refuses the request rather than answering without venues, and the adapter never builds a document.

### Features

* map membership levels from a choice question ([838715e](https://github.com/eventail-scheduling/eventail-furry-schedule-adapter/commit/838715e66f4ee5770f91aabbd61bef3546c990ea))
* read venues from eventail instead of configuration ([d8fac29](https://github.com/eventail-scheduling/eventail-furry-schedule-adapter/commit/d8fac29b0f8a7cced4ff412ab1fc1cb5f2d07704))

## 0.1.0 (2026-10-02)

First release. Serves an Eventail edition's schedule in the Furry Schedule
Schema format.
