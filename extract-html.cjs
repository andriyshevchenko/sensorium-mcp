const fs = require('fs');
const src = fs.readFileSync('src/dashboard.ts', 'utf-8');
const NL = src.includes('\r\n') ? '\r\n' : '\n';
const marker = 'function getDashboardHTML(): string {' + NL + '    return `';
const start = src.indexOf(marker);
if (start === -1) { console.error('Marker not found'); process.exit(1); }
const bodyStart = start + marker.length;
const endMarker = '`;' + NL + '}' + NL;
const bodyEnd = src.lastIndexOf(endMarker);
if (bodyEnd === -1) { console.error('End marker not found'); process.exit(1); }
const templateContent = src.slice(bodyStart, bodyEnd);
const evaluated = new Function('return `' + templateContent + '`')();
fs.mkdirSync('src/dashboard', { recursive: true });
fs.writeFileSync('src/dashboard/spa.html', evaluated, 'utf-8');
console.log('Extracted ' + evaluated.length + ' chars to src/dashboard/spa.html');
console.log('Lines: ' + evaluated.split('\n').length);
