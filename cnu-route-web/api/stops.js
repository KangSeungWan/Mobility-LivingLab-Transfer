const { handler, nearbyStops } = require('../lib/core');
module.exports = handler(nearbyStops, { cacheSec: 86400 });
