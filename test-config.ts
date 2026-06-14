import { app } from 'electron';
import { ProxyManager } from './src/main/services/ProxyManager';

const dummyConfig: any = {
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
const singboxConfig = (pm as any).generateConfig(dummyConfig);
require('fs').writeFileSync('temp.json', JSON.stringify(singboxConfig, null, 2));

try {
  const output = require('child_process').execSync('./resources/mac-arm64/sing-box check -c temp.json', { encoding: 'utf8', stdio: 'pipe' });
  console.log('Sing-box validation OK:', output);
} catch (e: any) {
  console.error('Sing-box validation FAILED:');
  console.error(e.stderr || e.stdout || e.message);
}
