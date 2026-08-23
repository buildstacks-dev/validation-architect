#!/usr/bin/env node
/** Production package entry. `prepack` compiles this target; no development
 * TypeScript runner is required in an installed product repo.
 *
 * Licensed under Apache-2.0.
 * Copyright 2026 Bikram Gupta. See LICENSE in this package. */
import { main } from "../dist/design/cli.js";

process.exitCode = await main(process.argv.slice(2));
