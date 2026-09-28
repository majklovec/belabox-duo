'use strict';
const { exec, spawnSync } = require('child_process');
const crypto = require('crypto');

module.exports = {
  name: 'ssh',
  version: '1.0.0',
  init(ctx) {
    const { setup, config, log, saveConfig, broadcastMsg,
            registerCommand, registerStatusField, isStreaming, sendStatus,
            notificationSend } = ctx;

    let sshStatus;

    function handle(s) {
      if (s.user === undefined || s.active === undefined || s.user_pass === undefined) return;
      if (!sshStatus || s.user !== sshStatus.user || s.active !== sshStatus.active || s.user_pass !== sshStatus.user_pass) {
        sshStatus = s;
        broadcastMsg('status', { ssh: sshStatus });
      }
    }

    function getUserHash(cb) {
      if (!setup.ssh_user) return;
      exec(`grep "^${setup.ssh_user}:" /etc/shadow`, (err, stdout) => {
        if (err === null && stdout.length) cb(stdout);
      });
    }

    function getStatus() {
      if (!setup.ssh_user) return undefined;
      const s = { user: setup.ssh_user };
      exec('systemctl is-active ssh', (err, stdout) => {
        if (err === null) s.active = true;
        else if (stdout === 'inactive\n') s.active = false;
        else return;
        handle(s);
      });
      getUserHash((hash) => { s.user_pass = hash !== ctx.sshPasswordHash; handle(s); });
      return sshStatus;
    }

    function resetPassword(conn) {
      if (!setup.ssh_user) return;
      const pw = crypto.randomBytes(24).toString('base64').replace(/[+/=]/g, '').substring(0, 20);
      exec(`printf "${pw}\n${pw}" | passwd ${setup.ssh_user}`, (err) => {
        if (err) return notificationSend(conn, 'ssh_pass_reset', 'error',
          `Failed to reset the SSH password for ${setup.ssh_user}`, 10);
        getUserHash((hash) => {
          config.ssh_pass = pw;
          ctx.sshPasswordHash = hash;
          saveConfig();
          broadcastMsg('config', config);
          getStatus();
        });
      });
    }

    function startStop(conn, cmd) {
      if (!setup.ssh_user) return;
      if (cmd === 'start_ssh' && config.ssh_pass === undefined) resetPassword(conn);
      const action = cmd.split('_')[0];
      spawnSync('systemctl', [action, 'ssh'], { detached: true });
      getStatus();
    }

    const guard = (fn) => (conn) => { if (isStreaming) return sendStatus(conn); fn(conn); };
    registerCommand('start_ssh',      guard((c) => startStop(c, 'start_ssh')));
    registerCommand('stop_ssh',       guard((c) => startStop(c, 'stop_ssh')));
    registerCommand('reset_ssh_pass', guard((c) => resetPassword(c)));

    registerStatusField('ssh', getStatus);

    getStatus();
    log('ready');
  },
};
