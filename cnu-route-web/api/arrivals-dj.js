const { handler, arrivalsDaejeon } = require('../lib/core');
module.exports = handler(arrivalsDaejeon, { cacheSec: 15 });
