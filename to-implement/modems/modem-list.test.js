"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { modemListToIds } = require("./modem-list");

test("converts a scalar mmcli modem-list value to a modem ID", () => {
  assert.deepEqual(
    modemListToIds("/org/freedesktop/ModemManager1/Modem/0"),
    [0],
  );
});

test("converts array-valued mmcli modem-list output to modem IDs", () => {
  assert.deepEqual(
    modemListToIds([
      "/org/freedesktop/ModemManager1/Modem/0",
      "/org/freedesktop/ModemManager1/Modem/2",
    ]),
    [0, 2],
  );
});
