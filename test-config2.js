const fs = require('fs');
const config = JSON.parse(fs.readFileSync('temp.json', 'utf8'));
delete config.route.rule_set;
if (config.dns && config.dns.rules) {
  config.dns.rules = config.dns.rules.filter(r => !r.rule_set);
}
if (config.route && config.route.rules) {
  config.route.rules = config.route.rules.filter(r => !r.rule_set);
}
fs.writeFileSync('temp2.json', JSON.stringify(config, null, 2));

try {
  const output = require('child_process').execSync('./resources/mac-arm64/sing-box check -c temp2.json', { encoding: 'utf8', stdio: 'pipe' });
  console.log('Sing-box validation OK:', output);
} catch (e) {
  console.error('Sing-box validation FAILED:');
  console.error(e.stderr || e.stdout || e.message);
}
