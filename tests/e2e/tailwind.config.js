// Builds the same CSS the page gets from cdn.tailwindcss.com, so tests run offline.
module.exports = { content: [__dirname + '/../../index.html'], theme: { extend: {} }, plugins: [] };
