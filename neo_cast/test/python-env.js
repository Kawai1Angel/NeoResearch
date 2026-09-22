"use strict";

const fs = require("node:fs");
const path = require("node:path");

// Temporary projects deliberately have no runtime. Use the test suite's
// installed Python dependencies without creating a venv in every fixture.
const runtimeBin = path.resolve(__dirname, "../.neo-cast/runtime/.venv/bin");
const python = process.env.NEO_CAST_PYTHON;
const bin = python ? path.dirname(path.resolve(python)) : runtimeBin;

module.exports = {
  ...process.env,
  PATH: (python || fs.existsSync(path.join(runtimeBin, "python3")))
    ? `${bin}${path.delimiter}${process.env.PATH || ""}`
    : process.env.PATH,
};
