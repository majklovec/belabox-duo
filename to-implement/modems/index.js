"use strict";

const util = require("util");
const { createNetworkManager } = require("../../network-manager");
const { createModemManager } = require("./modem-manager");

const execFileP = util.promisify(require("child_process").execFile);

module.exports = {
  name: "modems",
  version: "1.0.0",

  init(ctx) {
    const {
      setup,
      log,
      buildMsg,
      broadcastMsg,
      registerMessageHandler,
      registerStatusField,
      registerInitialStatusEmitter,
      readJsonFile,
      writeJsonFile,
    } = ctx;

    const networkManager = createNetworkManager({ execFile: execFileP, log });
    const {
      addConnection: nmConnAdd,
      connect: nmConnect,
      disconnect: nmDisconnect,
      getConnectionFields: nmConnGetFields,
      getConnections: nmConnsGet,
    } = networkManager;
    const modemManager = createModemManager({ execFile: execFileP, log });
    const {
      convertAccessTechnology: mmConvertAccessTech,
      convertNetworkType: mmConvertNetworkType,
      convertNetworkTypes: mmConvertNetworkTypes,
      getModem: mmGetModem,
      getSim: mmGetSim,
      list: mmList,
      scanNetworks: mmNetworkScan,
      setNetworkTypes: mmSetNetworkTypes,
    } = modemManager;

    // ─────────────────────────────────────────────────────────────────────────
    // GSM operator cache
    // ─────────────────────────────────────────────────────────────────────────
    const GSM_OPERATORS_CACHE_FILE = "gsm_operator_cache.json";
    const gsmOperatorsCache = readJsonFile(GSM_OPERATORS_CACHE_FILE) ?? {};
    if (!Object.keys(gsmOperatorsCache).length) {
      log("GSM operators cache is empty, starting fresh");
    }

    async function gsmOperatorsAdd(id, name) {
      if (gsmOperatorsCache[id] === name) return;
      gsmOperatorsCache[id] = name;
      await writeJsonFile(GSM_OPERATORS_CACHE_FILE, gsmOperatorsCache);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Modem state
    // ─────────────────────────────────────────────────────────────────────────
    const modems = {};
    let gsmConns; // fetched once per updateModems() run

    async function getGsmConns() {
      const byDevice = {},
        byOperator = {},
        byUuid = {};
      const conns = await nmConnsGet("uuid,type,state");
      if (!conns) return { byDevice, byOperator, byUuid };

      for (const c of conns) {
        const [uuid, type, state] = nmcliParseSep(c);
        if (type !== "gsm") continue;

        let fields =
          "gsm.device-id,gsm.sim-id,gsm.sim-operator-id,gsm.apn,gsm.username,gsm.password,gsm.home-only,gsm.network-id";
        if (setup.has_gsm_autoconfig) fields += ",gsm.auto-config";
        const info = await nmConnGetFields(uuid, fields);

        const [
          deviceId,
          simId,
          operatorId,
          apn,
          username,
          password,
          homeOnly,
          network,
          autoconfigRaw,
        ] = info;
        const conn = {
          state,
          uuid,
          deviceId,
          simId,
          operatorId,
          apn,
          username,
          password,
          roaming: homeOnly === "no",
          network,
        };
        if (setup.has_gsm_autoconfig) conn.autoconfig = autoconfigRaw === "yes";

        byUuid[uuid] = conn;
        if (deviceId && simId) {
          if (!byDevice[deviceId]) byDevice[deviceId] = {};
          const connections = byDevice[deviceId];
          connections[simId] = conn;
        }
        if (operatorId) byOperator[operatorId] = conn;
      }
      return { byDevice, byOperator, byUuid };
    }

    function modemConfigSanitizeToNM(cfg) {
      const fields = {};
      if (setup.has_gsm_autoconfig) {
        fields["gsm.auto-config"] = cfg.autoconfig ? "yes" : "no";
        if (cfg.autoconfig) {
          cfg.apn = "";
          cfg.username = "";
          cfg.password = "";
        }
      } else {
        delete cfg.autoconfig;
      }
      fields["gsm.apn"] = cfg.apn;
      fields["gsm.username"] = cfg.username;
      fields["gsm.password"] = cfg.password;
      fields["gsm.password-flags"] = cfg.password ? 0 : 4;
      fields["gsm.home-only"] = cfg.roaming ? "no" : "yes";
      fields["gsm.network-id"] = cfg.roaming ? cfg.network : "";
      return fields;
    }

    async function modemGetConfig(modemInfo, simInfo, gsmConns) {
      if (!modemInfo || !simInfo || !gsmConns) return;

      const modemId = modemInfo["modem.generic.device-identifier"];
      const simId = simInfo["sim.properties.iccid"];
      const operatorId = simInfo["sim.properties.operator-code"];

      if (gsmConns.byDevice[modemId]?.[simId]) {
        const ci = gsmConns.byDevice[modemId][simId];
        log(`Found NM connection ${ci.uuid} for modem ${modemId}`);
        return {
          conn: ci.uuid,
          autoconfig: ci.autoconfig,
          apn: ci.apn,
          username: ci.username,
          password: ci.password,
          roaming: ci.roaming,
          network: ci.network,
        };
      }

      let cfg;
      if (operatorId && gsmConns.byOperator[operatorId]) {
        const ci = gsmConns.byOperator[operatorId];
        cfg = {
          autoconfig: ci.autoconfig,
          apn: ci.apn,
          username: ci.username,
          password: ci.password,
          roaming: ci.roaming,
          network: ci.network,
        };
      } else {
        cfg = {
          autoconfig: true,
          apn: "internet",
          username: "",
          password: "",
          roaming: true,
          network: "",
        };
      }

      const nmConfig = {
        type: "gsm",
        ifname: "",
        autoconnect: "yes",
        "connection.autoconnect-retries": 10,
        "ipv6.method": "ignore",
        "gsm.device-id": modemId,
        "gsm.sim-id": simId,
        ...(operatorId && { "gsm.sim-operator-id": operatorId }),
        ...modemConfigSanitizeToNM(cfg),
      };

      const uuid = await nmConnAdd(nmConfig);
      if (uuid) {
        cfg.conn = uuid;
        log(`Created NM connection ${uuid} for ${modemId}`);
        log(cfg);
      }
      return cfg;
    }

    function modemUpdateStatus(modemInfo, modem) {
      let network = modemInfo["modem.3gpp.operator-name"];
      if (!network && modemInfo["modem.3gpp.registration-state"] === "home")
        network = modem.sim_network;

      modem.status = {
        connection: modem.is_scanning
          ? "scanning"
          : modemInfo["modem.generic.state"],
        network,
        network_type: mmConvertAccessTech(
          modemInfo["modem.generic.access-technologies"],
        ),
        signal: modemInfo["modem.generic.signal-quality.value"],
        roaming: modemInfo["modem.3gpp.registration-state"] === "roaming",
      };
    }

    async function modemNetworkScan(id) {
      const modem = modems[id];
      if (!modem?.config || !modem.status || modem.is_scanning) return;

      modem.is_scanning = true;
      if (modem.config.conn) await nmDisconnect(modem.config.conn);

      const results = await mmNetworkScan(id);
      delete modem.is_scanning;

      if (!results) {
        broadcastModemAvailableNetworks(id);
        return;
      }

      const availableNetworks = {};
      for (const r of results) {
        const code = r["operator-code"];
        if (r.availability === "current") r.availability = "available";
        else if (r.availability === "unknown") delete r.availability;

        if (availableNetworks[code]) {
          if (
            r.availability === "available" &&
            availableNetworks[code].availability !== "available"
          ) {
            availableNetworks[code].availability = "available";
          }
        } else {
          availableNetworks[code] = {
            name: r["operator-name"],
            availability: r.availability,
          };
        }
      }

      modem.available_networks = availableNetworks;
      broadcastModemAvailableNetworks(id);
    }

    async function registerModem(id) {
      if (modems[id])
        throw new Error(`Trying to register existing modem id ${id}`);

      const modemInfo = await mmGetModem(id);
      if (!modemInfo) return;

      let simInfo, cfg;
      const simIdMatch = modemInfo["modem.generic.sim"]?.match(
        /\/org\/freedesktop\/ModemManager1\/SIM\/(\d+)/,
      );
      if (simIdMatch) {
        simInfo = await mmGetSim(simIdMatch[1]);
        if (simInfo) {
          if (!gsmConns) gsmConns = await getGsmConns();
          cfg = await modemGetConfig(modemInfo, simInfo, gsmConns);
        }
      }

      // Find the network interface name
      let ifname;
      for (const port of modemInfo["modem.generic.ports"]) {
        if (port.endsWith(" (net)")) {
          ifname = port.replace(/ \(net\)$/, "");
          break;
        }
      }

      // Network types
      let networkType = mmConvertNetworkType(
        modemInfo["modem.generic.current-modes"],
      );
      const networkTypes = mmConvertNetworkTypes(
        modemInfo["modem.generic.supported-modes"],
      );
      if (networkType && !networkTypes[networkType.label]) {
        networkTypes[networkType.label] = {
          allowed: networkType.allowed,
          preferred: networkType.preferred,
        };
      }
      networkType = networkType.label;

      const partialImei =
        modemInfo["modem.generic.equipment-identifier"].slice(-5);
      const hwName = `${modemInfo["modem.generic.model"]} - ${partialImei}`;
      const simNetwork = simInfo
        ? simInfo["sim.properties.operator-name"] || "Unknown"
        : "<NO SIM>";

      modems[id] = {
        ifname,
        name: `${hwName} | ${simNetwork}`,
        sim_network: simNetwork,
        network_type: { supported: networkTypes, active: networkType },
        config: cfg,
      };
      modemUpdateStatus(modemInfo, modems[id]);
    }

    function modemGetAvailableNetworks(modem) {
      if (!modem.config || modem.config.network === "")
        return modem.available_networks || {};
      const networks = { ...(modem.available_networks ?? {}) };
      if (!modem.available_networks) {
        networks[modem.config.network] = {
          name:
            gsmOperatorsCache[modem.config.network] ||
            `Operator ID ${modem.config.network}`,
        };
      } else if (!modem.available_networks[modem.config.network]) {
        networks[modem.config.network] = {
          name: "Test",
          availability: "unavailable",
        };
      }
      return networks;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Status message builders
    // ─────────────────────────────────────────────────────────────────────────
    function modemsBuildMsg(modemsFullState) {
      const msg = {};
      for (const i in modems) {
        const m = modems[i];
        const full = modemsFullState === undefined || modemsFullState[i];
        msg[i] = {};

        if (full) {
          msg[i].ifname = m.ifname;
          msg[i].name = m.name;
          msg[i].network_type = {
            supported: Object.keys(m.network_type.supported),
            active: m.network_type.active,
          };

          if (m.config) {
            msg[i].config = {
              apn: m.config.apn,
              username: m.config.username,
              password: m.config.password,
              roaming: m.config.roaming,
              network: m.config.network,
            };
            if (setup.has_gsm_autoconfig)
              msg[i].config.autoconfig = m.config.autoconfig;
          } else {
            msg[i].no_sim = true;
          }
          msg[i].available_networks = modemGetAvailableNetworks(m);
        }

        if (!m.status) continue;
        msg[i].status = { ...m.status };
      }
      return msg;
    }

    function broadcastModems(modemsFullState) {
      broadcastMsg("status", { modems: modemsBuildMsg(modemsFullState) });
    }

    function broadcastModemAvailableNetworks(id) {
      const msg = {};
      for (const i in modems) {
        msg[i] = {};
        if (id === i)
          msg[i].available_networks = modemGetAvailableNetworks(modems[i]);
      }
      broadcastMsg("status", { modems: msg });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Periodic modem enumeration
    // ─────────────────────────────────────────────────────────────────────────
    async function updateModems() {
      for (const m in modems) modems[m].removed = true;

      const modemList = (await mmList()) ?? [];
      gsmConns = undefined;
      const newModems = {};

      for (const m of modemList) {
        if (modems[m]) {
          delete modems[m].removed;
          const modemInfo = await mmGetModem(m);
          if (!modemInfo) continue;

          const modem = modems[m];
          modemUpdateStatus(modemInfo, modem);

          const canActivate =
            !modem.inhibit &&
            !modem.is_scanning &&
            ["registered", "enabled"].includes(modem.status?.connection) &&
            modem.config?.conn;

          if (canActivate) {
            // Don't try to activate NM connections that are already active
            const nmState = await nmConnGetFields(
              modem.config.conn,
              "GENERAL.STATE",
            );
            if (nmState.length === 1) {
              log(
                `Trying to bring up connection ${modem.config.conn} for modem ${m}...`,
              );
              nmConnect(modem.config.conn);
            }
          }
        } else {
          try {
            await registerModem(m);
            newModems[m] = true;
            log(JSON.stringify(modems[m], undefined, 2));
          } catch (e) {
            log(`Failed to register modem ${m}: ${e.message ?? e}`);
          }
        }
      }

      for (const m in modems) {
        if (modems[m].removed) {
          log(`Modem ${m} removed`);
          delete modems[m];
        }
      }

      broadcastModems(newModems);
      setTimeout(updateModems, 1000);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // WS message handlers
    // ─────────────────────────────────────────────────────────────────────────
    async function handleModemConfig(_conn, msg) {
      const modem = modems[msg.device];
      if (!modem?.config?.conn) {
        log(
          `Ignoring modem config for unknown/unconfigured modem ${msg.device}`,
        );
        return;
      }
      const connUuid = modem.config.conn;

      // Field validation
      const validTypes = {
        roaming: "boolean",
        autoconfig: "boolean",
        apn: "string",
        username: "string",
        password: "string",
        network: "string",
        network_type: "string",
      };
      for (const [k, t] of Object.entries(validTypes)) {
        if (typeof msg[k] !== t) {
          log(`Received invalid configuration for modem ${msg.device}`);
          log(msg);
          return;
        }
      }

      // Network type must be supported
      const networkType = modem.network_type.supported[msg.network_type];
      if (!networkType) {
        log(
          `Received invalid network type ${msg.network_type} for modem ${msg.device}`,
        );
        return;
      }

      // Only allow '' / saved / scanned networks
      if (
        msg.network !== "" &&
        msg.network !== modem.config.network &&
        !modem.available_networks?.[msg.network]
      ) {
        log(
          `Received unavailable network ${msg.network} for modem ${msg.device}`,
        );
        return;
      }

      if (msg.network && modem.available_networks?.[msg.network]) {
        gsmOperatorsAdd(
          msg.network,
          modem.available_networks[msg.network].name,
        );
      }

      const updatedConfig = {
        autoconfig: msg.autoconfig,
        apn: msg.apn,
        username: msg.username,
        password: msg.password,
        roaming: msg.roaming,
        network: msg.network,
      };

      // This also clears apn/username/password in-place if autoconfig is set
      const ok = await nmConnSetFields(
        connUuid,
        modemConfigSanitizeToNM(updatedConfig),
      );
      if (ok) {
        Object.assign(modem.config, updatedConfig);
      } else {
        log(
          `Failed to update NM connection ${modem.config.conn} for modem ${msg.device}:`,
          updatedConfig,
        );
      }

      // Bring the connection down and set the network types if needed
      modem.inhibit = true;
      await nmDisconnect(connUuid);
      if (msg.network_type !== modem.network_type.active) {
        if (
          await mmSetNetworkTypes(
            msg.device,
            networkType.allowed,
            networkType.preferred,
          )
        ) {
          modem.network_type.active = msg.network_type;
        }
      }
      delete modem.inhibit;

      broadcastModems({ [msg.device]: true });
    }

    async function handleModemScan(_conn, msg) {
      if (!modems[msg?.device]) return;
      await modemNetworkScan(msg.device);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Registration with the core
    // ─────────────────────────────────────────────────────────────────────────
    registerStatusField("modems", () => modemsBuildMsg());
    registerInitialStatusEmitter((conn) =>
      conn.send(buildMsg("status", { modems: modemsBuildMsg() })),
    );

    registerMessageHandler("modems", (conn, payload) => {
      for (const type in payload) {
        switch (type) {
          case "config":
            handleModemConfig(conn, payload[type]);
            break;
          case "scan":
            handleModemScan(conn, payload[type]);
            break;
        }
      }
    });

    // Kick off the polling loop
    updateModems();

    log("ready");
  },
};
