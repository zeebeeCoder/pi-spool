# Absurd test fixture provenance

This directory contains the minimum upstream material needed to provision the
disposable integration-test database without a network fetch or local Absurd
checkout.

## Schema

- File: `absurd-0.5.0.sql`
- Upstream project: <https://github.com/earendil-works/absurd>
- Release tag: `0.5.0`
- Release commit: `550d3b9e6f9382d96178de6ab8c90c7f8edf2227`
- Source URL: <https://github.com/earendil-works/absurd/blob/550d3b9e6f9382d96178de6ab8c90c7f8edf2227/sql/absurd.sql>
- SHA-256: `d34309370c539f3a51f2b36b69b1f77551f8e4a14480a1c8def8bb8f40fd9aab`
- License: Apache-2.0; reproduced in `ABSURD-LICENSE`

The test verifies the SHA-256 before executing the schema and verifies
`absurd.get_schema_version()` returns `0.5.0` after installation.

## SDK mapping

`absurd-sdk@0.5.0` is pinned exactly in `package.json` and `package-lock.json`.
Registry metadata reports:

- npm version: `0.5.0`
- npm `gitHead`: `550d3b9e6f9382d96178de6ab8c90c7f8edf2227`
- tarball SHA-1: `dad63dc6be07cbbadbd2574d2a94680d5df6cbdb`
- integrity: `sha512-/FG9iDNt9Ujnbz5XVkBoNKRGf73fiJ+lrg54Dy3ol3T1RBRwExtzNWgI5LPMjU5/e+hYlGd9g152Vq2YniZr6A==`

The local upstream checkout was used only to verify this mapping during the
spike. Tests and runtime code do not read it.
