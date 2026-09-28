"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  convertAccessTechnology,
  convertNetworkType,
  convertNetworkTypes,
  createModemManager,
  parseKeyValueOutput,
} = require("./modem-manager");

test("parses ModemManager key-value output including lists", () => {
  assert.deepEqual(
    parseKeyValueOutput(
      "modem.generic.ports.length: 2\nmodem.generic.ports.value[1]: ttyUSB0\nmodem.generic.ports.value[2]: wwan0 (net)\n",
      () => {},
    ),
    { "modem.generic.ports": ["ttyUSB0", "wwan0 (net)"] },
  );
});

test("converts ModemManager network formats", () => {
  assert.deepEqual(convertNetworkType("allowed: 3g, 4g; preferred: 4g"), {
    label: "4g3g",
    allowed: "3g|4g",
    preferred: "4g",
  });
  assert.deepEqual(
    convertNetworkTypes([
      "allowed: 3g, 4g; preferred: none",
      "allowed: 3g, 4g; preferred: 4g",
    ]),
    { "4g3g": { allowed: "3g|4g", preferred: "4g" } },
  );
  assert.equal(convertAccessTechnology(["umts", "lte"]), "4G");
});

test("enumerates a scalar modem-list value", async () => {
  const manager = createModemManager({
    execFile: async () => ({
      stdout: "modem-list: /org/freedesktop/ModemManager1/Modem/4\n",
    }),
    log() {},
  });

  assert.deepEqual(await manager.list(), [4]);
});
