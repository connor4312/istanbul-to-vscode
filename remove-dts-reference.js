const fs = require('fs');

// temp fix while test coverage is proposed
fs.writeFileSync(
  'index.d.ts',
  fs
    .readFileSync('index.d.ts', 'utf-8')
    .split('\n')
    .filter((line) => !line.includes('/// <reference'))
    .join('\n'),
);
