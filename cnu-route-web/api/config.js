const { handler, config } = require('../lib/core');
module.exports = handler(config, { cacheSec: 300 });
