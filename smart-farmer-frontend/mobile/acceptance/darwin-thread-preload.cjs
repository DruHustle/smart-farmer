'use strict';
// start-services.sh adds this preload only after the same-runner qualification.
try { require('./darwin-thread-preflight.cjs').installIdentity(); } catch { /* Optional only. */ }
