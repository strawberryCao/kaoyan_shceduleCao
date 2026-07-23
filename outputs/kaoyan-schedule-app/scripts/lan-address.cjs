const os = require('node:os');

const isPrivateIpv4 = (address) => {
  const parts = String(address).split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 10
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168);
};

const virtualInterfacePattern = /virtual|vmware|vbox|vethernet|hyper-v|wsl|loopback|docker|tailscale|zerotier/i;
const candidates = [];

for (const [name, entries] of Object.entries(os.networkInterfaces())) {
  for (const entry of entries || []) {
    if (!entry || entry.internal || entry.family !== 'IPv4') continue;
    candidates.push({
      address: entry.address,
      score: (isPrivateIpv4(entry.address) ? 100 : 0) - (virtualInterfacePattern.test(name) ? 50 : 0),
    });
  }
}

candidates.sort((left, right) => right.score - left.score || left.address.localeCompare(right.address));
if (candidates[0]) process.stdout.write(candidates[0].address);
