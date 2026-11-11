const { handler, subway } = require('../lib/core');
module.exports = handler(subway, { cacheSec: 21600 });
