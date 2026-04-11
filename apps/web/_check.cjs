const fs = require('fs');
const node0 = fs.readFileSync('./build/_app/immutable/nodes/0.PykrJwtn.js', 'utf8');
const node2 = fs.readFileSync('./build/_app/immutable/nodes/2.Bvr4Pq5g.js', 'utf8');

console.log('Node0 (layout) length:', node0.length);
console.log('Node2 (page) length:', node2.length);

// Check for export default
console.log('Node0 has export:', node0.includes('export'));
console.log('Node2 has export:', node2.includes('export'));

// Check for component function
console.log('Node0 has component:', /component/.test(node0));
console.log('Node2 has component:', /component/.test(node2));

// Show first 200 chars to check structure
console.log('\nNode0 start:', node0.substring(0, 200));
console.log('\n---');

// Check what node0 exports
const exportMatch = node0.match(/export\s*\{[^}]+\}/g);
if (exportMatch) console.log('Node0 exports:', exportMatch.join('\n'));

const exportMatch2 = node2.match(/export\s*\{[^}]+\}/g);
if (exportMatch2) console.log('Node2 exports:', exportMatch2.join('\n'));
