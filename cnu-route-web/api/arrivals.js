const { handler, arrivals } = require('../lib/core');
module.exports = handler(arrivals, { cacheSec: 15 });
