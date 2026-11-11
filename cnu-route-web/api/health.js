const { handler, health } = require('../lib/core');
module.exports = handler(health, { perMin: 3 });
