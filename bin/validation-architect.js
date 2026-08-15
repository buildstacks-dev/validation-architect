#!/usr/bin/env node
/** Production package entry. `prepack` compiles this target; no development
 * TypeScript runner is required in an installed product repo.
 *
 * License: FSL-1.1-MIT (Functional Source License 1.1, MIT future grant).
 * Copyright 2026 Bikram Gupta. See LICENSE.md in this package. */
import { main } from "../dist/core-cli.js";

process.exitCode = await main(process.argv.slice(2));
