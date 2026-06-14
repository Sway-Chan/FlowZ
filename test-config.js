const Module = require('module');
const originalRequire = Module.prototype.require;
Module.prototype.require = function(id) {
  if (id === 'electron') {
    return { app: { getPath: () => '/tmp', getVersion: () => '1.0.0', isPackaged: false } };
  }
  return originalRequire.apply(this, arguments);
};

const { ProxyManager } = require('./dist/main/main/services/ProxyManager.js');

const dummyConfig = {
  version: 1,
  language: 'zh-CN',
  proxyMode: 'smart',
  proxyModeType: 'tun',
  enableIPv6: false,
  selectedServerId: 'server1',
  servers: [
    {
      id: 'server1',
      name: 'Test Server',
      protocol: 'shadowsocks',
      address: '1.2.3.4',
      port: 8388,
      shadowsocksSettings: {
        method: 'aes-256-gcm',
        password: 'password'
      }
    }
  ],
  tunConfig: {
    inet4Address: '172.19.0.1/30',
    mtu: 1400,
    autoRoute: true,
    strictRoute: true,
    stack: 'gvisor'
  }
};

const pm = new ProxyManager();
// Mock coreVersion
pm.coreVersion = '1.13.0';

const singboxConfig = pm.generateSingBoxConfig(dummyConfig);
require('fs').writeFileSync('temp.json', JSON.stringify(singboxConfig, null, 2));

try {
  const output = require('child_process').execSync('./resources/mac-arm64/sing-box check -c temp.json', { encoding: 'utf8', stdio: 'pipe' });
  console.log('Sing-box validation OK:', output);
} catch (e) {
  console.error('Sing-box validation FAILED:');
  console.error(e.stderr || e.stdout || e.message);
}
