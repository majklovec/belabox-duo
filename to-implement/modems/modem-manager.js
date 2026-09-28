"use strict";

const { modemListToIds } = require("./modem-list");

function parseKeyValueOutput(input, log) {
  const output = {};
  for (let line of input.split("\n")) {
    line = line.replace(/\\\d+/g, "");
    if (!line) continue;
    const pair = line.split(/:(.*)/);
    if (pair.length !== 3) {
      log(`mmcliParseSep: error parsing line ${line}`);
      continue;
    }
    let key = pair[0].trim();
    const value = pair[1].trim();
    if (key.endsWith(".length")) {
      key = key.replace(/\.length$/, "");
      output[key] = [];
      continue;
    }
    if (key.match(/\.value\[\d+\]$/)) {
      key = key.replace(/\.value\[\d+\]$/, "");
      output[key].push(value);
      continue;
    }
    if (value !== "--") output[key] = value;
  }
  return output;
}

function convertNetworkType(value) {
  const match = value.match(/^allowed: (.+); preferred: (.+)$/);
  const label = match[1].split(/,? /).sort().reverse().join("");
  return {
    label,
    allowed: match[1].replace(/,? /g, "|"),
    preferred: match[2],
  };
}

function convertNetworkTypes(values) {
  const types = {};
  for (const value of values) {
    const type = convertNetworkType(value);
    if (
      !types[type.label] ||
      types[type.label].preferred === "none" ||
      types[type.label].preferred < type.preferred
    )
      types[type.label] = {
        allowed: type.allowed,
        preferred: type.preferred,
      };
  }
  return types;
}

function convertAccessTechnology(values) {
  if (!values?.length) return;
  const generations = {
    gsm: "2G",
    umts: "3G",
    hsdpa: "3G+",
    hsupa: "3G+",
    lte: "4G",
    "5gnr": "5G",
  };
  let generation = "";
  for (const value of values)
    if (generations[value] > generation) generation = generations[value];
  return generation || values[0];
}

function createModemManager({ execFile, log }) {
  async function run(args, tag) {
    try {
      return (await execFile("mmcli", args)).stdout.toString("utf8");
    } catch ({ message }) {
      log(`${tag} err: ${message}`);
    }
  }

  async function list() {
    const output = await run(["-K", "-L"], "mmList");
    if (!output) return;
    return modemListToIds(parseKeyValueOutput(output, log)["modem-list"] ?? []);
  }

  async function getModem(id) {
    const output = await run(["-K", "-m", String(id)], "mmGetModem");
    return output && parseKeyValueOutput(output, log);
  }

  async function getSim(id) {
    const output = await run(["-K", "-i", String(id)], "mmGetSim");
    return output && parseKeyValueOutput(output, log);
  }

  async function setNetworkTypes(id, allowed, preferred) {
    const args = ["-m", String(id), `--set-allowed-modes=${allowed}`];
    if (preferred !== "none") args.push(`--set-preferred-mode=${preferred}`);
    const output = await run(args, "mmSetNetworkTypes");
    return output?.match(/successfully set current modes in the modem/);
  }

  async function scanNetworks(id, timeout = 240) {
    const output = await run(
      [`--timeout=${timeout}`, "-K", "-m", String(id), "--3gpp-scan"],
      "mmNetworkScan",
    );
    if (!output) return;
    const networks =
      parseKeyValueOutput(output, log)["modem.3gpp.scan-networks"] ?? [];
    return networks.map((network) =>
      Object.fromEntries(
        network.split(/, */).map((entry) => entry.split(/: */)),
      ),
    );
  }

  return {
    convertAccessTechnology,
    convertNetworkType,
    convertNetworkTypes,
    getModem,
    getSim,
    list,
    scanNetworks,
    setNetworkTypes,
  };
}

module.exports = {
  convertAccessTechnology,
  convertNetworkType,
  convertNetworkTypes,
  createModemManager,
  parseKeyValueOutput,
};
