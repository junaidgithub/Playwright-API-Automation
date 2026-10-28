'use strict';
/** Runs once before the suite: clears variables extracted by a previous run. */
const fs = require('node:fs');
const path = require('node:path');
const { loadDotEnv, getConfig } = require('../config');

module.exports = async () => {
  loadDotEnv();
  const { generatedDir } = getConfig();
  fs.rmSync(path.join(generatedDir, '.runtime-state.json'), { force: true });
};
