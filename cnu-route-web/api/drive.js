const { handler, drive } = require('../lib/core');
module.exports = handler(drive, { cacheSec: 300, perMin: 30 });
