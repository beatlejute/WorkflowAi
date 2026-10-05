#!/usr/bin/env node

import { routeReviewFailure, runRoutingCli } from './human-route-core.js';

await runRoutingCli(routeReviewFailure);
