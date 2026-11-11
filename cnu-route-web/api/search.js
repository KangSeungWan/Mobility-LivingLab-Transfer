const { handler, search } = require('../lib/core');
module.exports = handler(search, { cacheSec: 3600, perMin: 30 });
