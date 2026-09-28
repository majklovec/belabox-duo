"use strict";

function modemListToIds(modems) {
  const entries =
    typeof modems === "string" ? [modems] : Array.isArray(modems) ? modems : [];

  return entries
    .map(
      (modem) =>
        modem.match(/\/org\/freedesktop\/ModemManager1\/Modem\/(\d+)/)?.[1],
    )
    .filter(Boolean)
    .map((id) => parseInt(id, 10));
}

module.exports = { modemListToIds };
